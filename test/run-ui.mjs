#!/usr/bin/env node
/**
 * Tests qui reclament une vraie fenetre.
 *
 * Les tests CDP du depot partaient du principe que quelqu'un avait deja lance
 * l'app avec un port de debug, puis attendaient en silence. Ce lanceur fait la
 * moitie du travail : il demarre l'app, attend que le port reponde, lance les
 * tests, et tue le processus -- y compris quand un test echoue, parce qu'une
 * instance orpheline fait echouer le run suivant pour la mauvaise raison.
 *
 * Sous Linux il n'y a pas de bureau : `xvfb-run` est utilise s'il est present.
 * Et comme ce n'est pas Windows, ce que ces tests prouvent est limite au DOM
 * (barre de titre, pages, reglages, raccourcis) -- jamais au comportement
 * Windows. La distinction est ecrite ici pour que personne ne lise un vert
 * local comme une validation de l'installateur.
 */

import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'test');
/**
 * Le port est pris au hasard plutot que fixe : deux runs cote a cote (ou un run
 * apres une instance qui a mis du temps a mourir) se renvoient sinon un
 * "Cannot start http server for devtools", et l'echec ressemble alors a une
 * regression de l'app alors que c'est une collision.
 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const PORT = process.env.HUB_CDP_PORT || (await freePort());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Un test depend de la fenetre des qu'il parle CDP : detection par contenu. */
const needsWindow = (source) => /remote-debugging-port|webSocketDebuggerUrl/.test(source);

const found = readdirSync(testDir)
  // Les lanceurs se reconnaitraient entre eux : `run-ui.mjs` contient la chaine
  // `--remote-debugging-port`, donc il se prendrait pour un test et se relancerait
  // a l'infini. Les lanceurs sont excludes par nom, pas par chance.
  .filter((name) => name.endsWith('.mjs') && !name.startsWith('run'))
  .filter((name) => needsWindow(readFileSync(path.join(testDir, name), 'utf8')));

/**
 * Ordre explicite, pas alphabetique : `ui-lock` part d'un profil neuf et verifie
 * l'onboarding, donc il passe premier. Les suivants creent ce dont ils ont besoin.
 */
const ORDER = ['ui-lock.mjs', 'ui-glass.mjs', 'ui-volume.mjs', 'audio-volume.mjs'];
const files = [...ORDER.filter((name) => found.includes(name)), ...found.filter((name) => !ORDER.includes(name)).sort()];

/*
 * Un profil neuf par run : sinon le deuxieme herite des services, du code de
 * verrouillage et du theme laisses par le premier, et un echec ressemble a s'y
 * retrouver. `HUB_UI_PROFILE` designe un profil a garder pour debugger.
 */
const profile = process.env.HUB_UI_PROFILE || mkdtempSync(path.join(os.tmpdir(), 'soocial-ui-'));
mkdirSync(profile, { recursive: true });

if (!files.length) {
  console.log('aucun test UI trouve');
  process.exit(0);
}

function has(command, args = []) {
  return new Promise((resolve) => {
    const probe = spawn(command, args, { stdio: 'ignore' });
    probe.on('close', (code) => resolve(code === 0));
    probe.on('error', () => resolve(false));
  });
}

const electronBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
if (!existsSync(electronBin)) {
  console.error(`FAIL  binaire electron absent (${path.relative(root, electronBin)}) - lancer npm install`);
  process.exit(2);
}

const appArgs = [root, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--disable-gpu'];
const useXvfb = process.platform === 'linux' && (await has('which', ['xvfb-run']));
const command = useXvfb ? 'xvfb-run' : electronBin;
const args = useXvfb ? ['-a', electronBin, ...appArgs] : appArgs;

const child = spawn(command, args, {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    HUB_UI_TEST: '1',
    // Le main derive userData de HOME (et d'APPDATA sur Windows) : ces variables
    // sont le seul moyen de deplacer le profil sans toucher au code de l'app.
    HOME: profile,
    XDG_CONFIG_HOME: path.join(profile, '.config'),
    XDG_CACHE_HOME: path.join(profile, '.cache'),
    USERPROFILE: profile,
    APPDATA: path.join(profile, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
  },
});

let failures = 0;
let ready = false;

try {
  // Le port de debug est le seul signal utile : la page doit exister avant que
  // les tests ne commencent a la chercher.
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      ready = list.some((target) => target.type === 'page');
    } catch {
      // Le port n'est pas encore la : c'est normal pendant les premieres secondes.
    }
    if (!ready) await sleep(500);
  }

  if (!ready) {
    console.error(`FAIL  aucun renderer sur le port ${PORT} : l\u2019application n\u2019a pas demarre (ou a mis plus de 30 s)`);
    failures++;
  } else {
    console.log(`instance sur le port ${PORT}, ${files.length} test(s) UI, profil ${profile}`);
    for (const file of files) {
      const started = Date.now();
      const code = await new Promise((resolve) => {
        // WebSocket est global depuis Node 22 ; en dessous, il faut le drapeau.
        // Le mettre ici plutt que dans chaque test evite le "mais a la main ca marche".
        const flags = Number(process.versions.node.split('.')[0]) >= 22 ? [] : ['--experimental-websocket'];
        const test = spawn(process.execPath, [...flags, path.join(testDir, file), PORT], { cwd: root, stdio: 'inherit' });
        test.on('close', (exitCode) => resolve(exitCode ?? 1));
      });
      if (code !== 0) failures++;
      console.log(`${code === 0 ? 'OK  ' : 'FAIL'} ${file.replace(/\.mjs$/, '')} (${Date.now() - started} ms)`);
    }
  }
} finally {
  child.kill('SIGTERM');
  await sleep(800);
  if (!child.killed) child.kill('SIGKILL');
  if (!process.env.HUB_UI_PROFILE) rmSync(profile, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);

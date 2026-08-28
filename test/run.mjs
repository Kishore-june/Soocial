#!/usr/bin/env node
/**
 * Lanceur de tests du depot.
 *
 * Separes, les tests de ce projet etaient corrects mais optionnels : rien ne
 * forcait personne a lancer `node test/dnd.mjs` puis `node test/audio-volume.mjs`.
 * Ce lanceur les execute tous, dans un ordre qui a un sens (logique pure, puis
 * contrat d'installateur), et rend un seul code de sortie.
 *
 * Deux familles peuvent etre sautees — jamais silencieusement :
 *   - les tests CDP (ui-*.mjs) reclament une instance lancee avec
 *     --remote-debugging-port : sans fenetre, ils ne prouvent rien ;
 *   - compile-check.sh reclame makensis (le cache electron-builder ou le paquet
 *     systeme). Sans lui on ne peut pas dire que l'installateur est bon, mais on
 *     peut encore dire que le reste l'est.
 * Un test qui ne tourne pas en silence est un test qui n'existe pas ; c'est la
 * seule raison d'etre de la colonne SKIP.
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'test');

/**
 * Un test a besoin d'une fenetre quand il pilote l'app par CDP. Le detecter au
 * contenu plutot qu'au nom evite le pire echec de ce genre de lanceur : un test
 * ajoute en avril, nomme autrement, qui "reussit" parce qu'il n'a rien verifie.
 */
function needsWindow(source) {
  return /remote-debugging-port|webSocketDebuggerUrl/.test(source);
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.on('error', (err) => resolve({ code: 1, error: err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1 }));
  });
}

const results = [];
const only = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const pick = (name) => !only.length || only.some((wanted) => name.includes(wanted));

for (const file of readdirSync(testDir).filter(
      // Trois fichiers ne sont pas des tests : le lanceur sans fenetre, le lanceur
      // avec fenetre (qui lance les siens), et le garde d'installateur, appele une
      // fois plus bas pour qu'il soit compte comme contrat et non comme suite.
      (name) =>
        name.endsWith('.mjs') &&
        !['run.mjs', 'run-ui.mjs', 'installer-script.mjs'].includes(name)
    ).sort()) {
  const name = file.replace(/\.mjs$/, '');
  if (!pick(name)) continue;

  const source = readFileSync(path.join(testDir, file), 'utf8');
  const windowed = needsWindow(source);
  if (windowed && !process.env.HUB_CDP_PORT) {
    results.push([name, 'skip', 'veut HUB_CDP_PORT et une instance lancee en debug']);
    continue;
  }

  const started = Date.now();
  const args = [path.join(testDir, file)];
  if (windowed) args.push(process.env.HUB_CDP_PORT);
  const { code } = await run(process.execPath, args);
  results.push([name, code === 0 ? 'ok' : 'fail', `${Date.now() - started} ms`]);
}

// Le contrat installeur est verifie deux fois, et les deux comptent : la lecture
// des fichiers (partout) et la compilation reelle par makensis (si disponible).
if (pick('installer-script')) {
  const { code } = await run(process.execPath, [path.join(testDir, 'installer-script.mjs')]);
  results.push(['installer-script', code === 0 ? 'ok' : 'fail', 'contrat nsi <-> js']);
}

const templates = path.join(root, 'node_modules/app-builder-lib/templates/nsis/common.nsh');
const hasNsis = existsSync(path.join(root, 'installer/custom.nsh')) && existsSync(templates);
if (pick('installer-compile')) {
  if (hasNsis) {
    const { code } = await run('bash', [path.join(testDir, 'installer/compile-check.sh')]);
    results.push(['installer-compile', code === 0 ? 'ok' : 'fail', 'makensis, mode installeur + desinstallateur']);
  } else {
    results.push(['installer-compile', 'skip', 'veut les modeles NSIS de electron-builder (npm install)']);
  }
}

console.log('\n--- resume ---');
let failed = 0;
let skipped = 0;
for (const [name, status, detail] of results) {
  if (status === 'fail') failed++;
  if (status === 'skip') skipped++;
  const mark = status === 'ok' ? 'OK  ' : status === 'skip' ? 'SKIP' : 'FAIL';
  console.log(`${mark} ${name.padEnd(18)} ${detail}`);
}
console.log(`\n${results.length - failed - skipped}/${results.length} vert, ${failed} echec(s), ${skipped} saut(s)`);
process.exit(failed ? 1 : 0);

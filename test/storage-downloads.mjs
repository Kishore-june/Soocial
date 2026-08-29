#!/usr/bin/env node
/**
 * Le dossier de telechargement, quand il n'existe pas encore.
 *
 * Trois etats et non deux : un dossier ecrivable, un dossier absent mais creable,
 * un dossier refuse. Le deuxieme a ete confondu avec le troisieme pendant un
 * moment — consequence concrete : la page Stockage affichait "inaccessible" sur
 * un reglage parfaitement valide, et le premier telechargement partait au defaut
 * en le disant. Le contrat demande la creation a la volee du dossier par defaut,
 * donc "absent" n'est pas une panne.
 *
 * Deux etages. D'abord les fonctions pures (`finalizeProbe`, `isUsableProbe`,
 * `planDownload`, `resolveName`) avec des sondes fabriquees a la main : la
 * decision elle-meme, sans dependre d'un disque. Ensuite `probeDirectory` et
 * `setDownloadsDir` sur de vrais dossiers temporaires : ce que la decision vaut
 * quand elle rencontre `stat` et `mkdir`. Le deuxieme etage n'a ete possible
 * qu'apres avoir branche la verification de forme sur le systeme courant -
 * `shared/path-rules` est ecrit pour Windows et rejetait chaque chemin reel de ce
 * depot, ce qui est exactement le faux "inaccessible" que la page affichait.
 */

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const storage = require(path.join(root, 'main/storage-layout.js'));
const downloads = require(path.join(root, 'main/downloads.js'));
const rules = require(path.join(root, 'shared/path-rules.js'));

const locales = ['en', 'fr', 'es'].reduce((acc, lang) => {
  acc[lang] = JSON.parse(readFileSync(path.join(root, 'locales', `${lang}.json`), 'utf8'));
  return acc;
}, {});

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`OK   ${label}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${label}\n     ${String(err.message).split('\n')[0]}`);
  }
}

/** Un libelle doit exister dans les trois langues : une cle orpheline se voit. */
function translated(key) {
  if (!key) return false;
  return Object.values(locales).every((dict) => typeof dict[key] === 'string' && dict[key].length > 0);
}

const DEFAULT_DIR = 'C:\\Users\\me\\Downloads\\Soocial';
const CHOSEN_DIR = 'E:\\Tel\\Soocial';

// ---------------------------------------------------------------------------
// 1. Le verdict a trois etats
// ---------------------------------------------------------------------------

check('dossier present et ecrivable : ok, existe, rien a creer', () => {
  const state = storage.finalizeProbe({ ok: true, path: DEFAULT_DIR });
  assert.equal(state.downloadsOk, true);
  assert.equal(state.downloadsExists, true);
  assert.equal(state.downloadsWritable, true);
  assert.equal(state.downloadsWillCreate, false);
  assert.equal(state.downloadsErrorCode, null);
  assert.equal(state.downloadsErrorKey, null);
});

check('dossier absent mais creable : ok, et "a creer" - pas une panne', () => {
  const state = storage.finalizeProbe({
    ok: false,
    code: 'MISSING_DIRECTORY',
    path: DEFAULT_DIR,
    parent: 'C:\\Users\\me\\Downloads',
    creatable: true,
  });
  assert.equal(state.downloadsOk, true, 'le dossier par defaut jamais utilise ne doit pas passer pour un probleme');
  assert.equal(state.downloadsExists, false);
  assert.equal(state.downloadsWritable, true, 'le parent s\'ecrit, donc le dossier s\'ecrira');
  assert.equal(state.downloadsWillCreate, true);
  assert.equal(state.downloadsErrorCode, null);
});

check('dossier absent et impossible a creer : refuse, avec un code comprehensible', () => {
  const state = storage.finalizeProbe({ ok: false, code: 'MISSING_DIRECTORY', parent: '', creatable: false });
  assert.equal(state.downloadsOk, false);
  assert.equal(state.downloadsWillCreate, false);
  // MISSING_DIRECTORY est un code interne : traduit tel quel, il enverrait
  // l'utilisateur creer un dossier a la main la ou il ne peut pas ecrire.
  assert.equal(state.downloadsErrorCode, 'NO_PERMISSION');
  assert.equal(state.downloadsErrorKey, 'path.error.noPermission');
  assert.ok(translated(state.downloadsErrorKey), 'le libelle doit exister dans les trois langues');
});

check('lecteur parti : le code reste DRIVE_UNAVAILABLE, existe = false', () => {
  const state = storage.finalizeProbe({ ok: false, code: 'DRIVE_UNAVAILABLE', path: CHOSEN_DIR });
  assert.equal(state.downloadsOk, false);
  assert.equal(state.downloadsErrorCode, 'DRIVE_UNAVAILABLE');
  assert.equal(state.downloadsExists, false, 'le chemin n\'est pas la, il faut pouvoir le dire');
  assert.ok(translated(state.downloadsErrorKey));
});

check('dossier la mais en lecture seule : existe = true', () => {
  const state = storage.finalizeProbe({ ok: false, code: 'NO_PERMISSION', path: CHOSEN_DIR });
  assert.equal(state.downloadsOk, false);
  assert.equal(state.downloadsExists, true);
  assert.equal(state.downloadsErrorCode, 'NO_PERMISSION');
});

// ---------------------------------------------------------------------------
// 2. Une seule decision, partagee par la page et par le telechargement
// ---------------------------------------------------------------------------

const PROBES = [
  { label: 'ok', probe: { ok: true, path: DEFAULT_DIR } },
  { label: 'absent creable', probe: { ok: false, code: 'MISSING_DIRECTORY', creatable: true } },
  { label: 'absent non creable', probe: { ok: false, code: 'MISSING_DIRECTORY', creatable: false } },
  { label: 'sans droit', probe: { ok: false, code: 'NO_PERMISSION' } },
  { label: 'lecteur parti', probe: { ok: false, code: 'DRIVE_UNAVAILABLE' } },
  { label: 'nom de fichier', probe: { ok: false, code: 'NOT_A_DIRECTORY' } },
];

check('isUsableProbe et finalizeProbe ne se contredisent jamais', () => {
  for (const { label, probe } of PROBES) {
    assert.equal(
      storage.isUsableProbe(probe),
      storage.finalizeProbe(probe).downloadsOk,
      `les deux moities de l'app divergent sur : ${label}`,
    );
  }
});

check('sonde absente = on ecrit quand meme (l\'erreur remonte, pas un refus preventif)', () => {
  assert.equal(storage.isUsableProbe(undefined), true);
});

// ---------------------------------------------------------------------------
// 3. Le plan d'ecriture
// ---------------------------------------------------------------------------

check('premiere utilisation : on ecrit dans le defaut, aucun faux repli annonce', () => {
  const plan = downloads.planDownload({
    dir: DEFAULT_DIR,
    defaultDir: DEFAULT_DIR,
    suggested: 'rapport.pdf',
    existing: [],
    // Ce que renvoie la sonde de `attach` : le dossier est cree a cette occasion.
    probe: { ok: true, created: true, path: DEFAULT_DIR },
    defaultProbe: { ok: true, created: false, path: DEFAULT_DIR },
  });
  assert.equal(plan.mode, 'write');
  assert.equal(plan.dir, DEFAULT_DIR);
  assert.equal(plan.usedFallback, undefined, 'un repli ici enverrait une notification mensongere');
});

check('sonde sans creation : absent mais creable reste la bonne destination', () => {
  const plan = downloads.planDownload({
    dir: CHOSEN_DIR,
    defaultDir: DEFAULT_DIR,
    suggested: 'rapport.pdf',
    existing: [],
    probe: { ok: false, code: 'MISSING_DIRECTORY', creatable: true, path: CHOSEN_DIR },
    defaultProbe: { ok: true, path: DEFAULT_DIR },
  });
  assert.equal(plan.mode, 'write');
  assert.equal(plan.dir, CHOSEN_DIR);
  assert.ok(!plan.usedFallback);
});

check('lecteur ejecte : bascule au defaut, avec un message traduit', () => {
  const plan = downloads.planDownload({
    dir: CHOSEN_DIR,
    defaultDir: DEFAULT_DIR,
    suggested: 'rapport.pdf',
    existing: [],
    probe: { ok: false, code: 'DRIVE_UNAVAILABLE', path: CHOSEN_DIR },
    defaultProbe: { ok: true, path: DEFAULT_DIR },
  });
  assert.equal(plan.mode, 'write');
  assert.equal(plan.dir, DEFAULT_DIR);
  assert.equal(plan.usedFallback, true);
  assert.ok(translated(plan.reasonKey), `reasonKey intraduisible : ${plan.reasonKey}`);
});

check('plus aucune destination possible : on demande a l\'operateur', () => {
  const plan = downloads.planDownload({
    dir: CHOSEN_DIR,
    defaultDir: DEFAULT_DIR,
    suggested: 'rapport.pdf',
    probe: { ok: false, code: 'NO_PERMISSION', path: CHOSEN_DIR },
    defaultProbe: { ok: false, code: 'NO_PERMISSION', path: DEFAULT_DIR },
  });
  assert.equal(plan.mode, 'ask');
  assert.equal(plan.dir, '');
});

check('nom deja pris dans la destination : numerote, jamais ecrase', () => {
  const plan = downloads.planDownload({
    dir: DEFAULT_DIR,
    defaultDir: DEFAULT_DIR,
    suggested: 'rapport.pdf',
    existing: ['rapport.pdf'],
    probe: { ok: true, path: DEFAULT_DIR },
  });
  assert.equal(plan.mode, 'write');
  assert.equal(plan.name, 'rapport (2).pdf');
  assert.equal(plan.renamed, true);
});

// ---------------------------------------------------------------------------
// 4. Le nom dans le dossier ou l'on ecrit vraiment
// ---------------------------------------------------------------------------

check('sans repli, le nom du plan est le bon', () => {
  const plan = { mode: 'write', dir: DEFAULT_DIR, name: 'rapport.pdf' };
  assert.equal(downloads.resolveName(plan, ['rapport.pdf']), 'rapport.pdf');
});

check('avec repli, un nom pris la-bas est re-numerote', () => {
  const plan = { mode: 'write', dir: DEFAULT_DIR, name: 'rapport.pdf', usedFallback: true };
  assert.equal(downloads.resolveName(plan, ['rapport.pdf']), 'rapport (2).pdf');
});

check('avec repli, un nom libre la-bas est garde', () => {
  const plan = { mode: 'write', dir: DEFAULT_DIR, name: 'rapport.pdf', usedFallback: true };
  assert.equal(downloads.resolveName(plan, ['autre.pdf']), 'rapport.pdf');
});

check('un nom sans extension survit a la re-numerotation', () => {
  const plan = { mode: 'write', dir: DEFAULT_DIR, name: 'LICENSE', usedFallback: true };
  assert.equal(downloads.resolveName(plan, ['LICENSE']), 'LICENSE (2)');
  assert.equal(downloads.resolveName(plan, []), 'LICENSE');
});

check("un plan sans destination n'invente pas un nom", () => {
  assert.equal(downloads.resolveName({ name: 'rapport.pdf' }, []), 'rapport.pdf');
  assert.equal(downloads.resolveName(null, []), '');
});

// ---------------------------------------------------------------------------
// 5. Ce que le disque, pas la politique, decidera
// ---------------------------------------------------------------------------

check("le dossier est cree avant de planifier (Chromium n'invente pas de repertoire)", () => {
  // Assertion de source, la seule facon de tester l'ordre sans Electron : la
  // notification "a creer" promise par la page Stockage ne tient que si le
  // chemin d'ecriture cree vraiment le dossier avant de le promettre.
  const source = readFileSync(path.join(root, 'main/downloads.js'), 'utf8');
  const will = source.indexOf('plan = planDownload(');
  assert.ok(will > -1, 'le telechargement ne passe plus par planDownload');
  const block = source.slice(will, source.indexOf(');\n', will) + 2);
  assert.match(block, /probe:\s*storage\.probeDirectory\(context\.downloadsDir,\s*\{\s*create:\s*true\s*\}\s*\)/);
});

check('la politique de chemin est bien celle de Windows (et le dit)', () => {
  // Rappele ici parce que c'est la raison pour laquelle les tests ci-dessus
  // simulent les sondes au lieu de creer des dossiers : sur ce depot de
  // developpement, un chemin POSIX est refuse par la politique, pas par le disque.
  assert.equal(rules.isAbsolute('/home/user/Downloads'), false);
  assert.equal(rules.isAbsolute('C:\\Users\\me\\Downloads'), true);
});

// ---------------------------------------------------------------------------
// 6. Le meme verdict, confronte au disque
// ---------------------------------------------------------------------------

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'soocial-downloads-'));
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

try {
  const writableParent = path.join(sandbox, 'Downloads');
  mkdirSync(writableParent);
  const missing = path.join(writableParent, 'Soocial');

  check('sonde reelle : absent sous un parent ecrivable = creable', () => {
    const probe = storage.probeDirectory(missing);
    assert.equal(probe.ok, false);
    assert.equal(probe.code, 'MISSING_DIRECTORY');
    assert.equal(probe.parent, writableParent);
    assert.equal(probe.creatable, true);
    const state = storage.finalizeProbe(probe);
    assert.equal(state.downloadsOk, true);
    assert.equal(state.downloadsWillCreate, true);
  });

  check('sonde reelle avec creation : le dossier apparait, puis est "la"', () => {
    const probe = storage.probeDirectory(missing, { create: true });
    assert.equal(probe.ok, true);
    assert.equal(probe.created, true);
    assert.equal(statSync(missing).isDirectory(), true);
    const state = storage.finalizeProbe(storage.probeDirectory(missing));
    assert.deepEqual(
      [state.downloadsOk, state.downloadsExists, state.downloadsWritable, state.downloadsWillCreate],
      [true, true, true, false],
    );
  });

  check('sonde reelle : un fichier n\'est pas un dossier', () => {
    const file = path.join(sandbox, 'rapport.pdf');
    writeFileSync(file, 'x');
    assert.equal(storage.probeDirectory(file).code, 'NOT_A_DIRECTORY');
  });

  check('sonde reelle : un chemin relatif est refuse, pas resolu a l\'aveugle', () => {
    // Resoudre "Soocial" contre le repertoire courant creerait un dossier la ou
    // personne n'a rien demande, et le referait a chaque lancement d'un autre cwd.
    const probe = storage.probeDirectory('Soocial');
    assert.equal(probe.ok, false);
    assert.equal(probe.code, 'NOT_ABSOLUTE');
    assert.equal(statSync(path.join(root, 'Soocial'), { throwIfNoEntry: false }), undefined);
  });

  if (asRoot) {
    console.log('SKIP un parent en lecture seule rend la creation impossible (root ignore le mode)');
  } else {
    check('un parent en lecture seule rend la creation impossible', () => {
      const sealed = path.join(sandbox, 'scelle');
      mkdirSync(sealed);
      chmodSync(sealed, 0o500); // r-x : on lit, on n'ecrit pas
      try {
        const probe = storage.probeDirectory(path.join(sealed, 'Soocial'));
        assert.equal(probe.code, 'MISSING_DIRECTORY');
        assert.equal(probe.creatable, false);
        const state = storage.finalizeProbe(probe);
        assert.equal(state.downloadsOk, false, 'la, le rouge est merite');
        assert.equal(state.downloadsWillCreate, false);
        assert.equal(state.downloadsErrorCode, 'NO_PERMISSION');
        assert.equal(state.downloadsExists, false);
        assert.ok(translated(state.downloadsErrorKey));
      } finally {
        chmodSync(sealed, 0o700);
      }
    });
  }

  check('enregistrer un dossier creable le cree et ne stocke rien si c\'est le defaut', () => {
    const fresh = path.join(sandbox, 'choisi', 'Soocial');
    const store = new Map();
    const res = storage.setDownloadsDir({
      store: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) },
      roots: { downloadsDefault: path.join(sandbox, 'defaut', 'Soocial') },
      candidate: fresh,
    });
    assert.equal(res.ok, true);
    assert.equal(res.created, true, 'la consigne est la creation a la volee');
    assert.equal(res.isDefault, false);
    assert.equal(store.get('downloads'), fresh, 'un dossier distinct du defaut doit etre memore');
    assert.equal(statSync(fresh).isDirectory(), true);
  });

  check('enregistrer le defaut memore null (et non un chemin en dur)', () => {
    const defaut = path.join(sandbox, 'defaut2', 'Soocial');
    const store = new Map([['downloads', 'E\\:\\Tel\\Soocial']]);
    const res = storage.setDownloadsDir({
      store: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) },
      roots: { downloadsDefault: defaut },
      candidate: defaut,
    });
    assert.equal(res.ok, true);
    assert.equal(res.isDefault, true);
    assert.equal(store.get('downloads'), null);
  });

  check('enregistrer un chemin refuse ne memore rien', () => {
    const store = new Map();
    const api = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
    const args = { store: api, roots: { downloadsDefault: path.join(sandbox, 'defaut3', 'Soocial') } };
    assert.equal(storage.setDownloadsDir({ ...args, candidate: 'Soocial' }).code, 'NOT_ABSOLUTE');
    assert.equal(storage.setDownloadsDir({ ...args, candidate: '   ' }).code, 'EMPTY');
    assert.equal(store.size, 0, 'un echec ne doit rien laisser dans les reglages');
  });

  check('describe rend le meme etat que la sonde, sur le vrai disque', () => {
    const defaut = path.join(sandbox, 'decrit', 'Soocial');
    const state = storage.describe({
      store: { get: () => null },
      roots: { data: sandbox, cache: sandbox, downloadsDefault: defaut },
    });
    assert.equal(state.downloads, defaut);
    assert.equal(state.downloadsIsDefault, true);
    assert.equal(state.downloadsOk, true, 'le defaut jamais utilise ne doit pas etre une panne');
    assert.equal(state.downloadsWillCreate, true);
    assert.deepEqual(state.warnings, []);
  });
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------

console.log(failures ? `\n${failures} echec(s)` : `\nstorage-downloads: tout est vert (${PROBES.length} sondes, ${Object.keys(locales.en).length} cles par langue)`);
process.exit(failures ? 1 : 0);

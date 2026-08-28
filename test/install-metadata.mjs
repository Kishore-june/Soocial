#!/usr/bin/env node
/**
 * Le contrat install.json, teste sans ecrire de fichier.
 *
 * `install.json` est la seule trace lisible par l'app de " ou le dossier a-t-il
 * ete choisi ". Deux de ses modes de defaillance viennent de l'installeur lui-meme
 * (coupure en pleine ecriture, update qui doit conserver l'historique), et les
 * deux se traitent ici, pas dans le NSIS — c'est pour ca que ces lignes existent.
 */

import path from 'node:path';
import assert from 'node:assert/strict';
import { serialize, parse, consistency, mergeForUpdate, normalizeChannel, SCHEMA_VERSION } from '../shared/install-metadata.js';

const win32 = path.win32;
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

// La forme plate est celle des faits releves au moment d'ecrire (installeur, ou
// reparation depuis les reglages) ; la forme imbriquee est celle du fichier relu.
// Les deux doivent produire le MEME fichier, sinon une reecriture perd des champs.
const RECORD = {
  installPath: 'D:\\Apps\\Soocial',
  version: '1.2.0',
  channel: 'stable',
  architecture: 'x64',
  installationId: 'd:/apps/soocial',
  firstInstall: '2026-01-04T09:00:00.000Z',
  engine: 'nsis',
  appId: 'com.soocial.desktop',
  scope: 'perMachine',
  shortcutName: 'Soocial',
  desktopShortcut: true,
  startMenuShortcut: true,
  desktopLink: 'C:\\Users\\Public\\Desktop\\Soocial.lnk',
};

const NESTED = {
  installPath: RECORD.installPath,
  version: RECORD.version,
  channel: 'stable',
  architecture: 'x64',
  installationId: RECORD.installationId,
  firstInstall: RECORD.firstInstall,
  installer: { engine: 'nsis', appId: RECORD.appId, scope: 'perMachine', shortcutName: 'Soocial' },
  shortcuts: { desktop: true, startMenu: true, desktopLink: RECORD.desktopLink },
};
check('ce qui est ecrit se relit a l\u2019identique', () => {
  const text = serialize(RECORD);
  assert.ok(text.endsWith('\n'), 'un fichier sans saut de ligne final se lit comme coupe');
  const { record, issues } = parse(text);
  assert.deepEqual(issues, []);
  assert.equal(record.installPath, RECORD.installPath);
  assert.equal(record.shortcuts.desktopLink, RECORD.desktopLink);
  assert.equal(record.shortcuts.desktop, true);
  assert.equal(record.installer.appId, 'com.soocial.desktop');
  assert.equal(record.schemaVersion, SCHEMA_VERSION);
});

check('les deux formes d\u2019entree produisent le meme fichier', () => {
  // C\u2019est la propriete qui protege une reparation : relire install.json, corriger
  // un champ, reecrire. Si serialize ne connaissait que la forme plate, la
  // deuxieme passe effacerait installer.* et shortcuts.* sans lever le moindre
  // signal, et l\u2019installeur du prochain update ne trouverait plus de trace.
  assert.equal(serialize(NESTED), serialize(RECORD));
  assert.equal(serialize(parse(serialize(RECORD)).record), serialize(RECORD));
});

check('le chemin garde ses anti-slashes dans le JSON', () => {
  // C'est le seul endroit de la chaine ou un `\` doit etre double : si le
  // serialiseur oubliait l'echappement, le fichier serait illisible et le
  // chemin perdu.
  const text = serialize(RECORD);
  assert.match(text, /"installPath": "D:\\\\Apps\\\\Soocial"/);
});

check('install.json absent : absences distinctes de illisibles', () => {
  assert.deepEqual(parse(''), { record: null, issues: ['missing'] });
  assert.deepEqual(parse(null).issues, ['missing']);
});

check('installeur coupe en pleine ecriture : les champs passes sont recuperes', () => {
  // Cas reel : plus d'electricite pendant l'ecriture du fichier. Le tronc est du
  // JSON invalide, et `installPath` est justement le champ qui dit sur quel
  // disque la mise a jour devra repartir.
  const truncated = `{
  "schemaVersion": 1,
  "product": "Soocial",
  "installPath": "E:\\Messagerie\\Soocial",
  "version": "1.0.0",
  "channel": "stable",
  "archite`;

  const { record, issues } = parse(truncated);
  assert.deepEqual(issues, ['truncated']);
  assert.equal(record.installPath, 'E:\\Messagerie\\Soocial');
  assert.equal(record.version, '1.0.0');
});

check('tronc sans installPath : aucun chemin invente', () => {
  const { record, issues } = parse('{ "product": "Soocial", "ver');
  assert.equal(record, null);
  assert.deepEqual(issues, ['unreadable']);
});

check('champs obligatoires manquant : signales, pas devines', () => {
  const { record, issues } = parse(JSON.stringify({ product: 'Soocial', version: '1.0.0' }));
  assert.ok(issues.includes('missing:installPath'), issues.join(','));
  assert.ok(issues.includes('missing:channel'), issues.join(','));
  assert.ok(record, 'le fichier reste exploitable malgre tout');
});

check('schema plus recent : signale, pas rejete', () => {
  // serialize force le schema courant : un fichier futur ne peut venir que d'une
  // autre version de l'app. Le refuser n'aurait aucun sens -- l'app sait lire ce
  // qu'elle connait et doit dire qu'elle a vu plus recent.
  const future = JSON.parse(serialize(RECORD));
  future.schemaVersion = SCHEMA_VERSION + 1;
  const { record, issues } = parse(JSON.stringify(future));
  assert.deepEqual(issues, [`schema:${SCHEMA_VERSION + 1}`]);
  assert.equal(record.installPath, RECORD.installPath);
});

check('un update conserve firstInstall et installationId', () => {
  // Ces deux champs repondent a " depuis quand cette machine est installee la "
  // et servent a retrouver l'entree de registre. Les reecrire a chaque mise a
  // jour effacerait l'historique sans que personne ne s'en apercoive.
  const next = mergeForUpdate(RECORD, { version: '1.3.0', installPath: 'D:\\Apps\\Soocial', channel: 'stable' });
  assert.equal(next.version, '1.3.0');
  assert.equal(next.firstInstall, RECORD.firstInstall);
  assert.equal(next.installationId, RECORD.installationId);
});

check('update sans enregistrement precedent : le nouveau gagne', () => {
  const next = mergeForUpdate(null, { installationId: 'z', firstInstall: 'y', version: '2.0.0' });
  assert.equal(next.installationId, 'z');
  assert.equal(next.firstInstall, 'y');
});

check('coherence chemin enregistre / executable reel', () => {
  assert.equal(consistency(RECORD, 'D:\\Apps\\Soocial\\Soocial.exe', win32).status, 'match');
  // Un `\\` de plus ou de moins ne doit pas faire croire a une autre installation :
  // c'est exactement ce que produit une concatenation mal jointoyee.
  assert.equal(consistency({ ...RECORD, installPath: 'D:\\Apps\\Soocial\\' }, 'D:\\Apps\\Soocial\\Soocial.exe', win32).status, 'match');
  assert.equal(consistency(RECORD, 'C:\\Program Files\\Soocial\\Soocial.exe', win32).status, 'mismatch');
  assert.equal(consistency({ ...RECORD, installPath: 'D:\\Apps' }, 'D:\\Apps\\Soocial\\Soocial.exe', win32).status, 'nested');
  assert.equal(consistency(null, 'D:\\Apps\\Soocial\\Soocial.exe', win32).status, 'unknown');
});

check('la casse du lecteur ne cree pas une fausse divergence', () => {
  assert.equal(consistency({ ...RECORD, installPath: 'd:\\apps\\soocial' }, 'D:\\Apps\\Soocial\\Soocial.exe', win32).status, 'match');
});

check('canal inconnu ramene a stable', () => {
  // Un canal invente enverrait l'updater chercher un fichier qui n'existe pas,
  // et l'utilisateur lirait " aucune mise a jour disponible ".
  assert.equal(normalizeChannel('BETA'), 'beta');
  assert.equal(normalizeChannel('nightly'), 'stable');
  assert.equal(normalizeChannel(undefined), 'stable');
});

console.log(failures ? `\n${failures} echec(s)` : '\ninstall-metadata: tout est vert');
process.exit(failures ? 1 : 0);

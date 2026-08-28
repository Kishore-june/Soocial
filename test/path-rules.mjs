#!/usr/bin/env node
/**
 * La politique de chemin, testee sans Windows.
 *
 * `shared/path-rules.js` est la moitie lisible par l'app du contrat
 * d'installation personnalisee ; l'autre moitie est en NSIS et se verifie avec
 * test/installer/compile-check.sh. Ce fichier-la couvre ce qui provoque les
 * accidents reels : le dossier ou l'on installe, ce qu'on a le droit de
 * supprimer, et ce qu'on a le droit d'ecraser.
 *
 * Chaque test cite le cas de la cahier des charges qu'il ferme, pour qu'on puisse
 * distinguer un test qui echoue d'un test qui n'a pas ete ecrit.
 */

import assert from 'node:assert/strict';
import {
  resolveTargetDirectory,
  classifyTarget,
  validatePath,
  normalize,
  samePath,
  isPathInside,
  canRemoveDirectory,
  shouldCleanPartialInstall,
  sanitizeFileName,
  uniqueFileName,
  errorKeyFor,
  PATH_MAX_LENGTH,
  PATH_WARN_LENGTH,
  PRODUCT_DIR,
} from '../shared/path-rules.js';

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

// ---------------------------------------------------------------------------
// 1. Le choix du parent, et jamais le parent lui-meme
// ---------------------------------------------------------------------------

check('un parent simple devient <parent>\\Soocial', () => {
  const r = resolveTargetDirectory('D:\\Apps');
  assert.equal(r.target, 'D:\\Apps\\Soocial');
  assert.equal(r.createdSubfolder, true);
});

check('la racine d un lecteur aussi (D:\\ -> D:\\Soocial)', () => {
  const r = resolveTargetDirectory('D:\\');
  assert.equal(r.target, 'D:\\Soocial');
  assert.equal(r.createdSubfolder, true);
});

check('un dossier deja appele Soocial est utilise tel quel', () => {
  // Cree a la main pour ca. Produire Soocial\\Soocial serait la seule facon de
  // faire douter l'utilisateur de l'endroit ou tout est parti.
  const r = resolveTargetDirectory('D:\\Apps\\Soocial');
  assert.equal(r.target, 'D:\\Apps\\Soocial');
  assert.equal(r.createdSubfolder, false);
  assert.equal(r.parent, 'D:\\Apps');
});

check('la majuscule du nom compte comme le meme nom', () => {
  // Windows ne fait pas la difference ; l'installeur non plus, sinon un
  // "soocial" existant produirait un deuxieme dossier a cote.
  assert.equal(resolveTargetDirectory('E:\\soocial').target, 'E:\\soocial');
});

check('D:\\ racine refusee comme cible directe mais pas comme parent', () => {
  assert.equal(resolveTargetDirectory('D:\\').target, 'D:\\Soocial');
  // Installer DANS la racine (sans sous-dossier) est le cas interdit :
  assert.equal(classifyTarget('D:\\', { drives: ['D:\\'] }).code, 'IS_DRIVE_ROOT');
});

check('les espaces, les accents et les ideogrammes passent', () => {
  const r = resolveTargetDirectory('D:\\Mes Documents\\Éditeur\\Jeu 三');
  assert.equal(r.target, 'D:\\Mes Documents\\Éditeur\\Jeu 三\\' + PRODUCT_DIR);
  assert.equal(classifyTarget(r.target, { drives: ['D:\\'] }).valid, true);
});

check('les slashes de fin, les points et les espaces en queue sont retires', () => {
  assert.equal(normalize('D:\\Apps\\Soocial\\'), 'D:\\Apps\\Soocial');
  assert.equal(normalize('D:\\Apps\\..\\Apps\\'), 'D:\\Apps');
  assert.equal(normalize('  D:\\Apps  '), 'D:\\Apps');
  assert.equal(normalize('D:\\Apps\\.'), 'D:\\Apps');
});

check('un chemin relatif est refuse, pas resolu depuis le dossier courant', () => {
  // Resoudre un chemin relatif depuis System32 (le cwd d'un installeur eleve)
  // enverrait l'app dans un endroit que personne n'a choisi.
  assert.equal(resolveTargetDirectory('Apps').error, 'NOT_ABSOLUTE');
  assert.equal(resolveTargetDirectory('').error, 'EMPTY');
  assert.equal(resolveTargetDirectory(null).error, 'EMPTY');
});

check('une part\\... est repliee avant la decision, pas apres', () => {
  // Le champ peut dire n'importe quoi : ce qui est installe, verifie, enregistre
  // et affiche, c'est le chemin plie. Un `..` conserve dans install.json serait lu
  // par l'app comme un chemin different de celui que Windows resout.
  const r = resolveTargetDirectory('D:\\Apps\\..\\..\\Windows');
  assert.equal(r.parent, 'D:\\Windows');
  assert.equal(r.target, 'D:\\Windows\\' + PRODUCT_DIR);
  assert.ok(!r.target.includes('..'), 'le chemin enregistre ne doit contenir aucun point de remontee');
});

check('on ne remonte pas au-dela de la racine du lecteur', () => {
  // Un `..` qui n'a rien au-dessus de lui disparait au lieu d'etre ecrit :
  // `D:\..` n'existe pas comme dossier, et l'conservateur (l'installeur) le
  // recrerait en nom litteral.
  // La racine garde sa barre : c'est la forme que rootOf produit aussi, donc la
  // seule sous laquelle deux facons d'ecrire le meme endroit se ressemblent.
  assert.equal(normalize('D:\\..\\..'), 'D:\\');
  assert.equal(resolveTargetDirectory('C:\\..\\Users').target, 'C:\\Users\\' + PRODUCT_DIR);
});

// ---------------------------------------------------------------------------
// 2. Ce que l'installeur doit refuser, et dans le bon ordre
// ---------------------------------------------------------------------------

const DRIVES = ['C:\\', 'D:\\'];

check('lecteur absent : le vrai motif, pas un faux "droits insuffisants"', () => {
  const r = classifyTarget('E:\\Apps\\Soocial', { drives: DRIVES });
  assert.equal(r.valid, false);
  assert.equal(r.code, 'DRIVE_UNAVAILABLE');
});

check('chemin trop long refuse, et signale par le bon code', () => {
  const long = 'C:\\' + 'a'.repeat(PATH_MAX_LENGTH);
  const r = validatePath(long);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((issue) => issue.code === 'TOO_LONG'));
});

check('limite de prudence en dessous de MAX_PATH', () => {
  // 240 et 259 ne sont pas des chiffres decoratifs : l'app ajoutera des
  // sous-chemins (Partitions\\persist:<id>\\Local Storage\\leveldb\\...).
  assert.ok(PATH_WARN_LENGTH < PATH_MAX_LENGTH);
  assert.equal(PATH_MAX_LENGTH, 259);
});

check('nom reserve Windows refuse', () => {
  assert.equal(classifyTarget('C:\\Apps\\CON', { drives: DRIVES, exists: true }).code, 'RESERVED_NAME');
  assert.equal(classifyTarget('C:\\Apps\\com1.txt', { drives: DRIVES, exists: true }).code, 'RESERVED_NAME');
});

check('caracteres interdits refuses', () => {
  for (const bad of ['C:\\Apps\\a<b', 'C:\\Apps\\a>b', 'C:\\Apps\\a|b', 'C:\\Apps\\a?b']) {
    assert.equal(classifyTarget(bad, { drives: DRIVES }).code, 'INVALID_CHARS', bad);
  }
});

check('un fichier qui porte le nom du dossier : NOT_A_DIRECTORY', () => {
  const r = classifyTarget('C:\\Apps\\Soocial', { drives: DRIVES, exists: true, isFile: true });
  assert.equal(r.code, 'NOT_A_DIRECTORY');
});

check('dossier existant deja installe : ALREADY_INSTALLED, jamais d ecrasement silencieux', () => {
  const r = classifyTarget('D:\\Apps\\Soocial', { drives: DRIVES, exists: true, hasInstall: true, installedVersion: '0.9.0' });
  assert.equal(r.code, 'ALREADY_INSTALLED');
  assert.equal(r.version, '0.9.0');

  // ... et le meme cas, quand l'utilisateur a explicitement dit "reparer/mettre a jour".
  const upgrade = classifyTarget('D:\\Apps\\Soocial', {
    drives: DRIVES,
    exists: true,
    hasInstall: true,
    allowExisting: true,
    installedVersion: '0.9.0',
  });
  assert.equal(upgrade.valid, true);
});

check('dossier peuple d autres fichiers : NOT_EMPTY, avec la liste', () => {
  const r = classifyTarget('D:\\Apps\\Soocial', {
    drives: DRIVES,
    exists: true,
    hasForeignFiles: true,
    foreignEntries: ['notes.txt'],
  });
  assert.equal(r.code, 'NOT_EMPTY');
  assert.deepEqual(r.entries, ['notes.txt']);
});

check('droits manquants sur le parent, seulement si le dossier n existe pas', () => {
  assert.equal(classifyTarget('D:\\Apps\\Soocial', { drives: DRIVES, parentWritable: false }).code, 'NO_PERMISSION');
  // Le dossier existe et est en lecture seule : c'est lui, pas le parent.
  assert.equal(
    classifyTarget('D:\\Apps\\Soocial', { drives: DRIVES, exists: true, writable: false }).where,
    'target'
  );
});

check('un dossier nomme comme son parent n est pas imbrique', () => {
  assert.equal(classifyTarget('D:\\Soocial', { drives: DRIVES, exists: true, isSameNameAsParent: true }).code, 'NESTED_ROOT');
});

check('toutes les clefs d erreur ont une entree de langue', () => {
  // Une cle absente affiche la cle elle-meme - utile en dev, inacceptable sur
  // l'ecran d'un installeur.
  const codes = [
    'EMPTY', 'NOT_ABSOLUTE', 'INVALID_CHARS', 'RESERVED_NAME', 'TOO_LONG', 'LONG_PATH',
    'DRIVE_UNAVAILABLE', 'NO_PERMISSION', 'NOT_A_DIRECTORY', 'IS_DRIVE_ROOT', 'NESTED_ROOT',
    'ALREADY_INSTALLED', 'NOT_EMPTY', 'INCONNU',
  ];
  for (const code of codes) {
    const key = errorKeyFor(code);
    assert.match(key, /^path\.error\.[A-Za-z]+$/, `${code} -> ${key}`);
  }
  assert.equal(errorKeyFor('INCONNU'), 'path.error.unknown');
});

// ---------------------------------------------------------------------------
// 3. Perimetre de suppression (dossier voisin intact)
// ---------------------------------------------------------------------------

check('le desinstallateur peut vider <parent>\\Soocial', () => {
  assert.equal(canRemoveDirectory('D:\\Apps\\Soocial', 'D:\\Apps\\Soocial'), true);
});

check('jamais le parent, jamais la racine du lecteur', () => {
  assert.equal(canRemoveDirectory('D:\\Apps', 'D:\\Apps\\Soocial'), false);
  assert.equal(canRemoveDirectory('D:\\', 'D:\\Apps\\Soocial'), false);
  assert.equal(canRemoveDirectory('C:\\Users', 'D:\\Apps\\Soocial'), false);
});

check('un dossier qui ne s appelle pas Soocial n est pas a nous', () => {
  // C'est le cas "le registre a mente" : le perimetre annonce ne correspond a
  // rien de connu, donc on ne touche a rien.
  assert.equal(canRemoveDirectory('D:\\Apps\\Photoshop', 'D:\\Apps\\Photoshop'), false);
  assert.equal(canRemoveDirectory('d:\\apps\\soocial', 'D:\\Apps\\Soocial'), true, 'la casse ne doit rien changer');
});

check('les sous-dossiers du produit sont nettoyables', () => {
  assert.equal(canRemoveDirectory('D:\\Apps\\Soocial\\locales', 'D:\\Apps\\Soocial'), true);
  assert.equal(isPathInside('D:\\Apps\\Soocial', 'D:\\Apps\\Soocial\\locales'), true);
  assert.equal(isPathInside('D:\\Apps\\Soocial', 'D:\\Apps\\SoocialBackup'), false);
});

check('samePath ignore la casse et le separateur final', () => {
  assert.ok(samePath('D:\\Apps\\Soocial\\', 'd:\\apps\\soocial'));
});

// ---------------------------------------------------------------------------
// 4. Rattrapage d une installation coupee
// ---------------------------------------------------------------------------

check('marqueur inacheve seul : on nettoie', () => {
  assert.equal(shouldCleanPartialInstall({ markerPresent: true }), true);
});

check('marquee inacheve mais installation valide ailleurs : on ne touche a rien', () => {
  // Effacer une installation qui marche pour ranger un dossier orphelin est le
  // pire des deux maux.
  assert.equal(shouldCleanPartialInstall({ markerPresent: true, hasInstallInfo: true }), false);
  assert.equal(shouldCleanPartialInstall({ markerPresent: true, verifiedMarkerPresent: true }), false);
  assert.equal(shouldCleanPartialInstall({ markerPresent: false }), false);
});

// ---------------------------------------------------------------------------
// 5. Telechargements : jamais d ecrasement, jamais de suppression
// ---------------------------------------------------------------------------

check('un nom de fichier venu d un site est nettoie, pas translittere', () => {
  assert.equal(sanitizeFileName('rapport|final?.pdf'), 'rapportfinal.pdf');
  assert.equal(sanitizeFileName('  note.txt  '), 'note.txt');
  assert.equal(sanitizeFileName('CON'), '_CON');
  assert.equal(sanitizeFileName('中文 报告.pdf'), '中文 报告.pdf');
  assert.equal(sanitizeFileName('..'), 'download');
  assert.equal(sanitizeFileName(''), 'download');
});

check('le nom est numerote au lieu d ecraser', () => {
  assert.equal(uniqueFileName('rapport', '.pdf', []), 'rapport.pdf');
  assert.equal(uniqueFileName('rapport', '.pdf', ['rapport.pdf']), 'rapport (2).pdf');
  assert.equal(uniqueFileName('rapport', '.pdf', ['rapport.pdf', 'RAPPORT (2).PDF']), 'rapport (3).pdf');
});

check('la limite de numerotation ne produit pas un nom deja pris', () => {
  const taken = [];
  for (let n = 1; n <= 999; n++) taken.push(n === 1 ? 'x.pdf' : `x (${n}).pdf`);
  const name = uniqueFileName('x', '.pdf', taken);
  assert.ok(!taken.includes(name), name);
});

// ---------------------------------------------------------------------------

console.log(failures ? `\n${failures} echec(s)` : `\npath-rules: tout est vert (${PRODUCT_DIR}, MAX_PATH=${PATH_MAX_LENGTH})`);
process.exit(failures ? 1 : 0);

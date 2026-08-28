#!/usr/bin/env node
/**
 * Garde-fou du contrat installeur <-> app.
 *
 * Trois surfaces ecrivent les memes noms : package.json (ce que electron-builder
 * passe a makensis en !define), installer/custom.nsh (ce que l'installeur fait de
 * ces defines) et shared/*.js (ce que l'app lit ensuite). Rien ne les relie a la
 * compilation, et c'est exactement pour cela que ce test existe : un nom change
 * dans un seul des trois fichiers se voit a l'installation, jamais avant.
 *
 * Le test lit les fichiers, il ne les interprete pas. La verification que le
 * script compile vraiment est dans test/installer/compile-check.sh.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

const failures = [];
const checks = [];

function check(name, fn) {
  checks.push(name);
  try {
    const problem = fn();
    if (problem) failures.push(`${name}: ${problem}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

const pkg = JSON.parse(read('package.json'));
const nsh = read('installer/custom.nsh');
const productSource = read('shared/product.js');
const codesSource = read('shared/installer-codes.js');
const rulesSource = read('shared/path-rules.js');
const metadataSource = read('shared/install-metadata.js');

// `shared/installer-codes.js` est importe pour de vrai : c'est la seule facon de
// comparer des valeurs et pas des chaines que j'aurais recopiees ici.
const codes = await import(path.join(root, 'shared/installer-codes.js'));
const { PRODUCT } = await import(path.join(root, 'shared/product.js'));

/** Un !define de custom.nsh, sous la forme `!define NOM valeur`. */
function define(name) {
  const match = nsh.match(new RegExp(`!define\\s+${name}\\s+("([^"]*)"|(\\S+))`));
  if (!match) return null;
  return (match[2] ?? match[3] ?? '').trim();
}

// ---------------------------------------------------------------- codes ------

check('exit codes', () => {
  for (const [key, constant] of Object.entries(codes.NSIS_NAMES)) {
    const declared = define(constant);
    if (declared === null) return `${constant} is not defined in installer/custom.nsh`;
    if (Number(declared) !== codes.CODES[key]) {
      return `${constant} is ${declared} in NSIS but ${codes.CODES[key]} in shared/installer-codes.js`;
    }
  }
  return null;
});

check('installer constants', () => {
  const expected = {
    SOO_DIR_NAME: PRODUCT.dirName,
    SOO_REGISTRY_KEY: PRODUCT.registryKey,
    SOO_METADATA_JSON: PRODUCT.metadataFile,
    SOO_METADATA_INI: 'install.ini',
    SOO_PARTIAL_MARKER: PRODUCT.partialMarker,
  };
  for (const [name, value] of Object.entries(expected)) {
    const declared = define(name);
    if (declared === null) return `${name} missing`;
    // NSIS double les anti-slashes dans les chaines de chemin registre.
    const normalized = declared.replace(/\\\\/g, '\\');
    if (normalized !== value) return `${name} is "${declared}" in NSIS, "${value}" in shared/product.js`;
  }
  return null;
});

check('path limits', () => {
  const maxPath = Number(define('SOO_PATH_MAX'));
  const rulesMax = Number((rulesSource.match(/PATH_MAX_LENGTH\s*=\s*(\d+)/) || [])[1]);
  if (!Number.isFinite(maxPath) || !Number.isFinite(rulesMax)) return 'PATH_MAX introuvable dans lun des deux fichiers';
  if (maxPath !== rulesMax) return `SOO_PATH_MAX=${maxPath} mais shared/path-rules.js attend ${rulesMax}`;
  return null;
});

// ------------------------------------------------------------- languages -----

/**
 * Tables de langues de l'installateur.
 *
 * Deux merites d'explication. D'abord, `!ifdef LANG_FRENCH` n'est PAS decoratif :
 * les constantes LANG_* n'existent qu'apres `!insertmacro MUI_LANGUAGE "French"`,
 * et une LangString ecrite pour une langue que le build n'inser pas est une erreur
 * de compilation. Ensuite -- et c'est la que le bas a mordu une fois -- electron-builder
 * ne traduit pas "es" en `Spanish` mais en `SpanishInternational` (nsisLang.js), et
 * NSIS treat les deux comme deux tables distinctes. Un garde `!ifdef LANG_SPANISH`
 * ne se declenche donc jamais dans un build reel : l'installateur affiche ses
 * propres textes en anglais, makensis le dit par un `warning 6040` que seul un
 * build de production traite comme une erreur.
 *
 * Ce verrou lit donc trois sources et exige qu'elles disent la meme chose :
 * package.json (les langues demandees), custom.nsh (les tables nourries) et le
 * harnais de compilation (les tables inserees). Le harnais qui diverge ne voit
 * plus le bug, et rien d'autre ne le remplace avant la release.
 */
check('installer languages and LangStrings', () => {
  const declared = pkg.build?.nsis?.installerLanguages;
  if (!Array.isArray(declared) || !declared.length) return 'build.nsis.installerLanguages absent';

  const wanted = ['en', 'fr', 'es'].sort();
  if (JSON.stringify(declared.slice().sort()) !== JSON.stringify(wanted)) {
    return `installerLanguages est ${JSON.stringify(declared)}, le script est ecrit pour ${JSON.stringify(wanted)}`;
  }

  /** Ce que electron-builder ecrit dans le .nsi pour chaque code (nsisLang.js). */
  const NSIS_NAMES = { en: 'English', fr: 'French', es: 'SpanishInternational' };
  for (const code of declared) {
    if (!NSIS_NAMES[code]) return `langue "${code}" sans correspondance NSIS connue - completer ce test`;
  }

  const symbols = declared.map((code) => `LANG_${NSIS_NAMES[code].toUpperCase()}`);

  // 1. Le harnais doit inserer les memes tables que la production.
  const harness = read('test/installer/compile-check.sh');
  const inserted = [...harness.matchAll(/!insertmacro MUI_LANGUAGE "(\w+)"/g)].map((m) => m[1]);
  for (const code of declared) {
    if (!inserted.includes(NSIS_NAMES[code])) {
      return `test/installer/compile-check.sh insere ${JSON.stringify([...new Set(inserted)])}, sans ${NSIS_NAMES[code]} (${code})`;
    }
  }

  // 2. Chaque table demandee doit etre nourrie par un macro de textes.
  const feeds = [...nsh.matchAll(/!insertmacro (SOO_STRINGS_\w+) \$\{(LANG_[A-Z_]+)\}/g)];
  const fed = feeds.map((m) => m[2]);
  const missing = symbols.filter((symbol) => !fed.includes(symbol));
  if (missing.length) {
    return `aucun texte pour ${missing.join(', ')} : ces langues tomberaient sur une autre table (warning 6040)`;
  }

  // 3. Tous les macros doivent porter la meme liste de cles, sinon une langue
  //    aura un ecran complet et l'autre un melange de deux langues.
  const macros = [...new Set([...nsh.matchAll(/^!macro (SOO_STRINGS_\w+)/gm)].map((m) => m[1]))];
  if (!macros.length) return 'aucun macro SOO_STRINGS_* dans custom.nsh';
  const keysOf = (macro) => {
    const body = nsh.match(new RegExp(`!macro ${macro} SOO_LANG\\n([\\s\\S]*?)\\n!macroend`));
    if (!body) return null;
    return [...body[1].matchAll(/LangString\s+(\w+)/g)].map((m) => m[1]).sort();
  };
  const reference = keysOf(macros[0]);
  if (!reference || !reference.length) return `${macros[0]} ne declare aucun LangString`;
  for (const macro of macros) {
    const keys = keysOf(macro);
    if (!keys) return `${macro} est introuvable ou mal forme`;
    if (JSON.stringify(keys) !== JSON.stringify(reference)) {
      return `${macro} ne porte pas les memes cles que ${macros[0]} (${keys.length} contre ${reference.length})`;
    }
  }
  return null;
});

// ------------------------------------------------------------- hooks ---------

check('custom hooks electron-builder expects', () => {
  const hooks = [
    'customHeader',
    'customInit',
    'customInstall',
    'customUnInstall',
    'customUnInit',
    'customPageAfterChangeDir',
  ];
  for (const hook of hooks) {
    if (!new RegExp(`!macro\\s+${hook}\\b`).test(nsh)) return `!macro ${hook} absent — electron-builder ne l'appellera pas`;
  }
  return null;
});

check('macros balanced', () => {
  const opened = (nsh.match(/^!macro\s+\w+/gm) || []).length;
  const closed = (nsh.match(/^!macroend/gm) || []).length;
  if (opened !== closed) return `${opened} !macro pour ${closed} !macroend`;
  const functions = (nsh.match(/^\s*Function /gm) || []).length;
  const endFunctions = (nsh.match(/^\s*FunctionEnd/gm) || []).length;
  if (functions !== endFunctions) return `${functions} Function pour ${endFunctions} FunctionEnd`;
  const sections = (nsh.match(/^\s*Section\b(?!End)/gm) || []).length;
  const endSections = (nsh.match(/^\s*SectionEnd/gm) || []).length;
  if (sections !== endSections) return `${sections} Section pour ${endSections} SectionEnd`;
  return null;
});

check('no stray model tokens', () => {
  // Deja vu deux fois : un fragment de LaTeX ou un caractere CJK perdu dans un
  // commentaire. makensis ne s'en soucie pas, mais un octet inattendu dans une
  // chaine affichable, ca se voit a l'ecran.
  const bad = [];
  nsh.split('\n').forEach((line, index) => {
    // `${...}` est la syntaxe NSIS elle-meme, pas un residu : seule la forme
    // echappee d'un modele (backslash + math...) ou un ideogramme perdu trahit une
    // saisie accidentelle.
    if (/\\\\math/.test(line) || /[\u3000-\u9fff]/.test(line)) bad.push(index + 1);
  });
  if (bad.length) return `lignes ${bad.join(', ')}: jeton etranger`;
  return null;
});

check('quotes balanced on FileWrite lines', () => {
  // Un guillemet impair dans une ligne FileWrite ne casse pas seulement la ligne:
  // il avale le reste du bloc, et l'erreur remonte dix lignes plus loin.
  const bad = [];
  nsh.split('\n').forEach((line, index) => {
    if (!/FileWrite|DetailPrint|MessageBox|StrCpy|WriteRegStr|CreateDirectory|RMDir/.test(line)) return;
    if (line.trimStart().startsWith(';') || line.includes('\\n')) return;
    const count = (line.match(/(?<!\\)"/g) || []).length;
    if (count % 2 !== 0) bad.push(index + 1);
  });
  if (bad.length) return `guillemets impairs lignes ${bad.join(', ')}`;
  return null;
});

// ------------------------------------------------------------ branding -------

check('branding single source', () => {
  const build = pkg.build || {};
  const problems = [];

  const expectations = {
    'package.json name': [pkg.name, PRODUCT.dirName.toLowerCase()],
    'build.productName': [build.productName, PRODUCT.productName],
    'build.appId': [build.appId, PRODUCT.appId],
    'build.win.executableName': [build.win?.executableName, PRODUCT.executable],
    'build.nsis.shortcutName': [build.nsis?.shortcutName, PRODUCT.name],
    'build.nsis.uninstallDisplayName': [build.nsis?.uninstallDisplayName, PRODUCT.name],
    'build.artifactName': [build.artifactName, '${productName} Setup ${version}.${ext}'],
    'build.nsis.include': [build.nsis?.include, 'installer/custom.nsh'],
  };

  for (const [where, [actual, expected]] of Object.entries(expectations)) {
    if (actual !== expected) problems.push(`${where} = ${JSON.stringify(actual)}, attendu ${JSON.stringify(expected)}`);
  }

  if (build.directories?.buildResources !== 'installer') problems.push('build.directories.buildResources doit pointer sur installer/ (icone + bmp)');
  if (!existsSync(path.join(root, 'installer', 'icon.ico'))) problems.push('installer/icon.ico absent');
  if (build.nsis?.deleteAppDataOnUninstall !== false) problems.push('deleteAppDataOnUninstall doit rester false: desinstaller ne supprime pas les sessions');
  if (build.nsis?.oneClick !== false) problems.push('oneClick doit etre false: sans page de dossier, le chemin personnalise nest pas demande');
  if (build.nsis?.perMachine !== true) problems.push('perMachine doit etre true: Program Files est le defaut annonce');
  if (build.nsis?.allowToChangeInstallationDirectory !== true) problems.push('allowToChangeInstallationDirectory doit etre true');

  return problems.length ? problems.join('; ') : null;
});

check('no legacy brand left in shipped files', () => {
  // `shared/product.js` et le module de migration sont les deux endroits ou le nom
  // precedent a le droit de subsister: sans lui, rien ne sait quoi renommer.
  const scanned = {
    'installer/custom.nsh': nsh,
    'package.json': read('package.json'),
    'main.js': read('main.js'),
    'preload.js': read('preload.js'),
    'renderer/index.html': read('renderer/index.html'),
    'shared/path-rules.js': rulesSource,
    'shared/install-metadata.js': metadataSource,
  };
  const offenders = [];
  for (const [file, source] of Object.entries(scanned)) {
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      if (!/\bNexus\b|\bnexus\b/.test(line)) return;
      offenders.push(`${file}:${index + 1}`);
    });
  }
  if (offenders.length) return `nom herite encore present en ${offenders.join(', ')}`;
  return null;
});

// ---------------------------------------------------------------- result -----

if (failures.length) {
  console.error(`installer-script guard: ${failures.length} divergence(s) sur ${checks.length} controles\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`installer-script guard: ${checks.length}/${checks.length} controles OK`);

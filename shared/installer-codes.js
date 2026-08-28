'use strict';

/**
 * Codes d'erreur de l'installeur, au seul endroit ou ils sont ecrits.
 *
 * `installer/custom.nsh` sort un numero dans `$SOO_PROBLEM` (c'est ce que
 * l'installeur silencieux rend via `SetErrorLevel`, et ce que lit un script de
 * deploiement). Ce fichier-la ne peut pas importer de JavaScript ; l'autre moitie
 * du contrat est donc testee dans `test/installer-script.mjs`, qui verifie que les
 * deux listes disent la meme chose. Un code change dans le .nsi sans changer ici
 * ferait afficher a l'app le mauvais message pour le bon numero — le genre de
 * divergence qui ne se voit que chez l'utilisateur.
 */

/** Tout va bien : seul code qui ne declenche ni message ni retour en arriere. */
const OK = 0;
/** Dossier demande absent et creation refusee. */
const EMPTY = 1;
/** Chemin relatif ou sans lettre de lecteur. */
const NOT_ABSOLUTE = 3;
/** Ecriture impossible (droits, disque plein, ACL). */
const NO_PERMISSION = 5;
/** Lecteur absent: carte retiree, disque externe debranche, lecteur reseau deconnecte. */
const DRIVE_UNAVAILABLE = 21;
/** Nom refuse par Windows (caractere interdit, nom reserve). */
const INVALID_NAME = 123;
/** Chemin trop long pour MAX_PATH sans le manifeste longPathAware. */
const TOO_LONG = 206;
/** Verification d'apres-installation: un fichier attendu manque. */
const VERIFY_FAILED = 1604;
/** Desinstallation refusee: le dossier vise n'est pas un dossier Soocial. */
const UNSAFE_UNINSTALL = 1605;
/** L'utilisateur a annule (ou quitte la page de confirmation). */
const USER_ABORT = 1602;

const CODES = {
  OK,
  EMPTY,
  NOT_ABSOLUTE,
  NO_PERMISSION,
  DRIVE_UNAVAILABLE,
  INVALID_NAME,
  TOO_LONG,
  VERIFY_FAILED,
  UNSAFE_UNINSTALL,
  USER_ABORT,
};

/** Nom des constantes telles qu'elles sont ecrites dans le script NSIS. */
const NSIS_NAMES = {
  OK: 'SOO_CODE_OK',
  EMPTY: 'SOO_CODE_EMPTY',
  NOT_ABSOLUTE: 'SOO_CODE_NOT_ABSOLUTE',
  NO_PERMISSION: 'SOO_CODE_NO_PERMISSION',
  DRIVE_UNAVAILABLE: 'SOO_CODE_DRIVE_UNAVAILABLE',
  INVALID_NAME: 'SOO_CODE_INVALID_NAME',
  TOO_LONG: 'SOO_CODE_TOO_LONG',
  VERIFY_FAILED: 'SOO_CODE_VERIFY_FAILED',
  UNSAFE_UNINSTALL: 'SOO_CODE_UNSAFE_UNINSTALL',
  USER_ABORT: 'SOO_CODE_USER_ABORT',
};

/** Nom de ce que l'installeur cree ou lit a cote de l'executable. */
const FILES = {
  DIRECTORY_NAME: 'SOO_DIR_NAME',
  REGISTRY_KEY: 'SOO_REGISTRY_KEY',
  METADATA_JSON: 'SOO_METADATA_JSON',
  METADATA_INI: 'SOO_METADATA_INI',
  PARTIAL_MARKER: 'SOO_PARTIAL_MARKER',
  WRITE_PROBE: 'SOO_WRITE_PROBE',
  PATH_MAX: 'SOO_PATH_MAX',
  DIR_NAME_LEN: 'SOO_DIR_NAME_LEN',
};

/** Ce que chaque code veut dire cote app, pour la page Reglages et les logs. */
const MEANINGS = {
  [OK]: 'ok',
  [EMPTY]: 'no folder chosen',
  [NOT_ABSOLUTE]: 'relative path',
  [NO_PERMISSION]: 'no write permission',
  [DRIVE_UNAVAILABLE]: 'drive not present',
  [INVALID_NAME]: 'name refused by Windows',
  [TOO_LONG]: 'path too long',
  [VERIFY_FAILED]: 'files missing after install',
  [UNSAFE_UNINSTALL]: 'target is not a Soocial folder',
  [USER_ABORT]: 'cancelled by user',
};

function nameFor(code) {
  const entry = Object.entries(CODES).find(([, value]) => value === code);
  if (!entry) return `unknown code ${code}`;
  return `${entry[0]} (${MEANINGS[code] || ''})`;
}

module.exports = { ...CODES, CODES, NSIS_NAMES, FILES, MEANINGS, nameFor };

'use strict';

/**
 * Repartition des donnees sur le disque.
 *
 * Quatre emplacements, quatre raisons d'etre — les melanger est l'erreur
 * classique d'une application "installee ailleurs" :
 *
 *   Application  <dossier choisi>\Soocial   binaire, en lecture seule une fois installe
 *   Donnees      %APPDATA%\Soocial          config.json, sessions des services — suit le profil
 *   Cache        %LOCALAPPDATA%\Soocial     cache Chromium, journaux — jetable
 *   Telechargements  choisis par l'utilisateur     fichiers recus
 *
 * Le point qui coute le plus cher a comprendre : le dossier d'installation ne
 * doit jamais recevoir de donnees utilisateur. Sinon une installation sur un
 * disque externe devient une installation dont les sessions suivent le disque (et
 * se font lire sur n'importe quel autre PC), et une mise a jour qui reformate le
 * dossier d'application emporte les comptes connectes.
 *
 * Le cache vit a part pour une raison moins noble mais reelle : %LOCALAPPDATA%
 * n'est pas synchronise entre les postes par les strategies de groupe (Roaming, lui, l'est), donc y mettre 800 Mo de
 * cache Chromium evite de les promener d'un poste a l'autre.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rules = require('../shared/path-rules');
const { PRODUCT } = require('../shared/product');

const DEFAULT_DOWNLOADS_SUBFOLDER = PRODUCT.name;
const WRITE_TEST_FILE = '.soocial-write-test';

/**
 * Racines resolues a partir de l'environnement, sans Electron : ce module doit
 * pouvoir etre teste (et utilise par le script de verification) en dehors de
 * l'app. `app.getPath` n'est qu'un raccourci vers ces trois variables.
 */
function resolveRoots(env = process.env, platform = process.platform) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

  // Aucun embranchement par plateforme, et c'est voulu : `platform !== 'win32'`
  // donne exactement les memes chemins, parce que APPDATA/LOCALAPPDATA sont absents
  // et que HOME prend le relais. Un developpeur sous Linux ou macOS obtient donc
  // ~/.config-like par convention Electron, et le code commun (comme les tests)
  // tourne sans version specialisee a entretenir en parallele.
  void platform;

  return {
    data: path.join(roaming, PRODUCT.dataDirName),
    cache: path.join(local, PRODUCT.dataDirName),
    downloadsDefault: path.join(home, 'Downloads', DEFAULT_DOWNLOADS_SUBFOLDER),
  };
}

/** Le dossier de destination existe-t-il, est-ce un dossier, ecrit-on dedans ? */
function probeDirectory(dir, { create = false } = {}) {
  const resolved = rules.normalize(dir);
  const shape = rules.validatePath(resolved);
  if (!shape.ok) {
    const blocking = shape.issues.find((issue) => issue.code !== 'LONG_PATH');
    return { ok: false, code: blocking ? blocking.code : 'LONG_PATH', path: resolved, issues: shape.issues };
  }

  const facts = { exists: false, isDirectory: false, writable: false, created: false };

  try {
    const stat = fs.statSync(resolved);
    facts.exists = true;
    facts.isDirectory = stat.isDirectory();
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // "Le chemin n'existe pas" n'est pas une erreur ici : la consigne est de
      // creer le dossier manque, pas d'envoyer l'utilisateur le creer a la main.
    } else if (err && (err.code === 'ENOTDIR' || err.code === 'EINVAL')) {
      return { ok: false, code: 'NOT_A_DIRECTORY', path: resolved };
    } else {
      return { ok: false, code: driveErrorCode(err), path: resolved, cause: err.code };
    }
  }

  if (!facts.exists) {
    if (!create) {
      return { ok: false, code: 'MISSING_DIRECTORY', path: resolved, parent: rules.parentOf(resolved) };
    }
    try {
      fs.mkdirSync(resolved, { recursive: true });
      facts.created = true;
      facts.exists = true;
      facts.isDirectory = true;
    } catch (err) {
      return { ok: false, code: driveErrorCode(err), path: resolved, cause: err.code };
    }
  }

  if (facts.exists && !facts.isDirectory) return { ok: false, code: 'NOT_A_DIRECTORY', path: resolved };

  const writable = testWrite(resolved);
  if (!writable.ok) return { ok: false, code: writable.code, path: resolved };

  return { ok: true, path: resolved, created: facts.created };
}

/**
 * Le seul test qui vaille : creer et detruire un fichier. `W_OK` reussit sur un
 * dossier en lecture seule quand l'ACL dit "lecture pour tous" et que le fichier
 * vise n'existe pas encore, et Windows autorise l'acces au point de montage d'un
 * lecteur ejecte jusqu'a ce qu'on ecrive vraiment.
 */
function testWrite(dir) {
  const probe = path.join(dir, WRITE_TEST_FILE);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (err) {
    try {
      if (fs.existsSync(probe)) fs.unlinkSync(probe);
    } catch {}
    return { ok: false, code: driveErrorCode(err) };
  }
}

function driveErrorCode(err) {
  const code = err && err.code;
  if (code === 'EPERM' || code === 'EACCES' || code === 'EROFS') return 'NO_PERMISSION';
  if (code === 'ENOSPC') return 'NO_SPACE';
  if (code === 'ENOENT' || code === 'ENXIO' || code === 'ENOTREADY' || code === 'EINVAL') return 'DRIVE_UNAVAILABLE';
  if (code === 'ENAMETOOLONG') return 'TOO_LONG';
  return 'UNREADABLE';
}

/** Lecteur branche ? (D:\ retire, cle USB ejetee, disque reseau deconnecte.) */
function driveAvailable(dir) {
  const drive = rules.driveOf(dir);
  if (!drive) return true; // UNC ou simulateur : on n'a pas de test fiable, on laisse ecrire et on interprete l'erreur.
  try {
    fs.accessSync(`${drive}\\`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Etat complet du stockage, tel que l'affiche Reglages > Stockage. Chaque champ
 * est calcule a la demande : un lecteur amovible peut partir entre deux
 * affichages de la fenetre, et une valeur figee au demarrage afficherait
 * "pret" pour un disque qui n'est plus la.
 */
function describe({ store, roots }) {
  const stored = store.get('downloads');
  const isDefault = !stored || !String(stored).trim();
  const active = isDefault ? roots.downloadsDefault : rules.normalize(stored);
  const drive = rules.driveOf(active);

  return {
    data: roots.data,
    cache: roots.cache,
    downloads: active,
    downloadsIsDefault: isDefault,
    downloadsDrive: drive || null,
    ...finalizeProbe(probeDirectory(active)),
    warnings: rules.validatePath(active).issues.map((issue) => issue.code),
  };
}

function finalizeProbe(probe) {
  if (!probe.ok) {
    return {
      downloadsOk: false,
      downloadsExists: probe.code !== 'MISSING_DIRECTORY' && probe.code !== 'DRIVE_UNAVAILABLE',
      downloadsWritable: false,
      downloadsErrorCode: probe.code,
      downloadsErrorKey: rules.errorKeyFor(probe.code),
    };
  }
  return { downloadsOk: true, downloadsExists: true, downloadsWritable: true, downloadsErrorCode: null, downloadsErrorKey: null };
}

/**
 * Enregistrement d'un nouveau dossier de telechargement. La regle : on ne
 * memorise le chemin que si l'ecriture a reussi, dans l'ordre — sinon un
 * echec laisse l'app pointer vers un dossier inexistant et chaque telechargement
 * suivant le rappelle.
 */
function setDownloadsDir({ store, roots, candidate, create = true }) {
  const normalized = rules.normalize(candidate);
  if (!normalized) return { ok: false, code: 'EMPTY', errorKey: rules.errorKeyFor('EMPTY') };

  if (!rules.isAbsolute(normalized)) return { ok: false, code: 'NOT_ABSOLUTE', errorKey: rules.errorKeyFor('NOT_ABSOLUTE') };

  if (normalized.includes('\\*') || normalized.includes('?') || normalized.includes('"')) {
    return { ok: false, code: 'INVALID_CHARS', errorKey: rules.errorKeyFor('INVALID_CHARS') };
  }

  if (!driveAvailable(normalized)) {
    return { ok: false, code: 'DRIVE_UNAVAILABLE', errorKey: rules.errorKeyFor('DRIVE_UNAVAILABLE'), path: normalized };
  }

  const probe = probeDirectory(normalized, { create });
  if (!probe.ok) {
    // Un dossier manquant n'est pas un refus : on le cree (consigne du cahier
    // des charges), et on ne refuse qu'au deuxieme echec — donc sur la
    // permission ou le disque.
    if (probe.code === 'MISSING_DIRECTORY') {
      const created = probeDirectory(normalized, { create: true });
      if (!created.ok) return { ok: false, ...created, errorKey: rules.errorKeyFor(created.code) };
    } else {
      return { ok: false, code: probe.code, path: normalized, errorKey: rules.errorKeyFor(probe.code) };
    }
  }

  const resolved = probe.ok ? probe.path : normalized;
  store.set('downloads', resolved === roots.downloadsDefault ? null : resolved);
  return { ok: true, path: resolved, created: Boolean(probe.created), isDefault: resolved === roots.downloadsDefault };
}

function resetDownloadsDir({ store }) {
  store.set('downloads', null);
  return { ok: true };
}

/**
 * Chemin final d'un telechargement : nom nettoye, extension preservee, numerotation
 * si le fichier existe deja. Ne jamais ecraser sans demander est une consigne, et
 * le numerotation est le seul comportement qui ne detruit rien quand personne ne
 * regarde (telechargement en arriere-plan, fenetre fermee).
 */
function resolveDownloadPath(dir, suggestedName, { existing } = {}) {
  const sanitized = rules.sanitizeFileName(suggestedName, 'download');
  const ext = path.extname(sanitized);
  const base = ext ? sanitized.slice(0, -ext.length) : sanitized;

  const names = existing || (() => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  })();

  const unique = rules.uniqueFileName(base, ext, names);
  return { dir, name: unique, fullPath: path.join(dir, unique), renamed: unique !== sanitized };
}

/** Commutateurs Chromium a poser avant app.whenReady : apres, ils sont ignores. */
function chromiumSwitches({ app, roots }) {
  return {
    apply() {
      app.setPath('userData', roots.data);
      app.setPath('sessionData', roots.data);
      // 'disk-cache-dir' deplace le cache de Chromium sans toucher au reste du
      // profil : les sessions des services restent dans userData.
      app.commandLine.appendSwitch('disk-cache-dir', path.join(roots.cache, 'Network Cache'));
      return true;
    },
  };
}

module.exports = {
  DEFAULT_DOWNLOADS_SUBFOLDER,
  WRITE_TEST_FILE,
  resolveRoots,
  probeDirectory,
  testWrite,
  driveAvailable,
  driveErrorCode,
  describe,
  setDownloadsDir,
  resetDownloadsDir,
  resolveDownloadPath,
  chromiumSwitches,
};

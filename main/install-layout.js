'use strict';

/**
 * Ou l'application est installee, et si elle y est vraiment.
 *
 * Trois sources se contredisent un jour ou l'autre :
 *   1. le chemin de l'executable qui nous fait tourner (jamais faux) ;
 *   2. install.json a cote de cet exe (ecrit par l'installateur) ;
 *   3. le registre Windows (InstallPath, lu par la mise a jour et "Ajouter ou
 *      retirer").
 *
 * Ce module les confronte et rend un verdict. Il ne repare rien en silence : un
 * ecart est une information pour l'utilisateur (et pour un rapport de bug), pas
 * un detail a masquer. Une installation dont on tait qu'elle est ailleurs que
 * ce que croit l'updater est exactement la situation ou l'on reinstalle sur C:.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const metadata = require('../shared/install-metadata');
const rules = require('../shared/path-rules');
const { PRODUCT } = require('../shared/product');

const execFileAsync = promisify(execFile);

/** `reg query` repond en 30 ms d'ordinaire ; au-dela de 2 s le faire attendre n'a plus d'interet. */
const REG_TIMEOUT_MS = 2000;

const REG_KEYS = [
  { hive: 'HKCU', label: 'perUser' },
  { hive: 'HKLM', label: 'perMachine' },
];

/**
 * Chemin du dossier d'installation, et chemin du fichier d'enregistrement qui
 * l'accompagne. Derives de l'exe : jamais d'un reglage utilisateur, jamais du
 * lecteur courant. Un reglage qui dit "D:\Apps" alors que l'exe est sur C: est
 * justement le bug a detecter, pas la reponse a utiliser.
 */
function currentInstall({ app }) {
  const exePath = app.getPath('exe');
  const installDir = path.dirname(exePath);
  return {
    exePath,
    installDir,
    metadataPath: path.join(installDir, PRODUCT.metadataFile),
    /** Program Files reste en lecture seule : l'app n'y ecrit jamais. */
    writable: isWritable(installDir),
  };
}

function isWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Lecture tolerante : absent ou illisible n'est pas une exception, c'est un etat. */
function readInstallMetadata(install, log = () => {}) {
  let raw = null;
  try {
    raw = fs.readFileSync(install.metadataPath, 'utf8');
  } catch (err) {
    const code = err && err.code;
    if (code !== 'ENOENT') log('install', `install.json illisible : ${code || err.message}`);
    return { record: null, issues: [code === 'ENOENT' ? 'missing' : 'unreadable'] };
  }

  const parsed = metadata.parse(raw);
  if (parsed.issues.length) log('install', `install.json : ${parsed.issues.join(', ')}`);
  return parsed;
}

/**
 * Ce que le registre dit de l'installation. Un seul des deux hives repond en
 * general ; les deux peuvent repondre (installation par utilisateur puis par
 * machine) et ce cas doit rester visible.
 */
async function readRegistryInstall({ platform = process.platform } = {}) {
  if (platform !== 'win32') return { available: false, entries: [], error: 'not-windows' };

  const entries = [];
  let failed = false;

  for (const { hive, label } of REG_KEYS) {
    for (const key of [`${PRODUCT.registryKey}`, `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT.appId}`]) {
      try {
        const { stdout } = await execFileAsync('reg.exe', ['query', `${hive}\\${key}`, '/v', 'InstallPath'], {
          windowsHide: true,
          timeout: REG_TIMEOUT_MS,
        });
        const match = /InstallPath\s+REG_SZ\s+(.+)/.exec(stdout);
        if (match) entries.push({ hive: label, key, installPath: match[1].trim() });
      } catch (err) {
        // `reg query` sort en code 1 quand la cle n'existe pas : c'est le cas
        // normal, pas une erreur. On ne remonte que les vrais echecs.
        if (err && err.code === 'ENOENT') failed = true;
      }
    }
  }

  return { available: !failed, entries };
}

/**
 * Verdict complet, pret a afficher dans Reglages > Diagnostics et a copier dans
 * un rapport de bug.
 */
function describeInstall({ install, record, registry, shortcuts }) {
  const consistency = metadata.consistency(record, install.exePath, path);
  const registryPaths = (registry && registry.entries ? registry.entries : []).map((entry) => entry.installPath);
  const registryAgrees = registryPaths.length
    ? registryPaths.some((p) => rules.samePath(p, install.installDir))
    : null;

  return {
    installDir: install.installDir,
    metadataPath: install.metadataPath,
    hasMetadata: Boolean(record),
    channel: record ? metadata.normalizeChannel(record.channel) : null,
    version: record ? record.version : null,
    firstInstall: record ? record.firstInstall : null,
    installationId: record ? record.installationId : null,
    consistency: consistency.status,
    architecture: record ? record.architecture : null,
    expectedInstallPath: consistency.expected,
    writable: install.writable,
    registry: { available: Boolean(registry && registry.available), paths: registryPaths, agrees: registryAgrees },
    shortcuts: shortcuts || [],
  };
}

/**
 * Les raccourcis existent-ils vraiment ? C'est la moitie des "installation
 * cassee" signalees : les fichiers sont la, le raccourci pointe une copie
 * supprimee, et l'utilisateur ne sait pas laquelle des deux il a lancee.
 */
function checkShortcuts(record, installDir) {
  const links = [];
  const shortcuts = (record && record.shortcuts) || {};

  for (const key of ['desktopLink', 'startMenuLink']) {
    const link = shortcuts[key];
    if (!link) continue;

    let exists = false;
    let target = null;
    try {
      exists = fs.existsSync(link);
      if (exists) target = readShortcutTarget(link);
    } catch {}

    links.push({
      kind: key === 'desktopLink' ? 'desktop' : 'startMenu',
      path: link,
      exists,
      target,
      // Un raccourci qui mene ailleurs que le dossier enregistre est le vrai
      // danger : Windows lance alors une copie que l'utilisateur croit supprimee.
      pointsHere: target ? rules.isPathInside(installDir, target) : null,
    });
  }

  return links;
}

/**
 * Cible d'un .lnk, lue dans le binaire. Le format LNK est bourre de champs
 * conditionnels (chaque champ optionnel est annonce par un bit du flags), donc
 * on se limite a extraire la chaine locale : c'est suffisant pour repondre a
 * "ce raccourci mene-t-il a notre dossier".
 */
function readShortcutTarget(linkPath) {
  const buffer = fs.readFileSync(linkPath);
  if (buffer.length < 0x4c) return null;

  const flags = buffer.readUInt32LE(20);
  let offset = 0x4c;

  if (flags & 0x04) {
    const localBaseLen = buffer.readUInt16LE(offset);
    offset += 4 + localBaseLen * 2;
  }
  if (flags & 0x80 && offset + 2 <= buffer.length) {
    const len = buffer.readUInt16LE(offset);
    offset += 2 + len * 2;
  }

  const target = buffer.slice(offset, buffer.length).toString('utf16le').replace(/\0.*$/, '');
  return target || null;
}

/**
 * Controle de fin d'installation, et diagnostic de demarrage : les trois
 * fichiers sans lesquels l'app ne peut pas vivre, plus la coherence du chemin.
 */
function verifyInstallFiles(install, record) {
  const problems = [];

  for (const [label, target] of [
    ['executable', install.exePath],
    ['application bundle', path.join(install.installDir, 'resources', 'app.asar')],
    [PRODUCT.metadataFile, install.metadataPath],
  ]) {
    if (!fs.existsSync(target)) problems.push({ code: 'MISSING_FILE', what: label, path: target });
  }

  if (record && record.installPath && !rules.samePath(record.installPath, install.installDir)) {
    problems.push({ code: 'PATH_MISMATCH', expected: record.installPath, actual: install.installDir });
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Un install.json ment-il sur l'endroit ou il se trouve ? Le cas arrive quand un
 * dossier est deplace a la main : le fichier suit l'exe, donc son installPath
 * devient faux, et l'updater irait taper a l'ancien endroit. On corrige a
 * l'ecran (diagnostic), pas sur le disque : l'app n'a generalement pas les
 * droits, et une app qui reecrit son propre dossier d'installation est un
 * risque superieur au benefice.
 */
function needsRepair(description) {
  return description.consistency !== 'match' || !description.hasMetadata;
}

module.exports = {
  currentInstall,
  readInstallMetadata,
  readRegistryInstall,
  describeInstall,
  checkShortcuts,
  readShortcutTarget,
  verifyInstallFiles,
  needsRepair,
  REG_TIMEOUT_MS,
};

'use strict';

/**
 * install.json — la memoire de l'installation.
 *
 * Pourquoi ce fichier existe : une installation personnalisee ne peut pas se
 * deviner. Le registre, les raccourcis et le repertoire de l'exe peuvent se
 * contredire (raccourcis copies a la main, dossier renomme, installation
 * reparable). Des que l'app doit repondre a "oi je tourne, et est-ce que
 * c'est bien la ou l'utilisateur a dit", elle a besoin d'un enregistrement
 * ecrit au moment ou la decision etait prise, par celui qui la prenait.
 *
 * Il est ecrit par l'installateur (qui a les droits), lu par l'app et par
 * l'updater (qui ne les a pas). L'app n'y ecrit jamais : un fichier a cote de
 * l'exe est en lecture seule dans Program Files, et y stocker des reglages
 * ferait echouer l'installation par defaut — precisement le cas qu'on doit
 * ne jamais casser.
 *
 * Le format est volontairement plat et tolerant : une version future de l'app
 * doit pouvoir lire un install.json ecrit par une version passee, et un
 * installateur partiel (installateur tue en plein vol) doit rester lisible.
 */

const SCHEMA_VERSION = 1;

const CHANNELS = ['stable', 'beta', 'dev'];

/** Champs obligatoires pour considerer l'enregistrement exploitable. */
const REQUIRED = ['product', 'installPath', 'version', 'channel'];

/**
 * Serialise un enregistrement avec un ordre de cles stable. L'installateur NSIS
 * ecrit le meme ordre, a la main : la comparaison des deux (test/installer-metadata)
 * sert justement a detecter une divergence de format.
 */
function serialize(record) {
  // Les champs se lisent aux DEUX formes : plate (les faits releves par l'app ou
  // par l'installeur, au moment d'ecrire) et imbriquee (ce que `parse` rend apres
  // lecture du fichier). Sans cette tolerance, toute reecriture -- "reparer
  // install.json" depuis les reglages, par exemple -- perdrait silencieusement
  // installer.* et shortcuts.*, puisqu'elle partirait d'un objet qu'elle ne
  // reconnait pas. Un ecart de ce genre ne se voit qu'une fois le fichier ecrase.
  const nested = (group, name) => (record[group] && record[group][name] != null ? record[group][name] : null);
  const any = (...values) => {
    for (const value of values) if (value != null) return value;
    return null;
  };

  const out = {
    schemaVersion: SCHEMA_VERSION,
    product: 'Soocial',
    installPath: record.installPath,
    version: record.version,
    channel: normalizeChannel(record.channel),
    architecture: record.architecture || 'x64',
    installationId: record.installationId || null,
    firstInstall: record.firstInstall || null,
    updatedAt: record.updatedAt || null,
    installer: {
      engine: any(record.engine, nested('installer', 'engine')) || 'nsis',
      appId: any(record.appId, nested('installer', 'appId')),
      productFilename: any(record.productFilename, nested('installer', 'productFilename')) || 'Soocial',
      scope: any(record.scope, nested('installer', 'scope')) || 'perMachine',
      shortcutName: any(record.shortcutName, nested('installer', 'shortcutName')) || 'Soocial',
    },
    shortcuts: {
      desktop: Boolean(any(record.desktopShortcut, nested('shortcuts', 'desktop'))),
      startMenu: Boolean(any(record.startMenuShortcut, nested('shortcuts', 'startMenu'))),
      desktopLink: any(record.desktopLink, nested('shortcuts', 'desktopLink')),
      startMenuLink: any(record.startMenuLink, nested('shortcuts', 'startMenuLink')),
    },
    verified: record.verified !== false,
  };

  if (record.dataRoot) out.dataRoot = record.dataRoot;
  if (record.notes) out.notes = record.notes;

  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Lit un install.json meme abime. Une chaine invalide ne doit jamais faire
 * echouer le demarrage de l'app : au pire on perd la precision sur le chemin,
 * au mieux l'app continue et le diagnostic explique l'ecart.
 */
function parse(raw) {
  if (raw == null || raw === '') return { record: null, issues: ['missing'] };
  if (typeof raw !== 'object') {
    try {
      raw = JSON.parse(raw);
    } catch {
      // Dernier recours : un installateur interrompu en pleine ecriture laisse un
      // objet tronque, donc du JSON invalide. Recuperer les quelques champs qui
      // sont passes vaut mieux que tout jeter : c'est installPath qui decide si
      // la mise a jour repart sur le bon disque.
      const rescued = {};
      for (const field of REQUIRED.concat(['architecture', 'channel'])) {
        const match = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`).exec(raw);
        if (match) rescued[field] = match[1];
      }
      if (!rescued.installPath) return { record: null, issues: ['unreadable'] };
      return { record: rescued, issues: ['truncated'] };
    }
  }

  if (typeof raw !== 'object' || raw === null) return { record: null, issues: ['unreadable'] };

  const issues = [];
  for (const field of REQUIRED) {
    if (typeof raw[field] !== 'string' || !raw[field]) issues.push(`missing:${field}`);
  }
  if (raw.schemaVersion != null && raw.schemaVersion !== SCHEMA_VERSION) {
    issues.push(`schema:${raw.schemaVersion}`);
  }
  if (typeof raw.installPath === 'string' && raw.installPath.includes('\\*')) issues.push('bad-path');

  return { record: raw, issues };
}

function normalizeChannel(channel) {
  const value = String(channel || 'stable').toLowerCase();
  return CHANNELS.includes(value) ? value : 'stable';
}

/**
 * L'enregistrement decrit-il reellement l'installation en cours ?
 *
 * Le test est fait sur le chemin de l'executable courant : c'est la seule
 * verite qui ne peut pas mentir (c'est le fichier qui nous execute). Un ecart
 * signifie l'une de ces trois choses, et les trois doivent etre visibles :
 * une installation dupliquee, un dossier renomme apres coup, ou un raccourci
 * qui pointe vers une copie.
 */
function consistency(record, currentExePath, path) {
  if (!record || !record.installPath) return { status: 'unknown', expected: null, actual: dirname(currentExePath, path) };

  const expected = path.normalize(record.installPath).replace(/[\\]+$/, '').toLowerCase();
  const actual = dirname(currentExePath, path).replace(/[\\]+$/, '').toLowerCase();

  if (expected === actual) return { status: 'match', expected: record.installPath, actual };
  if (path.normalize(actual).toLowerCase().startsWith(`${expected}\\`)) {
    return { status: 'nested', expected: record.installPath, actual };
  }
  return { status: 'mismatch', expected: record.installPath, actual };
}

function dirname(p, path) {
  return p ? path.dirname(p) : '';
}

/**
 * Mise a jour de l'enregistrement apres un update : firstInstall et
 * installationId survivent (ils servent a savoir depuis quand cette machine est
 * installee, et un changement d'identifiant casserait les compteurs), tout le
 * reste est reecrit.
 */
function mergeForUpdate(previous, next) {
  const base = previous && typeof previous === 'object' ? previous : {};
  return {
    ...base,
    ...next,
    installationId: base.installationId || next.installationId,
    firstInstall: base.firstInstall || next.firstInstall,
  };
}

module.exports = {
  SCHEMA_VERSION,
  CHANNELS,
  serialize,
  parse,
  normalizeChannel,
  consistency,
  mergeForUpdate,
};

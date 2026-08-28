'use strict';

/**
 * Migration depuis l'ancien nom (Nexus) vers Soocial.
 *
 * Le fork change le nom du produit, donc le nom du repertoire de donnees :
 * %APPDATA%\Nexus devient %APPDATA%\Soocial. Sans migration, un utilisateur qui
 * installe Soocial par-dessus son installation precedente se retrouve avec six
 * comptes deconnectes et un ordre de sidebar perdu, et rien ne le lui avait
 * annonce. C'est la perte de donnees que le cahier des charges interdit.
 *
 * Deux choix deliberes :
 *
 * 1. RENAME, pas copy. Un dossier de sessions fait volontiers plusieurs
 *    centaines de Mo ; les dupliquer ferait attendre, et laisserait deux copies
 *    de cookies de compte sur le disque — la seconde n'etant jamais supprimee.
 *    Le rename n'a de sens que si la destination n'existe pas : on ne touche
 *    donc jamais a une installation Soocial deja demarree.
 * 2. En cas d'echec du rename (disque different, fichier verrouille par une app
 *    encore ouverte), on COPIE et on laisse la source en place. Une copie
 *    redondante se repare ; une session perdue non.
 *
 * L'operation est declaree dans un marqueur a cote des donnees : un deuxieme
 * lancement ne rejoue rien, et un rapport de bug peut dire quand elle a eu lieu.
 */

const fs = require('node:fs');
const path = require('node:path');

const { PRODUCT } = require('../shared/product');

const MARKER = 'migrated-from-nexus.json';

/** Ce qui doit survivre : la config, les sessions, les icones choisies. */
const MUST_survive = ['config.json', 'Partitions', 'Local State'];

function describe({ appData, productName = PRODUCT.legacy.dataDirName, dataDirName = PRODUCT.dataDirName } = {}) {
  const source = path.join(appData, productName);
  const target = path.join(appData, dataDirName);
  return { source, target, marker: path.join(target, MARKER) };
}

function alreadyMigrated(paths) {
  try {
    return fs.existsSync(paths.marker);
  } catch {
    return false;
  }
}

function legacyPresent(paths) {
  try {
    return fs.existsSync(paths.source) && fs.readdirSync(paths.source).length > 0;
  } catch {
    return false;
  }
}

function migrationNeeded(input) {
  const paths = describe(input);
  if (!legacyPresent(paths)) return false;
  if (alreadyMigrated(paths)) return false;
  return true;
}

/**
 * Declenchee une seule fois, avant que le store ne soit ouvert (sinon le store
 * cree le repertoire cible vide, et la porte se referme).
 *
 * @returns {{status: string, detail?: string, moved?: string[], copied?: string[]}}
 */
function migrate(input, { log = () => {} } = {}) {
  const paths = describe(input);

  if (!legacyPresent(paths)) return { status: 'none' };
  if (alreadyMigrated(paths)) return { status: 'already' };

  const targetExists = safeExists(paths.target);
  if (targetExists && hasRealContent(paths.target)) {
    // Deux histoires possibles, et on ne peut pas les distinguer surement : soit
    // Soocial a deja demarre, soit le nom du repertoire a ete pris par une autre
    // version. Dans les deux cas, ecraser serait la perte de donnees.
    log('migrate', 'destination deja peuplee : migration ignoree');
    return { status: 'skipped', detail: 'target-not-empty' };
  }

  if (!targetExists) {
    try {
      fs.renameSync(paths.source, paths.target);
      writeMarker(paths, { status: 'moved' });
      log('migrate', `${paths.source} -> ${paths.target} (renommage)`);
      return { status: 'moved' };
    } catch (err) {
      log('migrate', `renommage impossible (${err.code || err.message}), copie en cours`);
    }
  }

  const copied = [];
  try {
    for (const entry of fs.readdirSync(paths.source)) {
      copyRecursive(path.join(paths.source, entry), path.join(paths.target, entry));
      copied.push(entry);
    }
  } catch (err) {
    log('migrate', `copie interrompue : ${err.code || err.message}`);
    return { status: 'partial', detail: err.code || err.message, copied };
  }

  writeMarker(paths, { status: 'copied', copied, source: paths.source });
  log('migrate', `${copied.length} entrees copiees depuis ${paths.source}`);
  return { status: 'copied', copied };
}

/**
 * Un repertoire "vide" au sens du systeme de fichiers n'exclut pas la migration :
 * une installation interrompue laisse parfois un %APPDATA%\Soocial avec deux
 * journaux. On ne cede la place que devant une vraie config ou de vraies sessions.
 */
function hasRealContent(dir) {
  try {
    const entries = fs.readdirSync(dir);
    if (entries.includes(MARKER)) return true;
    return MUST_survive.some((name) => entries.includes(name)) && !isEmptyConfig(path.join(dir, 'config.json'));
  } catch {
    return false;
  }
}

function isEmptyConfig(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return !parsed || (Object.keys(parsed).length === 0) || (Array.isArray(parsed.services) && parsed.services.length === 0 && !parsed.onboarded);
  } catch {
    return false;
  }
}

function copyRecursive(from, to) {
  const stat = fs.lstatSync(from);

  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) copyRecursive(path.join(from, entry), path.join(to, entry));
    return;
  }

  fs.mkdirSync(path.dirname(to), { recursive: true });
  // copyFileSync preserve les dates et les permissions : les sessions Chromium
  // n'y sont pas sensibles, mais un journal dont l'horodatage change fait croire
  // a une corruption lors d'un diagnostic.
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
}

function writeMarker(paths, info) {
  try {
    fs.writeFileSync(
      paths.marker,
      `${JSON.stringify(
        {
          product: PRODUCT.name,
          from: PRODUCT.legacy.dataDirName,
          at: new Date().toISOString(),
          ...info,
        },
        null,
        2
      )}\n`
    );
  } catch {}
}

function safeExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

module.exports = { describe, migrationNeeded, migrate, hasRealContent, MARKER, MUST_survive };

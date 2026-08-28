'use strict';

/**
 * Telechargements : ou va le fichier, et que se passe-t-il quand ca ne peut pas.
 *
 * `will-download` est le seul endroit ou l'app a son mot a dire : Chromium a deja
 * decide du nom, pas encore du disque. Trois cas meritent un traitement distinct,
 * parce que les trois arrivent avec un disque externe :
 *
 *   - le dossier est la, ecrire passe       -> on ecrit ;
 *   - le dossier a disparu (lecteur ejecte) -> on bascule sur le dossier par
 *     defaut pour CE fichier et on le dit, au lieu de perdre le telechargement ;
 *   - le dossier existe mais refuse l'ecriture -> on le dit, et on laisse choisir,
 *     sans jamais ecrire "termine" pour un fichier qui n'est pas arrive.
 *
 * Deux regles absolues : ne jamais ecraser un fichier existant sans que
 * l'utilisateur l'ait demande, et ne jamais supprimer un fichier present dans le
 * dossier choisi — changer de dossier ne deplace rien, c'est un reglage d'avenir,
 * pas un demenagement.
 */

const fs = require('node:fs');
const path = require('node:path');

const rules = require('../shared/path-rules');
const storage = require('./storage-layout');

/**
 * Decision pure — ni Electron ni dialogue, donc testable seance tenante.
 *
 * @param {object} input
 * @param {string} input.dir         dossier enregistre dans les reglages
 * @param {string} input.defaultDir  dossier par defaut, cree si besoin
 * @param {string} input.suggested   nom propose par le site
 * @param {string[]} [input.existing] noms deja presents dans `dir`
 * @param {boolean} [input.overwriteOk] l'utilisateur a deja demande l'ecrasement
 * @param {boolean} [input.askWhere]  choisir a chaque telechargement
 * @param {object} [input.probe]      etat de `dir` (resultat de probeDirectory)
 * @param {object} [input.defaultProbe] etat de `defaultDir`
 */
function planDownload(input) {
  const dir = rules.normalize(input.dir);
  const suggested = rules.sanitizeFileName(input.suggested, 'download');
  const ext = path.extname(suggested);
  const base = ext ? suggested.slice(0, -ext.length) : suggested;

  if (input.askWhere) return { mode: 'ask', dir: dir || input.defaultDir, name: suggested };

  const target = usableDir(dir, input.probe);

  if (!target) {
    const fallback = usableDir(rules.normalize(input.defaultDir), input.defaultProbe);
    if (!fallback) {
      // Plus aucun dossier exploitable : la boite systeme garde la main, c'est
      // elle qui saura expliquer le probleme mieux que nous.
      return { mode: 'ask', dir: '', name: suggested, reason: input.probe?.code || 'UNREADABLE' };
    }
    return {
      mode: 'write',
      dir: fallback,
      name: rules.uniqueFileName(base, ext, input.existing || []),
      reason: input.probe?.code || 'UNREADABLE',
      reasonKey: rules.errorKeyFor(input.probe?.code || 'UNREADABLE'),
      usedFallback: true,
    };
  }

  const taken = (input.existing || []).some((name) => String(name).toLowerCase() === suggested.toLowerCase());

  if (taken && !input.overwriteOk) {
    return { mode: 'write', dir: target, name: rules.uniqueFileName(base, ext, input.existing), renamed: true };
  }

  return { mode: 'write', dir: target, name: suggested, overwritten: taken };
}

function usableDir(dir, probe) {
  if (!dir) return null;
  if (probe) return probe.ok ? dir : null;
  // Sans sonde, on suppose que l'ecriture passera et on laisse l'erreur
  // remonter a Chromium : mieux vaut un echec honnete qu'un refus preventif.
  return storage.driveAvailable(dir) ? dir : null;
}

function listNames(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Branchement sur de vraies sessions. Appelee pour la session par defaut et pour
 * chaque partition de service : un fichier recu depuis WhatsApp doit obeir au meme
 * dossier qu'un fichier recu depuis Gmail, et un dossier de telechargement par
 * service serait un reglage que personne ne retrouve.
 *
 * @param {object} deps
 * @param {import('electron').Session[]} deps.sessions
 * @param {() => object} deps.getContext  lu a chaque telechargement (reglages a chaud)
 * @param {(title: string, body: string, opts?: object) => void} deps.notify
 * @param {(msg: string[]) => void} deps.log
 */
function attach({ sessions, getContext, log = () => {}, notify = () => {}, t = (key) => key, dialog }) {
  for (const ses of sessions) {
    if (ses.__soocialDownloads) continue;
    ses.__soocialDownloads = true;

    ses.on('will-download', (_event, item, webContents) => {
      const context = getContext();
      const serviceId = context.serviceIdOf ? context.serviceIdOf(webContents) : null;

      const plan = planDownload({
        dir: context.downloadsDir,
        defaultDir: context.defaultDir,
        suggested: item.getFilename(),
        askWhere: Boolean(context.askWhere),
        existing: listNames(context.downloadsDir),
        probe: storage.probeDirectory(context.downloadsDir),
        defaultProbe: storage.probeDirectory(context.defaultDir, { create: true }),
      });

      if (plan.mode === 'ask') {
        askWhere(item, plan, { dialog, log, notify, t, serviceId });
        return;
      }

      if (plan.usedFallback) {
        log([`telechargement : ${plan.reason} sur ${context.downloadsDir}`, `fichier ecrit dans ${plan.dir}`]);
        notify(t('download.movedTitle'), t(plan.reasonKey, { path: plan.dir }), { serviceId });
      }

      if (!plan.dir) {
        // Ni dossier demande ni repli possible : on annule proprement au lieu
        // de laisser Chromium ecrire n'importe ou.
        item.cancel();
        notify(t('download.failedTitle'), t(plan.reasonKey || 'path.error.noPermission'), { serviceId });
        return;
      }

      const target = path.join(plan.dir, plan.name);
      item.setSavePath(target);
      log([`telechargement -> ${target}`]);

      item.once('done', (_e, state) => {
        if (state === 'completed') {
          log([`telechargement termine : ${plan.name}`]);
          if (plan.renamed) notify(t('download.renamedTitle'), t('download.renamedBody', { name: plan.name }), { target, serviceId });
          return;
        }
        log([`telechargement ${state} : ${plan.name}`]);
        if (state === 'interrupted') notify(t('download.interruptedTitle'), t('download.interruptedBody'), { serviceId });
      });
    });
  }
}

/**
 * Boite "Enregistrer sous" maison : le dossier propose est celui des reglages.
 * Celle de Chromium se souvient du dernier endroit visite, ce qui est exactement
 * ce qu'on ne veut pas (un telechargement parti sur une cle retiree se retrouve a
 * la racine du disque).
 */
function askWhere(item, plan, { dialog, log, notify, t, serviceId }) {
  if (!dialog) {
    item.cancel();
    notify(t('download.failedTitle'), t('path.error.noPermission'), { serviceId });
    return;
  }

  const suggested = rules.sanitizeFileName(item.getFilename(), 'download');
  const defaultPath = plan.dir ? path.join(plan.dir, suggested) : suggested;

  dialog
    .showSaveDialog({ title: t('download.saveAs'), defaultPath, properties: ['createDirectory', 'showOverwriteConfirmation'] })
    .then(({ canceled, filePath }) => {
      if (canceled || !filePath) {
        item.cancel();
        return;
      }
      item.setSavePath(filePath);
    })
    .catch((err) => {
      log([`boite d'enregistrement indisponible : ${err.message}`]);
      item.cancel();
    });
}

module.exports = { planDownload, attach, listNames, usableDir };

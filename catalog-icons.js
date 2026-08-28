'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, net, nativeImage } = require('electron');
const { sniffMime, iconWidth, readIco, packIco, toDataUrl, SVG_SCORE } = require('./images');

/**
 * Vignettes du catalogue.
 *
 * Les logos ne sont pas embarques dans l'app : ils seraient figes, alors que les
 * marques changent. Ils sont recuperes depuis le site de chaque service, mis en
 * cache sur disque, et rafraichis une fois par mois.
 *
 * Le prechargement se fait en tache de fond des le demarrage : une grille qui se
 * remplit sous les yeux de l'utilisateur fait aussi pauvre que pas de logo du
 * tout. Quand le formulaire s'ouvre, tout est deja la.
 */

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // un mois
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 6000;
// Garde-fou contre un telechargement absurde, pas contre une grosse icone : un
// .ico multi-resolutions depasse facilement 250 Ko et sera de toute facon reduit
// a une seule frame de 128px avant stockage.
const MAX_BYTES = 1024 * 1024;
const GOOD_ENOUGH = 128; // au-dela, inutile d'essayer les candidats suivants

// Version du format de cache. A incrementer quand la logique de recuperation
// change assez pour que les entrees existantes soient fausses (mauvaise icone,
// resolution trop basse) : sans ca, elles survivraient un mois.
const CACHE_VERSION = 2;

let cacheFile = null;
let cache = {}; // cle d'entree -> { dataUrl, width, fetchedAt }
let saveTimer = null;
let running = false;
let log = () => {};
let notify = () => {};

function init(options = {}) {
  cacheFile = path.join(app.getPath('userData'), 'catalog-icons.json');
  log = options.log || log;
  notify = options.onIcon || notify;

  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (raw.version === CACHE_VERSION) {
      cache = raw.icons || {};
      log('catalogue', `${Object.keys(cache).length} vignettes en cache`);
    } else {
      log('catalogue', 'cache d\'une version precedente, reconstruit');
    }
  } catch {
    cache = {}; // absent ou illisible : on repart d'un cache vide, sans bruit
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify({ version: CACHE_VERSION, icons: cache }));
    } catch (err) {
      log('catalogue', `cache non ecrit : ${err.message}`);
    }
  }, 2000);
}

function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Cle de cache d'une entree du catalogue.
 *
 * Le domaine seul ne suffit pas : Gmail et Google Chat vivent tous deux sur
 * mail.google.com, et une cle partagee faisait porter a Gmail le logo de Chat
 * (le premier des deux a etre rafraichi gagnait). Une entree avec une source
 * declaree obtient donc une cle qui lui est propre.
 */
function keyOf(entry) {
  const domain = domainOf(entry.url);
  if (!domain) return null;
  if (!entry.icon) return domain;

  const base = entry.icon.split('/').pop().split('?')[0].slice(0, 48) || 'override';
  return `${domain}#${base}`;
}

/**
 * Candidats, du plus qualitatif au plus sur.
 * apple-touch-icon fait generalement 180px et existe sur la plupart des sites
 * modernes ; le service de DuckDuckGo sert de filet quand le site n'expose rien
 * a un chemin devinable ; favicon.ico est le dernier recours.
 */
function candidatesFor(domain, override) {
  const bare = domain.replace(/^www\./, '');
  const labels = bare.split('.');
  // Beaucoup de services vivent sur un sous-domaine applicatif qui n'expose
  // aucune icone (app.intercom.com, web.skype.com) alors que le domaine racine
  // en a une. On le garde en dernier recours.
  const root = labels.length > 2 ? labels.slice(-2).join('.') : null;

  return [
    // Une source declaree dans le catalogue passe avant tout : elle n'est la que
    // parce que la detection automatique s'est trompee.
    ...(override ? [override] : []),
    `https://${domain}/apple-touch-icon.png`,
    `https://icons.duckduckgo.com/ip3/${bare}.ico`,
    `https://${domain}/favicon.ico`,
    ...(root ? [`https://icons.duckduckgo.com/ip3/${root}.ico`, `https://${root}/apple-touch-icon.png`] : []),
  ];
}

/**
 * Un logo affiche a 44px n'a aucun besoin d'etre stocke en 512. Sans ce
 * plafond, le cache depasse le megaoctet et transite en entier vers le renderer
 * a chaque demarrage.
 */
function shrink(candidate) {
  if (/svg/i.test(candidate.mime)) return candidate; // vectoriel : deja compact

  let current = candidate;

  // Un .ico embarque toutes les tailles a la fois : on ne garde que la plus
  // grande frame, quand elle est en PNG.
  if (/icon/i.test(current.mime)) {
    const ico = readIco(current.buffer);
    if (!ico) return current;

    current = ico.best.isPng
      ? { buffer: ico.best.data, mime: 'image/png' }
      : { buffer: packIco(ico.best), mime: 'image/x-icon' };
  }

  const image = nativeImage.createFromBuffer(current.buffer);
  if (image.isEmpty() || image.getSize().width <= 192) return current;

  return {
    buffer: image.resize({ width: 128, height: 128, quality: 'best' }).toPNG(),
    mime: 'image/png',
  };
}

async function download(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await net.fetch(url, { signal: controller.signal });
    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_BYTES) return null;

    const declared = (response.headers.get('content-type') || '').split(';')[0];
    const candidate = { buffer, mime: sniffMime(buffer, declared || 'image/png') };

    // Une page HTML renvoyee en 200 a la place d'une image : frequent sur les
    // sites qui redirigent tout vers leur SPA.
    if (/html/i.test(candidate.mime)) return null;

    // Le score se calcule sur l'original — c'est lui qui dit la qualite reelle —
    // mais c'est la version reduite qu'on stocke.
    const width = iconWidth(candidate);
    return width > 0 ? { dataUrl: toDataUrl(shrink(candidate)), width } : null;
  } catch {
    return null; // hors ligne, DNS, timeout : une vignette manquante n'est pas une erreur
  } finally {
    clearTimeout(timer);
  }
}

async function fetchIcon(domain, override) {
  const candidates = candidatesFor(domain, override);

  // Une source declaree l'emporte sans discussion : elle a ete choisie a la main
  // precisement parce que le meilleur score automatique donnait la mauvaise
  // icone (le G generique de Google pour tous ses produits, par exemple).
  if (override) {
    const forced = await download(candidates[0]);
    if (forced) return forced;
    log('catalogue', `${domain} : source declaree indisponible, retour a la detection`);
  }

  let best = null;

  for (const url of candidates.slice(override ? 1 : 0)) {
    const found = await download(url);
    if (found && (!best || found.width > best.width)) best = found;
    if (best && best.width >= GOOD_ENOUGH) break;
  }

  return best;
}

function isStale(entry) {
  return !entry || !entry.dataUrl || Date.now() - (entry.fetchedAt || 0) > MAX_AGE_MS;
}

/** Vignettes connues, pretes a etre envoyees au renderer. */
function known() {
  const result = {};
  for (const [key, entry] of Object.entries(cache)) {
    if (entry?.dataUrl) result[key] = entry.dataUrl;
  }
  return result;
}

/**
 * Met a jour ce qui manque ou a plus d'un mois. Les entrees fraiches ne sont
 * jamais retelechargees, donc un demarrage normal ne fait aucune requete.
 */
async function refresh(entries) {
  if (running) return;

  // cle -> { domain, override }, dedupliquee : deux entrees sans source declaree
  // sur le meme domaine partagent une seule requete.
  const targets = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (key && !targets.has(key)) targets.set(key, { domain: domainOf(entry.url), override: entry.icon || null });
  }

  const stale = [...targets.keys()].filter((key) => isStale(cache[key]));
  if (!stale.length) return;

  running = true;
  log('catalogue', `${stale.length} vignette(s) a rafraichir`);

  let index = 0;
  let updated = 0;

  const worker = async () => {
    while (index < stale.length) {
      const key = stale[index++];
      const { domain, override } = targets.get(key);
      const found = await fetchIcon(domain, override);

      if (found) {
        cache[key] = { ...found, fetchedAt: Date.now() };
        updated++;
        notify(key, found.dataUrl);
      } else {
        // Memorise l'echec pour ne pas reessayer a chaque demarrage.
        cache[key] = { dataUrl: null, fetchedAt: Date.now() };
      }

      scheduleSave();
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  running = false;
  log(
    'catalogue',
    `${updated}/${stale.length} vignette(s) recuperee(s)` +
      (updated < stale.length ? `, ${stale.length - updated} sans icone exploitable` : '')
  );
}

module.exports = { init, refresh, known, domainOf, keyOf, SVG_SCORE };

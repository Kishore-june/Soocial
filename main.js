'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const {
  app,
  BrowserWindow,
  WebContentsView,
  Menu,
  Tray,
  session,
  shell,
  dialog,
  ipcMain,
  clipboard,
  nativeImage,
  nativeTheme,
  powerMonitor,
  Notification,
} = require('electron');
const Store = require('electron-store');
const { SERVICE_DEFAULTS, CHROME_UA } = require('./services');
const storageLayout = require('./main/storage-layout');
const pathRules = require('./shared/path-rules');
const installLayout = require('./main/install-layout');
const legacyMigration = require('./main/migrate-legacy');
const downloadsPolicy = require('./main/downloads');
const { PRODUCT } = require('./shared/product');
const metrics = require('./shared/layout-metrics');
const { CATALOG } = require('./catalog');
const { SVG_SCORE, sniffMime, iconWidth, decodeDataUrl } = require('./images');
const { volumePatch } = require('./audio');
const dnd = require('./dnd');
const catalogIcons = require('./catalog-icons');
const i18n = require('./i18n');
const { t } = i18n;

const REPO_URL = 'https://github.com/MrJOYEN/soocial';
const STORE_URL = 'ms-windows-store://pdp/?productid=9PBW3G2B60J6';

// Build Microsoft Store : Electron leve ce drapeau quand le process tourne
// depuis un paquet MSIX/AppX. Rien a passer au build, c'est l'execution qui
// tranche — le meme code sert aux deux canaux (installeur NSIS et Store).
//
// Trois comportements en dependent, et chacun casse quelque chose s'il est
// laisse tel quel dans un paquet : l'identite Windows (notifications), la mise
// a jour automatique (interdite, le Store s'en charge) et le lancement au
// demarrage (registre virtualise).
const isStore = process.windowsStore === true;

// Dimensions : la valeur fait autorite est shared/layout-metrics.js. Elle part au
// renderer au bootstrap et est posee en variables CSS, pour qu'il n'y ait plus
// deux chiffres a garder "synchro" a la main (voir le commentaire amont).
const SIDEBAR_WIDTH = metrics.SIDEBAR_WIDTH;
const SIDEBAR_WIDTH_COLLAPSED = metrics.SIDEBAR_WIDTH_COLLAPSED;
const TITLEBAR_HEIGHT = metrics.TITLEBAR_HEIGHT;
const SPLIT_GAP = metrics.SPLIT_GAP;
const LOAD_TIMEOUT_MS = 15000; // au-dela, on affiche le bouton "Reessayer"
const PRELOAD_STAGGER_MS = 1500; // delai entre les chargements des services en arriere-plan
const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;
const ICON_PATH = path.join(__dirname, 'assets', 'icon.ico');
const ICONS_DIR = path.join(__dirname, 'assets', 'icons');
const MENU_ICONS_DIR = path.join(__dirname, 'assets', 'menu');

// ---------------------------------------------------------------------------
// Ou l'app stocke, avant meme de lire la moindre config
// ---------------------------------------------------------------------------
//
// Ces lignes sont en haut du fichier parce que l'ordre est un reglage :
// electron-store resout %APPDATA% au moment ou il est construit, et les
// commutateurs Chromium sont ignores une fois app.whenReady() passe. Toute
// initialisation placee plus bas serait silencieusement sans effet - et
// "silencieusement" est ici le mot dangereux : les sessions se retrouveraient
// dans le mauvais repertoire.
//
// 1. Migration : un fork qui change de nom change de repertoire de donnees.
//    Sans elle, un utilisateur qui installait Soocial se reveille avec six comptes
//    deconnectes. La migration precede le store, sinon le store cree le
//    repertoire cible vide et la porte se referme.
// 2. Racines : donnees en %APPDATA% (roaming, donc suit le profil), cache en
//    %LOCALAPPDATA% (jetable, ne doit pas etre synchronise entre les postes),
//    telechargements ou l'utilisateur a dit. Le dossier d'installation n'est
//    jamais une cible d'ecriture.
const ROOTS = storageLayout.resolveRoots();

legacyMigration.migrate({ appData: path.dirname(ROOTS.data) }, { log });

if (isStore) {
  // Sous MSIX, %APPDATA% est deja virtualise vers le conteneur du paquet : on ne
  // le redirige pas, on laisse Windows decider (et le paquet est en lecture
  // seule de toute facon).
  log('storage', 'paquet Store : racines delegatees a la virtualisation Windows');
} else {
  app.setName(PRODUCT.dataDirName);
  app.setPath('userData', ROOTS.data);
  app.setPath('sessionData', ROOTS.data);
  app.commandLine.appendSwitch('disk-cache-dir', path.join(ROOTS.cache, 'Network Cache'));
}


const isDev = process.argv.includes('--dev');
// Passe par l'entree de demarrage Windows quand "demarrer masque" est actif :
// l'app s'ouvre dans la zone de notification, sans fenetre.
const startHidden = process.argv.includes('--hidden');

function log(scope, ...args) {
  // La sortie standard d'une application packagee n'est raccordee a rien, et
  // peut se rompre en cours de route : terminal ferme, tuyau casse. L'ecriture
  // leve alors EPIPE, et une exception non capturee dans le process principal
  // se traduit par une boite d'erreur fatale d'Electron. On ne perd pas
  // l'application pour une ligne de journal.
  try {
    console.log(`[${new Date().toTimeString().slice(0, 8)}] [${scope}]`, ...args);
  } catch {}
}

/** id -> { service, view, status, message, timer, hibernateTimer, badge, iconScore } */
const views = new Map();
/** Services volontairement decharges : connus, configures, mais sans process. */
const hibernated = new Set();

let mainWindow = null;
let tray = null;
let activeId = null;
// Service affiche dans la moitie droite quand la vue partagee est active.
let splitId = null;
// Fenetre verrouillee : vues masquees, ecran de code par-dessus tout.
let locked = false;
let isQuitting = false;
// Demarrage masque avec une fenetre qui etait maximisee : maximize() afficherait
// la fenetre, on note l'etat et on l'applique au premier vrai affichage.
let pendingMaximize = false;
let pendingUpdate = null; // version telechargee, en attente de redemarrage

// Persistance : electron-store ecrit dans %APPDATA%\Soocial\config.json
const store = new Store({
  defaults: {
    window: { width: 1400, height: 900, x: undefined, y: undefined, maximized: false },
    lastActiveId: null,
    // La liste des services vit ici : construite a l'onboarding, editee depuis
    // l'app. Aucun fichier de code ne la definit.
    services: [],
    // Onboarding termine ? Tant que non (et que la liste est vide), le premier
    // lancement affiche l'accueil plutot qu'une fenetre vide.
    onboarded: false,
    // id -> data URI : icones choisies par l'utilisateur (clic droit sur l'icone).
    icons: {},
    // Ordre d'affichage choisi par l'utilisateur (drag & drop dans la sidebar).
    order: [],
    // id -> true : services dont les notifications sont coupees.
    muted: {},
    // Ne pas deranger global : until 0 = inactif, -1 = jusqu'a desactivation,
    // sinon timestamp ms. choice = option cochee dans les menus (voir dnd.js).
    dnd: { until: 0, choice: 'off' },
    // id -> 0..100 : volume par service. Absent = 100, aucun gain applique.
    volumes: {},
    // Volume general, applique par-dessus celui de chaque service.
    masterVolume: 100,
    // 'system' ou un code de langue disponible ('en', 'fr', 'es').
    language: 'system',
    // Lancement avec Windows, et demarrage masque dans la zone de notification.
    autostart: false,
    autostartHidden: false,
    // Correcteur orthographique dans les services.
    spellcheck: true,
    // Vue partagee : service secondaire, cote (droite ou dessous) et position
    // du separateur, restaures au lancement.
    splitId: null,
    splitDirection: 'right',
    splitRatio: 0.5,
    // Verrouillage : code hache (scrypt), jamais en clair.
    lock: { hash: null, salt: null, onSuspend: true, idleMinutes: 0 },
    // id -> true : services qui exigent le code individuellement.
    protected: {},
    // --- Soocial : apparence et fenetre ---
    // 'system' suit le theme Windows. `glass` regle l'intensite de la translucidite,
    // pas le style : 'off' supprime tout backdrop-filter (le cout reel est la, pas
    // dans les coins ronds). `animations` sert aux machines lentes et a
    // prefers-reduced-motion, qui n'est qu'une demande de l'utilisateur.
    theme: 'system',
    glass: 'soft',
    animations: 'full',
    sidebarCollapsed: false,
    // Fermer = cacher dans la zone de notification. Desactive, "fermer" quitte.
    closeToTray: true,
    // Reduire dans la zone de notification au lieu de la barre des taches.
    minimizeToTray: false,
    // --- Soocial : stockage ---
    // null = %USERPROFILE%\Downloads\Soocial. Un chemin n'est memorise que s'il a
    // ete ecrit avec succes : memoriser un chemin inaccessible revient a promener
    // l'erreur a chaque telechargement.
    downloads: null,
    askWhereToSave: false,
    // --- Soocial : navigation ---
    // ids mis en favoris (la vue Favoris de la barre laterale).
    favorites: [],
    // Derniere page hors service ouverte (home | favorites | settings | help) :
    // rouvrir Reglages la ou on l'avait laisse evite de repartir du haut de liste.
    lastPage: null,
    // Date du premier lancement connu par l'app (l'installeur, lui, ne connait
    // que la date de sa propre execution).
    firstLaunchAt: null,
  },
});

if (!store.get('firstLaunchAt')) store.set('firstLaunchAt', new Date().toISOString());

// Acceleration materielle. Le reglage est lu ici et applique avant que Chromium
// n'ait cree sa premiere surface : `app.disableHardwareAcceleration()` apres
// whenReady ne fait que marquer le drapeau, et le redemarrage demande a
// l'utilisateur dans les reglages n'est pas de la timidite, c'est la seule
// facon honnete de faire partir un pilote graphique du probleme.
// Utile sur les postes ou le rendu Compositing provoque des ecrans noirs,
// et sur les tres vieilles puces ou le flou coute plus qu'il ne rapporte.
if (store.get('hardwareAcceleration') === false) {
  app.disableHardwareAcceleration();
  log('app', 'acceleration materielle desactivee (reglage)');
}

// ---------------------------------------------------------------------------
// Catalogue de services
// ---------------------------------------------------------------------------

/** Complete un service stocke avec les valeurs par defaut. */
function withDefaults(service) {
  const merged = { ...SERVICE_DEFAULTS, ...service };

  // Un service sans partition (config ecrite par une version intermediaire, ou
  // editee a la main) recupere la partition conventionnelle liee a son id.
  // Sans ce filet, session.fromPartition(undefined) fait tomber l'app au
  // demarrage, et la config fautive replante a chaque lancement.
  if (!merged.partition && merged.id) merged.partition = `persist:${merged.id}`;

  return merged;
}

/**
 * L'onboarding ne se montre qu'une fois : premier lancement, aucune config.
 * Une installation qui a deja des services (mise a jour depuis une version
 * anterieure a l'onboarding) est consideree comme deja accueillie.
 */
function needsOnboarding() {
  if (store.get('onboarded')) return false;
  if (allServices().length) {
    store.set('onboarded', true);
    return false;
  }
  return true;
}

function allServices() {
  return (store.get('services') || []).map(withDefaults);
}

function getService(id) {
  return allServices().find((service) => service.id === id) || null;
}

/** User-Agent effectif : Chrome maquille, ou celui d'Electron par defaut. */
function userAgentFor(service) {
  return service?.spoofUserAgent ? CHROME_UA : undefined;
}

/**
 * Services dans l'ordre d'affichage. Cet ordre fait autorite partout — sidebar,
 * raccourcis Ctrl+1..9, menu tray — pour que la 3e icone soit toujours Ctrl+3.
 * Les ids inconnus sont ignores, les services non classes arrivent a la fin.
 */
function orderedServices() {
  const services = allServices();
  const stored = store.get('order') || [];
  const byId = new Map(services.map((service) => [service.id, service]));

  const ordered = stored.map((id) => byId.get(id)).filter(Boolean);
  const seen = new Set(ordered.map((service) => service.id));

  for (const service of services) {
    if (!seen.has(service.id)) ordered.push(service);
  }

  return ordered;
}

function isMuted(id) {
  return Boolean(store.get('muted')?.[id]);
}

function dndUntil() {
  return Number(store.get('dnd')?.until) || 0;
}

function dndActive() {
  return dnd.isActive(dndUntil(), Date.now());
}

function slugify(text) {
  return (
    (text || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // diacritiques laissees par NFD
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'service'
  );
}

// Identite Windows de l'app : elle determine le nom affiche par le Action Center
// pour les notifications, mais aussi l'icone et le libelle dans la barre des
// taches — Windows resout cet identifiant vers un raccourci du menu Demarrer et
// lui emprunte son icone, celle de l'exe etant ignoree.
//
// D'ou l'identifiant distinct hors packaging : en dev, Chromium fabrique tout
// seul un raccourci pointant sur electron.exe pour autoriser les toasts. S'il
// portait le meme identifiant que l'app installee, il lui volerait son identite
// et la barre des taches afficherait le logo Electron.
//
// A definir AVANT app.whenReady().
//
// Sauf dans un paquet MSIX : l'identite y est imposee par le manifeste et vaut
// <PackageFamilyName>!<ApplicationId>, soit
//   MehdiJoyen.NexusMessenger_6sysvkg83wmrg!Soocial
// La reecrire avec l'ancien 'com.mehdi.soocial' ferait emettre les toasts sous une
// identite que Windows n'associe a aucun paquet installe : ils cesseraient
// simplement de s'afficher, sans erreur ni trace. Windows renseigne deja la
// bonne valeur, on ne touche a rien.
if (!isStore) {
  app.setAppUserModelId(app.isPackaged ? 'com.mehdi.soocial' : 'com.mehdi.soocial.dev');
}

// Une seule instance : un 2e lancement reveille la fenetre existante.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

// ---------------------------------------------------------------------------
// Sessions isolees + override User-Agent + permissions
// ---------------------------------------------------------------------------

const configuredPartitions = new Set();

// Permissions accordees aux services. "notifications" est la cle du sujet :
// c'est ce qui laisse passer les Notification HTML5 vers le Action Center Windows.
const ALLOWED_PERMISSIONS = new Set([
  'notifications',
  'media', // appels audio/video WhatsApp & Discord
  'audioCapture',
  'videoCapture',
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'background-sync',
  'display-capture', // partage d'ecran Discord
  // Sans elle, Chromium s'autorise a evincer l'IndexedDB du site sous pression
  // disque — donc a deconnecter un compte. WhatsApp la demande a chaque
  // chargement, et l'etancheite des sessions est la raison d'etre de l'app.
  'persistent-storage',
]);

/**
 * Recupere (ou cree) la session d'un service et y branche l'override d'UA.
 * `persist:xxx` => stockage disque dedie : cookies, localStorage, IndexedDB et
 * Service Workers sont cloisonnes par service. C'est ce qui permet d'avoir 3
 * comptes WhatsApp connectes simultanement sans qu'ils se marchent dessus.
 */
function getServiceSession(service) {
  const ses = session.fromPartition(service.partition);

  if (configuredPartitions.has(service.partition)) return ses;
  configuredPartitions.add(service.partition);

  // Telechargements : la politique est par session, pas par fenetre. Un fichier
  // recu depuis WhatsApp doit partir au meme endroit qu'un fichier recu depuis
  // Gmail, et l'inverse se verrait des le deuxieme telechargement.
  downloadsPolicy.attach({
    sessions: [ses],
    getContext: () => ({ ...storageContext(), serviceIdOf: (wc) => serviceIdOfWebContents(wc) }),
    log: (lines) => log('download', [].concat(lines).join(' ')),
    notify: notifyApp,
    t,
    dialog,
  });

  const id = service.id;

  // Les handlers relisent le service dans le store a chaque appel : ses reglages
  // sont editables a chaud, une closure figee les rendrait obsoletes.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const ua = userAgentFor(getService(id));
    if (!ua) return callback({ requestHeaders: details.requestHeaders });

    const headers = details.requestHeaders;
    headers['User-Agent'] = ua;

    // Les Client Hints (sec-ch-ua*) trahissent Electron meme quand l'UA string
    // est maquillee. On les supprime : un navigateur non-Chromium n'en envoie
    // pas, donc WhatsApp retombe sur l'analyse de l'User-Agent.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase().startsWith('sec-ch-ua')) delete headers[key];
    }

    callback({ requestHeaders: headers });
  });

  applySessionUserAgent(service);

  const allows = (permission) => {
    if (permission === 'notifications' && (isMuted(id) || dndActive())) return false;
    return ALLOWED_PERMISSIONS.has(permission);
  };

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    const granted = allows(permission);
    log('permission', `${id} demande "${permission}" -> ${granted ? 'OK' : 'refuse'}`);
    callback(granted);
  });

  // Repond a Notification.permission / navigator.permissions.query() sans prompt.
  ses.setPermissionCheckHandler((_wc, permission) => allows(permission));

  applySpellchecker(ses);

  return ses;
}

// ---------------------------------------------------------------------------
// Correcteur orthographique
//
// Le correcteur est celui de Chromium ; les dictionnaires sont telecharges a la
// demande dans le profil. On corrige dans la langue de l'interface, avec
// l'anglais en plus : c'est dans ces langues qu'on ecrit ses messages. Les
// suggestions s'affichent via le menu contextuel pose sur chaque vue.
// ---------------------------------------------------------------------------

function spellcheckerLanguages(ses) {
  const ui = { en: 'en-US', fr: 'fr', es: 'es' }[i18n.current()] || 'en-US';
  const available = new Set(ses.availableSpellCheckerLanguages);
  return [...new Set([ui, 'en-US'])].filter((code) => available.has(code));
}

function applySpellchecker(ses) {
  const enabled = store.get('spellcheck') !== false;
  ses.setSpellCheckerEnabled(enabled);
  if (!enabled) return;

  const languages = spellcheckerLanguages(ses);
  if (languages.length) ses.setSpellCheckerLanguages(languages);
}

/** A rejouer quand la langue de l'interface ou le reglage change. */
function applySpellcheckerEverywhere() {
  for (const partition of configuredPartitions) {
    applySpellchecker(session.fromPartition(partition));
  }
}

/** Aligne navigator.userAgent sur l'en-tete HTTP (a rejouer apres edition). */
function applySessionUserAgent(service) {
  const ua = userAgentFor(service);
  if (!ua) return;
  session.fromPartition(service.partition).setUserAgent(ua);
  log('session', `${service.partition} : UA override actif`);
}

// ---------------------------------------------------------------------------
// Icones de service
//
// Priorite : 1) icone choisie dans l'app (clic droit > Changer l'icone),
//               persistee en data URI dans electron-store
//            2) fichier local declare via `icon`
//            3) favicon du site, recuperee automatiquement
//            4) initiales colorees (fallback)
// Le renderer a une CSP stricte (img-src 'self' data:) : on lui envoie donc des
// data URI plutot que des chemins disque ou des URL distantes.
// ---------------------------------------------------------------------------

const iconCache = new Map(); // id -> favicon deja envoyee (evite les renvois inutiles)

/** Icone choisie par l'utilisateur, si elle existe. */
function storedIcon(id) {
  return store.get('icons')?.[id] || null;
}

/**
 * Icone effective d'un service, tous niveaux confondus.
 * `source` sert au renderer : la pastille d'initiales n'est affichee que sur les
 * icones automatiques (favicon), la ou deux services peuvent se ressembler. Des
 * que l'utilisateur a choisi son icone, elle disparait.
 */
function resolveIcon(service) {
  const stored = storedIcon(service.id);
  if (stored) return { dataUrl: stored, source: 'user' };

  const declared = loadCustomIcon(service);
  if (declared) return { dataUrl: declared, source: 'declared' };

  const favicon = iconCache.get(service.id);
  if (favicon) return { dataUrl: favicon, source: 'favicon' };

  return { dataUrl: null, source: null };
}

/**
 * Ouvre un selecteur de fichier et enregistre l'image choisie comme icone du
 * service. On stocke une data URI plutot qu'un chemin : l'icone survit au
 * deplacement ou a la suppression du fichier source.
 */
async function chooseIcon(id) {
  const service = getService(id);
  if (!service) return;

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: t('icon.title', { name: service.name }),
    buttonLabel: t('icon.button'),
    properties: ['openFile'],
    // nativeImage ne decode que PNG / JPEG (+ ICO sous Windows).
    filters: [{ name: t('icon.filter'), extensions: ['png', 'jpg', 'jpeg', 'ico'] }],
  });

  if (canceled || !filePaths[0]) return;

  const image = nativeImage.createFromPath(filePaths[0]);
  if (image.isEmpty()) {
    log('icon', `${id} : image illisible -> ${filePaths[0]}`);
    dialog.showErrorBox(t('icon.errorTitle'), t('icon.errorDetail'));
    return;
  }

  // 128px : l'avatar fait 48px mais on garde de la marge pour les ecrans HiDPI.
  const dataUrl = image.resize({ width: 128, height: 128, quality: 'best' }).toDataURL();
  store.set(`icons.${id}`, dataUrl);
  log('icon', `${id} : icone personnalisee definie (${path.basename(filePaths[0])})`);
  send('hub:icon', { id, dataUrl, source: 'user' });
}

/** Supprime l'icone choisie : on retombe sur le fichier declare, puis la favicon. */
function resetIcon(id) {
  const icons = { ...store.get('icons') };
  delete icons[id];
  store.set('icons', icons);

  const service = getService(id);
  if (!service) return;

  const { dataUrl, source } = resolveIcon(service);
  log('icon', `${id} : icone personnalisee retiree -> ${source || 'initiales'}`);
  send('hub:icon', { id, dataUrl, source });
}

/** Charge l'icone locale d'un service, si `icon` est renseigne. */
function loadCustomIcon(service) {
  if (!service.icon) return null;

  const file = path.isAbsolute(service.icon) ? service.icon : path.join(ICONS_DIR, service.icon);
  const image = nativeImage.createFromPath(file);

  if (image.isEmpty()) {
    log('icon', `${service.id} : fichier introuvable ou illisible -> ${file}`);
    return null;
  }

  return image.resize({ width: 128, height: 128, quality: 'best' }).toDataURL();
}

/**
 * Telecharge la favicon du service et la convertit en data URI.
 * Le fetch passe par la session du service : certains sites protegent leurs
 * assets derriere la session (et ca evite une requete hors partition).
 */
async function fetchFavicon(entry, urls) {
  const { service } = entry;
  const candidates = (urls || []).filter(Boolean);
  if (!candidates.length) return;

  // Une icone de priorite superieure est en place : on met quand meme la favicon
  // en cache (elle servira si l'utilisateur fait "Icone par defaut") mais on ne
  // l'affiche pas.
  const overridden = Boolean(storedIcon(service.id) || service.icon);

  // Les sites emettent page-favicon-updated plusieurs fois par chargement, et
  // pas forcement du meilleur au pire : Discord annonce d'abord son icone
  // vectorielle, puis une version canvas de 16px avec son compteur incruste. On
  // garde donc le meilleur score depuis le dernier chargement, pas le dernier
  // arrive. (entry.iconScore est remis a zero par loadService.)
  const publish = (dataUrl, score, note = '') => {
    if (iconCache.get(service.id) === dataUrl) return;

    if (entry.iconScore != null && score <= entry.iconScore) {
      log('icon', `${service.id} : favicon ${note} ignoree (moins bonne que l'actuelle)`);
      return;
    }

    entry.iconScore = score;
    iconCache.set(service.id, dataUrl);
    log('icon', `${service.id} : favicon retenue ${note}`.trim());
    if (!overridden) send('hub:icon', { id: service.id, dataUrl, source: 'favicon' });
  };

  try {
    // Un site declare souvent plusieurs icones : plusieurs tailles (16, 32,
    // 192...) et parfois une favicon dynamique en data URI, dessinee au canvas
    // pour y incruster son compteur de non-lus. L'avatar faisant 48px, on
    // recupere TOUTES les candidates et on garde la plus definie.
    const downloads = await Promise.all(
      candidates.map(async (candidate) => {
        if (candidate.startsWith('data:')) return decodeDataUrl(candidate);
        try {
          const response = await entry.view.webContents.session.fetch(candidate);
          if (!response.ok) return null;
          const buffer = Buffer.from(await response.arrayBuffer());
          const declared = (response.headers.get('content-type') || '').split(';')[0];
          const mime = sniffMime(buffer, declared || 'image/png');
          // Une page HTML servie a la place d'une icone : ce n'est pas une
          // favicon, et la garder afficherait une image cassee.
          return /html/i.test(mime) ? null : { buffer, mime };
        } catch {
          return null;
        }
      })
    );

    const best = downloads
      .filter(Boolean)
      .map((candidate) => ({ ...candidate, width: iconWidth(candidate) }))
      .sort((a, b) => b.width - a.width || b.buffer.length - a.buffer.length)[0];

    if (!best) throw new Error('aucune candidate exploitable');

    publish(
      `data:${best.mime};base64,${best.buffer.toString('base64')}`,
      best.width,
      `(${best.width >= SVG_SCORE ? 'vectorielle' : `${best.width || '?'}px`}, ` +
        `${best.mime}, ${Math.round(best.buffer.length / 1024)} Ko, ` +
        `${candidates.length} candidate(s))`
    );
  } catch (err) {
    log('icon', `${service.id} : favicon indisponible (${err.message}) -> initiales`);
  }
}

// ---------------------------------------------------------------------------
// Coupure des notifications, service par service
//
// Refuser la permission ne suffit pas : les sites l'ont deja obtenue et en
// gardent l'etat en cache. On enveloppe donc window.Notification dans la page
// elle-meme. executeJavaScript s'execute dans le monde principal — contrairement
// a un preload qui, avec contextIsolation, ne pourrait pas toucher au window du
// site.
//
// Le wrapper n'est pose qu'une fois ; ensuite seul le drapeau bascule, ce qui
// rend le mute/unmute instantane, sans rechargement.
// ---------------------------------------------------------------------------

const notificationPatch = (muted) => `(() => {
  const Native = window.__soocialNativeNotification || window.Notification;
  if (!Native) return 'sans-Notification';

  window.__soocialNativeNotification = Native;
  window.__soocialMuted = ${muted};

  if (!window.__soocialPatched) {
    const Patched = function (title, options) {
      if (window.__soocialMuted) {
        // Objet inerte : les sites branchent onclick/onclose dessus juste apres.
        return { title, body: (options || {}).body, close() {},
                 addEventListener() {}, removeEventListener() {} };
      }
      return new Native(title, options);
    };

    Patched.requestPermission = (...args) => Native.requestPermission(...args);
    Object.defineProperty(Patched, 'permission', { get: () => Native.permission });
    window.Notification = Patched;
    window.__soocialPatched = true;
  }

  // Deuxieme voie, distincte : un site peut notifier via son service worker
  // (ServiceWorkerRegistration.showNotification), qui ne touche jamais a
  // window.Notification. Discord et WhatsApp le font.
  const swProto = window.ServiceWorkerRegistration && window.ServiceWorkerRegistration.prototype;
  if (swProto && swProto.showNotification && !window.__soocialSwPatched) {
    const nativeShow = swProto.showNotification;
    swProto.showNotification = function (...args) {
      if (window.__soocialMuted) return Promise.resolve();
      return nativeShow.apply(this, args);
    };
    window.__soocialSwPatched = true;
  }

  return (window.__soocialMuted ? 'coupe' : 'actif')
    + ' [permission Chromium: ' + Native.permission
    + ' | service worker: ' + (window.__soocialSwPatched ? 'enveloppe' : 'absent') + ']';
})()`;

function applyMuteState(entry) {
  // Le "ne pas deranger" global emprunte exactement les trois voies du mute par
  // service : memes patchs, meme coupure audio, sans toucher a l'etat stocke de
  // chaque service — a la desactivation, chacun retrouve son reglage.
  const muted = isMuted(entry.service.id) || dndActive();

  // Troisieme voie, la plus sournoise : les webapps jouent leur propre son
  // depuis la page (le "ding" de WhatsApp), sans passer par l'API Notification.
  // Aucune barriere cote notifications ne peut l'arreter — il faut couper
  // l'audio du webContents.
  // Consequence assumee : un service coupe est aussi muet pendant un appel.
  entry.view.webContents.setAudioMuted(muted);

  entry.view.webContents
    .executeJavaScript(notificationPatch(muted), true)
    .then((state) =>
      log('mute', `${entry.service.id} : notifications ${state} | audio ${muted ? 'coupe' : 'actif'}`)
    )
    .catch((err) => log('mute', `${entry.service.id} : patch impossible (${err.message})`));
}

function setMuted(id, muted) {
  store.set('muted', { ...store.get('muted'), [id]: muted });

  const entry = views.get(id);
  if (entry) applyMuteState(entry);
  else log('mute', `${id} : ${muted ? 'coupe' : 'actif'} (service pas charge)`);

  // La pastille de la tuile montre aussi la coupure : sans cette diffusion,
  // elle resterait sur l'etat d'avant apres un basculement depuis le menu.
  send('hub:volume', { id, value: volumeOf(id), muted });
}

// ---------------------------------------------------------------------------
// Ne pas deranger
//
// Un seul interrupteur au-dessus des coupures par service : tant qu'il est
// actif, applyMuteState traite chaque vue comme muette. Les compteurs de
// non-lus, eux, continuent de vivre — on silence, on ne cache pas.
// ---------------------------------------------------------------------------

let dndTimer = null;

function dndState() {
  return { active: dndActive(), until: dndUntil() };
}

/**
 * (Re)arme le reveil sur l'echeance. Les timers Node comptent en temps
 * monotone : une mise en veille les fige, d'ou le rappel depuis
 * powerMonitor.resume — au reveil de la machine, une echeance depassee
 * s'applique tout de suite au lieu d'attendre la fin du decompte.
 */
function syncDndTimer() {
  clearTimeout(dndTimer);
  dndTimer = null;

  const until = dndUntil();
  if (until <= 0) return; // inactif ou indefini : rien a reveiller

  const remaining = until - Date.now();
  if (remaining <= 0) {
    setDnd('off', 'echeance atteinte');
    return;
  }

  dndTimer = setTimeout(syncDndTimer, Math.min(remaining, 2 ** 31 - 1));
}

function setDnd(choice, origin) {
  const until = dnd.computeUntil(choice, Date.now());
  store.set('dnd', { until, choice: until === 0 ? 'off' : choice });

  const state = until === 0 ? 'inactif' : until === -1 ? 'actif' : `actif jusqu'a ${new Date(until).toLocaleTimeString()}`;
  log('dnd', `${state} (${origin})`);

  for (const entry of views.values()) applyMuteState(entry);
  syncDndTimer();

  // L'etat se lit partout ou il se regle : menus, tray et sidebar.
  refreshTrayMenu();
  refreshTrayTooltip();
  send('hub:dnd', dndState());
}

/** Sous-menu commun au menu Fichier, au tray et au bouton de la sidebar. */
function dndMenuTemplate() {
  const active = dndActive();
  const choice = active ? store.get('dnd')?.choice : 'off';
  const until = dndUntil();

  const option = (key, label, accelerator) => ({
    label,
    type: 'radio',
    checked: choice === key,
    ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
    click: () => setDnd(key, 'menu'),
  });

  return [
    // L'echeance en toutes lettres : les radios disent la duree choisie, pas
    // l'heure a laquelle elle tombe.
    ...(until > 0
      ? [
          {
            label: t('dnd.activeUntil', {
              time: new Date(until).toLocaleTimeString(i18n.current(), {
                hour: '2-digit',
                minute: '2-digit',
              }),
            }),
            enabled: false,
          },
          { type: 'separator' },
        ]
      : []),
    // Les cinq radios doivent rester contigues : un separateur couperait le
    // groupe en deux, et Electron coche d'office le premier element de tout
    // groupe ou rien n'est coche — "Off" et une duree paraissaient coches
    // en meme temps.
    option('off', t('dnd.off')),
    option('30', t('dnd.30')),
    option('60', t('dnd.60')),
    option('morning', t('dnd.morning')),
    option('on', t('dnd.on'), 'CommandOrControl+D'),
  ];
}

// ---------------------------------------------------------------------------
// Volume par service
// ---------------------------------------------------------------------------

// Le gain lui-meme vit dans audio.js : il s'evalue dans la page, pas ici, et
// le sortir d'ici le rend testable sans lancer l'application entiere.

function clampVolume(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(100, Math.max(0, Math.round(number)));
}

/** Volume d'un service, de 0 a 100. Jamais enregistre = 100. */
function volumeOf(id) {
  return clampVolume(store.get('volumes')?.[id], 100);
}

/** Volume general, de 0 a 100. */
function masterVolume() {
  return clampVolume(store.get('masterVolume'), 100);
}

/**
 * Ce qui arrive vraiment a la page : le volume du service, module par le
 * general. Les deux sont stockes separement, et c'est ce qui permet au curseur
 * general de restituer exactement l'equilibre d'origine quand on le remonte —
 * recalculer les valeurs individuelles les ecraserait sans retour possible.
 */
function effectiveLevel(id) {
  return (volumeOf(id) / 100) * (masterVolume() / 100);
}

function applyVolume(entry) {
  const id = entry.service.id;

  entry.view.webContents
    .executeJavaScript(volumePatch(effectiveLevel(id)), true)
    .then((applied) => log('volume', `${id} : ${applied}`))
    .catch((err) => log('volume', `${id} : patch impossible (${err.message})`));
}

function setVolume(id, value) {
  const level = clampVolume(value, 100);
  store.set('volumes', { ...store.get('volumes'), [id]: level });

  const entry = views.get(id);
  if (entry) applyVolume(entry);
  else log('volume', `${id} : ${level} % (service pas charge)`);

  send('hub:volume', { id, value: level, muted: isMuted(id) });
}

function setMasterVolume(value) {
  const level = clampVolume(value, 100);
  store.set('masterVolume', level);
  log('volume', `general : ${level} %`);

  // Le general ne touche a aucune valeur stockee des services : il change
  // seulement ce qui arrive aux pages, d'ou la reapplication de toutes les vues.
  for (const entry of views.values()) applyVolume(entry);

  send('hub:volume', { master: level });
}

// ---------------------------------------------------------------------------
// Vues de service (WebContentsView, remplacant de BrowserView depuis Electron 30)
// ---------------------------------------------------------------------------

// Hotes autorises a ouvrir une vraie popup Electron : ce sont les flux d'auth
// qui ont besoin de la session du service. Tout le reste part dans le navigateur
// systeme.
const AUTH_HOST_PATTERNS = [
  /(^|\.)accounts\.google\.com$/,
  /(^|\.)accounts\.youtube\.com$/,
  /(^|\.)login\.microsoftonline\.com$/,
  /(^|\.)appleid\.apple\.com$/,
  /(^|\.)facebook\.com$/,
  /(^|\.)discord\.com$/,
  /(^|\.)whatsapp\.com$/,
  /(^|\.)slack\.com$/,
];

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function isAuthPopup(url) {
  const host = hostOf(url);
  return host ? AUTH_HOST_PATTERNS.some((re) => re.test(host)) : false;
}

function createServiceView(service) {
  const view = new WebContentsView({
    webPreferences: {
      session: getServiceSession(service),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Sans ca, Chromium throttle les timers/WebSocket des vues cachees :
      // les services en arriere-plan rateraient leurs notifications.
      backgroundThrottling: false,
      spellcheck: true,
    },
  });

  view.setBackgroundColor('#1e1e2e');

  const entry = { service, view, status: 'idle', timer: null, hibernateTimer: null, badge: 0 };
  views.set(service.id, entry);
  hibernated.delete(service.id);

  const wc = view.webContents;

  // Les raccourcis doivent marcher quand le focus est dans le service (cas
  // normal) et pas seulement dans la sidebar.
  wc.on('before-input-event', handleShortcut);

  // dom-ready plutot que did-finish-load : on veut envelopper Notification avant
  // que le site n'en garde une reference.
  wc.on('dom-ready', () => {
    applyMuteState(entry);
    // Meme moment que le patch des notifications : la page a pu recreer ses
    // elements audio, et un rechargement remet tout a plat cote page.
    applyVolume(entry);
  });

  // Menu contextuel dans les zones de saisie : c'est la que vivent les
  // suggestions du correcteur. Ailleurs on ne fait rien — beaucoup de webapps
  // (Discord, Notion) dessinent leur propre menu, inutile d'en superposer un.
  wc.on('context-menu', (_e, params) => {
    if (!params.isEditable) return;

    const template = [];

    for (const suggestion of (params.dictionarySuggestions || []).slice(0, 5)) {
      template.push({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) });
    }

    if (params.misspelledWord) {
      template.push(
        {
          label: t('ctx.addToDictionary'),
          click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        },
        { type: 'separator' }
      );
    }

    // Appels explicites sur wc plutot que des roles : un role agit sur le
    // webContents qui a le focus, pas forcement celui du clic.
    template.push(
      { label: t('menu.edit.cut'), enabled: params.editFlags.canCut, click: () => wc.cut() },
      { label: t('menu.edit.copy'), enabled: params.editFlags.canCopy, click: () => wc.copy() },
      { label: t('menu.edit.paste'), enabled: params.editFlags.canPaste, click: () => wc.paste() },
      { label: t('menu.edit.selectAll'), click: () => wc.selectAll() }
    );

    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  wc.on('did-finish-load', () => setStatus(entry, 'ready'));

  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 = ERR_ABORTED : navigation annulee (redirection interne), pas une erreur.
    if (!isMainFrame || errorCode === -3) return;
    setStatus(entry, 'error', `${errorDescription} (${errorCode}) sur ${validatedURL}`);
  });

  wc.on('render-process-gone', (_e, details) => {
    setStatus(entry, 'error', `Process renderer termine : ${details.reason}`);
  });

  // Detection des notifications non lues : les webapps mettent le compteur dans
  // le titre de l'onglet -> "(3) WhatsApp", "(1) Discord".
  wc.on('page-title-updated', (_e, title) => {
    // Titre brut journalise : c'est la seule source du comptage, et chaque
    // service a sa propre convention (messages ? conversations ?).
    log('title', `${service.id} : "${title}"`);
    updateBadge(entry, title);
  });

  // Icone : favicon officielle du site, sauf si une icone locale est declaree.
  wc.on('page-favicon-updated', (_e, favicons) => fetchFavicon(entry, favicons));

  wc.setWindowOpenHandler(({ url }) => {
    if (isAuthPopup(url)) {
      log('popup', service.id, url);
      return {
        action: 'allow',
        // La popup herite de la session du service, sinon le login echoue.
        overrideBrowserWindowOptions: {
          parent: mainWindow,
          width: 620,
          height: 760,
          autoHideMenuBar: true,
          webPreferences: {
            session: getServiceSession(service),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }

    log('external', service.id, url);
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Une popup d'auth ne doit pas SURVIVRE au login : une fois le flux termine,
  // le site renvoie la popup vers son propre domaine (ex. accounts.google.com
  // -> calendar.google.com). A ce moment on la ferme et on reprend la main dans
  // la vue principale, qui partage la meme session (donc deja authentifiee).
  wc.on('did-create-window', (child, { url }) => {
    const serviceHost = hostOf(service.url);
    let absorbed = false;

    log('popup', `${service.id} : fenetre ouverte (${url})`);

    child.webContents.on('did-navigate', (_e, navigatedUrl) => {
      if (absorbed || hostOf(navigatedUrl) !== serviceHost) return;
      absorbed = true;
      log('popup', `${service.id} : flux termine -> retour dans la fenetre principale`);
      wc.loadURL(navigatedUrl);
      setImmediate(() => !child.isDestroyed() && child.close());
    });

    child.on('closed', () => {
      // Popup fermee sans redirection detectee (login termine puis fermeture
      // manuelle) : on recharge le service pour prendre en compte la session.
      if (absorbed) return;
      log('popup', `${service.id} : fermee -> rechargement du service`);
      if (!wc.isDestroyed()) wc.reload();
    });
  });

  mainWindow.contentView.addChildView(view);
  view.setVisible(false);
  layoutViews();

  loadService(entry);

  // Un service preche nait en arriere-plan : sa minuterie de veille doit
  // demarrer ici, sinon elle n'existerait qu'apres un premier changement de
  // service — et un service jamais consulte ne s'endormirait jamais.
  if (service.id !== activeId) scheduleHibernation(entry);

  return entry;
}

function loadService(entry) {
  const { service, view } = entry;
  clearTimeout(entry.timer);
  entry.iconScore = null; // nouvelle page = nouvelle competition entre favicons
  setStatus(entry, 'loading');
  log('load', service.id, '->', service.url);

  view.webContents
    .loadURL(service.url, { userAgent: userAgentFor(service) })
    .catch((err) => setStatus(entry, 'error', err.message));

  // Garde-fou : si rien n'a charge au bout de 15s, on rend la main a l'UI.
  entry.timer = setTimeout(() => {
    if (entry.status === 'loading') {
      setStatus(entry, 'error', `Timeout : aucune reponse apres ${LOAD_TIMEOUT_MS / 1000}s`);
    }
  }, LOAD_TIMEOUT_MS);
}

function setStatus(entry, status, message) {
  if (status !== 'loading') clearTimeout(entry.timer);
  entry.status = status;
  entry.message = message;

  if (status === 'ready') log('ready', entry.service.id, '-', entry.view.webContents.getTitle());
  if (status === 'error') log('error', entry.service.id, '-', message);

  // En erreur la vue est masquee : l'overlay "Reessayer" du renderer principal
  // devient visible dessous.
  if (!locked && (entry.service.id === activeId || entry.service.id === splitId)) {
    entry.view.setVisible(status !== 'error' && !needsCode(entry.service.id));
  }

  send('hub:status', { id: entry.service.id, status, message });
}

/**
 * Parse le compteur de non-lus dans le titre de la page.
 *  "(3) WhatsApp"       -> 3
 *  "(1) Discord | #dev" -> 1
 *  "• Discord"          -> -1 (non-lus sans compteur : pastille sans chiffre)
 *  "WhatsApp"           -> 0
 */
function parseBadgeCount(title) {
  const match = /\((\d+)\)/.exec(title || '');
  if (match) return Number(match[1]);
  if (/^\s*[•●*]/.test(title || '')) return -1;
  return 0;
}

function updateBadge(entry, title) {
  const count = parseBadgeCount(title);
  if (count === entry.badge) return;

  entry.badge = count;
  log('badge', entry.service.id, `-> ${count} (titre: "${title}")`);
  send('hub:badge', { id: entry.service.id, count });
  refreshTrayTooltip();
}

// ---------------------------------------------------------------------------
// Mise en veille
//
// Un service en veille est detruit : son process Chromium disparait et la
// memoire est rendue. En contrepartie il ne remonte plus ni badge ni
// notification jusqu'au prochain clic. C'est le seul arbitrage possible — un
// service qui notifie est un service qui tourne.
// ---------------------------------------------------------------------------

function hibernateService(id, reason) {
  const entry = views.get(id);
  if (!entry) return;

  // Un service affiche (a gauche comme a droite) n'est jamais mis en veille :
  // la zone deviendrait vide.
  if (id === activeId || id === splitId) return;

  clearTimeout(entry.timer);
  clearTimeout(entry.hibernateTimer);

  mainWindow?.contentView.removeChildView(entry.view);
  entry.view.webContents.close();
  views.delete(id);
  hibernated.add(id);
  unlockedIds.delete(id); // au reveil, un service protege redemande son code

  log('veille', `${id} endormi (${reason})`);
  send('hub:status', { id, status: 'hibernated' });
  send('hub:badge', { id, count: 0 });
  refreshTrayTooltip();
}

/**
 * Programme la veille d'un service qui vient de passer en arriere-plan.
 *
 * A n'appeler QUE lorsqu'un service cesse d'etre affiche. Le rappeler a chaque
 * changement de service, y compris pour ceux qui etaient deja en arriere-plan,
 * relancerait leur compte a rebours : le delai ne s'ecoulerait alors que si
 * l'utilisateur ne touche plus du tout a la sidebar, ce qui n'est pas
 * "inactivite de ce service".
 */
function scheduleHibernation(entry) {
  clearTimeout(entry.hibernateTimer);

  const minutes = Number(entry.service.hibernateAfter) || 0;
  if (minutes <= 0) return;

  entry.hibernateTimer = setTimeout(
    () => hibernateService(entry.service.id, `${minutes} min sans consultation`),
    minutes * 60000
  );
}

function showService(id) {
  const service = getService(id);
  if (!service || locked) return;

  const previousId = activeId;

  // Cliquer le service deja affiche a droite : les deux moities s'echangent
  // plutot que d'afficher le meme service des deux cotes.
  if (id === splitId) setSplitId(previousId !== id ? previousId : null);

  activeId = id;
  store.set('lastActiveId', id);

  // Le service demande se reveille tout seul : createServiceView le recharge.
  const entry = views.get(id) || createServiceView(service);
  clearTimeout(entry.hibernateTimer); // on le consulte : son compte a rebours s'annule

  // Seul le service qu'on vient de quitter demarre son compte a rebours. Les
  // autres gardent le leur, deja en cours. Un service qui reste visible dans la
  // moitie droite ne s'endort pas.
  if (previousId && previousId !== id && previousId !== splitId) {
    const previous = views.get(previousId);
    if (previous) scheduleHibernation(previous);

    // Un service protege se re-arme des qu'il quitte l'ecran : son code garde
    // chaque ouverture, pas seulement le retour d'un verrouillage global.
    if (isProtected(previousId)) unlockedIds.delete(previousId);
  }

  // Un service qu'on choisit passe avant n'importe quelle page : sans ceci, la
  // vue redeviendrait visible sous la page Reglages, ouverte et muette.
  closePage();

  applyViewVisibility();
  layoutViews();
  if (entry.status !== 'error' && !needsCode(id)) entry.view.webContents.focus();

  log('switch', id + (needsCode(id) ? ' (code demande)' : ''));
  send('hub:active', { id, needsCode: needsCode(id) });
}

/** Seuls le service actif et celui de la moitie droite sont visibles. */
function applyViewVisibility() {
  for (const [id, entry] of views) {
    entry.view.setVisible(
      !locked &&
        (id === activeId || id === splitId) &&
        entry.status !== 'error' &&
        !needsCode(id)
    );
  }
}

// ---------------------------------------------------------------------------
// Vue partagee : un second service occupe la moitie droite
// ---------------------------------------------------------------------------

/** Change l'id de droite et previent la sidebar (le menu suit au prochain rendu). */
function setSplitId(id) {
  splitId = id;
  store.set('splitId', id);
  send('hub:split', { id });
}

function setSplit(id, direction) {
  const service = getService(id);
  // Un service qui attend son code ne va pas en part partagee : elle n'a pas
  // d'ecran de code. Il se deverrouille d'abord en vue simple.
  if (!service || id === activeId || needsCode(id)) return;

  if (direction) store.set('splitDirection', direction === 'bottom' ? 'bottom' : 'right');
  if (id === splitId) return layoutViews(); // meme service, seul le cote change

  setSplitId(id);

  // Le service de droite se reveille comme un service actif.
  const entry = views.get(id) || createServiceView(service);
  clearTimeout(entry.hibernateTimer);

  applyViewVisibility();
  layoutViews();
  log('split', `${id} affiche a droite`);
}

function closeSplit(reason) {
  if (!splitId) return;

  const leavingId = splitId;
  const entry = views.get(leavingId);
  log('split', `vue partagee fermee (${reason})`);
  setSplitId(null);

  // Redevenu invisible, le service reprend sa vie d'arriere-plan, et son code
  // se re-arme s'il est protege.
  if (entry) scheduleHibernation(entry);
  if (isProtected(leavingId) && leavingId !== activeId) unlockedIds.delete(leavingId);

  applyViewVisibility();
  layoutViews();
}

// ---------------------------------------------------------------------------
// Layout : la vue active occupe toute la fenetre moins la sidebar, ou une part
// reglable quand la vue partagee est active (l'autre part revient au service
// secondaire, a droite ou en dessous selon le reglage)
// ---------------------------------------------------------------------------

/** Dernier layout envoye a la sidebar (repris par le bootstrap du renderer). */
let lastLayout = null;

/** Largeur effective de la barre laterale : repliee, elle ne garde que les icones. */
function sidebarWidth() {
  return store.get('sidebarCollapsed') ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH;
}

/**
 * Zone ou poser les vues natives.
 *
 * Trois choses la bornent, et les trois bougent : la barre laterale (pliable),
 * la barre de titre (dessinee par nous depuis que la fenetre est sans cadre, donc
 * absente du calcul "zone client - largeur de la sidebar" qui suffisait avant) et
 * le plein ecran (la barre de titre disparait, sa place aussi). Oublier l'un des
 * trois ne casse pas l'app : decale Discord de 40 px, avec le bord du contenu
 * coupe et une bande cliquable qui n'appartient a rien.
 */
function contentArea() {
  const { width, height } = mainWindow.getContentBounds();
  const chrome = mainWindow.isSimpleFullScreen() || mainWindow.isFullScreen() ? 0 : TITLEBAR_HEIGHT;
  const sidebar = sidebarWidth();

  return {
    x: sidebar,
    y: chrome,
    width: Math.max(0, width - sidebar),
    height: Math.max(0, height - chrome),
  };
}

function splitRatio() {
  const ratio = Number(store.get('splitRatio'));
  return Math.min(0.8, Math.max(0.2, Number.isFinite(ratio) ? ratio : 0.5));
}

function layoutViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const area = contentArea();

  const split = splitId ? views.get(splitId) : null;
  let activeBounds = area;
  let splitBounds = null;
  let divider = null;

  if (split) {
    if (store.get('splitDirection') === 'bottom') {
      const top = Math.floor((area.height - SPLIT_GAP) * splitRatio());
      activeBounds = { ...area, height: top };
      splitBounds = {
        x: area.x,
        y: top + SPLIT_GAP,
        width: area.width,
        height: area.height - top - SPLIT_GAP,
      };
      divider = { orientation: 'h', pos: top };
    } else {
      const left = Math.floor((area.width - SPLIT_GAP) * splitRatio());
      activeBounds = { ...area, width: left };
      splitBounds = {
        x: area.x + left + SPLIT_GAP,
        y: area.y,
        width: area.width - left - SPLIT_GAP,
        height: area.height,
      };
      divider = { orientation: 'v', pos: left };
    }
  }

  for (const [id, entry] of views) {
    entry.view.setBounds(split && id === splitId ? splitBounds : activeBounds);
  }

  // La sidebar a besoin du decoupage : elle y place le separateur saisissable
  // et cale l'ecran de code d'un service protege sur la bonne part (les
  // coordonnees sont relatives a la zone de contenu, sidebar deduite).
  lastLayout = {
    active: { width: activeBounds.width, height: activeBounds.height },
    divider,
    // Origine de la zone de service, en coordonnees de la fenetre : le renderer
    // en a besoin pour aligner ses calques (ecran de code, separateur, modales)
    // sur les vues natives qu'il ne peut pas recouvrir.
    origin: { x: area.x, y: area.y },
    sidebar: sidebarWidth(),
    titlebar: area.y,
  };
  send('hub:layout', lastLayout);
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// Verrouillage
//
// Un ecran de code par-dessus la fenetre, pas du chiffrement : les donnees sur
// le disque restent lisibles hors de Soocial. Le code est hache (scrypt + sel),
// jamais stocke en clair. Code oublie : supprimer la section "lock" de
// %APPDATA%\Soocial\config.json, les services restent connectes.
// ---------------------------------------------------------------------------

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

function hasPin() {
  return Boolean(store.get('lock')?.hash);
}

function matchesCode(pin, entry) {
  if (!entry?.hash || !entry?.salt) return false;

  const candidate = Buffer.from(hashPin(pin || '', entry.salt), 'hex');
  const expected = Buffer.from(entry.hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/** Code global de l'app (Ctrl+L). */
function verifyPin(pin) {
  return matchesCode(pin, store.get('lock'));
}

/** Code propre a un service protege. */
function verifyServiceCode(id, pin) {
  return matchesCode(pin, store.get('protected')?.[id]);
}

// -- Verrouillage par service ------------------------------------------------
// Chaque service protege porte SON code, cree au moment de l'activation et
// supprime avec elle : deux services proteges ont deux codes independants, et
// tout ca est distinct du code global de l'app (Ctrl+L). Un service protege se
// charge normalement en arriere-plan (notifications comprises) mais sa vue
// reste masquee derriere un ecran de code. Le code est redemande a chaque
// retour sur le service : le deverrouillage ne vaut que tant qu'il est a
// l'ecran.

/** Services proteges dont le code a ete saisi et qui sont restes a l'ecran. */
const unlockedIds = new Set();

function isProtected(id) {
  const entry = store.get('protected')?.[id];
  // Une vieille config stockait `true` sans code : sans code a verifier, la
  // protection est levee plutot que de bloquer le service pour toujours.
  return Boolean(entry && entry.hash && entry.salt);
}

function needsCode(id) {
  return Boolean(id) && isProtected(id) && !unlockedIds.has(id);
}

/** Pose ou retire le code d'un service ({ hash, salt } ou null). */
function setProtection(id, entry) {
  const flags = { ...store.get('protected') };
  if (entry) flags[id] = entry;
  else delete flags[id];
  store.set('protected', flags);

  unlockedIds.delete(id);
  // Le service affiche ne se verrouille pas sous les yeux de celui qui vient
  // d'activer l'option : la protection s'armera quand il quittera l'ecran.
  if (entry && (id === activeId || id === splitId)) unlockedIds.add(id);

  log('lock', `${id} : code ${entry ? 'exige' : 'retire'}`);
}

function lockApp(reason) {
  if (locked || !hasPin()) return;

  locked = true;
  unlockedIds.clear(); // les services proteges redemandent leur code
  // Les vues sont des couches natives au-dessus du renderer : sans ca, l'ecran
  // de verrouillage resterait cache sous le service affiche.
  for (const entry of views.values()) entry.view.setVisible(false);

  log('lock', `verrouille (${reason})`);
  send('hub:lock', { locked: true });
}

function unlockApp() {
  locked = false;

  // Un service protege re-arme par le verrouillage ne peut pas rester en part
  // partagee : cette part n'a pas d'ecran de code, elle resterait juste vide.
  if (needsCode(splitId)) closeSplit('service protege re-verrouille');

  applyViewVisibility();
  log('lock', 'deverrouille');
  send('hub:lock', { locked: false });

  // Le service actif peut avoir ete re-arme lui aussi : la sidebar doit alors
  // remontrer son ecran de code, sinon la zone reste vide.
  send('hub:active', { id: activeId, needsCode: needsCode(activeId) });
  if (!needsCode(activeId)) views.get(activeId)?.view.webContents.focus();

}

// ---------------------------------------------------------------------------
// Raccourcis clavier
// ---------------------------------------------------------------------------

/**
 * On passe par before-input-event plutot que par globalShortcut (qui capterait
 * les touches meme quand l'app n'a pas le focus) ou par un Menu applicatif
 * (dont les accelerateurs sont parfois avales par les webapps). Ce handler est
 * branche sur la sidebar ET sur chaque vue de service.
 */
function handleShortcut(event, input) {
  // input.alt exclut AltGr : sur un clavier AZERTY, AltGr est envoye comme
  // Ctrl+Alt, et taper ~ # { [ dans un service declencherait nos raccourcis.
  if (input.type !== 'keyDown' || !input.control || input.alt) return;

  // Verrouille, l'app ne repond plus qu'a l'ecran de code.
  if (locked) return;

  const key = (input.key || '').toLowerCase();
  const activeEntry = views.get(activeId);
  const webContentsIdOf = (evt) => (evt && evt.sender ? evt.sender.id : -1);
  const services = orderedServices();

  // Ctrl+1..9 : switch de service, dans l'ordre affiche par la sidebar.
  // On lit la POSITION de la touche (input.code, Digit1..Digit9), pas le
  // caractere produit : sur un AZERTY la rangee du haut donne & e " ' ( - e _ c
  // sans Shift, et comparer input.key a un chiffre ne matchait jamais.
  const digitMatch = /^(?:Digit|Numpad)([1-9])$/.exec(input.code || '');
  const digit = digitMatch ? Number(digitMatch[1]) : NaN;
  if (!input.shift && digit >= 1 && digit <= Math.min(9, services.length)) {
    event.preventDefault();
    log('shortcut', `Ctrl+${digit} -> ${services[digit - 1].id}`);
    showService(services[digit - 1].id);
    return;
  }

  if (key === 'n' && !input.shift) {
    event.preventDefault();
    send('hub:new-service', {});
    return;
  }

  if (key === 'r' && activeEntry) {
    event.preventDefault();
    if (input.shift) {
      // Hard reload : on vide le cache HTTP de la partition avant de recharger.
      log('shortcut', `hard reload ${activeId}`);
      activeEntry.view.webContents.session
        .clearCache()
        .then(() => activeEntry.view.webContents.reloadIgnoringCache());
    } else {
      log('shortcut', `reload ${activeId}`);
      activeEntry.view.webContents.reload();
    }
    return;
  }

  if (key === 'i' && input.shift && activeEntry) {
    event.preventDefault();
    activeEntry.view.webContents.toggleDevTools();
    return;
  }

  if (key === ',' && !input.shift) {
    // Le raccourci universel des reglages etait vole par les outils de
    // developpement de la sidebar. Ils passent en Ctrl+Shift+J ; la page
    // Reglages, elle, se doit d'etre a l'endroit ou tout le monde la cherche.
    event.preventDefault();
    openPage('settings');
    return;
  }

  if (key === 'j' && input.shift) {
    event.preventDefault();
    mainWindow.webContents.toggleDevTools();
    return;
  }

  // Les roles d'edition (couper, copier, coller, tout selectionner, annuler)
  // etaient fournis par le menu applicatif. Sans menu, ils doivent etre rejoues
  // ici, sinon Ctrl+C ne copie plus rien dans un champ de la sidebar.
  // Uniquement dans la sidebar : dans un service, c'est la page qui doit traiter
  // (elle a son propre historique et son presse-papiers riche).
  const EDIT_ROLES = { c: 'copy', x: 'cut', v: 'paste', a: 'selectAll', z: 'undo', y: 'redo' };
  if (EDIT_ROLES[key] && webContentsIdOf(event) === mainWindow.webContents.id) {
    const role = EDIT_ROLES[key];
    // redo est le seul des six a exiger Shift (Ctrl+Y est l'autre forme, gardee).
    if (input.shift === (role === 'redo')) {
      event.preventDefault();
      mainWindow.webContents[role]();
      return;
    }
  }

  if (key === 'd' && !input.shift) {
    event.preventDefault();
    // Bascule brute : actif (peu importe la duree) -> inactif, inactif ->
    // jusqu'a desactivation. Les durees fines vivent dans les menus.
    setDnd(dndActive() ? 'off' : 'on', 'raccourci');
    return;
  }

  if (key === 'l' && !input.shift) {
    event.preventDefault();
    lockApp('raccourci'); // sans code defini, ne fait rien
    return;
  }

  if (key === 'q' && !input.shift) {
    event.preventDefault();
    quitApp();
  }
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function createTray() {
  const image = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('Soocial');

  // Clic gauche : show/hide. Clic droit : menu (gere par setContextMenu).
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) {
      mainWindow.hide();
      log('tray', 'fenetre masquee');
    } else {
      showWindow();
    }
  });

  refreshTrayMenu();
  log('tray', 'icone creee');
}

function refreshTrayMenu() {
  if (!tray) return;

  const template = [
    ...orderedServices().map((service, index) => ({
      label: hibernated.has(service.id)
        ? t('tray.sleeping', { name: service.name })
        : service.name,
      accelerator: index < 9 ? `CommandOrControl+${index + 1}` : undefined,
      click: () => {
        showWindow();
        showService(service.id);
      },
    })),
    { type: 'separator' },
    {
      label: dndActive() ? t('dnd.menuOn') : t('dnd.menu'),
      submenu: dndMenuTemplate(),
    },
    {
      label: t('tray.toggle'),
      click: () => (mainWindow?.isVisible() ? mainWindow.hide() : showWindow()),
    },
  ];

  if (pendingUpdate) {
    template.push(
      { type: 'separator' },
      { label: t('tray.install', { version: pendingUpdate }), click: installUpdate }
    );
  }

  template.push(
    { type: 'separator' },
    { label: t('menu.help.about'), click: showAbout },
    { label: t('menu.file.quit'), accelerator: 'CommandOrControl+Q', click: quitApp }
  );

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function refreshTrayTooltip() {
  if (!tray) return;
  const total = [...views.values()].reduce((sum, entry) => sum + Math.max(0, entry.badge), 0);
  const base = total > 0 ? t('tray.unread', { count: total }) : 'Soocial';
  tray.setToolTip(dndActive() ? `${base} — ${t('dnd.menu')}` : base);
}

// ---------------------------------------------------------------------------
// Mise a jour automatique (GitHub Releases via electron-updater)
// ---------------------------------------------------------------------------

/**
 * electron-updater n'est charge qu'en cas de besoin reel. Dans un paquet MSIX
 * ce require n'a jamais lieu : le module n'est pas seulement neutralise, il
 * n'est pas instancie.
 */
let updaterInstance = null;
function updater() {
  if (!updaterInstance) updaterInstance = require('electron-updater').autoUpdater;
  return updaterInstance;
}

/**
 * Le canal de mise a jour est-il actif ? Non dans un paquet MSIX : le Store
 * distribue les mises a jour, et une application empaquetee n'a de toute facon
 * pas le droit de reecrire son propre paquet — le dossier d'installation est en
 * lecture seule. Laisser electron-updater tourner en plus du Store, c'est le
 * piege classique du portage Electron vers MSIX : telechargement d'une release
 * GitHub qui ne s'appliquera jamais, puis echec silencieux a l'installation.
 */
function canSelfUpdate() {
  return app.isPackaged && !isStore;
}

function setupUpdater() {
  if (isStore) {
    log('update', 'ignore : paquet Microsoft Store, les mises a jour passent par le Store');
    return;
  }

  // Hors packaging il n'y a pas de version installee a remplacer : electron-updater
  // chercherait un dev-app-update.yml inexistant et jetterait a chaque demarrage.
  if (!app.isPackaged) {
    log('update', 'ignore : application non packagee');
    return;
  }

  const autoUpdater = updater();

  autoUpdater.logger = {
    info: (message) => log('update', message),
    warn: (message) => log('update', `attention : ${message}`),
    error: (message) => log('update', `erreur : ${message}`),
    debug: () => {},
  };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    log('update', `version ${info.version} disponible, telechargement en cours`);
    send('hub:update', { state: 'downloading', version: info.version });
  });

  autoUpdater.on('update-not-available', () => log('update', 'deja a jour'));

  autoUpdater.on('update-downloaded', (info) => {
    pendingUpdate = info.version;
    // Le chemin est consigne des maintenant : l'utilisateur verra dans la barre
    // ou la mise a jour va taper, avant de cliquer.
    log('update', `cible : ${installLayout.currentInstall({ app }).installDir}`);
    log('update', `version ${info.version} prete, en attente de redemarrage`);
    send('hub:update', { state: 'ready', version: info.version });
    refreshTrayMenu();
  });

  autoUpdater.on('error', (err) => log('update', `echec : ${err.message}`));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, UPDATE_INTERVAL_MS);
}

/**
 * L'installation est-elle a la place qu'elle dit occuper ?
 *
 * C'est LE test qui protege une installation personnalisee d'un update qui la
 * deplace. electron-updater relance l'installeur NSIS en mode silencie, et
 * l'installateur retrouve son dossier dans le registre ; si ce registre a mente
 * (dossier renomme a la main, cle recopiee d'une autre machine), l'installeur
 * ecrirait ailleurs — typiquement sur C:, parce que c'est le defaut.
 *
 * On ne repare rien ici : l'app n'a generalement pas le droit d'ecrire dans son
 * propre dossier d'installation (Program Files), et une app qui reecrit sa propre
 * cle de registre est un risque superieur au benefit. On explique, on propose de
 * relancer l'installeur, et on ne laisse pas partir une mise a jour dont la cible
 * est incertaine.
 */
function updateTargetCheck() {
  const install = installLayout.currentInstall({ app });
  const record = installLayout.readInstallMetadata(install, log);
  const description = installLayout.describeInstall({
    install,
    record: record.record,
    registry: lastRegistryInfo,
    shortcuts: [],
  });

  if (!app.isPackaged) return { ok: true, skipped: 'not-packaged' };
  if (installLayout.needsRepair(description)) {
    return { ok: false, reason: 'unverified', description };
  }
  if (description.registry.agrees === false) {
    return { ok: false, reason: 'registry-mismatch', description };
  }
  return { ok: true, installDir: install.installDir, description };
}

function installUpdate() {
  if (!pendingUpdate || !canSelfUpdate()) return;

  const target = updateTargetCheck();
  if (!target.ok) {
    log('update', `installation non verifiee (${target.reason}) : update propose mais non applique`);
    const { response } = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      title: t('update.targetTitle'),
      message: t('update.targetMessage'),
      detail: t('update.targetDetail', {
        install: target.description.installDir,
        recorded: target.description.expectedInstallPath || '—',
        registry: target.description.registry.paths.join(' | ') || '—',
      }),
      buttons: [t('update.targetLater'), t('update.targetInstallAnyway'), t('about.copy')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });

    if (response === 2) clipboard.writeText(JSON.stringify(target.description, null, 2));
    if (response !== 1) return;
    log('update', 'installation forcee par l’utilisateur malgre le doute sur la cible');
  }

  log('update', `installation de ${pendingUpdate} dans ${target.installDir || 'cible inconnue'}`);
  isQuitting = true; // sinon le close-to-tray empecherait le redemarrage
  updater().quitAndInstall();
}

// ---------------------------------------------------------------------------
// Barre de menus et "A propos"
// ---------------------------------------------------------------------------

/**
 * Fenetre "A propos". Les versions y sont copiables d'un clic : c'est la
 * premiere chose qu'on demande dans un rapport de bug, et personne ne sait les
 * retrouver autrement.
 */
async function showAbout() {
  const details = [
    `Soocial ${app.getVersion()}`,
    `Electron ${process.versions.electron}`,
    `Chromium ${process.versions.chrome}`,
    `Node ${process.versions.node}`,
    `${process.platform} ${process.arch}`,
  ].join('\n');

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: t('menu.help.about'),
    message: `Soocial ${app.getVersion()}`,
    detail: `${t('about.tagline')}\n\n${details}`,
    buttons: [t('about.close'), t('about.copy'), t('about.repo')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    icon: nativeImage.createFromPath(ICON_PATH),
  });

  if (response === 1) clipboard.writeText(details);
  if (response === 2) shell.openExternal(REPO_URL);
}

function checkForUpdatesManually() {
  // Dans le paquet Store, "verifier les mises a jour" n'a pas de sens cote app :
  // on renvoie vers la fiche produit, seule surface qui puisse en installer une.
  if (isStore) {
    shell.openExternal(STORE_URL);
    return;
  }

  if (!app.isPackaged) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: t('update.title'),
      message: t('update.devMessage'),
      detail: t('update.devDetail'),
      buttons: [t('about.close')],
    });
    return;
  }

  if (pendingUpdate) return installUpdate();

  log('update', 'verification manuelle');
  updater()
    .checkForUpdates()
    .then((result) => {
      if (result?.updateInfo?.version === app.getVersion()) {
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: t('update.title'),
          message: t('update.currentMessage'),
          detail: t('update.currentDetail', { version: app.getVersion() }),
          buttons: [t('about.close')],
        });
      }
    })
    .catch((err) =>
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: t('update.title'),
        message: t('update.failedMessage'),
        detail: err.message,
        buttons: [t('about.close')],
      })
    );
}

/**
 * "Verifier les mises a jour" depuis la page Reglages. La version menu existait
 * deja ; la difference est qu'elle rend un etat au renderer au lieu d'afficher sa
 * propre boite : la page doit pouvoir dire "deja a jour" sans clignoter.
 */
async function checkForUpdatesFromSettings() {
  if (isStore) return { state: 'store', detail: t('update.storeDetail') };
  if (!app.isPackaged) return { state: 'dev', detail: t('update.devDetail') };
  if (pendingUpdate) return { state: 'ready', version: pendingUpdate };

  try {
    const result = await updater().checkForUpdates();
    const latest = result?.updateInfo?.version;
    if (!latest || latest === app.getVersion()) return { state: 'current', version: app.getVersion() };
    return { state: 'available', version: latest };
  } catch (err) {
    log('update', `verification depuis les reglages : ${err.message}`);
    return { state: 'error', detail: err.message };
  }
}

/**
 * Menu de l'app (popup).
 *
 * Piege a eviter : les raccourcis de l'app sont geres par before-input-event,
 * qui fonctionne meme quand le focus est dans un service. Si le menu les
 * enregistrait AUSSI, chaque frappe serait traitee deux fois — un Ctrl+Shift+I
 * qui ouvre puis referme les DevTools, par exemple. D'ou `registerAccelerator:
 * false` : le raccourci s'affiche dans le menu, mais n'est pas capte par lui.
 */
function appMenuTemplate() {
  const shown = (accelerator) => ({ accelerator, registerAccelerator: false });
  const active = () => views.get(activeId);

  const preference = store.get('language');

  return [
    {
      label: t('menu.file'),
      submenu: [
        {
          label: t('menu.file.new'),
          ...shown('CommandOrControl+N'),
          click: () => send('hub:new-service', {}),
        },
        { type: 'separator' },
        // La langue est un reglage, pas une rubrique d'aide. Elle se choisit a
        // l'onboarding puis se change ici.
        {
          label: t('menu.language'),
          submenu: [
            {
              label: t('menu.language.system'),
              type: 'radio',
              checked: preference === 'system',
              click: () => setLanguage('system'),
            },
            { type: 'separator' },
            ...i18n.AVAILABLE.map((code) => ({
              label: LANGUAGE_NAMES[code] || code,
              type: 'radio',
              checked: preference === code,
              click: () => setLanguage(code),
            })),
          ],
        },
        {
          label: t('menu.file.spellcheck'),
          type: 'checkbox',
          checked: store.get('spellcheck') !== false,
          click: () => {
            store.set('spellcheck', store.get('spellcheck') === false);
            applySpellcheckerEverywhere();
          },
        },
        { type: 'separator' },
        // Lancement avec Windows. Dans le paquet MSIX le reglage appartient a
        // Windows (extension StartupTask du manifeste) : l'app ne peut ni le
        // lire ni le basculer sans module natif WinRT, elle ouvre donc la page
        // qui le porte. Une case a cocher y mentirait sur son propre etat.
        ...(isStore
          ? [
              {
                label: t('menu.file.autostartSettings'),
                click: () => shell.openExternal('ms-settings:startupapps'),
              },
            ]
          : [
              {
                label: t('menu.file.autostart'),
                type: 'checkbox',
                checked: Boolean(store.get('autostart')),
                click: () => {
                  store.set('autostart', !store.get('autostart'));
                  applyAutostart();
                },
              },
              {
                label: t('menu.file.autostartHidden'),
                type: 'checkbox',
                enabled: Boolean(store.get('autostart')),
                checked: Boolean(store.get('autostartHidden')),
                click: () => {
                  store.set('autostartHidden', !store.get('autostartHidden'));
                  applyAutostart();
                },
              },
            ]),
        { type: 'separator' },
        {
          label: t('menu.file.lock'),
          ...shown('CommandOrControl+L'),
          enabled: hasPin() && !locked,
          click: () => lockApp('menu'),
        },
        {
          label: t('menu.file.lockMenu'),
          submenu: [
            {
              label: hasPin() ? t('menu.file.lockChange') : t('menu.file.lockSet'),
              click: () => send('hub:lock-setup', { mode: hasPin() ? 'change' : 'set' }),
            },
            {
              label: t('menu.file.lockRemove'),
              enabled: hasPin(),
              click: () => send('hub:lock-setup', { mode: 'remove' }),
            },
            { type: 'separator' },
            {
              label: t('menu.file.lockOnSuspend'),
              type: 'checkbox',
              enabled: hasPin(),
              checked: store.get('lock')?.onSuspend !== false,
              click: () => {
                store.set('lock.onSuspend', store.get('lock')?.onSuspend === false);
              },
            },
            {
              label: t('menu.file.lockIdle'),
              submenu: [0, 5, 15, 30].map((minutes) => ({
                label: minutes ? t('menu.file.lockIdleAfter', { minutes }) : t('form.sleep.never'),
                type: 'radio',
                enabled: hasPin(),
                checked: (Number(store.get('lock')?.idleMinutes) || 0) === minutes,
                click: () => store.set('lock.idleMinutes', minutes),
              })),
            },
          ],
        },
        { type: 'separator' },
        {
          // "(actif)" dans le libelle : un sous-menu ne porte pas de coche, et
          // c'est la seule trace de l'etat une fois le menu referme.
          label: dndActive() ? t('dnd.menuOn') : t('dnd.menu'),
          submenu: dndMenuTemplate(),
        },
        { type: 'separator' },
        { label: t('menu.file.hide'), click: () => mainWindow?.hide() },
        { label: t('menu.file.quit'), ...shown('CommandOrControl+Q'), click: quitApp },
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.edit.undo') },
        { role: 'redo', label: t('menu.edit.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.edit.cut') },
        { role: 'copy', label: t('menu.edit.copy') },
        { role: 'paste', label: t('menu.edit.paste') },
        { role: 'selectAll', label: t('menu.edit.selectAll') },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        {
          label: t('menu.view.reload'),
          ...shown('CommandOrControl+R'),
          click: () => active()?.view.webContents.reload(),
        },
        {
          label: t('menu.view.hardReload'),
          ...shown('CommandOrControl+Shift+R'),
          click: () => {
            const entry = active();
            if (!entry) return;
            entry.view.webContents.session
              .clearCache()
              .then(() => entry.view.webContents.reloadIgnoringCache());
          },
        },
        { type: 'separator' },
        {
          label: t('menu.view.splitClose'),
          enabled: Boolean(splitId),
          click: () => closeSplit('menu'),
        },
        { type: 'separator' },
        {
          label: t('menu.view.mixer'),
          accelerator: 'CommandOrControl+M',
          click: () => send('hub:open-mixer', {}),
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.view.fullscreen') },
        {
          label: t('menu.view.devtoolsService'),
          ...shown('CommandOrControl+Shift+I'),
          click: () => active()?.view.webContents.toggleDevTools(),
        },
        {
          label: t('menu.view.devtoolsSidebar'),
          ...shown('CommandOrControl+,'),
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
      ],
    },
    {
      label: t('menu.services'),
      submenu: orderedServices().map((service, index) => ({
        label: hibernated.has(service.id)
          ? t('tray.sleeping', { name: service.name })
          : service.name,
        ...(index < 9 ? shown(`CommandOrControl+${index + 1}`) : {}),
        click: () => showService(service.id),
      })),
    },
    {
      label: t('menu.help'),
      submenu: [
        {
          label: isStore ? t('menu.help.storePage') : t('menu.help.updates'),
          click: checkForUpdatesManually,
        },
        { type: 'separator' },
        { label: t('menu.help.docs'), click: () => shell.openExternal(`${REPO_URL}#readme`) },
        { label: t('menu.help.issue'), click: () => shell.openExternal(`${REPO_URL}/issues/new`) },
        { label: t('menu.help.source'), click: () => shell.openExternal(REPO_URL) },
        { type: 'separator' },
        { label: t('menu.help.about'), click: showAbout },
      ],
    },
  ];

}

// Les langues s'affichent dans leur propre langue : un francophone perdu dans
// une interface anglaise doit reconnaitre "Francais" sans le traduire.
const LANGUAGE_NAMES = { en: 'English', fr: 'Français', es: 'Español' };

/**
 * Change la langue a chaud, sans rien recharger. Menus et tray sont reconstruits
 * ici ; la barre laterale recoit le nouveau dictionnaire et retraduit sur place.
 * Les services, eux, ne bougent pas.
 */
function setLanguage(preference) {
  store.set('language', preference);
  const applied = i18n.setLanguage(preference === 'system' ? null : preference);
  log('i18n', `langue : ${preference} -> ${applied}`);

  refreshTrayMenu();
  refreshTrayTooltip();
  applySpellcheckerEverywhere(); // la langue de correction suit celle de l'interface
  send('hub:language', { strings: i18n.dict(), language: applied, preference });
}

// ---------------------------------------------------------------------------
// Fenetre principale (son webContents = la sidebar)
// ---------------------------------------------------------------------------

let saveStateTimer = null;

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const maximized = mainWindow.isMaximized();
  // En maximise, getBounds() renvoie la taille plein ecran : on garde les
  // dernieres dimensions "normales" pour la restauration.
  const bounds = maximized ? store.get('window') : mainWindow.getBounds();
  store.set('window', {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    maximized,
  });
}

function scheduleSaveWindowState() {
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(saveWindowState, 400);
}

/**
 * Theme effectif. 'system' delegue a Windows : c'est `nativeTheme.themeSource` qui
 * fait la delegation, l'app ne lit pas le registre. Un ecart entre les deux (un
 * theme force en dur, par exemple) se voit immediatement des qu'un service est en
 * theme sombre et la sidebar en theme clair.
 */
function effectiveTheme() {
  const preference = store.get('theme') || 'system';
  if (preference === 'light' || preference === 'dark') return preference;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function applyTheme() {
  const preference = store.get('theme') || 'system';
  nativeTheme.themeSource = preference === 'system' ? 'system' : preference;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(effectiveTheme() === 'light' ? '#f4f5fb' : '#16161f');
  }
  send('hub:theme', { theme: effectiveTheme(), preference });
}

// Windows ne connait qu'un seul etat de fenetre a la fois ; le renderer, qui
// dessine maintenant les boutons, doit le suivre pour que le bouton du milieu
// affiche agrandir ou restituer, et pour que le survol ne mente pas.
function sendWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  send('hub:window-state', {
    maximized: mainWindow.isMaximized(),
    minimized: mainWindow.isMinimized(),
    fullScreen: mainWindow.isFullScreen() || mainWindow.isSimpleFullScreen(),
    focused: mainWindow.isFocused(),
    visible: mainWindow.isVisible(),
    alwaysOnTop: mainWindow.isAlwaysOnTop(),
  });
}

/**
 * Les trois boutons de la barre de titre. Rien d'autre : le main reste seul a
 * decider de ce que "fermer" veut dire (tray ou quitter), parce que la reponse
 * depend d'un reglage et de l'etat de sortie, deux choses que le renderer ne peut
 * pas connaitre sans ouvrit une porte plus large qu'un bouton.
 */
function applyWindowControl(action) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  switch (action) {
    case 'minimize':
      if (store.get('minimizeToTray')) {
        saveWindowState();
        mainWindow.hide();
        log('window', 'reduite dans le tray (reglage)');
      } else {
        mainWindow.minimize();
      }
      break;
    case 'maximize':
      // Le geste du bouton du milieu est un bascule, comme sur les trois
      // plateformes : deux methodes distinctes obligeraient a deviner l'etat.
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
      break;
    case 'restore':
      mainWindow.unmaximize();
      break;
    case 'close':
      if (store.get('closeToTray') === false) quitApp();
      else {
        saveWindowState();
        mainWindow.hide();
      }
      break;
    case 'fullscreen':
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      break;
    case 'toggle-top':
      mainWindow.setAlwaysOnTop(!mainWindow.isAlwaysOnTop());
      break;
    case 'menu':
      showTitleBarMenu();
      break;
    default:
      log('window', `action inconnue ignoree : ${action}`);
  }

  sendWindowState();
}

/**
 * Le menu de la barre de titre : le meme contenu que l'ancien menu applicatif,
 * en popup. Un popup n'occupe aucune hauteur de fenetre, ce qui est exactement la
 * raison pour laquelle il le remplace ici.
 */
function showTitleBarMenu() {
  const menu = Menu.buildFromTemplate(appMenuTemplate());
  menu.popup({ window: mainWindow });
}

/** Contexte lu a chaque operation de stockage : les reglages sont editables a chaud. */
function storageContext() {
  return {
    downloadsDir: store.get('downloads') || ROOTS.downloadsDefault,
    defaultDir: ROOTS.downloadsDefault,
    askWhere: Boolean(store.get('askWhereToSave')),
    dataDir: ROOTS.data,
    cacheDir: ROOTS.cache,
  };
}

/** Snapshot de reglages pour la page Settings (aucun champ secret n'y transit). */
function settingsSnapshot() {
  const install = installLayout.currentInstall({ app });
  const record = installLayout.readInstallMetadata(install, log);

  return {
    theme: store.get('theme') || 'system',
    glass: store.get('glass') || 'soft',
    animations: store.get('animations') || 'full',
    sidebarCollapsed: Boolean(store.get('sidebarCollapsed')),
    closeToTray: store.get('closeToTray') !== false,
    minimizeToTray: Boolean(store.get('minimizeToTray')),
    autostart: Boolean(store.get('autostart')),
    autostartHidden: Boolean(store.get('autostartHidden')),
    spellcheck: store.get('spellcheck') !== false,
    language: store.get('language') || 'system',
    languageAvailable: i18n.AVAILABLE,
    downloads: store.get('downloads') || null,
    downloadsDefault: ROOTS.downloadsDefault,
    askWhereToSave: Boolean(store.get('askWhereToSave')),
    dnd: dndState(),
    hasLock: hasPin(),
    hardwareAcceleration: store.get('hardwareAcceleration') !== false,
    metrics: metrics.metricsForRenderer({ collapsed: Boolean(store.get('sidebarCollapsed')) }),
    install: installLayout.describeInstall({
      install,
      record: record.record,
      registry: lastRegistryInfo,
      shortcuts: installLayout.checkShortcuts(record.record, install.installDir),
    }),
    storage: storageLayout.describe({ store, roots: ROOTS }),
    version: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    packaged: app.isPackaged,
    isStoreBuild: isStore,
    firstLaunchAt: store.get('firstLaunchAt') || null,
    // La barre de titre et la page Reglages affichent le meme etat : un champ
    // separe aurait voulu dire deux sources de verite.
    update: pendingUpdate ? { state: 'ready', version: pendingUpdate } : null,
    productName: PRODUCT.name,
  };
}


function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (pendingMaximize) {
    pendingMaximize = false;
    mainWindow.maximize(); // maximize() affiche la fenetre
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Enregistre (ou retire) le lancement automatique aupres de Windows. En dev,
 * openAtLogin enregistrerait electron.exe : le reglage est stocke mais seule
 * l'app installee l'applique.
 */
function applyAutostart() {
  // Dans un paquet MSIX, setLoginItemSettings ecrit sous HKCU\...\Run, une ruche
  // virtualisee vers le conteneur du paquet. Windows ne la lit pas a l'ouverture
  // de session : l'appel reussit, le reglage est memorise, et rien ne demarre
  // jamais. C'est l'extension StartupTask du manifeste qui fait foi, et seul
  // l'utilisateur peut l'activer (Parametres > Applications > Demarrage).
  if (isStore) {
    log('autostart', 'delegue a Windows (extension StartupTask du manifeste MSIX)');
    return;
  }

  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: Boolean(store.get('autostart')),
    args: store.get('autostartHidden') ? ['--hidden'] : [],
  });
  log('autostart', `${store.get('autostart') ? 'actif' : 'inactif'}${store.get('autostartHidden') ? ' (masque)' : ''}`);
}

function createWindow() {
  const saved = store.get('window');

  const theme = effectiveTheme();

  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: theme === 'light' ? '#f4f5fb' : '#16161f',
    show: false,
    icon: ICON_PATH,
    // Fenetre sans cadre OS : la barre de titre est dessinee par le renderer
    // (boutons a la mac, a gauche). `thickFrame` reste a sa valeur par defaut,
    // c'est ce qui conserve sous Windows l'ombre, les bordures redimensionnables
    // et l'apercu de placement (Win+ fleches, glisser en bord d'ecran).
    //
    // Le menu applicatif est retire, pas masque : avec une barre de titre
    // personnelle, un menu barre se glisserait ENTRE elle et la zone de service,
    // et aucune API Electron n'expose sa hauteur pour le recalculer. Les memes
    // commandes restent atteignables par le bouton du titre, le tray, les menus
    // contextuels et les raccourcis - et le raccourci d'un element sans menu
    // applicatif ne disparait pas, il est traite dans before-input-event.
    frame: false,
    transparent: false,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('before-input-event', handleShortcut);

  mainWindow.once('ready-to-show', () => {
    if (startHidden) {
      pendingMaximize = saved.maximized;
      log('window', 'demarrage masque dans la zone de notification (--hidden)');
    } else {
      if (saved.maximized) mainWindow.maximize();
      mainWindow.show();
    }

    const services = orderedServices();
    if (!services.length) {
      log('services', 'aucun service configure');
      if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
      return;
    }

    // Dernier service actif au relancement (ou le premier de la liste).
    const lastId = store.get('lastActiveId');
    const startId = services.some((s) => s.id === lastId) ? lastId : services[0].id;
    showService(startId);

    // La vue partagee survit au redemarrage : elle etait visible, elle revient.
    const savedSplit = store.get('splitId');
    if (savedSplit && savedSplit !== startId && getService(savedSplit)) setSplit(savedSplit);
    else if (savedSplit) store.set('splitId', null);

    // Les autres services sont charges en arriere-plan, en quinconce : sans ca
    // leurs badges et leurs notifications ne remonteraient qu'apres un premier
    // clic sur leur icone.
    let delay = PRELOAD_STAGGER_MS;
    for (const service of services) {
      if (service.id === startId) continue;

      if (service.preload === false) {
        log('preload', `${service.id} ignore (chargement a la demande)`);
        hibernated.add(service.id);
        send('hub:status', { id: service.id, status: 'hibernated' });
        continue;
      }

      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed() || views.has(service.id)) return;
        log('preload', service.id);
        createServiceView(service);
      }, delay);
      delay += PRELOAD_STAGGER_MS;
    }

    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('resize', () => {
    layoutViews();
    scheduleSaveWindowState();
  });
  mainWindow.on('move', scheduleSaveWindowState);
  mainWindow.on('maximize', () => {
    layoutViews();
    saveWindowState();
    sendWindowState();
  });
  mainWindow.on('unmaximize', () => {
    layoutViews();
    saveWindowState();
    sendWindowState();
  });
  mainWindow.on('enter-full-screen', () => {
    layoutViews();
    sendWindowState();
  });
  mainWindow.on('leave-full-screen', () => {
    layoutViews();
    sendWindowState();
  });
  mainWindow.on('focus', sendWindowState);
  mainWindow.on('blur', sendWindowState);
  mainWindow.on('minimize', sendWindowState);
  mainWindow.on('restore', sendWindowState);

  // Le X de la barre personnalisee suit le reglage, pas une decision imposee :
  // "fermer = cacher" est ce qu'on attend d'un hub de messagerie, mais un
  // utilisateur qui veut vraiment quitter doit pouvoir l'obtenir.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    if (store.get('closeToTray') === false) {
      quitApp();
      return;
    }
    event.preventDefault();
    saveWindowState();
    mainWindow.hide();
    log('window', 'fermeture interceptee -> minimise dans le tray');
  });

  mainWindow.on('closed', () => {
    for (const entry of views.values()) {
      clearTimeout(entry.timer);
      clearTimeout(entry.hibernateTimer);
    }
    views.clear();
    mainWindow = null;
  });
}

function quitApp() {
  log('app', 'quit demande');
  isQuitting = true;
  saveWindowState();
  app.quit();
}

// ---------------------------------------------------------------------------
// Creation / edition / suppression de services
// ---------------------------------------------------------------------------

/** Payload envoye a la sidebar : tout ce qu'il faut pour afficher et editer. */
/** Service proprietaire d'un webContents (vue de service, popup, ou sidebar). */
function serviceIdOfWebContents(webContents) {
  if (!webContents || webContents.isDestroyed()) return null;
  for (const [id, entry] of views) {
    if (entry.view.webContents === webContents) return id;
  }
  return null;
}

/**
 * Notification emise par l'app elle-meme (telechargement deplace, installation a
 * reparer). Les notifications des services, elles, viennent des pages et ne
 * passent pas ici.
 *
 * `isQuitting` importe : une notification postee pendant la fermeture arrive dans
 * un procesus a moitie detruit, et Windows la montre orpheline.
 */
function notifyApp(title, body, options = {}) {
  if (!title || isQuitting) return null;
  try {
    const notification = new Notification({
      title: String(title).slice(0, 120),
      body: String(body || '').slice(0, 400),
      icon: ICON_PATH,
      silent: true,
      ...options,
    });
    if (options.target) {
      notification.on('click', () => shell.showItemInFolder(options.target));
    }
    notification.show();
    return notification;
  } catch (err) {
    // Une notification qui echoue ne doit jamais couter l'application : sous
    // Windows, l'AppUserModelID absent (app en dev) fait lever ici.
    log('notify', `ignoree : ${err.message}`);
    return null;
  }
}

function serviceForRenderer(service) {
  return {
    id: service.id,
    name: service.name,
    url: service.url,
    color: service.color,
    initials: service.initials,
    spoofUserAgent: Boolean(service.spoofUserAgent),
    preload: service.preload !== false,
    hibernateAfter: Number(service.hibernateAfter) || 0,
    muted: isMuted(service.id),
    volume: volumeOf(service.id),
    hibernating: hibernated.has(service.id),
    protected: isProtected(service.id),
    favorite: (store.get('favorites') || []).includes(service.id),
    ...resolveIcon(service),
  };
}

function broadcastServices() {
  send('hub:services', { services: orderedServices().map(serviceForRenderer) });
  refreshTrayMenu();
}

function normalizeUrl(raw) {
  const value = (raw || '').trim();
  if (!value) return null;
  // Saisir "web.whatsapp.com" doit marcher : sans schema, new URL() echoue et le
  // service ne chargerait jamais.
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    return null;
  }
}

/**
 * Cree ou met a jour un service. Retourne { ok } ou { error } — le renderer
 * affiche le message tel quel dans le formulaire.
 */
function saveService(draft) {
  const name = (draft.name || '').trim();
  const url = normalizeUrl(draft.url);

  if (!name) return { error: t('error.nameRequired') };
  if (!url) return { error: t('error.urlInvalid') };

  const services = allServices();
  const existing = draft.id ? services.find((service) => service.id === draft.id) : null;
  if (draft.id && !existing) return { error: t('error.serviceGone') };

  const settings = {
    name,
    url,
    color: /^#[0-9a-f]{6}$/i.test(draft.color || '') ? draft.color : '#45475a',
    initials: (draft.initials || name).trim().slice(0, 4).toUpperCase(),
    spoofUserAgent: Boolean(draft.spoofUserAgent),
    preload: draft.preload !== false,
    hibernateAfter: Math.max(0, Number(draft.hibernateAfter) || 0),
  };

  if (existing) {
    const urlChanged = existing.url !== settings.url;
    const spoofChanged = existing.spoofUserAgent !== settings.spoofUserAgent;

    const updated = services.map((service) =>
      service.id === existing.id ? { ...service, ...settings } : service
    );
    store.set('services', updated);
    log('services', `${existing.id} modifie`);

    const entry = views.get(existing.id);
    if (entry) {
      entry.service = withDefaults({ ...existing, ...settings });
      // L'UA est porte par la session : il faut le rejouer avant de recharger,
      // sinon la page repart avec l'ancienne identite.
      if (spoofChanged) applySessionUserAgent(entry.service);
      if (urlChanged || spoofChanged) loadService(entry);
    }
  } else {
    const taken = new Set(services.map((service) => service.id));
    let id = slugify(name);
    for (let n = 2; taken.has(id); n++) id = `${slugify(name)}-${n}`;

    const service = withDefaults({
      id,
      partition: `persist:${id}`, // partition dediee => session etanche des la creation
      ...settings,
    });

    store.set('services', [...services, service]);
    store.set('order', [...(store.get('order') || []), id]);
    log('services', `${id} cree (${settings.url})`);
  }

  broadcastServices();
  return { ok: true };
}

async function deleteService(id) {
  const service = getService(id);
  if (!service) return { error: t('error.serviceMissing') };

  const { response, checkboxChecked } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: [t('delete.cancel'), t('delete.confirm')],
    defaultId: 0,
    cancelId: 0,
    title: t('delete.title'),
    message: t('delete.message', { name: service.name }),
    detail: t('delete.detail'),
    checkboxLabel: t('delete.checkbox'),
    checkboxChecked: false,
  });

  if (response !== 1) return { ok: false };

  // La vue doit mourir avant la config : sinon elle continue de tourner sans
  // service correspondant.
  const entry = views.get(id);
  if (entry) {
    clearTimeout(entry.timer);
    clearTimeout(entry.hibernateTimer);
    mainWindow?.contentView.removeChildView(entry.view);
    entry.view.webContents.close();
    views.delete(id);
  }
  hibernated.delete(id);
  iconCache.delete(id);

  store.set(
    'services',
    allServices().filter((service) => service.id !== id)
  );
  store.set('order', (store.get('order') || []).filter((entryId) => entryId !== id));

  for (const key of ['icons', 'muted', 'protected']) {
    const map = { ...store.get(key) };
    delete map[id];
    store.set(key, map);
  }
  unlockedIds.delete(id);

  if (checkboxChecked) {
    await session.fromPartition(service.partition).clearStorageData();
    log('services', `${id} : donnees de session effacees`);
  }

  log('services', `${id} supprime`);

  if (splitId === id) {
    setSplitId(null);
    layoutViews();
  }

  if (activeId === id) {
    activeId = null;
    const next = orderedServices()[0];
    if (next) showService(next.id);
  }

  broadcastServices();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// IPC sidebar -> main
// ---------------------------------------------------------------------------

ipcMain.handle('hub:bootstrap', () => ({
  services: orderedServices().map(serviceForRenderer),
  activeId,
  splitId,
  version: app.getVersion(),
  onboarding: needsOnboarding(),
  locked,
  // Le service actif peut deja attendre son code (relancement de l'app).
  activeNeedsCode: needsCode(activeId),
  // Decoupage courant : position du separateur, taille de la part active.
  layout: lastLayout,
  // Le renderer est sandboxe : il ne lit pas les fichiers de langue, il recoit
  // le dictionnaire deja resolu.
  strings: i18n.dict(),
  language: i18n.current(),
  languagePreference: store.get('language'),
  // iconKey identifie la vignette de chaque entree : le domaine, sauf quand une
  // source est declaree (deux produits Google partagent mail.google.com).
  catalog: CATALOG.map((entry) => ({ ...entry, iconKey: catalogIcons.keyOf(entry) })),
  catalogIcons: catalogIcons.known(),
  update: pendingUpdate ? { state: 'ready', version: pendingUpdate } : null,
  masterVolume: masterVolume(),
  dnd: dndState(),
  // Base servant a composer l'icone du tray avec le compteur par-dessus.
  trayBase: nativeImage.createFromPath(ICON_PATH).resize({ width: 64, height: 64 }).toDataURL(),
  // Dimensions : le renderer les pose en variables CSS. C'est la seule facon de
  // garder la barre laterale et les vues natives alignes sans chiffres en double.
  metrics: metrics.metricsForRenderer({ collapsed: Boolean(store.get('sidebarCollapsed')) }),
  // Les reglages arrivent avec la premiere trame : ouvrir la page Reglages ne
  // doit jamais afficher un instant de valeurs par defaut avant les vraies.
  settings: settingsSnapshot(),
  favorites: store.get('favorites') || [],
  lastPage: store.get('lastPage') || null,
  theme: effectiveTheme(),
  productName: PRODUCT.name,
  tagline: t('about.tagline'),
}));

ipcMain.on('hub:set-volume', (_e, { id, value } = {}) => {
  if (getService(id)) setVolume(id, value);
});

ipcMain.on('hub:set-master-volume', (_e, value) => setMasterVolume(value));

// Menu natif du bouton lune : memes options que le menu Fichier et le tray.
ipcMain.on('hub:dnd-menu', () => {
  Menu.buildFromTemplate(dndMenuTemplate()).popup({ window: mainWindow });
});

ipcMain.handle('hub:service-save', (_e, draft) => saveService(draft || {}));
ipcMain.handle('hub:service-delete', (_e, id) => deleteService(id));

/** Tentative de deverrouillage depuis l'ecran de code. */
ipcMain.handle('hub:unlock', (_e, pin) => {
  if (!locked) return { ok: true };
  if (!verifyPin(pin)) {
    log('lock', 'code errone');
    return { error: t('lock.wrong') };
  }
  unlockApp();
  return { ok: true };
});

/** Deverrouillage d'un seul service protege, depuis son ecran de code. */
ipcMain.handle('hub:unlock-service', (_e, { id, pin } = {}) => {
  if (!needsCode(id)) return { ok: true };
  if (!verifyServiceCode(id, pin)) {
    log('lock', `${id} : code errone`);
    return { error: t('lock.wrong') };
  }

  unlockedIds.add(id);
  log('lock', `${id} : deverrouille`);
  applyViewVisibility();

  const entry = views.get(id);
  if (entry && entry.status !== 'error' && id === activeId) entry.view.webContents.focus();
  return { ok: true };
});

/**
 * Activation / desactivation de la protection d'un service, depuis le bouton
 * de son formulaire. L'activation CREE le code du service (deux saisies) ; la
 * desactivation exige ce code et le supprime — reactiver reparti donc sur un
 * code neuf, et chaque service a le sien.
 */
ipcMain.handle('hub:service-protect', (_e, draft) => {
  const { id, enable } = draft || {};
  const service = getService(id);
  if (!service) return { error: t('error.serviceMissing') };

  if (enable) {
    if ((draft.next || '').length < 4) return { error: t('lock.errorShort') };
    if (draft.next !== draft.confirm) return { error: t('lock.errorMismatch') };

    const salt = crypto.randomBytes(16).toString('hex');
    setProtection(id, { hash: hashPin(draft.next, salt), salt });
  } else {
    if (!verifyServiceCode(id, draft.code)) {
      log('lock', `${id} : code errone (desactivation)`);
      return { error: t('lock.wrong') };
    }
    setProtection(id, null); // le code du service disparait avec la protection
  }

  applyViewVisibility();
  if (id === activeId) send('hub:active', { id, needsCode: needsCode(id) });
  broadcastServices(); // le drapeau protected des services a change

  return { ok: true, protected: Boolean(enable) };
});

/** Definition, changement ou suppression du code, depuis le formulaire dedie. */
ipcMain.handle('hub:lock-config', (_e, draft) => {
  const { mode, current, next, confirm } = draft || {};

  // Toute modification exige le code en place : le formulaire ne suffit pas.
  if (hasPin() && !verifyPin(current)) return { error: t('lock.errorCurrent') };

  if (mode === 'remove') {
    store.set('lock', { ...store.get('lock'), hash: null, salt: null });
    log('lock', 'code supprime');
    return { ok: true };
  }

  if ((next || '').length < 4) return { error: t('lock.errorShort') };
  if (next !== confirm) return { error: t('lock.errorMismatch') };

  const salt = crypto.randomBytes(16).toString('hex');
  store.set('lock', { ...store.get('lock'), hash: hashPin(next, salt), salt });
  log('lock', 'code defini');

  // Un service protege actuellement affiche ne se verrouille pas sous les yeux
  // de celui qui vient de definir le code : il s'armera au prochain verrouillage.
  for (const id of [activeId, splitId]) {
    if (id && store.get('protected')?.[id]) unlockedIds.add(id);
  }

  return { ok: true };
});

/**
 * Fin d'onboarding : cree les services choisis dans l'ordre du clic, puis
 * demarre comme un lancement normal (premier service affiche, les autres
 * precharges en quinconce).
 */
ipcMain.handle('hub:onboard-complete', (_e, drafts) => {
  const picks = Array.isArray(drafts) ? drafts : [];

  for (const draft of picks) {
    const result = saveService(draft);
    if (result.error) log('onboarding', `"${draft?.name}" ignore : ${result.error}`);
  }

  store.set('onboarded', true);

  const services = orderedServices();
  log('onboarding', `termine : ${services.length} service(s)`);

  if (services.length) {
    showService(services[0].id);

    let delay = PRELOAD_STAGGER_MS;
    for (const service of services.slice(1)) {
      if (service.preload === false) continue;
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed() || views.has(service.id)) return;
        createServiceView(service);
      }, delay);
      delay += PRELOAD_STAGGER_MS;
    }
  }

  return { ok: true, count: services.length };
});

/** Changement de langue, depuis l'onboarding ou le menu Fichier. */
ipcMain.handle('hub:set-language', (_e, preference) => {
  setLanguage(preference);
  return { strings: i18n.dict(), language: i18n.current(), preference: store.get('language') };
});

/** Enregistre un nouvel ordre complet (drag & drop cote sidebar). */
ipcMain.on('hub:reorder', (_e, ids) => {
  const known = new Set(allServices().map((service) => service.id));
  const order = (ids || []).filter((id) => known.has(id));

  // Un ordre partiel signifierait un desaccord entre la sidebar et le store :
  // on prefere ne rien enregistrer plutot que de perdre un service.
  if (order.length !== known.size) {
    log('order', `ordre ignore : ${order.length}/${known.size} services`);
    return;
  }

  store.set('order', order);
  refreshTrayMenu();
  log('order', order.join(' > '));
});

/** Deplacement d'un cran depuis le menu contextuel. */
function moveService(id, delta) {
  const order = orderedServices().map((service) => service.id);
  const index = order.indexOf(id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= order.length) return;

  order.splice(target, 0, order.splice(index, 1)[0]);
  store.set('order', order);
  refreshTrayMenu();
  log('order', `${id} -> position ${target + 1} (${order.join(' > ')})`);
  send('hub:order', { order });
}

// Clic droit sur une icone de la sidebar : menu natif.
/**
 * Icone d'entree de menu. Windows peint ses menus selon le theme du systeme :
 * un jeu unique serait invisible sur l'un des deux fonds, d'ou les deux
 * variantes. createFromPath ramasse le fichier @2x tout seul sur ecran dense.
 */
function menuIcon(name) {
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return nativeImage.createFromPath(path.join(MENU_ICONS_DIR, theme, `${name}.png`));
}

ipcMain.on('hub:service-menu', (_e, id) => {
  const service = getService(id);
  if (!service) return;

  const order = orderedServices();
  const index = order.findIndex((s) => s.id === id);
  const entry = views.get(id);
  const asleep = hibernated.has(id);
  const volume = volumeOf(id);

  const menu = Menu.buildFromTemplate([
    { label: service.name, enabled: false },
    { type: 'separator' },

    // Pas d'icone ici, et c'est delibere : sous Windows une icone posee sur un
    // element a cocher peut prendre la place de la coche. On perdrait la
    // lecture de l'etat, ce que tout le reste cherche justement a rendre
    // visible.
    {
      label: t('ctx.notifications'),
      type: 'checkbox',
      checked: !isMuted(id),
      // On repart de l'etat stocke, pas de item.checked : selon les plateformes
      // le handler recoit la valeur d'avant ou d'apres la bascule, ce qui
      // inversait l'enregistrement.
      click: () => setMuted(id, !isMuted(id)),
    },

    // Un Menu Electron n'accepte pas de curseur : le reglage fin vit dans le
    // melangeur, et le menu offre des paliers. La valeur est dans le libelle
    // pour se lire sans ouvrir le sous-menu.
    {
      label: t('ctx.volumeLabel', { value: volume === 0 ? t('ctx.volumeZero') : `${volume} %` }),
      icon: menuIcon('volume'),
      submenu: [
        ...[100, 75, 50, 25].map((level) => ({
          label: `${level} %`,
          type: 'radio',
          checked: volume === level,
          click: () => setVolume(id, level),
        })),
        {
          label: t('ctx.volumeZero'),
          type: 'radio',
          checked: volume === 0,
          click: () => setVolume(id, 0),
        },
        { type: 'separator' },
        { label: t('ctx.mixer'), click: () => send('hub:open-mixer', { id }) },
      ],
    },
    {
      label: asleep ? t('ctx.sleeping') : t('ctx.sleep'),
      icon: menuIcon('sleep'),
      enabled: Boolean(entry) && id !== activeId && id !== splitId,
      click: () => hibernateService(id, 'demande manuelle'),
    },

    { type: 'separator' },

    // Un service qui attend son code se deverrouille d'abord en vue simple.
    ...(id === splitId
      ? [
          {
            label: t('ctx.splitClose'),
            icon: menuIcon('split-right'),
            click: () => closeSplit('demande manuelle'),
          },
        ]
      : [
          {
            label: t('ctx.split'),
            icon: menuIcon('split-right'),
            enabled: id !== activeId && !needsCode(id),
            click: () => setSplit(id, 'right'),
          },
          {
            label: t('ctx.splitBottom'),
            icon: menuIcon('split-bottom'),
            enabled: id !== activeId && !needsCode(id),
            click: () => setSplit(id, 'bottom'),
          },
          // Fermeture accessible depuis n'importe quelle tuile : chercher LA
          // bonne icone pour arreter la vue partagee etait une chasse au tresor.
          ...(splitId
            ? [{ label: t('menu.view.splitClose'), click: () => closeSplit('demande manuelle') }]
            : []),
        ]),

    { type: 'separator' },

    { label: t('ctx.edit'), icon: menuIcon('edit'), click: () => send('hub:edit-service', { id }) },

    // Ce qu'on fait une fois pour toutes descend d'un cran : l'icone, l'ordre,
    // le rechargement, les outils de developpement. Quatorze entrees au meme
    // niveau mettaient "Outils de developpement" au meme rang que "Modifier".
    {
      label: t('ctx.more'),
      icon: menuIcon('more'),
      submenu: [
        { label: t('ctx.icon'), click: () => chooseIcon(id) },
        { label: t('ctx.iconDefault'), enabled: Boolean(storedIcon(id)), click: () => resetIcon(id) },
        { type: 'separator' },
        { label: t('ctx.up'), enabled: index > 0, click: () => moveService(id, -1) },
        {
          label: t('ctx.down'),
          enabled: index >= 0 && index < order.length - 1,
          click: () => moveService(id, 1),
        },
        { type: 'separator' },
        {
          label: t('ctx.reload'),
          enabled: Boolean(entry),
          click: () => entry?.view.webContents.reload(),
        },
        {
          label: t('ctx.devtools'),
          enabled: Boolean(entry),
          click: () => entry?.view.webContents.toggleDevTools(),
        },
      ],
    },

    { type: 'separator' },

    // Isole en bas : voisine de "Modifier", une action irreversible finit par
    // etre cliquee par erreur.
    { label: t('ctx.delete'), icon: menuIcon('delete'), click: () => deleteService(id) },
  ]);

  menu.popup({ window: mainWindow });
});

// Icone du tray redessinee avec le compteur incruste (composee au canvas cote
// renderer). Sans compteur, on remet le fichier d'origine.
ipcMain.on('hub:tray-icon', (_e, dataUrl) => {
  if (!tray) return;
  tray.setImage(
    dataUrl ? nativeImage.createFromDataURL(dataUrl) : nativeImage.createFromPath(ICON_PATH)
  );
});

// Compteur de non-lus sur l'icone de la barre des taches Windows.
// app.setBadgeCount() n'est pas supporte sous Windows : on passe par une
// "overlay icon", dessinee au canvas cote renderer puis transmise ici.
ipcMain.on('hub:overlay', (_e, { dataUrl, description }) => {
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.setOverlayIcon(
    dataUrl ? nativeImage.createFromDataURL(dataUrl) : null,
    description || ''
  );
});

ipcMain.on('hub:select', (_e, id) => showService(id));
ipcMain.on('hub:install-update', installUpdate);
// Meme action que Ctrl+L ou le menu Fichier, offerte au renderer.
ipcMain.on('hub:lock-now', () => lockApp('demande du renderer'));

// Reglage du separateur au clique-glisse. Pendant le geste les vues sont
// masquees : ce sont des couches natives, la souris leur appartiendrait des
// qu'elle les survole et le glissement s'arreterait net au bord du separateur.
// La sidebar affiche un apercu a la place, et tout revient au relachement.
ipcMain.on('hub:split-drag', (_e, dragging) => {
  if (!splitId || locked) return;
  if (dragging) {
    for (const entry of views.values()) entry.view.setVisible(false);
  } else {
    applyViewVisibility();
  }
});

ipcMain.on('hub:split-ratio', (_e, ratio) => {
  if (typeof ratio === 'number' && Number.isFinite(ratio)) {
    store.set('splitRatio', Math.min(0.8, Math.max(0.2, ratio)));
  }
  layoutViews();
  applyViewVisibility();
});

// La vue du service recouvre toute la zone a droite de la sidebar : un
// formulaire affiche par le renderer serait cache dessous. On escamote donc la
// vue active le temps que la boite de dialogue est ouverte.
ipcMain.on('hub:modal', (_e, open) => {
  if (locked) return; // les vues restent masquees tant que l'ecran de code est la

  if (open) {
    for (const entry of views.values()) entry.view.setVisible(false);
  } else {
    applyViewVisibility();
  }
});

ipcMain.on('hub:retry', (_e, id) => {
  const entry = views.get(id);
  if (entry) loadService(entry);
  else {
    const service = getService(id);
    if (service) createServiceView(service);
  }
});

// ---------------------------------------------------------------------------
// Soocial : fenetre, reglages, stockage
// ---------------------------------------------------------------------------

/**
 * Ce que le registre dit de l'installation. Recupere une fois au demarrage et
 * garde en memoire : `reg.exe` coute une centaine de millisecondes, et la page
 * Reglages s'ouvre souvent. Un desynchronisation avec le disque est signalee,
 * jamais reparer en silence.
 */
let lastRegistryInfo = { available: false, entries: [] };

async function refreshRegistryInfo() {
  try {
    lastRegistryInfo = await installLayout.readRegistryInstall({});
  } catch (err) {
    log('install', `lecture du registre impossible : ${err.message}`);
  }
  return lastRegistryInfo;
}

/**
 * Reglages acceptes depuis le renderer, avec leur type. Une liste blanche et
 * pas une extension : le renderer est sandboxe, mais un reglages qui accepterait
 * n'importe quelle cle accepterait aussi d'ecraser `services`, `lock` ou
 * `partition`. Autant dire que la surface d'ecriture du renderer est exactement
 * ce qui est affiche a l'ecran.
 */
const SETTINGS_WHITELIST = {
  theme: ['system', 'light', 'dark'],
  glass: ['off', 'soft', 'full'],
  animations: ['full', 'reduced', 'off'],
  sidebarCollapsed: 'boolean',
  closeToTray: 'boolean',
  minimizeToTray: 'boolean',
  autostart: 'boolean',
  autostartHidden: 'boolean',
  spellcheck: 'boolean',
  askWhereToSave: 'boolean',
  hardwareAcceleration: 'boolean',
  language: 'language',
};

function applySettingsPatch(patch) {
  if (!patch || typeof patch !== 'object') return { ok: false, error: t('error.settingsBadCall') };

  const applied = [];
  const rejected = [];

  for (const [key, value] of Object.entries(patch)) {
    const rule = SETTINGS_WHITELIST[key];
    if (!rule) {
      rejected.push(key);
      continue;
    }

    if (rule === 'boolean') {
      if (typeof value !== 'boolean') {
        rejected.push(key);
        continue;
      }
      store.set(key, value);
      applied.push(key);
      continue;
    }

    if (rule === 'language') {
      const next = value === 'system' || i18n.AVAILABLE.includes(value) ? value : 'system';
      setLanguagePreference(next);
      applied.push(key);
      continue;
    }

    if (Array.isArray(rule) && !rule.includes(value)) {
      rejected.push(key);
      continue;
    }
    store.set(key, value);
    applied.push(key);
  }

  // Effets de bord, dans l'ordre ou ils ont un sens : le theme avant la
  // translucidite (les deux changent la couleur de fond), l'enregistrement
  // Windows apres son reglage.
  if (applied.includes('theme')) applyTheme();
  if (applied.includes('sidebarCollapsed') || applied.includes('theme')) layoutViews();
  if (applied.includes('autostart') || applied.includes('autostartHidden')) applyAutostart();

  if (rejected.length) log('settings', `champs ignores : ${rejected.join(', ')}`);
  if (applied.length) log('settings', `regles : ${applied.join(', ')}`);

  const snapshot = settingsSnapshot();
  // Le retour de l'appel ne suffit pas : une deuxieme fenetre (ou un reglage ecrit
  // ailleurs, par le tray ou un raccourci) laisserait la page Reglages afficher
  // l'ancienne valeur. Le broadcast est ce qui fait de ces reglages un etat shared,
  // pas une variable locale au composant qui l'a change.
  if (applied.length) send('hub:settings', snapshot);

  return { ok: true, applied, rejected, settings: snapshot };
}

/**
 * Choix d'un dossier. `purpose` est une cle fermee, pas un chemin : le renderer
 * ne dit jamais ou le dialogue s'ouvre, il dit pourquoi.
 */
async function pickDirectory(purpose) {
  const context = storageContext();
  const startPath = purpose === 'downloads' ? context.downloadsDir : ROOTS.data;

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: t('storage.pick'),
    defaultPath: startPath,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };

  if (purpose !== 'downloads') return { ok: true, path: filePaths[0] };

  // Le controle d'ecriture est fait ici, avant de memoriser : un chemin qui
  // n'accepte pas l'ecriture ne doit jamais devenir le reglage par defaut.
  const result = storageLayout.setDownloadsDir({
    store,
    roots: ROOTS,
    candidate: filePaths[0],
    create: true,
  });

  if (!result.ok) {
    log('storage', `dossier refuse (${result.code}) : ${filePaths[0]}`);
    return { ok: false, error: t(rulesErrorKey(result.code)), path: filePaths[0] };
  }

  log('storage', `telechargements : ${result.path}`);
  return { ok: true, path: result.path, created: result.created, settings: settingsSnapshot() };
}

function rulesErrorKey(code) {
  return pathRules.errorKeyFor(code);
}

/**
 * Ouvrir un emplacement sur le disque. Liste fermee la encore : un canal qui
 * prendrait un chemin en parametre serait un `shell.openPath` accessible depuis
 * n'importe quelle page web chargee dans un service.
 */
async function openLocation(kind) {
  const targets = {
    downloads: store.get('downloads') || ROOTS.downloadsDefault,
    data: ROOTS.data,
    cache: ROOTS.cache,
    install: path.dirname(app.getPath('exe')),
  };
  const target = targets[kind];
  if (!target) return { ok: false, error: t('error.locationUnknown') };

  // Creer le dossier avant de l'ouvrir : "Ouvrir le dossier" sur un dossier qui
  // n'a jamais contenu grand-chose doit fonctionner quand meme.
  if (kind === 'downloads') storageLayout.probeDirectory(target, { create: true });

  const error = await shell.openPath(target);
  if (error) {
    log('storage', `ouverture impossible (${kind}) : ${error}`);
    return { ok: false, error };
  }
  return { ok: true, path: target };
}

/**
 * Bloc de diagnostic. Copiable en entier parce que c'est la premiere chose
 * demandee dans un rapport de bug, et que "ou est installee l'application" est
 * precisement la question a laquelle un fork installe sur D: doit repondre sans
 * que l'utilisateur ouvres le registre.
 */
async function buildDiagnostics() {
  const install = installLayout.currentInstall({ app });
  const record = installLayout.readInstallMetadata(install, log);
  const registry = lastRegistryInfo.available ? lastRegistryInfo : await refreshRegistryInfo();
  const description = installLayout.describeInstall({
    install,
    record: record.record,
    registry,
    shortcuts: installLayout.checkShortcuts(record.record, install.installDir),
  });
  const files = installLayout.verifyInstallFiles(install, record.record);
  const storage = storageLayout.describe({ store, roots: ROOTS });

  const lines = [
    `${PRODUCT.name} ${app.getVersion()}`,
    `Electron ${process.versions.electron} / Chromium ${process.versions.chrome} / Node ${process.versions.node}`,
    `${process.platform} ${process.arch} — packaged=${app.isPackaged ? 'yes' : 'no'}${isStore ? ' (store)' : ''}`,
    '',
    `install dir      ${description.installDir}`,
    `install.json     ${description.hasMetadata ? 'present' : 'ABSENT'} (${description.metadataPath})`,
    `path recorded    ${description.expectedInstallPath || '-'}`,
    `consistency      ${description.consistency}${files.ok ? '' : ` — missing: ${files.problems.map((p) => p.what || p.expected).join(', ')}`}`,
    `registry         ${description.registry.paths.join(' | ') || 'no InstallPath'} (agrees: ${String(description.registry.agrees)})`,
    `shortcut desktop ${description.shortcuts.map((s) => `${s.kind}:${s.exists ? 'ok' : 'MISSING'}${s.pointsHere === false ? ' WRONG TARGET' : ''}`).join(' ') || 'not recorded'}`,
    '',
    `data             ${storage.data}`,
    `cache            ${storage.cache}`,
    `downloads        ${storage.downloads}${storage.downloadsIsDefault ? ' (default)' : ''} — ${storage.downloadsOk ? 'writable' : `NOT WRITABLE (${storage.downloadsErrorCode})`}`,
    `first launch     ${store.get('firstLaunchAt') || 'unknown'}`,
    `channel          ${description.channel || 'stable'}`,
  ];

  return { text: lines.join('\n'), description, storage, files };
}

/**
 * Actions de service exposees a la page Reglages > Services. Les memes que le
 * menu contextuel de la barre laterale, parce qu'une liste de services sans
 * bouton "Reinitialiser" oblige a trouver le clic droit pour reparer un compte
 * accroche.
 */
async function serviceAction(id, action) {
  const service = getService(id);
  if (!service) return { error: t('error.serviceMissing') };
  const entry = views.get(id);

  switch (action) {
    case 'reload':
      if (entry) entry.view.webContents.reload();
      else createServiceView(service);
      return { ok: true };
    case 'hard-reload':
      if (!entry) return { ok: false, error: t('overlay.sleepingTitle', { name: service.name }) };
      await entry.view.webContents.session.clearCache();
      entry.view.webContents.reloadIgnoringCache();
      return { ok: true };
    case 'sleep':
      hibernateService(id);
      return { ok: true };
    case 'wake':
      showService(id);
      return { ok: true };
    case 'mute':
      setMuted(id, !isMuted(id));
      return { ok: true, muted: isMuted(id) };
    case 'reset': {
      // Reinitialiser une session : c'est la seule maniere propre de deconnecter
      // un compte sans toucher au service lui-meme. La confirmation est native,
      // parce que la perte est reelle (cookies, IndexedDB, historique local).
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: t('service.resetTitle'),
        message: t('service.resetMessage', { name: service.name }),
        detail: t('service.resetDetail'),
        buttons: [t('service.resetConfirm'), t('delete.cancel')],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (response !== 0) return { ok: false, canceled: true };

      if (entry) {
        clearTimeout(entry.timer);
        mainWindow.contentView.removeChildView(entry.view);
        entry.view.webContents.destroy();
        views.delete(id);
      }
      await session.fromPartition(service.partition).clearStorageData();
      log('services', `${id} : session reinitialisee depuis les reglages`);
      broadcastServices();
      return { ok: true };
    }
    case 'duplicate':
      return duplicateService(service);
    case 'open-external':
      await shell.openExternal(service.url);
      return { ok: true };
    default:
      return { error: t('error.actionUnknown') };
  }
}

/**
 * Copier un service vers un NOUVEAU compte du meme site. L'important est la
 * partition : heriter de `persist:<id>` aurait connecte les deux au meme compte,
 * ce qui est exactement ce que l'app promet d'empecher.
 */
function duplicateService(service) {
  // Meme regle de nommage qu'a la creation : un slug, puis un suffixe numerique
  // si le slug est pris. Un id libre est ce qui garantit une partition libre.
  const taken = new Set(allServices().map((existing) => existing.id));
  let id = slugify(`${service.name} 2`);
  for (let n = 3; taken.has(id); n++) id = `${slugify(service.name)}-${n}`;
  const copy = {
    ...service,
    id,
    partition: `persist:${id}`,
    name: `${service.name} (2)`,
  };

  store.set('services', [...allServices(), copy]);
  store.set('order', [...(store.get('order') || []), id]);
  log('services', `${id} cree par duplication de ${service.id} (partition ${copy.partition})`);
  broadcastServices();
  return { ok: true, id };
}

function toggleFavorite(id) {
  const favorites = new Set(store.get('favorites') || []);
  if (favorites.has(id)) favorites.delete(id);
  else favorites.add(id);

  // Un id supprime de la liste des services ne doit pas rester favori : la page
  // Favoris afficherait une entree sans icone ni adresse.
  const known = new Set(allServices().map((service) => service.id));
  store.set('favorites', [...favorites].filter((favoriteId) => known.has(favoriteId)));
  broadcastServices();
  return { ok: true, favorites: store.get('favorites') };
}

/**
 * Page hors service (accueil, favoris, reglages, aide). Ouvrir une page masque les
 * vues natives — elles sont au-dessus du DOM, une page dessous ne se verrait pas.
 */
function openPage(page) {
  const allowed = ['home', 'favorites', 'settings', 'help', null];
  const next = allowed.includes(page) ? page : null;
  store.set('lastPage', next);
  send('hub:page', { page: next });

  // Les vues natives sont AU-DESSUS du DOM : une page affichee sans les masquer
  // serait une page qu'on ne voit pas. Le mecanisme est celui des modales, deja
  // la et deja teste ; le rendre ici evite deux politiques de visibilite.
  if (next) {
    for (const entry of views.values()) entry.view.setVisible(false);
  } else {
    applyViewVisibility();
  }
  layoutViews();
}

/** Referme la page ouverte (choix d'un service, tray, raccourci). */
function closePage() {
  if (!store.get('lastPage')) return;
  store.set('lastPage', null);
  send('hub:page', { page: null });
}

ipcMain.on('hub:page', (_e, page) => openPage(typeof page === 'string' ? page : null));
ipcMain.handle('hub:check-updates', () => checkForUpdatesFromSettings());
ipcMain.handle('hub:update-target', () => updateTargetCheck());
ipcMain.on('hub:window-control', (_e, action) => applyWindowControl(String(action || '')));
ipcMain.handle('hub:settings-get', () => settingsSnapshot());
ipcMain.handle('hub:settings-update', (_e, patch) => applySettingsPatch(patch));
ipcMain.handle('hub:pick-directory', (_e, purpose) => pickDirectory(purpose));
ipcMain.handle('hub:storage-verify', () => storageLayout.describe({ store, roots: ROOTS }));
ipcMain.handle('hub:downloads-reset', () => {
  storageLayout.resetDownloadsDir({ store });
  log('storage', 'dossier de telechargement remis au defaut');
  return { ok: true, settings: settingsSnapshot() };
});
ipcMain.handle('hub:open-location', (_e, kind) => openLocation(String(kind)));
ipcMain.handle('hub:diagnostics', async (_e, options) => {
  const report = await buildDiagnostics();
  // La copie se fait ici : `navigator.clipboard` depuis le renderer reclamerait une
  // permission et un focus, deux choses qui ne dependront jamais l'une de l'autre.
  if (options?.copy) clipboard.writeText(report.text);
  return report;
});
ipcMain.on('hub:open-lock-setup', () => send('hub:lock-setup', {}));
ipcMain.handle('hub:about', () => {
  showAbout();
  return { ok: true };
});
ipcMain.handle('hub:open-docs', () => shell.openExternal(`${REPO_URL}#readme`));
ipcMain.handle('hub:service-action', (_e, { id, action } = {}) => serviceAction(id, String(action || '')));
ipcMain.handle('hub:favorite-toggle', (_e, id) => toggleFavorite(id));
ipcMain.handle('hub:install-info', async () => {
  const install = installLayout.currentInstall({ app });
  const record = installLayout.readInstallMetadata(install, log);
  const registry = await refreshRegistryInfo();
  return installLayout.describeInstall({
    install,
    record: record.record,
    registry,
    shortcuts: installLayout.checkShortcuts(record.record, install.installDir),
  });
});

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  log('app', `Soocial ${app.getVersion()} — Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`);
  const preference = store.get('language');
  log('i18n', `langue : ${i18n.init(preference === 'system' ? null : preference)}`);

  catalogIcons.init({
    log,
    onIcon: (key, dataUrl) => send('hub:catalog-icon', { key, dataUrl }),
  });

  const services = allServices();
  log('app', `${services.length} services : ${services.map((s) => s.id).join(', ')}`);

  // Theme avant la fenetre : un fond force trop tard fait clignoter la barre de
  // titre en clair puis en sombre au premier affichage.
  nativeTheme.on('updated', () => send('hub:theme', { theme: effectiveTheme(), preference: store.get('theme') }));

  // La politique de telechargement vaut aussi pour la session par defaut (celle
  // des popups et de l'onboarding).
  downloadsPolicy.attach({
    sessions: [session.defaultSession],
    getContext: () => ({ ...storageContext(), serviceIdOf: (wc) => serviceIdOfWebContents(wc) }),
    log: (lines) => log('download', [].concat(lines).join(' ')),
    notify: notifyApp,
    t,
    dialog,
  });

  // Confrontation install.json / registre / executable reel. Deux issues, deux
  // traitements : un ecart de chemin se signale dans les reglages, une absence de
  // install.json se signale aussi mais n'empeche rien (l'app tourne tres bien,
  // c'est l'updater qui aura besoin du chemin).
  refreshRegistryInfo().then(() => {
    const install = installLayout.currentInstall({ app });
    const record = installLayout.readInstallMetadata(install, log);
    const description = installLayout.describeInstall({
      install,
      record: record.record,
      registry: lastRegistryInfo,
      shortcuts: installLayout.checkShortcuts(record.record, install.installDir),
    });
    log('install', `${install.installDir} — ${description.consistency}${description.hasMetadata ? '' : ' (install.json absent)'}`);
    if (description.consistency === 'mismatch') {
      log('install', `attention : install.json dit ${description.expectedInstallPath}, l'executable est ${install.installDir}`);
    }
    if (installLayout.needsRepair(description) && app.isPackaged) {
      notifyApp(t('install.repairTitle'), t('install.repairBody'), {});
    }
  });

  applyTheme(); // theme + delegate systeme, avant le premier fond de fenetre
  createWindow();
  createTray();
  setupUpdater();
  applyAutostart(); // aligne l'entree Windows sur la config a chaque demarrage

  // Verrouillage automatique. lockApp ne fait rien tant qu'aucun code n'est
  // defini. L'inactivite est sondee : powerMonitor ne la notifie pas.
  const lockOnSuspend = () => {
    if (store.get('lock')?.onSuspend !== false) lockApp('session Windows verrouillee');
  };
  powerMonitor.on('lock-screen', lockOnSuspend);
  powerMonitor.on('suspend', lockOnSuspend);

  // Ne pas deranger : reprend l'echeance laissee par la session precedente
  // (une echeance passee se desactive au premier sync), et la re-verifie au
  // reveil de la machine, les timers ayant dormi avec elle.
  syncDndTimer();
  powerMonitor.on('resume', syncDndTimer);
  setInterval(() => {
    const minutes = Number(store.get('lock')?.idleMinutes) || 0;
    if (minutes > 0 && powerMonitor.getSystemIdleTime() >= minutes * 60) {
      lockApp(`${minutes} min d'inactivite`);
    }
  }, 30000);

  // Prechargement des vignettes du catalogue : la grille doit etre chaude avant
  // que le formulaire ne s'ouvre. Pendant l'onboarding elle est visible tout de
  // suite, donc pas d'attente ; sinon on laisse les services demarrer d'abord.
  // Un cache frais ne declenche aucune requete.
  const delay = needsOnboarding() ? 0 : 8000;
  setTimeout(() => catalogIcons.refresh(CATALOG), delay);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  tray?.destroy();
  tray = null;
});

// La fenetre etant masquee (jamais fermee) tant qu'on ne quitte pas vraiment,
// cet evenement ne se declenche qu'apres un quit explicite.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

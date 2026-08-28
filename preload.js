'use strict';

// Bridge sidebar <-> main. Seule surface exposee au renderer (contextIsolation
// active, nodeIntegration desactive) : pas d'acces direct a Node ni a ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

contextBridge.exposeInMainWorld('hub', {
  /** Services, service actif, version, mise a jour en attente. */
  bootstrap: () => ipcRenderer.invoke('hub:bootstrap'),

  /** Affiche le service demande (swap de WebContentsView cote main). */
  select: (id) => ipcRenderer.send('hub:select', id),

  /** Relance le chargement d'un service en erreur, en veille ou en timeout. */
  retry: (id) => ipcRenderer.send('hub:retry', id),

  /** Menu natif du clic droit sur une icone de service. */
  serviceMenu: (id) => ipcRenderer.send('hub:service-menu', id),

  /** Volume d'un service, de 0 a 100. Applique dans la page, pas par Windows. */
  setVolume: (id, value) => ipcRenderer.send('hub:set-volume', { id, value }),

  /** Volume general, applique par-dessus celui de chaque service. */
  setMasterVolume: (value) => ipcRenderer.send('hub:set-master-volume', value),

  /** Volume change ailleurs : sous-menu du clic droit, autre surface. */
  onVolume: (callback) => on('hub:volume', callback),

  /** Ouverture du melangeur, demandee depuis un menu natif. */
  onOpenMixer: (callback) => on('hub:open-mixer', callback),

  /** Menu natif "Ne pas deranger" (durees), ouvert par le bouton lune. */
  dndMenu: () => ipcRenderer.send('hub:dnd-menu'),

  /** { active, until } - le mode "Ne pas deranger" a bascule ou expire. */
  onDnd: (callback) => on('hub:dnd', callback),

  /** Cree ou met a jour un service -> { ok } ou { error }. */
  saveService: (draft) => ipcRenderer.invoke('hub:service-save', draft),

  /** Fin d'onboarding : cree les services choisis et demarre. */
  completeOnboarding: (drafts) => ipcRenderer.invoke('hub:onboard-complete', drafts),

  /** Change la langue -> { strings, language, preference }. */
  setLanguage: (preference) => ipcRenderer.invoke('hub:set-language', preference),

  /** Verrouille l'app (equivalent de Ctrl+L), sans effet si aucun code. */
  lockNow: () => ipcRenderer.send('hub:lock-now'),

  /** Tente de deverrouiller avec le code saisi -> { ok } ou { error }. */
  unlock: (pin) => ipcRenderer.invoke('hub:unlock', pin),

  /** Deverrouille un seul service protege -> { ok } ou { error }. */
  unlockService: (id, pin) => ipcRenderer.invoke('hub:unlock-service', { id, pin }),

  /** Bascule la protection d'un service -> { ok, protected } ou { error }. */
  protectService: (draft) => ipcRenderer.invoke('hub:service-protect', draft),

  /** Definit, change ou supprime le code -> { ok } ou { error }. */
  configureLock: (draft) => ipcRenderer.invoke('hub:lock-config', draft),

  /** { locked } - l'app vient de se verrouiller ou deverrouiller. */
  onLock: (callback) => on('hub:lock', callback),

  /** { mode: 'set' | 'change' | 'remove' } - le menu demande le formulaire de code. */
  onLockSetup: (callback) => on('hub:lock-setup', callback),

  /** { strings, language } - la langue a change depuis le menu. */
  onLanguage: (callback) => on('hub:language', callback),

  /** Supprime un service, apres confirmation native. */
  deleteService: (id) => ipcRenderer.invoke('hub:service-delete', id),

  /** Nouvel ordre complet des services, apres un drag & drop. */
  reorder: (ids) => ipcRenderer.send('hub:reorder', ids),

  /** Redemarre l'app sur la version telechargee. */
  installUpdate: () => ipcRenderer.send('hub:install-update'),

  /** Escamote la vue du service pour laisser voir une boite de dialogue. */
  setModalOpen: (open) => ipcRenderer.send('hub:modal', open),

  /** Pastille de non-lus sur l'icone de la barre des taches (dessinee au canvas). */
  setOverlayBadge: (dataUrl, description) =>
    ipcRenderer.send('hub:overlay', { dataUrl, description }),

  /** Icone du tray recomposee avec le compteur ; null = icone d'origine. */
  setTrayIcon: (dataUrl) => ipcRenderer.send('hub:tray-icon', dataUrl),

  /** { id, status: 'loading' | 'ready' | 'error' | 'hibernated', message? } */
  onStatus: (callback) => on('hub:status', callback),

  /** { id, needsCode } - le service actif a change (clic sidebar, raccourci, tray). */
  onActive: (callback) => on('hub:active', callback),

  /** { id } - le service affiche dans la seconde part (null = vue simple). */
  onSplit: (callback) => on('hub:split', callback),

  /** { active, divider } - decoupage courant de la zone de contenu. */
  onLayout: (callback) => on('hub:layout', callback),

  /** Debut / fin du glissement du separateur (les vues sont escamotees). */
  splitDrag: (dragging) => ipcRenderer.send('hub:split-drag', dragging),

  /** Nouveau ratio du separateur (0.2 a 0.8), null pour annuler le geste. */
  setSplitRatio: (ratio) => ipcRenderer.send('hub:split-ratio', ratio),

  /** { id, count } - count > 0 : compteur, -1 : pastille sans nombre, 0 : rien. */
  onBadge: (callback) => on('hub:badge', callback),

  /** { id, dataUrl, source } - icone resolue pour un service. */
  onIcon: (callback) => on('hub:icon', callback),

  /** { order } - l'ordre a change ailleurs (menu contextuel Monter/Descendre). */
  onOrder: (callback) => on('hub:order', callback),

  /** { services } - la liste a change (creation, edition, suppression). */
  onServices: (callback) => on('hub:services', callback),

  /** { id } - le menu contextuel demande l'ouverture du formulaire d'edition. */
  onEditService: (callback) => on('hub:edit-service', callback),

  /** Le menu Fichier demande le formulaire de creation. */
  onNewService: (callback) => on('hub:new-service', callback),

  /** { domain, dataUrl } - vignette de catalogue arrivee en tache de fond. */
  onCatalogIcon: (callback) => on('hub:catalog-icon', callback),

  /** { state: 'downloading' | 'ready', version } */
  onUpdate: (callback) => on('hub:update', callback),

  // ---------------------------------------------------------------- Soocial --

  /** Boutons de la barre de titre : minimize | maximize | close | fullscreen | menu. */
  windowControl: (action) => ipcRenderer.send('hub:window-control', action),

  /** { maximized, minimized, fullScreen, focused } - l'etat que les boutons refletent. */
  onWindowState: (callback) => on('hub:window-state', callback),

  /** { theme, preference } - le theme vient de changer (Windows ou reglage). */
  onTheme: (callback) => on('hub:theme', callback),

  /** Ouvre une page hors service (home | favorites | settings | help) ou la ferme. */
  setPage: (page) => ipcRenderer.send('hub:page', page),
  onPage: (callback) => on('hub:page', callback),

  /** Instantane des reglages, du stockage et de l'installation. */
  settings: () => ipcRenderer.invoke('hub:settings-get'),

  /** Un reglage a change, d'ou que ce soit -> instantane complet. */
  onSettings: (callback) => on('hub:settings', callback),

  /** Applique des reglages -> { applied, rejected, settings }. Liste blanche cote main. */
  updateSettings: (patch) => ipcRenderer.invoke('hub:settings-update', patch),

  /** Boite de selection d'un dossier (purpose: 'downloads') -> { ok, path, error }. */
  pickDirectory: (purpose) => ipcRenderer.invoke('hub:pick-directory', purpose),

  /** Re-sonde le dossier de telechargement : lecteur retire, droits perdus. */
  verifyStorage: () => ipcRenderer.invoke('hub:storage-verify'),

  /** Retour au dossier de telechargement par defaut. */
  resetDownloads: () => ipcRenderer.invoke('hub:downloads-reset'),

  /** Ouvre un emplacement sur le disque (downloads | data | cache | install). */
  openLocation: (kind) => ipcRenderer.invoke('hub:open-location', kind),

  /** Bloc de texte pret a coller dans un rapport de bug ({ copy: true } le copie deja). */
  diagnostics: (options) => ipcRenderer.invoke('hub:diagnostics', options),

  /** Boite "A propos" (la meme que le menu). */
  about: () => ipcRenderer.invoke('hub:about'),

  /** Dialogue de configuration du code de verrouillage, gere par la barre laterale. */
  openLockSetup: () => ipcRenderer.send('hub:open-lock-setup'),

  /** Documentation du depot. */
  openDocs: () => ipcRenderer.invoke('hub:open-docs'),

  /** installPath / canal / registre / raccourcis : ce que l'installeur a laisse. */
  installInfo: () => ipcRenderer.invoke('hub:install-info'),

  /** reload | hard-reload | sleep | wake | mute | reset | duplicate | open-external */
  serviceAction: (id, action) => ipcRenderer.invoke('hub:service-action', { id, action }),

  /** Etoile de la barre laterale et vue Favoris. */
  toggleFavorite: (id) => ipcRenderer.invoke('hub:favorite-toggle', id),

  /** Verification manuelle -> { state, version? }. */
  checkUpdates: () => ipcRenderer.invoke('hub:check-updates'),
});

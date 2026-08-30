/* Soocial — Tauri bridge
 *
 * Keeps the renderer's `window.hub` contract exactly as the Electron preload
 * exposed it, while routing each call through Tauri commands and events.  This
 * file is loaded by `renderer/index.html` before `sidebar.js` / `pages.js`.
 *
 * When the app is still launched by Electron (`preload.js` runs first and
 * already defines `window.hub`) this script returns immediately so the
 * Electron path stays intact.
 */
(() => {
  'use strict';

  if (window.hub) return;

  const ta = (window.__TAURI__ || {});
  const api = ta.core || {};
  const events = ta.event || {};

  const invoke = (cmd, args) => {
    if (typeof api.invoke !== 'function') {
      return Promise.reject(new Error(`Tauri API unavailable in this host: ${cmd}`));
    }
    return api.invoke(cmd, args === undefined ? {} : args);
  };

  const fire = (cmd, args) => {
    invoke(cmd, args).catch((err) => console.warn(`[hub] ${cmd} failed`, err));
  };

  const listen = (event, callback) => {
    if (typeof events.listen !== 'function') {
      return Promise.resolve(() => {});
    }
    return events.listen(event, (e) => {
      try {
        callback(e.payload);
      } catch (err) {
        console.error(`[hub] ${event} listener failed`, err);
      }
    });
  };

  // Map every command the old Electron preload exposed.  Keep the names in
  // snake_case because Tauri maps a Rust command argument `someArg` to the JS
  // key `someArg`, and our command signatures use the same names.
  const hub = {
    bootstrap: () => invoke('bootstrap'),
    select: (id) => invoke('select', { id }),
    retry: (id) => invoke('retry', { id }),
    saveService: (draft) => invoke('save_service', { draft }),
    deleteService: (id) => invoke('delete_service', { id }),
    serviceMenu: (id) => invoke('service_menu', { id }),
    navMenu: (rect) => invoke('nav_menu', { rect }),
    dndMenu: () => invoke('dnd_menu'),
    completeOnboarding: (drafts) => invoke('onboard_complete', { drafts }),
    setLanguage: (preference) => invoke('set_language', { preference }),
    reorder: (ids) => invoke('reorder', { ids }),
    setVolume: (id, value) => fire('set_volume', { id, value }),
    setMasterVolume: (value) => fire('set_master_volume', { value }),
    setDnd: (choice) => fire('set_dnd', { choice }),
    unlock: (pin) => invoke('unlock', { pin }),
    unlockService: (id, pin) => invoke('unlock_service', { id, pin }),
    protectService: (draft) => invoke('protect_service', { draft }),
    configureLock: (draft) => invoke('configure_lock', { draft }),
    lockNow: () => fire('lock_now'),
    openLockSetup: () => fire('open_lock_setup'),
    setSplit: (id) => invoke('set_split', { id }),
    closeSplit: () => fire('close_split'),
    splitDrag: (dragging) => fire('split_drag', { dragging }),
    setSplitRatio: (ratio) => fire('set_split_ratio', { ratio }),
    setModalOpen: (open) => fire('set_modal_open', { open }),
    windowControl: (action) => fire('window_control', { action }),
    setPage: (page) => fire('set_page', { page }),
    settings: () => invoke('settings'),
    updateSettings: (patch) => invoke('update_settings', { patch }),
    pickDirectory: (purpose) => invoke('pick_directory', { purpose }),
    verifyStorage: () => invoke('verify_storage'),
    resetDownloads: () => invoke('reset_downloads'),
    openLocation: (kind) => invoke('open_location', { kind }),
    diagnostics: (options) => invoke('diagnostics', { options }),
    about: () => invoke('about'),
    openDocs: () => invoke('open_docs'),
    installInfo: () => invoke('install_info'),
    serviceAction: (id, action) => invoke('service_action', { id, action }),
    toggleFavorite: (id) => invoke('favorite_toggle', { id }),
    favoriteToggle: (id) => invoke('favorite_toggle', { id }),
    checkUpdates: () => invoke('check_updates'),
    installUpdate: () => fire('install_update'),
    setOverlayBadge: (dataUrl, description) => fire('set_overlay_badge', { dataUrl, description }),
    setTrayIcon: (dataUrl) => fire('set_tray_icon', { dataUrl })
  };

  // Event subscriptions used by the sidebar/pages/titlebar.  Preload returned
  // an unsubscribe function; keep the same shape so existing renderer code
  // (which ignores the return value) works unchanged.
  const eventMethods = {
    onStatus: 'hub:status',
    onActive: 'hub:active',
    onSplit: 'hub:split',
    onLayout: 'hub:layout',
    onBadge: 'hub:badge',
    onIcon: 'hub:icon',
    onOrder: 'hub:order',
    onServices: 'hub:services',
    onCatalogIcon: 'hub:catalog-icon',
    onEditService: 'hub:edit-service',
    onNewService: 'hub:new-service',
    onDnd: 'hub:dnd',
    onLock: 'hub:lock',
    onLockSetup: 'hub:lock-setup',
    onUpdate: 'hub:update',
    onLanguage: 'hub:language',
    onOpenMixer: 'hub:open-mixer',
    onVolume: 'hub:volume',
    onWindowState: 'hub:window-state',
    onPage: 'hub:page',
    onTheme: 'hub:theme',
    onSettings: 'hub:settings'
  };

  for (const [method, eventName] of Object.entries(eventMethods)) {
    hub[method] = (callback) => listen(eventName, callback);
  }

  window.hub = hub;

  // Convenience re-exports for the Tauri dev console.
  window.__soocialTauri = { invoke, listen };
})();

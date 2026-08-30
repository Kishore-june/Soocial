'use strict';

/* ==========================================================================
   Soocial - barre de titre
   ==========================================================================

   La barre est dessinee par le renderer mais ne decide de rien : chaque bouton
   envoie une intention au processus principal, qui traduit selon le reglage en
   cours (fermer = tray ou = quitter) et renvoie l'etat. C'est dans ce sens que le
   bouton du milieu peut afficher "agrandir" ou "reduire" sans mentir : il ne le
   devine pas, on le lui dit.
   ========================================================================== */

(() => {
  const titlebar = document.getElementById('titlebar');
  if (!titlebar || !window.hub) return;

  const title = document.getElementById('titlebar-title');
  const subtitle = document.getElementById('titlebar-subtitle');
  const maximizeButton = titlebar.querySelector('[data-action="maximize"]');
/**
 * Libelles de secours. Le texte vrai vient du dictionnaire que le main envoie a la
 * sidebar (`t`, fonction de sidebar.js, partagee entre scripts classiques du meme
 * document) : une barre de titre non traduite a cote d'une app traduite donne
 * l'impression d'un gadget colle dessus.
 */
const FALLBACK = {
  minimize: 'Minimize',
  maximize: 'Maximize',
  restore: 'Restore',
  close: 'Close',
  fullscreen: 'Full screen',
  menu: 'Menu',
};

const translate = (key, fallback) => (typeof t === 'function' ? t(key, undefined) : fallback || key);

function refreshLabels() {
  for (const button of titlebar.querySelectorAll('button[data-action]')) {
    const action = button.dataset.action;
    const text = translate(`titlebar.${action}`, FALLBACK[action]);
    button.title = text;
    button.setAttribute('aria-label', text);
  }
}
refreshLabels();

  titlebar.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return; // le clic a porte sur la zone de glissement : rien a faire
    window.hub.windowControl(button.dataset.action);
  });

  // Le double-clic sur une barre de titre Windows est un "agrandir", pas un geste
  // decoratif. La zone de glissement avale les clics de bouton, d'ou le filtre.
  titlebar.addEventListener('dblclick', (event) => {
    if (event.target.closest('button, input, select, [data-no-drag]')) return;
    window.hub.windowControl('maximize');
  });

  function setMaximizedLabel(maximized) {
    if (!maximizeButton) return;
    const key = maximized ? 'restore' : 'maximize';
    const text = translate(`titlebar.${key}`, FALLBACK[key]);
    maximizeButton.title = text;
    maximizeButton.setAttribute('aria-label', text);
    maximizeButton.dataset.state = maximized ? 'restore' : 'maximize';
  }

  window.hub.onWindowState((state) => {
    document.documentElement.dataset.windowFocused = String(Boolean(state.focused));
    document.documentElement.dataset.windowMaximized = String(Boolean(state.maximized));
    document.documentElement.dataset.windowFullscreen = String(Boolean(state.fullScreen));
    setMaximizedLabel(state.maximized);

    // En plein ecran, la barre n'a plus de raison d'etre : elle mange 40 px de
    // conversation et ses boutons ne servent plus (Echapp y rentre mieux).
    if (titlebar) titlebar.hidden = Boolean(state.fullScreen);
  });

  /* Le titre suit le service actif. `hub:active` est l'evenement qui dit la verite
     (le payload des services, lui, ne porte pas "actif" : c'est le main qui decide). */
  window.hub.onActive(({ id }) => {
    if (!title) return;
    const service = (lastServices || []).find((entry) => entry.id === id);
    title.textContent = service ? service.name : 'Soocial';
    document.title = service ? `${service.name} - Soocial` : 'Soocial';
  });

  let lastServices = [];
  window.hub.onServices(({ services }) => {
    lastServices = services || [];
  });

  // Les libelles des boutons dependent de la langue : recharger quand elle change.
  document.addEventListener('hub:i18n', refreshLabels);

  window.hub.onUpdate?.((update) => {
    if (!subtitle) return;
    // Le sous-titre dit ce qui attend l'utilisateur, rien de plus : une barre de
    // titre qui raconte l'historique devient un deuxieme journal.
    subtitle.textContent = update && update.state === 'ready'
      ? translate('update.readyMessage', 'Update ready')
      : '';
  });
})();

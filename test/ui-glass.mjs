#!/usr/bin/env node
/**
 * Test UI de la barre de titre, des pages et des reglages, via CDP.
 *
 * Prerequis : instance lancee avec --remote-debugging-port et profil vierge.
 *   npm run test:ui        (ou, a la main : node --experimental-websocket test/ui-glass.mjs 9229
 *   -- le drapeau n'est utile qu'avant Node 22, ou WebSocket n'etait pas global)
 *
 * Ce que ce test prouve vraiment : le DOM est la, les evenements circulent dans
 * les deux sens (un clic de bouton arrive au main, l'etat de la fenetre revient),
 * et les reglages qui promettent un effet le produisent dans le style. Ce qu'il ne
 * prouve pas : le comportement Windows (Aero Snap, tray, notifications), qui
 * depend du systeme d'exploitation et non du renderer.
 */

import { readFileSync } from 'node:fs';

const PORT = process.argv[2] || '9229';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

let page;
for (let i = 0; i < 40 && !page; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
  } catch {}
  if (!page) await sleep(500);
}
if (!page) {
  console.error('FAIL page sidebar introuvable');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push((message.params.args || []).map((a) => a.value ?? a.description).join(' '));
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('Runtime.enable');

async function evalJs(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails) {
    return { __threw: result.result.exceptionDetails.exception?.description || result.result.exceptionDetails.text };
  }
  return result.result?.result?.value;
}

const query = (selector) => evalJs(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
const attr = (selector, name) =>
  evalJs(`document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)}) ?? null`);
const count = (selector) => evalJs(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const click = (selector) =>
  evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);

/* Un profil neuf affiche l'onboarding, qui recouvre la fenetre : le vrai clic de
   souris de la section 1 porterait dessus. On le ferme s'il est la, rien d'autre. */
await evalJs(`(async () => {
  const overlay = document.getElementById('onboarding');
  if (!overlay || overlay.classList.contains('hidden')) return 'absent';
  document.getElementById('ob-start')?.click();
  await new Promise((r) => setTimeout(r, 900));
  return 'ferme';
})()`);
await sleep(300);

// ---------------------------------------------------------------------------
// 1. La barre de titre
// ---------------------------------------------------------------------------

check('#titlebar present', await query('#titlebar'));
check('trois boutons de fenetre', (await count('#titlebar .win-button')) === 3, `${await count('#titlebar .win-button')}`);
check('les trois actions sont distinctes', await evalJs(
  `new Set([...document.querySelectorAll('#titlebar .win-button')].map((b) => b.dataset.action)).size === 3`
));
check('chaque bouton a un libelle accessible', await evalJs(
  `[...document.querySelectorAll('#titlebar button')].every((b) => (b.getAttribute('aria-label') || '').length > 0 && b.title.length > 0)`
));
check('les boutons ne sont pas dans la zone de glissement', await evalJs(
  `getComputedStyle(document.querySelector('.titlebar-controls')).webkitAppRegion === 'no-drag' ||
   getComputedStyle(document.querySelector('.titlebar-controls')).getPropertyValue('-webkit-app-region') === 'no-drag'`
));

// Un clic sur "reduire" doit traverser l'IPC et revenir par l'etat de fenetre :
// c'est le seul bout du parcours qui ne peut pas etre simule en JS.
const beforeMinimize = await evalJs(`window.__hubWindowStates || 0`);
await evalJs(`window.hub.onWindowState((s) => { window.__hubWindowStates = (window.__hubWindowStates || 0) + 1; window.__hubWindowState = s; }); 'ok'`);
await click('#titlebar [data-action="minimize"]');
await sleep(700);
const states = await evalJs(`window.__hubWindowStates || 0`);
check('le clic de reduction a fait aller et retour l\u2019etat', Number(states) > Number(beforeMinimize), `etat recu ${states}x`);
// Pas d'assertion sur `minimized === true` : sous un gestionnaire de fenetres
// absent (xvfb), Electron peut tres bien ne jamais reporter l'etat reduit. Ce qui
// est verifie ici est ce qui depend du code : le message part, l'etat revient avec
// sa forme complete, et le renderer le pose sur <html>.
const stateShape = await evalJs(`(() => {
  const s = window.__hubWindowState || {};
  return ['maximized', 'minimized', 'fullScreen', 'focused', 'visible'].every((k) => typeof s[k] === 'boolean');
})()`);
check('l\u2019etat de fenetre recu est complet', stateShape === true);
const focusAttr = await evalJs(`document.documentElement.dataset.windowFocused`);
check('le focus de la fenetre est reflette dans le DOM', focusAttr === 'true' || focusAttr === 'false', String(focusAttr));
await evalJs(`window.hub.windowControl('restore'); 'ok'`);

// ---------------------------------------------------------------------------
// 2. Dimensions partagees
// ---------------------------------------------------------------------------

const titlebarHeight = await evalJs(`getComputedStyle(document.documentElement).getPropertyValue('--titlebar-height').trim()`);
check('--titlebar-height vient du main', titlebarHeight === '40px', titlebarHeight);
const sidebarWidth = await evalJs(`getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width').trim()`);
check('--sidebar-width vient du main', ['72px', '60px'].includes(sidebarWidth), sidebarWidth);
check('le corps reserve la hauteur du titre', await evalJs(
  `getComputedStyle(document.body).paddingTop === '${titlebarHeight}'`
), await evalJs(`getComputedStyle(document.body).paddingTop`));

// ---------------------------------------------------------------------------
// 3. Theme, verre, animations
// ---------------------------------------------------------------------------

const theme = await attr('html', 'data-theme');
check('un theme est applique des le bootstrap', theme === 'dark' || theme === 'light', theme);

await evalJs(`window.hub.updateSettings({ glass: 'off' })`);
await sleep(400);
check('glass=off se lit dans le DOM', (await attr('html', 'data-glass')) === 'off');
check('glass=off supprime le flou de la barre laterale', await evalJs(
  `const style = getComputedStyle(document.querySelector('#sidebar'));
   style.backdropFilter === 'none' || style.getPropertyValue('backdrop-filter') === 'none'`
));

await evalJs(`window.hub.updateSettings({ glass: 'full' })`);
await sleep(400);
const blurFull = await evalJs(`getComputedStyle(document.querySelector('#sidebar')).backdropFilter || getComputedStyle(document.querySelector('#sidebar')).getPropertyValue('backdrop-filter')`);
check('glass=full floute reellement', /blur\(26px\)/.test(String(blurFull)), String(blurFull));

await evalJs(`window.hub.updateSettings({ animations: 'reduced' })`);
await sleep(400);
check('animations reduites coupent les transitions', await evalJs(
  `parseFloat(getComputedStyle(document.querySelector('.rail-logo')).transitionDuration) <= 0.01`
), await evalJs(`getComputedStyle(document.querySelector('.rail-logo')).transitionDuration`));

// ---------------------------------------------------------------------------
// 4. Pages et reglages
// ---------------------------------------------------------------------------

// Les dimensions viennent de shared/layout-metrics.js et sont posees sur <html> :
// ce sont elles que le rendu doit refleter, pas les valeurs de repli du CSS.
const sizes = JSON.parse(await evalJs(`JSON.stringify({
  button: Math.round(document.querySelector('.win-button').getBoundingClientRect().width),
  glyph: Math.round(document.querySelector('.win-button svg').getBoundingClientRect().width),
  tile: document.querySelector('.service') ? Math.round(document.querySelector('.service').getBoundingClientRect().height) : null,
  avatar: document.querySelector('.service .avatar') ? Math.round(document.querySelector('.service .avatar').getBoundingClientRect().width) : null,
})`));
check('les pastilles de fenetre mesurent 15 px', sizes.button === 15, `${sizes.button} px`);
check('leur glyphe mesure 8 px', sizes.glyph === 8, `${sizes.glyph} px`);
// Une barre sans service n'a rien a mesurer : le lanceur part d'un profil vierge,
// et ce n'est pas une raison pour que le test casse. null est donc une sortie
// admise, signalee comme telle dans le detail.
const tilesOk = sizes.tile === null || (sizes.tile === 40 && sizes.avatar === 30);
check('la tuile de service fait 40 px, son icone 30', tilesOk,
  sizes.tile === null ? 'aucun service dans ce profil' : `${sizes.tile}/${sizes.avatar} px`);

// La navigation est un seul bouton : l'icone du logiciel. Les quatre destinations
// sont dans le menu natif qu'il ouvre, donc elles ne se comptent plus dans le DOM.
check("l'entree du menu est l'icone du logiciel", await evalJs(
  `!!document.querySelector('#rail-logo.rail-logo[aria-haspopup="menu"]')`
));
check('aucun bouton de page ne traine a cote', (await count('#sidebar [data-page]')) === 0, `${await count('#sidebar [data-page]')} bouton(s)`);
check('le duplicata ≡ de la barre de titre a disparu', (await count('.titlebar-actions button')) === 0, `${await count('.titlebar-actions button')} bouton(s)`);

// Le contenu du menu est decide par le main (un popup natif ne se lit pas depuis
// le renderer) : on verifie la source, qui est le seul endroit ou il est ecrit.
const menuSource = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const navMenuBody = menuSource.slice(menuSource.indexOf('function navMenuTemplate'), menuSource.indexOf('function showNavMenu'));
check('le menu groupe les quatre pages',
  /\['home', 'favorites', 'settings', 'help'\]/.test(navMenuBody) && (navMenuBody.match(/t\(`nav\.\$\{page\}`\)/) || []).length > 0,
  `${(navMenuBody.match(/type: 'radio'/g) || []).length} entree(s) marquee(s)`);
check('le menu garde les rubriques de lapplication', /\.\.\.appMenuTemplate\(\)/.test(navMenuBody));

// Le pont contextBridge est gele : window.hub ne peut pas etre piege depuis la
// page, et le popup est natif - il n'existe aucun observateur cote renderer. Ce
// que ce test peut donc prouver est limite aux trois maillons visibles : le canal
// est declare dans le preload, la fonction arrive jusqu'a nous, le clic part.
const preloadSource = readFileSync(new URL('../preload.js', import.meta.url), 'utf8');
check('le pont expose navMenu sur son canal',
  /navMenu:\s*\(rect\)\s*=>\s*ipcRenderer\.send\('hub:nav-menu',\s*rect\)/.test(preloadSource));
check("l'icone appelle le pont au clic", await evalJs(
  `typeof window.hub.navMenu === 'function' && document.getElementById('rail-logo').dataset.wired === '1'`
));
await click('#rail-logo');
await sleep(150);
check("l'icone se dit menu ouvert", await evalJs(
  `document.getElementById('rail-logo').getAttribute('aria-expanded') === 'true'`
));

// Point de depart deterministe : `lastPage` est persiste (rouvrir les reglages la
// ou on les a laisses est un reglage voulu), donc un test qui ouvrait une page sans
// remettre a zero se retrouverait a la REFERMER.
await evalJs(`window.hub.setPage(null)`);
await sleep(400);

await evalJs(`window.hub.setPage('home')`);
await sleep(600);
check("l'entree Accueil du menu ouvre l'accueil", await evalJs(
  `!document.getElementById('page-root').hidden && document.querySelector('.page-head h1')?.textContent.length > 0`
));
check("l'entree unique porte le temoin de page ouverte", await evalJs(
  `document.getElementById('rail-logo').getAttribute('aria-current') === 'page' && document.getElementById('rail-logo').getAttribute('data-page-open') === 'home'`
));
check('le sous-titre de la page est traduit', await evalJs(
  `(() => { const t = document.querySelector('.page-head p')?.textContent || ''; return t.length > 8 && !/^[a-z0-9_]+\\.[a-z0-9_.]+$/i.test(t) })()`
), await evalJs(`document.querySelector('.page-head p')?.textContent`));

await evalJs(`window.hub.setPage('settings')`);
await sleep(600);
check('#page-root affiche quand une page est ouverte', await evalJs(`!document.getElementById('page-root').hidden`));
// Le reglages.subtitle etait passe sous le nez des trois fichiers de langue : la
// cle s'affichait telle quelle dans l'en-tete. Toute page doit montrer une phrase.
check("l'en-tete des reglages a un sous-titre traduit", await evalJs(
  `(() => { const t = document.querySelector('.page-head p')?.textContent || ''; return t.length > 8 && !/^[a-z0-9_]+\\.[a-z0-9_.]+$/i.test(t) })()`
), await evalJs(`document.querySelector('.page-head p')?.textContent`));
check('sept rubriques de reglages', (await count('.settings-nav button')) === 7, `${await count('.settings-nav button')}`);
check('les rangees de reglages sont rendues', (await count('.setting-row')) > 3, `${await count('.setting-row')}`);

// Stockage : le chemin de telechargement doit etre affiche, et distinct du
// dossier d'installation -- c'est le coeur de la demande "dossier separe".
await click('.settings-nav button:nth-child(4)');
await sleep(500);
check('la rubrique Stockage est activee au clic', await evalJs(
  `document.querySelectorAll('.settings-nav button')[3].getAttribute('aria-current') === 'true'`
));
const paths = await evalJs(
  `[...document.querySelectorAll('.path-cell')].map((cell) => cell.textContent.trim())`
);
check('au moins trois emplacements affiches', Array.isArray(paths) && paths.length >= 3, JSON.stringify(paths));
check('telechargements distinct du dossier applicatif', Array.isArray(paths) && new Set(paths.filter(Boolean)).size >= 3, JSON.stringify(paths));
check('le bloc installation cite install.json', await evalJs(
  `document.querySelector('.settings-body')?.textContent.includes('install.json')`
));

// Un interrupteur doit survivre a l'aller-retour : ecrit dans le main, broadcaste,
// reaffiche. C'est la que les reglages "locaux au renderer" cassent d'habitude.
const flip = await evalJs(`(async () => {
  const row = [...document.querySelectorAll('.setting-row')].find((r) => r.querySelector('.glass-switch'));
  const toggle = row.querySelector('.glass-switch');
  const before = toggle.getAttribute('aria-checked');
  toggle.click();
  await new Promise((r) => setTimeout(r, 500));
  const after = document.querySelector('.setting-row .glass-switch')?.getAttribute('aria-checked');
  const persisted = (await window.hub.settings()).sidebarCollapsed;
  return { before, after, persisted };
})()`);
check('un interrupteur change d\u2019etat et se relit', flip && flip.before !== flip.after, JSON.stringify(flip));

// Le service choisi ferme la page : les vues natives sont au-dessus du DOM, une
// page qui resterait ouverte masquerait le service ouvert.
await evalJs(`window.hub.setPage(null)`);
await sleep(400);
check('#page-root est referme', await evalJs(`document.getElementById('page-root').hidden`));
check('la navigation n\u2019est plus marquee', await evalJs(
  `!document.querySelector('#rail-logo[aria-current]') && !document.querySelector('#rail-logo[data-page-open]')`
));

// ---------------------------------------------------------------------------
// 5. Rien ne casse en silence
// ---------------------------------------------------------------------------

const errors = await evalJs(`JSON.stringify(window.__hubBootError || null)`);
check('pas d\u2019erreur de bootstrap signalee', errors === 'null', String(errors));
check('aucune exception dans le renderer', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

await send('Runtime.disable');
ws.close();

console.log(failures ? `\n${failures} echec(s)` : '\nui-glass: tout est vert');
process.exit(failures ? 1 : 0);

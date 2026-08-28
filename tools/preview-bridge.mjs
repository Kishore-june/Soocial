#!/usr/bin/env node
/**
 * Pont d'aperçu : une image live de la fenetre Electron, dans le navigateur.
 *
 * L'application est un poste de travail, pas un site : il n'y a rien a ouvrir
 * sur un port pour la voir. Ce petit serveur fait les deux bouts : il capture le
 * framebuffer du serveur X virtuel et il renvoie les clics et les touches a ce
 * meme X. Ce qu'on voit dans l'onglet est donc l'app elle-même, pas une maquette
 * - et ce qu'on y tape lui parvient vraiment.
 *
 * Aucun dependance : `import` (ImageMagick) et `xdotool` sont deja la, et le CDP
 * est parle a cru avec le WebSocket global de Node (drapeau
 * --experimental-websocket sous Node 20).
 *
 *   DISPLAY=:99 XAUTHORITY=/tmp/xvfb-run.XXXX/Xauthority \
 *     node --experimental-websocket tools/preview-bridge.mjs
 */

import { execFile, spawn } from 'node:child_process';
import http from 'node:http';

const DISPLAY = process.env.DISPLAY || ':99';
const PORT = Number(process.env.PREVIEW_PORT || 8080);
const CDP = process.env.CDP_PORT || '9229';
const FRAME_MS = Number(process.env.PREVIEW_EVERY || 700);
const JPEG_QUALITY = process.env.PREVIEW_QUALITY || '82';

const env = { ...process.env, DISPLAY };

/** Une frame, en JPEG, avec une compression choisie plutot qu'un PNG de 1,3 Mo. */
function grabFrame() {
  return new Promise((resolve, reject) => {
    const importProc = spawn('import', ['-window', 'root', '-silent', 'png:-']);
    const convert = spawn('convert', ['png:-', '-quality', JPEG_QUALITY, 'jpg:-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    convert.stdout.on('data', (c) => chunks.push(c));
    convert.stdout.once('end', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length > 1000) resolve(buf);
      else reject(new Error('image vide'));
    });
    importProc.stdout.pipe(convert.stdin);
    importProc.once('error', reject);
    convert.once('error', reject);
  });
}

// La derniere trame est gardee en memoire : le navigateur repasse la chercher
// toutes les FRAME_MS, et un client qui ouvre deux onglets ne declenche pas deux
// captures.
let latest = null;
let grabbedAt = 0;
let grabbing = false;
let lastError = null;

async function refresh() {
  if (grabbing) return;
  grabbing = true;
  try {
    latest = await grabFrame();
    grabbedAt = Date.now();
    lastError = null;
  } catch (err) {
    lastError = String(err && err.message ? err.message : err);
  } finally {
    grabbing = false;
  }
}
setInterval(refresh, FRAME_MS);
refresh();

// ---------------------------------------------------------------------------
// Ce que les boutons de la page ont le droit de faire dans l'app
//
// Les vues sont pilotees par CDP (le renderer expose window.hub), pas par des
// clics simulés : un clic a des coordonnees depend de la taille de la fenetre,
// une intention non. Les coordonnees, elles, servent au clic direct, qui est un
// service rendu, pas un mecanisme de navigation.
// ---------------------------------------------------------------------------

const ACTIONS = {
  home: `window.hub.setPage('home')`,
  favorites: `window.hub.setPage('favorites')`,
  settings: `window.hub.setPage('settings')`,
  help: `window.hub.setPage('help')`,
  close: `window.hub.setPage(null)`,
  appearance: `openSettings(2)`,
  notifications: `openSettings(3)`,
  storage: `openSettings(4)`,
  services: `openSettings(5)`,
  privacy: `openSettings(6)`,
  advanced: `openSettings(7)`,
  dnd: `document.getElementById('dnd-btn').click()`,
  mixer: `document.getElementById('mixer-btn').click()`,
  fullscreen: `window.hub.windowControl('fullscreen')`,
  maximize: `window.hub.windowControl('maximize')`,
  glass: `cycle('glass', ['soft', 'full', 'off'])`,
  theme: `cycle('theme', ['light', 'dark', 'system'])`,
  animations: `toggle('animations')`,
};

// Aide locale : `setPage` est un send IPC, il ne renvoie rien a attendre, donc la
// rubrique est ouverte apres un court delai - le temps que le main reponde et que
// le renderer ait construit les boutons. Chainer un .then sur undefined cassait
// l'action en silence pour l'utilisateur.
const PRELUDE = `
  const nav = (i) => {
    const buttons = document.querySelectorAll('.settings-nav button');
    buttons[i - 1]?.click();
    return 'rubrique ' + i + ' sur ' + buttons.length;
  };
  const cycle = async (key, order) => {
    const now = (await window.hub.settings())[key];
    const next = order[(order.indexOf(now) + 1) % order.length];
    await window.hub.updateSettings({ [key]: next });
    return key + ' = ' + next;
  };
  const toggle = async (key) => {
    const now = (await window.hub.settings())[key];
    await window.hub.updateSettings({ [key]: !now });
    return key + ' = ' + !now;
  };
  const openSettings = async (i) => {
    window.hub.setPage('settings');
    await new Promise((r) => setTimeout(r, 320));
    return nav(i);
  };
`;

let ws = null;
let msgId = 0;
const pending = new Map();
let queue = Promise.resolve();
/** Les evaluations CDP sont mises en file : deux ordres entrelaces dans le meme
 * contexte rendent le resultat indechiffrable, et la page ne mérite pas ça. */
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

async function connect() {
  if (ws && ws.readyState === 1) return ws;
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!page) throw new Error("page de l'app introuvable sur le port CDP " + CDP);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('websocket CDP refuse'));
    setTimeout(() => reject(new Error('timeout de connexion CDP')), 4000);
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  ws.onclose = () => { ws = null; };
  await send('Runtime.enable');
  return ws;
}

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  await connect();
  return serial(async () => {
  const result = await send('Runtime.evaluate', {
    // L'expression est evaluee comme une valeur : sans ce `return`, une promesse
    // n'etait jamais attendue et le bouton affichait un succes creux.
    expression: `(() => { ${PRELUDE}
      const __value = (${expression});
      return (__value && typeof __value.then === 'function') ? __value : String(__value);
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.result?.exceptionDetails) {
    throw new Error(result.result.exceptionDetails.exception?.description || result.result.exceptionDetails.text);
  }
  return result.result?.result?.value;
  });
}

const KEYS = ['Return', 'Escape', 'Tab', 'BackSpace', 'Delete', 'space'];
function pressKey(name) {
  return new Promise((resolve, reject) => {
    if (!KEYS.includes(name)) return reject(new Error('touche non autorisee'));
    execFile('xdotool', ['key', '--clearmodifiers', name], { env }, (err) => (err ? reject(err) : resolve('ok')));
  });
}

function typeText(text) {
  return new Promise((resolve, reject) => {
    const clean = String(text).slice(0, 200);
    if (!clean) return resolve('rien a taper');
    execFile('xdotool', ['type', '--clearmodifiers', '--delay', '12', clean], { env }, (err) => (err ? reject(err) : resolve('ok')));
  });
}

function clickAt(x, y, button) {
  return new Promise((resolve, reject) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return reject(new Error('coordonnees invalides'));
    const args = ['mousemove', Math.round(x), Math.round(y), 'click', button === 'right' ? '3' : '1'];
    execFile('xdotool', args, { env }, (err) => (err ? reject(err) : resolve('ok')));
  });
}

// ---------------------------------------------------------------------------
// La page
// ---------------------------------------------------------------------------

const BUTTONS = [
  ['home', 'Accueil'], ['favorites', 'Favoris'], ['close', 'Revenir au service'], ['help', 'Aide'],
  ['-', ''],
  ['settings', 'Reglages'], ['appearance', 'Apparence'], ['notifications', 'Notifications'], ['storage', 'Stockage'],
  ['services', 'Services'], ['privacy', 'Confidentialite'], ['advanced', 'Avance'],
  ['-', ''],
  ['glass', 'Verre'], ['theme', 'Theme'], ['animations', 'Animations'], ['dnd', 'Ne pas deranger'],
  ['mixer', 'Melangeur'], ['maximize', 'Agrandir'], ['fullscreen', 'Plein ecran'],
];

function page() {
  const buttons = BUTTONS.map(([id, label]) => id === '-'
    ? '<span class="sep"></span>'
    : `<button data-act="${id}">${label}</button>`).join('');
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store">
<title>Soocial - apercu live</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0d12; color: #e8eaf0; font: 13px/1.4 system-ui, "Segoe UI", sans-serif; }
  header { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 10px 14px; background: #12151d; border-bottom: 1px solid #1e2330; position: sticky; top: 0; }
  h1 { font-size: 13px; margin: 0 8px 0 0; font-weight: 600; letter-spacing: .02em; }
  button, select, input { font: inherit; color: #e8eaf0; background: #1b2030; border: 1px solid #2b3348; border-radius: 7px; padding: 5px 9px; cursor: pointer; }
  button:hover { background: #232a3d; }
  button:active { transform: translateY(1px); }
  input { cursor: text; width: 190px; }
  .grow { flex: 1 1 auto; }
  #status { opacity: .65; font-variant-numeric: tabular-nums; }
  main { padding: 14px; }
  #frame { position: relative; display: block; max-width: 100%; border-radius: 10px; overflow: hidden; background: #000; }
  #frame img { display: block; width: 100%; }
  #frame.busy { cursor: progress; }
  #frame.right { cursor: context-menu; }
  .hint { opacity: .6; margin: 8px 2px 0; }
  .toggle { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border: 1px solid #2b3348; border-radius: 7px; background: #1b2030; }
</style></head>
<body>
<header>
  <h1>Soocial - apercu live</h1>
  ${buttons}
  <span class="sep"></span>
  <label class="toggle"><input type="checkbox" id="rightclick"> clic droit</label>
  <select id="keys">
    <option value="">touche…</option>
    ${KEYS.map((k) => `<option>${k}</option>`).join('')}
  </select>
  <input id="type" placeholder="taper dans la fenetre puis Entree" autocomplete="off">
  <span class="grow"></span>
  <span id="status">…</span>
</header>
<main>
  <div id="frame"><img id="shot" alt="capturer la fenetre Soocial"></div>
  <p class="hint">
    L'image vient du serveur X virtuel : ce que vous voyez est l'application en cours,
    et un clic (avec la case « clic droit » pour le menu des services) lui est transmis.
    Les boutons du haut pilotent les vues par le protocole de debug, pas par des coordonnees.
  </p>
</main>
<script>
const img = document.getElementById('shot');
const status = document.getElementById('status');
const frame = document.getElementById('frame');
let busy = false;

async function pull() {
  if (busy) return;
  busy = true;
  try {
    const r = await fetch('/shot?t=' + Date.now());
    if (!r.ok) throw new Error('pas de trame');
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    img.onload = () => URL.revokeObjectURL(url);
    img.src = url;
    status.textContent = Math.round(blob.size / 1024) + ' Ko - ' + new Date().toLocaleTimeString();
  } catch (e) {
    status.textContent = 'capture indisponible';
  } finally {
    busy = false;
  }
}
pull();
setInterval(pull, 800);

async function act(path) {
  frame.classList.add('busy');
  try {
    const r = await fetch(path);
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || 'echec');
    status.textContent = 'ok: ' + (body.result ?? '');
  } catch (e) {
    status.textContent = 'erreur: ' + e.message;
  } finally {
    frame.classList.remove('busy');
    pull();
  }
}

for (const b of document.querySelectorAll('header button')) {
  b.addEventListener('click', () => act('/act/' + b.dataset.act));
}

frame.addEventListener('click', async (ev) => {
  const rect = img.getBoundingClientRect();
  const sx = (img.naturalWidth || 1440) / rect.width, sy = (img.naturalHeight || 900) / rect.height;
  const right = document.getElementById('rightclick').checked;
  await act('/click?x=' + Math.round((ev.clientX - rect.left) * sx)
    + '&y=' + Math.round((ev.clientY - rect.top) * sy) + (right ? '&b=right' : ''));
});

document.getElementById('keys').addEventListener('change', (ev) => {
  if (ev.target.value) { act('/key?k=' + encodeURIComponent(ev.target.value)); ev.target.value = ''; }
});
document.getElementById('type').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  act('/type?t=' + encodeURIComponent(ev.target.value));
  ev.target.value = '';
});
</script>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(page());
  }

  if (url.pathname === '/shot') {
    if (!latest) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      return res.end(lastError || 'aucune trame pour le moment');
    }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
    return res.end(latest);
  }

  const send200 = (obj) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const sendErr = (code, message) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: message }));
  };

  try {
    if (url.pathname.startsWith('/act/')) {
      const name = url.pathname.slice(5);
      const expression = ACTIONS[name];
      if (!expression) return sendErr(404, 'action inconnue');
      const result = await evaluate(expression);
      await refresh();
      return send200({ ok: true, result: result === undefined ? name : String(result) });
    }
    if (url.pathname === '/click') {
      await clickAt(Number(url.searchParams.get('x')), Number(url.searchParams.get('y')), url.searchParams.get('b'));
      setTimeout(refresh, 120);
      return send200({ ok: true });
    }
    if (url.pathname === '/key') {
      await pressKey(url.searchParams.get('k'));
      setTimeout(refresh, 120);
      return send200({ ok: true });
    }
    if (url.pathname === '/type') {
      await typeText(url.searchParams.get('t') || '');
      setTimeout(refresh, 120);
      return send200({ ok: true });
    }
  } catch (err) {
    return sendErr(500, String(err && err.message ? err.message : err));
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('ok: / /shot /act/<nom> /click /key /type');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[preview] http://0.0.0.0:${PORT}  (DISPLAY=${DISPLAY}, CDP=${CDP})`);
});

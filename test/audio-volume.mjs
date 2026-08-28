// Test du gain audio par service, via CDP.
//
// Il ne verifie pas que l'application applique le bon niveau — ca, les logs le
// disent — mais que le patch lui-meme attenue reellement les deux chemins
// audio : les balises <audio>/<video> et l'API Web Audio. C'est le second qui
// compte le plus : Discord y fait passer ses sons, et .volume n'a aucun effet
// dessus, donc une regression y serait silencieuse.
//
// Prerequis : instance lancee avec --remote-debugging-port.
//   npm run dev -- --remote-debugging-port=9225
//   node test/audio-volume.mjs 9225

import { volumePatch } from '../audio.js';

const PORT = process.argv[2] || '9225';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

let page;
for (let i = 0; i < 30 && !page; i++) {
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
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
};

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

async function evalJs(expression) {
  const reply = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const details = reply.result?.exceptionDetails;
  if (details) return { __threw: details.exception?.description || details.text };
  return reply.result?.result?.value;
}

// --- Le patch s'installe -----------------------------------------------------

const applied = await evalJs(volumePatch(0.5));
check('le patch s applique', typeof applied === 'string' && applied.startsWith('50 %'), String(applied));

const installed = await evalJs('[window.__soocialMediaPatched, window.__soocialAudioPatched].join()');
check('les deux enveloppes sont posees', installed === 'true,true', String(installed));

// --- Chemin 1 : <audio> ------------------------------------------------------

// On lit le volume reel via le descripteur d'origine : le getter enveloppe rend
// la valeur voulue par la page, pas celle qui part vraiment vers la sortie.
const mediaAt50 = await evalJs(`(() => {
  const el = new Audio();
  el.volume = 1;
  return window.__soocialMediaDesc.get.call(el);
})()`);
check('un <audio> a 1 sort a 0.5', mediaAt50 === 0.5, String(mediaAt50));

const wanted = await evalJs(`(() => {
  const el = new Audio();
  el.volume = 0.8;
  return el.volume;
})()`);
check('la page relit sa propre valeur, pas la notre', wanted === 0.8, String(wanted));

const halfOfHalf = await evalJs(`(() => {
  const el = new Audio();
  el.volume = 0.5;
  return window.__soocialMediaDesc.get.call(el);
})()`);
check('le reglage du site est module, pas ecrase', halfOfHalf === 0.25, String(halfOfHalf));

// --- Chemin 2 : Web Audio ----------------------------------------------------

const gainValue = await evalJs(`(() => {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  osc.connect(ctx.destination);
  window.__soocialTestCtx = ctx;
  return ctx.__soocialGain ? ctx.__soocialGain.gain.value : null;
})()`);
check('un GainNode est interpose avant la destination', gainValue === 0.5, String(gainValue));

const rerouted = await evalJs(`(() => {
  const ctx = window.__soocialTestCtx;
  const osc = ctx.createOscillator();
  // connect() doit rendre le gain, pas la destination : c est la preuve que le
  // signal ne court-circuite pas notre noeud.
  return osc.connect(ctx.destination) === ctx.__soocialGain;
})()`);
check('le signal passe par le gain, pas par la destination', rerouted === true, String(rerouted));

// --- Reinjection : le niveau change, les enveloppes restent ------------------

await evalJs(volumePatch(0.2));

const gainAfter = await evalJs('window.__soocialTestCtx.__soocialGain.gain.value');
check('un contexte deja cree suit le nouveau niveau', Math.abs(gainAfter - 0.2) < 1e-6, String(gainAfter));

const mediaAfter = await evalJs(`(() => {
  const el = new Audio();
  el.volume = 1;
  return window.__soocialMediaDesc.get.call(el);
})()`);
check('un nouveau media suit le nouveau niveau', Math.abs(mediaAfter - 0.2) < 1e-6, String(mediaAfter));

const once = await evalJs('window.__soocialGains.length');
check('aucune enveloppe en double apres reinjection', once === 1, `${once} gain(s)`);

// --- Coupure totale ----------------------------------------------------------

await evalJs(volumePatch(0));

const silent = await evalJs(`(() => {
  const el = new Audio();
  el.volume = 1;
  return [window.__soocialMediaDesc.get.call(el), window.__soocialTestCtx.__soocialGain.gain.value].join();
})()`);
check('a zero, les deux chemins sont muets', silent === '0,0', String(silent));

// --- Nettoyage ---------------------------------------------------------------

await evalJs('window.__soocialTestCtx.close(); delete window.__soocialTestCtx;');
await evalJs(volumePatch(1));

ws.close();
console.log(failures ? `\n${failures} echec(s)` : '\nTout est vert');
process.exit(failures ? 1 : 0);

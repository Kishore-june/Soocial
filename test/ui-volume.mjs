// Test UI des surfaces de volume de Soocial, via CDP.
//
// Pastille d etat sur la tuile, molette avec repere fugace, bouton et panneau
// melangeur. Les libelles dependent de la langue du profil : on teste le sens,
// pas le mot — et le service se retrouve par son id, pas par son nom, les deux
// ne se correspondant pas forcement.
//
// Prerequis : instance lancee avec --remote-debugging-port.
//   npm run dev -- --remote-debugging-port=9226
//   node test/ui-volume.mjs 9226
const PORT = process.argv[2] || '9226';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) fails++;
};

let page;
for (let i = 0; i < 30 && !page; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
  } catch {}
  if (!page) await sleep(500);
}
if (!page) { console.error('page sidebar introuvable'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const ev = (expression) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, (m) => resolve(m.result?.result?.value));
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
});

const ID = 'discord-pro';
const TILE = `document.querySelector('.service[data-id="${ID}"]')`;
const VOL = `${TILE}.querySelector(".vol")`;

const lang = await ev('document.documentElement.lang');
const name = await ev(`items.get("${ID}")?.service.name`);
if (!name) {
  // Le sujet du test est la molette, pas le profil : a defaut de service deja la,
  // on le cree. Sortir ici laisserait un test "non execute" sans raison visible.
  await ev(`window.hub.saveService({ name: "Discord pro", url: "https://discord.com/app" })`);
  await sleep(1500);
}
const tested = await ev(`items.get("${ID}")?.service.name`);
if (!tested) {
  console.error(`FAIL service "${ID}" toujours absent apres creation - le test n'a pas de sujet`);
  process.exit(1);
}
console.log(`profil en "${lang}", service teste : ${ID} = "${tested}"\n`);

// --- surfaces visibles -------------------------------------------------------
check('bouton melangeur present', await ev('Boolean(document.getElementById("mixer-btn"))'));
check('repere de molette present', await ev(`Boolean(${TILE}.querySelector(".vol-gauge"))`));

const btnTitle = await ev('document.getElementById("mixer-btn").title');
check('infobulle du bouton traduite', Boolean(btnTitle) && btnTitle !== 'sidebar.mixer', btnTitle);

// --- pastille : rien a 100 % -------------------------------------------------
await ev(`window.hub.setVolume("${ID}", 100)`);
await sleep(400);
check('rien ne s affiche a 100 %', (await ev(`${TILE}.classList.contains("has-vol")`)) === false);

// --- pastille : volume baisse ------------------------------------------------
await ev(`window.hub.setVolume("${ID}", 25)`);
await sleep(400);
check('pastille visible a 25 %', (await ev(`${TILE}.classList.contains("has-vol")`)) === true);
check('pastille non rouge a 25 %', (await ev(`${VOL}.classList.contains("off")`)) === false);
check('pastille effectivement peinte', (await ev(`getComputedStyle(${VOL}).display`)) === 'grid');

const t25 = await ev(`${VOL}.title`);
check('infobulle indique la valeur', t25.includes('25') && !t25.startsWith('tile.'), t25);

// --- pastille : coupure ------------------------------------------------------
await ev(`window.hub.setVolume("${ID}", 0)`);
await sleep(400);
check('pastille rouge a 0 %', (await ev(`${VOL}.classList.contains("off")`)) === true);

const tOff = await ev(`${VOL}.title`);
check('infobulle distincte pour la coupure', Boolean(tOff) && tOff !== t25 && !tOff.startsWith('tile.'), tOff);

// --- molette -----------------------------------------------------------------
await ev(`window.hub.setVolume("${ID}", 50)`);
await sleep(350);
await ev(`${TILE}.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }))`);
await sleep(150);

const tWheel = await ev(`${VOL}.title`);
check('la molette monte le volume de 5', tWheel.includes('55'), tWheel);
check('le repere s affiche', (await ev(`${TILE}.classList.contains("tuning")`)) === true);
check('le repere montre la valeur', (await ev(`${TILE}.querySelector(".vol-gauge-val").textContent`)) === '55');

// Le controle qui compte. Au-dela de la sidebar commence la vue du service,
// une couche native peinte par-dessus le HTML : un repere pose la resterait
// dans le DOM, repondrait aux mesures, et ne s'afficherait jamais. Verifier
// qu'il n'est pas "hidden" ne prouve donc rien — il faut sa geometrie.
const inside = await ev(`(() => {
  const strip = document.getElementById('sidebar').getBoundingClientRect();
  const gauge = ${TILE}.querySelector('.vol-gauge').getBoundingClientRect();
  return JSON.stringify({
    ok: gauge.width > 0 && gauge.height > 0 && gauge.right <= strip.right + 1,
    gauge: Math.round(gauge.right),
    strip: Math.round(strip.right),
  });
})()`);
const geo = JSON.parse(inside);
check('le repere tient dans la sidebar, hors de la couche native', geo.ok,
  `bord droit ${geo.gauge}px, sidebar ${geo.strip}px`);

await ev(`${TILE}.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }))`);
await sleep(150);
check('la molette redescend', (await ev(`${VOL}.title`)).includes('50'), await ev(`${VOL}.title`));

await sleep(1300);
check('le repere disparait tout seul', (await ev(`${TILE}.classList.contains("tuning")`)) === false);

// --- panneau melangeur -------------------------------------------------------
await ev('document.getElementById("mixer-btn").click()');
await sleep(350);
check('le bouton ouvre le melangeur', (await ev('document.getElementById("mixer").classList.contains("hidden")')) === false);
// Le nombre de lignes suit le profil, pas un chiffre ecrit ici : ce qui compte
// est "une ligne par service, plus la generale".
const mixerRows = await ev('document.querySelectorAll("#mixer-rows .mixer-row").length');
const serviceCount = await ev('items.size');
check(`une ligne generale plus ${serviceCount} service(s)`, mixerRows === serviceCount + 1, `${mixerRows} rangees`);
check('la ligne generale est en tete', (await ev('document.querySelector("#mixer-rows .mixer-row").classList.contains("master")')) === true);

// La ligne se retrouve par le nom que l'application donne au service : dans
// cette configuration, l'id et le nom ne se correspondent pas.
const rowValue = await ev(`(() => {
  const wanted = items.get("${ID}").service.name;
  const row = [...document.querySelectorAll("#mixer-rows .mixer-row")]
    .find((r) => r.querySelector(".mixer-name").textContent === wanted);
  return row ? row.querySelector(".mixer-slider").value : "ligne introuvable";
})()`);
check('le curseur du melangeur reflete la molette', rowValue === '50', rowValue);

// Le general doit exister et ne pas toucher aux valeurs des services.
await ev('document.querySelector("#mixer-rows .mixer-row.master .mixer-slider").value = 40');
await ev('document.querySelector("#mixer-rows .mixer-row.master .mixer-slider").dispatchEvent(new Event("input", { bubbles: true }))');
await sleep(400);
check('le general ne modifie pas le volume des services',
  (await ev(`items.get("${ID}").service.volume`)) === 50,
  String(await ev(`items.get("${ID}").service.volume`)));

await ev('window.hub.setMasterVolume(100)');
await sleep(250);

await ev('document.getElementById("mixer-close").click()');
await sleep(250);
check('le melangeur se referme', (await ev('document.getElementById("mixer").classList.contains("hidden")')) === true);

// --- remise a zero -----------------------------------------------------------
await ev(`window.hub.setVolume("${ID}", 100)`);
await sleep(300);
check('retour a 100 %, pastille retiree', (await ev(`${TILE}.classList.contains("has-vol")`)) === false);

ws.close();
console.log(fails ? `\n${fails} echec(s)` : '\nTout est vert');
process.exit(fails ? 1 : 0);

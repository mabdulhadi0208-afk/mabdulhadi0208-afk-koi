// Koi test harness (Linux/xvfb). Loads ../main.js with a fake /Applications and, with KOI_SIM=1, the cost macOS
// pays on a cold start: QuickLook thumbnails are serialized (~120 ms each) and `ps -axo comm=` takes ~120 ms.
// Measures: time from "summon" to the overlay being shown and to the first fan frame on screen, rAF deltas while
// the fan opens, and idle CPU of every Koi process (app.getAppMetrics) over KOI_CPU seconds.
//   xvfb-run -a npx electron test/harness.js --no-sandbox
// env: KOI_SIM=1  KOI_LABEL=before|after  KOI_CPU=30  KOI_SHOTS=/tmp/lumen-shots/42-koi-<label>  KOI_RUNS=3
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const LABEL = process.env.KOI_LABEL || 'run', SIM = process.env.KOI_SIM === '1', CPU_S = +(process.env.KOI_CPU || 30), RUNS = +(process.env.KOI_RUNS || 3);
const SHOTS = process.env.KOI_SHOTS || '';
const LOG = `/tmp/koi-perf-${LABEL}.log`; fs.writeFileSync(LOG, '');
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const { SIM: _s, ud, iconCalls } = require('./fake-mac');
const wins = new Set(); app.on('browser-window-created', (_e, w) => wins.add(w));
require('../main.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const overlay = () => [...wins].find(w => !w.isDestroyed() && /app\.html/.test(w.webContents.getURL()) && /mode=overlay/.test(w.webContents.getURL()));
const summon = () => app.emit('second-instance');

async function cpuSample(sec, tag) {
  app.getAppMetrics(); await sleep(1000); const per = []; const byType = {};
  for (let i = 0; i < sec; i++) { await sleep(1000); const m = app.getAppMetrics(); let s = 0; for (const p of m) { s += p.cpu.percentCPUUsage; byType[p.type] = (byType[p.type] || 0) + p.cpu.percentCPUUsage; } per.push(s); }
  const avg = per.reduce((a, b) => a + b, 0) / per.length; Object.keys(byType).forEach(k => byType[k] = +(byType[k] / sec).toFixed(3));
  log(`CPU ${tag}: avg ${avg.toFixed(3)}% max ${Math.max(...per).toFixed(2)}% over ${sec}s procs=${app.getAppMetrics().length} byType=${JSON.stringify(byType)}`);
  return avg;
}
const FRAME_PROBE = `new Promise(res=>{const d=[];let l=performance.now(),first=null;const t0=performance.now();
 (function f(n){d.push(n-l);l=n;if(first===null){const w=[...document.querySelectorAll('.w')].filter(e=>+getComputedStyle(e).opacity>.15);if(w.length)first=performance.timeOrigin+n}
 if(n-t0<900)requestAnimationFrame(f);else res({first,deltas:d.slice(1).map(x=>+x.toFixed(1)),wedges:document.querySelectorAll('.w').length})})(l)})`;

async function measureOpen(i) {
  const t0 = Date.now(); let shownAt = 0;
  const w0 = overlay(); if (w0) w0.once('show', () => { shownAt = Date.now(); });
  summon();
  for (let k = 0; k < 2000 && !overlay(); k++) await sleep(2);
  const w = overlay(); if (!w0) w.once('show', () => { shownAt = Date.now(); });
  for (let k = 0; k < 6000 && !w.isVisible(); k++) await sleep(2);
  if (!shownAt) shownAt = Date.now();
  const r = await w.webContents.executeJavaScript(FRAME_PROBE);
  const firstFan = r.first ? Math.round(r.first - t0) : -1, d = r.deltas, avg = d.reduce((a, b) => a + b, 0) / Math.max(1, d.length);
  log(`OPEN#${i}: show=${shownAt - t0}ms firstFanFrame=${firstFan}ms wedges=${r.wedges} rAF avg=${avg.toFixed(1)}ms max=${Math.max(...d).toFixed(1)}ms >20ms=${d.filter(x => x > 20).length}/${d.length} iconCalls=${iconCalls.n}`);
  return { show: shownAt - t0, firstFan, avg, max: Math.max(...d) };
}
async function shot(w, name) {
  if (!SHOTS || !w) return;
  await w.webContents.insertCSS(`body::before{content:'';position:fixed;inset:0;z-index:0;background:radial-gradient(60% 70% at 20% 20%,#3b2a6e,transparent 70%),radial-gradient(60% 60% at 85% 80%,#123d5c,transparent 70%),linear-gradient(160deg,#1a1330,#0c1424)}`);
  await sleep(120); const img = await w.webContents.capturePage(); fs.writeFileSync(`${SHOTS}-${name}.png`, img.toPNG()); log('SHOT', `${SHOTS}-${name}.png`);
}

app.whenReady().then(async () => {
  const tReady = Date.now();
  await sleep(+(process.env.KOI_SETTLE || 9000));                        // let startup work (pre-warm, update check) finish
  log(`LABEL ${LABEL} sim=${SIM} electron=${process.versions.electron} settle=${Date.now() - tReady}ms`);
  const idle0 = await cpuSample(Math.min(10, CPU_S), 'idle-before-first-open');
  const res = [];
  for (let i = 1; i <= RUNS; i++) {
    res.push(await measureOpen(i)); await sleep(700);
    if (i === 1) await shot(overlay(), 'fan');
    const w = overlay(); if (w) w.webContents.send('koi:hide'); app.emit('koi-test-hide'); try { require('electron').ipcMain.emit('koi:hide', {}); } catch {}
    await sleep(900);
    log(`after close: overlay visible=${overlay() && overlay().isVisible()}`);
  }
  const idle = await cpuSample(CPU_S, 'idle-after-use');
  const out = { label: LABEL, sim: SIM, opens: res, idleBefore: idle0, idle };
  fs.writeFileSync(`/tmp/koi-perf-${LABEL}.json`, JSON.stringify(out, null, 1));
  log('RESULT', JSON.stringify(out));
  app.exit(0);
});

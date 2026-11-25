// Koi cold-open test (Linux/xvfb): the first open after a long idle must be as smooth as a warm open.
// It forces the paths a long idle takes on a Mac: the hidden overlay is backgrounded (renderer hidden, timers
// throttled, frames evicted), Chromium's intensive wake-up throttling is switched on after 5 s instead of
// 5 minutes, and V8 throws away compiled code and collects garbage (--stress-flush-code + gc()). Then the fan is
// summoned the way the owner does it: Command goes down, then Option, through Koi's chord path.
//   xvfb-run -a npx electron test/coldopen.js --no-sandbox        env: KOI_IDLE=20 (seconds)  KOI_LABEL=after
// Prints PASS/FAIL lines and the numbers, also /tmp/koi-coldopen-<label>.log
const { app } = require('electron');
app.commandLine.appendSwitch('enable-features', 'IntensiveWakeUpThrottling:grace_period_seconds/5');
app.commandLine.appendSwitch('js-flags', '--expose-gc --stress-flush-code');
const fs = require('fs');
const IDLE = +(process.env.KOI_IDLE || 20), LABEL = process.env.KOI_LABEL || 'run';
const LOG = `/tmp/koi-coldopen-${LABEL}.log`; fs.writeFileSync(LOG, '');
let fails = 0; const out = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const ok = (c, m) => { out((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
require('./fake-mac');
const wins = new Set(); app.on('browser-window-created', (_e, w) => wins.add(w));
require('../main.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const overlay = () => [...wins].find(w => !w.isDestroyed() && /mode=overlay/.test(w.webContents.getURL()));
const CMD = 3675, OPT = 56;
// installed before the summon: records every frame and every long task for 900 ms after the fan is asked to show
const ARM = `(()=>{const r=window.__m={d:[],lt:0,lmax:0,first:null,t0:performance.now(),vis:document.visibilityState};
 try{new PerformanceObserver(l=>{for(const e of l.getEntries()){r.lt+=e.duration;r.lmax=Math.max(r.lmax,e.duration)}}).observe({entryTypes:['longtask']})}catch(e){}
 let last=performance.now();(function f(n){r.d.push(n-last);last=n;if(r.first===null){const w=[...document.querySelectorAll('.w')].filter(e=>+getComputedStyle(e).opacity>.15);if(w.length)r.first=n-r.t0}
 if(n-r.t0<900)requestAnimationFrame(f)})(last);return true})()`;
async function measure(tag, T) {
  const w = overlay();
  await w.webContents.executeJavaScript(ARM).catch(() => {});
  const t0 = Date.now();
  T.perm.key('down', CMD); await sleep(90); T.perm.key('down', OPT);          // Command first, then Option
  const shown = Date.now() - t0;
  await sleep(1100); T.perm.key('up', OPT); T.perm.key('up', CMD);
  const r = await w.webContents.executeJavaScript('window.__m');r.lag = await w.webContents.executeJavaScript('window.__koiShowLag');
  const d = r.d.slice(1), max = Math.max(...d), slow = d.filter(x => x > 20).length;
  const res = { ipcLag: r.lag, first: r.first === null ? -1 : Math.round(r.first), max: +max.toFixed(1), slow, frames: d.length, longTasks: Math.round(r.lt), longest: Math.round(r.lmax), vis: r.vis };
  out(`${tag}: ${JSON.stringify(res)}`);
  T.hide(); await sleep(700);
  return res;
}
app.whenReady().then(async () => {
  const T = global.__koiTest; T.perm.fakeHook();
  T.setHotkeys('Command+Alt', []);
  await sleep(9000);                                                        // pre-warm finishes
  await measure('warm-0', T); const warm = await measure('warm', T);
  out(`idling ${IDLE} s with the fan hidden...`);
  await sleep(IDLE * 1000);
  const w = overlay();
  out('hidden overlay renderer sees: ' + await w.webContents.executeJavaScript('document.visibilityState'));
  await w.webContents.executeJavaScript('for(let i=0;i<4;i++)window.gc&&gc()').catch(() => {}); // V8 drops code and garbage, as after minutes of idle
  const cold = await measure('cold', T);
  ok(cold.ipcLag <= warm.ipcLag + 30, `cold renderer answers the show in ${cold.ipcLag} ms vs warm ${warm.ipcLag} ms`);
  ok(cold.vis === 'visible', `the hidden fan is never backgrounded (renderer saw "${cold.vis}" while hidden)`);
  ok(T.warmN() > 0, 'pressing Command (the first key of the chord) warmed the fan up');
  ok(cold.max <= Math.max(50, warm.max * 1.6), `cold worst frame ${cold.max} ms vs warm ${warm.max} ms`);
  ok(cold.longTasks <= warm.longTasks + 60, `cold long tasks ${cold.longTasks} ms vs warm ${warm.longTasks} ms`);
  app.getAppMetrics(); await sleep(6000);
  const cpu = app.getAppMetrics().reduce((s, p) => s + p.cpu.percentCPUUsage, 0);
  ok(cpu < 1.5, `idle CPU after the opens stays near zero (${cpu.toFixed(2)}%)`);
  out(fails ? `DONE with ${fails} FAIL` : 'DONE all PASS');
  app.exit(fails ? 1 : 0);
});

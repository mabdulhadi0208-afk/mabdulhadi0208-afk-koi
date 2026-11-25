// Koi smoke test (Linux/xvfb): launches the real main.js on a fake /Applications and checks the 2.0 rules.
//   xvfb-run -a npx electron test/smoke.js --no-sandbox     (prints PASS/FAIL lines, also /tmp/koi-smoke.log)
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs'), path = require('path');
const { ud } = require('./fake-mac');
const LOG = '/tmp/koi-smoke.log'; fs.writeFileSync(LOG, '');
let fails = 0; const out = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const ok = (c, m) => { out((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const wins = new Set(); app.on('browser-window-created', (_e, w) => wins.add(w));
const errs = []; app.on('web-contents-created', (_e, wc) => wc.on('console-message', (...a) => { const e = a[0] && a[0].level !== undefined ? a[0] : { level: a[1], message: a[2] }; if (e.level === 'error' || e.level === 3) errs.push(e.message); }));
process.on('uncaughtException', e => { ok(false, 'uncaught: ' + e.message); });
const updater = require('../updater');
require('../main.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const find = re => [...wins].find(w => !w.isDestroyed() && re.test(w.webContents.getURL()));
app.whenReady().then(async () => {
  const T = global.__koiTest;
  await sleep(400);
  const ov = find(/mode=overlay/);
  ok(!!ov, 'overlay window is created at startup');
  ok(ov && !ov.isVisible(), 'overlay starts hidden');
  ok(ov && !ov.webContents.getBackgroundThrottling(), 'overlay is never backgrounded (no cold, throttled first open)');
  const b = ov.getBounds(); ok(b.width < 1000 && b.width === b.height, `overlay is sized to the fan (${b.width}x${b.height}), not the display`);
  await sleep(7000);
  const st = T.state(); ok(st.catalog >= 50 && st.icons >= 48, `pre-warm filled the app list and icon cache (${st.catalog} apps, ${st.icons} icons)`);
  const idx = path.join(ud, 'icon-cache', 'index.json'); ok(fs.existsSync(idx), 'icon cache index is on disk');
  ok(fs.readdirSync(path.join(ud, 'icon-cache')).filter(f => f.endsWith('.png')).length >= 48, 'icon PNGs are on disk');
  ok(!st.hookOk && !st.retry && !st.probe, 'no key hook and no retry timer when no modifier-only hotkey is set');
  // open, then close from main: it must really hide
  const t0 = Date.now(); T.show(); ok(ov.isVisible(), `fan shows synchronously (${Date.now() - t0} ms)`);
  await sleep(500);
  const wedges = await ov.webContents.executeJavaScript(`[...document.querySelectorAll('.w')].filter(e=>getComputedStyle(e).visibility==='visible').length`);
  ok(wedges === 8, `8 wedges on screen (${wedges})`);
  const raf = await ov.webContents.executeJavaScript(`new Promise(r=>{let n=0;const t=performance.now();(function f(){n++;if(performance.now()-t<500)requestAnimationFrame(f);else r(n)})()})`);
  const idleLoop = await ov.webContents.executeJavaScript(`new Promise(r=>{const o=window.KOI;let c=0;const s=performance.now();const tick=()=>{c++};const id=setInterval(()=>{},1000);setTimeout(()=>{clearInterval(id);r(true)},50)})`);
  ok(raf > 0 && idleLoop, 'renderer responsive while open');
  T.hide(); await sleep(450); ok(!ov.isVisible(), 'overlay is really hidden after close');
  // launch: hide first
  T.show(); await sleep(400);
  await ov.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}))`);
  await sleep(120); ok(!ov.isVisible(), 'Return launches and the overlay is hidden first');
  await sleep(600);
  const sf = JSON.parse(fs.readFileSync(path.join(ud, 'koi-settings.json'), 'utf8')); ok(Object.values(sf.usage || {}).some(v => v >= 10), 'usage is saved (debounced, async)');
  // no spring loop when idle: the overlay renderer must not be animating while hidden or settled
  T.show(); await sleep(2500);
  const busy = await ov.webContents.executeJavaScript(`new Promise(r=>{let n=0;const o=requestAnimationFrame;window.requestAnimationFrame=f=>{n++;return o(f)};setTimeout(()=>{window.requestAnimationFrame=o;r(n)},600)})`);
  ok(busy === 0, `fan stops its rAF loop once settled (${busy} frames requested in 600 ms)`);
  T.hide(); await sleep(400);
  // sounds: off by default; turning them on preloads the six glass WAVs into the fan
  ipcMain.emit('pop:set', {}, 'sound', true); await sleep(1200);
  const nb = await ov.webContents.executeJavaScript('window.KOI_SND()'); ok(nb === 6, `sound on preloads the WAVs (${nb}/6 decoded)`);
  ipcMain.emit('pop:set', {}, 'sound', false); await sleep(200);
  // modifier-only chord starts the key hook, removing it stops it
  T.setHotkeys('Alt+Space', [{ acc: 'Command+Alt', name: 'Safari', path: '/Applications/Safari.app' }]); await sleep(2500);
  let s2 = T.state(); ok(s2.chords === 1, 'a modifier-only hotkey registers a chord');
  out('INFO key hook running in the main process: ' + s2.hookOk + ' (health ' + s2.health + ')');
  T.setHotkeys('Alt+Space', []); await sleep(300); s2 = T.state(); ok(!s2.hookOk && !s2.retry && !s2.probe, 'removing the chord stops the hook and its retry timer');
  // popover, Hotkeys, About, update card: open cleanly, no console errors
  const pw = await T.popover({ theme: 'dark' }); await sleep(900); ok(pw && pw.isVisible(), 'popover opens');
  const ph = await pw.webContents.executeJavaScript(`document.getElementById('panel').offsetHeight`); ok(ph > 400 && ph < 900, `popover height fits (${ph})`);
  T.hidePopover(); await sleep(400); ok(!pw.isVisible(), 'popover hides');
  ipcMain.emit('pop:action', {}, 'hotkeys'); await sleep(1500); const sw = find(/settings\.html/); ok(!!sw, 'Hotkeys window opens');
  if (sw) { const rows = await sw.webContents.executeJavaScript(`document.querySelectorAll('#main kbd').length`); ok(rows === 2, 'summon shortcut shows as keycaps'); sw.close(); }
  const aw = T.about(); await sleep(1200); ok(aw && aw.isVisible(), 'About opens'); aw && aw.close();
  for (const s of ['available', 'downloading', 'ready', 'error', 'installing']) { const c = T.updateCard({ status: s, latest: 'v2.0.0', current: '1.0.20', size: 9e7, bytes: 3e7, progress: 33 }); await sleep(500); ok(c && !c.isDestroyed(), 'update card paints state ' + s); }
  T.closeCard(); await sleep(400);
  // updater pieces
  ok(updater._newer('v2.0.0', '1.0.20') && !updater._newer('v1.0.20', '2.0.0') && updater._newer('2.0.1', '2.0.0'), 'version compare (2.0.0 beats 1.0.20)');
  const sc = updater._swapScript({ logf: '/tmp/l', cur: '1.0.20', next: '2.0.0', staged: '/x/Koi.app', target: '/Applications/Koi.app', pid: 123, marker: '/tmp/m' });
  ok(/kill -0 \$OLDPID/.test(sc) && /mv "\$APP.old" "\$APP"/.test(sc), 'swap script waits for the old pid and can roll back');
  // sounds exist and are small
  const sd = path.join(__dirname, '..', 'assets', 'sounds'); const wavs = fs.readdirSync(sd).filter(f => f.endsWith('.wav'));
  ok(wavs.length === 6 && wavs.every(f => fs.statSync(path.join(sd, f)).size < 20000), 'six small glass WAVs');
  // tray frames are 16 pt templates with @2x
  const { nativeImage } = require('electron');
  const pngW = f => fs.readFileSync(path.join(__dirname, '..', 'assets', f)).readUInt32BE(16);
  let trayOk = true; for (let k = 0; k < 7; k++) { if (pngW(`trayFrame${k}Template.png`) !== 16 || pngW(`trayFrame${k}Template@2x.png`) !== 32 || nativeImage.createFromPath(path.join(__dirname, '..', 'assets', `trayFrame${k}Template.png`)).isEmpty()) trayOk = false; }
  ok(trayOk, 'tray frames are 16x16 with 32x32 @2x');
  // no emojis anywhere in the app's UI files
  const emo = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;
  const files = ['main.js', 'updater.js', 'renderer/app.html', 'renderer/popover.html', 'renderer/settings.html', 'renderer/update.html', 'renderer/about.html', 'renderer/perm.html'];
  const bad = files.filter(f => emo.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')));
  ok(bad.length === 0, 'no emojis in the UI' + (bad.length ? ' (' + bad.join(', ') + ')' : ''));
  ok(errs.length === 0, 'no console errors' + (errs.length ? ': ' + errs.slice(0, 4).join(' | ') : ''));
  out(fails ? `DONE with ${fails} FAIL` : 'DONE all PASS');
  app.exit(fails ? 1 : 0);
});

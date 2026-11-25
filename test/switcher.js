// Koi 2.1 window switcher, end to end on Linux/xvfb: the real main.js and panel, with test/fake-switch.js standing in
// for the native helper (same JSON-lines protocol, over a real pipe). Checks the Cmd+Tab vs Command + Option chord in
// both orders, the gliding selection rim, spring scrolling, wheel, thumbnails, permission cards, the crash fallback,
// the Hotkeys section, and that nothing runs once the panel is closed. Screenshots go to /tmp/koi-shots/switcher-*.png.
//   xvfb-run -a npx electron test/switcher.js --no-sandbox      (PASS/FAIL lines, also /tmp/koi-switcher.log)
const path = require('path'), fs = require('fs'), os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-sw-'));
const STATE = path.join(tmp, 'state.json'), FLOG = path.join(tmp, 'fake.log');
const setState = o => fs.writeFileSync(STATE, JSON.stringify({ ax: true, screen: true, tap: 'on', n: 9, ...o }));
setState({});
process.env.KOI_SWITCH_HELPER = path.join(__dirname, 'fake-switch.js'); process.env.KOI_FAKE_STATE = STATE; process.env.KOI_FAKE_LOG = FLOG;
const { app, ipcMain, BrowserWindow, nativeImage } = require('electron');
require('./fake-mac');
const SHOTS = '/tmp/koi-shots'; fs.mkdirSync(SHOTS, { recursive: true });
const LOG = '/tmp/koi-switcher.log'; fs.writeFileSync(LOG, '');
let fails = 0; const out = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const ok = (c, m) => { out((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const errs = []; app.on('web-contents-created', (_e, wc) => wc.on('console-message', (...a) => { const e = a[0] && a[0].level !== undefined ? a[0] : { level: a[1], message: a[2] }; if (e.level === 'error' || e.level === 3) errs.push(e.message); }));
process.on('uncaughtException', e => ok(false, 'uncaught: ' + e.stack));
require('../main.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await f()) return true; } catch (e) {} await sleep(15); } return false; };
const CMD = 3675, OPT = 56;
const WALL = `html{background:radial-gradient(60% 70% at 20% 20%,#3b2a6e,transparent 70%),radial-gradient(60% 60% at 85% 80%,#123d5c,transparent 70%),linear-gradient(160deg,#1a1330,#0c1424)!important}`;
const WALL_L = `html{background:radial-gradient(50% 60% at 18% 22%,#ffc3e1 0,transparent 70%),radial-gradient(50% 60% at 88% 80%,#b9e4ff 0,transparent 70%),linear-gradient(160deg,#f3e9ff,#e6f2ff)!important}`;

app.whenReady().then(async () => {
  const T = global.__koiTest, sw = T.sw.core, P = T.perm, st = () => T.state();
  const emit = msg => sw.send({ cmd: '_emit', msg });
  const win = () => T.sw.win();
  const js = s => win().webContents.executeJavaScript(s);
  const sst = () => js('window.__sw.state()');
  const sent = c => sw.sent.filter(m => m.cmd === c);
  P.fakeHook();
  ok(await until(() => sw.status === 'ready', 5000), `the helper starts and its tap is ready (${sw.status})`);
  ok(win() && !win().isVisible() && !win().webContents.getBackgroundThrottling(), 'the panel window is created hidden and warm, never backgrounded');
  ok(win() && !win().isFocusable(), 'the panel never takes focus (the app you are in stays in front)');
  await sleep(1500);

  // ---- 1. open within a frame, thumbnails fill in ----
  let t0 = Date.now(), shownAt = 0; win().once('show', () => { shownAt = Date.now(); });
  emit({ ev: 'open', shift: false });
  ok(await until(() => win().isVisible(), 2000), 'Cmd+Tab shows the panel');
  const firstPaint = await js(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(+getComputedStyle(document.getElementById('panel')).opacity))))`);
  const lag = await js('window.__swLag');
  out(`INFO open: helper event to window shown ${shownAt - t0} ms, main to renderer ${lag} ms, panel opacity two frames later ${firstPaint}`);
  ok(lag <= 16 && firstPaint > 0, `the panel paints within a frame of the event (renderer got it in ${lag} ms, visible two frames later)`);
  // (under xvfb the real cursor sits still in the middle of the panel; Chromium sends it pointermoves as the tiles land)
  await sleep(300);
  let s = await sst(); ok(s.n === 9 && s.sel === 1, `9 windows, the first Tab selects the previous one, and a still cursor under the panel does not steal it (sel ${s.sel})`);
  ok(sent('ack').length === 1, 'the open is acked');
  ok(await until(async () => (await js(`document.querySelectorAll('.shot.has').length`)) >= 6, 3000), 'live thumbnails fill in progressively');

  // ---- 2. the rim glides: intermediate positions, not a jump ----
  await sleep(600);
  const from = (await sst()).halo;
  const trackP = js('window.__sw.track(500)'); await sleep(20); emit({ ev: 'next' });
  let tr = await trackP; s = await sst();
  const to = s.halo, dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const mids = tr.filter(p => { const d = Math.hypot(p.x - from[0], p.y - from[1]); return d > dist * .05 && d < dist * .95; });
  out(`INFO glide ${from} -> ${to}: ${tr.length} frames, ${mids.length} in between, path ${tr.filter((_, i) => i % 3 === 0).map(p => p.x).join(' ')}`);
  ok(s.sel === 2 && dist > 100, `Tab moves the selection (sel ${s.sel}, rim moves ${dist.toFixed(0)} px)`);
  ok(mids.length >= 4, `the rim glides through ${mids.length} intermediate frames (not a single-frame jump)`);
  const over = Math.max(...tr.map(p => p.x)) - to[0];
  ok(over < dist * .12, `lively but not over-bouncy: overshoot ${over.toFixed(1)} px of ${dist.toFixed(0)} px`);
  ok(s.scale[2] > 1.02 && s.scale[1] < 1.01, `the selected card swells, the previous one eases back (${s.scale[2]}, ${s.scale[1]})`);
  // frame strip of a glide (Shift+Tab back), cropped to the panel
  {
    const rect = await js(`(()=>{const r=document.getElementById('panel').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}})()`);
    await win().webContents.insertCSS(WALL); await sleep(500);
    const frames = []; emit({ ev: 'prev' }); const g0 = Date.now();
    for (const at of [0, 30, 60, 95, 140, 200, 320]) { await sleep(Math.max(0, g0 + at - Date.now())); frames.push((await win().webContents.capturePage(rect))); }
    const fw = Math.round(rect.width / 2), fh = Math.round(rect.height / 2), bufs = frames.map(f => f.resize({ width: fw, height: fh }).toBitmap());
    const strip = nativeImage.createFromBitmap(Buffer.concat(bufs), { width: fw, height: fh * bufs.length });
    fs.writeFileSync(`${SHOTS}/switcher-glide.png`, strip.toPNG()); out(`SHOT ${SHOTS}/switcher-glide.png (${bufs.length} frames, 0 to 320 ms)`);
  }
  // ---- 3. hold Tab: fast repeat stays smooth, settles, then sleeps ----
  await sleep(500);
  const fp = js(`new Promise(r=>{const d=[];let l=performance.now();const t0=l;(function f(n){d.push(n-l);l=n;if(n-t0<900)requestAnimationFrame(f);else r(d.slice(1))})(l)})`);
  for (let i = 0; i < 16; i++) { emit({ ev: 'next' }); await sleep(33); }
  const fd = await fp, avg = fd.reduce((a, b) => a + b, 0) / fd.length;
  out(`INFO Tab hold-repeat (16 steps at 30 Hz): ${fd.length} frames, avg ${avg.toFixed(1)} ms, worst ${Math.max(...fd).toFixed(1)} ms`);
  ok(avg < 20 && Math.max(...fd) < 60, `Tab hold-repeat stays smooth (avg ${avg.toFixed(1)} ms per frame)`);
  s = await sst(); ok(s.sel === sw.sel, `panel and Koi agree on the selection (${s.sel} / ${sw.sel})`);
  await sleep(900); ok((await sst()).busy === 0, 'the springs stop once the rim settles (no loop while still)');
  // ---- 4. wheel and hover ----
  const before = sw.sel;
  await js(`for(let i=0;i<3;i++)window.dispatchEvent(new WheelEvent('wheel',{deltaY:40,cancelable:true}))`); await sleep(80);
  ok(sw.sel === (before + 3) % 9 && (await sst()).sel === sw.sel, `the scroll wheel moves through windows (${before} -> ${sw.sel})`);
  await js(`(()=>{const t=document.querySelectorAll('.tile')[4];const r=t.getBoundingClientRect();for(const k of [0,1,2])t.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:r.x+20+k*12,clientY:r.y+20,screenX:r.x+20+k*12,screenY:r.y+20}))})()`); await sleep(60);
  ok(sw.sel === 4, `hovering a window selects it (${sw.sel})`);
  // ---- 5. screenshots, dark and light ----
  await sleep(700); emit({ ev: 'next' }); await sleep(900);
  fs.writeFileSync(`${SHOTS}/switcher-dark.png`, (await win().webContents.capturePage()).toPNG()); out(`SHOT ${SHOTS}/switcher-dark.png`);
  // ---- 6. release: focus the exact window ----
  const pick = sw.list[sw.sel];
  emit({ ev: 'release' }); await sleep(300);
  const f = sent('focus').pop(); ok(f && f.wid === pick.wid && f.pid === pick.pid && !win().isVisible(), `releasing Command focuses that exact window (wid ${f && f.wid}) and the panel goes`);
  await sleep(400); ok((await sst()).busy === 0, 'nothing animates once the panel is closed');

  // light theme
  ipcMain.emit('pop:set', {}, 'theme', 'light');
  emit({ ev: 'open', shift: false }); await until(() => win().isVisible()); await win().webContents.insertCSS(WALL_L); await sleep(1100);
  fs.writeFileSync(`${SHOTS}/switcher-light.png`, (await win().webContents.capturePage()).toPNG()); out(`SHOT ${SHOTS}/switcher-light.png`);
  emit({ ev: 'key', k: 'esc' }); await sleep(300); ok(!win().isVisible() && sent('active').pop().on === false, 'Esc cancels');
  ipcMain.emit('pop:set', {}, 'theme', 'dark');

  // ---- 7. many windows: the grid scrolls on a spring to keep the selection in view ----
  setState({ n: 40 }); sw.send({ cmd: '_state' }); await sleep(100);
  emit({ ev: 'open', shift: false }); await until(() => win().isVisible()); await sleep(500);
  s = await sst(); ok(s.n === 40 && s.rows > 1, `40 windows wrap into ${s.rows} rows of ${s.cols}`);
  const sp = js('window.__sw.track(700)'); await sleep(20); emit({ ev: 'prev' }); emit({ ev: 'prev' });
  const str = await sp; s = await sst();
  const smid = str.filter(p => p.s > 2 && p.s < s.scrollT - 2).length;
  out(`INFO scroll to the last row: target ${s.scrollT.toFixed(0)} px, ${smid} frames in between`);
  ok(s.scrollT > 0 && smid >= 4, `the grid scrolls smoothly to the selection (${smid} intermediate frames to ${s.scrollT.toFixed(0)} px)`);
  await sleep(800); fs.writeFileSync(`${SHOTS}/switcher-many.png`, (await win().webContents.capturePage()).toPNG()); out(`SHOT ${SHOTS}/switcher-many.png`);
  emit({ ev: 'key', k: 'esc' }); await sleep(300);
  setState({}); sw.send({ cmd: '_state' }); await sleep(100);

  // ---- 8. Cmd+Tab vs Command + Option, both orders ----
  T.setHotkeys('Command+Alt', []); await sleep(300);
  const fanShown = () => { const w = BrowserWindow.getAllWindows().find(w => /mode=overlay/.test(w.webContents.getURL())); return !!(w && w.isVisible()); };
  // a) Command, Tab (switcher), then Option while Command is held: the fan must NOT fire
  P.key('down', CMD); emit({ ev: 'open', shift: false }); await until(() => win().isVisible());
  P.key('down', OPT); await sleep(150);
  ok(!fanShown() && sw.isOpen(), 'Command, Tab, then Option: the fan does not fire, the switcher stays');
  P.key('up', OPT); emit({ ev: 'release' }); P.key('up', CMD); await sleep(400);
  ok(!fanShown() && !sw.isOpen(), 'releasing Command ends the switch, still no fan');
  // the very next Command + Option works (nothing left stuck)
  P.key('down', CMD); P.key('down', OPT); await sleep(200);
  ok(fanShown(), 'right after, Command + Option opens the fan as usual');
  // b) Command + Option (fan open), then Tab: the switcher must NOT open
  const shows = sent('ack').length; emit({ ev: 'open', shift: false }); await sleep(250);
  ok(fanShown() && !sw.isOpen() && !win().isVisible() && sent('ack').length === shows + 1 && sent('active').pop().on === false, 'Command + Option, then Tab: the switcher stays shut while the fan is open');
  P.key('up', OPT); P.key('up', CMD); T.hide(); await sleep(500);
  // c) Command + Tab right after the fan closed works
  emit({ ev: 'open', shift: false }); ok(await until(() => win().isVisible()), 'after the fan closes, Cmd+Tab opens the switcher again');
  emit({ ev: 'release' }); await sleep(300);
  T.setHotkeys('Alt+Space', []); await sleep(200);

  // ---- 9. helper crash: Apple's Cmd+Tab back, then the helper returns ----
  emit({ ev: 'open', shift: false }); await until(() => win().isVisible());
  const flog = () => fs.existsSync(FLOG) ? fs.readFileSync(FLOG, 'utf8') : '';
  const restores0 = flog().split('\n').filter(l => l.startsWith('restore')).length;
  sw.send({ cmd: '_crash' });
  ok(await until(() => sw.status === 'fallback'), 'helper crash: status fallback');
  ok(await until(() => flog().split('\n').filter(l => l.startsWith('restore')).length > restores0), 'helper crash: koi-switch --restore ran (Apple\'s Cmd+Tab is back)');
  ok(await until(() => !win().isVisible()), 'helper crash: the panel closes');
  ok(await until(() => sw.status === 'ready', 5000), 'the helper is restarted and ready again');
  emit({ ev: 'tap', state: 'failed', why: 'timeout' }); await sleep(300);
  ok(sw.status === 'fallback', 'tap disabled by repeated timeouts: fallback to Apple\'s Cmd+Tab');
  emit({ ev: 'tap', state: 'on' }); await sleep(100);

  // ---- 10. permissions: no Screen Recording -> icons and titles, the card, then it heals ----
  setState({ screen: false }); sw.send({ cmd: '_state' }); await sleep(150);
  const nThumbs = sent('thumbs').length;
  emit({ ev: 'open', shift: false }); await until(() => win().isVisible()); await sleep(700);
  ok(await js(`document.body.classList.contains('noscreen')`) && sent('thumbs').length === nThumbs, 'no Screen Recording: icons and titles only, a "Turn on previews" chip, no capture');
  ok(await js(`[...document.querySelectorAll('.tile')].every(t=>t.querySelector('.big'))`), 'every card shows its app icon');
  fs.writeFileSync(`${SHOTS}/switcher-noscreen.png`, (await win().webContents.capturePage()).toPNG()); out(`SHOT ${SHOTS}/switcher-noscreen.png`);
  emit({ ev: 'release' });
  ok(await until(() => T.sw.card() && T.sw.card().isVisible() && T.sw.cardKind() === 'screen', 3000), 'after the switch, the Screen Recording card appears (once)');
  await sleep(1200);
  const ctext = await T.sw.card().webContents.executeJavaScript('document.getElementById("card").innerText');
  ok(/Turn on live previews/.test(ctext) && /Open Screen Recording/.test(ctext), 'the card says what to do, with an Open Screen Recording button');
  await T.sw.card().webContents.insertCSS(WALL); await sleep(200);
  fs.writeFileSync(`${SHOTS}/switcher-card-screen.png`, (await T.sw.card().webContents.capturePage()).toPNG()); out(`SHOT ${SHOTS}/switcher-card-screen.png`);
  await T.sw.card().webContents.executeJavaScript('koiAPI.perm.action("access")');
  ok(sent('askScreen').length >= 1, 'the button asks macOS for Screen Recording (and opens the pane)');
  setState({ screen: true });
  ok(await until(async () => /Previews are on/.test(await T.sw.card().webContents.executeJavaScript('document.getElementById("card").innerText').catch(() => '')), 6000), 'granted: the card turns green by itself, no restart');
  ok(await until(() => sw.status === 'ready' && sw.perm.screen === true, 4000), 'the helper restarts with previews on');
  ok(await until(() => !T.sw.card(), 5000), 'the card folds away');
  // no Accessibility: the access card, and Apple's Cmd+Tab meanwhile
  setState({ ax: false }); sw.send({ cmd: '_crash' });
  ok(await until(() => sw.status === 'needs-access', 6000), 'no Accessibility: needs-access (macOS keeps Cmd+Tab)');
  ok(await until(() => T.sw.card() && T.sw.cardKind() === 'access', 3000), 'the Accessibility card appears');
  await sleep(1200); await T.sw.card().webContents.insertCSS(WALL);
  fs.writeFileSync(`${SHOTS}/switcher-card-access.png`, (await T.sw.card().webContents.capturePage()).toPNG()); out(`SHOT ${SHOTS}/switcher-card-access.png`);
  setState({}); sw.send({ cmd: '_state' });
  ok(await until(() => sw.status === 'ready', 3000), 'granted: the tap comes up');
  ok(await until(() => !T.sw.card(), 5000), 'and the card folds away');

  // ---- 11. the Hotkeys window section ----
  ipcMain.emit('pop:action', {}, 'hotkeys'); await sleep(1600);
  const sw2 = BrowserWindow.getAllWindows().find(w => /settings\.html/.test(w.webContents.getURL()));
  ok(!!sw2, 'Hotkeys opens');
  await sw2.webContents.executeJavaScript(`window.__go('switch')`); await sleep(1400);
  const txt = await sw2.webContents.executeJavaScript('document.getElementById("p-switch").innerText');
  ok(/Replace Cmd\+Tab/.test(txt) && /Current Space/.test(txt) && /Include minimized windows/.test(txt) && /Window switcher/.test(txt), 'the Window switcher section has its four settings');
  fs.writeFileSync(`${SHOTS}/switcher-settings.png`, (await sw2.webContents.capturePage()).toPNG()); out(`SHOT ${SHOTS}/switcher-settings.png`);
  await sw2.webContents.executeJavaScript(`document.getElementById('swRep').click()`); await sleep(300);
  ok(st().S.switchReplace === false && sent('config').pop().replace === false, 'Replace Cmd+Tab off: saved and sent to the helper');
  await sw2.webContents.executeJavaScript(`document.querySelector('#swScope button[data-v=space]').click()`); await sleep(300);
  ok(st().S.switchScope === 'space', 'Show windows from: Current Space is saved');
  await sw2.webContents.executeJavaScript(`document.getElementById('swOn').click()`); await sleep(900);
  ok(st().S.switcher === false && sw.status === 'off' && !sw.child, 'switching the switcher off stops the helper');
  await sw2.webContents.executeJavaScript(`document.getElementById('swOn').click();document.getElementById('swRep').click()`);
  ok(await until(() => sw.status === 'ready', 5000) && st().S.switcher && st().S.switchReplace, 'and on again brings it back');
  sw2.close();

  // ---- 12. idle: nothing runs ----
  await sleep(1500);
  ok((await sst()).busy === 0 && !win().isVisible(), 'closed panel: no spring loop');
  app.getAppMetrics(); await sleep(4000);
  const cpu = app.getAppMetrics().reduce((a, p) => a + p.cpu.percentCPUUsage, 0);
  ok(cpu < 2, `idle CPU with the switcher ready stays near zero (${cpu.toFixed(2)}%)`);
  const emo = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;
  const bad = ['switcher.js', 'renderer/switcher.html', 'renderer/perm.html', 'renderer/settings.html', 'native/koi-switch.swift', 'RELEASE_NOTES.md'].filter(f => emo.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')));
  ok(!bad.length, 'no emojis' + (bad.length ? ' (' + bad.join(', ') + ')' : ''));
  ok(errs.length === 0, 'no console errors' + (errs.length ? ': ' + errs.slice(0, 4).join(' | ') : ''));
  out(fails ? `DONE with ${fails} FAIL` : 'DONE all PASS');
  app.exit(fails ? 1 : 0);
});

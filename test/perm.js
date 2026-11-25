// Koi 2.0.1 key hook + permission test (Linux/xvfb): chord detection, stuck-key recovery, and the self-healing
// permission card, with macOS's answers simulated through global.__koiTest.perm (KOI_TEST=1).
//   xvfb-run -a npx electron test/perm.js --no-sandbox     (PASS/FAIL lines, also /tmp/koi-perm.log)
const { app, ipcMain } = require('electron');
const fs = require('fs'), path = require('path');
require('./fake-mac');
const LOG = '/tmp/koi-perm.log'; fs.writeFileSync(LOG, '');
let fails = 0; const out = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const ok = (c, m) => { out((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const errs = []; app.on('web-contents-created', (_e, wc) => wc.on('console-message', (...a) => { const e = a[0] && a[0].level !== undefined ? a[0] : { level: a[1], message: a[2] }; if (e.level === 'error' || e.level === 3) errs.push(e.message); }));
process.on('uncaughtException', e => ok(false, 'uncaught: ' + e.message));
require('../main.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CMD = 3675, CMD_R = 3676, OPT = 56, OPT_R = 3640, SHIFT = 42, K = 37;
app.whenReady().then(async () => {
  await sleep(500);
  const T = global.__koiTest, P = T.perm, st = () => T.state();
  const fake = P.fakeHook();
  const uses = () => st().S.usage.Safari || 0;
  const chord = [{ acc: 'Command+Alt', name: 'Safari', path: '/Applications/Safari.app' }];
  const card = () => { const w = P.card(); return w && !w.isDestroyed() ? w : null; };
  const text = async () => card() ? card().webContents.executeJavaScript('document.getElementById("card").innerText') : '';

  // 1. a stale grant: chord set, macOS says Koi is not trusted
  P.trust(false); T.setHotkeys('Alt+Space', chord); await sleep(1500);
  ok(st().health === 'denied' && !st().hookOk, `untrusted: health is denied and no hook (${st().health})`);
  ok(st().retry, 'untrusted: Koi keeps polling for the permission');
  ok(!!card() && card().isVisible(), 'the permission card appears by itself');
  let tx = await text();
  ok(/Remove Koi/.test(tx) && /Add Koi again/.test(tx) && /Command \+ Option/.test(tx), 'the card names the chord and the remove / add again steps');
  ok(/Open Accessibility/.test(tx) && /Input Monitoring/.test(tx), 'the card has Open Accessibility and Input Monitoring buttons');
  const s0 = await card().webContents.executeJavaScript('koiAPI.perm.state()'); ok(s0.state === 'denied' && s0.chord === '⌘ ⌥', 'the card gets its state over IPC');
  // 2. the person re-adds Koi: trust comes back, the hook starts without a relaunch, the card checks off and goes
  P.trust(true); await sleep(2200);
  ok(st().hookOk && fake.starts === 1, `trust back: the hook started by itself (${fake.starts} start)`);
  tx = await text(); ok(/is back/.test(tx), 'the card says the hotkey is back');
  await sleep(3400); ok(!card(), 'the card folds away and its window is gone');
  // 3. chord detection
  let u = uses();
  P.key('down', CMD); P.key('down', OPT); P.key('up', OPT); P.key('up', CMD); await sleep(50);
  ok(uses() === u + 1, 'left Command + left Option fires once, on press');
  u = uses(); P.key('down', CMD_R); P.key('down', OPT_R); P.key('up', CMD_R); P.key('up', OPT_R); await sleep(50);
  ok(uses() === u + 1, 'right Command + right Option fires too');
  u = uses(); P.key('down', OPT); P.key('down', CMD); P.key('up', CMD); P.key('up', OPT); await sleep(50);
  ok(uses() === u + 1, 'Option first, then Command, fires too');
  u = uses(); P.key('down', CMD); P.key('down', K); P.key('down', OPT); P.key('up', K); P.key('up', OPT); P.key('up', CMD); await sleep(50);
  ok(uses() === u, 'Command + K + Option (real typing) does not fire');
  u = uses(); P.key('down', CMD); P.key('down', OPT); P.key('up', OPT); P.key('down', OPT); P.key('up', OPT); P.key('up', CMD); await sleep(50);
  ok(uses() === u + 1, 'holding the chord does not fire twice');
  // a key-up macOS never delivered must not kill the chord for good
  const t0 = Date.now(); u = uses();
  P.key('down', SHIFT, t0 - 30000);                       // Shift "held" 30 s ago, its key-up was lost
  P.key('down', CMD, t0); P.key('down', OPT, t0 + 5); P.key('up', OPT, t0 + 50); P.key('up', CMD, t0 + 60); await sleep(50);
  ok(uses() === u + 1, 'a lost key-up (stuck Shift) is dropped and the chord still fires');
  u = uses(); P.key('down', CMD); P.key('down', OPT); P.key('up', OPT); P.key('up', CMD); await sleep(50);
  ok(uses() === u + 1, 'and keeps firing after that');
  // closing the Hotkeys window while it records must not leave chords paused
  ipcMain.emit('pop:action', {}, 'hotkeys'); await sleep(1500);
  const { BrowserWindow } = require('electron'); const sw = BrowserWindow.getAllWindows().find(w => /settings\.html/.test(w.webContents.getURL()));
  await sw.webContents.executeJavaScript('koiAPI.s.pause()'); sw.close(); await sleep(400);
  u = uses(); P.key('down', CMD); P.key('down', OPT); P.key('up', OPT); P.key('up', CMD); await sleep(50);
  ok(uses() === u + 1, 'closing Hotkeys mid-recording does not leave the chord paused');
  // 4. a deaf hook: the Mac is in use, the hook hears nothing
  T.setHotkeys('Alt+Space', []); await sleep(100); ok(!st().hookOk && !st().probe && !st().retry && st().health === 'off', 'no chord: no hook, no probe, no retry');
  T.setHotkeys('Alt+Space', chord); await sleep(100);
  ok(st().hookOk && st().probe && st().health === 'waiting', `fresh hook waits for its first key with a probe (${st().health})`);
  P.idle(2); for (let i = 0; i < 6; i++) P.probe(); await sleep(100);
  ok(st().hookOk && st().health === 'waiting' && fake.starts === 3, `first deaf round: a quiet restart only (${st().health}, ${fake.starts} starts)`);
  for (let i = 0; i < 6; i++) P.probe(); await sleep(1500);
  ok(st().health === 'deaf' && !!card(), `still deaf: health deaf and the card is up (${st().health})`);
  tx = await text(); ok(/not reaching Koi/.test(tx), 'the card explains macOS is not passing keys');
  P.key('down', OPT); P.key('up', OPT); await sleep(200);
  tx = await text(); ok(st().health === 'fixed' && /is back/.test(tx), 'the first key heard heals it and the card says so (' + st().health + ', ' + (card() && card().isVisible()) + ', ' + tx.slice(0, 80).replace(/\n/g, ' ') + ')');
  ok(!st().probe, 'the probe stops once a key was heard');
  await sleep(3400); ok(!card(), 'the card goes away');
  // 5. trust revoked while running: the probe notices
  T.setHotkeys('Alt+Space', []); T.setHotkeys('Alt+Space', chord); await sleep(100);
  P.trust(false); P.probe(); await sleep(1500);
  ok(st().health === 'denied' && !st().hookOk && !!card(), 'trust lost while running: back to denied, card up');
  await card().webContents.executeJavaScript('koiAPI.perm.action("later")'); await sleep(500);
  ok(!card(), 'Later folds the card away');
  P.probe(); await sleep(1700); ok(!card(), 'and it does not nag again for the same problem');
  P.trust(true); await sleep(2500); ok(st().hookOk && (st().health === 'ok' || st().health === 'waiting'), `trust back with the card snoozed: the hook starts quietly (${st().health})`);
  T.setHotkeys('Alt+Space', []); await sleep(100);
  // 6. no emojis, no console errors
  const emo = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;
  ok(!emo.test(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'perm.html'), 'utf8')), 'no emojis in the permission card');
  ok(errs.length === 0, 'no console errors' + (errs.length ? ': ' + errs.slice(0, 4).join(' | ') : ''));
  out(fails ? `DONE with ${fails} FAIL` : 'DONE all PASS');
  app.exit(fails ? 1 : 0);
});

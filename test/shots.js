// Screenshots of every Koi surface: popover (light + dark), Hotkeys window, update card states, the tour/intro.
//   KOI_SHOTS=/tmp/lumen-shots/42-koi-after xvfb-run -a -s "-screen 0 1440x900x24" npx electron test/shots.js --no-sandbox
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs'), path = require('path');
const { ud } = require('./fake-mac');
const P = process.env.KOI_SHOTS || '/tmp/lumen-shots/42-koi-x', R = path.join(__dirname, '..', 'renderer'), PRE = path.join(__dirname, '..', 'preload.js');
const LOG = '/tmp/koi-shots.log'; fs.writeFileSync(LOG, '');
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const wins = new Set(); app.on('browser-window-created', (_e, w) => wins.add(w));
const errs = []; app.on('web-contents-created', (_e, wc) => wc.on('console-message', (...a) => { const e = a[0] && a[0].level !== undefined ? a[0] : { level: a[1], message: a[2], sourceId: a[4], lineNumber: a[3] }; if (e.level === 'error' || e.level === 3) errs.push(`${e.message} @${e.sourceId}:${e.lineNumber}`); }));
require('../main.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WALL = `background:radial-gradient(50% 60% at 18% 22%,#5a2a8a 0,transparent 70%),radial-gradient(50% 60% at 88% 80%,#0d5170 0,transparent 70%),linear-gradient(160deg,#211638,#0c1424)!important`;
const WALL_L = `background:radial-gradient(50% 60% at 18% 22%,#ffc3e1 0,transparent 70%),radial-gradient(50% 60% at 88% 80%,#b9e4ff 0,transparent 70%),linear-gradient(160deg,#f3e9ff,#e6f2ff)!important`;
async function cap(w, name, wall = WALL) {
  await w.webContents.insertCSS(`html{${wall}}`); await sleep(150);
  const img = await w.webContents.capturePage(); fs.writeFileSync(`${P}-${name}.png`, img.toPNG()); log('SHOT', `${P}-${name}.png`, img.getSize().width + 'x' + img.getSize().height);
}
const find = re => [...wins].find(w => !w.isDestroyed() && re.test(w.webContents.getURL()));
app.whenReady().then(async () => {
  await sleep(2500);
  const api = global.__koiTest;          // present in Koi 2.0 (KOI_TEST=1); the 1.0 build is driven through its demo modes
  // ---- popover ----
  for (const theme of ['light', 'dark']) {
    let w;
    if (api && api.popover) { w = await api.popover({ theme }); }
    else { w = new BrowserWindow({ width: 344, height: 640, show: true, frame: false, webPreferences: { contextIsolation: true } }); await w.loadFile(path.join(R, 'popover.html')); await w.webContents.executeJavaScript(`document.body.classList.toggle('dk',${theme === 'dark'})`); }
    await sleep(1600); await cap(w, 'popover-' + theme, theme === 'dark' ? WALL : WALL_L); if (!(api && api.popover)) w.destroy(); else api.hidePopover();
    await sleep(400);
  }
  // ---- update card states ----
  const states = [['available', { status: 'available', latest: 'v2.0.0', current: '1.0.20', size: 98e6, lastCheck: Date.now() }], ['downloading', { status: 'downloading', latest: 'v2.0.0', current: '1.0.20', size: 98e6, bytes: 41e6, progress: 42, speed: 6.2e6, eta: 9, lastCheck: Date.now() }], ['ready', { status: 'ready', latest: 'v2.0.0', current: '1.0.20', lastCheck: Date.now() }], ['installing', { status: 'installing', latest: 'v2.0.0', current: '1.0.20' }], ['error', { status: 'error', latest: 'v2.0.0', current: '1.0.20', error: 'GitHub did not answer' }]];
  for (const [n, s] of states) {
    let w;
    if (api && api.updateCard) w = await api.updateCard(s);
    else { if (n !== 'downloading') continue; w = new BrowserWindow({ width: 540, height: 200, show: true, frame: false, webPreferences: { contextIsolation: true } }); await w.loadFile(path.join(R, 'update.html')); }
    await sleep(1500); await cap(w, 'update-' + n);
    if (!(api && api.updateCard)) w.destroy();
  }
  if (api && api.closeCard) api.closeCard();
  if (api && api.about) { const w = api.about(); await sleep(1500); await cap(w, 'about', ''); w.close(); }
  // ---- Hotkeys window ----
  ipcMain.emit('pop:action', { sender: null }, 'hotkeys'); await sleep(2200);
  { const w = find(/settings\.html/); if (w) { await cap(w, 'settings', ''); w.close(); } }
  // ---- tour / intro ----
  ipcMain.emit('pop:action', { sender: null }, 'tour');
  const t0 = Date.now(); const marks = (process.env.KOI_TOUR || '2200,5800,11000,18500,26000,37000').split(',').map(Number);
  for (const ms of marks) { await sleep(Math.max(0, t0 + ms - Date.now())); const w = find(/mode=tour/); if (w) await cap(w, 'tour-' + String(ms).padStart(5, '0'), ''); }
  log('CONSOLE ERRORS', errs.length, errs.slice(0, 8).join(' | '));
  app.exit(0);
});

// Koi auto-update — GitHub Releases → zip → staged .app → swap → relaunch.
// (Same engine as Surge.)  State: idle → checking → available → downloading → unpacking → ready → installing   (error → retry)
const { execFile, execFileSync, spawn } = require('child_process');
const { BrowserWindow, screen, powerMonitor, Notification } = require('electron');
const fs = require('fs');
const path = require('path');

const REPO = 'mabdulhadi0208-afk/mabdulhadi0208-afk-koi';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const ZIP = `Koi-mac-${ARCH}.zip`, DMG = `Koi-mac-${ARCH}.dmg`;
let C = null, timer = null, cancelled = false, popup = null, snoozedUntil = 0, skipVersion = null, polling = false, misses = 0, lastTag = null, lastCheck = 0, dlProc = null;
const state = { status: 'idle', latest: null, url: null, size: 0, progress: 0, bytes: 0, speed: 0, eta: 0, error: null, staged: null, isZip: true };

// a quiet look at GitHub every 10 minutes (a HEAD request, no download), plus on launch, on wake and when you
// open the menu-bar popover; the moment a newer tag shows up the full check runs
const POLL = 10 * 60000;
const semver = v => String(v).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
const newer = (a, b) => { const A = semver(a), B = semver(b); for (let i = 0; i < 3; i++) { if ((A[i] || 0) > (B[i] || 0)) return true; if ((A[i] || 0) < (B[i] || 0)) return false; } return false; };
const same = (a, b) => semver(a).join('.') === semver(b).join('.');
const sh = (cmd, args, opts = {}) => new Promise((res, rej) => execFile(cmd, args, { timeout: 600000, maxBuffer: 1 << 24, ...opts }, (e, out, err) => e ? rej(new Error((err || e.message).trim())) : res(out)));
const latestTag = () => sh('curl', ['-sI', '-o', '/dev/null', '-w', '%{redirect_url}', `https://github.com/${REPO}/releases/latest`], { timeout: 8000 }).then(u => (/\/tag\/([^\/\s]+)/.exec(u) || [])[1] || null).catch(() => null);
async function probe(url) { const h = await sh('curl', ['-sIL', url], { timeout: 15000 }).catch(() => ''); const codes = [...h.matchAll(/^HTTP\/[\d.]+ (\d{3})/gm)].map(m => +m[1]); const len = [...h.matchAll(/^content-length:\s*(\d+)/gmi)].map(m => +m[1]); return { ok: codes.length > 0 && codes[codes.length - 1] === 200, size: len.length ? len[len.length - 1] : 0 }; }
function stagedVersion(appPath) {
  try { const pl = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8'); const v = /CFBundleShortVersionString<\/key>\s*<string>([^<]+)/.exec(pl)?.[1]; if (v) return v; } catch {}
  try { return execFileSync('defaults', ['read', path.join(appPath, 'Contents', 'Info.plist'), 'CFBundleShortVersionString'], { timeout: 3000 }).toString().trim(); } catch { return null; }
}
const bundlePath = () => { const p = process.execPath; const i = p.indexOf('.app/Contents/MacOS/'); return i > 0 ? p.slice(0, i + 4) : null; };
const fmtMB = b => (b / 1048576).toFixed(1) + ' MB';
const updDir = () => path.join(C.app.getPath('userData'), 'update');
const log = (...a) => { try { fs.mkdirSync(C.app.getPath('logs'), { recursive: true }); fs.appendFileSync(path.join(C.app.getPath('logs'), 'koi.log'), `[${new Date().toISOString()}] updater: ${a.join(' ')}\n`); } catch {} };
// removing a staged ~200 MB app happens off the main thread, so the menu bar never stalls
function clearStaged() { const d = updDir(), gone = d + '.old-' + Date.now(); try { fs.renameSync(d, gone); fs.promises.rm(gone, { recursive: true, force: true }).catch(() => {}); } catch {} state.staged = null; }
const snapshot = () => ({ ...state, current: C.app.getVersion(), lastCheck });
function push() { const s = snapshot(); C.onState && C.onState(s); if (popup && !popup.isDestroyed()) { try { popup.webContents.send('upd:state', s); } catch {} } }
function set(patch) { Object.assign(state, patch); push(); }

function showCard() {
  if (!C.settings().updateCard) return;
  if (popup && !popup.isDestroyed()) { if (!popup.isVisible()) popup.showInactive(); push(); return; }
  const d = screen.getPrimaryDisplay().workArea, w = 600, h = 268;
  popup = new BrowserWindow({ width: w, height: h, x: Math.round(d.x + d.width / 2 - w / 2), y: d.y + 6, frame: false, transparent: true, hasShadow: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, focusable: true, fullscreenable: false, backgroundColor: '#00000000', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  popup.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); popup.setAlwaysOnTop(true, 'screen-saver');
  popup.loadFile(path.join(__dirname, 'renderer', 'update.html'), { query: { theme: C.settings().theme || 'dark' } });
  popup.once('ready-to-show', () => { if (!popup || popup.isDestroyed()) return; popup.showInactive(); push(); });
  popup.on('closed', () => (popup = null));
}
// the card folds itself away first (it listens for 'upd:hide'), then the window is hidden
function hideCard() { if (popup && !popup.isDestroyed() && popup.isVisible()) { try { popup.webContents.send('upd:hide'); } catch {} setTimeout(() => { if (popup && !popup.isDestroyed()) popup.hide(); }, 240); } }
const showCardIfAllowed = manual => { if (manual || Date.now() > snoozedUntil) showCard(); };

async function check(manual) {
  if (['downloading', 'unpacking', 'installing'].includes(state.status)) return snapshot();
  set({ status: 'checking', error: null }); lastCheck = Date.now();
  try {
    const latest = await latestTag(); if (!latest) throw new Error('GitHub did not answer');
    const cur = C.app.getVersion();
    if (!newer(latest, cur)) { if (state.staged) clearStaged(); set({ status: 'uptodate', latest }); C.setBadge(false); return snapshot(); }
    if (!manual && skipVersion === latest) { set({ status: 'uptodate', latest }); return snapshot(); }
    if (state.staged) { const sv = stagedVersion(state.staged); if (!sv || !same(sv, latest)) { log('discard stale staged', sv); clearStaged(); } }
    if (state.staged) { set({ status: 'ready', latest }); C.setBadge(true); showCardIfAllowed(manual); return snapshot(); }
    let url = `https://github.com/${REPO}/releases/download/${latest}/${ZIP}`, isZip = true, p = await probe(url);
    if (!p.ok) { url = `https://github.com/${REPO}/releases/download/${latest}/${DMG}`; isZip = false; p = await probe(url); }
    if (!p.ok) throw new Error(`${latest} is published but the file isn't ready yet`);
    set({ status: 'available', latest, url, isZip, size: p.size, progress: 0, bytes: 0 });
    log('available', latest, isZip ? 'zip' : 'dmg', fmtMB(p.size));
    C.setBadge(true); showCardIfAllowed(manual);
    if (C.settings().autoDownload) download();
  } catch (e) { set({ status: 'error', error: e.message }); log('check failed:', e.message); lastTag = null; }
  return snapshot();
}

async function download() {
  if (!state.url || ['downloading', 'unpacking', 'installing'].includes(state.status)) return;
  if (state.staged) { const sv = stagedVersion(state.staged); if (sv && same(sv, state.latest)) { set({ status: 'ready' }); return; } clearStaged(); }
  const dir = updDir(); await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); fs.mkdirSync(dir, { recursive: true });
  cancelled = false;
  const file = path.join(dir, state.isZip ? ZIP : DMG), mnt = path.join(dir, 'mnt');
  let prog = null;
  try {
    set({ status: 'downloading', progress: 0, bytes: 0, speed: 0, eta: 0 });
    let lastB = 0, lastT = Date.now();
    prog = setInterval(() => { try { const b = fs.statSync(file).size, now = Date.now(), sp = (b - lastB) / Math.max(.001, (now - lastT) / 1000); lastB = b; lastT = now;
      set({ bytes: b, speed: sp, progress: state.size ? Math.min(99, Math.round(b / state.size * 100)) : 0, eta: sp > 0 && state.size ? Math.round((state.size - b) / sp) : 0 }); } catch {} }, 300);
    let ok = false, err = null;
    for (let i = 0; i < 3 && !ok && !cancelled; i++) {
      try { await new Promise((res, rej) => { dlProc = execFile('curl', ['-L', '--fail', '--silent', '--show-error', '-C', '-', '--retry', '2', '-o', file, state.url], { timeout: 900000 }, (e, o, se) => { dlProc = null; e ? rej(new Error((se || e.message).trim())) : res(); }); }); ok = true; }
      catch (e) { err = e; if (cancelled) break; log('download attempt', i + 1, 'failed:', e.message); await new Promise(r => setTimeout(r, 1500)); }
    }
    if (cancelled) { clearInterval(prog); prog = null; set({ status: 'available', progress: 0, bytes: 0, speed: 0, eta: 0 }); log('download cancelled'); return; }
    if (!ok) throw err || new Error('download failed');
    clearInterval(prog); prog = null;
    if (state.size && fs.statSync(file).size !== state.size) throw new Error('download incomplete');
    set({ progress: 100, status: 'unpacking' });
    if (state.isZip) { await sh('ditto', ['-x', '-k', file, dir]); const app = fs.readdirSync(dir).find(f => f.endsWith('.app')); if (!app) throw new Error('No .app in zip'); if (app !== 'Koi.app') fs.renameSync(path.join(dir, app), path.join(dir, 'Koi.app')); }
    else { fs.mkdirSync(mnt, { recursive: true }); await sh('hdiutil', ['attach', '-nobrowse', '-quiet', '-mountpoint', mnt, file]); const app = fs.readdirSync(mnt).find(f => f.endsWith('.app')); if (!app) throw new Error('No .app in DMG'); await sh('ditto', [path.join(mnt, app), path.join(dir, 'Koi.app')]); await sh('hdiutil', ['detach', '-quiet', mnt]).catch(() => {}); }
    fs.rmSync(file, { force: true });
    const staged = path.join(dir, 'Koi.app'), sv = stagedVersion(staged);
    if (!sv || !same(sv, state.latest)) throw new Error(`unpacked version mismatch (${sv})`);
    await sh('xattr', ['-cr', staged]).catch(() => {});
    set({ staged, status: 'ready' }); log('staged', state.latest);
    showCardIfAllowed(false);
    try { new Notification({ title: `Koi ${String(state.latest).replace(/^v/, '')} is ready`, body: 'Downloaded and checked. Restart Koi from the menu bar to switch, it takes about 3 seconds.' }).show(); } catch {}
  } catch (e) { clearInterval(prog); if (cancelled) { set({ status: 'available', progress: 0 }); return; } set({ status: 'error', error: e.message }); log('download failed:', e.message); try { await sh('hdiutil', ['detach', '-quiet', mnt]); } catch {} }
}

function swapScript(o) {
  return `#!/bin/bash
exec >> "${o.logf}" 2>&1
echo "=== $(date) swap ${o.cur} -> ${o.next}"
NEW="${o.staged}"; APP="${o.target}"; OLDPID=${o.pid}
# wait for the old Koi (this exact pid) to exit; escalate if it hangs
for i in $(seq 1 40); do kill -0 $OLDPID 2>/dev/null || break; sleep 0.1; done
kill -0 $OLDPID 2>/dev/null && { echo "old pid still alive, SIGTERM"; kill -TERM $OLDPID 2>/dev/null; sleep 1; }
kill -0 $OLDPID 2>/dev/null && { echo "old pid stuck, SIGKILL"; kill -KILL $OLDPID 2>/dev/null; sleep 0.5; }
rm -rf "$APP.old"; mv "$APP" "$APP.old" || { echo "mv failed"; exit 1; }
if mv "$NEW" "$APP" 2>/dev/null || ditto "$NEW" "$APP"; then xattr -cr "$APP" 2>/dev/null; echo "swapped"; else echo "swap failed, rolling back"; rm -rf "$APP"; mv "$APP.old" "$APP"; fi
touch "${o.marker}"
open -a "$APP" || ("$APP/Contents/MacOS/Koi" >/dev/null 2>&1 & disown)
for i in $(seq 1 40); do pgrep -f "$APP/Contents/MacOS/Koi" >/dev/null && break; sleep 0.25; done
if pgrep -f "$APP/Contents/MacOS/Koi" >/dev/null; then echo "launched OK"; rm -rf "$APP.old" "$NEW"; else echo "launch failed, restoring old"; rm -rf "$APP"; mv "$APP.old" "$APP" 2>/dev/null; open -a "$APP"; fi
sleep 8; pgrep -f "$APP/Contents/MacOS/Koi" >/dev/null || { echo "no Koi running after swap, relaunching"; open -a "$APP"; }
echo "=== done"
`;
}

async function install() {
  if (!state.staged) { if (state.status !== 'downloading' && state.status !== 'unpacking') await download(); if (!state.staged) return snapshot(); }
  const sv = stagedVersion(state.staged);
  if (!sv || !newer(sv, C.app.getVersion())) { clearStaged(); set({ status: 'error', error: 'staged copy was not newer — fetching again' }); return check(true); }
  const target = bundlePath(); if (!target) { set({ status: 'error', error: 'Not running from an .app bundle' }); return snapshot(); }
  const script = path.join(updDir(), 'swap.sh');
  fs.writeFileSync(script, swapScript({ logf: path.join(C.app.getPath('logs'), 'update.log'), cur: C.app.getVersion(), next: sv, staged: state.staged, target, pid: process.pid, marker: path.join(C.app.getPath('userData'), 'just-updated') }));
  fs.chmodSync(script, 0o755);
  set({ status: 'installing' }); log('installing', sv);
  if (C.settings().updateCard) showCard();
  try { C.beforeQuit && C.beforeQuit(); } catch {}
  // the swap script waits for this exact pid to exit, so the card gets a moment to show "Restarting" first
  const child = spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }); child.unref();
  setTimeout(() => C.app.exit(0), 650);
  setTimeout(() => { try { process.kill(process.pid, 'SIGKILL'); } catch {} }, 3000);
  return snapshot();
}

async function poll() {
  if (polling || ['downloading', 'unpacking', 'installing', 'checking'].includes(state.status)) return; polling = true;
  const tag = await latestTag().finally(() => (polling = false));
  if (!tag) { misses++; if (misses === 3) { clearInterval(timer); timer = setInterval(poll, 30 * 60000); log('offline: backing off to 30 min'); } return; }
  if (misses >= 3) { clearInterval(timer); timer = setInterval(poll, POLL); } misses = 0;
  if (tag === lastTag) return; lastTag = tag;
  if (newer(tag, C.app.getVersion())) check(false); else if (state.status === 'idle') set({ status: 'uptodate', latest: tag });
}

const actions = {
  check: () => check(true), install: () => install(), download: () => download(), state: () => snapshot(),
  later: () => { snoozedUntil = Date.now() + 2 * 3600000; hideCard(); },
  skip: () => { skipVersion = state.latest; C.saveSkip && C.saveSkip(skipVersion); C.setBadge(false); hideCard(); },
  cancel: () => { cancelled = true; try { dlProc?.kill('SIGTERM'); } catch {} set({ status: 'available', progress: 0, bytes: 0, speed: 0, eta: 0 }); },
  quiet: () => { if (!['downloading', 'unpacking', 'installing', 'checking'].includes(state.status)) poll(); return snapshot(); },
  close: () => hideCard(),
};
function start(ctx) {
  C = ctx; skipVersion = ctx.settings().skipped || null;
  try { const f = path.join(ctx.app.getPath('userData'), 'just-updated'); if (fs.existsSync(f)) { fs.rmSync(f); log('updated to', ctx.app.getVersion()); setTimeout(() => { try { new Notification({ title: `You are on Koi ${ctx.app.getVersion()}`, body: 'The update went through. Your hotkeys, settings and permissions came along.' }).show(); } catch {} }, 1500); } } catch {}
  const staged = path.join(updDir(), 'Koi.app');
  if (fs.existsSync(staged)) { const sv = stagedVersion(staged); if (sv && newer(sv, ctx.app.getVersion())) { state.staged = staged; state.status = 'ready'; state.latest = 'v' + sv; ctx.setBadge(true); } else clearStaged(); }
  setTimeout(() => check(false), 5000);
  timer = setInterval(poll, POLL);
  try { powerMonitor.on('resume', () => setTimeout(() => check(false), 8000)); } catch {}
}
// tests only: paint the card in a given state without touching GitHub
function _preview(s) { Object.assign(state, s); showCard(); push(); return popup; }
module.exports = { start, actions, snapshot: () => (C ? snapshot() : state), _swapScript: swapScript, _newer: newer, _preview };

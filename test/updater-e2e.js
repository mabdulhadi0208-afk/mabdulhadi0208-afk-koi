// Koi updater end to end, offline (Linux/xvfb or macOS): GitHub, curl and ditto are simulated with the exact
// command lines updater.js uses, the release zip is a real zip of a Koi.app, and the swap script runs for real
// against a fake /Applications with shims for the macOS-only tools (ditto, xattr, open).
//   xvfb-run -a npx electron test/updater-e2e.js --no-sandbox      (PASS/FAIL lines, also /tmp/koi-updater.log)
const { app } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const LOG = '/tmp/koi-updater.log'; fs.writeFileSync(LOG, '');
let fails = 0; const out = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); }, ok = (c, m) => { out((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-upd-')), ud = path.join(T, 'ud'); fs.mkdirSync(ud);
app.setPath('userData', ud); app.setPath('logs', path.join(T, 'logs'));
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64', REPO = 'mabdulhadi0208-afk/mabdulhadi0208-afk-koi';
// ---- a real release zip: Koi.app 2.0.0 ----
const plist = v => `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${v}</string></dict></plist>`;
function makeApp(dir, v, runnable = true) { fs.mkdirSync(path.join(dir, 'Contents', 'MacOS'), { recursive: true }); fs.writeFileSync(path.join(dir, 'Contents', 'Info.plist'), plist(v)); if (runnable) { fs.writeFileSync(path.join(dir, 'Contents', 'MacOS', 'Koi'), '#!/bin/bash\nsleep 20\n'); fs.chmodSync(path.join(dir, 'Contents', 'MacOS', 'Koi'), 0o755); } }
const rel = path.join(T, 'rel'); makeApp(path.join(rel, 'Koi.app'), '2.0.0');
const zip = path.join(T, `Koi-mac-${ARCH}.zip`);
cp.execFileSync('python3', ['-c', `import shutil;shutil.make_archive(${JSON.stringify(zip.slice(0, -4))},'zip',${JSON.stringify(rel)},'Koi.app')`]);
const ZSIZE = fs.statSync(zip).size;
// ---- simulated network + macOS tools, matching updater.js's command lines ----
let slowDl = 0; const calls = [];
const real = cp.execFile;
cp.execFile = function (cmd, args, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  const a = (args || []).join(' '); calls.push(cmd + ' ' + a);
  const done = (e, o = '', se = '') => setTimeout(() => cb && cb(e, o, se), 5);
  if (cmd === 'curl' && a.includes('%{redirect_url}')) { done(null, `https://github.com/${REPO}/releases/tag/v2.0.0`); return { kill() {} }; }
  if (cmd === 'curl' && args[0] === '-sIL') { const u = args[1]; const has = u.endsWith(`/v2.0.0/Koi-mac-${ARCH}.zip`); done(null, has ? `HTTP/2 302\r\nlocation: x\r\n\r\nHTTP/2 200\r\ncontent-length: ${ZSIZE}\r\n` : 'HTTP/2 404\r\n'); return { kill() {} }; }
  if (cmd === 'curl' && args.includes('--fail')) {
    const o = args[args.indexOf('-o') + 1]; let killed = false;
    const t = setTimeout(() => { if (!killed) { fs.copyFileSync(zip, o); cb(null, '', ''); } }, slowDl);
    return { kill() { killed = true; clearTimeout(t); cb(new Error('killed'), '', 'killed'); } };
  }
  if (cmd === 'ditto' && args[0] === '-x') { try { cp.execFileSync('python3', ['-c', `import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`, args[2], args[3]]); for (const f of cp.execFileSync('find', [args[3], '-name', 'Koi', '-path', '*MacOS*']).toString().split('\n').filter(Boolean)) fs.chmodSync(f, 0o755); done(null); } catch (e) { done(e); } return { kill() {} }; }
  if (cmd === 'xattr' || cmd === 'hdiutil') { done(null); return { kill() {} }; }
  return real.apply(this, arguments);
};
const updater = require('../updater');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const states = [];
const S = { updateCard: false, autoDownload: true, skipped: null };
app.whenReady().then(async () => {
  const fakeApp = { getVersion: () => '1.0.20', getPath: k => app.getPath(k), exit: () => out('INFO app.exit called') };
  updater.start({ app: fakeApp, settings: () => S, setBadge: () => {}, onState: s => { if (states[states.length - 1] !== s.status) states.push(s.status); }, saveSkip: () => {}, beforeQuit: () => {} });
  // 1. check finds v2.0.0, downloads the zip, unpacks and verifies Koi.app 2.0.0
  await updater.actions.check();
  for (let i = 0; i < 100 && updater.snapshot().status !== 'ready' && updater.snapshot().status !== 'error'; i++) await sleep(100);
  const s = updater.snapshot();
  out('INFO states: ' + states.join(' > '));
  ok(s.status === 'ready', 'check > available > downloading > unpacking > ready' + (s.error ? ' (' + s.error + ')' : ''));
  ok(s.latest === 'v2.0.0' && s.isZip, 'picks the zip for this arch (' + `Koi-mac-${ARCH}.zip` + ')');
  ok(s.staged && fs.existsSync(path.join(s.staged, 'Contents', 'Info.plist')) && /2\.0\.0/.test(fs.readFileSync(path.join(s.staged, 'Contents', 'Info.plist'), 'utf8')), 'staged Koi.app is version 2.0.0');
  ok(calls.some(c => c.startsWith('curl -sI -o /dev/null -w %{redirect_url} https://github.com/' + REPO + '/releases/latest')), 'asks github.com/<repo>/releases/latest for the newest tag');
  // 2. a newer staged copy survives a restart of Koi (start() picks it up)
  // 3. cancel really cancels: re-download slowly and cancel midway
  updater.actions.cancel(); // no-op while ready
  slowDl = 3000; S.autoDownload = false;
  fs.rmSync(path.join(ud, 'update'), { recursive: true, force: true });
  const st2 = updater.snapshot(); st2.staged = null;
  await updater._preview({ status: 'available', staged: null });
  const dl = updater.actions.download(); await sleep(300);
  ok(updater.snapshot().status === 'downloading', 'download starts');
  updater.actions.cancel(); await dl; await sleep(200);
  ok(updater.snapshot().status === 'available', 'Cancel stops the download and goes back to "available" (no retries)');
  ok(calls.filter(c => c.startsWith('curl -L --fail')).length === 2, 'no retry after cancel');
  // 4. install outside an .app bundle refuses cleanly instead of crashing
  slowDl = 0; await updater.actions.download(); for (let i = 0; i < 50 && updater.snapshot().status !== 'ready'; i++) await sleep(100);
  const r = await updater.actions.install();
  ok(r.status === 'error' && /bundle/.test(r.error), 'install outside an .app bundle stops with a clear error, no crash');
  // 5. the swap script, for real: old Koi exits, new one moves in and launches; then a broken update rolls back
  const shim = path.join(T, 'bin'); fs.mkdirSync(shim);
  fs.writeFileSync(path.join(shim, 'ditto'), '#!/bin/bash\ncp -R "$1" "$2"\n'); fs.writeFileSync(path.join(shim, 'xattr'), '#!/bin/bash\nexit 0\n');
  fs.writeFileSync(path.join(shim, 'open'), '#!/bin/bash\n[ "$1" = "-a" ] && shift\nB="$1/Contents/MacOS/Koi"\n[ -x "$B" ] || exit 1\n"$B" >/dev/null 2>&1 &\ndisown\n');
  for (const f of ['ditto', 'xattr', 'open']) fs.chmodSync(path.join(shim, f), 0o755);
  async function swap(tag, runnable) {
    const A = path.join(T, tag, 'Applications'), target = path.join(A, 'Koi.app'), staged = path.join(T, tag, 'staged', 'Koi.app');
    makeApp(target, '1.0.20'); makeApp(staged, '2.0.0', runnable);
    const old = cp.spawn('sleep', ['1.5']); const logf = path.join(T, tag, 'update.log');
    const sc = path.join(T, tag, 'swap.sh'); fs.writeFileSync(sc, updater._swapScript({ logf, cur: '1.0.20', next: '2.0.0', staged, target, pid: old.pid, marker: path.join(T, tag, 'just-updated') })); fs.chmodSync(sc, 0o755);
    // shorten the final 8 s watchdog for the test only
    fs.writeFileSync(sc, fs.readFileSync(sc, 'utf8').replace('sleep 8;', 'sleep 1;'));
    const t0 = Date.now(); cp.spawnSync('/bin/bash', [sc], { env: { ...process.env, PATH: shim + ':' + process.env.PATH }, timeout: 40000 });
    const v = (/<string>([^<]+)/.exec(fs.readFileSync(path.join(target, 'Contents', 'Info.plist'), 'utf8')) || [])[1];
    try { cp.execSync(`pkill -f "${target}/Contents/MacOS/Koi"`); } catch {}
    return { v, ms: Date.now() - t0, log: fs.readFileSync(logf, 'utf8'), leftovers: fs.existsSync(target + '.old'), marker: fs.existsSync(path.join(T, tag, 'just-updated')) };
  }
  const good = await swap('good', true);
  ok(good.v === '2.0.0' && /launched OK/.test(good.log) && !good.leftovers && good.marker, `swap: waits for the old pid, swaps to 2.0.0, relaunches, cleans up (${good.ms} ms)`);
  const bad = await swap('bad', false);
  ok(bad.v === '1.0.20' && /launch failed, restoring old/.test(bad.log), 'swap: a new build that cannot launch is rolled back to the old Koi');
  out(fails ? `DONE with ${fails} FAIL` : 'DONE all PASS');
  app.exit(fails ? 1 : 0);
});

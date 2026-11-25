// CI (macOS) only: rebuild uiohook-napi so its macOS event tap asks for KEY events only.
// Stock libuiohook installs an active session event tap for every mouse move, click and scroll too, which puts
// Koi in the path of every pointer event on the Mac (and wakes it for each one). Koi only needs keys and
// modifier changes, so the tap mask is cut down to kCGEventKeyDown | kCGEventKeyUp | kCGEventFlagsChanged.
// The tap option is left alone, so the Accessibility permission people already gave Koi keeps working.
// Builds arm64 and x64 into prebuilds/darwin-<arch>/ (what node-gyp-build loads). If anything fails, the stock
// prebuilds are restored and the release still ships (Koi's key process drops mouse events itself).
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const dir = path.join(__dirname, '..', 'node_modules', 'uiohook-napi');
const src = path.join(dir, 'libuiohook', 'src', 'darwin', 'input_hook.c');
const warn = m => console.log(`::warning title=uiohook patch::${m}`);
if (process.platform !== 'darwin' && !process.argv.includes('--patch-only')) { console.log('not macOS, nothing to do'); process.exit(0); }
if (!fs.existsSync(src)) { warn('libuiohook source not found; keeping stock prebuilds'); process.exit(0); }
let c = fs.readFileSync(src, 'utf8');
const re = /CGEventMask event_mask = [\s\S]*?CGEventMaskBit\(NX_SYSDEFINED\);/;
if (!re.test(c)) { if (/KOI: keys only/.test(c)) console.log('already patched'); else { warn('event mask not found; keeping stock prebuilds'); process.exit(0); } }
else {
  c = c.replace(re, 'CGEventMask event_mask = /* KOI: keys only */ CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) | CGEventMaskBit(kCGEventFlagsChanged);');
  fs.writeFileSync(src, c); console.log('patched the event mask: keys and modifier changes only');
}
if (process.argv.includes('--patch-only')) process.exit(0);
const pre = path.join(dir, 'prebuilds'), backup = path.join(dir, 'prebuilds.stock');
fs.cpSync(pre, backup, { recursive: true });
try {
  for (const arch of ['arm64', 'x64']) {
    execFileSync('npx', ['--yes', 'node-gyp@10', 'rebuild', `--arch=${arch}`], { cwd: dir, stdio: 'inherit' });
    const out = path.join(dir, 'build', 'Release', 'uiohook_napi.node');
    if (!fs.existsSync(out)) throw new Error('no build output for ' + arch);
    fs.copyFileSync(out, path.join(pre, `darwin-${arch}`, 'uiohook-napi.node'));
    console.log('built', arch);
  }
  fs.rmSync(path.join(dir, 'build'), { recursive: true, force: true });   // node-gyp-build must load the prebuilds
  fs.rmSync(backup, { recursive: true, force: true });
} catch (e) {
  warn('rebuild failed (' + e.message + '); restoring stock prebuilds');
  fs.rmSync(pre, { recursive: true, force: true }); fs.renameSync(backup, pre);
  fs.rmSync(path.join(dir, 'build'), { recursive: true, force: true });
}

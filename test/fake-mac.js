// Shared by the Koi tests: a temporary userData, a fake /Applications (real dirs, so stat and mtime work), glossy
// fake icons, and with KOI_SIM=1 the latency macOS pays on a cold start (serialized QuickLook thumbnails ~120 ms
// each, `ps -axo comm=` ~120 ms). Network calls (curl) fail fast, `open`/`osascript` are no-ops.
const { app, nativeImage } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const SIM = process.env.KOI_SIM === '1', THEME = process.env.KOI_THEME || 'dark';
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-ud-')); app.setPath('userData', ud);
fs.writeFileSync(path.join(ud, 'koi-settings.json'), JSON.stringify({ tourSeen: true, migFast: true, theme: THEME, usage: { Safari: 9, Terminal: 7, Notes: 5, Music: 4 } }));
process.env.KOI_TEST = '1';

// ---- fake /Applications with 60 apps (real dirs, so stat/mtime work) ----
const NAMES = ['Safari', 'Messages', 'Mail', 'Calendar', 'Notes', 'Music', 'Terminal', 'Photos', 'Maps', 'System Settings', 'Xcode', 'Slack', 'Spotify', 'Figma', 'Visual Studio Code', 'Google Chrome', 'Discord', 'Lumen', 'Pages', 'Numbers', 'Keynote', 'Preview', 'Podcasts', 'News', 'Stocks', 'Weather', 'Clock', 'Reminders', 'FaceTime', 'Books', 'Freeform', 'Home', 'Shortcuts', 'TextEdit', 'Calculator', 'Dictionary', 'Font Book', 'Image Capture', 'Mission Control', 'Photo Booth', 'QuickTime Player', 'Stickies', 'Time Machine', 'Tips', 'TV', 'Voice Memos', 'Zoom', 'Notion', 'Linear', 'Arc', 'Firefox', 'iTerm', 'Docker', 'Postman', 'Obsidian', 'Raycast', 'Bear', 'Things', 'Fantastical', 'Transmit'];
for (const n of NAMES) { const d = `/Applications/${n}.app/Contents`; if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(d + '/Info.plist', `<plist><dict><key>CFBundleName</key><string>${n}</string></dict></plist>`); } }

// a glossy rounded-square icon per app (BGRA), distinct hue per name
function fakeIcon(name) {
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  const S = 128, buf = Buffer.alloc(S * S * 4), hsl = (H, s, l) => { const k = n => (n + H / 30) % 12, a = s * Math.min(l, 1 - l), f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)); return [f(0), f(8), f(4)].map(x => Math.round(x * 255)); };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const r = 28, dx = Math.max(0, Math.abs(x - 63.5) - (63.5 - r - 8)), dy = Math.max(0, Math.abs(y - 63.5) - (63.5 - r - 8)), inside = Math.hypot(dx, dy) <= r;
    const t = y / S, [R, G, B] = hsl((h + t * 40) % 360, .85, .62 - t * .22), gl = y < 52 && inside ? .18 * (1 - y / 52) : 0, i = (y * S + x) * 4;
    buf[i] = Math.min(255, B + gl * 255); buf[i + 1] = Math.min(255, G + gl * 255); buf[i + 2] = Math.min(255, R + gl * 255); buf[i + 3] = inside ? 255 : 0;
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S });
}
// serialized QuickLook-like queue
let q = Promise.resolve(); const iconCalls = { n: 0 };
const slow = (ms, fn) => (q = q.then(() => new Promise(r => setTimeout(r, ms))).then(fn));
nativeImage.createThumbnailFromPath = async p => { iconCalls.n++; const n = path.basename(p, '.app'); return SIM ? slow(120, () => fakeIcon(n)) : fakeIcon(n); };
const gfi = app.getFileIcon.bind(app); app.getFileIcon = async (p, o) => { const n = path.basename(p, '.app'); return SIM ? slow(120, () => fakeIcon(n)) : fakeIcon(n); };
// ps: like macOS, names under /Applications/X.app/Contents/MacOS/X, with the mac latency
const realExecFile = cp.execFile;
cp.execFile = function (cmd, args, opts, cb) {
  if (cmd === 'ps' && Array.isArray(args) && args.join(' ') === '-axo comm=') {
    if (typeof opts === 'function') cb = opts;
    const out = ['Safari', 'Terminal', 'Notes', 'Messages', 'Slack', 'Lumen'].map(n => `/Applications/${n}.app/Contents/MacOS/${n}`).join('\n') + '\n/usr/sbin/cfprefsd\n';
    setTimeout(() => cb && cb(null, out, ''), SIM ? 120 : 5); return { kill() {} };
  }
  if (cmd === 'open' || cmd === 'osascript') { if (typeof opts === 'function') cb = opts; setTimeout(() => cb && cb(null, '', ''), 5); return { kill() {} }; }
  if (cmd === 'curl') { if (typeof opts === 'function') cb = opts; setTimeout(() => cb && cb(new Error('offline in tests'), '', 'offline'), 5); return { kill() {} }; }
  return realExecFile.apply(this, arguments);
};

module.exports = { SIM, ud, iconCalls, fakeIcon };

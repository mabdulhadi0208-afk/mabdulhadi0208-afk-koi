// A stand-in for native/koi-switch on Linux: speaks the same JSON-lines protocol over stdin/stdout, with fake
// windows, app icons and window thumbnails (SVG mock-ups). Koi runs it when KOI_SWITCH_HELPER points here.
// Test-only commands: {"cmd":"_emit","msg":{...}} writes msg as if the tap had produced it (an "open" without
// windows gets the fake list), {"cmd":"_crash"} exits with code 9, {"cmd":"_state"} re-reads the state file.
// State file (KOI_FAKE_STATE): {"ax":true,"screen":true,"tap":"on","n":9}. Every --restore run appends to KOI_FAKE_LOG.
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2), arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const LOG = process.env.KOI_FAKE_LOG || '/tmp/koi-fake-switch.log';
const readState = () => { try { return { ax: true, screen: true, tap: 'on', n: 9, ...JSON.parse(fs.readFileSync(process.env.KOI_FAKE_STATE, 'utf8')) }; } catch (e) { return { ax: true, screen: true, tap: 'on', n: 9 }; } };
let st = readState();
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const note = s => { try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {} };
if (argv.includes('--restore')) { note('restore ' + Date.now()); out({ ok: true, restored: true }); process.exit(0); }
if (argv.includes('--perm')) { out({ ax: st.ax, screen: st.screen }); process.exit(0); }
if (argv.includes('--selftest')) { out({ ok: true, selftest: true, windows: st.n }); process.exit(0); }

const cache = arg('--cache') || '/tmp/koi-fake-switch'; fs.mkdirSync(cache, { recursive: true });
const APPS = [['Safari', '#2f7bff', '#13c1cd'], ['Notes', '#ffb547', '#ff8a3d'], ['Xcode', '#3a7bff', '#8b5cf6'], ['Music', '#f4679b', '#ff4f6b'], ['Terminal', '#2a2f3a', '#4b5563'], ['Figma', '#a66be3', '#f4679b'], ['Messages', '#22c55e', '#13c1cd'], ['Mail', '#38bdf8', '#2f7bff'], ['Slack', '#e0559a', '#6b21a8'], ['Lumen', '#5b8cff', '#a66be3'], ['Calendar', '#ef4444', '#f97316'], ['Photos', '#f59e0b', '#ec4899']];
const TITLES = ['Koi 2.1 release notes', 'Groceries and ideas', 'KoiSwitch.xcodeproj', 'Late night mix', 'zsh: ~/koi', 'Koi panel, frame 3', 'Lumen team', 'Inbox (3)', '#koi', 'lumen://newtab', 'November 2026', 'Library'];
function icon(a) {
  const f = path.join(cache, 'icon-' + a[0] + '.svg');
  if (!fs.existsSync(f)) fs.writeFileSync(f, `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a[1]}"/><stop offset="1" stop-color="${a[2]}"/></linearGradient><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><rect x="8" y="8" width="112" height="112" rx="28" fill="url(#g)"/><rect x="8" y="8" width="112" height="112" rx="28" fill="url(#s)"/><text x="64" y="84" font-family="Helvetica,Arial" font-weight="800" font-size="56" fill="#fff" text-anchor="middle">${a[0][0]}</text></svg>`);
  return f;
}
function thumb(w, n) {
  const a = APPS.find(x => x[0] === w.app) || APPS[0], W = 520, H = Math.round(520 / (w.w / w.h)), f = path.join(cache, `w${w.wid}-${n}.svg`);
  const lines = Array.from({ length: 7 }, (_, i) => `<rect x="${170}" y="${80 + i * 34}" width="${W - 210 - (i * 37) % 120}" height="12" rx="6" fill="#fff" opacity="${.5 - i * .04}"/>`).join('');
  fs.writeFileSync(f, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a[1]}"/><stop offset="1" stop-color="${a[2]}"/></linearGradient></defs><rect width="${W}" height="${H}" rx="14" fill="#14182a"/><rect width="${W}" height="${H}" rx="14" fill="url(#b)" opacity=".55"/><rect width="${W}" height="40" rx="14" fill="#fff" opacity=".16"/><circle cx="24" cy="20" r="7" fill="#ff5f57"/><circle cx="46" cy="20" r="7" fill="#febc2e"/><circle cx="68" cy="20" r="7" fill="#28c840"/><text x="${W / 2}" y="26" font-family="Helvetica,Arial" font-size="15" font-weight="700" fill="#fff" text-anchor="middle">${w.title}</text><rect x="20" y="60" width="130" height="${H - 80}" rx="10" fill="#fff" opacity=".12"/>${lines}</svg>`);
  return f;
}
function windows() {
  const list = [];
  for (let i = 0; i < st.n; i++) {
    const a = APPS[i % APPS.length], min = i === st.n - 1 && st.n > 3, ar = [1.6, 1.33, 1.78, 1.45][i % 4];
    list.push({ wid: 1000 + i, pid: 500 + (i % APPS.length), app: a[0], bundle: 'com.fake.' + a[0].toLowerCase(), title: TITLES[i % TITLES.length], x: 0, y: 0, w: Math.round(900 * ar), h: 900, onscreen: !min, min, hidden: false, z: i, ax: true, icon: icon(a) });
  }
  return list;
}
let seq = 0, tn = 0;
out({ ev: 'tap', state: st.ax ? st.tap : 'noperm' });
out({ ev: 'ready', protocol: 1, ax: st.ax, screen: st.screen, tap: st.ax ? st.tap : 'noperm', symbolicHotKeys: true, focusExact: true, screenCaptureKit: true });
let buf = '';
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); }
});
process.stdin.on('end', () => { note('stdin closed'); process.exit(0); });
function handle(m) {
  switch (m.cmd) {
    case '_emit': { const e = { ...m.msg }; if (e.ev === 'open') { e.seq = ++seq; if (!e.windows) e.windows = windows(); } out(e); break; }
    case '_crash': process.exit(9); break;
    case '_state': st = readState(); out({ ev: 'perm', ax: st.ax, screen: st.screen }); if (st.ax) out({ ev: 'tap', state: st.tap }); break;
    case 'list': out({ re: m.id, windows: windows() }); break;
    case 'thumbs': {
      if (!st.screen) { out({ ev: 'thumbfail', wids: m.ids, why: 'screen' }); break; }
      const all = windows(); let k = 0;
      for (const id of m.ids) { const w = all.find(x => x.wid === id); if (!w) continue; setTimeout(() => out({ ev: 'thumb', wid: id, file: thumb(w, ++tn), w: 520, h: 325 }), 15 + 12 * k++); }
      break;
    }
    case 'perm': out({ re: m.id, ax: st.ax, screen: st.screen }); break;
    case 'askScreen': out({ ev: 'perm', ax: st.ax, screen: st.screen }); break;
    case 'bye': note('bye'); process.exit(0); break;
  }
}

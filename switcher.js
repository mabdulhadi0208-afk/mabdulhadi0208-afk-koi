// Koi 2.1 window switcher: the brain in Koi's main process. Electron-free, so test/switcher-unit.js runs it in plain
// Node with a fake helper.
//
// The native helper (native/koi-switch.swift, Koi.app/Contents/MacOS/koi-switch) owns the keyboard side: its event
// tap consumes Cmd+Tab (so Apple's switcher never shows) and tells us open / next / prev / key / release over JSON
// lines. This module owns everything else: the window order (most recently used first), the selection, what
// happens on release, Q and W, the helper's life (restart with backoff, and Apple's Cmd+Tab restored whenever it
// dies) and the permission states.
//
// Rules:
//  - The panel opens from the window list that arrives WITH the open event: no round trip before the first frame.
//  - The first Tab selects the front window of the app you used before this one (moved to index 1), so a quick
//    Cmd+Tab tap-and-release lands on it, like macOS and Windows. "Before" comes from the order you really used apps
//    in (the helper's apps list, from macOS activation events), not from how windows happen to be stacked. Shift+Tab from closed selects the last.
//  - The panel only appears if Command is still held SHOW_DELAY ms after the Tab press (like macOS): a quick tap
//    switches instantly with no flash. A commit that arrives before the open (or before the panel showed) switches
//    straight away without ever showing the panel.
//  - Releasing Cmd focuses the selected window (the exact window; the helper un-minimizes it).
//  - Never fires while Koi's fan is open, and tells the chord detector a real key went down, so Cmd+Tab followed by
//    Option can never fire the Command + Option fan.
//  - Nothing runs while closed: no timers, no polling. Thumbnails are cached briefly and refreshed on every open.
const { pathToFileURL } = require('url');

const SHOW_DELAY = 120, THUMB_TTL = 5 * 60000, THUMB_MAX = 48, BACKOFF = [800, 2000, 5000, 15000];
const fileUrl = f => f ? pathToFileURL(f).href : '';

// most recently used first: visible windows of this Space in z-order (macOS keeps that order as you use them),
// then the rest (minimized, hidden, other Spaces) by when Koi last switched to them, then by z-order
// apps: the pids of apps in the order you last used them, newest first (the helper hears it from macOS as you switch
// apps any way at all: Cmd+Tab, clicks, the Dock), with the app you are in first. When it is there it decides who is
// current and who is "the app before", which window stacking alone gets wrong (other displays, small helper windows,
// an app whose window sits behind another one).
function orderWindows(wins, opts = {}, mru = new Map(), apps = null) {
  const scope = opts.scope || 'all', withMin = opts.minimized !== false;
  const keep = (wins || []).filter(w => w && w.wid && (withMin || !w.min) && (scope === 'all' || w.onscreen || w.min || w.hidden));
  const front = keep.filter(w => w.onscreen && !w.min && !w.hidden).sort((a, b) => a.z - b.z);
  const back = keep.filter(w => !(w.onscreen && !w.min && !w.hidden)).sort((a, b) => (mru.get(b.wid) || 0) - (mru.get(a.wid) || 0) || a.z - b.z);
  const list = front.concat(back);
  if (Array.isArray(apps) && apps.length && list.length) {
    const cur = apps[0];
    // the current app's front window first (if it has one)
    const c = list.findIndex(w => w.pid === cur);
    if (c > 0) list.unshift(list.splice(c, 1)[0]);
    // then the front window of the most recently used other app that has a window
    for (const pid of apps.slice(1)) {
      if (pid === cur) continue;
      const k = list.findIndex(w => w.pid === pid);
      if (k < 0) continue;
      const at = c >= 0 ? 1 : 0;
      if (k !== at) list.splice(at, 0, list.splice(k, 1)[0]);
      break;
    }
    list.curApp = c >= 0;
    return list;
  }
  // no app history from the helper (an older helper): the previous app goes right after the current window
  const k = list.findIndex((w, i) => i > 0 && list[0] && w.pid !== list[0].pid);
  if (k > 1) list.splice(1, 0, list.splice(k, 1)[0]);
  list.curApp = true;
  return list;
}

class Switcher {
  // o: { spawn(): child, ui: {show, select, update, thumb, hide}, settings(): {switcher, switchReplace, switchScope,
  //      switchMinimized}, restore(), blocked(): bool, onOpen(), warm(), onState(st), log(...), now(), thumbFallback(wids) }
  constructor(o) {
    this.o = o; this.child = null; this.buf = ''; this.status = 'off'; this.tap = ''; this.perm = { ax: null, screen: null };
    this.open = false; this.list = []; this.sel = 0; this.cols = 1; this.mru = new Map(); this.thumbs = new Map();
    this.deaths = []; this.restartT = null; this.stopping = false; this.sent = []; this.reqN = 0; this.pending = new Map();
    this.features = {}; this.opens = 0; this.lastEvAt = 0; this.shown = false; this.showT = null; this.seq = 0; this.early = null;
  }
  now() { return this.o.now ? this.o.now() : Date.now(); }
  log(...a) { if (this.o.log) this.o.log(...a); }
  cfg() { const s = this.o.settings() || {}; return { enabled: s.switcher !== false, replace: s.switchReplace !== false, scope: s.switchScope === 'space' ? 'space' : 'all', minimized: s.switchMinimized !== false }; }
  isOpen() { return this.open; }
  state() { return { status: this.status, tap: this.tap, perm: { ...this.perm }, open: this.open, shown: this.shown, sel: this.sel, n: this.list.length, list: this.list.map(w => w.wid), deaths: this.deaths.length, running: !!this.child, features: this.features }; }
  setStatus(s) { if (s === this.status) return; this.status = s; this.o.onState && this.o.onState(this.state()); }

  // ---- helper life ----
  start() {
    const c = this.cfg();
    if (!c.enabled) { this.stop(); return; }
    if (this.child) { this.config(); return; }
    clearTimeout(this.restartT); this.restartT = null; this.stopping = false;
    let ch;
    try { ch = this.o.spawn(); } catch (e) { ch = null; this.log('switcher spawn', e && e.message); }
    if (!ch) { this.died(-1); return; }
    this.child = ch; this.buf = ''; this.setStatus('starting');
    ch.stdout.on('data', d => this.data(d));
    if (ch.stderr) ch.stderr.on('data', d => this.log('koi-switch:', String(d).trim()));
    ch.on('error', e => { this.log('koi-switch error', e && e.message); if (this.child === ch) { this.child = null; this.died(-1); } });
    ch.on('exit', code => { if (this.child === ch) { this.child = null; this.died(code); } });
    if (ch.stdin && ch.stdin.on) ch.stdin.on('error', () => {});
    this.config();
  }
  stop() {
    clearTimeout(this.restartT); this.restartT = null;
    if (this.open) this.closeUI();
    const ch = this.child; this.child = null; this.stopping = true;
    if (ch) { this.send({ cmd: 'bye' }, ch); setTimeout(() => { try { ch.kill(); } catch (e) {} }, 600); }
    this.setStatus('off');
  }
  // the helper died: give Cmd+Tab back to macOS right away, then try again a few times with a growing pause
  died(code) {
    if (this.open) this.closeUI();
    if (this.stopping) { this.setStatus('off'); return; }
    this.log('koi-switch exited', code);
    try { this.o.restore && this.o.restore(); } catch (e) {}
    const t = this.now(); this.deaths = this.deaths.filter(x => t - x < 120000).concat(t);
    this.setStatus('fallback');
    if (!this.cfg().enabled) return;
    if (this.deaths.length > BACKOFF.length) { this.log('koi-switch keeps dying; macOS keeps Cmd+Tab until settings change or the Mac wakes'); return; }
    const ms = (this.o.backoff || BACKOFF)[this.deaths.length - 1];
    clearTimeout(this.restartT); this.restartT = setTimeout(() => { this.restartT = null; this.start(); }, ms);
  }
  // after sleep, or when the person changes a setting: a clean slate
  revive() { this.deaths = []; if (!this.child) this.start(); else this.config(); }
  send(m, ch = this.child) {
    if (!ch || !ch.stdin) return false;
    this.sent.push(m); if (this.sent.length > 200) this.sent.splice(0, 100);
    try { ch.stdin.write(JSON.stringify(m) + '\n'); return true; } catch (e) { return false; }
  }
  request(m, ms = 2000) {
    const id = ++this.reqN;
    return new Promise(res => { const t = setTimeout(() => { this.pending.delete(id); res(null); }, ms); this.pending.set(id, r => { clearTimeout(t); res(r); }); if (!this.send({ ...m, id })) { clearTimeout(t); this.pending.delete(id); res(null); } });
  }
  config() { const c = this.cfg(); this.send({ cmd: 'config', enabled: c.enabled, replace: c.replace }); }
  data(d) {
    this.buf += String(d);
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (e) { this.log('koi-switch bad line', line.slice(0, 120)); continue; }
      try { this.msg(m); } catch (e) { this.log('switcher msg', e && e.stack); }
    }
  }
  tapStatus(t) {
    this.tap = t;
    if (t === 'on') this.setStatus('ready');
    else if (t === 'noperm') this.setStatus('needs-access');
    else if (t === 'bypass') this.setStatus('bypass');
    else if (t === 'failed') { if (this.open) this.closeUI(); try { this.o.restore && this.o.restore(); } catch (e) {} this.setStatus('fallback'); }
  }

  // ---- messages from the helper ----
  msg(m) {
    this.lastEvAt = this.now();
    if (m.re !== undefined && this.pending.has(m.re)) { const f = this.pending.get(m.re); this.pending.delete(m.re); f(m); return; }
    switch (m.ev) {
      case 'ready':
        this.features = { symbolicHotKeys: !!m.symbolicHotKeys, focusExact: !!m.focusExact, screenCaptureKit: !!m.screenCaptureKit };
        this.setPerm(m); this.deaths = this.deaths.slice(-1); this.tapStatus(m.tap || this.tap); this.config(); return;
      case 'tap': this.tapStatus(m.state); return;
      case 'perm': this.setPerm(m); return;
      case 'warm': this.o.warm && this.o.warm(); return;
      case 'open': return this.onOpen(m);
      case 'next': if (this.stale(m)) return; return this.move(1);
      case 'prev': if (this.stale(m)) return; return this.move(-1);
      case 'key': if (this.stale(m)) return; return this.key(m.k, m.shift);
      case 'commit': case 'release': return this.onCommit(m);
      case 'thumb': return this.gotThumb(m.wid, fileUrl(m.file));
      case 'thumbfail': return this.thumbFail(m.wids || []);
    }
  }
  setPerm(m) {
    const p = { ax: m.ax === undefined ? this.perm.ax : !!m.ax, screen: m.screen === undefined ? this.perm.screen : !!m.screen };
    const changed = p.ax !== this.perm.ax || p.screen !== this.perm.screen; this.perm = p;
    if (changed && this.o.onState) this.o.onState(this.state());
  }
  // an event from a gesture that is already over (or from before this open): ignore it, except that a gesture event
  // for an open that has not arrived yet is remembered and replayed when it does
  stale(m) {
    if (m.seq === undefined || m.seq === this.seq) return !this.open;
    if (m.seq > this.seq) { (this.early && this.early.seq === m.seq ? this.early : (this.early = { seq: m.seq, ev: [] })).ev.push(m); }
    return true;
  }
  // Command went up: switch to the selection. Before the panel showed (a quick tap) the switch is instant and the
  // panel never appears; before the open itself arrived, the open commits the moment it lands.
  onCommit(m) {
    if (m.seq !== undefined && m.seq > this.seq) { this.early = { seq: m.seq, ev: [...(this.early && this.early.seq === m.seq ? this.early.ev : []), m] }; return; }
    if (this.open && (m.seq === undefined || m.seq === this.seq)) this.commit();
  }
  onOpen(m) {
    this.send({ cmd: 'ack', seq: m.seq });                  // first, so the helper never thinks Koi is hung
    if (m.seq !== undefined) this.seq = m.seq;
    const early = this.early && this.early.seq === m.seq ? this.early.ev : []; this.early = null;
    const c = this.cfg();
    const no = () => this.send({ cmd: 'active', on: false });
    if (!c.enabled || (this.o.blocked && this.o.blocked())) return no();
    const list = orderWindows(m.windows, c, this.mru, m.apps);
    if (!list.length) return no();
    this.list = list; this.opens++;
    // the app you are in has no window (Finder on an empty desktop, say): the first Tab lands on the app before it
    this.sel = m.shift ? list.length - 1 : list.length > 1 && list.curApp !== false ? 1 : 0;
    this.open = true; this.shown = false;
    this.o.onOpen && this.o.onOpen();
    for (const e of early) { this.msg(e); if (!this.open) return; }   // Tab, Tab, release all before the open landed
    const wait = Math.max(0, (this.o.showDelay !== undefined ? this.o.showDelay : SHOW_DELAY) - (m.age || 0));
    clearTimeout(this.showT); this.showT = null;
    if (wait <= 0) this.showNow(); else this.showT = setTimeout(() => { this.showT = null; if (this.open) this.showNow(); }, wait);
  }
  showNow() {
    if (!this.open || this.shown) return;
    this.shown = true;
    this.o.ui.show({ wins: this.list.map(w => this.view(w)), sel: this.sel, screen: this.perm.screen !== false });
    this.askThumbs();
  }
  view(w) {
    const t = this.thumbs.get(w.wid), fresh = t && this.now() - t.at < THUMB_TTL;
    return { wid: w.wid, app: w.app || '', title: w.title || '', icon: fileUrl(w.icon), thumb: fresh ? t.url : '', min: !!w.min, hidden: !!w.hidden, other: !w.onscreen && !w.min && !w.hidden, ar: w.w && w.h ? +(w.w / w.h).toFixed(3) : 1.6 };
  }
  // the selected window first, then outwards, so the one you look at fills in first
  askThumbs() {
    if (this.perm.screen === false) return;
    const n = this.list.length, ids = [];
    for (let d = 0; d < n && ids.length < THUMB_MAX; d++) { for (const i of d ? [this.sel + d, this.sel - d] : [this.sel]) { const w = this.list[(i + n) % n]; if (w && !w.min && !ids.includes(w.wid)) ids.push(w.wid); } }
    if (ids.length) this.send({ cmd: 'thumbs', ids, w: 520, h: 340 });
  }
  gotThumb(wid, url) {
    if (!wid || !url) return;
    this.thumbs.set(wid, { url, at: this.now() });
    if (this.thumbs.size > 200) { const old = [...this.thumbs].sort((a, b) => a[1].at - b[1].at).slice(0, 100); old.forEach(([k]) => this.thumbs.delete(k)); }
    if (this.shown && this.list.some(w => w.wid === wid)) this.o.ui.thumb(wid, url);
  }
  async thumbFail(wids) {
    if (!this.o.thumbFallback || !wids.length) return;
    try { const got = await this.o.thumbFallback(wids); for (const [wid, url] of Object.entries(got || {})) this.gotThumb(+wid, url); } catch (e) {}
  }

  // ---- moving and picking ----
  select(i) { const n = this.list.length; if (!this.open || !n) return; i = Math.max(0, Math.min(n - 1, i)); if (i === this.sel) return; this.sel = i; if (this.shown) this.o.ui.select(i); }
  move(d) { const n = this.list.length; if (!this.open || !n) return; this.sel = ((this.sel + d) % n + n) % n; if (this.shown) this.o.ui.select(this.sel); }
  key(k, shift) {
    if (!this.open) return;
    const n = this.list.length, cols = Math.max(1, this.cols | 0);
    if (k === 'right') this.move(1);
    else if (k === 'left' || k === 'grave') this.move(-1);
    else if (k === 'down') { if (this.sel + cols < n) this.select(this.sel + cols); else this.select(n - 1); }
    else if (k === 'up') { if (this.sel - cols >= 0) this.select(this.sel - cols); else this.select(0); }
    else if (k === 'esc') this.cancel();
    else if (k === 'return') this.commit();
    else if (k === 'w') this.closeSel();
    else if (k === 'q') this.quitSel();
  }
  commit() {
    const w = this.list[this.sel]; this.closeUI();
    if (!w) return null;
    this.mru.set(w.wid, this.now());
    this.send({ cmd: 'focus', wid: w.wid, pid: w.pid });
    return w;
  }
  cancel() { if (!this.open) return; this.closeUI(); this.send({ cmd: 'active', on: false }); }
  closeUI() { this.open = false; clearTimeout(this.showT); this.showT = null; if (this.shown) { this.shown = false; this.o.ui.hide(); } }
  drop(pred) {
    const keepSel = this.list[this.sel];
    this.list = this.list.filter(w => !pred(w));
    if (!this.list.length) { this.cancel(); return; }
    const i = keepSel ? this.list.indexOf(keepSel) : -1;
    this.sel = i >= 0 ? i : Math.min(this.sel, this.list.length - 1);
    if (this.shown) this.o.ui.update({ wins: this.list.map(w => this.view(w)), sel: this.sel });
  }
  closeSel() { const w = this.list[this.sel]; if (!w) return; this.send({ cmd: 'close', wid: w.wid, pid: w.pid }); this.drop(x => x === w); }
  quitSel() { const w = this.list[this.sel]; if (!w) return; this.send({ cmd: 'quit', pid: w.pid }); this.drop(x => x.pid === w.pid); }
  // from the panel: hover, wheel and clicks
  hover(i) { this.select(i); }
  wheel(d) { if (d) this.move(d > 0 ? 1 : -1); }
  pick(i) { if (!this.open) return; this.select(i); this.commit(); this.send({ cmd: 'active', on: false }); }
  setCols(n) { this.cols = Math.max(1, n | 0); }
  askScreen() { this.send({ cmd: 'askScreen' }); }
}

module.exports = { Switcher, orderWindows };

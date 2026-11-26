// Koi 2.1 window switcher: unit tests of the state machine (switcher.js) in plain Node, against an in-process fake
// helper that speaks the JSON-lines protocol. No Electron, no macOS.
//   node test/switcher-unit.js        (PASS/FAIL lines, also /tmp/koi-switcher-unit.log)
const fs = require('fs'), EventEmitter = require('events');
const { Switcher, orderWindows } = require('../switcher');
const LOG = '/tmp/koi-switcher-unit.log'; fs.writeFileSync(LOG, '');
let fails = 0; const out = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const ok = (c, m) => { out((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

class FakeChild extends EventEmitter {
  constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.got = []; this.killed = false;
    this.stdin = { write: s => { s.split('\n').filter(Boolean).forEach(l => this.got.push(JSON.parse(l))); return true; }, on() {} }; }
  say(o) { this.stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n')); }
  kill() { this.killed = true; }
  cmds(c) { return this.got.filter(m => m.cmd === c); }
}
const W = (wid, o = {}) => ({ wid, pid: 100 + (wid % 3), app: 'App' + (wid % 3), title: 'Win ' + wid, w: 1600, h: 1000, onscreen: true, min: false, hidden: false, z: wid, ...o });
const FRONT = [W(1, { z: 0 }), W(2, { z: 1 }), W(3, { z: 2 }), W(4, { z: 3 })];

function rig(over = {}) {
  const S = { switcher: true, switchReplace: true, switchScope: 'all', switchMinimized: true, ...(over.S || {}) };
  const ui = { calls: [], show(p) { this.calls.push(['show', p]); this.last = p; this.sel = p.sel; this.visible = true; }, select(i) { this.calls.push(['select', i]); this.sel = i; },
    update(p) { this.calls.push(['update', p]); this.last = p; this.sel = p.sel; }, thumb(w, u) { this.calls.push(['thumb', w, u]); }, hide() { this.calls.push(['hide']); this.visible = false; } };
  const r = { S, ui, kids: [], restores: 0, opened: 0, blocked: false, warmed: 0 };
  r.sw = new Switcher({
    spawn: over.spawn || (() => { const c = new FakeChild(); r.kids.push(c); return c; }), ui, settings: () => S,
    restore: () => r.restores++, blocked: () => r.blocked, onOpen: () => r.opened++, warm: () => r.warmed++, backoff: [30, 30, 30, 30], showDelay: over.showDelay !== undefined ? over.showDelay : 0,
    thumbFallback: over.thumbFallback, log: () => {}
  });
  r.child = () => r.kids[r.kids.length - 1];
  r.ready = (o = {}) => r.child().say({ ev: 'ready', ax: true, screen: true, tap: 'on', ...o });
  r.open = (o = {}) => r.child().say({ ev: 'open', seq: (r.seq = (r.seq || 0) + 1), shift: false, windows: FRONT, ...o });
  return r;
}

(async () => {
  // ---- ordering ----
  let o = orderWindows([W(5, { z: 4, min: true }), W(1, { z: 0 }), W(9, { z: 1, onscreen: false }), W(2, { z: 2 })], {}, new Map([[9, 100], [5, 200]]));
  ok(o.map(w => w.wid).join() === '1,2,5,9', `MRU order: visible windows in z-order, then the rest by last switch (${o.map(w => w.wid)})`);
  o = orderWindows([W(1), W(2, { min: true }), W(3, { onscreen: false })], { minimized: false });
  ok(o.map(w => w.wid).join() === '1,3', 'Include minimized off drops minimized windows');
  o = orderWindows([W(1), W(2, { min: true }), W(3, { onscreen: false })], { scope: 'space' });
  ok(o.map(w => w.wid).join() === '1,2', 'Current Space drops windows on other Spaces');

  // ---- open, Tab, Shift+Tab, release ----
  let r = rig(); r.sw.start(); r.ready();
  ok(r.sw.status === 'ready' && r.child().cmds('config').some(c => c.enabled && c.replace), 'ready: config sent (switcher on, replace Cmd+Tab)');
  r.open();
  const ackIdx = r.child().got.findIndex(m => m.cmd === 'ack');
  ok(ackIdx >= 0 && r.child().got[ackIdx].seq === 1, 'every open is acked (so the helper never thinks Koi hung)');
  ok(r.ui.visible && r.ui.last.wins.length === 4 && r.ui.sel === 1, `opens on the window list from the open event, first Tab selects the previous window (sel ${r.ui.sel})`);
  ok(r.opened === 1, 'opening tells the chord detector a real key went down');
  r.child().say({ ev: 'next' }); ok(r.ui.sel === 2, 'Tab moves to the next window');
  r.child().say({ ev: 'next' }); r.child().say({ ev: 'next' }); ok(r.ui.sel === 0, 'Tab wraps around');
  r.child().say({ ev: 'prev' }); ok(r.ui.sel === 3, 'Shift+Tab moves back (and wraps)');
  r.child().say({ ev: 'key', k: 'left' }); ok(r.ui.sel === 2, 'Left arrow moves back');
  r.child().say({ ev: 'release' });
  let f = r.child().cmds('focus').pop();
  ok(!r.ui.visible && f && f.wid === 3 && f.pid === 100, `releasing Command focuses the exact selected window (wid ${f && f.wid}, pid ${f && f.pid})`);
  ok(r.sw.mru.has(3), 'the switched-to window is remembered as most recent');
  // quick Cmd+Tab flick: open then release at once lands on the previous window
  r.open(); r.child().say({ ev: 'release' }); f = r.child().cmds('focus').pop(); ok(f.wid === 2, 'a quick Cmd+Tab flick lands on the previous window, like Windows');
  // Cmd+Shift+Tab from closed selects the last
  r.open({ shift: true }); ok(r.ui.sel === 3, 'Cmd+Shift+Tab opens on the last window');
  // Esc
  const nf = r.child().cmds('focus').length; r.child().say({ ev: 'key', k: 'esc' });
  ok(!r.ui.visible && r.child().cmds('focus').length === nf && r.child().cmds('active').pop().on === false, 'Esc cancels: no focus, the helper stops consuming keys');
  r.child().say({ ev: 'release' }); ok(r.child().cmds('focus').length === nf, 'a release after Esc does nothing');
  r.child().say({ ev: 'next' }); ok(!r.ui.visible, 'Tab events while closed are ignored');
  // grid arrows
  r.open({ windows: Array.from({ length: 10 }, (_, i) => W(20 + i, { z: i })) }); r.sw.setCols(4);
  r.child().say({ ev: 'key', k: 'down' }); ok(r.ui.sel === 5, 'Down moves one row (4 columns)');
  r.child().say({ ev: 'key', k: 'down' }); r.child().say({ ev: 'key', k: 'down' }); ok(r.ui.sel === 9, 'Down clamps to the last window');
  r.child().say({ ev: 'key', k: 'up' }); ok(r.ui.sel === 5, 'Up moves one row back');
  // hover, wheel, click
  r.sw.hover(7); ok(r.ui.sel === 7, 'mouse hover selects'); r.sw.wheel(1); ok(r.ui.sel === 8, 'scroll wheel moves'); r.sw.wheel(-1); r.sw.wheel(-1); ok(r.ui.sel === 6, 'scroll wheel moves back');
  r.sw.pick(2); f = r.child().cmds('focus').pop(); ok(!r.ui.visible && f.wid === 22, 'click picks a window and focuses it');
  // Q and W
  r.open({ windows: [W(1, { z: 0, pid: 7 }), W(2, { z: 1, pid: 8 }), W(3, { z: 2, pid: 8 }), W(4, { z: 3, pid: 9 })] });
  r.child().say({ ev: 'key', k: 'w' });
  ok(r.child().cmds('close').pop().wid === 2 && r.ui.last.wins.length === 3 && r.ui.visible, 'W closes the selected window and keeps the switcher open');
  r.child().say({ ev: 'key', k: 'q' });
  ok(r.child().cmds('quit').pop().pid === 8 && r.ui.last.wins.map(w => w.wid).join() === '1,4', 'Q quits the app and drops all its windows');
  r.child().say({ ev: 'key', k: 'return' }); ok(!r.ui.visible && r.child().cmds('focus').length > 0, 'Return picks');
  r.open({ windows: [] }); ok(!r.ui.visible && r.child().cmds('active').pop().on === false, 'no windows: nothing opens and the helper is told');

  // ---- 2.1.1: quick Cmd+Tab taps switch straight to the previous app, the panel only shows on a hold ----
  // the current app has two windows in front: the first Tab must still go to the previous APP
  const APPS3 = [W(1, { z: 0, pid: 10, app: 'Safari' }), W(2, { z: 1, pid: 10, app: 'Safari' }), W(3, { z: 2, pid: 20, app: 'Notes' }), W(4, { z: 3, pid: 30, app: 'Xcode' }), W(5, { z: 4, pid: 40, app: 'Music' })];
  o = orderWindows(APPS3); ok(o.map(w => w.wid).join() === '1,3,2,4,5', `the previous app's front window comes right after the current window (${o.map(w => w.wid)})`);
  // ---- 2.1.2: "the app before" comes from the order apps were really used in, not from window stacking ----
  // you went Notes -> Xcode -> Safari: Safari is current, but a Music window and a Notes window are stacked above Xcode's
  const STACK = [W(1, { z: 0, pid: 10, app: 'Safari' }), W(5, { z: 1, pid: 40, app: 'Music' }), W(3, { z: 2, pid: 20, app: 'Notes' }), W(4, { z: 3, pid: 30, app: 'Xcode' })];
  o = orderWindows(STACK, {}, new Map(), [10, 30, 20, 40]);
  ok(o[0].wid === 1 && o[1].wid === 4, `the app you used before (Xcode) is next, whatever is stacked above it (${o.map(w => w.wid)})`);
  // the current app's window is not on top (another display, a floating helper window)
  o = orderWindows(STACK, {}, new Map(), [30, 10]);
  ok(o[0].wid === 4 && o[1].wid === 1, `the current app goes first even when its window is lower in the stack (${o.map(w => w.wid)})`);
  // the current app has no window at all (Finder on an empty desktop): the app before still comes first in line
  o = orderWindows(STACK, {}, new Map(), [99, 20, 10]);
  ok(o[0].wid === 3 && o.curApp === false, `current app without windows: the app before leads (${o.map(w => w.wid)})`);
  // an app in the history that has since closed all its windows is skipped
  o = orderWindows(STACK, {}, new Map(), [10, 77, 40]);
  ok(o[1].wid === 5, `apps with no windows are skipped when looking for the one before (${o.map(w => w.wid)})`);
  { const r2 = rig({ showDelay: 120 }); r2.sw.start(); r2.ready()
    r2.open({ windows: STACK, apps: [10, 30, 20] }); await sleep(20); r2.child().say({ ev: 'commit', seq: r2.seq })
    let g = r2.child().cmds('focus').pop(); ok(g && g.pid === 30, `quick Cmd+Tab lands on the app used before (pid ${g && g.pid})`)
    r2.open({ windows: STACK, apps: [99, 20, 10] }); await sleep(20); r2.child().say({ ev: 'commit', seq: r2.seq })
    g = r2.child().cmds('focus').pop(); ok(g && g.pid === 20, `from an app with no windows, a quick Cmd+Tab still lands on the app before (pid ${g && g.pid})`)
    r2.open({ windows: STACK }); await sleep(20); r2.child().say({ ev: 'commit', seq: r2.seq })
    g = r2.child().cmds('focus').pop(); ok(g && g.wid === 5, `an older helper without the app list still works the old way (wid ${g && g.wid})`) }
  let q = rig({ showDelay: 120 }); q.sw.start(); q.ready();
  q.open({ windows: APPS3 }); await sleep(30); q.child().say({ ev: 'commit', seq: q.seq });
  f = q.child().cmds('focus').pop();
  ok(f && f.wid === 3 && f.pid === 20, `quick tap (release after 30 ms) switches to the previous app (wid ${f && f.wid})`);
  await sleep(150); ok(!q.ui.calls.some(c => c[0] === 'show'), 'quick tap: the panel never shows (no flash)');
  ok(!q.sw.isOpen() && !q.child().cmds('thumbs').length, 'quick tap: nothing left open, no thumbnails taken');
  q.open({ windows: APPS3 }); q.child().say({ ev: 'next', seq: q.seq }); await sleep(20); q.child().say({ ev: 'commit', seq: q.seq });
  f = q.child().cmds('focus').pop(); ok(f.wid === 2 && !q.ui.calls.some(c => c[0] === 'show'), `tap, tap, release goes to the second one (wid ${f.wid}), still no panel`);
  q.open({ windows: APPS3 }); await sleep(60); ok(!q.ui.visible, 'holding: no panel at 60 ms');
  await sleep(100); ok(q.ui.visible && q.ui.sel === 1, 'holding Command past ~120 ms shows the panel, on the previous app');
  q.child().say({ ev: 'commit', seq: q.seq }); f = q.child().cmds('focus').pop(); ok(!q.ui.visible && f.wid === 3, 'and releasing after the hold switches and hides it');
  // the open spent 100 ms listing windows: the panel waits only the rest of the 120 ms
  q.open({ windows: APPS3, age: 100 }); await sleep(40); ok(q.ui.visible, 'the show delay counts from the Tab press, not from when Koi heard it');
  q.child().say({ ev: 'commit', seq: q.seq });
  // release (and a second Tab) arriving BEFORE the open, i.e. while the open and its ack are still pending
  const nShow = q.ui.calls.filter(c => c[0] === 'show').length, s2 = q.seq + 1;
  q.child().say({ ev: 'commit', seq: s2 });
  ok(!q.child().cmds('focus').some(c => c.seq) && q.child().cmds('ack').every(a => a.seq !== s2), 'a release before its open is held, not dropped');
  q.child().say({ ev: 'open', seq: (q.seq = s2), shift: false, windows: APPS3 });
  f = q.child().cmds('focus').pop(); ok(f.wid === 3 && q.child().cmds('ack').pop().seq === s2, `release while the open ack was pending: the open is acked and switches at once (wid ${f.wid})`);
  await sleep(150); ok(q.ui.calls.filter(c => c[0] === 'show').length === nShow, 'and the panel never shows for it');
  const s3 = q.seq + 1; q.child().say({ ev: 'next', seq: s3 }); q.child().say({ ev: 'commit', seq: s3 });
  q.child().say({ ev: 'open', seq: (q.seq = s3), shift: false, windows: APPS3 });
  f = q.child().cmds('focus').pop(); ok(f.wid === 2, `Tab, Tab, release all before the open landed: goes to the second one (wid ${f.wid})`);
  q.open({ windows: APPS3 }); q.child().say({ ev: 'commit', seq: q.seq - 1 }); await sleep(10);
  ok(q.sw.isOpen(), 'a late release from an older gesture does not end the current one');
  q.child().say({ ev: 'key', k: 'esc', seq: q.seq }); q.sw.stop();

  // ---- the fan and the chord ----
  r.blocked = true; const shows = r.ui.calls.filter(c => c[0] === 'show').length; r.open();
  ok(r.ui.calls.filter(c => c[0] === 'show').length === shows && r.child().cmds('active').pop().on === false && r.child().cmds('ack').length >= 1, 'while the fan is open, Cmd+Tab does not open the switcher (still acked)');
  r.blocked = false;
  r.child().say({ ev: 'warm' }); ok(r.warmed === 1, 'Command going down warms the panel');
  r.S.switcher = false; r.open(); ok(!r.ui.visible, 'switcher off: an open is ignored');
  r.S.switcher = true;

  // ---- permissions ----
  r = rig(); r.sw.start(); r.ready({ screen: false });
  r.open(); ok(r.ui.last.screen === false && !r.child().cmds('thumbs').length, 'no Screen Recording: panel shows icons and titles, no thumbnail request');
  r.child().say({ ev: 'key', k: 'esc' });
  r.child().say({ ev: 'perm', screen: true }); r.open();
  const tq = r.child().cmds('thumbs').pop();
  ok(tq && tq.ids[0] === FRONT[1].wid, `with Screen Recording: thumbnails requested, the selected window first (${tq && tq.ids})`);
  r.child().say({ ev: 'thumb', wid: 2, file: '/tmp/x/w2-1.jpg' });
  ok(r.ui.calls.some(c => c[0] === 'thumb' && c[1] === 2 && /^file:/.test(c[2])), 'thumbnails fill in progressively while open');
  r.child().say({ ev: 'release' }); r.open();
  ok(r.ui.last.wins.find(w => w.wid === 2).thumb.startsWith('file:'), 'a cached thumbnail shows at once on the next open, then refreshes');
  r.child().say({ ev: 'release' });
  r = rig({ thumbFallback: async w => ({ [w[0]]: 'data:image/png;base64,AAAA' }) }); r.sw.start(); r.ready(); r.open();
  r.child().say({ ev: 'thumbfail', wids: [2] }); await sleep(10);
  ok(r.ui.calls.some(c => c[0] === 'thumb' && c[1] === 2 && /^data:/.test(c[2])), 'a window the helper could not capture falls back to Electron thumbnails');
  r = rig(); r.sw.start(); r.child().say({ ev: 'tap', state: 'noperm' }); r.ready({ ax: false, tap: 'noperm' });
  ok(r.sw.status === 'needs-access' && r.sw.perm.ax === false, 'no Accessibility: status needs-access (macOS keeps Cmd+Tab)');
  r.child().say({ ev: 'tap', state: 'on' }); ok(r.sw.status === 'ready', 'the tap comes up the moment Accessibility is granted');

  // ---- helper failures: Cmd+Tab must always come back ----
  r = rig(); r.sw.start(); r.ready(); r.open();
  r.child().emit('exit', 9);
  ok(r.restores === 1 && r.sw.status === 'fallback' && !r.ui.visible, 'helper crash: Apple\'s Cmd+Tab restored, panel closed, status fallback');
  await sleep(60); ok(r.kids.length === 2, 'and the helper is restarted after a pause');
  r.ready(); ok(r.sw.status === 'ready', 'restarted helper is ready again');
  r.child().say({ ev: 'tap', state: 'failed', why: 'timeout' });
  ok(r.restores === 2 && r.sw.status === 'fallback', 'tap disabled for good (timeouts): Cmd+Tab restored');
  r.child().say({ ev: 'tap', state: 'bypass' }); ok(r.sw.status === 'bypass', 'Koi too slow to ack: helper hands Cmd+Tab back (bypass)');
  r.child().say({ ev: 'tap', state: 'on' }); ok(r.sw.status === 'ready', 'and takes it back on the next ack');
  // dies over and over: stops retrying, Cmd+Tab stays Apple's
  r = rig(); r.sw.start();
  for (let i = 0; i < 6; i++) { if (r.child()) r.child().emit('exit', 1); await sleep(50); }
  ok(r.restores >= 5 && r.sw.status === 'fallback' && !r.sw.child, `a helper that keeps dying is given up on (${r.kids.length} tries, ${r.restores} restores)`);
  r.sw.revive(); ok(r.sw.child, 'revive (wake from sleep, settings change) tries again');
  // cannot spawn at all
  r = rig({ spawn: () => { throw new Error('ENOENT'); } }); r.sw.start();
  ok(r.restores === 1 && r.sw.status === 'fallback', 'missing helper binary: fallback, Cmd+Tab restored');
  r.sw.stop();
  // stop
  r = rig(); r.sw.start(); r.ready(); r.sw.stop();
  ok(r.kids[0].cmds('bye').length === 1 && r.sw.status === 'off' && r.restores === 0, 'switching it off says bye (the helper restores Cmd+Tab itself)');
  r.kids[0].emit('exit', 0); ok(r.restores === 0 && r.kids.length === 1, 'a clean stop is not treated as a crash');
  // garbage on the pipe
  r = rig(); r.sw.start(); r.child().stdout.emit('data', Buffer.from('not json\n{"ev":"ready","tap":"on","ax":true,"screen":true}\n')); ok(r.sw.status === 'ready', 'a bad line from the helper is skipped');
  r.sw.stop();
  out(fails ? `DONE with ${fails} FAIL` : 'DONE all PASS');
  process.exit(fails ? 1 : 0);
})();

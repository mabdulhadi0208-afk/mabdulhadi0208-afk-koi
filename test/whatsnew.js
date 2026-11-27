// What is new after an update (Koi 2.1.3): launches the real main.js several times on one userData, each launch in its
// own Electron process, and checks which film opens.
//   xvfb-run -a npx electron test/whatsnew.js --no-sandbox     (prints PASS/FAIL lines, also /tmp/koi-whatsnew.log)
// A fresh install gets the whole film, as before (and again on the next launch until it is finished). An existing user
// on a new version gets the short What is new cut by itself, once; the same version never plays it again. What's new in
// the menu-bar panel replays it.
const { app, ipcMain } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');
const CASE = process.env.KOI_WN_CASE;

if (CASE) {
  // ---- child: one launch of Koi ----
  require('./fake-mac');
  const UD = process.env.KOI_WN_UD, SF = path.join(UD, 'koi-settings.json');
  app.setPath('userData', UD);
  const seed = process.env.KOI_WN_SEED;
  if (seed === 'none') { try { fs.rmSync(SF); } catch (e) {} } else if (seed) fs.writeFileSync(SF, seed);
  const errs = []; app.on('web-contents-created', (_e, wc) => wc.on('console-message', (...a) => { const e = a[0] && a[0].level !== undefined ? a[0] : { level: a[1], message: a[2] }; if (e.level === 'error' || e.level === 3) errs.push(e.message); }));
  const wins = new Set(); app.on('browser-window-created', (_e, w) => wins.add(w));
  require('../main.js');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tourWin = () => [...wins].find(w => !w.isDestroyed() && /mode=(tour|new)/.test(w.webContents.getURL()));
  const modeOf = w => { if (!w) return ''; const u = new URL(w.webContents.getURL()); return { mode: u.searchParams.get('mode'), from: u.searchParams.get('from') || '', v: u.searchParams.get('v') }; };
  app.whenReady().then(async () => {
    const T = global.__koiTest, r = { case: CASE };
    await sleep(2600);
    const w = tourWin(); r.opened = modeOf(w);
    if (w) {
      r.film = await w.webContents.executeJavaScript(`(()=>{const sc=document.getElementById('scene'),was=sc.querySelector('.odo .was'),now=sc.querySelector('.odo .now');
        return {st:window.KOIFILM.st(),text:sc.textContent,wn:!!sc.querySelector('.wn'),cards:sc.querySelectorAll('.wn>div').length,sheen:!!sc.querySelector('.wn>i.sheen'),
          was:was?was.textContent:'',now:now?now.textContent:'',cap:document.getElementById('cap').classList.contains('in'),dl:!!sc.querySelector('.dl')}})()`);
    }
    if (CASE === 'skip' && w) {
      await w.webContents.executeJavaScript(`document.getElementById('skip').click()`); await sleep(900);
      r.closedAfterSkip = w.isDestroyed();
    }
    if (CASE === 'replay') {
      ipcMain.emit('pop:action', {}, 'whatsnew'); await sleep(2600);
      const w2 = tourWin(); r.replay = modeOf(w2);
      if (w2) r.replayFilm = await w2.webContents.executeJavaScript(`({short:window.KOIFILM.st().short,wn:!!document.querySelector('#scene .wn')})`);
    }
    await sleep(900);
    try { r.saved = JSON.parse(fs.readFileSync(SF, 'utf8')); } catch (e) { r.saved = null; }
    r.version = app.getVersion(); r.errs = errs;
    fs.writeFileSync(process.env.KOI_WN_OUT, JSON.stringify(r));
    app.exit(0);
  });
} else {
  // ---- parent: run the launches in order on one userData ----
  const LOG = '/tmp/koi-whatsnew.log'; fs.writeFileSync(LOG, '');
  let fails = 0; const out = s => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
  const ok = (c, m) => { out((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  const run = (name, ud, seed) => {
    const o = path.join(ud, '..', path.basename(ud) + '-' + name + '.json');
    const env = { ...process.env, KOI_WN_CASE: name, KOI_WN_UD: ud, KOI_WN_OUT: o, KOI_WN_SEED: seed || '' };
    const p = spawnSync(process.execPath, [__filename, '--no-sandbox'], { env, encoding: 'utf8', timeout: 60000 });
    try { return JSON.parse(fs.readFileSync(o, 'utf8')); } catch (e) { out('INFO ' + name + ' gave no result: ' + (p.stderr || '').slice(-600)); return { opened: '', errs: [] }; }
  };
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koi-wn-'));
  const V = app.getVersion();
  const noErr = (r, n) => ok(!(r.errs || []).length, n + ': no console errors' + ((r.errs || []).length ? ': ' + r.errs.slice(0, 3).join(' | ') : ''));

  // 1. a fresh install: the whole film, as before; the version is written down so it does not also get the short cut
  const A = mk();
  let r = run('fresh', A, 'none');
  ok(r.opened && r.opened.mode === 'tour', `fresh install opens the whole film (${JSON.stringify(r.opened)})`);
  ok(r.film && !r.film.st.short && r.film.dl, 'fresh install starts at the download scene, not the short cut');
  ok(r.saved && r.saved.newSeen === V && !r.saved.tourSeen, 'fresh install records the version, tour still unseen');
  noErr(r, 'fresh');
  // 2. quit before finishing the tour: the whole film again next launch (unchanged behaviour), never the short cut
  r = run('fresh2', A);
  ok(r.opened && r.opened.mode === 'tour', `unfinished tour plays the whole film again, not What is new (${JSON.stringify(r.opened)})`);

  // 3. upgrading from 2.1.2 or older (no version recorded yet): the short What is new cut plays by itself
  const B = mk();
  r = run('upgrade', B, JSON.stringify({ tourSeen: true, migFast: true, usage: { Safari: 3 } }));
  ok(r.opened && r.opened.mode === 'new', `update from 2.1.2 opens What is new by itself (${JSON.stringify(r.opened)})`);
  ok(r.film && r.film.st.short && r.film.wn && r.film.cards === 3, 'it opens straight into the What is new scene with three cards');
  ok(r.film && /Just updated\. What is new/.test(r.film.text) && r.film.now === V, `the heading shows the new version (${r.film && r.film.now})`);
  ok(r.film && !r.film.cap && !r.film.dl, 'no tutorial step and no download scene in the short cut');
  ok(r.saved && r.saved.newSeen === V && r.saved.tourSeen === true, 'the new version is recorded at once');
  noErr(r, 'upgrade');
  // 4. the same version again: nothing plays
  r = run('same', B);
  ok(r.opened === '', `same version: What is new does not play again (${JSON.stringify(r.opened)})`);

  // 5. a known older version: the odometer rolls 2.1.2 over to the new one, the light sweep is there; Skip closes it
  const C = mk();
  r = run('skip', C, JSON.stringify({ tourSeen: true, newSeen: '2.1.2', migFast: true }));
  ok(r.opened && r.opened.mode === 'new' && r.opened.from === '2.1.2', `version change 2.1.2 to ${V} opens What is new (${JSON.stringify(r.opened)})`);
  ok(r.film && r.film.was === '2.1.2' && r.film.now === V && r.film.sheen, 'the version rolls over from 2.1.2 and the light sweep is in the scene');
  ok(r.closedAfterSkip === true, 'Skip closes the What is new window');
  ok(r.saved && r.saved.newSeen === V && r.saved.tourSeen === true, 'still recorded after Skip, tour stays seen');
  noErr(r, 'skip');
  // 6. relaunch on the same version: nothing plays; What's new in the panel replays the short cut
  r = run('replay', C);
  ok(r.opened === '', 'relaunch on the same version: nothing plays by itself');
  ok(r.replay && r.replay.mode === 'new' && r.replayFilm && r.replayFilm.short && r.replayFilm.wn, `What's new in the menu-bar panel replays the short cut (${JSON.stringify(r.replay)})`);
  ok(r.saved && r.saved.newSeen === V, 'replaying does not change the recorded version');
  noErr(r, 'replay');

  // 7. the panel has the entry and the film has the new pieces
  const pop = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'popover.html'), 'utf8'), film = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.html'), 'utf8');
  ok(/data-a="whatsnew"/.test(pop), "the menu-bar panel has a What's new entry");
  const css = (film.match(/@keyframes (odout|odin|sheen)\{[^@]*?\}\}/g) || []);
  ok(css.length === 3 && css.every(k => !/(filter|width|height|left|top|margin|background)\s*:/.test(k)), 'the rollover and the light sweep animate only transform and opacity');
  out(fails ? `DONE with ${fails} FAIL` : 'DONE all PASS');
  app.exit(fails ? 1 : 0);
}

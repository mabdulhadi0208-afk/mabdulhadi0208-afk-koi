// Koi 2.0: springy fan app switcher for macOS (menu-bar app)
// Speed rules: the fan opens from what is already in memory (app list, running set, icon files on disk) and never
// waits on a scan, `ps` or an icon extraction. Those refresh in the background and push only what changed.
// Idle rules: nothing polls, loops or animates while Koi sits in the menu bar.
const {app,BrowserWindow,Tray,globalShortcut,screen,ipcMain,nativeImage,Notification,shell}=require('electron');
const path=require('path'),fs=require('fs'),fsp=fs.promises,os=require('os'),crypto=require('crypto'),{pathToFileURL}=require('url'),{execFile}=require('child_process');
const updater=require('./updater');
const {Switcher}=require('./switcher');

let tray=null,overlay=null,tour=null,settingsWin=null,aboutWin=null,popWin=null,popShown=false,lastPopHide=0,trayFrames=[],trayTimer=null,shown=false,lastToggle=0,hideT=null;
const DEF={theme:'dark',size:1,speed:1.3,sound:false,shortcut:'Alt+Space',hotkeys:[],tourSeen:false,usage:{},autoDownload:true,updateCard:true,skipped:null,
  switcher:true,switchReplace:true,switchScope:'all',switchMinimized:true,swScreenAsked:false};
let S={...DEF};
const SF=()=>path.join(app.getPath('userData'),'koi-settings.json');
const load=()=>{try{S={...DEF,...JSON.parse(fs.readFileSync(SF(),'utf8'))}}catch(e){}if(!S.migFast){S.speed=1.3;S.migFast=true;saveSoon()}};
// settings are written off the main thread, debounced; a sync write only happens on quit
let saveT=null,saving=Promise.resolve();
function saveSoon(){clearTimeout(saveT);saveT=setTimeout(()=>{saveT=null;const f=SF(),tmp=f+'.tmp',data=JSON.stringify(S);saving=saving.then(()=>fsp.writeFile(tmp,data)).then(()=>fsp.rename(tmp,f)).catch(()=>{})},350)}
function saveNow(){if(!saveT)return;clearTimeout(saveT);saveT=null;try{fs.writeFileSync(SF(),JSON.stringify(S))}catch(e){}}

if(!app.requestSingleInstanceLock()){app.quit();}

// ---------- installed / running apps, all cached ----------
const DIRS=['/Applications','/Applications/Utilities','/System/Applications','/System/Applications/Utilities',path.join(os.homedir(),'Applications')];
const PRIORITY=['Finder','Safari','Messages','Mail','Calendar','Notes','Music','Terminal','Photos','Maps','System Settings','Xcode','Slack','Spotify','Figma','Visual Studio Code','Google Chrome','Discord'];
const TOP=48,FINDER='/System/Library/CoreServices/Finder.app';
let catalog=[],scanAt=0,scanP=null;                    // [{name,path,m}] m = bundle mtime
function scanAsync(){
  if(scanP)return scanP;
  scanP=(async()=>{
    const out=new Map();
    const lists=await Promise.all(DIRS.map(d=>fsp.readdir(d).catch(()=>[])));
    DIRS.forEach((d,i)=>{for(const n of lists[i])if(n.endsWith('.app')){const name=n.slice(0,-4);if(!out.has(name))out.set(name,path.join(d,n))}});
    if(await fsp.access(FINDER).then(()=>true,()=>false))out.set('Finder',FINDER);
    const list=[...out].map(([name,p])=>({name,path:p,m:0}));
    await Promise.all(list.map(async a=>{try{a.m=Math.round((await fsp.stat(a.path)).mtimeMs)}catch(e){}}));
    catalog=list;scanAt=Date.now();return list;
  })().finally(()=>{scanP=null});
  return scanP;
}
// `ps` is cached for 3 s and never run twice at once
let runSet=new Set(),runAt=0,runP=null;
function running(maxAge=3000){
  if(Date.now()-runAt<maxAge)return Promise.resolve(runSet);
  if(runP)return runP;
  runP=new Promise(res=>{execFile('ps',['-axo','comm='],{maxBuffer:8e6},(e,out)=>{const set=new Set();if(!e)String(out).split('\n').forEach(l=>{const m=l.match(/\/([^/]+)\.app\/Contents\/MacOS\//);if(m)set.add(m[1])});runSet=set;runAt=Date.now();runP=null;res(set)})});
  return runP;
}
// ---- icon cache on disk: one PNG per app, keyed by bundle path + mtime, plus the icon's main colour ----
const ICONS=()=>path.join(app.getPath('userData'),'icon-cache');
let iconIdx={},idxT=null;                              // path -> {m, f (file name, '' if the app has no icon), c (colour)}
async function loadIconIdx(){try{iconIdx=JSON.parse(await fsp.readFile(path.join(ICONS(),'index.json'),'utf8'))||{}}catch(e){iconIdx={}}}
function saveIdxSoon(){clearTimeout(idxT);idxT=setTimeout(()=>{const f=path.join(ICONS(),'index.json');fsp.mkdir(ICONS(),{recursive:true}).then(()=>fsp.writeFile(f+'.tmp',JSON.stringify(iconIdx))).then(()=>fsp.rename(f+'.tmp',f)).catch(()=>{})},800)}
const iconUrl=f=>pathToFileURL(path.join(ICONS(),f)).href;
const fresh=a=>{const e=iconIdx[a.path];return e&&e.m===a.m?e:null};
function mainColour(img){
  try{const s=img.resize({width:8,height:8,quality:'good'}),b=s.toBitmap(),n=b.length/4;let r=0,g=0,bl=0,w=0;
    for(let i=0;i<n;i++){const B=b[i*4],G=b[i*4+1],R=b[i*4+2],A=b[i*4+3];if(A<200)continue;const mx=Math.max(R,G,B),mn=Math.min(R,G,B),sat=mx?((mx-mn)/mx):0,k=.15+sat*sat;r+=R*k;g+=G*k;bl+=B*k;w+=k}
    if(!w)return '';return `rgb(${Math.round(r/w)},${Math.round(g/w)},${Math.round(bl/w)})`}catch(e){return ''}
}
const inflight=new Map();
function extractIcon(a){
  if(inflight.has(a.path))return inflight.get(a.path);
  const p=(async()=>{
    let img=null;
    try{img=await nativeImage.createThumbnailFromPath(a.path,{width:128,height:128})}catch(e){}
    if(!img||img.isEmpty()){try{img=await app.getFileIcon(a.path,{size:'large'})}catch(e){}}
    const old=iconIdx[a.path];let entry={m:a.m,f:'',c:''};
    if(img&&!img.isEmpty()){
      const f=crypto.createHash('sha1').update(a.path).digest('hex').slice(0,14)+'-'+a.m+'.png';
      try{await fsp.mkdir(ICONS(),{recursive:true});await fsp.writeFile(path.join(ICONS(),f),img.resize({width:128,height:128,quality:'best'}).toPNG());entry={m:a.m,f,c:mainColour(img)}}catch(e){}
    }
    if(old&&old.f&&old.f!==entry.f)fsp.unlink(path.join(ICONS(),old.f)).catch(()=>{});
    iconIdx[a.path]=entry;saveIdxSoon();return entry;
  })().finally(()=>inflight.delete(a.path));
  inflight.set(a.path,p);return p;
}
// icons are made in small batches with a breath in between, so the main thread never stalls
async function warmIcons(list,onBatch){
  const need=list.filter(a=>!fresh(a));
  for(let i=0;i<need.length;i+=6){await Promise.all(need.slice(i,i+6).map(extractIcon));onBatch&&onBatch();await new Promise(r=>setTimeout(r,30))}
}
function ranked(){
  return catalog.map(a=>{const pr=PRIORITY.indexOf(a.name),run=runSet.has(a.name);return {...a,running:run,freq:(S.usage[a.name]||0)*1000+(run?400:0)+(pr>=0?(60-pr*2):0)}}).sort((a,b)=>b.freq-a.freq);
}
// the list the fan shows, built synchronously from memory (apps whose icon is still coming get a monogram tile)
function buildList(){
  const out=[];
  for(const a of ranked()){const e=fresh(a);if(e&&!e.f)continue;out.push({name:a.name,path:a.path,running:a.running,freq:a.freq,icon:e?iconUrl(e.f):'',col:e?e.c:''});if(out.length>=TOP)break}
  return out;
}
const sigOf=l=>l.map(a=>a.name+(a.running?'*':'')+(a.icon?'+':'')).join('|');
let sentSig='',refreshing=false;
function pushIfChanged(){const l=buildList(),s=sigOf(l);if(s===sentSig||!overlay||overlay.isDestroyed())return;sentSig=s;overlay.webContents.send('koi:apps',l)}
async function refresh(){
  if(refreshing)return;refreshing=true;
  try{if(!catalog.length||Date.now()-scanAt>15000)await scanAsync();await running();pushIfChanged();await warmIcons(ranked().slice(0,TOP),pushIfChanged)}
  catch(e){console.error('refresh',e&&e.message)}finally{refreshing=false}
}
// startup: pre-warm list + icons, deferred so launch stays light
async function prewarm(){
  await loadIconIdx();
  await scanAsync();
  await running(0);
  pushIfChanged();                                           // the hidden fan builds itself and decodes icons now
  await warmIcons(ranked().slice(0,TOP),pushIfChanged);
  const keep=new Set(Object.values(iconIdx).map(e=>e.f).filter(Boolean));   // tidy files of apps that changed or left
  fsp.readdir(ICONS()).then(fl=>fl.filter(f=>f.endsWith('.png')&&!keep.has(f)).forEach(f=>fsp.unlink(path.join(ICONS(),f)).catch(()=>{}))).catch(()=>{});
}

// ---------- the fan window: created hidden at startup, sized to the fan, really hidden when closed ----------
const pub=()=>({theme:S.theme,size:S.size,speed:S.speed,sound:!!S.sound});
function fanRect(){
  const pt=screen.getCursorScreenPoint(),wa=screen.getDisplayNearestPoint(pt).workArea,z=S.size||1;
  const r=Math.ceil(350*z),cl=(v,lo,hi)=>lo>hi?(lo+hi)/2:Math.max(lo,Math.min(hi,v));
  const cx=Math.round(cl(pt.x,wa.x+r*.62,wa.x+wa.width-r)),cy=Math.round(cl(pt.y,wa.y+r*.86,wa.y+wa.height-r*.86));
  return {x:cx-r,y:cy-r,width:2*r,height:2*r};
}
function makeOverlay(){
  overlay=new BrowserWindow({show:false,frame:false,transparent:true,hasShadow:false,resizable:false,movable:false,skipTaskbar:true,alwaysOnTop:true,fullscreenable:false,backgroundColor:'#00000000',...fanRect(),
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,autoplayPolicy:'no-user-gesture-required',
      // Never background the fan's renderer. A hidden, throttled renderer is what made the first open after 5+ minutes
      // stutter: after 5 minutes hidden Chromium switches on intensive wake-up throttling, drops the renderer to
      // background priority (on Apple Silicon: the efficiency cores), puts V8 in memory-saving mode and evicts the
      // compositor's frames, so the first open had to wake, re-promote and rebuild all of it while animating.
      // This costs nothing while idle: the fan has no timers or loops when closed (npm test checks it).
      backgroundThrottling:false}});
  overlay.setAlwaysOnTop(true,'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
  overlay.loadFile(path.join(__dirname,'renderer','app.html'),{query:{mode:'overlay'}});
  overlay.webContents.once('did-finish-load',()=>{sentSig='';overlay.webContents.send('koi:settings',pub());pushIfChanged()});
  overlay.on('blur',()=>{if(shown)hideOverlay()});
  overlay.on('closed',()=>{overlay=null;shown=false});
}
function showOverlay(){
  if(!overlay||overlay.isDestroyed())makeOverlay();
  clearTimeout(hideT);
  overlay.setBounds(fanRect());
  const l=buildList(),s=sigOf(l),apps=s!==sentSig?l:null;if(apps)sentSig=s;
  const send=()=>overlay.webContents.send('koi:show',{apps,settings:pub(),t:Date.now()});
  if(overlay.webContents.isLoading())overlay.webContents.once('did-finish-load',send);else send();
  noNap();shown=true;overlay.show();overlay.focus();
  // the background refresh (scan, ps, icons) waits until the bloom has settled, so it never competes with it
  setImmediate(()=>animateTray(true));clearTimeout(refreshT);refreshT=setTimeout(refresh,600);
}
// main-side close: the fan plays a short fold, then tells us to hide; a timer makes sure it really goes
function hideOverlay(){
  if(!overlay||overlay.isDestroyed()||!shown)return;
  shown=false;overlay.webContents.send('koi:close');
  clearTimeout(hideT);hideT=setTimeout(()=>{if(!shown&&overlay&&!overlay.isDestroyed())overlay.hide()},260);napLater();
}
function hideNow(){shown=false;clearTimeout(hideT);if(overlay&&!overlay.isDestroyed())overlay.hide();napLater()}
// App Nap: an idle menu-bar app gets napped by macOS (timers coalesced, lower priority). Koi holds a
// "user-initiated activity" only from the first key of the chord, or the show, until 3 s after the fan closes.
let napId=-1,napT=null,refreshT=null,warmAt=0;
function noNap(){clearTimeout(napT);napT=setTimeout(napOff,8000);try{const {powerSaveBlocker}=require('electron');if(napId<0||!powerSaveBlocker.isStarted(napId))napId=powerSaveBlocker.start('prevent-app-suspension')}catch(e){}}
function napOff(){clearTimeout(napT);napT=null;if(shown)return;try{if(napId>=0)require('electron').powerSaveBlocker.stop(napId)}catch(e){}napId=-1}
function napLater(){clearTimeout(napT);napT=setTimeout(napOff,3000)}
// warm-up: the first modifier of a chord went down. Wake the app and the fan's renderer (decode the first page of
// icons, touch layout) in the ~100 ms before the second key arrives, so the show finds everything awake.
function warmOverlay(){
  if(shown||Date.now()-warmAt<1500||!overlay||overlay.isDestroyed())return;warmAt=Date.now();
  noNap();napLater();try{overlay.webContents.send('koi:warm')}catch(e){}
}
function toggle(){if(sw&&sw.isOpen())return;const t=Date.now();if(t-lastToggle<250)return;lastToggle=t;shown?hideOverlay():showOverlay()}
function openTour(){
  if(tour&&!tour.isDestroyed()){tour.focus();return}
  tour=new BrowserWindow({width:1280,height:800,minWidth:900,minHeight:600,titleBarStyle:'hiddenInset',backgroundColor:'#0a0c15',show:false,
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,autoplayPolicy:'no-user-gesture-required'}});
  tour.once('ready-to-show',()=>tour.show());
  tour.loadFile(path.join(__dirname,'renderer','app.html'),{query:{mode:'tour',v:app.getVersion()}});
  tour.on('closed',()=>{tour=null});
}

// ---------- hotkeys ----------
const SYM={Command:'⌘',CommandOrControl:'⌘',Control:'⌃',Alt:'⌥',Shift:'⇧'};
const pretty=a=>(a||'').split('+').map(p=>SYM[p]||(p==='Return'?'↩︎':p)).join(' ');
const label=()=>pretty(S.shortcut);
const norm=a=>String(a).replace('CommandOrControl','Command').toLowerCase();
const modOnly=a=>typeof a==='string'&&/^(Command|Control|Alt|Shift)(\+(Command|Control|Alt|Shift))+$/.test(a);
const validAcc=a=>modOnly(a)||typeof a==='string'&&/^((Command|Control|Alt|Shift)\+)*([A-Z0-9]|F\d{1,2}|Space|Return|Tab|Backspace|Up|Down|Left|Right|[-=,./;'`\[\]\\])$/.test(a)&&(/\+/.test(a)||/^F\d{1,2}$/.test(a));
function canRegister(acc){if(modOnly(acc)){startHook(true);return hookLoaded}globalShortcut.unregisterAll();let ok=false;try{ok=globalShortcut.register(acc,()=>{});if(ok)globalShortcut.unregister(acc)}catch(e){}return ok}
function launchApp(p,name){S.usage[name]=(S.usage[name]||0)+1;saveSoon();execFile('open',['-a',p],()=>{})}

// ---- modifier-only chords (e.g. ⌘⌥) through a key hook (uiohook) that runs in THIS process ----
// Why here and not in a utility process (Koi 2.0.0 did that, and Command + Option never fired):
//  1. libuiohook hands every key press, modifiers included, to the main dispatch queue with dispatch_sync (its
//     key-typed lookup, libuiohook/src/darwin/input_hook.c). Only a process whose main thread runs a CFRunLoop
//     drains that queue. Koi's main process does; a utility process does not, so the hook thread hung on the
//     first key press (the Command of Command + Option), the Option never arrived and the tap went dead.
//  2. macOS grants Accessibility to the process that creates the event tap. That must be the process that
//     isTrustedAccessibilityClient answers for, or the permission check means nothing.
// The hook only exists while a chord is set. CI builds it to ask for key events only and to skip the key-typed
// lookup (build/patch-uiohook.js), so typing never waits on Koi.
const KOI_ID='com.koi.switcher';
let hookOk=false,hookLoaded=false,chords=[],recording=false,hookErr='',quitting=false,retryT=null,retryN=0,uio=null;
let trustTest=null,idleTest=null;                              // tests only (KOI_TEST): simulate macOS answers
const trusted=prompt=>{if(trustTest!==null)return trustTest;if(process.platform!=='darwin')return true;try{return require('electron').systemPreferences.isTrustedAccessibilityClient(!!prompt)}catch(e){return false}};
try{require.resolve('uiohook-napi');hookLoaded=true}catch(e){console.error('key hook unavailable',e&&e.message)}
// uiohook key codes: left and right Option, Control, Shift, Command
const M={56:'Alt',3640:'Alt',29:'Control',3613:'Control',42:'Shift',54:'Shift',3675:'Command',3676:'Command'};
const STALE=20000;                                             // a modifier "held" this long lost its key-up
const held=new Map();let dirty=false,fired=false,evN=0,lastEvAt=0;
const cur=()=>{const n=new Set([...held.keys()].map(x=>x.split(':')[0]));return ['Command','Control','Alt','Shift'].filter(x=>n.has(x)).join('+')};
function resetKeys(){held.clear();dirty=false;fired=false}
// fires the instant the held modifiers are exactly a chord; a real key in between (Command + Option + K) cancels it
function onKey(type,keycode,now=Date.now()){
  evN++;lastEvAt=now;if(hookOk&&health!=='ok'&&health!=='fixed')heard();
  const m=M[keycode];
  if(type==='down'){
    if(!m){if(held.size)dirty=true;return}
    for(const [k,t] of held)if(now-t>STALE)held.delete(k);    // a key-up macOS never delivered (secure input, sleep, a tap timeout)
    if(!held.size){dirty=false;fired=false}                    // a fresh gesture: nothing stuck from the last one
    held.set(m+':'+keycode,now);
    if(sw&&sw.isOpen())dirty=true;                             // Cmd+Tab is in progress: Command + Option must not fire
    if(dirty||fired||recording)return;
    const acc=cur();
    if(!acc.includes('+')){if(chords.some(c=>c.fn===toggle&&c.acc.split('+').includes(acc)))warmOverlay();return}
    const c=chords.find(c=>c.acc===acc);if(c){fired=true;try{c.fn()}catch(e){console.error('chord',e&&e.message)}}
  }else{if(!m)return;held.delete(m+':'+keycode);if(!held.size){dirty=false;fired=false}}
}
function stopHook(){clearTimeout(retryT);retryT=null;stopProbe();if(hookOk&&uio){try{uio.stop()}catch(e){}}hookOk=false;resetKeys()}
function startHook(prompt,quiet){
  if(hookOk||!hookLoaded||quitting)return hookOk;
  if(!trusted(prompt)){hookErr='permission';setHealth('denied');scheduleRetry();return false}
  try{
    if(!uio){uio=require('uiohook-napi').uIOhook;
      // replace the EventEmitter fan-out: only key events, nothing else is looked at
      uio.handler=function(e){const t=e.type;if(t===4||t===5)onKey(t===4?'down':'up',e.keycode)}}
    uio.start();
  }catch(e){hookErr='start';console.error('key hook start',e&&e.message);setHealth('broken');scheduleRetry();return false}
  hookOk=true;hookErr='';retryN=0;clearTimeout(retryT);retryT=null;resetKeys();
  evN=0;hookAt=Date.now();activeN=0;
  if(!quiet)setHealth(BAD.includes(health)?'fixed':'waiting');
  startProbe();
  try{reg()}catch(e){}
  return true;
}
// while a chord needs the hook and it is not running: every 1.5 s while the permission card is up, otherwise every
// 2 s for a minute, then every 15 s. It stops as soon as the hook runs or no chord needs it.
function scheduleRetry(){if(retryT||quitting)return;retryT=setTimeout(()=>{retryT=null;if(hookOk||!hookLoaded||!chords.length)return;retryN++;startHook(false);if(!hookOk)scheduleRetry()},permShown()?1500:retryN<30?2000:15000)}

// ---- hook health: notice when macOS stops passing keys to Koi, and heal as soon as it does again ----
// health: off (no chord) | waiting (hook runs, no key heard yet) | ok | fixed (just healed) | denied (no
// Accessibility, or a grant macOS no longer honours) | deaf (hook runs, but the Mac is in use and no key reaches it)
// | broken (the hook would not start). The probe only runs while the hook has not heard a single key yet.
let health='off',hookAt=0,activeN=0,probeT=null,deafN=0;
const PROBE_MS=()=>permShown()?4000:30000,DEAF_AFTER=6;     // 6 probes of an active Mac with no key at all
function startProbe(){stopProbe();probeT=setTimeout(probe,PROBE_MS())}
function stopProbe(){clearTimeout(probeT);probeT=null}
function idleSecs(){if(idleTest!==null)return idleTest;try{return require('electron').powerMonitor.getSystemIdleTime()}catch(e){return 1e9}}
function probe(){
  probeT=null;if(!hookOk||!chords.length)return;
  if(!trusted(false)){stopHook();hookErr='permission';setHealth('denied');scheduleRetry();return}   // revoked, or went stale
  if(evN){heard();return}
  if(idleSecs()<30)activeN++;
  if(activeN>=DEAF_AFTER)return deafNow('quiet');
  startProbe();
}
// proof that the hook is deaf: the Mac is in use (or a key shortcut just fired) and the hook heard nothing.
// First a quiet restart of the hook; if it is still deaf after that, the permission card explains the fix.
function deafNow(why){
  deafN++;console.error('key hook deaf',why,deafN);
  stopHook();startHook(false,true);
  if(hookOk&&deafN>=2)setHealth('deaf');
}
function heard(){if(health==='ok'||health==='fixed')return;stopProbe();deafN=0;setHealth(health==='deaf'||health==='broken'||health==='denied'?'fixed':'ok')}
const BAD=['denied','deaf','broken'];
function setHealth(h){
  if(h==='fixed'&&!permShown())h='ok';
  if(h===health)return;health=h;
  if(!BAD.includes(h))permSnooze='';
  if(BAD.includes(h))showPermCard(false);
  else if(h==='fixed'){pushPerm();clearTimeout(permAutoT);permAutoT=setTimeout(()=>{if(health==='fixed')health='ok';hidePermCard()},2800)}
  pushPerm();sendPop();
}
// a regular shortcut that holds modifiers fired: the hook must have heard those modifiers go down
function crossCheck(){if(!hookOk||!chords.length)return;const t=Date.now();setTimeout(()=>{if(hookOk&&t-hookAt>3000&&lastEvAt<t-1500)deafNow('shortcut')},1500)}

let regStatus={main:false,hk:[]};
function tryReg(acc,fn){if(modOnly(acc)){chords=chords.filter(c=>c.acc!==acc);chords.push({acc,fn});return hookOk}try{if(globalShortcut.isRegistered(acc))globalShortcut.unregister(acc);const f=()=>{crossCheck();fn()};return globalShortcut.register(acc,f)&&globalShortcut.isRegistered(acc)}catch(e){console.error('reg fail',acc,e&&e.message);return false}}
function reg(){
  globalShortcut.unregisterAll();chords=[];
  let ok=tryReg(S.shortcut,toggle);
  if(!ok&&S.shortcut!==DEF.shortcut){tryReg(DEF.shortcut,toggle)}/* temporary fallback only; never overwrite the saved shortcut (old instance may still hold it during an update) */
  regStatus={main:ok,hk:S.hotkeys.map(h=>tryReg(h.acc,()=>launchApp(h.path,h.name)))};
  if(chords.length){if(!hookOk)startHook(false)}else{if(hookOk)stopHook();clearTimeout(retryT);retryT=null;stopProbe();deafN=0;if(health!=='off'){health='off';hidePermCard();pushPerm()}}
  if(!ok)console.error('main shortcut failed');
}

// ---- the permission card: Lumen-style, top of the screen, says exactly what to do, and heals itself ----
let permWin=null,permSnooze='',permAutoT=null;
const permShown=()=>!!(permWin&&!permWin.isDestroyed()&&permWin.isVisible());
const chordLabel=()=>{const c=chords[0];return c?pretty(c.acc):''};
const chordWhat=()=>{const c=chords[0];if(!c)return '';const h=S.hotkeys.find(h=>h.acc===c.acc);return h&&c.acc!==S.shortcut?'opens '+h.name:'opens the fan'};
const permState=()=>({state:health,chord:chordLabel(),what:chordWhat(),trusted:trusted(false),hook:hookOk,err:hookErr,mac:process.platform==='darwin'});
function pushPerm(){if(permWin&&!permWin.isDestroyed()){try{permWin.webContents.send('perm:state',permState())}catch(e){}}}
function showPermCard(manual){
  if(!manual&&(permSnooze===health||!BAD.includes(health)))return;
  if(manual)permSnooze='';
  clearTimeout(permAutoT);
  if(permWin&&!permWin.isDestroyed()){if(!permWin.isVisible())permWin.showInactive();pushPerm();scheduleRetryFast();return}
  const d=screen.getPrimaryDisplay().workArea,w=620,h=384;
  permWin=new BrowserWindow({width:w,height:h,x:Math.round(d.x+d.width/2-w/2),y:d.y+6,frame:false,transparent:true,hasShadow:false,resizable:false,alwaysOnTop:true,skipTaskbar:true,focusable:true,fullscreenable:false,backgroundColor:'#00000000',show:false,
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}});
  permWin.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});permWin.setAlwaysOnTop(true,'screen-saver');
  permWin.loadFile(path.join(__dirname,'renderer','perm.html'),{query:{theme:S.theme||'dark'}});
  permWin.once('ready-to-show',()=>{if(!permWin||permWin.isDestroyed())return;permWin.showInactive();pushPerm();scheduleRetryFast()});
  permWin.on('closed',()=>{permWin=null});
}
// the card is up: look for the permission every 1.5 s (and the probe every 4 s) so the hotkey comes back the moment it can
function scheduleRetryFast(){if(!hookOk&&chords.length){clearTimeout(retryT);retryT=null;scheduleRetry()}else if(hookOk&&probeT){startProbe()}}
// it folds itself away first, then the window is destroyed (nothing of it stays around)
function hidePermCard(){clearTimeout(permAutoT);if(!permWin||permWin.isDestroyed())return;try{permWin.webContents.send('perm:hide')}catch(e){}const w=permWin;setTimeout(()=>{if(!w.isDestroyed())w.destroy()},260)}
const PANES={access:'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',input:'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'};
// "Open Accessibility": a grant macOS no longer honours cannot be switched back on, so Koi first clears its own stale
// entry (tccutil reset only touches Koi), asks macOS to list Koi again, then opens the exact pane.
function openPane(which){
  const go=()=>{if(which==='access')trusted(true);shell.openExternal(PANES[which]).catch(()=>{})};
  if(process.platform==='darwin'&&!hookOk&&(health==='denied'||health==='deaf'||health==='broken'))execFile('tccutil',['reset',which==='access'?'Accessibility':'ListenEvent',KOI_ID],()=>go());
  else go();
  if(BAD.includes(health))showPermCard(true);
}
ipcMain.handle('perm:action',(_e,a)=>{
  if(swCard&&!swCard.isDestroyed()&&_e&&_e.sender===swCard.webContents)return swCardAction(a);
  if(a==='state')return permState();
  if(a==='access'||a==='input')openPane(a);
  else if(a==='later'){permSnooze=health;hidePermCard()}
  else if(a==='close'){hidePermCard()}
  else if(a==='retry'){if(!hookOk)startHook(false);else deafNow('manual')}
  return permState();
});
const winOpts=(w,h,bg)=>({width:w,height:h,titleBarStyle:'hiddenInset',backgroundColor:bg,show:false,webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}});
function openSettings(){
  if(settingsWin&&!settingsWin.isDestroyed()){settingsWin.focus();return}
  settingsWin=new BrowserWindow({...winOpts(940,700,S.theme==='light'?'#f5f6fb':'#0a0c15'),minWidth:780,minHeight:560});
  settingsWin.once('ready-to-show',()=>settingsWin.show());
  settingsWin.loadFile(path.join(__dirname,'renderer','settings.html'),{query:{theme:S.theme,v:app.getVersion()}});
  settingsWin.on('closed',()=>{settingsWin=null;recording=false;resetKeys();reg();sendPop()});   // closing mid-recording must not leave chords paused
}
function openAbout(){
  if(aboutWin&&!aboutWin.isDestroyed()){aboutWin.focus();return}
  aboutWin=new BrowserWindow({...winOpts(560,620,'#0a0c15'),resizable:false,minimizable:false,maximizable:false});
  aboutWin.once('ready-to-show',()=>aboutWin.show());
  aboutWin.loadFile(path.join(__dirname,'renderer','about.html'),{query:{v:app.getVersion(),theme:S.theme}});
  aboutWin.on('closed',()=>{aboutWin=null});
}
// ---------- tray icon (blooming fan frames, one short bloom) + custom springy popover ----------
function loadFrames(){trayFrames=[];for(let k=0;k<7;k++){const im=nativeImage.createFromPath(path.join(__dirname,'assets',`trayFrame${k}Template.png`));im.setTemplateImage(true);trayFrames.push(im)}}
function animateTray(open){
  if(!tray||!trayFrames.length)return;
  if(!open){if(!trayTimer)return;clearInterval(trayTimer);trayTimer=null;tray.setImage(trayFrames[6]);return}
  if(trayTimer)return;                                       // one bloom at a time, never a loop
  const seq=[1,3,5,6];let i=0;tray.setImage(trayFrames[0]);
  trayTimer=setInterval(()=>{tray.setImage(trayFrames[seq[i++]]);if(i>=seq.length){clearInterval(trayTimer);trayTimer=null}},34);
}
function setBadge(on){try{tray&&tray.setTitle(on?' ↑':'')}catch(e){}}
function popState(){return {theme:S.theme,size:S.size,speed:S.speed,sound:!!S.sound,login:!!app.getLoginItemSettings().openAtLogin,autoDownload:S.autoDownload!==false,shortcut:label(),version:app.getVersion(),upd:updater.snapshot(),apps:catalog.length,hk:S.hotkeys.length}}
function sendPop(){if(popWin&&!popWin.isDestroyed())popWin.webContents.send('pop:state',popState())}
const POPW=372;
function makePopover(){
  popWin=new BrowserWindow({width:POPW,height:640,show:false,frame:false,transparent:true,hasShadow:false,resizable:false,movable:false,skipTaskbar:true,alwaysOnTop:true,fullscreenable:false,backgroundColor:'#00000000',
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}});
  popWin.setAlwaysOnTop(true,'pop-up-menu');popWin.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
  popWin.loadFile(path.join(__dirname,'renderer','popover.html'));
  popWin.on('blur',()=>{if(popShown)hidePopover()});
}
function showPopover(){
  if(!popWin||popWin.isDestroyed())makePopover();
  const b=tray?tray.getBounds():{x:0,y:0,width:0,height:0},disp=screen.getDisplayMatching(b),wa=disp.workArea;
  let x=Math.round(b.x+b.width/2-POPW/2);x=Math.max(wa.x+4,Math.min(x,wa.x+wa.width-POPW-4));
  popWin.setPosition(x,Math.max(wa.y,b.y+b.height-4));
  popShown=true;animateTray(true);
  const send=()=>popWin.webContents.send('pop:show',{state:popState(),anchor:Math.round(b.x+b.width/2-x)-14});
  if(popWin.webContents.isLoading())popWin.webContents.once('did-finish-load',send);else send();
  popWin.show();popWin.focus();
  if(Date.now()-(updater.snapshot().lastCheck||0)>10*60000)updater.actions.quiet();   // a fresh look for updates when you look
}
function hidePopover(){if(!popShown)return;popShown=false;lastPopHide=Date.now();if(popWin&&!popWin.isDestroyed()){popWin.webContents.send('pop:hide');setTimeout(()=>{if(!popShown&&popWin&&!popWin.isDestroyed())popWin.hide()},190)}}
function togglePopover(){if(popShown)hidePopover();else if(Date.now()-lastPopHide>220)showPopover()}

// ---------- IPC ----------
ipcMain.on('koi:hide',()=>hideNow());                 // the fan finished folding
ipcMain.on('koi:iconBad',(_e,p)=>{if(typeof p==='string'&&iconIdx[p]){delete iconIdx[p];const a=catalog.find(x=>x.path===p);if(a)extractIcon(a).then(pushIfChanged)}});
ipcMain.handle('pop:get',()=>popState());
ipcMain.on('pop:size',(_e,h)=>{if(popWin&&!popWin.isDestroyed()&&h>100&&h<1000)popWin.setSize(POPW,Math.round(h))});
ipcMain.on('pop:set',(_e,k,v)=>{
  if(k==='theme'&&(v==='light'||v==='dark'))S.theme=v;
  else if(k==='size'&&[.85,1,1.2,1.4].includes(+v))S.size=+v;
  else if(k==='speed'&&[.7,1,1.3].includes(+v))S.speed=+v;
  else if(k==='sound')S.sound=!!v;
  else if(k==='autoDownload')S.autoDownload=!!v;
  else if(k==='login'){S.login=!!v;try{app.setLoginItemSettings({openAtLogin:!!v})}catch(e){}}
  else return;
  saveSoon();
  if(overlay&&!overlay.isDestroyed())overlay.webContents.send('koi:settings',pub());
});
ipcMain.on('pop:action',(_e,a)=>{
  if(a==='open'){hidePopover();setTimeout(()=>showOverlay(),200)}
  else if(a==='hotkeys'){hidePopover();openSettings()}
  else if(a==='tour'){hidePopover();openTour()}
  else if(a==='about'){hidePopover();openAbout()}
  else if(a==='update'){updater.actions.check()}
  else if(a==='download'){updater.actions.download()}
  else if(a==='install'){updater.actions.install()}
  else if(a==='repo'){shell.openExternal('https://github.com/mabdulhadi0208-afk/mabdulhadi0208-afk-koi/releases')}
  else if(a==='quit'){app.isQuitting=true;app.quit()}
});
ipcMain.handle('upd:action',(_e,a)=>{const f=updater.actions[a];return f?f():null});
// launching: hide first, then open the app, then save the usage later
ipcMain.on('koi:launch',(_e,p,name)=>{
  if(typeof p!=='string'||!p.endsWith('.app')||typeof name!=='string')return;
  hideNow();
  setImmediate(()=>execFile('open',['-a',p],()=>{}));
  S.usage[name]=(S.usage[name]||0)+1;runSet.add(name);saveSoon();
});
ipcMain.on('koi:action',(_e,kind,p,name)=>{
  if(typeof p!=='string'||!p.endsWith('.app')||typeof name!=='string')return;
  const safe=name.replace(/["\\]/g,''),done=()=>{runAt=0};
  if(kind==='new')execFile('open',['-n','-a',p],done);
  else if(kind==='hide')execFile('osascript',['-e',`tell application "System Events" to set visible of process "${safe}" to false`],done);
  else if(kind==='quit')execFile('osascript',['-e',`tell application "${safe}" to quit`],()=>{runSet.delete(name);done()});
});
const taken=(acc,skip)=>norm(acc)===norm(S.shortcut)&&skip!=='main'||S.hotkeys.some((h,i)=>i!==skip&&norm(h.acc)===norm(acc));
ipcMain.handle('koi:s:get',async()=>{if(!catalog.length)await scanAsync();return {sw:swSettings(),status:regStatus,perm:{needed:modOnly(S.shortcut)||S.hotkeys.some(h=>modOnly(h.acc)),trusted:trusted(false),hook:hookOk,err:hookErr,health},main:S.shortcut,hk:S.hotkeys.map(h=>{const e=iconIdx[h.path];return {...h,icon:e&&e.f?iconUrl(e.f):''}}),apps:catalog.map(a=>({name:a.name,path:a.path})).sort((a,b)=>a.name.localeCompare(b.name))}});
ipcMain.on('koi:s:openAccess',()=>openPane('access'));
ipcMain.on('koi:s:fixPerm',()=>{if(BAD.includes(health))showPermCard(true);else openPane('access')});
ipcMain.handle('koi:s:pause',()=>{recording=true;globalShortcut.unregisterAll()});
ipcMain.handle('koi:s:resume',()=>{recording=false;resetKeys();reg()});
ipcMain.handle('koi:s:setMain',(_e,acc)=>{
  if(!validAcc(acc))return {ok:false,msg:'That key combo is not valid.',where:'m1'};
  if(taken(acc,'main')&&norm(acc)!==norm(S.shortcut))return {ok:false,msg:'One of your app hotkeys already uses it.',where:'m1'};
  if(!canRegister(acc)){reg();return {ok:false,msg:'macOS or another app already owns that shortcut.',where:'m1'}}
  S.shortcut=acc;saveSoon();reg();sendPop();return {ok:true};
});
ipcMain.handle('koi:s:add',(_e,acc,name,p)=>{
  if(!validAcc(acc)||typeof p!=='string'||!p.endsWith('.app'))return {ok:false,msg:'That key combo is not valid.',where:'m2'};
  if(taken(acc,-1))return {ok:false,msg:'You already use that shortcut.',where:'m2'};
  if(!canRegister(acc)){reg();return {ok:false,msg:'macOS or another app already owns that shortcut.',where:'m2'}}
  S.hotkeys.push({acc,name:String(name),path:p});saveSoon();reg();return {ok:true};
});
ipcMain.handle('koi:s:update',(_e,i,acc)=>{
  if(!S.hotkeys[i]||!validAcc(acc))return {ok:false,where:'m2'};
  if(taken(acc,i))return {ok:false,msg:'You already use that shortcut.',where:'m2'};
  if(norm(acc)!==norm(S.hotkeys[i].acc)&&!canRegister(acc)){reg();return {ok:false,msg:'macOS or another app already owns that shortcut.',where:'m2'}}
  S.hotkeys[i].acc=acc;saveSoon();reg();return {ok:true};
});
ipcMain.handle('koi:s:remove',(_e,i)=>{S.hotkeys.splice(i,1);saveSoon();reg();return {ok:true}});
ipcMain.on('koi:tourDone',()=>{
  S.tourSeen=true;saveSoon();
  if(tour&&!tour.isDestroyed())tour.close();
  try{new Notification({title:'Koi is ready',body:`Press ${label()} anywhere and your apps fan out around the cursor. Koi lives in the menu bar.`}).show()}catch(e){}
});

// ---------- the window switcher (Koi 2.1): Cmd+Tab with live window previews ----------
// The keyboard side lives in a small native helper (native/koi-switch.swift, Koi.app/Contents/MacOS/koi-switch):
// its event tap consumes Cmd+Tab so Apple's switcher never shows. The logic lives in switcher.js. The panel is a
// warm hidden window like the fan (never backgrounded), shown without taking focus, so the app you are in stays the
// front app until you let go of Command.
const SW_OK=process.platform==='darwin'||!!process.env.KOI_SWITCH_HELPER;
let swWin=null,swShown=false,swHideT=null,swBoundsKey='',swCard=null,swCardKind='',swCardT=null,swCardAuto=null,swSnooze={};
const swBin=()=>app.isPackaged?path.join(path.dirname(process.execPath),'koi-switch'):path.join(__dirname,'native','bin','koi-switch');
function swRun(args,opts={}){
  const {spawn}=require('child_process');
  if(process.env.KOI_SWITCH_HELPER)return spawn(process.execPath,[process.env.KOI_SWITCH_HELPER,...args],{...opts,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
  const bin=swBin();if(!fs.existsSync(bin))throw new Error('koi-switch is missing at '+bin);
  return spawn(bin,args,opts);
}
const swCache=()=>path.join(app.getPath('userData'),'switch-cache');
// Apple's Cmd+Tab back on, no matter what state the helper died in
function swRestore(){try{const p=swRun(['--restore'],{stdio:'ignore'});p.on('error',()=>{});p.unref&&p.unref()}catch(e){}}
function swArea(){return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea}
function makeSwitchWin(){
  const a=swArea();
  swWin=new BrowserWindow({show:false,frame:false,transparent:true,hasShadow:false,resizable:false,movable:false,skipTaskbar:true,alwaysOnTop:true,fullscreenable:false,
    focusable:false,acceptFirstMouse:true,backgroundColor:'#00000000',...(process.platform==='darwin'?{type:'panel'}:{}),x:a.x,y:a.y,width:a.width,height:a.height,
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  swBoundsKey=[a.x,a.y,a.width,a.height].join();
  swWin.setAlwaysOnTop(true,'screen-saver');swWin.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
  swWin.loadFile(path.join(__dirname,'renderer','switcher.html'));
  swWin.on('closed',()=>{swWin=null;swShown=false});
  swWin.webContents.on('render-process-gone',()=>{try{swWin&&swWin.destroy()}catch(e){}swWin=null;if(sw&&sw.isOpen())sw.cancel()});
}
const swUI={
  show(p){
    if(!swWin||swWin.isDestroyed())makeSwitchWin();
    clearTimeout(swHideT);if(shown)hideNow();
    const a=swArea(),k=[a.x,a.y,a.width,a.height].join();if(k!==swBoundsKey){swBoundsKey=k;swWin.setBounds(a)}
    const send=()=>swWin.webContents.send('sw:show',{...p,theme:S.theme,t:Date.now()});
    if(swWin.webContents.isLoading())swWin.webContents.once('did-finish-load',send);else send();
    noNap();swShown=true;swWin.showInactive();
  },
  select(i){if(swWin&&!swWin.isDestroyed())swWin.webContents.send('sw:select',i)},
  update(p){if(swWin&&!swWin.isDestroyed())swWin.webContents.send('sw:update',p)},
  thumb(wid,url){if(swWin&&!swWin.isDestroyed())swWin.webContents.send('sw:thumb',{wid,url})},
  hide(){
    if(!swWin||swWin.isDestroyed()||!swShown)return;swShown=false;swWin.webContents.send('sw:hide');
    clearTimeout(swHideT);swHideT=setTimeout(()=>{if(!swShown&&swWin&&!swWin.isDestroyed())swWin.hide()},170);napLater();
    if(sw.perm.screen===false&&!S.swScreenAsked&&sw.opens>0){S.swScreenAsked=true;saveSoon();setTimeout(()=>showSwCard('screen'),500)}
  }
};
// previews when the helper could not capture a window: Electron's own window thumbnails (same Screen Recording grant)
async function swElectronThumbs(wids){
  const {desktopCapturer}=require('electron'),out={};
  const src=await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:520,height:340},fetchWindowIcons:false});
  for(const s of src){const m=/^window:(\d+):/.exec(s.id);if(m&&wids.includes(+m[1])&&!s.thumbnail.isEmpty())out[m[1]]=s.thumbnail.toDataURL()}
  return out;
}
const sw=new Switcher({
  spawn:()=>swRun(['--cache',swCache(),'--parent',String(process.pid)],{stdio:['pipe','pipe','pipe']}),
  ui:swUI,settings:()=>S,restore:swRestore,
  blocked:()=>shown,                                            // the fan is open: it owns the keyboard
  onOpen:()=>{if(held.size)dirty=true},                         // a real key (Tab) went down in this gesture
  warm:()=>{noNap();napLater();if(swWin&&!swWin.isDestroyed())try{swWin.webContents.send('sw:warm')}catch(e){}},
  onState:st=>{if(st.status==='needs-access'&&S.switcher!==false)showSwCard('access');if(swCardKind==='access'&&st.status==='ready')swCardFixed();pushSwCard();sendSettings()},
  thumbFallback:swElectronThumbs,
  log:(...a)=>console.error(...a)
});
function sendSettings(){if(settingsWin&&!settingsWin.isDestroyed())try{settingsWin.webContents.send('koi:s:changed')}catch(e){}}
function swStart(){if(SW_OK)sw.start()}
// ---- the switcher's permission card (renderer/perm.html in its "screen" or "access" mode) ----
const swCardShown=()=>!!(swCard&&!swCard.isDestroyed()&&swCard.isVisible());
const swCardState=()=>({kind:swCardKind,state:swCardKind==='screen'?(sw.perm.screen?'fixed':'need'):(sw.status==='ready'?'fixed':'need'),chord:S.switchReplace!==false?'⌘ Tab':'⌥ Tab',mac:process.platform==='darwin'});
function pushSwCard(){if(swCard&&!swCard.isDestroyed())try{swCard.webContents.send('perm:state',swCardState())}catch(e){}}
function showSwCard(kind,manual){
  if(!manual&&swSnooze[kind])return;
  if(kind==='screen'&&sw.perm.screen&&!manual)return;
  swCardKind=kind;clearTimeout(swCardAuto);
  if(swCard&&!swCard.isDestroyed()){if(!swCard.isVisible())swCard.showInactive();pushSwCard();swPoll();return}
  const d=screen.getPrimaryDisplay().workArea,w=620,h=384;
  swCard=new BrowserWindow({width:w,height:h,x:Math.round(d.x+d.width/2-w/2),y:d.y+6,frame:false,transparent:true,hasShadow:false,resizable:false,alwaysOnTop:true,skipTaskbar:true,focusable:true,fullscreenable:false,backgroundColor:'#00000000',show:false,
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}});
  swCard.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});swCard.setAlwaysOnTop(true,'screen-saver');
  swCard.loadFile(path.join(__dirname,'renderer','perm.html'),{query:{theme:S.theme||'dark',kind}});
  swCard.once('ready-to-show',()=>{if(!swCard||swCard.isDestroyed())return;swCard.showInactive();pushSwCard();swPoll()});
  swCard.on('closed',()=>{swCard=null;clearTimeout(swCardT);swCardT=null});
}
function hideSwCard(){clearTimeout(swCardT);swCardT=null;clearTimeout(swCardAuto);if(!swCard||swCard.isDestroyed())return;try{swCard.webContents.send('perm:hide')}catch(e){}const w=swCard;setTimeout(()=>{if(!w.isDestroyed())w.destroy()},260)}
function swCardFixed(){pushSwCard();clearTimeout(swCardAuto);swCardAuto=setTimeout(hideSwCard,2800)}
// only while the card is up: ask a fresh helper process whether macOS said yes (a running process keeps its old answer)
function swPoll(){
  clearTimeout(swCardT);swCardT=null;
  if(!swCardShown()&&!(swCard&&!swCard.isDestroyed()))return;
  if(swCardKind!=='screen')return;                               // Accessibility: the helper retries its tap by itself
  swCardT=setTimeout(()=>{
    swCardT=null;let out='';
    try{const p=swRun(['--perm'],{stdio:['ignore','pipe','ignore']});p.stdout.on('data',d=>out+=d);p.on('error',()=>swPoll());
      p.on('exit',()=>{let r={};try{r=JSON.parse(out.trim().split('\n').pop())}catch(e){}
        if(r.screen){sw.perm.screen=true;sw.stop();sw.start();swCardFixed();sendSettings()}else swPoll()})}catch(e){swPoll()}
  },2500);
}
function swCardAction(a){
  if(a==='state')return swCardState();
  if(a==='access'){
    if(swCardKind==='screen'){sw.askScreen();shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture').catch(()=>{})}
    else{trusted(true);shell.openExternal(PANES.access).catch(()=>{})}
    swPoll();
  }else if(a==='later'){swSnooze[swCardKind]=true;hideSwCard()}
  else if(a==='close')hideSwCard();
  return swCardState();
}
ipcMain.on('sw:hover',(_e,i)=>sw.hover(+i));
ipcMain.on('sw:pick',(_e,i)=>sw.pick(+i));
ipcMain.on('sw:wheel',(_e,d)=>sw.wheel(+d));
ipcMain.on('sw:cols',(_e,n)=>sw.setCols(+n));
ipcMain.on('sw:key',(_e,k)=>{if(k==='next')sw.move(1);else if(k==='prev')sw.move(-1);else sw.key(String(k))});
ipcMain.on('sw:perm',()=>{sw.cancel();showSwCard('screen',true)});
ipcMain.handle('koi:s:sw',(_e,k,v)=>{
  if(k==='switcher')S.switcher=!!v;else if(k==='switchReplace')S.switchReplace=!!v;else if(k==='switchScope'&&(v==='all'||v==='space'))S.switchScope=v;
  else if(k==='switchMinimized')S.switchMinimized=!!v;else if(k==='previews'){showSwCard('screen',true);return swSettings()}else if(k==='access'){showSwCard('access',true);return swSettings()}
  saveSoon();if(SW_OK){if(S.switcher)sw.revive();else sw.stop()}return swSettings();
});
function swSettings(){return {on:S.switcher!==false,replace:S.switchReplace!==false,scope:S.switchScope==='space'?'space':'all',minimized:S.switchMinimized!==false,supported:SW_OK,status:sw.status,perm:sw.perm}}

// ---------- lifecycle ----------
app.whenReady().then(()=>{
  load();
  if(app.dock)app.dock.hide();
  loadFrames();tray=new Tray(trayFrames[6]);tray.setToolTip('Koi');
  tray.on('click',()=>togglePopover());tray.on('right-click',()=>togglePopover());
  updater.start({app,settings:()=>S,setBadge,onState:()=>sendPop(),saveSkip:v=>{S.skipped=v;saveSoon()},beforeQuit:()=>{app.isQuitting=true;quitting=true;saveNow();stopHook();try{sw.stop()}catch(e){}}});
  reg();makeOverlay();
  if(SW_OK){makeSwitchWin();setTimeout(swStart,700)}
  setTimeout(()=>prewarm().catch(e=>console.error('prewarm',e&&e.message)),1200);
  try{const {powerMonitor}=require('electron');['resume','unlock-screen'].forEach(ev=>powerMonitor.on(ev,()=>setTimeout(()=>{resetKeys();if(ev==='resume'&&hookOk)stopHook();reg();if(SW_OK&&S.switcher!==false)sw.revive()},1500)));}catch(e){}   // a fresh tap after sleep; key-ups lost while asleep are dropped
  setTimeout(reg,3000);setTimeout(reg,9000);
  if(!S.tourSeen)openTour();
  if(process.env.KOI_TEST)global.__koiTest={show:showOverlay,hide:hideOverlay,toggle,
    popover:async({theme}={})=>{if(theme){S.theme=theme}showPopover();await new Promise(r=>setTimeout(r,60));return popWin},hidePopover,
    updateCard:s=>updater._preview(s),closeCard:()=>updater.actions.close(),about:()=>{openAbout();return aboutWin},
    setHotkeys:(sc,hk)=>{S.shortcut=sc;S.hotkeys=hk;reg()},warmN:()=>warmAt,state:()=>({S,catalog:catalog.length,icons:Object.keys(iconIdx).length,hookOk,chords:chords.length,retry:!!retryT,health,probe:!!probeT,evN}),
    sw:{core:sw,win:()=>swWin,card:()=>swCard,cardKind:()=>swCardKind,start:swStart},
    perm:{trust:v=>{trustTest=v},idle:v=>{idleTest=v},key:(t,k,now)=>onKey(t,k,now),fakeHook:()=>{hookLoaded=true;uio={starts:0,start(){this.starts++},stop(){}};return uio},probe:()=>{clearTimeout(probeT);probe()},shortcut:()=>crossCheck(),card:()=>permWin}};
});
app.on('second-instance',()=>showOverlay());
app.on('before-quit',()=>{quitting=true;saveNow()});
app.on('will-quit',()=>{quitting=true;globalShortcut.unregisterAll();stopHook();try{sw.stop()}catch(e){}});
app.on('window-all-closed',()=>{});

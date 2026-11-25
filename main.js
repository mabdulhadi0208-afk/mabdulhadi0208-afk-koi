// Koi 2.0: springy fan app switcher for macOS (menu-bar app)
// Speed rules: the fan opens from what is already in memory (app list, running set, icon files on disk) and never
// waits on a scan, `ps` or an icon extraction. Those refresh in the background and push only what changed.
// Idle rules: nothing polls, loops or animates while Koi sits in the menu bar.
const {app,BrowserWindow,Tray,globalShortcut,screen,ipcMain,nativeImage,Notification,shell}=require('electron');
const path=require('path'),fs=require('fs'),fsp=fs.promises,os=require('os'),crypto=require('crypto'),{pathToFileURL}=require('url'),{execFile}=require('child_process');
const updater=require('./updater');

let tray=null,overlay=null,tour=null,settingsWin=null,aboutWin=null,popWin=null,popShown=false,lastPopHide=0,trayFrames=[],trayTimer=null,shown=false,lastToggle=0,hideT=null;
const DEF={theme:'dark',size:1,speed:1.3,sound:false,shortcut:'Alt+Space',hotkeys:[],tourSeen:false,usage:{},autoDownload:true,updateCard:true,skipped:null};
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
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,autoplayPolicy:'no-user-gesture-required'}});
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
  shown=true;overlay.show();overlay.focus();
  setImmediate(()=>{animateTray(true);refresh()});
}
// main-side close: the fan plays a short fold, then tells us to hide; a timer makes sure it really goes
function hideOverlay(){
  if(!overlay||overlay.isDestroyed()||!shown)return;
  shown=false;overlay.webContents.send('koi:close');
  clearTimeout(hideT);hideT=setTimeout(()=>{if(!shown&&overlay&&!overlay.isDestroyed())overlay.hide()},260);
}
function hideNow(){shown=false;clearTimeout(hideT);if(overlay&&!overlay.isDestroyed())overlay.hide()}
function toggle(){const t=Date.now();if(t-lastToggle<250)return;lastToggle=t;shown?hideOverlay():showOverlay()}
function openTour(){
  if(tour&&!tour.isDestroyed()){tour.focus();return}
  tour=new BrowserWindow({width:1280,height:800,minWidth:900,minHeight:600,titleBarStyle:'hiddenInset',backgroundColor:'#07040e',show:false,
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
let hookOk=false,hookLoaded=false,chords=[],recording=false;
function canRegister(acc){if(modOnly(acc)){startHook(true);return hookLoaded}globalShortcut.unregisterAll();let ok=false;try{ok=globalShortcut.register(acc,()=>{});if(ok)globalShortcut.unregister(acc)}catch(e){}return ok}
function launchApp(p,name){S.usage[name]=(S.usage[name]||0)+1;saveSoon();execFile('open',['-a',p],()=>{})}

// ---- modifier-only chords (e.g. ⌘⌥) through a key hook that runs in its own process (koi-keys.js) ----
// It only exists while a chord is set, reports key codes only (never mouse events, never text), and Koi's
// build of the hook asks macOS for key events only, so the pointer never passes through Koi.
let hookProc=null,hookStarting=false,hookErr='',quitting=false,inproc=null,retryT=null,retryN=0;
const trusted=prompt=>{if(process.platform!=='darwin')return true;try{return require('electron').systemPreferences.isTrustedAccessibilityClient(!!prompt)}catch(e){return false}};
try{require.resolve('uiohook-napi');hookLoaded=true}catch(e){console.error('key hook unavailable',e&&e.message)}
const M={56:'Alt',3640:'Alt',29:'Control',3613:'Control',42:'Shift',54:'Shift',3675:'Command',3676:'Command'};
const held=new Set();let dirty=false,fired=false;
const cur=()=>{const n=new Set([...held].map(x=>x.split(':')[0]));return ['Command','Control','Alt','Shift'].filter(x=>n.has(x)).join('+')};
function onKey(type,keycode){const m=M[keycode];
  if(type==='down'){if(!m){dirty=true;return}
    held.add(m+':'+keycode);
    if(!dirty&&!fired&&!recording){const acc=cur();if(acc.includes('+')){const c=chords.find(c=>c.acc===acc);if(c){fired=true;c.fn()}}}}
  else{if(!m)return;held.delete(m+':'+keycode);if(held.size===0){dirty=false;fired=false}}}
function stopHook(){clearTimeout(retryT);retryT=null;const p=hookProc;hookProc=null;hookOk=false;hookStarting=false;try{p&&p.kill()}catch(e){}if(inproc){try{inproc.stop()}catch(e){}inproc=null}held.clear()}
function startInProcess(){       // fallback if a utility process cannot run the hook
  try{const {uIOhook}=require('uiohook-napi');const mods=new Set(Object.keys(M).map(Number));let h=0;
    uIOhook.handler=function(e){const t=e.type;if(t!==4&&t!==5)return;const m=mods.has(e.keycode);if(!m&&!h)return;if(m)h=Math.max(0,h+(t===4?1:-1));onKey(t===4?'down':'up',e.keycode)};
    uIOhook.start();inproc=uIOhook;hookOk=true;hookErr='';try{reg()}catch(e){}}catch(e){hookErr='start'}
}
function startHook(prompt){
  if(hookOk||hookStarting||!hookLoaded||quitting)return hookOk;
  if(!trusted(prompt)){hookErr='permission';scheduleRetry();return false}
  hookStarting=true;hookErr='';
  let p;try{p=require('electron').utilityProcess.fork(path.join(__dirname,'koi-keys.js'),[],{serviceName:'Koi Keys',stdio:'ignore'})}catch(e){hookStarting=false;startInProcess();return hookOk}
  hookProc=p;
  const t=setTimeout(()=>{if(hookProc===p&&!hookOk){stopHook();startInProcess()}},8000);
  p.on('message',m=>{if(hookProc!==p||!m)return;
    if(m.ev)onKey(m.ev,m.k);
    else if(m.started){clearTimeout(t);hookOk=true;hookStarting=false;retryN=0;try{reg()}catch(e){}}
    else if(m.error){clearTimeout(t);stopHook();startInProcess()}});
  p.on('exit',()=>{clearTimeout(t);if(hookProc===p){hookProc=null;hookOk=false;hookStarting=false;scheduleRetry()}});
  return false;
}
// retry only while a chord needs the hook and it is not running: every 2 s for a minute, then every 15 s
function scheduleRetry(){if(retryT||quitting)return;retryT=setTimeout(()=>{retryT=null;if(hookOk||!hookLoaded||!chords.length)return;retryN++;startHook(false);if(!hookOk)scheduleRetry()},retryN<30?2000:15000)}
let regStatus={main:false,hk:[]};
function tryReg(acc,fn){if(modOnly(acc)){chords=chords.filter(c=>c.acc!==acc);chords.push({acc,fn});return hookOk}try{if(globalShortcut.isRegistered(acc))globalShortcut.unregister(acc);return globalShortcut.register(acc,fn)&&globalShortcut.isRegistered(acc)}catch(e){console.error('reg fail',acc,e&&e.message);return false}}
function reg(){
  globalShortcut.unregisterAll();chords=[];
  let ok=tryReg(S.shortcut,toggle);
  if(!ok&&S.shortcut!==DEF.shortcut){tryReg(DEF.shortcut,toggle)}/* temporary fallback only; never overwrite the saved shortcut (old instance may still hold it during an update) */
  regStatus={main:ok,hk:S.hotkeys.map(h=>tryReg(h.acc,()=>launchApp(h.path,h.name)))};
  if(chords.length){if(!hookOk)startHook(false)}else if(hookOk||hookProc||inproc)stopHook();
  if(!ok)console.error('main shortcut failed');
}
const winOpts=(w,h,bg)=>({width:w,height:h,titleBarStyle:'hiddenInset',backgroundColor:bg,show:false,webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}});
function openSettings(){
  if(settingsWin&&!settingsWin.isDestroyed()){settingsWin.focus();return}
  settingsWin=new BrowserWindow({...winOpts(600,820,S.theme==='light'?'#fbf4fb':'#0b0714'),minWidth:520,minHeight:560});
  settingsWin.once('ready-to-show',()=>settingsWin.show());
  settingsWin.loadFile(path.join(__dirname,'renderer','settings.html'),{query:{theme:S.theme}});
  settingsWin.on('closed',()=>{settingsWin=null;reg();sendPop()});
}
function openAbout(){
  if(aboutWin&&!aboutWin.isDestroyed()){aboutWin.focus();return}
  aboutWin=new BrowserWindow({...winOpts(480,580,'#0b0714'),resizable:false,minimizable:false,maximizable:false});
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
ipcMain.handle('koi:s:get',async()=>{if(!catalog.length)await scanAsync();return {status:regStatus,perm:{needed:modOnly(S.shortcut)||S.hotkeys.some(h=>modOnly(h.acc)),trusted:trusted(false),hook:hookOk,err:hookErr},main:S.shortcut,hk:S.hotkeys.map(h=>{const e=iconIdx[h.path];return {...h,icon:e&&e.f?iconUrl(e.f):''}}),apps:catalog.map(a=>({name:a.name,path:a.path})).sort((a,b)=>a.name.localeCompare(b.name))}});
ipcMain.on('koi:s:openAccess',()=>{trusted(true);shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')});
ipcMain.handle('koi:s:pause',()=>{recording=true;globalShortcut.unregisterAll()});
ipcMain.handle('koi:s:resume',()=>{recording=false;reg()});
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

// ---------- lifecycle ----------
app.whenReady().then(()=>{
  load();
  if(app.dock)app.dock.hide();
  loadFrames();tray=new Tray(trayFrames[6]);tray.setToolTip('Koi');
  tray.on('click',()=>togglePopover());tray.on('right-click',()=>togglePopover());
  updater.start({app,settings:()=>S,setBadge,onState:()=>sendPop(),saveSkip:v=>{S.skipped=v;saveSoon()},beforeQuit:()=>{app.isQuitting=true;quitting=true;saveNow();stopHook()}});
  reg();makeOverlay();
  setTimeout(()=>prewarm().catch(e=>console.error('prewarm',e&&e.message)),1200);
  try{const {powerMonitor}=require('electron');['resume','unlock-screen'].forEach(ev=>powerMonitor.on(ev,()=>setTimeout(reg,1500)));}catch(e){}
  setTimeout(reg,3000);setTimeout(reg,9000);
  if(!S.tourSeen)openTour();
  if(process.env.KOI_TEST)global.__koiTest={show:showOverlay,hide:hideOverlay,toggle,
    popover:async({theme}={})=>{if(theme){S.theme=theme}showPopover();await new Promise(r=>setTimeout(r,60));return popWin},hidePopover,
    updateCard:s=>updater._preview(s),closeCard:()=>updater.actions.close(),about:()=>{openAbout();return aboutWin},
    setHotkeys:(sc,hk)=>{S.shortcut=sc;S.hotkeys=hk;reg()},state:()=>({S,catalog:catalog.length,icons:Object.keys(iconIdx).length,hookOk,hookProc:!!hookProc,chords:chords.length,retry:!!retryT})};
});
app.on('second-instance',()=>showOverlay());
app.on('before-quit',()=>{quitting=true;saveNow()});
app.on('will-quit',()=>{quitting=true;globalShortcut.unregisterAll();stopHook()});
app.on('window-all-closed',()=>{});

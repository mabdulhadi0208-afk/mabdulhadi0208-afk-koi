// Koi — springy fan app switcher for macOS (menu-bar app)
const {app,BrowserWindow,Tray,Menu,globalShortcut,screen,ipcMain,nativeImage,Notification}=require('electron');
const path=require('path'),fs=require('fs'),os=require('os'),{execFile}=require('child_process');
const updater=require('./updater');

let tray=null,overlay=null,tour=null,settingsWin=null,popWin=null,popShown=false,lastPopHide=0,trayFrames=[],trayTimer=null,shown=false,lastToggle=0;
const DEF={theme:'light',size:1,speed:1.3,sound:false,shortcut:'Alt+Space',hotkeys:[],tourSeen:false,usage:{},autoDownload:true,updateCard:true,skipped:null};
let S={...DEF};
const SF=()=>path.join(app.getPath('userData'),'koi-settings.json');
const load=()=>{try{S={...DEF,...JSON.parse(fs.readFileSync(SF(),'utf8'))}}catch(e){}if(!S.migFast){S.speed=1.3;S.migFast=true;try{fs.writeFileSync(SF(),JSON.stringify(S))}catch(e){}}};
const save=()=>{try{fs.writeFileSync(SF(),JSON.stringify(S))}catch(e){}};

if(!app.requestSingleInstanceLock()){app.quit();}

// ---------- installed / running apps ----------
const DIRS=['/Applications','/Applications/Utilities','/System/Applications','/System/Applications/Utilities',path.join(os.homedir(),'Applications')];
const PRIORITY=['Finder','Safari','Messages','Mail','Calendar','Notes','Music','Terminal','Photos','Maps','System Settings','Xcode','Slack','Spotify','Figma','Visual Studio Code','Google Chrome','Discord'];
function scan(){
  const out=new Map();
  for(const d of DIRS){let f=[];try{f=fs.readdirSync(d)}catch(e){continue}
    for(const n of f){if(n.endsWith('.app')){const name=n.slice(0,-4);if(!out.has(name))out.set(name,path.join(d,n))}}}
  if(fs.existsSync('/System/Library/CoreServices/Finder.app'))out.set('Finder','/System/Library/CoreServices/Finder.app');
  return [...out].map(([name,p])=>({name,path:p}));
}
function running(){return new Promise(res=>{execFile('ps',['-axo','comm='],{maxBuffer:8e6},(e,out)=>{const set=new Set();if(!e)String(out).split('\n').forEach(l=>{const m=l.match(/\/([^/]+)\.app\/Contents\/MacOS\//);if(m)set.add(m[1])});res(set)})})}
const iconCache=new Map();
async function iconOf(p){
  if(iconCache.has(p))return iconCache.get(p);
  let img=null;
  try{img=await nativeImage.createThumbnailFromPath(p,{width:128,height:128})}catch(e){}
  if(!img||img.isEmpty()){try{img=await app.getFileIcon(p,{size:'large'})}catch(e){}}
  const url=img&&!img.isEmpty()?img.resize({width:128}).toDataURL():'';
  iconCache.set(p,url);return url;
}
async function getApps(){
  const [list,run]=[scan(),await running()];
  const scored=list.map(a=>{const pr=PRIORITY.indexOf(a.name);return {...a,running:run.has(a.name),freq:(S.usage[a.name]||0)*1000+(run.has(a.name)?400:0)+(pr>=0?(60-pr*2):0)}});
  scored.sort((a,b)=>b.freq-a.freq);
  const top=scored.slice(0,48);
  await Promise.all(top.map(async a=>{a.icon=await iconOf(a.path)}));
  return top.filter(a=>a.icon);
}

// ---------- windows ----------
function makeOverlay(){
  overlay=new BrowserWindow({show:false,frame:false,transparent:true,hasShadow:false,resizable:false,movable:false,skipTaskbar:true,alwaysOnTop:true,fullscreenable:false,
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
  overlay.setAlwaysOnTop(true,'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
  overlay.loadFile(path.join(__dirname,'renderer','app.html'),{query:{mode:'overlay'}});
  overlay.on('blur',()=>{if(shown)hideOverlay()});
}
async function showOverlay(){
  if(!overlay)makeOverlay();
  const pt=screen.getCursorScreenPoint(),disp=screen.getDisplayNearestPoint(pt);
  overlay.setBounds(disp.bounds);
  const apps=await getApps();
  shown=true;overlay.show();overlay.focus();
  overlay.webContents.send('koi:show',{x:pt.x-disp.bounds.x,y:pt.y-disp.bounds.y,apps,settings:S});
  animateTray(true);
}
function hideOverlay(){if(!overlay)return;shown=false;overlay.webContents.send('koi:hide');overlay.hide()}
function toggle(){const t=Date.now();if(t-lastToggle<250)return;lastToggle=t;shown?hideOverlay():showOverlay()}
function openTour(){
  if(tour&&!tour.isDestroyed()){tour.focus();return}
  tour=new BrowserWindow({width:1280,height:800,minWidth:900,minHeight:600,titleBarStyle:'hiddenInset',backgroundColor:'#04050c',show:false,
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,autoplayPolicy:'no-user-gesture-required'}});
  tour.once('ready-to-show',()=>tour.show());
  tour.loadFile(path.join(__dirname,'renderer','app.html'),{query:{mode:'tour'}});
  tour.on('closed',()=>{tour=null});
}

// ---------- tray / settings ----------
const SYM={Command:'⌘',CommandOrControl:'⌘',Control:'⌃',Alt:'⌥',Shift:'⇧'};
const pretty=a=>(a||'').split('+').map(p=>SYM[p]||(p==='Return'?'↩':p)).join(' ');
const label=()=>pretty(S.shortcut);
const norm=a=>String(a).replace('CommandOrControl','Command').toLowerCase();
const modOnly=a=>typeof a==='string'&&/^(Command|Control|Alt|Shift)(\+(Command|Control|Alt|Shift))+$/.test(a);
const validAcc=a=>modOnly(a)||typeof a==='string'&&/^((Command|Control|Alt|Shift)\+)*([A-Z0-9]|F\d{1,2}|Space|Return|Tab|Backspace|Up|Down|Left|Right|[-=,./;'`\[\]\\])$/.test(a)&&(/\+/.test(a)||/^F\d{1,2}$/.test(a));
let hookOk=false,hookLoaded=false,chords=[],recording=false;
function canRegister(acc){if(modOnly(acc)){startHook(true);return hookLoaded}globalShortcut.unregisterAll();let ok=false;try{ok=globalShortcut.register(acc,()=>{});if(ok)globalShortcut.unregister(acc)}catch(e){}return ok}
function launchApp(p,name){S.usage[name]=(S.usage[name]||0)+1;save();execFile('open',['-a',p])}

// ---- modifier-only chords (e.g. ⌘⌥) via global key hook; needs Accessibility permission ----
let uio=null;
function startHook(prompt){
  if(hookOk||!uio)return hookOk;
  try{const {systemPreferences}=require('electron');if(process.platform==='darwin'&&!systemPreferences.isTrustedAccessibilityClient(!!prompt))return false}catch(e){}
  try{uio.start();hookOk=true;try{reg()}catch(e){}}catch(e){console.error('hook start failed',e&&e.message)}
  return hookOk;
}
(function(){try{
  const {uIOhook}=require('uiohook-napi');uio=uIOhook;hookLoaded=true;
  const M={56:'Alt',3640:'Alt',29:'Control',3613:'Control',42:'Shift',54:'Shift',3675:'Command',3676:'Command'};
  const held=new Set();let dirty=false,fired=false;
  const cur=()=>{const n=new Set([...held].map(x=>x.split(':')[0]));return ['Command','Control','Alt','Shift'].filter(x=>n.has(x)).join('+')};
  uIOhook.on('keydown',e=>{const m=M[e.keycode];
    if(!m){dirty=true;return}
    held.add(m+':'+e.keycode);
    if(!dirty&&!fired&&!recording){const acc=cur();if(acc.includes('+')){const c=chords.find(c=>c.acc===acc);if(c){fired=true;c.fn()}}}});
  uIOhook.on('keyup',e=>{const m=M[e.keycode];if(!m)return;held.delete(m+':'+e.keycode);if(held.size===0){dirty=false;fired=false}});
}catch(e){console.error('key hook unavailable',e&&e.message)}})();
setInterval(()=>{if(!hookOk&&hookLoaded&&chords.length)startHook(false)},3000);
let regStatus={main:false,hk:[]};
function tryReg(acc,fn){if(modOnly(acc)){chords=chords.filter(c=>c.acc!==acc);chords.push({acc,fn});return hookOk}try{if(globalShortcut.isRegistered(acc))globalShortcut.unregister(acc);return globalShortcut.register(acc,fn)&&globalShortcut.isRegistered(acc)}catch(e){console.error('reg fail',acc,e&&e.message);return false}}
function reg(){
  globalShortcut.unregisterAll();chords=[];
  let ok=tryReg(S.shortcut,toggle);
  if(!ok&&S.shortcut!==DEF.shortcut){tryReg(DEF.shortcut,toggle)}/* temporary fallback only; never overwrite the saved shortcut (old instance may still hold it during an update) */
  regStatus={main:ok,hk:S.hotkeys.map(h=>tryReg(h.acc,()=>launchApp(h.path,h.name)))};
  if(!ok)console.error('main shortcut failed');
}
function openSettings(){
  if(settingsWin&&!settingsWin.isDestroyed()){settingsWin.focus();return}
  settingsWin=new BrowserWindow({width:560,height:660,minWidth:480,minHeight:500,titleBarStyle:'hiddenInset',backgroundColor:'#eef1fb',show:false,
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}});
  settingsWin.once('ready-to-show',()=>settingsWin.show());
  settingsWin.loadFile(path.join(__dirname,'renderer','settings.html'));
  settingsWin.on('closed',()=>{settingsWin=null;reg();buildMenu()});
}
// ---------- tray icon (blooming fan frames) + custom springy popover ----------
function loadFrames(){trayFrames=[];for(let k=0;k<7;k++){const im=nativeImage.createFromPath(path.join(__dirname,'assets',`trayFrame${k}Template.png`));im.setTemplateImage(true);trayFrames.push(im)}}
function animateTray(open){
  if(!tray)return;clearInterval(trayTimer);let k=open?0:6;if(open)tray.setImage(trayFrames[0]);
  if(open){let i=0;trayTimer=setInterval(()=>{i++;tray.setImage(trayFrames[Math.min(6,i)]);if(i>=6)clearInterval(trayTimer)},38)}
  else tray.setImage(trayFrames[6]);
}
function setBadge(on){try{tray&&tray.setTitle(on?' ↑':'')}catch(e){}}
function popState(){return {theme:S.theme,size:S.size,speed:S.speed,sound:!!S.sound,login:!!app.getLoginItemSettings().openAtLogin,autoDownload:S.autoDownload!==false,shortcut:label(),version:app.getVersion(),upd:updater.snapshot()}}
function sendPop(){if(popWin&&!popWin.isDestroyed())popWin.webContents.send('pop:state',popState())}
function makePopover(){
  popWin=new BrowserWindow({width:344,height:560,show:false,frame:false,transparent:true,hasShadow:false,resizable:false,movable:false,skipTaskbar:true,alwaysOnTop:true,fullscreenable:false,backgroundColor:'#00000000',
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  popWin.setAlwaysOnTop(true,'pop-up-menu');popWin.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
  popWin.loadFile(path.join(__dirname,'renderer','popover.html'));
  popWin.on('blur',()=>{if(popShown)hidePopover()});
}
function showPopover(){
  if(!popWin||popWin.isDestroyed())makePopover();
  const b=tray.getBounds(),disp=screen.getDisplayMatching(b),W=344,wa=disp.workArea;
  let x=Math.round(b.x+b.width/2-W/2);x=Math.max(wa.x+4,Math.min(x,wa.x+wa.width-W-4));
  popWin.setPosition(x,b.y+b.height-4);
  popShown=true;animateTray(true);popWin.show();popWin.focus();
  popWin.webContents.send('pop:show',{state:popState(),anchor:Math.round(b.x+b.width/2-x)-12});
}
function hidePopover(){if(!popShown)return;popShown=false;lastPopHide=Date.now();if(popWin&&!popWin.isDestroyed()){popWin.webContents.send('pop:hide');setTimeout(()=>{if(!popShown&&popWin&&!popWin.isDestroyed())popWin.hide()},200)}animateTray(false)}
function togglePopover(){if(popShown)hidePopover();else if(Date.now()-lastPopHide>220)showPopover()}
function buildMenu(){sendPop()}


// ---------- IPC ----------
ipcMain.on('koi:hide',()=>hideOverlay());
ipcMain.handle('pop:get',()=>popState());
ipcMain.on('pop:size',(_e,h)=>{if(popWin&&!popWin.isDestroyed()&&h>100&&h<900)popWin.setSize(344,Math.round(h))});
ipcMain.on('pop:set',(_e,k,v)=>{
  if(k==='theme'&&(v==='light'||v==='dark'))S.theme=v;
  else if(k==='size'&&[.85,1,1.2,1.4].includes(+v))S.size=+v;
  else if(k==='speed'&&[.7,1,1.3].includes(+v))S.speed=+v;
  else if(k==='sound')S.sound=!!v;
  else if(k==='autoDownload')S.autoDownload=!!v;
  else if(k==='login'){S.login=!!v;try{app.setLoginItemSettings({openAtLogin:!!v})}catch(e){}}
  save();
});
ipcMain.on('pop:action',(_e,a)=>{
  if(a==='open'){hidePopover();setTimeout(()=>showOverlay(),230)}
  else if(a==='hotkeys'){hidePopover();openSettings()}
  else if(a==='tour'){hidePopover();openTour()}
  else if(a==='update'){updater.actions.check()}
  else if(a==='download'){updater.actions.download()}
  else if(a==='install'){updater.actions.install()}
  else if(a==='quit'){app.isQuitting=true;app.quit()}
});
ipcMain.handle('upd:action',(_e,a)=>{const f=updater.actions[a];return f?f():null});
ipcMain.on('koi:launch',(_e,p,name)=>{
  if(typeof p!=='string'||!p.endsWith('.app'))return;
  S.usage[name]=(S.usage[name]||0)+1;save();
  execFile('open',['-a',p]);hideOverlay();
});
ipcMain.on('koi:action',(_e,kind,p,name)=>{
  if(typeof p!=='string'||!p.endsWith('.app')||typeof name!=='string')return;
  const safe=name.replace(/["\\]/g,'');
  if(kind==='new')execFile('open',['-n','-a',p]);
  else if(kind==='hide')execFile('osascript',['-e',`tell application "System Events" to set visible of process "${safe}" to false`]);
  else if(kind==='quit')execFile('osascript',['-e',`tell application "${safe}" to quit`]);
});
const taken=(acc,skip)=>norm(acc)===norm(S.shortcut)&&skip!=='main'||S.hotkeys.some((h,i)=>i!==skip&&norm(h.acc)===norm(acc));
ipcMain.handle('koi:s:get',()=>({status:regStatus,main:S.shortcut,hk:S.hotkeys,apps:scan().sort((a,b)=>a.name.localeCompare(b.name))}));
ipcMain.handle('koi:s:pause',()=>{recording=true;globalShortcut.unregisterAll()});
ipcMain.handle('koi:s:resume',()=>{recording=false;reg()});
ipcMain.handle('koi:s:setMain',(_e,acc)=>{
  if(!validAcc(acc))return {ok:false,msg:'That key combo is not valid.',where:'m1'};
  if(taken(acc,'main')&&norm(acc)!==norm(S.shortcut))return {ok:false,msg:'Already used by one of your app hotkeys.',where:'m1'};
  if(!canRegister(acc)){reg();return {ok:false,msg:'macOS or another app already owns that shortcut.',where:'m1'}}
  S.shortcut=acc;save();reg();buildMenu();return {ok:true};
});
ipcMain.handle('koi:s:add',(_e,acc,name,p)=>{
  if(!validAcc(acc)||typeof p!=='string'||!p.endsWith('.app'))return {ok:false,msg:'That key combo is not valid.',where:'m2'};
  if(taken(acc,-1))return {ok:false,msg:'You already use that shortcut.',where:'m2'};
  if(!canRegister(acc)){reg();return {ok:false,msg:'macOS or another app already owns that shortcut.',where:'m2'}}
  S.hotkeys.push({acc,name:String(name),path:p});save();reg();return {ok:true};
});
ipcMain.handle('koi:s:update',(_e,i,acc)=>{
  if(!S.hotkeys[i]||!validAcc(acc))return {ok:false,where:'m2'};
  if(taken(acc,i))return {ok:false,msg:'You already use that shortcut.',where:'m2'};
  if(norm(acc)!==norm(S.hotkeys[i].acc)&&!canRegister(acc)){reg();return {ok:false,msg:'macOS or another app already owns that shortcut.',where:'m2'}}
  S.hotkeys[i].acc=acc;save();reg();return {ok:true};
});
ipcMain.handle('koi:s:remove',(_e,i)=>{S.hotkeys.splice(i,1);save();reg();return {ok:true}});
ipcMain.on('koi:tourDone',()=>{
  S.tourSeen=true;save();
  if(tour&&!tour.isDestroyed())tour.close();
  try{new Notification({title:'Koi is ready',body:'Press '+label()+' to open the fan — it lives in your menu bar.'}).show()}catch(e){}
});

// ---------- lifecycle ----------
app.whenReady().then(()=>{
  load();
  if(app.dock)app.dock.hide();
  loadFrames();tray=new Tray(trayFrames[6]);tray.setToolTip('Koi');
  tray.on('click',()=>togglePopover());tray.on('right-click',()=>togglePopover());
  updater.start({app,settings:()=>S,setBadge,onState:()=>sendPop(),saveSkip:v=>{S.skipped=v;save()},beforeQuit:()=>{app.isQuitting=true}});
  reg();makeOverlay();
  try{const {powerMonitor}=require('electron');['resume','unlock-screen'].forEach(ev=>powerMonitor.on(ev,()=>setTimeout(reg,1500)));}catch(e){}
  setTimeout(reg,3000);setTimeout(reg,9000);
  if(!S.tourSeen)openTour();
});
app.on('second-instance',()=>showOverlay());
app.on('will-quit',()=>globalShortcut.unregisterAll());
app.on('window-all-closed',()=>{});

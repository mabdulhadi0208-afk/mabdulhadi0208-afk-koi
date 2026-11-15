// Koi — springy fan app switcher for macOS (menu-bar app)
const {app,BrowserWindow,Tray,Menu,globalShortcut,screen,ipcMain,nativeImage,Notification}=require('electron');
const path=require('path'),fs=require('fs'),os=require('os'),{execFile}=require('child_process');

let tray=null,overlay=null,tour=null,settingsWin=null,shown=false,lastToggle=0;
const DEF={theme:'light',size:1,speed:1,sound:false,shortcut:'Alt+Space',hotkeys:[],tourSeen:false,usage:{}};
let S={...DEF};
const SF=()=>path.join(app.getPath('userData'),'koi-settings.json');
const load=()=>{try{S={...DEF,...JSON.parse(fs.readFileSync(SF(),'utf8'))}}catch(e){}};
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
  const scored=list.map(a=>{const pr=PRIORITY.indexOf(a.name);return {...a,running:run.has(a.name),freq:(run.has(a.name)?400:0)+(S.usage[a.name]||0)*25+(pr>=0?(60-pr*2):0)}});
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
const validAcc=a=>typeof a==='string'&&/^((Command|Control|Alt|Shift)\+)*([A-Z0-9]|F\d{1,2}|Space|Return|Tab|Backspace|Up|Down|Left|Right|[-=,./;'`\[\]\\])$/.test(a)&&(/\+/.test(a)||/^F\d{1,2}$/.test(a));
function canRegister(acc){globalShortcut.unregisterAll();let ok=false;try{ok=globalShortcut.register(acc,()=>{});if(ok)globalShortcut.unregister(acc)}catch(e){}return ok}
function launchApp(p,name){S.usage[name]=(S.usage[name]||0)+1;save();execFile('open',['-a',p])}
function reg(){
  globalShortcut.unregisterAll();
  let ok=false;try{ok=globalShortcut.register(S.shortcut,toggle)}catch(e){}
  if(!ok&&S.shortcut!==DEF.shortcut){S.shortcut=DEF.shortcut;try{globalShortcut.register(S.shortcut,toggle)}catch(e){}}
  for(const h of S.hotkeys){try{globalShortcut.register(h.acc,()=>launchApp(h.path,h.name))}catch(e){}}
}
function openSettings(){
  if(settingsWin&&!settingsWin.isDestroyed()){settingsWin.focus();return}
  settingsWin=new BrowserWindow({width:560,height:660,minWidth:480,minHeight:500,titleBarStyle:'hiddenInset',backgroundColor:'#eef1fb',show:false,
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}});
  settingsWin.once('ready-to-show',()=>settingsWin.show());
  settingsWin.loadFile(path.join(__dirname,'renderer','settings.html'));
  settingsWin.on('closed',()=>{settingsWin=null;reg();buildMenu()});
}
function buildMenu(){
  const radio=(key,items)=>items.map(([l,v])=>({label:l,type:'radio',checked:S[key]===v,click:()=>{S[key]=v;save();buildMenu()}}));
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:'Open Koi',accelerator:S.shortcut,click:()=>showOverlay()},
    {type:'separator'},
    {label:'Theme',submenu:radio('theme',[['Light','light'],['Dark','dark']])},
    {label:'Size',submenu:radio('size',[['Small',.85],['Medium',1],['Big',1.2],['Huge',1.4]])},
    {label:'Animation speed',submenu:radio('speed',[['Fast',1.3],['Normal',1],['Soft',.7]])},
    {label:'Hotkeys…',click:()=>openSettings()},
    {label:'Sounds',type:'checkbox',checked:!!S.sound,click:m=>{S.sound=m.checked;save()}},
    {label:'Launch at login',type:'checkbox',checked:app.getLoginItemSettings().openAtLogin,click:m=>app.setLoginItemSettings({openAtLogin:m.checked})},
    {type:'separator'},
    {label:'Replay the tour',click:()=>openTour()},
    {label:'About Koi  v'+app.getVersion(),enabled:false},
    {label:'Quit Koi',accelerator:'Command+Q',click:()=>{app.isQuitting=true;app.quit()}}
  ]));
}

// ---------- IPC ----------
ipcMain.on('koi:hide',()=>hideOverlay());
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
ipcMain.handle('koi:s:get',()=>({main:S.shortcut,hk:S.hotkeys,apps:scan().sort((a,b)=>a.name.localeCompare(b.name))}));
ipcMain.handle('koi:s:pause',()=>{globalShortcut.unregisterAll()});
ipcMain.handle('koi:s:resume',()=>{reg()});
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
  const ti=nativeImage.createFromPath(path.join(__dirname,'assets','trayTemplate.png'));ti.setTemplateImage(true);
  tray=new Tray(ti);tray.setToolTip('Koi');buildMenu();
  tray.on('click',()=>{});
  reg();makeOverlay();
  if(!S.tourSeen)openTour();
});
app.on('second-instance',()=>showOverlay());
app.on('will-quit',()=>globalShortcut.unregisterAll());
app.on('window-all-closed',()=>{});

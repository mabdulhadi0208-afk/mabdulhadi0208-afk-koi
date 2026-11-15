const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('koiAPI',{
  onShow:cb=>ipcRenderer.on('koi:show',(_e,d)=>cb(d)),
  onHide:cb=>ipcRenderer.on('koi:hide',()=>cb()),
  hide:()=>ipcRenderer.send('koi:hide'),
  launch:(p,n)=>ipcRenderer.send('koi:launch',p,n),
  action:(k,p,n)=>ipcRenderer.send('koi:action',k,p,n),
  tourDone:()=>ipcRenderer.send('koi:tourDone'),
  s:{
    get:()=>ipcRenderer.invoke('koi:s:get'),
    pause:()=>ipcRenderer.invoke('koi:s:pause'),
    resume:()=>ipcRenderer.invoke('koi:s:resume'),
    setMain:a=>ipcRenderer.invoke('koi:s:setMain',a),
    addHotkey:(a,n,p)=>ipcRenderer.invoke('koi:s:add',a,n,p),
    updateHotkey:(i,a)=>ipcRenderer.invoke('koi:s:update',i,a),
    removeHotkey:i=>ipcRenderer.invoke('koi:s:remove',i)
  }
});

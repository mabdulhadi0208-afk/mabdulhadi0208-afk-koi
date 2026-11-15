const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('koiAPI',{
  onShow:cb=>ipcRenderer.on('koi:show',(_e,d)=>cb(d)),
  onHide:cb=>ipcRenderer.on('koi:hide',()=>cb()),
  hide:()=>ipcRenderer.send('koi:hide'),
  launch:(p,n)=>ipcRenderer.send('koi:launch',p,n),
  action:(k,p,n)=>ipcRenderer.send('koi:action',k,p,n),
  tourDone:()=>ipcRenderer.send('koi:tourDone')
});

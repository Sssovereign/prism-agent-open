const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {createRequire}=require('node:module');
const {readFileSync}=require('node:fs');
const {join,dirname}=require('node:path');

function host(platform){
 const file=join(__dirname,'main.cjs'),requireActual=createRequire(file),handlers=new Map(),popups=[];
 class Window extends EventEmitter{
  constructor(options){super();this.options=options;this.listeners=new Map();this.webContents={mainFrame:{url:'http://127.0.0.1:49152/'},on:(name,fn)=>this.listeners.set(name,fn),setWindowOpenHandler(){}};}
  isDestroyed(){return false;}
  async loadURL(){}
  show(){this.shown=true;}
  setTitleBarOverlay(value){this.overlay=value;}
 }
 const electron={BrowserWindow:Window,nativeTheme:{shouldUseDarkColors:false},Menu:{buildFromTemplate:template=>({popup:opts=>popups.push({template,opts})})},app:{setName(){},isPackaged:true,requestSingleInstanceLock:()=>false,quit(){}},ipcMain:{handle(){},on:(name,fn)=>handlers.set(name,fn)}};
 const ctx=vm.createContext({require:name=>name==='electron'?electron:requireActual(name),__dirname:dirname(file),process:{env:{},platform,versions:{electron:'test'},on:()=>{}},console,setTimeout,clearTimeout});
 vm.runInContext(readFileSync(file,'utf8'),ctx);
 return {ctx,handlers,popups};
}

test('实际窗口构造：Mac和Windows共用隐藏标题栏，原生控制及渲染隔离保持',async()=>{
 for(const platform of ['darwin','win32']){
  const {ctx}=host(platform);await vm.runInContext('createWindow()',ctx);
  const win=vm.runInContext('window',ctx),o=win.options;
  assert.equal(o.titleBarStyle,'hidden');assert.equal(o.frame,undefined);assert.equal(win.shown,true);
  assert.equal(o.webPreferences.nodeIntegration,false);assert.equal(o.webPreferences.contextIsolation,true);assert.equal(o.webPreferences.sandbox,true);
  if(platform==='darwin'){assert.equal(o.trafficLightPosition.x,14);assert.equal(o.titleBarOverlay,undefined);}
  else{assert.equal(o.titleBarOverlay.height,48);assert.equal(o.titleBarOverlay.color,'#00000000');}
 }
});

test('Windows标题按钮主题桥：仅主窗口主frame及有限主题值可更改颜色',async()=>{
 const {ctx,handlers}=host('win32');await vm.runInContext('createWindow();origin="http://127.0.0.1:49152";registerUpdateIpc()',ctx);
 const win=vm.runInContext('window',ctx),set=handlers.get('window:theme'),valid={sender:win.webContents,senderFrame:win.webContents.mainFrame};
 set({...valid,sender:{}},'dark');assert.equal(win.overlay,undefined);
 set({...valid,senderFrame:{url:'http://127.0.0.1:49152/iframe'}},'dark');assert.equal(win.overlay,undefined);
 set(valid,'blue');assert.equal(win.overlay,undefined);
 set(valid,'dark');assert.equal(win.overlay.symbolColor,'#eeeeee');
 set(valid,'light');assert.equal(win.overlay.symbolColor,'#242424');
});

test('preload只提供标题栏能力标记和枚举主题，不暴露通用窗口或IPC权限',()=>{
 for(const platform of ['darwin','win32','linux']){
  const exposed={},sent=[];
  vm.runInNewContext(readFileSync(join(__dirname,'preload.cjs'),'utf8'),{process:{platform},require:()=>({contextBridge:{exposeInMainWorld:(name,value)=>exposed[name]=value},ipcRenderer:{send:(...args)=>sent.push(args)}})});
  assert.equal(exposed.prismPlatform.integratedTitlebar,platform!=='linux');
  assert.deepEqual(Object.keys(exposed.prismWindow),['setTheme']);
  exposed.prismWindow.setTheme('invalid');exposed.prismWindow.setTheme('dark');
  assert.deepEqual(sent,[['window:theme','dark']]);
 }
});

test('右键菜单接线：注册context-menu监听，空模板不弹，可编辑模板popup到当前窗口',async()=>{
 const {ctx,popups}=host('darwin');await vm.runInContext('createWindow()',ctx);
 const win=vm.runInContext('window',ctx),onContextMenu=win.listeners.get('context-menu');
 assert.equal(typeof onContextMenu,'function');
 onContextMenu.call(win.webContents,null,{isEditable:false,editFlags:{},selectionText:'',x:5,y:6});
 assert.equal(popups.length,0);
 onContextMenu.call(win.webContents,null,{isEditable:true,editFlags:{canUndo:false,canRedo:false,canCut:false,canCopy:true,canPaste:true,canDelete:true,canSelectAll:true},selectionText:'',x:5,y:6});
 assert.equal(popups.length,1);
 assert.equal(popups[0].opts.window,win);
 assert.equal(popups[0].template.some(item=>item.label==='粘贴'),true);
 assert.equal(popups[0].template.some(item=>item.label==='检查元素'),false);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const { PrismUpdater } = require('./updater.cjs');
function host() {
  const file = join(__dirname, '..', 'main.cjs');
  const actual = createRequire(file);
  const events = [];
  const context = vm.createContext({ require: name => name === 'electron' ? {
    app: { setName() {}, requestSingleInstanceLock: () => false, quit() {}, getVersion: () => '0.0.5-beta' },
    dialog: { showErrorBox: (...args) => events.push(['dialog', ...args]) },
  } : name === 'node:fs' ? {...actual(name),appendFileSync:()=>{}} : actual(name), process: { env: {}, platform: 'darwin', versions: { electron: 'test' }, on: () => {} }, setTimeout, clearTimeout, console, events });
  vm.runInContext(readFileSync(file, 'utf8'), context);
  vm.runInContext(`
    globalThis.old = {connected:true,exitCode:null}; backend=old;
    currentSelection={workspace:'/bundle',identity:{businessVersion:'0.0.5-beta',sourceSha:'a'.repeat(40)},releaseId:null};
    currentBundledWorkspace='/bundle'; currentNode='/node'; currentDataDir='/temp';
    currentBuildInfo={version:'0.0.5-beta',sourceSha:'a'.repeat(40)};
    currentLogPath='/unused'; broadcastState = () => {}; ensureNodeModulesLink = () => {};
    updater={host:{businessVersion:'0.0.5-beta'},preApplyCheck:()=>({sourceSha:'b'.repeat(40),productVersion:'0.0.6-beta'}),
      setPhase:()=>{}, failApply:(...args)=>events.push(['failed',...args]), confirmApply:()=>events.push(['confirm']),
      store:{snapshotsDir:'/snapshots',workspaceOf:()=>'/candidate',writePending:()=>{},writeState:()=>{}}};
    stopBackendGracefully=async child=>{ events.push(['stop',child===old?'old':'candidate']);child.exitCode=0; };
  `, context);
  return context;
}
test('等待空闲的IPC失败只解除屏障，不重启或终止旧任务', async () => {
  const ctx = host();
  vm.runInContext(`backendRequest=async (_child,message)=>{if(message.type==='update:prepare')throw new Error('IPC失败');events.push([message.type]);return {};};`,ctx);
  const result = await vm.runInContext(`applyUpdate('release-b')`,ctx);
  assert.equal(result.ok,false);
  assert.equal(ctx.events.filter(e=>e[0]==='stop').length,0);
  assert.equal(vm.runInContext('backend===old && backend.exitCode===null && applyFlow===null',ctx),true);
  assert.ok(ctx.events.some(e=>e[0]==='update:abort'));
});
test('应用前验签错误被处理，不产生未捕获拒绝或触碰旧服务', async () => {
  const ctx = host();
  vm.runInContext(`updater.preApplyCheck=()=>{throw new Error('SIGNATURE_INVALID')};`,ctx);
  const result=await vm.runInContext(`applyUpdate('release-b')`,ctx);
  assert.match(result.error,/SIGNATURE_INVALID/);
  assert.equal(ctx.events.filter(e=>e[0]==='stop').length,0);
});
test('候选健康门禁失败关闭候选并启动原版本，不提交新指针', async () => {
  const ctx=host();
  vm.runInContext(`
    backendRequest=async (_child,message)=>message.type==='update:prepare'?{snapshot:{idle:true}}:{ok:true};
    startBackend=async options=>{const child={connected:true,exitCode:null};return {child,token:'token',port:options.candidate?2:3}};
    healthGate=async options=>{if(options.port===2)throw new Error('候选失败')};
  `,ctx);
  const result=await vm.runInContext(`applyUpdate('release-b')`,ctx);
  assert.equal(result.ok,false);
  assert.deepEqual(ctx.events.filter(e=>e[0]==='stop').map(e=>e[1]),['old','candidate']);
  assert.equal(ctx.events.some(e=>e[0]==='confirm'),false);
  assert.equal(vm.runInContext('currentSelection.identity.businessVersion',ctx),'0.0.5-beta');
});

test('外置当前版本损坏时加载上次成功版本，不丢失防降级序号',()=>{
 const ctx=host();
 vm.runInContext(`
  updater.store={readState:()=>({activeReleaseId:'bad',lastGoodReleaseId:'good',highestAcceptedSequence:3}),readPending:()=>null,
    workspaceOf:id=>'/updates/'+id,writeState:patch=>events.push(['state',patch])};
  updater.preApplyCheck=(id,options)=>{if(id==='bad')throw new Error('VERIFY_HASH_MISMATCH');if(!options.allowRollback)throw new Error('SEQUENCE_REJECTED');return {productVersion:'0.0.6-beta',sourceSha:'b'.repeat(40)}};
 `,ctx);
 const chosen=vm.runInContext(`selectWorkspace({bundledWorkspace:'/bundle',updater})`,ctx);
 assert.equal(chosen.releaseId,'good');
 assert.ok(ctx.events.some(e=>e[0]==='state'&&e[1].activeReleaseId==='good'&&!('highestAcceptedSequence'in e[1])));
});

// 真实验签、逐文件检查与持久状态；仅Electron窗口/依赖链接以既有VM边界替代。
function installedHost(t, versions, state) {
 const ctx=host(), dir=mkdtempSync(join(tmpdir(),'prism-install-floor-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const updater=new PrismUpdater({userDataDir:dir,feed:{githubRepo:'example/releases'},hostIdentity:{
  platform:'darwin',arch:'arm64',channel:'beta',hostVersion:'0.0.6-beta',businessVersion:'0.0.6-beta',
  runtimeCompatibilityId:'node24.same',updatesPublicKey:publicKey.export({type:'spki',format:'pem'}),updatesKeyId:'test',
 }});
 t.after(()=>updater.dispose());
 for(const [id,version] of Object.entries(versions)){
  const workspace=updater.store.workspaceOf(id);mkdirSync(join(workspace,'desktop'),{recursive:true});
  const contents={'package.json':JSON.stringify({version}),'desktop/backend.mjs':'// signed fixture'};
  const files=Object.entries(contents).map(([path,content])=>{
   writeFileSync(join(workspace,path),content);
   return {path,size:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')};
  });
  const manifest={manifestVersion:1,releaseId:id,productVersion:version,updateSequence:1,sourceSha:'a'.repeat(40),
   channel:'beta',platform:'darwin',arch:'arm64',runtimeCompatibilityId:'node24.same',shellVersionRange:'>=0.0.5-beta <0.1.0',
   productionDependenciesHash:'a'.repeat(64),databaseSchemaVersion:24,keyId:'test',package:{file:'test.tar.gz',size:1,sha256:'a'.repeat(64)},files};
  const bytes=Buffer.from(JSON.stringify(manifest));
  writeFileSync(updater.store.manifestFileOf(id),bytes);
  writeFileSync(join(updater.store.releaseDir(id),'manifest.sig'),sign(null,bytes,privateKey).toString('base64'));
  updater.store.writeReleaseRecord(id,{status:'activated',manifest});
 }
 updater.store.writeState({highestAcceptedSequence:9,...state});
 ctx.actualUpdater=updater;
 vm.runInContext("updater=actualUpdater;currentBuildInfo={version:'0.0.6-beta',sourceSha:'b'.repeat(40)};",ctx);
 const select=()=>vm.runInContext("selectWorkspace({bundledWorkspace:'/bundle',updater})",ctx);
 return {updater,select};
}

test('F006-01完整安装：真实签名的旧active及lastGood不能遮蔽随包版本，重启保持且保留恢复证据',t=>{
 const {updater,select}=installedHost(t,{old:'0.0.5-beta',older:'0.0.4-beta'},{activeReleaseId:'old',lastGoodReleaseId:'older'});
 assert.equal(updater.preApplyCheck('old',{allowRollback:true}).productVersion,'0.0.5-beta');
 for(let restart=0;restart<2;restart++){
  const chosen=select();assert.equal(chosen.releaseId,null);assert.equal(chosen.identity.businessVersion,'0.0.6-beta');
  const state=updater.store.readState();assert.equal(state.activeReleaseId,null);assert.equal(state.lastGoodReleaseId,null);
  assert.equal(state.highestAcceptedSequence,9);
 }
 assert.ok(existsSync(updater.store.manifestFileOf('old')));
 assert.equal(updater.store.readReleaseRecord('old').status,'activated');
});

test('完整安装：仅lastGood存在的旧包也解除指针，不重置防降级序号',t=>{
 const {updater,select}=installedHost(t,{old:'0.0.5-beta'},{activeReleaseId:null,lastGoodReleaseId:'old'});
 assert.equal(select().releaseId,null);assert.equal(updater.store.readState().lastGoodReleaseId,null);
 assert.equal(updater.store.readState().highestAcceptedSequence,9);
});

test('完整安装：同版本维护包和更新业务包仍可加载',t=>{
 for(const version of ['0.0.6-beta','0.0.7-beta']){
  const {updater,select}=installedHost(t,{current:version},{activeReleaseId:'current',lastGoodReleaseId:null});
  const chosen=select();assert.equal(chosen.releaseId,'current');assert.equal(chosen.identity.businessVersion,version);
  assert.equal(updater.store.readState().highestAcceptedSequence,9);
 }
});

test('完整安装：新包损坏且lastGood低于随包时回到随包，不回退旧业务',t=>{
 const {updater,select}=installedHost(t,{bad:'0.0.7-beta',old:'0.0.5-beta'},{activeReleaseId:'bad',lastGoodReleaseId:'old'});
 writeFileSync(join(updater.store.workspaceOf('bad'),'desktop/backend.mjs'),'// tampered');
 assert.equal(select().releaseId,null);assert.equal(updater.store.readState().activeReleaseId,null);
 assert.equal(updater.store.readState().highestAcceptedSequence,9);
});

test('完整安装：损坏active仍可回退不低于随包的签名lastGood',t=>{
 const {updater,select}=installedHost(t,{bad:'0.0.8-beta',good:'0.0.7-beta'},{activeReleaseId:'bad',lastGoodReleaseId:'good'});
 writeFileSync(join(updater.store.workspaceOf('bad'),'desktop/backend.mjs'),'// tampered');
 assert.equal(select().releaseId,'good');assert.equal(updater.store.readState().activeReleaseId,'good');
 assert.equal(updater.store.readState().highestAcceptedSequence,9);
});

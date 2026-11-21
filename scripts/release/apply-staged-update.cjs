// 维护入口：先验签下载；只有操作者已停止空闲App时才可离线激活。
// 不绕过签名、兼容性、文件校验或健康门禁；不暴露为产品HTTP接口。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {fork}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {PrismUpdater}=require('../../desktop/updates/updater.cjs');
const arg=name=>process.argv[process.argv.indexOf(name)+1],flag=name=>process.argv.includes(name);
const data=path.resolve(arg('--data')),bundled=path.resolve(arg('--bundled')),node=path.resolve(arg('--node')),out=path.resolve(arg('--out'));
const info=JSON.parse(fs.readFileSync(arg('--host-info'))),id=arg('--release-id'),phase=arg('--phase');
const local=process.argv.includes('--local-feed');
if(local&&(!data.replaceAll('\\','/').includes('/.cache/verification/')||!out.replaceAll('\\','/').includes('/.cache/verification/')))throw Error('本地更新源仅允许隔离验收数据');
const feed=local?{localFeedUrl:arg('--local-feed'),localFeedAssetBase:arg('--asset-base')}:{githubRepo:'Sssovereign/prism-agent-releases'};
const updater=new PrismUpdater({userDataDir:data,hostIdentity:{...info,platform:process.platform,arch:process.arch,channel:'beta',hostVersion:info.hostVersion},feed});
const active=updater.store.readState().activeReleaseId;if(active)updater.host.businessVersion=updater.store.readReleaseRecord(active)?.manifest?.productVersion??info.businessVersion;
fs.mkdirSync(out,{recursive:true,mode:0o700});
function idle(db){
 const counts={runs:db.prepare("SELECT count(*) AS n FROM runs WHERE status NOT IN ('succeeded','failed','cancelled')").get().n,models:db.prepare("SELECT count(*) AS n FROM model_requests WHERE state IN ('reserved','started')").get().n,queue:db.prepare("SELECT count(*) AS n FROM conversation_queue WHERE state='queued'").get().n,memory:db.prepare("SELECT count(*) AS n FROM memory_extractions WHERE state='running'").get().n};
 return {idle:Object.values(counts).every(n=>n===0),counts};
}
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fingerprint(db){const result={};for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
 const statement=db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"');statement.setReadBigInts(true);
 const rows=statement.all().map(row=>JSON.stringify(row,(_k,v)=>typeof v==='bigint'?String(v):v)).sort();result[name]={rows:rows.length,sha256:digest(rows.join('\n'))};
}return result;}
let child,lock,activationOwned=false,confirmed=false;
async function stop(){if(!child||child.exitCode!==null)return;await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},20000);child.once('exit',()=>{clearTimeout(timer);resolve();});if(child.connected)child.send({type:'shutdown'});else child.kill();});}
(async()=>{try{
 if(phase==='idle'){
  const db=new DatabaseSync(path.join(data,'workbench.sqlite'),{readOnly:true});const result=idle(db);db.close();console.log(JSON.stringify(result));if(!result.idle)process.exitCode=3;return;
 }
 lock=fs.openSync(path.join(updater.store.root,'maintenance.lock'),'wx',0o600);
 if(phase==='download'){
  const status=await updater.checkNow({manual:true});assert.equal(status.available?.releaseId,id,JSON.stringify(status.lastError));
  await updater.download(id);updater.preApplyCheck(id);console.log('VERIFIED_UPDATE_STAGED',id);return;
 }
 if(phase!=='activate'||!flag('--app-stopped'))throw Error('激活须先停止空闲App并显式指定 --app-stopped');
 const manifest=updater.preApplyCheck(id),db=new DatabaseSync(path.join(data,'workbench.sqlite'),{readOnly:true});
 assert.equal(idle(db).idle,true,'仍有任务，拒绝激活');const before=fingerprint(db);
 const snapshot=path.join(updater.store.snapshotsDir,id+'-maintenance-'+crypto.randomBytes(6).toString('hex'));fs.mkdirSync(snapshot,{mode:0o700});
 db.exec("VACUUM INTO '"+path.join(snapshot,'workbench.sqlite').replaceAll("'","''")+"'");db.close();
 const key=path.join(data,'credential-master.key'),oldKey=fs.existsSync(key)?digest(fs.readFileSync(key)):null;
 if(oldKey)fs.copyFileSync(key,path.join(snapshot,'credential-master.key'));
 fs.writeFileSync(path.join(snapshot,'evidence.json'),JSON.stringify({releaseId:id,before,keySha256:oldKey},null,2)+'\n',{mode:0o600});
 const workspace=updater.store.workspaceOf(id),link=path.join(workspace,'node_modules'),dependencies=path.join(bundled,'node_modules');
 let linked=false;try{linked=fs.realpathSync(link)===fs.realpathSync(dependencies);}catch{}
 if(!linked){fs.rmSync(link,{recursive:true,force:true});fs.symlinkSync(dependencies,link,process.platform==='win32'?'junction':'dir');}
 const applyId=crypto.randomBytes(8).toString('hex');updater.store.writePending({releaseId:id,applyId,snapshotDir:snapshot,startedAt:new Date().toISOString()});activationOwned=true;
 const token=crypto.randomBytes(32).toString('hex'),log=fs.openSync(path.join(out,'candidate.log'),'a');
 child=fork(path.join(workspace,'desktop/backend.mjs'),[],{execPath:node,cwd:workspace,windowsHide:true,stdio:['ignore',log,log,'ipc'],env:{...process.env,DEBATE_DATA_DIR:data,PRISM_DESKTOP_TOKEN:token,PRISM_UPDATE_CANDIDATE:'1',PRISM_SOURCE_SHA:manifest.sourceSha,PRISM_BUSINESS_VERSION:manifest.productVersion,PRISM_HOST_VERSION:info.hostVersion,PRISM_RUNTIME_COMPAT:manifest.runtimeCompatibilityId,PRISM_DATABASE_SCHEMA_VERSION:String(manifest.databaseSchemaVersion),PATH:path.dirname(node)+path.delimiter+process.env.PATH}});
 fs.closeSync(log);
 const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('候选启动超时')),30000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);reject(Error('候选退出:'+code));});child.on('message',message=>{if(message.type==='ready'){clearTimeout(timer);resolve(message);}});});
 const origin='http://127.0.0.1:'+ready.port,options={headers:{'x-prism-desktop-token':token},signal:AbortSignal.timeout(15000)};
 const response=await fetch(origin+'/api/v1/health',options);assert.equal(response.status,200);const health=(await response.json()).data;
 assert.equal(health.sourceSha,manifest.sourceSha);assert.equal(health.businessVersion,manifest.productVersion);assert.equal((await fetch(origin+'/',options)).status,200);
 await stop();const afterDb=new DatabaseSync(path.join(data,'workbench.sqlite'),{readOnly:true});const after=fingerprint(afterDb);assert.equal(afterDb.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(afterDb.prepare('PRAGMA foreign_key_check').all().length,0);afterDb.close();
 assert.deepEqual(after,before,'候选启动期间数据库内容变化，保留快照并停止确认');assert.equal(fs.existsSync(key)?digest(fs.readFileSync(key)):null,oldKey);
 updater.confirmApply(id);confirmed=true;
 const result={pass:true,releaseId:id,version:manifest.productVersion,sourceSha:manifest.sourceSha,snapshot,databaseTablesUnchanged:Object.keys(before).length,masterKeyUnchanged:true,health};
 fs.writeFileSync(path.join(out,'activation.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log('VERIFIED_OFFLINE_ACTIVATION',manifest.productVersion);
}catch(error){await stop();if(activationOwned&&!confirmed)updater.failApply(id,error.message);throw error;}finally{updater.dispose();if(lock!==undefined){fs.closeSync(lock);fs.unlinkSync(path.join(updater.store.root,'maintenance.lock'));}}})().catch(error=>{console.error(error.message);process.exitCode=1;});

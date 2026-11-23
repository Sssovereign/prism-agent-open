import{test}from'node:test';import assert from'node:assert/strict';import{mkdtempSync,mkdirSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{randomUUID}from'node:crypto';import{buildProductApp}from'../src/app.js';import{clearLoginFailures}from'../src/auth/routes.js';import{buildContextManifest}from'../src/agent/contextManifest.js';
async function fixture(t:{after(fn:()=>unknown):unknown}){
 clearLoginFailures();
 const dir=mkdtempSync(join(tmpdir(),'prism-retry-')),fx=buildProductApp(dir,{serveWeb:false}),workspace=join(dir,'project');mkdirSync(workspace);t.after(async()=>{await fx.app.close();rmSync(dir,{recursive:true,force:true});});
 const register=await fx.app.inject({method:'POST',url:'/api/v1/auth/register',payload:{username:'retry-user',password:'SyntheticRetry2026!',confirmation:'SyntheticRetry2026!'}});assert.equal(register.statusCode,201,register.body);const uid=register.json().data.user.id,headers={cookie:String(register.headers['set-cookie']).split(';')[0]!,'x-csrf-token':register.json().data.csrfToken};const db=fx.db.db,session=(db.prepare('SELECT id FROM sessions WHERE user_id=?').get(uid) as {id:string}).id;
 const p=await fx.app.inject({method:'POST',url:'/api/v1/projects',headers,payload:{name:'retry'}}),pid=p.json().data.id,now=new Date().toISOString();db.prepare("INSERT INTO workspace_grants(id,project_id,canonical_root,access,selected_by,created_at,updated_at) VALUES (?,?,?,'write',?,?,?)").run(randomUUID(),pid,workspace,uid,now,now);
 const c=await fx.app.inject({method:'POST',url:'/api/v1/model-configs',headers,payload:{preset:'custom',name:'fixture',baseUrl:'https://models.example.org/v1',models:[{modelId:'fixture',displayName:'fixture',enabled:true,parameters:{}}]}});assert.equal(c.statusCode,201,c.body);const cid=c.json().data.id;await fx.app.inject({method:'PUT',url:`/api/v1/model-configs/${cid}/credential`,headers,payload:{apiKey:'synthetic-only'}});
 const observed:Array<ReturnType<typeof buildContextManifest>>=[];const modes:string[]=[];let starts=0;fx.supervisor.startAttempt=(runId,attemptId,_s,_c,grant,mode)=>{starts++;modes.push(mode??'start');const conv=(db.prepare('SELECT conversation_id FROM runs WHERE id=?').get(runId) as {conversation_id:string}).conversation_id;observed.push(buildContextManifest(fx.db,{runId,conversationId:conv,grant,checkpointFrom:mode==='start'?'conversation':'run'}));db.prepare("UPDATE attempts SET status='failed',error_code='SYNTHETIC_ERROR' WHERE id=?").run(attemptId);db.prepare("UPDATE runs SET status='failed',stop_reason='SYNTHETIC_ERROR',ended_at=? WHERE id=?").run(now,runId);};
 const created=fx.supervisor.createOrdinaryRun({userId:uid,sessionId:session,projectId:pid,conversationId:null,objective:'原始目标',modelConfigId:cid,modelId:'fixture'});const runId=created.runId,attempt=()=>String(db.prepare('SELECT a.id FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=? ORDER BY a.number DESC LIMIT 1').get(runId)!.id);const retry=(id=attempt(),regenerate?:boolean)=>fx.app.inject({method:'POST',url:`/api/v1/runs/${runId}/retry`,headers,payload:{attemptId:id,...(regenerate===undefined?{}:{regenerate})}});return{fx,db,uid,pid,cid,session,headers,runId,created,attempt,retry,observed,modes,starts:()=>starts};
}
test('失败重试保持同一Run/会话/标题/消息，新增attempt且恢复正式上下文；重复请求不再次执行',async t=>{const f=await fixture(t),first=f.attempt(),counts=()=>['runs','conversations','messages'].map(table=>f.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n),before=counts();const r=await f.retry(first);assert.equal(r.statusCode,200,r.body);assert.notEqual(r.json().data.attemptId,first);assert.deepEqual(counts(),before);assert.equal(f.starts(),2);assert.equal(f.observed.at(-1)!.isResume,true);assert.ok(f.observed.at(-1)!.historyMessages.some(m=>m.text==='原始目标'));assert.equal((await f.retry(first)).json().data.attemptId,r.json().data.attemptId);assert.equal(f.starts(),2);assert.equal((await f.retry()).statusCode,200);assert.equal(f.starts(),3);});
test('旧轮次、归档、他人、非法状态和过期attempt拒绝，保留原任务',async t=>{const f=await fixture(t);assert.equal((await f.fx.app.inject({method:'POST',url:`/api/v1/runs/${f.runId}/retry`,payload:{attemptId:f.attempt()}})).statusCode,401);assert.equal((await f.retry(randomUUID())).statusCode,409);f.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(f.runId);assert.equal((await f.retry()).statusCode,409);f.db.prepare("UPDATE runs SET status='failed' WHERE id=?").run(f.runId);f.db.prepare("UPDATE conversations SET archived_at='2026-11-13' WHERE id=?").run(f.created.conversationId);assert.equal((await f.retry()).statusCode,409);f.db.prepare('UPDATE conversations SET archived_at=NULL WHERE id=?').run(f.created.conversationId);f.fx.supervisor.createOrdinaryRun({userId:f.uid,sessionId:f.session,projectId:f.pid,conversationId:f.created.conversationId,objective:'后续轮次',modelConfigId:f.cid,modelId:'fixture'});assert.equal((await f.retry()).statusCode,409);});
test('未知修改结果阻止盲目重放；缺凭据失败不产生新attempt',async t=>{const f=await fixture(t),attempt=f.attempt(),phase=String(f.db.prepare('SELECT phase_task_id FROM attempts WHERE id=?').get(attempt)!.phase_task_id),id=randomUUID(),now=new Date().toISOString();f.db.prepare("INSERT INTO tool_invocations(id,run_id,phase_task_id,attempt_id,call_key,tool_name,tool_version,args_hash,redacted_args_json,state,effect_kind,created_at,updated_at) VALUES (?,?,?,?,?,'write_file','v1','h','{}','unknown','write',?,?)").run(id,f.runId,phase,attempt,id,now,now);const r=await f.retry();assert.equal(r.statusCode,409,r.body);assert.equal(r.json().error.code,'RECONCILIATION_REQUIRED');assert.equal(f.attempt(),attempt);f.db.prepare("UPDATE tool_invocations SET state='failed' WHERE id=?").run(id);await f.fx.app.inject({method:'DELETE',url:`/api/v1/model-configs/${f.cid}/credential`,headers:f.headers});assert.equal((await f.retry()).statusCode,422);assert.equal(f.attempt(),attempt);});
test('并发重试最多领取一次；启动失败仍在原任务保留可重试状态',async t=>{const f=await fixture(t),first=f.attempt();const results=await Promise.all([f.retry(first),f.retry(first)]);assert.ok(results.every(r=>[200,409].includes(r.statusCode)));assert.equal(f.starts(),2);const id=f.attempt();f.fx.supervisor.startAttempt=()=>{throw Error('synthetic spawn failure');};const failed=await f.retry(id);assert.equal(failed.statusCode,422,failed.body);assert.equal(f.db.prepare('SELECT status FROM runs WHERE id=?').get(f.runId)!.status,'failed');assert.equal(f.db.prepare('SELECT count(*) n FROM conversations').get()!.n,1);});


test('代码主题以应用data-theme为准，支持显式浅色覆盖旧dark类',async()=>{const {resolveCodeTheme}=await import('../web/conversation/shikiSupport.js');const original=globalThis.document;try{globalThis.document={documentElement:{dataset:{theme:'dark'},classList:{contains:()=>false}}} as unknown as Document;assert.equal(resolveCodeTheme(),'github-dark-default');document.documentElement.dataset.theme='light';assert.equal(resolveCodeTheme(),'github-light-default');}finally{if(original)globalThis.document=original;else delete (globalThis as {document?:Document}).document;}});

test('重试等待清理期间到来的新轮次不能被旧轮次抢占',async t=>{const f=await fixture(t);let release!:()=>void;const ready=new Promise<void>(r=>release=r);(f.fx.supervisor as unknown as {ensurePreviousWorkerStopped:()=>Promise<void>}).ensurePreviousWorkerStopped=()=>ready;const retry=f.retry();await new Promise(r=>setTimeout(r,10));f.fx.supervisor.createOrdinaryRun({userId:f.uid,sessionId:f.session,projectId:f.pid,conversationId:f.created.conversationId,objective:'并发后续消息',modelConfigId:f.cid,modelId:'fixture'});release();assert.equal((await retry).statusCode,409);assert.equal(f.db.prepare('SELECT count(*) n FROM attempts').get()!.n,2);});

test('重新回答需显式请求，保留同一Run/会话与用户消息；重复点击幂等，失败后仍保留重答语义',async t=>{
 const f=await fixture(t),first=f.attempt();f.db.prepare("UPDATE runs SET status='succeeded' WHERE id=?").run(f.runId);
 assert.equal((await f.retry(first)).statusCode,409);
 const counts=()=>['runs','conversations','messages'].map(table=>f.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n),before=counts();
 const result=await f.retry(first,true);assert.equal(result.statusCode,200,result.body);assert.deepEqual(counts(),before);assert.equal(f.modes.at(-1),'regenerate');assert.equal(f.observed.at(-1)!.isResume,true);
 assert.equal(JSON.parse(String(f.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(f.runId)!.config_snapshot_json)).regenerateAnswer,true);
 assert.equal((await f.retry(first,true)).json().data.attemptId,result.json().data.attemptId);assert.equal(f.starts(),2);
 assert.equal((await f.retry()).statusCode,200);assert.equal(f.starts(),3);assert.equal(JSON.parse(String(f.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(f.runId)!.config_snapshot_json)).regenerateAnswer,true);
});

test('分叉式重答：旧答复墓碑化不删行，新attempt上下文剥离旧答案，二次重答仅留墓碑',async t=>{
 const f=await fixture(t),first=f.attempt(),now=new Date().toISOString();
 f.db.prepare("UPDATE runs SET status='succeeded' WHERE id=?").run(f.runId);
 const conv=(f.db.prepare('SELECT conversation_id FROM runs WHERE id=?').get(f.runId) as {conversation_id:string}).conversation_id;
 const nextSeq=()=>Number((f.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS s FROM messages WHERE conversation_id=?').get(conv) as {s:number}).s);
 const addAnswer=(text:string)=>f.db.prepare("INSERT INTO messages(id,conversation_id,run_id,author_type,seq,visibility,state,content_json,created_at,updated_at) VALUES (?,?,?,'agent',?,'public','published',?,?,?)").run(randomUUID(),conv,f.runId,nextSeq(),JSON.stringify({text}),now,now);
 addAnswer('旧答复内容');
 const rowsBefore=Number((f.db.prepare('SELECT COUNT(*) n FROM messages').get() as {n:number}).n);
 const result=await f.retry(first,true);assert.equal(result.statusCode,200,result.body);
 assert.equal(Number((f.db.prepare('SELECT COUNT(*) n FROM messages').get() as {n:number}).n),rowsBefore);
 const agentStates=()=>String((f.db.prepare("SELECT state FROM messages WHERE run_id=? AND author_type='agent' ORDER BY seq").all(f.runId) as unknown as Array<{state:string}>).map(r=>r.state).join(','));
 assert.equal(agentStates(),'abandoned');
 assert.equal(String((f.db.prepare("SELECT state FROM messages WHERE run_id=? AND author_type='user'").get(f.runId) as {state:string}).state),'published');
 assert.equal(f.modes.at(-1),'regenerate');
 assert.ok(!f.observed.at(-1)!.historyMessages.some(m=>m.text==='旧答复内容'));
 assert.ok(f.observed.at(-1)!.historyMessages.some(m=>m.text==='原始目标'));
 f.db.prepare("UPDATE runs SET status='succeeded' WHERE id=?").run(f.runId);
 addAnswer('第二版答复');
 await f.retry(f.attempt(),true);
 assert.equal(agentStates(),'abandoned,abandoned');
 assert.ok(!f.observed.at(-1)!.historyMessages.some(m=>m.text==='第二版答复'));
});

test('失败重试不墓碑化答复，恢复上下文仍含旧答复',async t=>{
 const f=await fixture(t),now=new Date().toISOString(),conv=(f.db.prepare('SELECT conversation_id FROM runs WHERE id=?').get(f.runId) as {conversation_id:string}).conversation_id;
 f.db.prepare("INSERT INTO messages(id,conversation_id,run_id,author_type,seq,visibility,state,content_json,created_at,updated_at) VALUES (?,?,?,'agent',(SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE conversation_id=?),'public','published','{\"text\":\"部分答复\"}',?,?)").run(randomUUID(),conv,f.runId,conv,now,now);
 const result=await f.retry();assert.equal(result.statusCode,200,result.body);
 assert.equal(f.modes.at(-1),'resume');
 assert.equal(String((f.db.prepare("SELECT state FROM messages WHERE run_id=? AND author_type='agent'").get(f.runId) as {state:string}).state),'published');
 assert.ok(f.observed.at(-1)!.historyMessages.some(m=>m.text==='部分答复'));
});

// —— 弱网自愈L2：监督器级attempt自动重建（白名单/台账计数/单主让位/取消）——
const supervisorEvents=(db:import('node:sqlite').DatabaseSync,runId:string)=>(db.prepare('SELECT seq,type,payload_json FROM run_events WHERE run_id=? AND type LIKE \'run.retry%\' ORDER BY seq').all(runId) as unknown as Array<{seq:number;type:string;payload_json:string}>);
test('可重试模型错误失败后自动重建：排期事件+到点新attempt+成功收尾',async t=>{
 const previous=process.env.PRISM_AUTO_RETRY_DELAYS_MS;
 process.env.PRISM_AUTO_RETRY_DELAYS_MS='20';
 t.after(()=>{if(previous===undefined)delete process.env.PRISM_AUTO_RETRY_DELAYS_MS;else process.env.PRISM_AUTO_RETRY_DELAYS_MS=previous;});
 const f=await fixture(t),first=f.attempt();
 f.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(f.runId);
 (f.fx.supervisor as unknown as {failRunningRun:(runId:string,attemptId:string,code:string,extra?:Record<string,unknown>)=>void}).failRunningRun(f.runId,first,'PROVIDER_ERROR',{retryable:true});
 const scheduled=supervisorEvents(f.db,f.runId);
 assert.deepEqual(scheduled.map(e=>e.type),['run.retry_scheduled']);
 const payload=JSON.parse(scheduled[0]!.payload_json);assert.equal(payload.source,'supervisor');assert.equal(payload.retry,1);assert.equal(payload.maxRetries,2);
 const deadline=Date.now()+2000;
 while(Date.now()<deadline&&f.starts()<2)await new Promise(r=>setTimeout(r,10));
 assert.equal(f.starts(),2,'自动重建应启动新attempt');
 assert.deepEqual(supervisorEvents(f.db,f.runId).map(e=>e.type),['run.retry_scheduled','run.retry_finished']);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM run_events WHERE run_id=? AND type='run.retried'").get(f.runId)!.n,1);
 assert.equal(JSON.parse(supervisorEvents(f.db,f.runId).at(-1)!.payload_json).success,true);
});
test('白名单外错误不自动重建；同run最多2次自动重建',async t=>{
 const previous=process.env.PRISM_AUTO_RETRY_DELAYS_MS;
 process.env.PRISM_AUTO_RETRY_DELAYS_MS='20';
 t.after(()=>{if(previous===undefined)delete process.env.PRISM_AUTO_RETRY_DELAYS_MS;else process.env.PRISM_AUTO_RETRY_DELAYS_MS=previous;});
 const f=await fixture(t),fail=(code:string)=>{f.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(f.runId);(f.fx.supervisor as unknown as {failRunningRun:(runId:string,attemptId:string,code:string)=>void}).failRunningRun(f.runId,f.attempt(),code);};
 fail('CREDENTIAL_REQUIRED');
 assert.deepEqual(supervisorEvents(f.db,f.runId),[],'凭据类错误不排期');
 const deadline=Date.now()+150;await new Promise(r=>setTimeout(r,deadline));
 assert.equal(f.starts(),1);
 for(let i=0;i<2;i++)fail('PROVIDER_ERROR');
 assert.equal(supervisorEvents(f.db,f.runId).filter(e=>e.type==='run.retry_scheduled').length,2);
 fail('PROVIDER_ERROR');
 assert.equal(supervisorEvents(f.db,f.runId).filter(e=>e.type==='run.retry_scheduled').length,2,'第3次不再排期');
});
test('单主规则：手动重试与取消让位，到点静默放弃',async t=>{
 const previous=process.env.PRISM_AUTO_RETRY_DELAYS_MS;
 process.env.PRISM_AUTO_RETRY_DELAYS_MS='60';
 t.after(()=>{if(previous===undefined)delete process.env.PRISM_AUTO_RETRY_DELAYS_MS;else process.env.PRISM_AUTO_RETRY_DELAYS_MS=previous;});
 const f=await fixture(t),first=f.attempt(),sup=f.fx.supervisor as unknown as {failRunningRun:(runId:string,attemptId:string,code:string)=>void};
 sup.failRunningRun(f.runId,first,'MODEL_TIMEOUT');
 assert.equal((await f.retry(first)).statusCode,200,'手动重试立即生效');
 const deadline=Date.now()+400;await new Promise(r=>setTimeout(r,deadline));
 assert.equal(f.starts(),2,'自动重建让位，不叠加');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM attempts').get()!.n,2);
 // 取消路径同样清理（failed是终态，cancelRun早退但先清排期）
 f.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(f.runId);
 sup.failRunningRun(f.runId,f.attempt(),'MODEL_TIMEOUT');
 await f.fx.supervisor.cancelRun(f.runId,'user-stop');
 const scheduledBefore=supervisorEvents(f.db,f.runId).filter(e=>e.type==='run.retry_scheduled').length;
 await new Promise(r=>setTimeout(r,300));
 assert.equal(supervisorEvents(f.db,f.runId).filter(e=>e.type==='run.retry_scheduled').length,scheduledBefore,'取消后不再排期');
 assert.equal(f.starts(),2);
});

test('研究run瞬态失败纳入自动重建：分流research.retry只重跑失败phase，台账同为2次封顶',async t=>{
 const previous=process.env.PRISM_AUTO_RETRY_DELAYS_MS;
 process.env.PRISM_AUTO_RETRY_DELAYS_MS='20';
 t.after(()=>{if(previous===undefined)delete process.env.PRISM_AUTO_RETRY_DELAYS_MS;else process.env.PRISM_AUTO_RETRY_DELAYS_MS=previous;});
 const f=await fixture(t);
 const choice={modelConfigId:f.cid,modelId:'fixture'};
 const models=Object.fromEntries(['pro','con','host','juror1','juror2','juror3','aggregate'].map(s=>[s,choice]));
 // 不spawn真实runner：研究launch经supervisor.startAttempt，覆盖为置running的最小实现（模拟fixtures的launch钩子）
 f.fx.supervisor.startAttempt=(runId:string,attemptId:string)=>{f.db.prepare("UPDATE attempts SET status='running' WHERE id=?").run(attemptId);f.db.prepare("UPDATE phase_tasks SET status='running' WHERE active_attempt_id=?").run(attemptId);f.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(runId);};
 const created=f.fx.supervisor.research.create({userId:f.uid,sessionId:f.session,projectId:f.pid,mode:'debate',objective:'研究自动重建验收',rounds:1,models,sources:[{title:'资料',content:'方案A成本下降10%，但样本只有两组。'}],policyVersion:'research-v1'});
 const runId=created.runId;
 const attemptCount=()=>(f.db.prepare('SELECT COUNT(*) n FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=?').get(runId) as {n:number}).n;
 const attempt=()=>String((f.db.prepare(`SELECT a.id FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=? ORDER BY a.number DESC LIMIT 1`).get(runId) as {id:string}).id);
 const sup=f.fx.supervisor as unknown as {failRunningRun:(runId:string,attemptId:string,code:string,extra?:Record<string,unknown>)=>void};
 const failPhase=(code='PROVIDER_ERROR')=>sup.failRunningRun(runId,attempt(),code,{retryable:true});
 assert.equal(attemptCount(),1,'首轮phase已launch');
 failPhase();
 const deadline=Date.now()+2000;
 while(Date.now()<deadline&&attemptCount()<2)await new Promise(r=>setTimeout(r,10));
 assert.equal(attemptCount(),2,'自动重建应经research.retry重开失败phase');
 assert.equal(JSON.parse(supervisorEvents(f.db,runId)[0]!.payload_json).source,'supervisor');
 // 二连瞬态失败仍重建（第2次额度），第3次台账封顶不再排期
 for(let i=0;i<2;i++){const before=supervisorEvents(f.db,runId).filter(e=>e.type==='run.retry_scheduled').length;failPhase();const dd=Date.now()+2000;while(Date.now()<dd&&supervisorEvents(f.db,runId).filter(e=>e.type==='run.retry_scheduled').length<=before)await new Promise(r=>setTimeout(r,10));}
 assert.equal(supervisorEvents(f.db,runId).filter(e=>e.type==='run.retry_scheduled').length,2,'研究run与普通run共用2次台账');
 failPhase();
 assert.equal(supervisorEvents(f.db,runId).filter(e=>e.type==='run.retry_scheduled').length,2,'第3次不再排期');
 assert.equal(attemptCount(),3);
});

test('停机取消已排期的自动重试', async t => {
 const previous = process.env.PRISM_AUTO_RETRY_DELAYS_MS;
 process.env.PRISM_AUTO_RETRY_DELAYS_MS = '80';
 t.after(() => {
  if (previous === undefined) delete process.env.PRISM_AUTO_RETRY_DELAYS_MS;
  else process.env.PRISM_AUTO_RETRY_DELAYS_MS = previous;
 });
 const f = await fixture(t);
 const supervisor = f.fx.supervisor;
 const retryable = supervisor as unknown as {failRunningRun:(runId:string,attemptId:string,code:string,details:Record<string,unknown>)=>void};
 f.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(f.runId);
 retryable.failRunningRun(f.runId, f.attempt(), 'MODEL_TIMEOUT', {retryable:true});
 assert.deepEqual(supervisorEvents(f.db, f.runId).map(event => event.type), ['run.retry_scheduled']);
 await supervisor.stop();
 assert.equal(f.starts(), 1);
 assert.deepEqual(supervisorEvents(f.db, f.runId).map(event => event.type), ['run.retry_scheduled']);
});

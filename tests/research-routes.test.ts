import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildProductApp} from '../src/app.js';
import {clearLoginFailures} from '../src/auth/routes.js';
async function fixture(t:{after(fn:()=>unknown):unknown}) {
 const dir=mkdtempSync(join(tmpdir(),'prism-research-api-')),fx=buildProductApp(dir,{serveWeb:false});
 t.after(async()=>{await fx.app.close();clearLoginFailures();rmSync(dir,{recursive:true,force:true});});
 clearLoginFailures();
 const registered=await fx.app.inject({method:'POST',url:'/api/v1/auth/register',payload:{username:'research-api',password:'SyntheticCheck2026!',confirmation:'SyntheticCheck2026!'}});
 const headers={cookie:String(registered.headers['set-cookie']).split(';')[0]!,'x-csrf-token':registered.json().data.csrfToken as string},uid=registered.json().data.user.id;
 const pid=randomUUID(),configId=randomUUID(),time=new Date().toISOString();
 fx.db.db.prepare('INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(pid,uid,'API验收',time,time);
 fx.db.db.prepare("INSERT INTO workspace_grants(id,project_id,canonical_root,access,selected_by,created_at,updated_at) VALUES (?,?,?,'write',?,?,?)").run(randomUUID(),pid,dir,uid,time,time);
 fx.db.db.prepare("INSERT INTO model_configs(id,owner_user_id,preset,name,base_url,created_at,updated_at) VALUES (?,?,'custom','API验收','https://models.example.org/v1',?,?)").run(configId,uid,time,time);
 fx.db.db.prepare("INSERT INTO model_entries(id,config_id,model_id,display_name,parameters_json,created_at,updated_at) VALUES (?,?,'fixture','模型','{}',?,?)").run(randomUUID(),configId,time,time);
 const key=await fx.app.inject({method:'PUT',url:`/api/v1/model-configs/${configId}/credential`,headers,payload:{apiKey:'synthetic-research-key'}});assert.equal(key.statusCode,200);
 // API contract fixture: scheduling is deterministic; actual Pi coverage lives in agent-chain.
 fx.supervisor.startAttempt=(run,id)=>{fx.db.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run);fx.db.db.prepare("UPDATE attempts SET status='running' WHERE id=?").run(id);fx.db.db.prepare("UPDATE phase_tasks SET status='running' WHERE active_attempt_id=?").run(id);};
 const choice={modelConfigId:configId,modelId:'fixture'},payload={mode:'jury',objective:'API研究议题',models:{juror1:choice,juror2:choice,juror3:choice,aggregate:choice},sources:[{title:'合成资料',content:'固定原文'}],subject:{title:'API验收被评对象',content:'固定原文'},criteria:[{id:'s1',text:'证据充分',mustHave:false}]};
 const create=()=>fx.app.inject({method:'POST',url:`/api/v1/projects/${pid}/research`,headers,payload});
 return {fx,dir,pid,uid,headers,payload,create};
}
test('research API: 登录、CSRF、账号边界及非法模式',async t=>{
 const h=await fixture(t);
 assert.equal((await h.fx.app.inject({method:'POST',url:`/api/v1/projects/${h.pid}/research`,payload:h.payload})).statusCode,401);
 assert.equal((await h.fx.app.inject({method:'POST',url:`/api/v1/projects/${h.pid}/research`,headers:{cookie:h.headers.cookie},payload:h.payload})).statusCode,403);
 assert.equal((await h.fx.app.inject({method:'POST',url:`/api/v1/projects/${h.pid}/research`,headers:h.headers,payload:{...h.payload,mode:'ordinary'}})).statusCode,400);
 const created=await h.create();assert.equal(created.statusCode,201,created.body);const runId=created.json().data.runId;
 const other=await h.fx.app.inject({method:'POST',url:'/api/v1/auth/register',payload:{username:'research-other',password:'SyntheticCheck2026!',confirmation:'SyntheticCheck2026!'}});
 assert.equal((await h.fx.app.inject({url:`/api/v1/runs/${runId}/research`,headers:{cookie:String(other.headers['set-cookie']).split(';')[0]!}})).statusCode,404);
 assert.equal((await h.fx.app.inject({url:`/api/v1/runs/${runId}/research/export`})).statusCode,401);
});
test('research API: 页面与下载消费同一个规范报告，含程序投票和固定视图',async t=>{
 const h=await fixture(t),created=await h.create(),runId=created.json().data.runId;
 for(let i=0;i<4;i++) {
  const attempt=h.fx.db.db.prepare("SELECT a.id FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=? AND a.status='running'").get(runId)!;
  const ctx=h.fx.supervisor.research.context(String(attempt.id))!;
  h.fx.supervisor.research.complete(String(attempt.id),JSON.stringify({text:'独立分析',claims:[],limitations:['合成验收'],...(ctx.phase.role==='juror'?{verdict:'insufficient',criterionEvaluations:[{criterionId:'s1',status:'insufficient',reason:'合成验收'}]}:{summary:'独立摘要'})}));
  h.fx.supervisor.research.launchNext(runId,JSON.parse((h.fx.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(runId) as {config_snapshot_json:string}).config_snapshot_json).sessionRef);
 }
 const view=await h.fx.app.inject({url:`/api/v1/runs/${runId}/research`,headers:h.headers}),download=await h.fx.app.inject({url:`/api/v1/runs/${runId}/research/export`,headers:h.headers});
 assert.equal(download.statusCode,200);assert.match(String(download.headers['content-disposition']),/attachment/);assert.deepEqual(JSON.parse(download.body),view.json().data);assert.equal(view.json().data.report.tally.insufficient,3);assert.equal(view.json().data.report.evidenceStatus,'insufficient');
 assert.equal((await h.fx.app.inject({url:`/api/v1/runs/${runId}`,headers:h.headers})).json().data.run.mode,'jury');
});
test('research API: 文字补充与提前汇总有明确模式边界',async t=>{
 const h=await fixture(t),created=await h.create(),id=created.json().data.runId;
 assert.equal((await h.fx.app.inject({method:'POST',url:`/api/v1/runs/${id}/steer`,headers:h.headers,payload:{text:'公开补充',clientMessageId:randomUUID()}})).statusCode,200);
 assert.equal((await h.fx.app.inject({method:'POST',url:`/api/v1/runs/${id}/research/summarize`,headers:h.headers,payload:{}})).statusCode,409);
 assert.equal((await h.fx.app.inject({method:'POST',url:`/api/v1/runs/${id}/compact`,headers:h.headers,payload:{}})).statusCode,403);
});


test('research API: 关闭再启动服务，已提交初稿保留并可从下一阶段重试',async t=>{
 const h=await fixture(t),created=await h.create(),runId=created.json().data.runId;
 const prior=h.fx.db.db.prepare('SELECT a.id FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=?').get(runId)!;
 h.fx.supervisor.research.complete(String(prior.id),JSON.stringify({text:'已提交初判',claims:[],limitations:['合成验收'],verdict:'insufficient',criterionEvaluations:[{criterionId:'s1',status:'insufficient',reason:'合成验收'}]}));
 await h.fx.app.close();
 const restarted=buildProductApp(h.dir,{serveWeb:false});
 try{
  assert.equal(restarted.db.db.prepare('SELECT status FROM runs WHERE id=?').get(runId)!.status,'failed');
  restarted.supervisor.startAttempt=(run,id)=>{restarted.db.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run);restarted.db.db.prepare("UPDATE attempts SET status='running' WHERE id=?").run(id);restarted.db.db.prepare("UPDATE phase_tasks SET status='running' WHERE active_attempt_id=?").run(id);};
  const retry=await restarted.app.inject({method:'POST',url:`/api/v1/runs/${runId}/retry`,headers:h.headers,payload:{attemptId:String(prior.id)}});assert.equal(retry.statusCode,200,retry.body);
  assert.equal(restarted.supervisor.research.context(retry.json().data.attemptId)!.phase.label,'juror2');
  assert.equal(restarted.db.db.prepare("SELECT COUNT(*) n FROM research_records WHERE run_id=? AND kind='opinion'").get(runId)!.n,1);
 }finally{await restarted.app.close();}
});

test('research API: 运行中异议带目标提交与幂等冲突，终态异议随复核创建',async t=>{
 const h=await fixture(t),created=await h.create(),runId=created.json().data.runId;
 assert.equal(created.statusCode,201,created.body);
 const sessionRefOf=()=>JSON.parse((h.fx.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(runId) as {config_snapshot_json:string}).config_snapshot_json).sessionRef;
 const sourceId=String(h.fx.db.db.prepare("SELECT id FROM research_records WHERE run_id=? AND kind='source'").get(runId)!.id);
 const completeJuror=()=>{
  const attempt=h.fx.db.db.prepare("SELECT a.id FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=? AND a.status='running'").get(runId)!;
  h.fx.supervisor.research.complete(String(attempt.id),JSON.stringify({text:'独立初判',claims:[{key:'c1',text:'样本有限',evidence:[{sourceId,quote:'固定原文'}]}],limitations:['合成验收'],verdict:'insufficient',criterionEvaluations:[{criterionId:'s1',status:'insufficient',reason:'合成验收'}]}));
 };
 completeJuror();h.fx.supervisor.research.launchNext(runId,sessionRefOf());
 completeJuror();h.fx.supervisor.research.launchNext(runId,sessionRefOf());
 completeJuror();
 // 意见批次已发布；汇总尚未启动（final.view_id为空）——运行中异议窗口
 const opinion=h.fx.db.db.prepare("SELECT phase_task_id FROM research_records WHERE run_id=? AND kind='opinion' ORDER BY rowid LIMIT 1").get(runId)!;
 const claimId=`${opinion.phase_task_id}:c1`;
 assert.equal((await h.fx.app.inject({method:'POST',url:`/api/v1/runs/${runId}/steer`,headers:h.headers,payload:{text:'x',clientMessageId:'11111111-1111-4111-8111-111111111111',target:{type:'conclusion'}}})).statusCode,400);
 const first=await h.fx.app.inject({method:'POST',url:`/api/v1/runs/${runId}/steer`,headers:h.headers,payload:{text:'样本口径不同意',clientMessageId:'11111111-1111-4111-8111-111111111111',target:{type:'claim',claimId}}});
 assert.equal(first.statusCode,200,first.body);
 const objectionId=String(first.json().data.objectionId);
 assert.equal((await h.fx.app.inject({method:'POST',url:`/api/v1/runs/${runId}/steer`,headers:h.headers,payload:{text:'样本口径不同意',clientMessageId:'11111111-1111-4111-8111-111111111111',target:{type:'claim',claimId}}})).json().data.duplicate,true);
 assert.equal((await h.fx.app.inject({method:'POST',url:`/api/v1/runs/${runId}/steer`,headers:h.headers,payload:{text:'样本口径不同意',clientMessageId:'11111111-1111-4111-8111-111111111111',target:{type:'claim',claimId:`${opinion.phase_task_id}:c9`}}})).statusCode,409);
 assert.equal(h.fx.db.db.prepare("SELECT COUNT(*) n FROM research_records WHERE run_id=? AND kind='objection'").get(runId)!.n,1);
 // 汇总必须逐条回应；回应组装进报告
 const sessionRef=JSON.parse((h.fx.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(runId) as {config_snapshot_json:string}).config_snapshot_json).sessionRef;
 h.fx.supervisor.research.launchNext(runId,sessionRef);
 const aggregate=h.fx.db.db.prepare("SELECT a.id FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=? AND a.status='running'").get(runId)!;
 h.fx.supervisor.research.complete(String(aggregate.id),JSON.stringify({text:'汇总',summary:'汇总摘要',claims:[],limitations:['合成验收'],objectionResponses:[{objectionId,resolution:'partial',reason:'口径按台账为准'}]}));
 const report=(await h.fx.app.inject({url:`/api/v1/runs/${runId}/research`,headers:h.headers})).json().data.report;
 assert.equal(report.objections[0].responses[0].resolution,'partial');
 // 终态异议：随复核创建进入新run（主张+结论）
 const review=await h.fx.app.inject({method:'POST',url:`/api/v1/projects/${h.pid}/research`,headers:h.headers,payload:{mode:'jury',objective:'API研究议题',models:h.payload.models,sources:[],sourceRunId:runId,subject:{title:'被评对象',content:'固定原文'},criteria:[{id:'s1',text:'证据充分',mustHave:false}],objections:[{target:{type:'claim',claimId},text:'初判证据不足'},{target:{type:'conclusion'},text:'结论低估样本限制'}]}});
 assert.equal(review.statusCode,201,review.body);
 const inspect=(await h.fx.app.inject({url:`/api/v1/runs/${review.json().data.runId}/research`,headers:h.headers})).json().data;
 const reviewObjections=inspect.records.filter((r:{kind:string;content:string})=>r.kind==='objection');
 assert.equal(reviewObjections.length,3);
 assert.equal(reviewObjections.filter((r:{content:string})=>!r.content.includes('"origin"')).length,2);
});


test('research API: 研究会话续聊与执行交接——运行中冲突、结束成功、重试互斥、锚点独立分页、上下文与交接快照',async t=>{
 const h=await fixture(t);
 const created=await h.create(),runId=created.json().data.runId,convId=created.json().data.conversationId;
 assert.equal(created.statusCode,201,created.body);
 const models=h.payload.models.juror1;
 const ordinaryPayload={objective:'续聊追问结论',modelConfigId:models.modelConfigId,modelId:models.modelId,conversationId:convId};
 const sessionRefOf=()=>JSON.parse((h.fx.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(runId) as {config_snapshot_json:string}).config_snapshot_json).sessionRef;
 const completeJuror=()=>{
  const attempt=h.fx.db.db.prepare("SELECT a.id FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=? AND a.status='running'").get(runId)!;
  h.fx.supervisor.research.complete(String(attempt.id),JSON.stringify({text:'独立初判',claims:[],limitations:['合成验收'],verdict:'insufficient',criterionEvaluations:[{criterionId:'s1',status:'insufficient',reason:'合成验收'}]}));
 };
 const failOrdinary=(id:string)=>{const time=new Date().toISOString();h.fx.db.db.prepare("UPDATE runs SET status='failed',ended_at=?,updated_at=? WHERE id=?").run(time,time,id);h.fx.db.db.prepare("UPDATE attempts SET status='failed',updated_at=? WHERE phase_task_id IN (SELECT id FROM phase_tasks WHERE run_id=?)").run(time,id);};
 // 研究进行中：普通创建与研究重试同口径互斥
 completeJuror();h.fx.supervisor.research.launchNext(runId,sessionRefOf());
 const busy=await h.fx.app.inject({method:'POST',url:`/api/v1/projects/${h.pid}/runs`,headers:h.headers,payload:ordinaryPayload});
 assert.equal(busy.statusCode,409,busy.body);assert.equal(busy.json().error.code,'CONVERSATION_BUSY');
 // 研究停止后：同会话普通创建成功
 assert.equal((await h.fx.app.inject({method:'POST',url:`/api/v1/runs/${runId}/cancel`,headers:h.headers})).statusCode,200);
 // 取消API只翻run状态；受控测试环境无worker收尾，把活动阶段与attempt归位（阶段回pending等待重试）
 const stopTime=new Date().toISOString();
 const juror2Phase=h.fx.db.db.prepare("SELECT id FROM phase_tasks WHERE run_id=? AND status='running'").get(runId) as {id:string}|undefined;
 if(juror2Phase){
  h.fx.db.db.prepare("UPDATE attempts SET status='cancelled',updated_at=? WHERE id=(SELECT active_attempt_id FROM phase_tasks WHERE id=?)").run(stopTime,juror2Phase.id);
  h.fx.db.db.prepare("UPDATE phase_tasks SET status='pending',updated_at=? WHERE id=?").run(stopTime,juror2Phase.id);
 }
 const cont=await h.fx.app.inject({method:'POST',url:`/api/v1/projects/${h.pid}/runs`,headers:h.headers,payload:ordinaryPayload});
 assert.equal(cont.statusCode,201,cont.body);assert.equal(cont.json().data.status,'running');
 const ordinaryId=String(cont.json().data.runId);
 // 研究重试在普通run活动时统一CONVERSATION_BUSY；普通run结束后重试恢复
 const juror1Attempt=String(h.fx.db.db.prepare('SELECT a.id FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=? ORDER BY a.number LIMIT 1').get(runId)!.id);
 const retryBusy=await h.fx.app.inject({method:'POST',url:`/api/v1/runs/${runId}/retry`,headers:h.headers,payload:{attemptId:juror1Attempt}});
 assert.equal(retryBusy.statusCode,409,retryBusy.body);assert.equal(retryBusy.json().error.code,'CONVERSATION_BUSY');
 failOrdinary(ordinaryId);
 const retry=await h.fx.app.inject({method:'POST',url:`/api/v1/runs/${runId}/retry`,headers:h.headers,payload:{attemptId:juror1Attempt}});
 assert.equal(retry.statusCode,200,retry.body);
 // 研究跑完出报告：普通run冻结研究上下文；执行交接进快照与正文；锚点独立于分页
 completeJuror();h.fx.supervisor.research.launchNext(runId,sessionRefOf());
 completeJuror();h.fx.supervisor.research.launchNext(runId,sessionRefOf());
 const aggregate=h.fx.db.db.prepare("SELECT a.id FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=? AND a.status='running'").get(runId)!;
 h.fx.supervisor.research.complete(String(aggregate.id),JSON.stringify({text:'汇总',summary:'独立摘要',claims:[],limitations:['合成验收']}));
 const cont2=await h.fx.app.inject({method:'POST',url:`/api/v1/projects/${h.pid}/runs`,headers:h.headers,payload:{...ordinaryPayload,objective:'基于结论推进'}});
 assert.equal(cont2.statusCode,201,cont2.body);
 const cont2Id=String(cont2.json().data.runId);
 const snapshot=JSON.parse((h.fx.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(cont2Id) as {config_snapshot_json:string}).config_snapshot_json) as {researchContext?:string};
 assert.match(String(snapshot.researchContext),/研究议题：API研究议题/);assert.match(String(snapshot.researchContext),/最终摘要：独立摘要/);
 failOrdinary(cont2Id);
 // 锚点：窗口不含研究run仍返回；run.mode随窗口下发
 const window=await h.fx.app.inject({url:`/api/v1/runs/${cont2Id}/conversation?limit=1`,headers:h.headers});
 assert.equal(window.statusCode,200,window.body);
 assert.equal(window.json().data.research.runId,runId);
 assert.equal(window.json().data.runs[0].mode,'ordinary');
 assert.equal(window.json().data.runs.some((r:{id:string})=>r.id===runId),false);
 // 执行交接：来源与验收项冻结进快照、验收清单进正文
 const handoff=await h.fx.app.inject({method:'POST',url:`/api/v1/projects/${h.pid}/runs`,headers:h.headers,payload:{...ordinaryPayload,objective:'交接执行',researchHandoff:{sourceRunId:runId,items:['交付文档存在','口径与结论一致']}}});
 assert.equal(handoff.statusCode,201,handoff.body);
 const handoffId=String(handoff.json().data.runId);
 const handoffSnapshot=JSON.parse((h.fx.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(handoffId) as {config_snapshot_json:string}).config_snapshot_json) as {researchHandoff?:{sourceRunId:string;items:string[]};researchContext?:string};
 assert.deepEqual(handoffSnapshot.researchHandoff,{sourceRunId:runId,items:['交付文档存在','口径与结论一致']});
 assert.match(String(handoffSnapshot.researchContext),/研究议题/);
 const body=h.fx.db.db.prepare("SELECT content_json FROM messages WHERE run_id=? AND author_type='user' ORDER BY seq LIMIT 1").get(handoffId) as {content_json:string};
 assert.ok(body,'用户目标消息应存在');
 assert.match(String(JSON.parse(body.content_json).text),/【执行交接·验收项】/);assert.match(String(JSON.parse(body.content_json).text),/交付文档存在/);
 // 查找分派：研究发言以authorType=research返回并携带phaseTaskId（驱动面板锚点定位）
 failOrdinary(handoffId);
 const found=await h.fx.app.inject({url:`/api/v1/runs/${cont2Id}/find?q=${encodeURIComponent('独立初判')}`,headers:h.headers});
 assert.equal(found.statusCode,200,found.body);
 const researchHit=found.json().data.matches.find((m:{authorType:string})=>m.authorType==='research');
 assert.ok(researchHit,'研究发言应可被会话查找命中');assert.ok(researchHit.phaseTaskId);
 assert.equal((await h.fx.app.inject({method:'POST',url:`/api/v1/projects/${h.pid}/runs`,headers:h.headers,payload:{...ordinaryPayload,objective:'交接执行',researchHandoff:{sourceRunId:ordinaryId,items:['a']}}})).statusCode,400);
 assert.equal((await h.fx.app.inject({method:'POST',url:`/api/v1/projects/${h.pid}/runs`,headers:h.headers,payload:{...ordinaryPayload,objective:'交接执行',researchHandoff:{sourceRunId:runId,items:[]}}})).statusCode,400);
});

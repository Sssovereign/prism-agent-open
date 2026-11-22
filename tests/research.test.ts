import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Db} from '../src/storage/db.js';
import {migrate} from '../src/storage/migrate.js';
import {ResearchCoordinator,verifySourceVerdict,type ResearchModel} from '../src/agent/research.js';
import {saveAttachment} from '../src/agent/attachments.js';
import {collectCachedMcpTools} from '../src/agent/mcpManager.js';
import {deleteArchivedConversation} from '../src/projects/archive.js';
import type {ResearchSubmission} from '../contracts/research.js';
import { researchContextChars, researchPromptRecords } from '../src/agent/researchContext.js';

function fixture(t:{after(fn:()=>unknown):unknown},opts:{memoryIndex?:(projectId:string)=>string|null}={}) {
 const dir=mkdtempSync(join(tmpdir(),'prism-research-')),db=new Db(join(dir,'db.sqlite'));migrate(db);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const userId=randomUUID(),projectId=randomUUID(),configId=randomUUID(),time=new Date().toISOString();
 db.db.prepare("INSERT INTO users(id,username,password_hash,password_salt,password_params_json,created_at,updated_at) VALUES (?,?,'x','s','{}',?,?)").run(userId,userId,time,time);
 db.db.prepare('INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(projectId,userId,'研究',time,time);
 db.db.prepare("INSERT INTO model_configs(id,owner_user_id,preset,name,base_url,search_provider,created_at,updated_at) VALUES (?,?,'custom','模型','https://example.com','zhipu',?,?)").run(configId,userId,time,time);
 const model:ResearchModel={configId,modelId:'test',displayName:'测试',baseUrl:'https://example.com',preset:'custom',revision:1,contextWindow:131072,maxOutputTokens:4096};
 // 视觉能力开关：拨动冻结模型的advanced.image（创建前预检按此判定）
 const setVision=(on:boolean)=>{model.parameters={advanced:{image:on}} as unknown as ResearchModel['parameters'];};
 // 注册第二个模型配置：逐角色视觉预检测试用（freeze按configId区分，缺省回落共享model）
 const modelsByConfig=new Map<string,ResearchModel>();
 const registerModel=(vision:boolean):string=>{
   const id=randomUUID();
   db.db.prepare("INSERT INTO model_configs(id,owner_user_id,preset,name,base_url,search_provider,created_at,updated_at) VALUES (?,?,'custom','模型','https://example.com','zhipu',?,?)").run(id,userId,time,time);
   modelsByConfig.set(id,{configId:id,modelId:'test',displayName:vision?'视觉模型':'文本模型',baseUrl:'https://example.com',preset:'custom',revision:1,contextWindow:131072,maxOutputTokens:4096,parameters:{advanced:{image:vision}} as unknown as ResearchModel['parameters']});
   return id;
 };
 let attemptId='';
 const kernel=new ResearchCoordinator(db,{freeze:(sessionId,configId)=>modelsByConfig.get(configId)??model,launch:(run,id)=>{
   attemptId=id;db.db.prepare("UPDATE attempts SET status='running' WHERE id=?").run(id);db.db.prepare("UPDATE phase_tasks SET status='running' WHERE active_attempt_id=?").run(id);db.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run);
 },...opts});
 const choice={modelConfigId:configId,modelId:'test'},models=Object.fromEntries(['pro','con','host','juror1','juror2','juror3','aggregate'].map(s=>[s,choice]));
 // 既有语义测试固定v1（对应“升级前创建的run”）；v2行为走createV2。
 const create=(mode:'debate'|'jury'='debate',extra={})=>kernel.create({userId,sessionId:'test-session',projectId,mode,objective:'是否采用方案A',rounds:1,models,sources:[{title:'原始资料',content:'方案A成本下降10%，但样本只有两组。'}],policyVersion:'research-v1',...extra});
 // 能力扩展夹具：写 agent 设置 / 工作区技能 / MCP 只读工具缓存
 const putSettings=(json:Record<string,unknown>)=>db.db.prepare('INSERT INTO agent_runtime_settings(user_id,settings_json,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json,updated_at=excluded.updated_at').run(userId,JSON.stringify(json),new Date().toISOString());
 const seedSkill=(name:string,body:string)=>{const skillDir=join(dir,'.prism','skills',name);mkdirSync(skillDir,{recursive:true});writeFileSync(join(skillDir,'SKILL.md'),`---\nname: ${name}\ndescription: ${name} 方法说明\n---\n${body}`);db.db.prepare("INSERT INTO workspace_grants(id,project_id,canonical_root,access,revision,selected_by,revoked_at,excludes_json,created_at,updated_at) VALUES (?,?,?,'write',1,?,NULL,'[]',?,?)").run(randomUUID(),projectId,dir,'test',time,time);};
 const seedMcpTool=(name='read_table',readOnly=true)=>{const id=randomUUID();db.db.prepare(`INSERT INTO mcp_servers(id,owner_user_id,name,command,args_json,env_json,trusted,enabled,last_error,last_tools_json,created_at,updated_at) VALUES (?,?,?,?,?,'{}',1,1,NULL,?,?,?)`).run(id,userId,'库存库','echo','[]',JSON.stringify([{name,description:'只读查询缓存表',inputSchema:{type:'object',properties:{}},readOnly}]),time,time);return collectCachedMcpTools(db,userId).find(x=>x.toolName===name)!;};
 const runsRow=(runId:string)=>db.db.prepare('SELECT model_request_limit,tool_request_limit,private_json FROM research_runs WHERE run_id=?').get(runId) as {model_request_limit:number;tool_request_limit:number;private_json:string|null};
 const capsOf=(runId:string)=>(JSON.parse((db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(runId) as {config_snapshot_json:string}).config_snapshot_json) as {researchCapabilities?:import('../contracts/research.js').ResearchCapabilitySnapshot}).researchCapabilities;
 const v2Criteria=[{id:'s1',text:'方案满足成本约束',mustHave:true},{id:'s2',text:'样本证据充分',mustHave:false}];
 const createV2=(mode:'debate'|'jury'='debate',extra={})=>kernel.create({userId,sessionId:'test-session',projectId,mode,objective:'是否采用方案A',rounds:1,models,sources:[{title:'原始资料',content:'方案A成本下降10%，但样本只有两组。'}],
  ...(mode==='jury'?{subject:{title:'方案A交付说明',content:'方案A计划先上线可读性，成本下降10%，样本只有两组。'},criteria:v2Criteria}:{}),...extra});
 const v2Juror=(verdict:'pass'|'conditional_pass'|'fail'|'insufficient'|'abstain',over:Partial<import('../contracts/research.js').ResearchSubmission>={}):Partial<import('../contracts/research.js').ResearchSubmission>=>({
   verdict,criterionEvaluations:v2Criteria.map(c=>({criterionId:c.id,status:(verdict==='pass'?'satisfied':verdict==='fail'?'unmet':'insufficient') as 'satisfied'|'unmet'|'insufficient',reason:'逐项理由'})),
   ...(verdict==='abstain'?{abstainReason:'材料不足以独立判断'}:{}),
   ...(verdict==='conditional_pass'?{pendingConditions:[{criterionId:'s2',text:'补齐两组以上样本'}]}:{}),...over});
 const context=()=>kernel.context(attemptId)!;
 const submission=(overrides:Partial<ResearchSubmission>={}):ResearchSubmission=>{
   const ctx=context(),records=kernel.visible(attemptId),source=records.find(r=>r.kind==='source')!;
   const claims=records.filter(r=>r.kind==='statement').flatMap(r=>(JSON.parse(r.content) as {claims:Array<{id:string}>}).claims);
   return {text:`${ctx.phase.label}分析`,claims:[{key:'c1',text:'存在成本收益和样本限制',evidence:[{sourceId:source.id,quote:'样本只有两组'}],respondsTo:ctx.phase.role==='pro'||ctx.phase.role==='con'?claims.slice(-1).map(c=>c.id):[]}],limitations:['尚需外部样本'],...(ctx.phase.role==='host'?{objections:claims.map(c=>({claimId:c.id,resolution:'unresolved' as const,reason:'样本仍不足'}))}:{}),...(ctx.phase.role==='juror'?{verdict:ctx.phase.label==='juror1'?'insufficient' as const:'con' as const}:{}),...overrides};
 };
 const complete=(overrides:Partial<ResearchSubmission>={})=>kernel.complete(attemptId,JSON.stringify(submission(overrides)));
 const advance=(runId:string)=>kernel.launchNext(runId,'test-session');
 return {db,kernel,create,createV2,v2Criteria,v2Juror,context,submission,complete,advance,attempt:()=>attemptId,userId,projectId,models,model,dir,putSettings,seedSkill,seedMcpTool,runsRow,capsOf,setVision,registerModel};
}

test('research: 完整辩论原文引证、回应、规范报告和数据库一致',t=>{
 const h=fixture(t),r=h.create();
 for(let i=0;i<5;i++){assert.equal(h.context().phase.ordinal,i);h.complete();h.advance(r.runId);}
 const report=h.kernel.report(r.runId)!;assert.equal(report.execution,'complete');assert.equal(report.evidenceStatus,'cited');assert.equal(report.claimCount,5);assert.equal(report.evidenceCount,5);
 assert.equal(h.db.db.prepare('SELECT partial FROM runs WHERE id=?').get(r.runId)!.partial,0);
 assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM argument_responses').get()!.n,2);
 assert.equal(h.db.db.prepare('PRAGMA foreign_key_check').all().length,0);
});
test('research: 独立初稿输入相同且对方初稿、搜索结果均不可见',async t=>{
 const h=fixture(t),r=h.create(),first=h.context();h.complete();
 assert.equal(h.kernel.records(r.runId).filter(r=>r.kind==='statement'&&r.published).length,0);
 h.advance(r.runId);const second=h.context();assert.deepEqual(first.view.recordIds,second.view.recordIds);
 const hidden=h.kernel.records(r.runId).find(r=>r.kind==='statement')!;
 await assert.rejects(h.kernel.tool(h.attempt(),'research_read',{recordId:hidden.id},h.userId),/不存在或无权/);
 const result=await h.kernel.tool(h.attempt(),'research_search',{query:'pro分析'},h.userId) as {records:unknown[]};assert.equal(result.records.length,0);
 h.complete();assert.equal(h.kernel.records(r.runId).filter(r=>r.kind==='statement'&&r.published).length,2);
});
test('research: 假引文、越界引证、重复主张和越界回应均不能提交',t=>{
 const h=fixture(t);h.create();
 for(const claim of [
 {key:'c1',text:'伪造',evidence:[{sourceId:h.kernel.visible(h.attempt())[0]!.id,quote:'收益100%'}]},
 {key:'c1',text:'越界',evidence:[{sourceId:randomUUID(),quote:'样本只有两组'}]},
 {key:'c1',text:'越界回应',evidence:[],respondsTo:['private:c1']},
 ])assert.throws(()=>h.complete({claims:[claim]}),/引文|回应/);
 const claim=h.submission().claims[0]!;assert.throws(()=>h.complete({claims:[claim,claim]}),/编号/);
 assert.equal(h.kernel.records(h.context().phase.run_id).filter(r=>r.kind==='statement').length,0);
});
test('research: 引文逐字匹配容忍CJK邻接空白（标签折行空格），实质改写仍拒绝',t=>{
 // 2026-11-22实机4次拒绝皆此因：HTML清洗把内联标签折成空格，模型tokenizer复述引文时归一化。
 const h=fixture(t);
 h.create('debate',{sources:[{title:'带空格资料',content:'方案A成本下降10%， 样本只有两组。盘后披露超2亿元回购或\t增持计划公告，占流动\n资产比例上升。'}]});
 const src=h.kernel.visible(h.attempt()).find(x=>x.kind==='source')!;
 // 逗号后空格、制表符折行：剥除CJK邻接空白后逐字成立
 h.complete({claims:[{key:'c1',text:'成本与样本',evidence:[{sourceId:src.id,quote:'成本下降10%，样本只有两组'}]}]});
 h.advance(h.context().phase.run_id);
 // 实质改写（丢字/换词）仍拒绝，反编造性质不变
 assert.throws(()=>h.complete({claims:[{key:'c3',text:'丢字改写',evidence:[{sourceId:src.id,quote:'盘后披露超2亿元回购增持计划公告'}]}]}),/逐字匹配/);
 assert.throws(()=>h.complete({claims:[{key:'c4',text:'换词改写',evidence:[{sourceId:src.id,quote:'成本下降10个百分点，样本只有两组'}]}]}),/逐字匹配/);
 // 制表符折行容忍
 h.complete({claims:[{key:'c2',text:'回购增持',evidence:[{sourceId:src.id,quote:'盘后披露超2亿元回购或增持计划公告'}]}]});
});
test('research: JSON容错吸收数组闭括号句点与重复对象，截断仍拒绝',t=>{
 const h=fixture(t);h.create();
 const sid=h.kernel.visible(h.attempt())[0]!.id;
 // 直解析失败的"]."verdict""标点滑笔（2026-11-22实机2例）：修复后走完整字段校验
 h.kernel.complete(h.attempt(),`{"text":"分析","claims":[{"key":"c1","text":"主张","evidence":[{"sourceId":"${sid}","quote":"样本只有两组"}]}],"limitations":["a"]."verdict":"con"}`);
 h.advance(h.context().phase.run_id);
 // 完整JSON对象重复输出两遍（实机1例）：取首个平衡对象
 h.kernel.complete(h.attempt(),`{"text":"反方分析","claims":[],"limitations":[]} {"text":"重复","claims":[],"limitations":[]}`);
 h.advance(h.context().phase.run_id);
 // 截断JSON（无闭合）不冒充成功
 assert.throws(()=>h.kernel.complete(h.attempt(),`{"text":"主持","claims":[],"limitations":[]`),/JSON对象/);
});
test('research: 工具后端拒绝文件、命令、MCP、子代理和伪造身份',async t=>{
 const h=fixture(t);h.create();
 for(const tool of ['read_file','bash','agent','write_artifact'])await assert.rejects(h.kernel.tool(h.attempt(),tool,{participantId:'host',role:'host'},h.userId),/允许范围/);
 // 未进冻结清单的MCP工具（含未勾选与未发现）在分支前置处拒绝，消息指向冻结清单
 await assert.rejects(h.kernel.tool(h.attempt(),'mcp__x__read',{},h.userId),/冻结清单/);
});
test('research: 取消后的迟到回报不能发布',t=>{
 const h=fixture(t),r=h.create(),raw=JSON.stringify(h.submission());h.db.db.prepare("UPDATE runs SET status='cancelled',cancel_requested_at='yes' WHERE id=?").run(r.runId);
 assert.throws(()=>h.kernel.complete(h.attempt(),raw),/过期或停止/);assert.equal(h.kernel.report(r.runId),null);
});
test('research: 相同完成回报幂等，不同回报冲突',t=>{
 const h=fixture(t);h.create();const id=h.attempt(),raw=JSON.stringify(h.submission());h.kernel.complete(id,raw);
 assert.equal(h.kernel.complete(id,raw).duplicate,true);assert.throws(()=>h.kernel.complete(id,raw+' '),/内容发生变化/);
});
test('research: 阶段发布与事件原子提交，事件故障全部回滚',t=>{
 const h=fixture(t),r=h.create();h.db.db.exec("CREATE TRIGGER fail_research_event BEFORE INSERT ON run_events WHEN NEW.type='research.phase.completed' BEGIN SELECT RAISE(ABORT,'injected'); END;");
 assert.throws(()=>h.complete(),/injected/);assert.equal(h.kernel.records(r.runId).filter(r=>r.kind==='statement').length,0);assert.equal(h.context().phase.status,'running');
});
test('research: 失败重试保留视图与成功初稿，旧attempt失效',t=>{
 const h=fixture(t),r=h.create();h.complete();h.advance(r.runId);const old=h.attempt(),view=h.context().view,raw=JSON.stringify(h.submission());
 h.db.db.prepare("UPDATE attempts SET status='failed' WHERE id=?").run(old);h.db.db.prepare("UPDATE phase_tasks SET status='failed' WHERE active_attempt_id=?").run(old);h.db.db.prepare("UPDATE runs SET status='failed' WHERE id=?").run(r.runId);
 const retry=h.kernel.retry(r.runId,h.userId,'test-session',old);assert.notEqual(retry.attemptId,old);assert.deepEqual(h.context().view,view);assert.throws(()=>h.kernel.complete(old,raw),/过期或停止/);h.complete();assert.equal(h.kernel.records(r.runId).filter(r=>r.kind==='statement').length,2);
});
test('research: 补充在下一未冻结阶段生效，初稿保持同批基线',t=>{
 const h=fixture(t),r=h.create(),first=h.context().view;const a=h.kernel.supplement(r.runId,'新增公开材料','supplement-1');assert.equal(h.kernel.supplement(r.runId,'新增公开材料','supplement-1').messageId,a.messageId);
 h.complete();h.advance(r.runId);assert.deepEqual(h.context().view.recordIds,first.recordIds);h.complete();h.advance(r.runId);
 assert.equal(h.context().view.supplementThrough,1);assert.ok(h.kernel.visible(h.attempt()).some(r=>r.content==='新增公开材料'));
});
test('research: 提前汇总保留初稿屏障、跳过未开始交锋、partial一致',t=>{
 const h=fixture(t),r=h.create();h.kernel.requestSummary(r.runId);h.complete();h.advance(r.runId);assert.equal(h.context().phase.label,'con');h.complete();h.advance(r.runId);assert.equal(h.context().phase.label,'host');h.complete();
 assert.equal(h.kernel.report(r.runId)!.execution,'early_summary');assert.equal(h.db.db.prepare('SELECT partial FROM runs WHERE id=?').get(r.runId)!.partial,1);
});
test('research: 主持不能遗漏已有主张',t=>{
 const h=fixture(t),r=h.create();for(let i=0;i<4;i++){h.complete();h.advance(r.runId);}assert.throws(()=>h.complete({objections:[]}),/遗漏/);
});
test('research: 陪审初判互不可见，程序保留2反对1资料不足，聚合不能改票',t=>{
 const h=fixture(t),r=h.create('jury');let baseline:string[]|undefined;
 for(let i=0;i<3;i++){const ctx=h.context();baseline??=ctx.view.recordIds;assert.deepEqual(ctx.view.recordIds,baseline);assert.ok(!h.kernel.visible(h.attempt()).some(r=>['opinion','host'].includes(r.kind)));h.complete();h.advance(r.runId);}
 assert.equal(h.context().phase.role,'aggregate');assert.equal(h.kernel.visible(h.attempt()).filter(r=>r.kind==='opinion').length,3);h.complete({verdict:'pro'});
 assert.deepEqual(h.kernel.report(r.runId)!.tally,{pro:0,con:2,mixed:0,insufficient:1,abstain:0});
});

test('research: 超过600KB的完整原文不再阻塞汇总，原失败阶段可重试且不重跑三份初判',t=>{
 const h=fixture(t),content='样本只有两组。'+'资料'.repeat(9_990);
 const sources=Array.from({length:12},(_,i)=>({title:`长原文${i}`,content}));
 const r=h.create('jury',{sources});
 assert.ok(Buffer.byteLength(JSON.stringify(h.kernel.records(r.runId)))>600_000);
 let baseline:string[]|undefined;
 for(let i=0;i<3;i++){
  const ctx=h.context();baseline??=ctx.view.recordIds;assert.deepEqual(ctx.view.recordIds,baseline);
  assert.ok(ctx.prompt.length<30_000);h.complete();h.advance(r.runId);
 }
 assert.equal(h.context().phase.role,'aggregate');
 const view=h.context().view,completed=h.kernel.records(r.runId).filter(r=>r.kind==='opinion'),attempt=h.attempt();
 h.db.db.prepare("UPDATE attempts SET status='failed',error_code='CONTEXT_LIMIT_EXCEEDED' WHERE id=?").run(attempt);
 h.db.db.prepare("UPDATE phase_tasks SET status='failed' WHERE active_attempt_id=?").run(attempt);
 h.db.db.prepare("UPDATE runs SET status='failed' WHERE id=?").run(r.runId);
 h.kernel.retry(r.runId,h.userId,'test-session',attempt);
 assert.deepEqual(h.context().view,view);assert.equal(h.context().phase.role,'aggregate');
 assert.deepEqual(h.kernel.records(r.runId).filter(r=>r.kind==='opinion'),completed);
 h.complete();assert.equal(h.kernel.report(r.runId)!.execution,'complete');
 assert.equal(h.kernel.records(r.runId).filter(r=>r.kind==='source').length,12);
 assert.ok(h.kernel.records(r.runId).filter(r=>r.kind==='source').every(r=>r.content===content));
});

test('research: 原文可逐段还原，尾部引文仍按完整保存原文校验，参数和不可见ID不能越权',async t=>{
 const h=fixture(t),content='开头'+'甲'.repeat(12_000)+'尾部证据',run=h.create('jury',{sources:[{title:'长原文',content}]});
 const record=h.kernel.visible(h.attempt())[0]!;
 let offset=0,reconstructed='';
 for(;;){
  const page=await h.kernel.tool(h.attempt(),'research_read',{recordId:record.id,offset,limit:2_000},h.userId) as {content:string;nextOffset:number|null;totalChars:number;hash:string};
  reconstructed+=page.content;assert.equal(page.hash,record.hash);assert.equal(page.totalChars,content.length);
  if(page.nextOffset===null)break;offset=page.nextOffset;
 }
 assert.equal(reconstructed,content);
 const found=await h.kernel.tool(h.attempt(),'research_search',{query:'尾部证据'},h.userId) as {records:Array<{content:string;offset:number}>};
 assert.ok(found.records[0]!.content.includes('尾部证据'));assert.ok(found.records[0]!.offset>0);assert.ok(found.records[0]!.content.length<=400);
 h.complete({claims:[{key:'tail',text:'核对尾部',evidence:[{sourceId:record.id,quote:'尾部证据'}]}]});
 assert.equal(h.kernel.records(run.runId).find(r=>r.kind==='source')!.content,content);
 assert.ok(h.kernel.records(run.runId).some(r=>r.kind==='opinion'&&r.content.includes('尾部证据')));
});

test('research: 小窗口只装载有限目录，目录和原文分页可达且不放松读取边界',async t=>{
 const h=fixture(t);h.model.contextWindow=8_192;h.model.maxOutputTokens=1_024;
 h.create('jury',{sources:Array.from({length:12},(_,i)=>({title:`资料${i}`,content:'长资料'.repeat(1_000)}))});
 assert.equal(researchContextChars(8_192,1_024),0);assert.ok(h.context().prompt.includes('"completeIndex":false'));
 let offset=0,seen:string[]=[];
 for(;;){const page=await h.kernel.tool(h.attempt(),'research_search',{query:'*',offset,limit:5},h.userId) as {records:Array<{id:string;content:string}>;nextOffset:number|null};
  assert.ok(page.records.every(r=>r.content.length<=400));seen.push(...page.records.map(r=>r.id));
  if(page.nextOffset===null)break;offset=page.nextOffset;
 }
 assert.deepEqual(seen,h.context().view.recordIds);
 for(const args of [{offset:-1},{offset:1.5},{limit:8_001},{limit:0}])await assert.rejects(h.kernel.tool(h.attempt(),'research_read',{recordId:seen[0],...args},h.userId),/读取位置/);
 await assert.rejects(h.kernel.tool(h.attempt(),'research_search',{query:'*',limit:21},h.userId),/搜索位置/);
 await assert.rejects(h.kernel.tool(h.attempt(),'research_read',{recordId:randomUUID()},h.userId),/不存在或无权/);
});
test('research: 陪审可联网核对、聚合无外网，票分类缺失拒绝',async t=>{
 const h=fixture(t),r=h.create('jury');
 assert.deepEqual(h.context().view.tools,['research_read','research_search','web_search','web_fetch']);
 assert.throws(()=>h.complete({verdict:undefined}),/投票分类/);
 h.complete();h.advance(r.runId);h.complete();h.advance(r.runId);h.complete();h.advance(r.runId);
 assert.equal(h.context().phase.role,'aggregate');
 // hostVerify 默认开：聚合增 verify_source（仍无 web_search/web_fetch）
 assert.deepEqual(h.context().view.tools,['research_read','research_search','verify_source']);
 await assert.rejects(h.kernel.tool(h.attempt(),'web_fetch',{url:'https://example.com'},h.userId),/允许范围/);
});
test('research: 陪审复核辩论，初判隐藏主持、聚合才看到主持',t=>{
 const h=fixture(t),debate=h.create();for(let i=0;i<5;i++){h.complete();h.advance(debate.runId);}
 const jury=h.create('jury',{sourceRunId:debate.runId,sources:[]});
 for(let i=0;i<3;i++){assert.ok(!h.kernel.visible(h.attempt()).some(r=>r.kind==='host'));h.complete();h.advance(jury.runId);}
 assert.ok(h.kernel.visible(h.attempt()).some(r=>r.kind==='host'));h.complete();assert.equal(h.kernel.report(jury.runId)!.evidenceStatus,'cited');
});
test('research: 无引证可以完成流程，证据不足独立标明',t=>{
 const h=fixture(t),r=h.create('jury');for(let i=0;i<4;i++){h.complete({claims:[]});h.advance(r.runId);}assert.equal(h.kernel.report(r.runId)!.evidenceStatus,'insufficient');assert.equal(h.kernel.report(r.runId)!.execution,'complete');
});
test('research: 固定视图和原始内容不可改写',t=>{
 const h=fixture(t);h.create();const ctx=h.context();assert.throws(()=>h.db.db.prepare("UPDATE research_views SET manifest_json='{}' WHERE id=?").run(ctx.view.id),/IMMUTABLE/);assert.throws(()=>h.db.db.prepare("UPDATE research_records SET content='替换' WHERE id=?").run(ctx.view.recordIds[0]!),/IMMUTABLE/);
});
test('research: 整场预算不随阶段与重试重置',t=>{
 const h=fixture(t),r=h.create();h.db.db.prepare('UPDATE research_runs SET model_request_limit=0 WHERE run_id=?').run(r.runId);assert.throws(()=>h.kernel.checkBudget(h.attempt(),'model'),/整场研究预算/);
});
test('research: 账号边界与跨项目复核失败关闭',t=>{
 const h=fixture(t),r=h.create();assert.throws(()=>h.kernel.owned(r.runId,randomUUID()),/无权/);assert.throws(()=>h.create('jury',{sourceRunId:r.runId}),/已完成/);
});
test('research: 归档删除清理新增表，保留其他任务',t=>{
 const h=fixture(t),r=h.create();h.db.db.prepare("UPDATE runs SET status='cancelled' WHERE id=?").run(r.runId);h.db.db.prepare("UPDATE conversations SET archived_at=? WHERE id=?").run(new Date().toISOString(),r.conversationId);deleteArchivedConversation(h.db,h.userId,r.conversationId);assert.equal(h.db.db.prepare('SELECT 1 FROM research_runs WHERE run_id=?').get(r.runId),undefined);assert.equal(h.db.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('research: 阶段间重启后从下一阶段恢复，不重复成功发言',t=>{
 const h=fixture(t),r=h.create();const completedId=h.attempt();h.complete();
 h.db.db.prepare("UPDATE runs SET status='failed',stop_reason='INTERRUPTED_RESTART' WHERE id=?").run(r.runId);
 const result=h.kernel.retry(r.runId,h.userId,'new-session',completedId);assert.notEqual(result.attemptId,completedId);assert.equal(h.context().phase.label,'con');h.complete();assert.equal(h.kernel.records(r.runId).filter(r=>r.kind==='statement').length,2);
});
test('research: 最终汇总冻结后拒绝新补充，避免未读补充被冒充已处理',t=>{
 const h=fixture(t),r=h.create('jury');for(let i=0;i<3;i++){h.complete();h.advance(r.runId);}assert.throws(()=>h.kernel.supplement(r.runId,'迟到的新材料',null),/输入已经冻结/);h.complete();assert.equal(h.kernel.report(r.runId)!.execution,'complete');
});

test('research: 聚合允许回应视图内已发布陪审主张，拒绝视图外编号',t=>{
 const h=fixture(t),r=h.create('jury');for(let i=0;i<3;i++){h.complete();h.advance(r.runId);}
 const opinion=h.kernel.visible(h.attempt()).find(r=>r.kind==='opinion')!,claim=JSON.parse(opinion.content).claims[0];
 const output=h.submission();output.claims[0]!.respondsTo=[claim.id];assert.doesNotThrow(()=>h.kernel.complete(h.attempt(),JSON.stringify(output)));assert.equal(h.kernel.report(r.runId)!.tally!.insufficient,1);
});

test('research: 等待用户恢复的闲置时间不消耗执行预算',t=>{
 const h=fixture(t),r=h.create();h.db.db.prepare("UPDATE runs SET created_at='2020-01-01T00:00:00Z' WHERE id=?").run(r.runId);assert.doesNotThrow(()=>h.kernel.checkBudget(h.attempt(),'model'));
});

test('research: 摘要可选、超限拒绝，规范报告记录最终摘要，历史缺摘要回退正文',t=>{
 const h=fixture(t),r=h.create();
 assert.throws(()=>h.complete({summary:'x'.repeat(601)}),/摘要/);
 assert.throws(()=>h.complete({summary:'   '}),/摘要/);
 h.complete({summary:'本轮核心：方案A样本不足。'});
 assert.ok(h.kernel.records(r.runId).find(x=>x.kind==='statement')!.content.includes('样本不足'));
 h.advance(r.runId);
 for(let i=0;i<3;i++){h.complete();h.advance(r.runId);}
 h.complete({summary:'主持结论摘要'});
 const report=h.kernel.report(r.runId)!;
 assert.equal(report.summary,'主持结论摘要');
 assert.notEqual(report.text,report.summary);
 // 历史报告（无summary字段）仍可读取；界面按原正文回退
 h.db.db.prepare('UPDATE research_runs SET report_json=? WHERE run_id=?').run(JSON.stringify({...report,summary:undefined}),r.runId);
 assert.equal(h.kernel.report(r.runId)!.summary,undefined);
 assert.equal(h.kernel.report(r.runId)!.text,report.text);
});

test('research: 版本与协议配置冻结在快照中，跨阶段与重试保持',t=>{
 const h=fixture(t),r=h.create();
 const version=(id:string)=>String((h.db.db.prepare('SELECT policy_version FROM research_runs WHERE run_id=?').get(id) as {policy_version:string}).policy_version);
 assert.equal(version(r.runId),'research-v1');
 const snap=()=>JSON.parse((h.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(r.runId) as {config_snapshot_json:string}).config_snapshot_json) as {policyVersion:string;researchProtocol:{policyVersion:string;verdicts:string[];summaryRequired:boolean;summaryMaxChars:number}};
 assert.equal(snap().policyVersion,'research-v1');
 assert.deepEqual(snap().researchProtocol,{policyVersion:'research-v1',verdicts:['pro','con','mixed','insufficient','abstain'],summaryRequired:false,summaryMaxChars:600,decision:null,subject:null,criteria:null});
 h.complete();h.advance(r.runId);
 assert.deepEqual(snap().researchProtocol,{policyVersion:'research-v1',verdicts:['pro','con','mixed','insufficient','abstain'],summaryRequired:false,summaryMaxChars:600,decision:null,subject:null,criteria:null});
 assert.equal(h.context().view.policyVersion,'research-v1');
 const old=h.attempt();
 h.db.db.prepare("UPDATE attempts SET status='failed' WHERE id=?").run(old);
 h.db.db.prepare("UPDATE phase_tasks SET status='failed' WHERE active_attempt_id=?").run(old);
 h.db.db.prepare("UPDATE runs SET status='failed' WHERE id=?").run(r.runId);
 h.kernel.retry(r.runId,h.userId,'test-session',old);
 assert.deepEqual(snap().researchProtocol,{policyVersion:'research-v1',verdicts:['pro','con','mixed','insufficient','abstain'],summaryRequired:false,summaryMaxChars:600,decision:null,subject:null,criteria:null});
 assert.equal(h.context().view.policyVersion,'research-v1');
});

test('research: 升级前创建的run升级后下一阶段与重试仍按库中版本执行',t=>{
 const h=fixture(t),r=h.create();
 h.complete();h.advance(r.runId);h.complete();
 // 模拟代码升级到新协议版本而该run创建于升级前：此后新建阶段的版本继续读自research_runs.policy_version
 h.db.db.prepare("UPDATE research_runs SET policy_version='research-v0-legacy' WHERE run_id=?").run(r.runId);
 h.advance(r.runId);
 assert.equal(h.context().view.policyVersion,'research-v0-legacy');
 assert.ok(h.context().prompt.includes('research-v0-legacy'));
 h.complete();
 assert.equal(h.kernel.records(r.runId).filter(x=>x.kind==='statement').length,3);
});

test('research: inspect提供阶段key、轮次、模型名、按阶段聚合的工具活动与拒绝',async t=>{
 const h=fixture(t),r=h.create();
 const record=h.kernel.visible(h.attempt())[0]!;
 await h.kernel.tool(h.attempt(),'research_read',{recordId:record.id},h.userId);
 await h.kernel.tool(h.attempt(),'research_search',{query:'样本'},h.userId);
 // 工具调用行由监督器登记：测试直接按其形态落库以验证聚合
 const phaseId=(h.db.db.prepare('SELECT phase_task_id FROM attempts WHERE id=?').get(h.attempt()) as {phase_task_id:string}).phase_task_id;
 const insertTool=(tool:string)=>h.db.db.prepare(`INSERT INTO tool_invocations(id,run_id,phase_task_id,attempt_id,call_key,tool_name,tool_version,args_hash,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'x','succeeded',?,?)`)
  .run(randomUUID(),r.runId,phaseId,h.attempt(),randomUUID(),tool,'1',new Date().toISOString(),new Date().toISOString());
 insertTool('research_read');insertTool('research_search');
 const seq=(h.db.db.prepare('SELECT COALESCE(MAX(seq),0)+1 n FROM run_events WHERE run_id=?').get(r.runId) as {n:number}).n;
 h.db.db.prepare("INSERT INTO run_events(run_id,seq,event_id,attempt_id,visibility,type,occurred_at,payload_json) VALUES (?,?,?,?, 'owner','research.delivery.rejected',?,?)").run(r.runId,seq,randomUUID(),h.attempt(),new Date().toISOString(),JSON.stringify({code:'DELIVERY_INVALID',message:'引文必须逐字匹配当前视图内已保存资料'}));
 const snap=h.kernel.inspect(r.runId) as {protocol:{policyVersion:string;verdicts:string[]};phases:Array<{phaseKey:string;roundNo:number;model:{displayName:string};activity:{tools:Record<string,number>;modelRequests:number};rejections:{count:number;last:{message:string}|null}}>};
 assert.equal(snap.protocol.policyVersion,'research-v1');
 assert.ok(snap.protocol.verdicts.includes('abstain'));
 const first=snap.phases[0]!;
 assert.equal(first.phaseKey,'opening_pro');assert.equal(first.roundNo,0);
 assert.equal(first.model.displayName,'测试');
 assert.equal(first.activity.tools.research_read,1);assert.equal(first.activity.tools.research_search,1);
 assert.equal(first.activity.modelRequests,0);
 assert.equal(first.rejections.count,1);assert.match(first.rejections.last!.message,/逐字匹配/);
 assert.equal(snap.phases[1]!.rejections.count,0);
 assert.equal(snap.phases[1]!.phaseKey,'opening_con');
});

// —— 阶段②：决策与评审（research-v2） ——

test('research v2: 决策辩论交付采用处置，报告携带处置、候选与程序统计',t=>{
 const h=fixture(t),r=h.createV2('debate',{decision:{proposition:'先上线可读性还是等齐再上线',candidates:[{text:'先上线可读性'},{text:'等齐再上线'},{text:'维持现状'}]}});
 assert.equal(h.kernel.policyVersion(r.runId),'research-v2');
 for(let i=0;i<4;i++){h.complete();h.advance(r.runId);}
 const statement=h.kernel.visible(h.attempt()).find(x=>x.kind==='statement')!;
 const claimId=(JSON.parse(statement.content) as {claims:Array<{id:string}>}).claims[0]!.id;
 h.complete({summary:'主持摘要：采用先上线',disposition:{kind:'adopt',candidateId:'cand-1',hardConstraints:'两组以上样本再全量',basisClaimIds:[claimId]}});
 const report=h.kernel.report(r.runId)!;
 assert.equal(report.version,2);
 assert.equal(report.disposition?.kind,'adopt');
 assert.equal(report.disposition?.candidateId,'cand-1');
 assert.equal(report.decision?.candidates.length,3);
 assert.equal(report.tally,null);assert.equal(report.majority,null);
 assert.ok(report.summary);
});

test('research v2: 决策处置缺省、错误候选、错误引用、缺决定性依据与非决策模式均拒绝',t=>{
 const h=fixture(t),r=h.createV2('debate',{decision:{proposition:'决策命题',candidates:[{text:'候选一'},{text:'候选二'}]}});
 for(let i=0;i<4;i++){h.complete();h.advance(r.runId);}
 const statement=h.kernel.visible(h.attempt()).find(x=>x.kind==='statement')!;
 const claimId=(JSON.parse(statement.content) as {claims:Array<{id:string}>}).claims[0]!.id;
 assert.throws(()=>h.complete({summary:'s'}),/决策模式主持必须交付/);
 assert.throws(()=>h.complete({summary:'s',disposition:{kind:'adopt',candidateId:'cand-9',hardConstraints:'x',basisClaimIds:[claimId]}}),/冻结的候选/);
 assert.throws(()=>h.complete({summary:'s',disposition:{kind:'adopt',candidateId:'cand-1',hardConstraints:'x',basisClaimIds:['other:c1']}}),/已发布主张/);
 // B2修复：缺失或空数组的决定性依据均拒绝——处置不能没有可追溯的决定性主张。
 assert.throws(()=>h.complete({summary:'s',disposition:{kind:'adopt',candidateId:'cand-1',hardConstraints:'x'}}),/决定性依据/);
 assert.throws(()=>h.complete({summary:'s',disposition:{kind:'adopt',candidateId:'cand-1',hardConstraints:'x',basisClaimIds:[]}}),/决定性依据/);
 assert.throws(()=>h.complete({summary:'s',disposition:{kind:'trial',scope:'范围'}}),/成功条件/);
 assert.throws(()=>h.complete({summary:'s',disposition:{kind:'defer',missingEvidence:'缺失'}}),/取得方式/);
 h.complete({summary:'试验建议',disposition:{kind:'trial',scope:'灰度一个项目',successCriteria:'异议率下降',reEvalTrigger:'两周后',basisClaimIds:[claimId]}});
 assert.equal(h.kernel.report(r.runId)!.disposition?.kind,'trial');
 assert.deepEqual(h.kernel.report(r.runId)!.disposition?.basisClaimIds,[claimId]);
 const other=h.createV2('debate');
 for(let i=0;i<4;i++){h.complete();h.advance(other.runId);}
 assert.throws(()=>h.complete({summary:'s',disposition:{kind:'trial',scope:'x',successCriteria:'y',reEvalTrigger:'z',basisClaimIds:[claimId]}}),/未启用决策/);
 h.complete({summary:'无决策模式主持'});
 assert.equal(h.kernel.report(other.runId)!.disposition,undefined);
});

test('research v2: 评审逐项判定覆盖/重复/未知ID、引证逐字与弃权理由校验',async t=>{
 const h=fixture(t),r=h.createV2('jury');
 assert.ok(h.context().prompt.includes('satisfied|unmet|insufficient'));
 assert.ok(h.context().prompt.includes('被评对象'));
 const source=h.kernel.visible(h.attempt()).find(x=>x.kind==='source')!;
 assert.throws(()=>h.complete({verdict:'pass'}),/逐项判定/);
 assert.throws(()=>h.complete({...h.v2Juror('pass'),criterionEvaluations:[{criterionId:'s9',status:'satisfied',reason:'x'}]}),/冻结的评审标准/);
 assert.throws(()=>h.complete({...h.v2Juror('pass'),criterionEvaluations:[{criterionId:'s1',status:'satisfied',reason:'x'},{criterionId:'s1',status:'satisfied',reason:'y'}]}),/只能有一条/);
 assert.throws(()=>h.complete({...h.v2Juror('pass'),criterionEvaluations:[{criterionId:'s1',status:'satisfied',reason:'x'}]}),/覆盖全部评审标准/);
 assert.throws(()=>h.complete({...h.v2Juror('pass'),criterionEvaluations:[{criterionId:'s1',status:'satisfied',reason:'x',evidence:[{sourceId:source.id,quote:'假引文'}]},{criterionId:'s2',status:'satisfied',reason:'y'}]}),/逐字匹配/);
 assert.throws(()=>h.complete({...h.v2Juror('abstain'),abstainReason:undefined}),/弃权必须说明原因/);
 assert.doesNotThrow(()=>h.complete({...h.v2Juror('pass'),criterionEvaluations:[{criterionId:'s1',status:'satisfied',reason:'x',evidence:[{sourceId:source.id,quote:'样本只有两组'}]},{criterionId:'s2',status:'satisfied',reason:'y'}]}));
});

test('research v2: 逐项判定与总判定交叉校验，必达标准未满足不能通过',t=>{
 const h=fixture(t),r=h.createV2('jury');
 assert.throws(()=>h.complete({...h.v2Juror('pass'),criterionEvaluations:[{criterionId:'s1',status:'unmet',reason:'成本未达标'},{criterionId:'s2',status:'satisfied',reason:'y'}]}),/必达标准/);
 assert.throws(()=>h.complete({...h.v2Juror('conditional_pass'),pendingConditions:[]}),/列明待达成条件/);
 assert.throws(()=>h.complete({...h.v2Juror('conditional_pass'),pendingConditions:[{criterionId:'s9',text:'补证'}]}),/对应评审标准/);
 h.complete({...h.v2Juror('conditional_pass')});
});

test('research v2: 锁定票型分别计票、无多数显示、汇总阻断项与下一步',t=>{
 const h=fixture(t),r=h.createV2('jury');
 h.complete({...h.v2Juror('pass')});h.advance(r.runId);
 h.complete({...h.v2Juror('conditional_pass')});h.advance(r.runId);
 h.complete({...h.v2Juror('fail')});h.advance(r.runId);
 assert.throws(()=>h.complete({}),/非空摘要/);
 assert.throws(()=>h.complete({summary:'汇总',blockingItems:[{criterionId:'s9',reason:'x'}]}),/对应评审标准/);
 h.complete({summary:'汇总摘要',blockingItems:[{criterionId:'s1',reason:'成本证据不足'}],nextSteps:['补齐样本后复评']});
 const report=h.kernel.report(r.runId)!;
 assert.deepEqual(report.tally,{pass:1,conditional_pass:1,fail:1,insufficient:0,abstain:0});
 assert.equal(report.majority,null);
 assert.deepEqual(report.criterionSummary?.[0],{id:'s1',text:'方案满足成本约束',mustHave:true,satisfied:1,unmet:1,insufficient:1});
 assert.deepEqual(report.blockingItems,[{criterionId:'s1',reason:'成本证据不足'}]);
 assert.deepEqual(report.nextSteps,['补齐样本后复评']);
 assert.equal(report.summary,'汇总摘要');
});

test('research v2: 陪审逐项引证入证据表，报告不再误标证据不足',t=>{
 // J1修复：criterionEvaluations[].evidence通过逐字校验后必须入证据表——
 // 否则存在有效原文引证时 evidenceCount=0、evidenceStatus=insufficient（报告事实错误）。
 const h=fixture(t),r=h.createV2('jury');
 const source=h.kernel.visible(h.attempt()).find(x=>x.kind==='source')!;
 for(let i=0;i<3;i++){
  h.complete({...h.v2Juror('pass'),claims:[],criterionEvaluations:[{criterionId:'s1',status:'satisfied',reason:'成本达标',evidence:[{sourceId:source.id,quote:'样本只有两组'}]},{criterionId:'s2',status:'satisfied',reason:'y'}]});
  h.advance(r.runId);
 }
 h.complete({summary:'汇总摘要',claims:[],limitations:['合成验收']});
 const report=h.kernel.report(r.runId)!;
 assert.equal(report.evidenceStatus,'cited');
 assert.equal(report.evidenceCount,3);
 const rows=h.db.db.prepare('SELECT locator_json,producer_role FROM evidence WHERE run_id=?').all(r.runId) as Array<{locator_json:string;producer_role:string}>;
 assert.equal(rows.length,3);
 for(const row of rows){assert.equal(JSON.parse(row.locator_json).criterionId,'s1');assert.ok(row.producer_role);}
 // 逐项引证不属于任何主张：不写argument_evidence关联
 assert.equal((h.db.db.prepare('SELECT COUNT(*) n FROM argument_evidence').get() as {n:number}).n,0);
});

test('research: 交锋回应重复引用同一主张直接拒绝，不再触发数据库约束错误',t=>{
 // B1修复：重复respondsTo此前会撞argument_responses复合主键→事务回滚内部错误；现在校验层按格式错误拒绝，走修复流程。
 const h=fixture(t),r=h.create();
 h.complete();h.advance(r.runId);h.complete();h.advance(r.runId);
 const claimId=(JSON.parse(h.kernel.visible(h.attempt()).find(x=>x.kind==='statement')!.content as string) as {claims:Array<{id:string}>}).claims[0]!.id;
 assert.throws(()=>h.complete({claims:[{key:'c1',text:'回应',evidence:[],respondsTo:[claimId,claimId]}]}),/不能重复/);
});

test('research: 主持阶段开始后拒绝提前汇总，完整辩论不再误标early_summary',t=>{
 // B3修复：全部交锋完成、主持已启动时requestSummary曾把完整辩论标成early_summary（runs.partial=1）。
 const h=fixture(t),r=h.create();
 for(let i=0;i<4;i++){h.complete();h.advance(r.runId);}
 assert.equal(h.context().phase.role,'host');
 assert.throws(()=>h.kernel.requestSummary(r.runId),/主持阶段已开始/);
 h.complete();
 const report=h.kernel.report(r.runId)!;
 assert.equal(report.execution,'complete');
 const run=h.db.db.prepare('SELECT partial,stop_reason FROM runs WHERE id=?').get(r.runId) as {partial:number;stop_reason:string};
 assert.equal(run.partial,0);assert.equal(run.stop_reason,'completed');
});

test('research: 运行中目标异议执行2000字符上限，与终态复核入口一致',t=>{
 // B4修复：steer带目标的异议此前沿用普通补充的20000字符上限。
 const h=fixture(t),r=h.create();
 h.complete();h.advance(r.runId);h.complete();h.advance(r.runId);
 const claimId=(JSON.parse(h.kernel.visible(h.attempt()).find(x=>x.kind==='statement')!.content as string) as {claims:Array<{id:string}>}).claims[0]!.id;
 assert.throws(()=>h.kernel.supplement(r.runId,'长'.repeat(2001),null,{type:'claim',claimId}),/异议须为1—2000字符/);
 const accepted=h.kernel.supplement(r.runId,'长'.repeat(2000),null,{type:'claim',claimId});
 assert.ok(accepted.objectionId);
});

test('research v2: 必达标准多数未满足时聚合必须提供对应阻断项',t=>{
 // J2修复：陪审员全部判定必达标准未满足时，聚合不能只交摘要——失败必须附带可追溯的阻断项。
 const h=fixture(t),r=h.createV2('jury');
 for(let i=0;i<3;i++){h.complete({...h.v2Juror('fail')});h.advance(r.runId);}
 assert.throws(()=>h.complete({summary:'仅摘要'}),/阻断项/);
 assert.throws(()=>h.complete({summary:'摘要',blockingItems:[{criterionId:'s2',reason:'非必达项也提'}]}),/必须提供对应阻断项/);
 h.complete({summary:'汇总摘要',blockingItems:[{criterionId:'s1',reason:'成本约束未满足'}]});
 const report=h.kernel.report(r.runId)!;
 assert.equal(report.majority?.key,'fail');
 assert.deepEqual(report.blockingItems,[{criterionId:'s1',reason:'成本约束未满足'}]);
});

test('research v2: 多数判定不通过且无未满足必达标准时须给出阻断项或下一步',t=>{
 const h=fixture(t),r=h.createV2('jury');
 // 矛盾票型（fail但必达自评满足）：parse允许，聚合须解释失败路径。
 for(let i=0;i<3;i++){h.complete({...h.v2Juror('fail'),criterionEvaluations:[{criterionId:'s1',status:'satisfied',reason:'自评满足'},{criterionId:'s2',status:'satisfied',reason:'y'}]});h.advance(r.runId);}
 assert.throws(()=>h.complete({summary:'仅摘要'}),/阻断项或下一步/);
 h.complete({summary:'汇总摘要',nextSteps:['复核票型后重开研究']});
 assert.ok(h.kernel.report(r.runId)!.nextSteps?.length);
});

test('research v2: 全部标准非必达时，多数不通过仍须给出阻断项或下一步',t=>{
 // P2修复：majorityFail兜底此前嵌在“存在必达标准”分支内——标准全为非必达时三票不通过可交出无解释的报告。
 const h=fixture(t);
 const criteria=[{id:'s1',text:'方案满足成本约束',mustHave:false},{id:'s2',text:'样本证据充分',mustHave:false}];
 const r=h.kernel.create({userId:h.userId,sessionId:'test-session',projectId:h.projectId,mode:'jury',objective:'是否采用方案A',models:h.models,subject:{title:'对象',content:'材料'},criteria,sources:[{title:'原始资料',content:'方案A成本下降10%，但样本只有两组。'}]});
 for(let i=0;i<3;i++){h.complete({...h.v2Juror('fail'),criterionEvaluations:criteria.map(c=>({criterionId:c.id,status:'unmet' as const,reason:'未满足'}))});h.advance(r.runId);}
 assert.throws(()=>h.complete({summary:'仅摘要',claims:[],limitations:[]}),/阻断项或下一步/);
 h.complete({summary:'汇总摘要',claims:[],limitations:[],nextSteps:['补齐证据后重评']});
 assert.ok(h.kernel.report(r.runId)!.nextSteps?.length);
});

test('research v2: 阻断项上限与标准条数同界，9条必达全未满足不再卡死汇总',t=>{
 // 上限修复：标准最多12条而阻断项固定8条，9条必达全未满足时汇总无论怎么提交都被拒（无解死锁）。
 const h=fixture(t);
 const criteria=Array.from({length:9},(_,i)=>({id:`s${i+1}`,text:`标准${i+1}`,mustHave:true}));
 const r=h.kernel.create({userId:h.userId,sessionId:'test-session',projectId:h.projectId,mode:'jury',objective:'是否采用方案A',models:h.models,subject:{title:'对象',content:'材料'},criteria,sources:[{title:'原始资料',content:'方案A成本下降10%，但样本只有两组。'}]});
 for(let i=0;i<3;i++){h.complete({...h.v2Juror('fail'),criterionEvaluations:criteria.map(c=>({criterionId:c.id,status:'unmet' as const,reason:'未满足'}))});h.advance(r.runId);}
 h.complete({summary:'汇总摘要',claims:[],limitations:[],blockingItems:criteria.map(c=>({criterionId:c.id,reason:`${c.text}未满足`}))});
 const report=h.kernel.report(r.runId)!;
 assert.equal(report.blockingItems?.length,9);
 assert.equal(report.majority?.key,'fail');
});

test('research v2: 阻断项不得与锁定判定相反，同一标准不能重复提交',t=>{
 // 一致性收口：报告把阻断项与陪审员判定同屏展开——多数「满足」的标准标阻断=交付自相矛盾；
 // 同一标准重复提交会在报告里保留两条重复项。两者都按交付格式错误拒绝，走修复流程。
 const h=fixture(t),r=h.createV2('jury');
 for(let i=0;i<3;i++){h.complete({...h.v2Juror('pass')});h.advance(r.runId);}
 assert.throws(()=>h.complete({summary:'汇总',claims:[],limitations:[],blockingItems:[{criterionId:'s1',reason:'与满足判定相反的理由'}]}),/不能标为阻断/);
 assert.throws(()=>h.complete({summary:'汇总',claims:[],limitations:[],blockingItems:[{criterionId:'s1',reason:'a'},{criterionId:'s1',reason:'b'}]}),/一条阻断项/);
 h.complete({summary:'汇总摘要',claims:[],limitations:['合成验收']});
 assert.ok(h.kernel.report(r.runId));
 assert.equal(h.kernel.report(r.runId)!.blockingItems,undefined);
});

test('research v2: 复核继承的旧初判不计票，本轮全通过不再被旧票逼回阻断项门禁',t=>{
 // 旧票污染修复：复核run的聚合视图能看到来源run继承的历史初判（participant/phase为空的复制行），
 // 但票数只计本轮陪审员——否则来源轮的fail票会把本轮三票通过的汇总重新逼回阻断项门禁，
 // 填入旧阻断项后报告出现“三票通过+过时阻断项”的自相矛盾。
 const h=fixture(t);
 const source=h.createV2('jury');
 for(let i=0;i<3;i++){h.complete({...h.v2Juror('fail')});h.advance(source.runId);}
 h.complete({summary:'首轮汇总',blockingItems:[{criterionId:'s1',reason:'成本约束未满足'}]});
 const review=h.createV2('jury',{sourceRunId:source.runId});
 assert.ok(h.kernel.records(review.runId).filter(x=>x.kind==='opinion').length>=3,'历史初判已继承进本轮供查阅');
 for(let i=0;i<3;i++){h.complete({...h.v2Juror('pass')});h.advance(review.runId);}
 h.complete({summary:'复核汇总',claims:[],limitations:['复核验收']});
 const report=h.kernel.report(review.runId)!;
 assert.deepEqual(report.tally,{pass:3,conditional_pass:0,fail:0,insufficient:0,abstain:0});
 assert.deepEqual(report.majority,{key:'pass',count:3});
 assert.equal(report.blockingItems,undefined);
});

test('research: 新版任务卡匹配普通Agent读取能力，旧v1提示保持冻结',t=>{
 const h=fixture(t),modern=h.createV2('jury');
 assert.equal((JSON.parse((h.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(modern.runId) as {config_snapshot_json:string}).config_snapshot_json) as {promptVersion:string}).promptVersion,'research-task-card-v1');
 const prompt=h.context().prompt;
 assert.ok(prompt.includes('[研究任务卡 research-task-card-v1]'));
 assert.ok(prompt.includes('独立初判'));
 assert.ok(prompt.includes('read_file'));
 assert.ok(prompt.includes('项目读取结果和图片可用于分析，但目前不生成结构化引证'));
 assert.ok(!prompt.includes('不能读取本地文件'));
 assert.ok(!prompt.includes('只能使用固定研究视图'));
 assert.ok(prompt.includes('criterionEvaluations'));
 assert.ok(prompt.length<20_000,'无大量既有发言时任务卡应保持紧凑');
 const legacy=fixture(t),old=legacy.create('jury');
 assert.equal((JSON.parse((legacy.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(old.runId) as {config_snapshot_json:string}).config_snapshot_json) as {promptVersion:string}).promptVersion,'research-v1');
 assert.ok(legacy.context().prompt.includes('不能读取本地文件'));
});

test('research: 旧分析方法冻结入口保留兼容旧提示，不能静默切到Skill任务卡',t=>{
 const h=fixture(t);h.seedSkill('depth-first','DEPTH-FIRST-BODY');
 const r=h.createV2('debate',{methods:['depth-first']});
 const snapshot=JSON.parse((h.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(r.runId) as {config_snapshot_json:string}).config_snapshot_json) as {promptVersion:string};
 assert.equal(snapshot.promptVersion,'research-v2');
 assert.ok(h.context().prompt.includes('DEPTH-FIRST-BODY'));
});

test('research v2: 通过与有条件通过分别计票，同一判定两票成多数',t=>{
 const h=fixture(t),r=h.createV2('jury');
 h.complete({...h.v2Juror('pass')});h.advance(r.runId);
 h.complete({...h.v2Juror('pass')});h.advance(r.runId);
 h.complete({...h.v2Juror('conditional_pass')});h.advance(r.runId);
 h.complete({summary:'汇总'});
 const report=h.kernel.report(r.runId)!;
 assert.deepEqual(report.tally,{pass:2,conditional_pass:1,fail:0,insufficient:0,abstain:0});
 assert.deepEqual(report.majority,{key:'pass',count:2});
});

test('research v2: 创建校验——评审须带被评对象与标准，决策候选至少两项，标准ID重复拒绝',t=>{
 const h=fixture(t);
 const base={userId:h.userId,sessionId:'test-session',projectId:h.projectId,mode:'jury' as const,objective:'是否采用方案A',models:h.models};
 assert.throws(()=>h.kernel.create(base),/被评对象标题/);
 assert.throws(()=>h.kernel.create({...base,subject:{title:'对象',content:'材料'}}),/评审标准须为1—12项/);
 assert.throws(()=>h.kernel.create({...base,subject:{title:'对象',content:'材料'},criteria:[{id:'s1',text:'a',mustHave:true},{id:'s1',text:'b',mustHave:false}]}),/标准ID重复/);
 assert.throws(()=>h.createV2('debate',{decision:{proposition:'命题',candidates:[{text:'只有一个'}]}}),/2—6项候选/);
 assert.throws(()=>h.kernel.create({...base,mode:'debate',models:h.models,policyVersion:'research-v9'}),/仅支持固定/);
});

test('research v2: 固定v1的run升级后仍按v1语义，v2不能沿用v1票型',t=>{
 const h=fixture(t),v1=h.create('jury');
 h.complete({verdict:'con'});
 assert.equal(h.kernel.policyVersion(v1.runId),'research-v1');
 const v2=h.createV2('jury');
 assert.throws(()=>h.complete({verdict:'con'}),/票型/);
 h.complete({...h.v2Juror('pass')});
});

test('research: 引用文件经授权导入切段入库，越界/软链/二进制/伪造授权同形拒绝',async t=>{
 const h=fixture(t);
 const {mkdirSync,writeFileSync,symlinkSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'prism-grant-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'docs'));
 writeFileSync(join(root,'notes.md'),'方案A在两组样本上成本下降10%。');
 writeFileSync(join(root,'docs/big.md'),'第一段内容\n'.repeat(4000));
 writeFileSync(join(root,'blob.bin'),Buffer.from([0x00,0x01,0x02]));
 writeFileSync(join(root,'empty.txt'),'');
 writeFileSync(join(root,'broken.txt'),Buffer.from([0xff,0xfe,0x01]));
 writeFileSync(join(root,'outside-secret.txt'),'秘密');
 symlinkSync(join(root,'outside-secret.txt'),join(root,'link.md'));
 const time=new Date().toISOString(),grantId=randomUUID();
 h.db.db.prepare('INSERT INTO workspace_grants(id,project_id,canonical_root,access,revision,selected_by,excludes_json,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?,?)').run(grantId,h.projectId,root,'read',h.userId,'["secret"]',time,time);
 const src=(relativePath:string,g=grantId)=>({grantId:g,relativePath});
 // 正常导入：小文件整份入库，长文本按换行切段；重复引用去重
 const imported=await h.kernel.expandSourceFiles(h.projectId,h.userId,[src('notes.md'),src('docs/big.md'),src('docs/big.md')]);
 assert.equal(imported.length,3);
 assert.equal(imported[0]!.title,'notes.md');
 assert.ok(imported[1]!.title.startsWith('big.md (1/2)'));
 assert.ok(imported[2]!.title.startsWith('big.md (2/2)'));
 const r=h.create('debate',{sources:[{title:'粘贴资料',content:'方案A成本下降10%，但样本只有两组。'},...imported]});
 const sources=h.kernel.records(r.runId).filter(x=>x.kind==='source');
 assert.equal(sources.length,4);
 assert.equal(h.kernel.records(r.runId).every(x=>x.kind!=='source'||x.published),true);
 // 越界/绝对路径/软链/excludes：与files模块同形404
 await assert.rejects(h.kernel.expandSourceFiles(h.projectId,h.userId,[src('../outside-secret.txt')]),/对象不存在或无权访问/);
 await assert.rejects(h.kernel.expandSourceFiles(h.projectId,h.userId,[src('/etc/passwd')]),/对象不存在或无权访问/);
 await assert.rejects(h.kernel.expandSourceFiles(h.projectId,h.userId,[src('link.md')]),/对象不存在或无权访问/);
 await assert.rejects(h.kernel.expandSourceFiles(h.projectId,h.userId,[src('secret/x.txt')]),/对象不存在或无权访问/);
 await assert.rejects(h.kernel.expandSourceFiles(h.projectId,h.userId,[src('docs/big.md',randomUUID())]),/对象不存在或无权访问/);
 await assert.rejects(h.kernel.expandSourceFiles(h.projectId,h.userId,[src('docs/missing.md')]),/对象不存在或无权访问/);
 // 二进制/非UTF-8/空文件：明确拒绝
 await assert.rejects(h.kernel.expandSourceFiles(h.projectId,h.userId,[src('blob.bin')]),/二进制/);
 await assert.rejects(h.kernel.expandSourceFiles(h.projectId,h.userId,[src('broken.txt')]),/UTF-8/);
 await assert.rejects(h.kernel.expandSourceFiles(h.projectId,h.userId,[src('empty.txt')]),/没有可用的文本内容/);
 // 文件数与切段总数上限
 await assert.rejects(h.kernel.expandSourceFiles(h.projectId,h.userId,Array.from({length:21},()=>src('notes.md'))),/最多20个/);
 writeFileSync(join(root,'huge-a.txt'),'a'.repeat(500_000));
 writeFileSync(join(root,'huge-b.txt'),'b'.repeat(500_000));
 await assert.rejects(h.kernel.expandSourceFiles(h.projectId,h.userId,[src('huge-a.txt'),src('huge-b.txt')]),/超过32份上限/);
 // 导入+粘贴合计仍受create的32份上限约束
 assert.throws(()=>h.create('debate',{sources:[...Array.from({length:31},(_,i)=>({title:`t${i}`,content:'内容'})),...imported]}),/最多32份/);
});

// —— 运行时复用普通Agent能力：能力快照与显式附件冻结（隔离验收 B/C 层） ——

test('research: 新建run冻结ordinaryTools与显式附件元数据，固定v1与旧run保持受限视图',t=>{
 const h=fixture(t);
 // PNG魔数最小缓冲：只走魔数嗅探，不要求完整图片结构
 const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.alloc(16,0x7f)]);
 const att=saveAttachment(h.db,h.dir,h.userId,'证据截图.png',png);
 const base64=png.toString('base64');
 // 新建run（v2）：ordinaryTools=true + researchAttachments只冻结元数据；携带图片须全角色视觉（创建前预检）
 h.setVision(true);
 const r=h.createV2('jury',{attachmentIds:[att.id]});
 const caps=h.capsOf(r.runId)!;
 assert.equal(caps.ordinaryTools,true);
 const snap=JSON.parse((h.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(r.runId) as {config_snapshot_json:string}).config_snapshot_json) as {researchAttachments?:Array<{id:string;mime:string;sizeBytes:number;sha256:string;displayName:string}>};
 assert.deepEqual(snap.researchAttachments,[{id:att.id,mime:'image/png',sizeBytes:att.size_bytes,sha256:att.sha256,displayName:'证据截图.png'}]);
 assert.ok(!JSON.stringify(snap).includes(base64.slice(0,32)),'附件base64不得进入runs.config_snapshot_json');
 assert.deepEqual(h.kernel.attachmentsForRun(r.runId).map(a=>a.id),[att.id]);
 assert.deepEqual(h.kernel.ordinaryToolsForRun(r.runId),['read_file','read_image','list_dir','grep_files']);
 // 附件不产生研究记录、base64不落research_records（资料source记录照常入库）
 const kinds=(h.db.db.prepare('SELECT DISTINCT kind FROM research_records WHERE run_id=?').all(r.runId) as Array<{kind:string}>).map(x=>x.kind);
 assert.ok(!kinds.includes('attachment'));
 assert.ok(!JSON.stringify(h.db.db.prepare('SELECT content FROM research_records WHERE run_id=?').all(r.runId)).includes(base64.slice(0,32)));
 // 显式固定v1的受控回归run：无ordinaryTools键（旧受限视图），附件机制同样不生效
 const old=h.create('debate',{policyVersion:'research-v1'});
 assert.equal(h.capsOf(old.runId)?.ordinaryTools,undefined);
 assert.deepEqual(h.kernel.ordinaryToolsForRun(old.runId),[]);
 // 旧run模拟（无ordinaryTools快照键）：ordinaryToolsForRun回落空清单
 const stripped=h.createV2('debate');
 const snap2=JSON.parse((h.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(stripped.runId) as {config_snapshot_json:string}).config_snapshot_json) as {researchCapabilities?:{ordinaryTools?:boolean}};
 delete snap2.researchCapabilities!.ordinaryTools;
 h.db.db.prepare('UPDATE runs SET config_snapshot_json=? WHERE id=?').run(JSON.stringify(snap2),stripped.runId);
 assert.deepEqual(h.kernel.ordinaryToolsForRun(stripped.runId),[]);
});

test('research: 显式附件边界——归属/缺失/重复/超限整体拒绝',t=>{
 const h=fixture(t);
 const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.alloc(16,0x7f)]);
 const mine=saveAttachment(h.db,h.dir,h.userId,'a.png',png);
 const time=new Date().toISOString();
 const otherId=randomUUID();
 h.db.db.prepare("INSERT INTO users(id,username,password_hash,password_salt,password_params_json,created_at,updated_at) VALUES (?,?,'x','s','{}',?,?)").run(otherId,randomUUID(),time,time);
 const foreign=saveAttachment(h.db,h.dir,otherId,'b.png',png);
 // 他人附件/不存在/重复/超限：整体拒绝（不静默丢弃）
 assert.throws(()=>h.createV2('debate',{attachmentIds:[foreign.id]}),/附件不存在或无权访问/);
 assert.throws(()=>h.createV2('debate',{attachmentIds:[randomUUID()]}),/附件不存在或无权访问/);
 assert.throws(()=>h.createV2('debate',{attachmentIds:[mine.id,mine.id]}),/附件重复/);
 assert.throws(()=>h.createV2('debate',{attachmentIds:Array.from({length:11},()=>mine.id)}),/最多携带10张图片/);
 // 契约红线：拒绝路径不留下半成品run
 assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM runs').get()!.n,0);
});

test('research: 显式附件创建前预检——任一角色非视觉即整体拒绝，不建run不发请求',t=>{
 const h=fixture(t);
 const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.alloc(16,0x7f)]);
 const att=saveAttachment(h.db,h.dir,h.userId,'证据截图.png',png);
 // 场景一：全部角色共用非视觉模型——创建阶段整体拒绝并点名全部角色；
 // 不建run/研究run/阶段/事件，自然也不可能有任何模型请求（launch从未发生）
 assert.throws(()=>h.createV2('debate',{attachmentIds:[att.id]}),/不支持图片输入：pro、con、host/);
 assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM runs').get()!.n,0);
 assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM research_runs').get()!.n,0);
 assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM phase_tasks').get()!.n,0);
 assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM run_events').get()!.n,0);
 // 场景二：逐角色混配（pro/con视觉、host非视觉）——错误只点名实际非视觉的角色
 const vision=()=>({modelConfigId:h.registerModel(true),modelId:'test'});
 const blind=()=>({modelConfigId:h.registerModel(false),modelId:'test'});
 assert.throws(()=>h.createV2('debate',{attachmentIds:[att.id],models:{pro:vision(),con:vision(),host:blind()}}),/不支持图片输入：host；请为这些角色/);
 assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM runs').get()!.n,0);
 // 场景三：全部角色视觉——创建成功，run进入正常流程（首个阶段已launch）
 h.setVision(true);
 const r=h.createV2('debate',{attachmentIds:[att.id]});
 assert.equal(h.db.db.prepare('SELECT status FROM runs WHERE id=?').get(r.runId)!.status,'running');
 // 固定v1的受控run不装载附件：维持旧语义，不做创建前预检（非视觉模型+附件仍可创建）
 const old=h.create('debate',{attachmentIds:[att.id],policyVersion:'research-v1'});
 assert.equal(h.capsOf(old.runId)?.ordinaryTools,undefined);
 assert.deepEqual(h.kernel.ordinaryToolsForRun(old.runId),[]);
 // 无附件的非视觉模型研究不受预检影响（预检只在携带图片时生效）
 const noAttach=h.createV2('debate');
 assert.equal(h.capsOf(noAttach.runId)?.ordinaryTools,true);
});

test('research: 显式附件phase启动按冻结元数据核验——篡改/丢失明确失败不使用',async t=>{
 const {loadFrozenAttachmentImages}=await import('../src/agent/attachments.js');
 const {readFileSync,writeFileSync,unlinkSync}=await import('node:fs');
 const h=fixture(t);
 const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.alloc(16,0x7f)]);
 const att=saveAttachment(h.db,h.dir,h.userId,'证据截图.png',png);
 h.setVision(true);
 const r=h.createV2('jury',{attachmentIds:[att.id]});
 const frozen=h.kernel.attachmentsForRun(r.runId)[0]!;
 // 正常：字节未动——按冻结元数据装载成功
 const images=loadFrozenAttachmentImages(h.db,h.userId,h.kernel.attachmentsForRun(r.runId));
 assert.equal(images.length,1);
 assert.equal(images[0]!.mimeType,'image/png');
 // 篡改：修改附件文件字节——hash不符明确失败，不使用被改动的图片
 const internal=(h.db.db.prepare('SELECT internal_path FROM attachments WHERE id=?').get(att.id) as {internal_path:string}).internal_path;
 const original=readFileSync(internal);
 writeFileSync(internal,Buffer.concat([original,Buffer.from([0x01])]));
 assert.throws(()=>loadFrozenAttachmentImages(h.db,h.userId,[frozen]),/内容与发起研究时不一致/);
 // 丢失：删除附件文件——明确失败
 writeFileSync(internal,original);
 unlinkSync(internal);
 assert.throws(()=>loadFrozenAttachmentImages(h.db,h.userId,[frozen]),/附件文件已丢失/);
 // 契约红线：核验失败的run没有被静默降级为无附件运行——附件元数据仍在快照中
 assert.equal(h.kernel.attachmentsForRun(r.runId).length,1);
});

test('research v2: 运行中异议逐条回应、幂等复用与目标变更冲突',t=>{
 const h=fixture(t),r=h.createV2('debate');
 h.complete();h.advance(r.runId);h.complete();h.advance(r.runId);
 const claims=h.kernel.records(r.runId).filter(x=>x.kind==='statement'&&x.published).flatMap(x=>(JSON.parse(x.content) as {claims:Array<{id:string}>}).claims);
 const claimId=claims[0]!.id;
 // 结论异议须等报告；未知主张与非法目标同形拒绝
 assert.throws(()=>h.kernel.supplement(r.runId,'整份结论不成立','m0',{type:'conclusion'}),/复核发起/);
 assert.throws(()=>h.kernel.supplement(r.runId,'指向未发布主张','m0',{type:'claim',claimId:'missing-phase:c1'}),/已发布的主张/);
 assert.throws(()=>h.kernel.supplement(r.runId,'目标结构错误','m0',{type:'bogus'}),/异议目标/);
 // 合法异议：服务端创建研究记录ID作为objectionId，同id同文同目标幂等复用，目标变更冲突
 const first=h.kernel.supplement(r.runId,'样本口径不同意：试点只有两组','m1',{type:'claim',claimId})!;
 assert.ok(first.objectionId);
 assert.equal(h.kernel.supplement(r.runId,'样本口径不同意：试点只有两组','m1',{type:'claim',claimId}).duplicate,true);
 assert.throws(()=>h.kernel.supplement(r.runId,'样本口径不同意：试点只有两组','m1',{type:'claim',claimId:claims[claims.length-1]!.id}),/不同内容或目标/);
 const record=h.kernel.records(r.runId).find(x=>x.id===first.objectionId)!;
 assert.deepEqual((JSON.parse(record.content) as {target:{type:string;claimId:string}}).target,{type:'claim',claimId});
 // 普通补充（无目标）不受异议语义影响
 h.kernel.supplement(r.runId,'请补充财务台账口径说明',null);
 // 主持漏答异议被拒；逐条回应后通过并组装进报告
 h.complete();h.advance(r.runId);h.complete();h.advance(r.runId);
 assert.throws(()=>h.complete({summary:'主持汇总'}),/逐条回应/);
 h.complete({summary:'主持汇总',objectionResponses:[{objectionId:first.objectionId!,resolution:'partial',reason:'口径按财务台账为准；样本限制成立'}]});
 const report=h.kernel.report(r.runId)!;
 assert.equal(report.objections?.length,1);
 assert.equal(report.objections?.[0]?.target.type,'claim');
 assert.equal(report.objections?.[0]?.responses[0]?.resolution,'partial');
 assert.equal(report.objections?.[0]?.responses[0]?.responder,'host');
 assert.ok(h.db.db.prepare("SELECT 1 FROM run_events WHERE run_id=? AND type='research.objection'").get(r.runId));
});

test('research v2: 陪审复核继承辩论或陪审来源，终态异议进入新run且初判隔离',t=>{
 const h=fixture(t);
 // 来源一：辩论（成功出报告）——辩论来源可复核；v2主持必须带摘要
 const debate=h.createV2('debate');
 for(let i=0;i<4;i++){h.complete();h.advance(debate.runId);}
 h.complete({summary:'主持汇总'});
 const debateConclusionObjection=h.createV2('jury',{sourceRunId:debate.runId,objections:[{target:{type:'conclusion'},text:'结论低估了样本限制'}]});
 assert.equal(h.kernel.records(debateConclusionObjection.runId).filter(x=>x.kind==='objection').length,1);
 // 来源二：陪审——主张异议取其锁定初判的claims
 const source=h.createV2('jury');
 const originalSource=h.kernel.records(source.runId).find(record=>record.kind==='source')!;
 for(let i=0;i<3;i++){h.complete({...h.v2Juror('pass')});h.advance(source.runId);}
 const originalSummary=`原汇总含资料编号 ${originalSource.id}`;
 h.complete({summary:originalSummary});
 const opinionClaim=(h.kernel.records(source.runId).find(x=>x.kind==='opinion'&&x.published)!) && (JSON.parse(h.kernel.records(source.runId).find(x=>x.kind==='opinion'&&x.published)!.content) as {claims:Array<{id:string}>}).claims[0]!.id;
 // 校验：议题不一致/异议无来源/未知主张/结论异议要求报告——同形拒绝
 assert.throws(()=>h.createV2('jury',{sourceRunId:source.runId,objective:'换了议题',objections:[{target:{type:'conclusion'},text:'x'}]}),/议题保持一致/);
 assert.throws(()=>h.createV2('jury',{objections:[{target:{type:'conclusion'},text:'x'}]}),/随复核创建/);
 assert.throws(()=>h.createV2('jury',{sourceRunId:source.runId,objections:[{target:{type:'claim',claimId:'no:c1'},text:'x'}]}),/已发布主张/);
 // 复核创建：陪审来源+终态异议（主张+结论）
 const review=h.createV2('jury',{sourceRunId:source.runId,objections:[{target:{type:'claim',claimId:opinionClaim},text:'该初判的证据不足以支撑通过'},{target:{type:'conclusion'},text:'结论低估了样本限制'}]});
 const objections=h.kernel.records(review.runId).filter(x=>x.kind==='objection');
 const inheritedVerdict=h.kernel.records(review.runId).find(x=>x.kind==='verdict')!;
 assert.equal(JSON.parse(inheritedVerdict.content).summary,originalSummary);
 assert.equal(objections.length,2);
 assert.deepEqual(objections.map(x=>(JSON.parse(x.content) as {target:{type:string}}).target.type),['claim','conclusion']);
 assert.equal(objections.every(x=>x.published),true);
 // 初判隔离：陪审员视图无异议/初判/汇总记录；汇总视图含异议且须逐条回应
 h.complete({...h.v2Juror('insufficient')});h.advance(review.runId);
 const jurorVisible=h.kernel.visible(h.attempt());
 assert.equal(jurorVisible.some(x=>['objection','opinion','verdict','host'].includes(x.kind)),false);
 assert.ok(jurorVisible.some(x=>x.kind==='source'));
 for(let i=0;i<2;i++){h.complete({...h.v2Juror('insufficient')});h.advance(review.runId);}
 const aggregate=h.kernel.visible(h.attempt());
 assert.equal(aggregate.filter(x=>x.kind==='objection').length,2);
 assert.ok(h.kernel.context(h.attempt())!.prompt.includes('用户异议'));
 // J2修复后：复核陪审对必达标准多数「证据不足」，聚合须先提供对应阻断项，才轮到异议逐条回应校验。
 assert.throws(()=>h.complete({summary:'复核汇总'}),/必须提供对应阻断项/);
 assert.throws(()=>h.complete({summary:'复核汇总',blockingItems:[{criterionId:'s1',reason:'复核证据不足，须补齐台账样本'}]}),/逐条回应/);
 const ids=objections.map(x=>x.id);
 h.complete({summary:'复核汇总',blockingItems:[{criterionId:'s1',reason:'复核证据不足，须补齐台账样本'}],objectionResponses:[{objectionId:ids[0]!,resolution:'accepted',reason:'样本证据确实不足'},{objectionId:ids[1]!,resolution:'rejected',reason:'结论已写明限制'}]});
 const report=h.kernel.report(review.runId)!;
 assert.deepEqual(report.objections?.map(o=>o.responses[0]?.responder),['aggregate','aggregate']);
 // 继承按字节保留来源资料；记录引用（异议回应的objectionId）指向新run记录
 assert.ok(h.kernel.records(review.runId).filter(x=>x.kind==='source').some(x=>x.content.includes('方案A成本下降10%')));
});

test('research: 汇总视野优先装载异议目录，超预算降级保留必答ID',()=>{
 const objection=(id:string,text:string):import('../contracts/research.js').ResearchRecord=>({id,kind:'objection',participantId:null,phaseTaskId:null,title:'用户异议',content:JSON.stringify({target:{type:'conclusion'},text}),hash:'h',url:null,truncated:false,published:true});
 const source=(id:string,content:string):import('../contracts/research.js').ResearchRecord=>({id,kind:'source',participantId:null,phaseTaskId:null,title:'资料',content,hash:'h',url:null,truncated:false,published:true});
 const long='证'.repeat(5000);
 const records=[source('s1',long),source('s2',long),source('s3',long),objection('o1','异议一'),objection('o2','异议二')];
 const out=researchPromptRecords(records,600);
 const byId=new Map(out.records.map(r=>[(r as {id:string}).id,r] as const));
 // 异议排最前并完整在场；超预算的其余记录被略过
 assert.equal(byId.has('o1'),true);assert.equal(byId.has('o2'),true);
 assert.equal((byId.get('o1') as {content:string}).content,'{"target":{"type":"conclusion"},"text":"异议一"}');
 assert.ok(out.indexedRecords<records.length);
 // 极小预算：异议条目降级为仅元数据也保留必答ID（正文经分页阅读取回）
 const tiny=new Map(researchPromptRecords(records,60).records.map(r=>[(r as {id:string}).id,r] as const));
 assert.equal((tiny.get('o1') as {content:string}).content,'');
 assert.equal(tiny.has('s1'),false);
 // 预算充足时异议排最前
 const wide=researchPromptRecords(records,100_000);
 assert.equal((wide.records[0] as {id:string}).id,'o1');
});

// ===== 能力扩展（设置归还自由度）：发起时冻结，MCP显式opt-in，方法/记忆为私有正文 =====

test('research: 默认预算列240/480与capabilities冻结；缺省无私有正文',t=>{
 const h=fixture(t),r=h.create();
 const row=h.runsRow(r.runId);
 assert.equal(row.model_request_limit,240);assert.equal(row.tool_request_limit,480);assert.equal(row.private_json,null);
 const caps=h.capsOf(r.runId)!;
 assert.equal(caps.assemblyVersion,2);assert.equal(caps.hostVerify,true);assert.equal(caps.memory,false);
 assert.deepEqual(caps.methods,[]);assert.deepEqual(caps.mcpTools,[]);
});

test('research: 设置改动冻结进新run（预算列/能力位），在途run沿用发起时刻',t=>{
 const h=fixture(t);
 const first=h.create();
 h.putSettings({researchModelRequestLimit:40,researchToolRequestLimit:60,researchHostVerify:false,researchMcpTools:false,researchSkillMethods:false,researchMemory:false});
 const second=h.create();
 assert.equal(h.runsRow(first.runId).model_request_limit,240);
 assert.equal(h.runsRow(second.runId).model_request_limit,40);
 assert.equal(h.runsRow(second.runId).tool_request_limit,60);
 const caps=h.capsOf(second.runId)!;
 assert.equal(caps.hostVerify,false);
 // 设置关闭时显式带 methods/mcpToolIds 创建 → 拒绝
 assert.throws(()=>h.create('debate',{methods:['nope']}),/已在设置中关闭/);
 assert.throws(()=>h.create('debate',{mcpToolIds:['mcp__a__b']}),/已在设置中关闭/);
});

test('research: 分析方法冻结——正文进private_json、hash对下发文本、prompt含注入行；缺名与超量拒绝',t=>{
 const h=fixture(t);
 h.seedSkill('depth-first','DEPTH-FIRST-BODY\n先查全目录再读正文');
 const r=h.create('debate',{methods:['depth-first']});
 const row=h.runsRow(r.runId);
 const priv=JSON.parse(row.private_json!) as {methods:Array<{name:string;content:string}>;memoryIndex:string|null};
 assert.equal(priv.methods.length,1);assert.equal(priv.methods[0]!.name,'depth-first');
 assert.ok(priv.methods[0]!.content.includes('DEPTH-FIRST-BODY'));
 const caps=h.capsOf(r.runId)!;
 assert.equal(caps.methods.length,1);
 assert.equal(caps.methods[0]!.sha256,createHash('sha256').update(priv.methods[0]!.content).digest('hex'));
 assert.deepEqual(priv.memoryIndex,null);
 // prompt含方法注入行（先complete再读prompt前需重跑：context在初稿阶段直接可读）
 assert.ok(h.context().prompt.includes('【分析方法：depth-first】'));
 assert.ok(h.context().prompt.includes('DEPTH-FIRST-BODY'));
 assert.ok(h.context().prompt.includes('不是证据'));
 // 未知技能名 / 超3项 拒绝
 assert.throws(()=>h.create('debate',{methods:['不存在']}),/不可用或未启用/);
 h.seedSkill('m1','a');h.seedSkill('m2','b');h.seedSkill('m3','c');
 assert.throws(()=>h.create('debate',{methods:['m1','m2','m3','depth-first']}),/最多3项/);
});

test('research: 超长方法正文有界读截断+sha对截断后文本；哨兵——快照/inspect不泄漏正文',t=>{
 const h=fixture(t);
 h.seedSkill('long-method','LONGBODY-'.repeat(2000)); // 18000字符 > 8000
 const r=h.create('debate',{methods:['long-method']});
 const priv=JSON.parse(h.runsRow(r.runId).private_json!) as {methods:Array<{name:string;content:string}>};
 const content=priv.methods[0]!.content;
 assert.ok(content.length<=8100);assert.ok(content.includes('已被截断'));
 assert.equal(h.capsOf(r.runId)!.methods[0]!.chars,content.length);
 // 私有正文只住在 research_runs.private_json：runs快照与inspect/export投影均不得含正文标记
 const snapshot=(h.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(r.runId) as {config_snapshot_json:string}).config_snapshot_json;
 assert.ok(!snapshot.includes('LONGBODY-'));
 assert.ok(!JSON.stringify(h.kernel.inspect(r.runId)).includes('LONGBODY-'));
 assert.ok(h.runsRow(r.runId).private_json!.includes('LONGBODY-'));
});

test('research: 记忆索引随memoryIndex钩子注入（正文只进private_json；缺失省略；设置关闭不下发）',t=>{
 const h=fixture(t,{memoryIndex:()=>'MEMINDEX-BODY'});
 const r=h.create();
 assert.equal(h.capsOf(r.runId)!.memory,true);
 assert.equal((JSON.parse(h.runsRow(r.runId).private_json!) as {memoryIndex:string}).memoryIndex,'MEMINDEX-BODY');
 assert.ok(h.context().prompt.includes('MEMINDEX-BODY'));
 assert.ok(h.context().prompt.includes('【项目记忆索引】'));
 // 无钩子：显式省略不阻塞
 const h2=fixture(t);
 const r2=h2.create();
 assert.equal(h2.capsOf(r2.runId)!.memory,false);assert.equal(h2.runsRow(r2.runId).private_json,null);
 // 设置关闭：钩子存在也不注入
 h.putSettings({researchMemory:false});
 const h3=fixture(t,{memoryIndex:()=>'SHOULD-NOT-INJECT'});
 h3.putSettings({researchMemory:false});
 const r3=h3.create();
 assert.equal(h3.capsOf(r3.runId)!.memory,false);assert.equal(h3.runsRow(r3.runId).private_json,null);
});

test('research: MCP显式opt-in——勾选子集冻结进manifest；hint=false不可选；dispatch注桩落source；isError不归档',async t=>{
 const h=fixture(t);
 const tool=h.seedMcpTool('read_table',true);
 const hidden=h.seedMcpTool('write_row',false); // 非只读声明：不在候选
 const r=h.create('debate',{mcpToolIds:[tool.qualifiedName]});
 const caps=h.capsOf(r.runId)!;
 assert.equal(caps.mcpTools.length,1);
 assert.equal(caps.mcpTools[0]!.qualifiedName,tool.qualifiedName);
 assert.ok(caps.mcpTools[0]!.bindingHash);
 // mcpToolsForRun 与 dispatch 同一清单（supervisor boot.mcpTools 数据源）
 assert.deepEqual(h.kernel.mcpToolsForRun(r.runId).map(x=>x.qualifiedName),[tool.qualifiedName]);
 // hint=false 的工具不在候选：勾选直接拒绝
 assert.throws(()=>h.create('debate',{mcpToolIds:[hidden.qualifiedName]}),/不可选/);
 // 未知工具拒绝
 assert.throws(()=>h.create('debate',{mcpToolIds:['mcp__ghost__nope']}),/不可选/);
 // dispatch：注桩返回文本 → 归档为source（I/O后复查；预算照走checkBudget）
 h.kernel.mcpExecutor=async()=>({content:[{type:'text',text:'MCPTOOLBODY'}]});
 const result=await h.kernel.tool(h.attempt(),tool.qualifiedName,{},h.userId) as {sourceId:string;title:string};
 assert.equal(result.title,'MCP · 库存库/read_table');
 const archived=h.kernel.records(r.runId).find(x=>x.id===result.sourceId)!;
 assert.equal(archived.kind,'source');assert.equal(archived.content,'MCPTOOLBODY');
 // isError=true 或无文本：PROVIDER_ERROR 且不落source
 h.kernel.mcpExecutor=async()=>({content:[{type:'text',text:'boom'}],isError:true});
 await assert.rejects(h.kernel.tool(h.attempt(),tool.qualifiedName,{},h.userId),/未归档/);
 h.kernel.mcpExecutor=async()=>({content:[{type:'image',data:'x'}]});
 await assert.rejects(h.kernel.tool(h.attempt(),tool.qualifiedName,{},h.userId),/未归档/);
 // 夹具自带1条原始资料 + 仅MCP成功路径归档的1条 = 2；两次失败均未落source
 assert.equal(h.kernel.records(r.runId).filter(x=>x.kind==='source').length,2);
 assert.equal(h.kernel.records(r.runId).filter(x=>x.content==='MCPTOOLBODY').length,1);
});

test('research: verify_source——视图门禁、无网址拒绝、不可达unavailable、比对纯函数matched/changed',async t=>{
 const h=fixture(t);
 const r=h.create('debate',{sources:[{title:'原始资料',content:'方案A成本下降10%，但样本只有两组。'},{title:'网页资料',content:'线上原始内容',url:'https://example.invalid/page'}]});
 // hostVerify 默认开：host 阶段视图含 verify_source；pro/con/juror 不含
 // debate rounds=1：opening pro/con + round1 pro/con，第5阶段才是host
 for(let i=0;i<4;i++){h.complete();h.advance(r.runId);}
 const host=h.context();
 assert.equal(host.phase.role,'host');
 assert.ok(host.view.tools.includes('verify_source'));
 // 不可达来源：DNS/网络失败 → unavailable（不产证据、不新建source）
 // 不可达来源：DNS/网络失败 → unavailable（不产证据、不新建source）
 const source=h.kernel.records(r.runId).find(x=>x.kind==='source'&&x.url)!;
 const verdict=await h.kernel.tool(h.attempt(),'verify_source',{sourceId:source.id},h.userId) as {status:string};
 assert.equal(verdict.status,'unavailable');
 // 非视图记录/非source拒绝；无url拒绝
 await assert.rejects(h.kernel.tool(h.attempt(),'verify_source',{sourceId:'nope'},h.userId),/资料记录/);
 await assert.rejects(h.kernel.tool(h.attempt(),'verify_source',{sourceId:h.kernel.records(r.runId).find(x=>x.kind==='statement')!.id},h.userId),/资料记录/);
 // pro阶段无该工具
 const h2=fixture(t);h2.create();
 await assert.rejects(h2.kernel.tool(h2.attempt(),'verify_source',{sourceId:'x'},h2.userId),/允许范围/);
 // 比对纯函数：空白归一后全量正文定位——完整正文仍在判matched，任何位置改动判changed
 assert.equal(verifySourceVerdict('方案A成本下降10%，  样本只有两组。','前言\n方案A成本下降10%， 样本只有两组。\n后记'),'matched');
 assert.equal(verifySourceVerdict('方案A成本下降10%，样本只有两组。','页面已改版，内容完全不同'),'changed');
 // 修前缀误报：开头200字保持一致、被引内容被改，旧实现（只比前200字符）误判matched
 const head='方案A成本下降10%，样本规模有限，'.repeat(20);
 assert.equal(verifySourceVerdict(`${head}被引内容：100万元、已获批。`,`${head}被引内容：900万元、已撤销。`),'changed');
});

test('research: 装配v2纯函数——240k顶/未知窗口保守/1200预览/url元数据；v1门控旧值不变',t=>{
 // 大窗口：v2 cap 240k（显式传cap）；未知窗口保持96k-4k；v1门控cap=96k
 assert.equal(researchContextChars(1_000_000,16_384),240_000);
 assert.equal(researchContextChars(1_000_000,16_384,96_000),96_000);
 assert.equal(researchContextChars(null,4_096),92_000);
 assert.equal(researchContextChars(8_192,1_024),0);
 // v2预览1200与url元数据；v1默认240与无url
 const record:import('../contracts/research.js').ResearchRecord={id:'r1',kind:'source',participantId:null,phaseTaskId:null,title:'网页',content:'X'.repeat(2000),hash:'h',url:'https://example.com/a',truncated:true,published:true};
 const v2=researchPromptRecords([record],50_000,{previewChars:1200,includeUrl:true}).records[0] as {content:string;url?:string;contentTruncated:boolean};
 assert.equal(v2.content.length,1200);assert.equal(v2.url,'https://example.com/a');assert.equal(v2.contentTruncated,true);
 const v1=researchPromptRecords([record],50_000).records[0] as {content:string;url?:string};
 assert.equal(v1.content.length,240);assert.equal('url' in v1,false);
 // 越界previewChars被夹到0—8000
 const clamped=researchPromptRecords([record],50_000,{previewChars:999_999}).records[0] as {content:string};
 assert.equal(clamped.content.length,2000);
});

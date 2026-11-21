import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:https';
import Fastify from 'fastify';
import {Db} from '../src/storage/db.js';
import {migrate,defaultMigrationsDir} from '../src/storage/migrate.js';
import {ProviderMeasurement,contextMeasurement} from '../src/agent/contextMeasurement.js';
import {ModelRequestRegistry} from '../src/agent/modelRequests.js';
import {projectUsage,usageRequests} from '../src/agent/usageProjection.js';
import {ModelGatewayServer,PrivateThinkingCache,type FrozenModelBinding} from '../src/agent/gatewayServer.js';
import {parseChatRequest,encodeSseFromEvents} from '../src/agent/protocolAdapter.js';
import type {AssistantMessage} from '@earendil-works/pi-ai';
import {TicketRegistry} from '../src/agent/tickets.js';
import {RUNTIME_STREAM_PROFILE} from '../src/models/streamNetwork.js';
import {registerRunRoutes} from '../src/agent/runRoutes.js';
import type {Supervisor} from '../src/agent/supervisor.js';

function harness(t:{after(fn:()=>unknown):unknown}){
 const dir=mkdtempSync(join(tmpdir(),'usage-provenance-')),db=new Db(join(dir,'test.sqlite'));
 migrate(db,defaultMigrationsDir());
 db.db.exec(`INSERT INTO users(id,username,password_hash,password_salt,password_params_json,created_at,updated_at) VALUES ('u','test','x','x','{}','t','t');
 INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES ('p','u','test','t','t');
 INSERT INTO conversations(id,project_id,mode,title,created_at,updated_at) VALUES ('c','p','ordinary','test','t','t');
 INSERT INTO problem_versions(id,conversation_id,version,objective,created_at,updated_at) VALUES ('pv','c',1,'test','t','t');
 INSERT INTO model_configs(id,owner_user_id,preset,name,base_url,created_at,updated_at) VALUES ('mc','u','custom','test','https://127.0.0.1','t','t');
 INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,config_snapshot_json,created_at,updated_at) VALUES ('r','p','c','pv','ordinary','succeeded','{"contextWindow":8192}','t','t');
 INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,config_snapshot_json,created_at,updated_at) VALUES ('r2','p','c','pv','ordinary','running','{"contextWindow":8192}','u','u');
 INSERT INTO agent_bindings(id,run_id,role_id,model_config_id,model_id,created_at,updated_at) VALUES ('b','r2','ordinary','mc','test-model','t','t');
 INSERT INTO phase_tasks(id,run_id,agent_binding_id,phase_key,status,created_at,updated_at) VALUES ('pt','r2','b','main','running','t','t');
 INSERT INTO attempts(id,phase_task_id,number,status,created_at,updated_at) VALUES ('a','pt',1,'running','t','t');`);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const registry=new ModelRequestRegistry(db,()=>false);
 const insert=(id:string,run='r2')=>db.db.prepare(`INSERT INTO model_requests(id,reservation_id,run_id,attempt_id,request_kind,body_hash,provider,model,state,created_at,started_at,updated_at,context_window,reserve_output_tokens) VALUES (?,?,?,'a','main','h','provider','test-model','started',?,?,?,8192,2048)`).run(id,id,run,id,'2026-01-01T00:00:00.000Z',id);
 return {db,dir,registry,insert};
}
const timing={startedAt:'2026-01-01T00:00:00.000Z',firstChunkAt:'2026-01-01T00:00:00.050Z',firstGenerationDeltaAt:'2026-01-01T00:00:00.100Z',firstTextAt:null,firstToolDeltaAt:null,completedAt:'2026-01-01T00:00:01.100Z',ttftMs:100,firstTextMs:null};
const usage={input:70,output:20,cacheRead:20,cacheWrite:10,reasoning:5,totalInput:100};

test('private thinking hooks roundtrip opaque capability, reject forgery/cross-attempt/model and clear',async()=>{
 const cache=new PrivateThinkingCache();
 const binding:FrozenModelBinding={configId:'c',sessionRef:'synthetic',baseUrl:'https://example.invalid',providerPreset:'custom',modelId:'m',protocol:'anthropic-messages',contextWindow:8192,maxOutputTokens:512,configRevision:1};
 const final:AssistantMessage={role:'assistant',content:[{type:'thinking',thinking:'private',thinkingSignature:'provider-signature'},{type:'text',text:'public'}],api:'anthropic-messages',provider:'prism-gateway',model:'m',timestamp:1,stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
 async function* events(){yield {type:'done' as const,reason:'stop' as const,message:final};}
 const text=await new Response(encodeSseFromEvents(events(),'r','m',1,{encodePrivateThinking:m=>cache.encode('a',binding,m)})).text();
 assert.ok(!text.includes('provider-signature'));assert.ok(!text.includes('"private"'));
 const frames=text.split('\n\n').filter(x=>x.startsWith('data: {')).map(x=>JSON.parse(x.slice(6)));
 const details=frames.flatMap(x=>x.choices??[]).map(x=>x.delta?.reasoning_details).find(Boolean);
 assert.ok(details);
 const parsed=parseChatRequest({model:'m',messages:[{role:'assistant',content:'public',reasoning_details:details}]},{decodePrivateThinking:d=>cache.decode('a',binding,d)});
 const assistant=parsed.messages[0] as AssistantMessage;assert.deepEqual(assistant.content[0],final.content[0]);
 assert.throws(()=>cache.decode('b',binding,details),/无效/);assert.throws(()=>cache.decode('a',{...binding,modelId:'another'},details),/无效/);
 assert.throws(()=>cache.decode('a',binding,[{type:'reasoning.encrypted',format:'prism-private-v1',data:'forged'}]),/无效/);
 cache.clearAttempt('a');assert.throws(()=>cache.decode('a',binding,details),/过期/);assert.deepEqual(cache.attemptIds(),[]);
 const other=cache.encode('a',binding,final);cache.clear();assert.throws(()=>cache.decode('a',binding,other),/过期/);
});

test('compact POST queues through supervisor with owner boundary and HTTP 202',async t=>{
 const h=harness(t);const app=Fastify();let call:string[]=[];
 const supervisor={compactRun:(runId:string,userId:string)=>{call=[runId,userId];return {accepted:true,queued:true,duplicate:false};}} as unknown as Supervisor;
 registerRunRoutes(app,{db:h.db,dataDir:h.dir,supervisor},()=>({userId:'u'}));t.after(()=>app.close());
 const res=await app.inject({method:'POST',url:'/api/v1/runs/r2/compact'});assert.equal(res.statusCode,202);assert.deepEqual(call,['r2','u']);assert.equal(res.json().data.queued,true);
 call=[];const denied=await app.inject({method:'POST',url:'/api/v1/runs/foreign/compact'});assert.notEqual(denied.statusCode,202);assert.deepEqual(call,[]);
});

test('Activity counts conversation runs and dispatched steps; kind summaries and unknown timings are not paginated',t=>{
 const h=harness(t);h.insert('main');h.insert('compact');h.insert('repair');h.insert('pending');
 h.db.db.prepare("UPDATE model_requests SET request_kind='compaction' WHERE id='compact'").run();
 h.db.db.prepare("UPDATE model_requests SET request_kind='repair' WHERE id='repair'").run();
 for(const id of ['main','compact','repair'])h.registry.finish(id,'completed',null,{usageSource:'provider',usage,timing});
 h.db.db.exec(`INSERT INTO tool_invocations(id,run_id,phase_task_id,attempt_id,call_key,tool_name,tool_version,args_hash,state,created_at,updated_at) VALUES ('tool','r2','pt','a','call','read_file','1','h','succeeded','t','t');
 INSERT INTO tool_invocations(id,run_id,phase_task_id,attempt_id,call_key,tool_name,tool_version,args_hash,state,created_at,updated_at) VALUES ('unknown','r2','pt','a','call2','read_file','1','h','claimed','t','t');
 INSERT INTO run_events(run_id,seq,event_id,type,occurred_at,payload_json) VALUES ('r2',1,'start','tool.started','2026-01-01T00:00:00.000Z','{"invocationId":"tool"}');
 INSERT INTO run_events(run_id,seq,event_id,type,occurred_at,payload_json) VALUES ('r2',2,'done','tool.completed','2026-01-01T00:00:00.400Z','{"invocationId":"tool","durationMs":400}');`);
 const s=projectUsage(h.db,'c',8192,16384);
 assert.deepEqual(s.activity,{turns:2,turnsBasis:'conversation_runs',steps:4,llmMs:3300,toolMs:400,averageTtftMs:100,ttftSamples:3,llmSamples:3,toolSamples:1,unknownLlmCount:1,unknownToolCount:1});
 assert.deepEqual(s.byKind.map(x=>[x.kind,x.requests,x.totalTokens]),[['main',1,120],['compaction',1,120],['repair',1,120],['memory_recall',0,null],['memory_extraction',0,null]]);
});

test('raw usage missing vs explicit zero vs partial retain provenance',()=>{
 const missing=new ProviderMeasurement();missing.observe({choices:[{delta:{content:'hi'}}]});
 assert.equal(missing.source(true),'absent');assert.equal(missing.usage.input,null);
 const zero=new ProviderMeasurement();zero.observe({usage:{prompt_tokens:0,completion_tokens:0,prompt_tokens_details:{cached_tokens:0,cache_write_tokens:0}}});
 assert.equal(zero.source(true),'provider');assert.equal(zero.usage.input,0);assert.equal(zero.usage.reasoning,null);
 const partial=new ProviderMeasurement();partial.observe({usage:{prompt_tokens:100}});
 assert.equal(partial.source(true),'partial');assert.equal(partial.usage.totalInput,100);assert.equal(partial.usage.input,null);assert.equal(partial.usage.output,null);
});
test('cache buckets disjoint; reasoning not added to output; Anthropic usage merges snapshots',()=>{
 const m=new ProviderMeasurement();m.observe({usage:{prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:20,cache_write_tokens:10},completion_tokens_details:{reasoning_tokens:5}}});assert.deepEqual(m.usage,usage);
 const a=new ProviderMeasurement('anthropic-messages');a.observe({type:'message_start',message:{usage:{input_tokens:70,cache_read_input_tokens:20,cache_creation_input_tokens:10}}});a.observe({type:'message_delta',usage:{output_tokens:20}});
 assert.equal(a.source(true),'provider');assert.equal(a.usage.totalInput,100);assert.equal(a.usage.output,20);
});
test('TTFT ignores role/empty tool envelopes and records first effective reasoning/text/tool delta',()=>{
 const m=new ProviderMeasurement();m.observe({choices:[{delta:{role:'assistant',content:''}}]},'header');m.observe({choices:[{delta:{tool_calls:[{index:0,id:'x',function:{arguments:''}}]}}]},'empty');assert.equal(m.firstGenerationDeltaAt,null);
 m.observe({choices:[{delta:{reasoning_content:'think'}}]},'reason');m.observe({choices:[{delta:{content:'hi'}}]},'text');assert.equal(m.firstGenerationDeltaAt,'reason');assert.equal(m.firstTextAt,'text');
 const a=new ProviderMeasurement('anthropic-messages');a.observe({delta:{partial_json:'{' }},'tool');assert.equal(a.firstToolDeltaAt,'tool');
});
test('cancelled unknown ledger accepts timing/provenance without fabricating consumption',t=>{
 const h=harness(t);h.insert('unknown');h.registry.cancelInflight('a');
 const m=new ProviderMeasurement();m.observe({choices:[{delta:{content:'partial text'}}]},timing.firstGenerationDeltaAt!);
 h.registry.finish('unknown','failed','cancelled',{usageSource:'unknown',usage:m.usage,evidence:m.evidence,timing});
 const row=h.db.db.prepare('SELECT usage_evidence_json,first_generation_delta_at,ttft_ms FROM usage_entries WHERE request_id=?').get('unknown') as {usage_evidence_json:string;first_generation_delta_at:string;ttft_ms:number};
 assert.equal(JSON.parse(row.usage_evidence_json).rawUsageObserved,false);assert.equal(row.first_generation_delta_at,timing.firstGenerationDeltaAt);assert.equal(row.ttft_ms,100);
 const s=projectUsage(h.db,'c',8192,16384);assert.equal(s.lastRequest?.status,'cancelled');assert.equal(s.totals.inputTokens,null);assert.equal(s.speed.samples,0);
});

test('cancelled dispatched request retains unknown consumption; terminal usage reconciliation is idempotent',t=>{
 const h=harness(t);h.insert('q');h.registry.cancelInflight('a');
 let s=projectUsage(h.db,'c',8192,16384);assert.equal(s.totals.requests,1);assert.equal(s.totals.inputTokens,null);assert.equal(s.lastRequest?.status,'cancelled');
 h.registry.finish('q','completed',null,{usageSource:'provider',usage,timing});h.registry.finish('q','completed',null,{usageSource:'provider',usage,timing});
 s=projectUsage(h.db,'c',8192,16384);assert.equal(s.totals.requests,1);assert.equal(s.totals.totalTokens,120);assert.equal(s.lastRequest?.status,'cancelled');assert.equal(s.speed.decodeMs,1000);
 assert.equal((h.db.db.prepare('SELECT first_generation_delta_at t FROM usage_entries').get() as {t:string}).t,timing.firstGenerationDeltaAt);
});
test('conversation totals exceed 500 across runs, independent detail pagination and weighted speed',t=>{
 const h=harness(t);
 for(let i=0;i<605;i++){const id=String(i).padStart(5,'0');h.insert(id,i<300?'r':'r2');h.registry.finish(id,'completed',null,{usageSource:'provider',usage:{...usage,output:i===604?40:20},timing:{...timing,completedAt:i===604?'2026-01-01T00:00:02.100Z':timing.completedAt}});}
 const s=projectUsage(h.db,'c',8192,16384);assert.equal(s.totals.requests,605);assert.equal(s.totals.totalInputTokens,60500);assert.equal(s.requests.length,100);assert.equal(s.requestPage.hasMore,true);assert.equal(s.speed.sessionTokPerMs,(604*20+40)/(604000+2000));
 assert.equal(s.context.source,'last_request');assert.equal(s.context.isCurrent,false);assert.equal(s.context.reserveTokens,2048);assert.equal(s.lastRequest?.runId,'r2');
 const ids=new Set<string>();let before:string|undefined;do{const p=usageRequests(h.db,'c',100,before);for(const r of p.requests)ids.add(r.requestId);before=p.requestPage.nextBefore??undefined;}while(before);assert.equal(ids.size,605);
 h.insert('zz');h.registry.finish('zz','failed','error',{usageSource:'absent',usage:{},timing});const last=projectUsage(h.db,'c',8192,16384);assert.equal(last.speed.lastRequestTokPerMs,null);assert.equal(last.context.tokens,null);assert.equal(last.totals.unknownCount,1);
});
test('partial known buckets survive projection without counting unknown SDK zero',t=>{
 const h=harness(t);h.insert('p');h.registry.finish('p','completed',null,{usageSource:'partial',usage:{output:7},timing});
 const s=projectUsage(h.db,'c',8192,16384);assert.equal(s.totals.outputTokens,7);assert.equal(s.totals.inputTokens,null);assert.equal(s.totals.coverage.cacheRead.unknownRequests,1);assert.equal(s.requests[0]?.inputTokens,null);
 assert.equal(s.totals.cacheReadTokens,null);assert.equal(s.totals.cacheWriteTokens,null);assert.equal(s.totals.reasoningTokens,null);
});
test('messages carry runId; tools/events page without loss; terminal SSE drains >500 events',async t=>{
 const h=harness(t);const app=Fastify();registerRunRoutes(app,{db:h.db,dataDir:h.dir,supervisor:{} as Supervisor},()=>({userId:'u'}));t.after(()=>app.close());
 h.db.db.exec(`INSERT INTO messages(id,conversation_id,run_id,author_type,seq,state,content_json,created_at,updated_at) VALUES ('m','c','r','user',1,'published','{}','t','t')`);
 for(let i=1;i<=510;i++){
 h.db.db.prepare(`INSERT INTO run_events(run_id,seq,event_id,type,occurred_at,payload_json) VALUES ('r',?,?,'test','t','{}')`).run(i,`e${i}`);
 h.db.db.prepare(`INSERT INTO tool_invocations(id,run_id,phase_task_id,attempt_id,call_key,tool_name,tool_version,args_hash,state,created_at,updated_at) VALUES (?,'r','pt','a',?,'read_file','1','h','succeeded','t','t')`).run(`tool${String(i).padStart(4,'0')}`,`call${i}`);
 }
 const msg=(await app.inject('/api/v1/runs/r/messages')).json();assert.equal(msg.data.messages[0].runId,'r');
 let after=0,total=0;do{const p=(await app.inject(`/api/v1/runs/r/events?after=${after}&limit=200`)).json().data;total+=p.events.length;after=p.nextAfter;if(!p.hasMore)break;}while(true);assert.equal(total,510);
 let before='',tools=0;do{const p=(await app.inject(`/api/v1/runs/r/tools?limit=200${before?'&before='+before:''}`)).json().data;tools+=p.tools.length;before=p.nextBefore??'';}while(before);assert.equal(tools,510);
 const response=await app.inject('/api/v1/runs/r/events/stream');const frames=response.body.split('\n\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
 assert.equal(frames.filter(x=>x.type==='event').length,510);assert.equal(frames.at(-1).type,'end');
});
test('context without a known window stays unavailable, never substitutes a model capacity',()=>{
 const c=contextMeasurement(null,null,16384);assert.equal(c.window,null);assert.equal(c.windowSource,'unavailable');assert.equal(c.source,'unavailable');assert.equal(c.isCurrent,false);
 assert.equal(contextMeasurement(null,0,16384).window,null);
});

test('known prompt total and cache hit survive missing writes and legacy rows independently',t=>{
 const h=harness(t);h.insert('a-legacy');h.registry.finish('a-legacy','completed',null,{usageSource:'provider',usage,timing});
 h.db.db.prepare('UPDATE usage_entries SET normalized_usage_json=NULL,usage_evidence_json=NULL WHERE request_id=?').run('a-legacy');
 h.insert('z-known');const m=new ProviderMeasurement();m.observe({usage:{prompt_tokens:4819,completion_tokens:303,prompt_cache_hit_tokens:4608,completion_tokens_details:{reasoning_tokens:0}}});
 h.registry.finish('z-known','completed',null,{usageSource:m.source(true),usage:m.usage,evidence:m.evidence,timing});
 const s=projectUsage(h.db,'c',8192,16384);
 assert.equal(s.lastRequest?.usageSource,'partial');assert.equal(s.lastRequest?.inputTokens,null);assert.equal(s.lastRequest?.cacheWrite,null);
 assert.equal(s.lastRequest?.totalInputTokens,4819);assert.equal(s.lastRequest?.cacheRead,4608);
 assert.equal(s.totals.totalInputTokens,4819);assert.equal(s.totals.totalTokens,5122);assert.equal(s.totals.cacheReadTokens,4608);assert.equal(s.totals.cacheWriteTokens,null);
 assert.deepEqual(s.totals.coverage.totalInput,{knownRequests:1,unknownRequests:1});assert.deepEqual(s.totals.coverage.cacheRead,{knownRequests:1,unknownRequests:1});assert.deepEqual(s.totals.coverage.cacheWrite,{knownRequests:0,unknownRequests:2});
 assert.equal(s.context.tokens,4819);assert.equal(s.context.source,'last_request');assert.equal(s.context.isCurrent,false);assert.equal(s.context.estimated,false);
 assert.ok(s.lastRequest?.evidence?.fields.includes('usage.prompt_cache_hit_tokens'));
});

test('real Pi Anthropic HTTPS callback merges start/delta usage and initial content block timing',{timeout:15000},async t=>{
 const h=harness(t),cert=join(h.dir,'anthropic-cert.pem'),key=join(h.dir,'anthropic-key.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-keyout',key,'-out',cert,'-days','1','-nodes','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 let variant=0;
 const server=createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{
  req.resume();req.on('end',()=>{
   assert.equal(new URL(req.url!,'https://127.0.0.1').pathname,'/v1/messages');
   res.writeHead(200,{'content-type':'text/event-stream'});
   const frame=(event:Record<string,unknown>)=>res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
   const initial=variant===0?{input_tokens:70,output_tokens:0,cache_read_input_tokens:20,cache_creation_input_tokens:10}:variant===1?{input_tokens:70}:variant===2?{input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}:{};
   frame({type:'message_start',message:{id:'synthetic',type:'message',role:'assistant',model:'test-model',content:[],stop_reason:null,stop_sequence:null,usage:initial}});
   setTimeout(()=>{
    frame({type:'content_block_start',index:0,content_block:variant===0?{type:'tool_use',id:'tool_1',name:'test_tool',input:{}}:{type:'text',text:'hello'}});
    frame({type:'content_block_stop',index:0});
    setTimeout(()=>{frame({type:'message_delta',delta:{stop_reason:variant===0?'tool_use':'end_turn',stop_sequence:null},...(variant===3?{}:{usage:{output_tokens:variant===2?0:20,...(variant===0?{output_tokens_details:{thinking_tokens:5}}:{})}})});frame({type:'message_stop'});res.end();},220);
   },100);
  });
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
 const tickets=new TicketRegistry(h.db),ticket=tickets.mint({attemptId:'a',runId:'r2',roleId:'ordinary',modelConfigId:'mc',modelId:'test-model',policyVersion:'1'},60000);
 const gateway=new ModelGatewayServer({db:h.db,tickets,registry:h.registry,vault:{get:()=> 'synthetic-test-key'},bindingOf:()=>({configId:'mc',sessionRef:'synthetic',baseUrl:`https://127.0.0.1:${port}`,providerPreset:'custom',modelId:'test-model',protocol:'anthropic-messages',contextWindow:8192,maxOutputTokens:512,configRevision:1}),abortOf:()=>undefined,profile:{...RUNTIME_STREAM_PROFILE,allowLoopbackForTest:true,caCertPem:readFileSync(cert,'utf8')}});
 await gateway.ready;t.after(async()=>{await gateway.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 for(variant=0;variant<4;variant++){
  const body=JSON.stringify({model:'test-model',messages:[{role:'user',content:'test'}],stream:true,max_tokens:512}),hash=ModelRequestRegistry.hashBody(body);
  const reservation=h.registry.propose({attemptId:'a',runId:'r2',roleId:'ordinary',kind:'main',bodyHash:hash,estimatedInputTokens:20,maxOutputTokens:512,inputMessageIds:[],sourceSeq:null,checkpointId:null,turnId:null,clientMessageId:null,provider:'custom',model:'test-model',contextWindow:8192,frozenMaxOutput:512,reserveOutputTokens:2048});
  const response=await fetch(gateway.baseUrl+'/chat/completions',{signal:AbortSignal.timeout(5000),method:'POST',headers:{authorization:'Bearer '+ticket.token,'content-type':'application/json','x-prism-reservation':reservation.reservation,'x-prism-body-hash':hash},body});assert.equal(response.status,200);await response.text();
  const row=h.db.db.prepare('SELECT normalized_usage_json,usage_evidence_json,usage_source,first_tool_delta_at,first_text_at,ttft_ms,speed_valid FROM usage_entries WHERE request_id=?').get(reservation.requestId)!;
  const normalized=JSON.parse(String(row.normalized_usage_json)),evidence=JSON.parse(String(row.usage_evidence_json));
  assert.ok(Number(row.ttft_ms)>=80);assert.equal(evidence.protocol,'anthropic-messages');
  if(variant===0){assert.deepEqual(normalized,{input:70,output:20,cacheRead:20,cacheWrite:10,reasoning:5,totalInput:100});assert.equal(row.usage_source,'provider');assert.ok(row.first_tool_delta_at);assert.equal(row.first_text_at,null);assert.equal(row.speed_valid,1);assert.ok(evidence.fields.includes('message.usage.cache_read_input_tokens'));assert.ok(evidence.fields.includes('usage.output_tokens'));}
  if(variant===1){assert.equal(normalized.input,70);assert.equal(normalized.output,20);assert.equal(normalized.totalInput,null);assert.equal(normalized.cacheRead,null);assert.equal(normalized.cacheWrite,null);assert.equal(row.usage_source,'partial');assert.ok(row.first_text_at);}
  if(variant===2){assert.equal(normalized.totalInput,0);assert.equal(normalized.cacheRead,0);assert.equal(normalized.cacheWrite,0);assert.equal(row.usage_source,'provider');assert.equal(row.speed_valid,0);}
  if(variant===3){assert.equal(normalized.input,null);assert.equal(normalized.output,null);assert.equal(normalized.cacheRead,null);assert.equal(normalized.cacheWrite,null);assert.equal(normalized.totalInput,null);assert.deepEqual(evidence.fields,[]);}
 }
});

test('real HTTPS gateway raw missing/zero/partial/cache usage and delayed TTFT, no SDK default leakage',async t=>{
 const h=harness(t),cert=join(h.dir,'cert.pem'),key=join(h.dir,'key.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-keyout',key,'-out',cert,'-days','1','-nodes','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 let captured:Record<string,unknown>={};let choiceUsage=false;
 let raw:Record<string,unknown>|undefined;const server=createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{let body='';req.on('data',c=>{body+=String(c);});req.on('end',()=>{captured=JSON.parse(body) as Record<string,unknown>;res.writeHead(200,{'content-type':'text/event-stream'});const frame=(delta:unknown,finish:string|null=null)=>`data: ${JSON.stringify({id:'x',object:'chat.completion.chunk',model:'test-model',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`;res.write(frame({role:'assistant',content:''}));setTimeout(()=>{res.write(frame({content:'hello'}));setTimeout(()=>{if(raw)res.write(`data: ${JSON.stringify(choiceUsage ? {choices:[{index:0,delta:{},finish_reason:null,usage:raw}]} : {choices:[],usage:raw})}\n\n`);res.end(frame({},'stop')+'data: [DONE]\n\n');},220);},150);});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
 const tickets=new TicketRegistry(h.db),ticket=tickets.mint({attemptId:'a',runId:'r2',roleId:'ordinary',modelConfigId:'mc',modelId:'test-model',policyVersion:'1'},60000);
 const gateway=new ModelGatewayServer({db:h.db,tickets,registry:h.registry,vault:{get:()=> 'synthetic-test-key'},bindingOf:()=>({configId:'mc',sessionRef:'synthetic',baseUrl:`https://127.0.0.1:${port}`,providerPreset:'custom',modelId:'test-model',contextWindow:8192,maxOutputTokens:512,configRevision:1,parameters:{requested:{},effective:{contextWindow:8192,maxOutputTokens:256,thinkingLevel:'high',reasoning:'high',temperature:0},capability:{id:'openai-reasoning-v1',verified:true,thinkingLevels:['high'],temperature:true},adjustments:[],policyVersion:'runtime-parameters-v1'}}),abortOf:()=>undefined,profile:{...RUNTIME_STREAM_PROFILE,allowLoopbackForTest:true,caCertPem:readFileSync(cert,'utf8')}});
 await gateway.ready;t.after(async()=>{await gateway.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const variants=[undefined,{prompt_tokens:0,completion_tokens:0,prompt_tokens_details:{cached_tokens:0,cache_write_tokens:0}},{completion_tokens:3},{prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:20,cache_write_tokens:10},completion_tokens_details:{reasoning_tokens:5}},
 // Standard OpenAI/GLM wire shape: cache writes are not reported. No invented zero.
 {prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:80}},
 // DeepSeek compatibility fields; miss tokens are NOT cache-creation tokens.
 {prompt_tokens:4819,completion_tokens:303,prompt_cache_hit_tokens:4608,prompt_cache_miss_tokens:211},
 {prompt_tokens:100,completion_tokens:20,cached_tokens:75}];
 for(let i=0;i<variants.length;i++){
 choiceUsage=i===6;
 raw=variants[i];const body=JSON.stringify({model:'test-model',messages:[{role:'user',content:'test'}],stream:true,max_tokens:512}),hash=ModelRequestRegistry.hashBody(body);
 const reservation=h.registry.propose({attemptId:'a',runId:'r2',roleId:'ordinary',kind:'main',bodyHash:hash,estimatedInputTokens:20,maxOutputTokens:512,inputMessageIds:[],sourceSeq:null,checkpointId:null,turnId:null,clientMessageId:null,provider:'custom',model:'test-model',contextWindow:8192,frozenMaxOutput:512,reserveOutputTokens:2048});
 const response=await fetch(gateway.baseUrl+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+ticket.token,'content-type':'application/json','x-prism-reservation':reservation.reservation,'x-prism-body-hash':hash},body});assert.equal(response.status,200);await response.text();
 assert.equal(captured.temperature,0);assert.equal(captured.reasoning_effort,'high');assert.equal(captured.max_completion_tokens,256);
 const row=h.db.db.prepare('SELECT normalized_usage_json,usage_source,ttft_ms FROM usage_entries WHERE request_id=?').get(reservation.requestId) as {normalized_usage_json:string;usage_source:string;ttft_ms:number};assert.ok(row.ttft_ms>=100);const normalized=JSON.parse(row.normalized_usage_json);
 if(i===0){assert.equal(row.usage_source,'absent');assert.equal(normalized.output,null);}if(i===1){assert.equal(row.usage_source,'provider');assert.equal(normalized.output,0);}if(i===2){assert.equal(row.usage_source,'partial');assert.equal(normalized.output,3);assert.equal(normalized.input,null);}if(i===3)assert.deepEqual(normalized,usage);
 if(i>=4){
  assert.equal(row.usage_source,'partial');assert.equal(normalized.input,null);assert.equal(normalized.cacheWrite,null);
  assert.equal(normalized.totalInput,i===5?4819:100);assert.equal(normalized.cacheRead,i===4?80:i===5?4608:75);
  const evidence=JSON.parse(String(h.db.db.prepare('SELECT usage_evidence_json FROM usage_entries WHERE request_id=?').get(reservation.requestId)!.usage_evidence_json));
  assert.equal(evidence.rawUsageObserved,true);
  assert.ok(evidence.fields.includes(i===4?'usage.prompt_tokens_details.cached_tokens':i===5?'usage.prompt_cache_hit_tokens':'choices[0].usage.cached_tokens'));
  const snapshot=projectUsage(h.db,'c',8192,16384);assert.equal(snapshot.context.tokens,normalized.totalInput);assert.equal(snapshot.lastRequest?.cacheRead,normalized.cacheRead);
 }
 }
});

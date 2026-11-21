import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:https';
import Fastify from 'fastify';
import {Db} from '../src/storage/db.js';
import {migrate,defaultMigrationsDir} from '../src/storage/migrate.js';
import {ReasoningProjection} from '../src/agent/reasoningProjection.js';
import {ModelGatewayServer} from '../src/agent/gatewayServer.js';
import {ModelRequestRegistry,type RequestKind} from '../src/agent/modelRequests.js';
import {TicketRegistry} from '../src/agent/tickets.js';
import {RUNTIME_STREAM_PROFILE} from '../src/models/streamNetwork.js';
import {readConversationWindow} from '../src/agent/conversationProjection.js';
import {registerRunRoutes} from '../src/agent/runRoutes.js';
import type {Supervisor} from '../src/agent/supervisor.js';
import type {ConversationEvent,ConversationRun} from '../contracts/conversation.js';
import {projectTurn,mergeEvents} from '../web/conversation/project.js';

function harness(t:{after(fn:()=>unknown):unknown}){
 const dir=mkdtempSync(join(tmpdir(),'reasoning-projection-')),db=new Db(join(dir,'test.sqlite'));
 migrate(db,defaultMigrationsDir());
 db.db.exec(`INSERT INTO users(id,username,password_hash,password_salt,password_params_json,created_at,updated_at) VALUES ('u','test','x','x','{}','t','t');
 INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES ('p','u','test','t','t');
 INSERT INTO conversations(id,project_id,mode,title,created_at,updated_at) VALUES ('c','p','ordinary','test','t','t');
 INSERT INTO problem_versions(id,conversation_id,version,objective,created_at,updated_at) VALUES ('pv','c',1,'test','t','t');
 INSERT INTO model_configs(id,owner_user_id,preset,name,base_url,created_at,updated_at) VALUES ('mc','u','custom','test','https://127.0.0.1','t','t');
 INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,config_snapshot_json,created_at,updated_at) VALUES ('r','p','c','pv','ordinary','running','{}','t','t');
 INSERT INTO agent_bindings(id,run_id,role_id,model_config_id,model_id,created_at,updated_at) VALUES ('b','r','ordinary','mc','test-model','t','t');
 INSERT INTO phase_tasks(id,run_id,agent_binding_id,phase_key,status,created_at,updated_at) VALUES ('pt','r','b','main','running','t','t');
 INSERT INTO attempts(id,phase_task_id,number,status,created_at,updated_at) VALUES ('a','pt',1,'running','t','t');`);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const registry=new ModelRequestRegistry(db,()=>false);
 const events=()=>db.db.prepare('SELECT seq,type,attempt_id AS attemptId,visibility,payload_json FROM run_events ORDER BY seq').all().map(e=>({runId:'r',seq:Number(e.seq),attemptId:String(e.attemptId),type:String(e.type),visibility:e.visibility,payload:JSON.parse(String(e.payload_json))}));
 return {dir,db,registry,events};
}
const identity={runId:'r',attemptId:'a',requestId:'req',kind:'main'};
const frame=(delta:unknown)=>({choices:[{index:0,delta}]});
const rows=(run:ConversationRun)=>projectTurn(run).segments.flatMap(s=>s.rows).filter(r=>r.kind==='reasoning');

test('raw projection allowlists three plaintext fields, coalesces snapshots and persists owner-only safe scalars',async t=>{
 const h=harness(t),p=new ReasoningProjection(h.db,identity);
 p.observe(frame({reasoning_content:'alpha',thinkingSignature:'SECRET_SIG',reasoning_details:[{type:'reasoning.encrypted',data:'SECRET_DATA'}]}));
 for(let i=0;i<30;i++)p.observe(frame({reasoning:'b'}));
 p.observe(frame({reasoning_text:'omega'}));
 assert.equal(h.events().length,1);
 await new Promise(r=>setTimeout(r,145));
 assert.equal(h.events().length,2);
 p.finish(true);p.finish(false);p.observe(frame({reasoning:'late'}));
 const events=h.events();assert.equal(events.length,3);
 assert.deepEqual(events.map(e=>e.payload.revision),[1,2,3]);
 assert.equal(events.at(-1)!.payload.text,'alpha'+'b'.repeat(30)+'omega');
 assert.equal(events.at(-1)!.payload.state,'completed');
 for(const e of events){assert.equal(e.visibility,'owner');assert.equal(e.attemptId,'a');assert.deepEqual(Object.keys(e.payload).sort(),['runId','attemptId','requestId','blockId','revision','text','state','source','truncated'].sort());}
 assert.ok(!JSON.stringify(events).includes('SECRET'));
});

test('no invented block for signature-only, nested/encrypted/redacted/unknown fields or internal request kinds',t=>{
 const h=harness(t);
 for(const kind of ['main','compaction','repair']){
  const p=new ReasoningProjection(h.db,{...identity,kind});
  p.observe(frame({thinkingSignature:'SECRET',reasoning_details:[{type:'reasoning.text',text:'SECRET'}],reasoning_content:{text:'SECRET'},reasoning_text:['SECRET']}));
  p.observe({type:'thinking_delta',thinking:'SECRET'});
  p.observe(frame({reasoning:'   '}));
  if(kind!=='main')p.observe(frame({reasoning:'INTERNAL'}));
  p.finish(true);
 }
 assert.equal(h.events().length,0);
 const a=new ReasoningProjection(h.db,identity,'anthropic-messages');
 a.observe({type:'content_block_start',index:0,content_block:{type:'redacted_thinking',data:'SECRET',thinking:'SECRET'}});
 a.observe({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'SECRET'}});
 a.observe({type:'content_block_delta',index:1,delta:{type:'thinking_delta',thinking:'SECRET'}});
 a.finish(true);assert.equal(h.events().length,0);
});

test('Anthropic includes start plaintext and delta, never signatures/redacted, preserves interrupted and distinct blocks',t=>{
 const h=harness(t),p=new ReasoningProjection(h.db,identity,'anthropic-messages');
 p.observe({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'initial ',signature:'SECRET'}});
 p.observe({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'delta'}});
 p.observe({type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'SECRET'}});
 p.observe({type:'content_block_stop',index:0});
 p.observe({type:'content_block_start',index:1,content_block:{type:'redacted_thinking',data:'SECRET'}});
 p.observe({type:'content_block_start',index:2,content_block:{type:'thinking',thinking:'next'}});
 p.finish(false);
 const finals=h.events().filter(e=>e.type==='reasoning.completed');
 assert.equal(finals.length,2);assert.deepEqual(finals.map(e=>e.payload.text),['initial delta','next']);
 assert.ok(finals.every(e=>e.payload.state==='interrupted'));assert.ok(!JSON.stringify(h.events()).includes('SECRET'));
});

test('history/live replay is stable under out-of-order duplicates and late stale snapshots; no assistant merge',t=>{
 const h=harness(t),p=new ReasoningProjection(h.db,identity);
 p.observe(frame({reasoning:'safe'}));p.observe(frame({reasoning:' final'}));p.finish(true);
 const run=readConversationWindow(h.db,'r','u').runs[0]!;
 const expected=rows(run);assert.equal(expected.length,1);
 const reversed=mergeEvents([run.events.at(-1)!],run.events.slice().reverse());
 assert.deepEqual(rows({...run,events:reversed}),expected);
 const late:ConversationEvent={...run.events[0]!,seq:100,payload:{...run.events[0]!.payload,revision:99,text:'late'}};
 assert.deepEqual(rows({...run,events:[...run.events,late]}),expected);
 const interrupted=rows({...run,status:'cancelled',events:[run.events[0]!]});assert.equal(interrupted[0]!.state,'interrupted');
 assert.equal(rows({...run,events:[{...run.events[0]!,payload:{...run.events[0]!.payload,runId:'foreign'}}]}).length,0);
});

test('owner HTTP events, SSE and conversation window expose identical safe projection and enforce ownership',async t=>{
 const h=harness(t),p=new ReasoningProjection(h.db,identity);p.observe(frame({reasoning:'safe',reasoning_details:[{data:'SECRET'}]}));p.finish(true);
 h.db.db.prepare("UPDATE runs SET status='succeeded' WHERE id='r'").run();
 const app=Fastify();registerRunRoutes(app,{db:h.db,dataDir:h.dir,supervisor:{} as Supervisor},req=>({userId:req.headers['x-user']==='foreign'?'other':'u'}));
 await app.listen({port:0,host:'127.0.0.1'});t.after(()=>app.close());
 const http=(await app.inject({method:'GET',url:'/api/v1/runs/r/events'})).json().data.events;
 assert.equal((await app.inject({method:'GET',url:'/api/v1/runs/r/events',headers:{'x-user':'foreign'}})).statusCode,404);
 const response=await fetch(`http://127.0.0.1:${(app.server.address() as {port:number}).port}/api/v1/runs/r/events/stream`,{signal:AbortSignal.timeout(5000)});
 const wire=await response.text();assert.ok(!wire.includes('SECRET'));
 const live=wire.split('\n\n').filter(s=>s.startsWith('data: ')).map(s=>JSON.parse(s.slice(6))).filter(e=>e.type==='event').map(e=>e.event);
 assert.deepEqual(live,http);
 const run=readConversationWindow(h.db,'r','u').runs[0]!;
 assert.deepEqual(rows({...run,events:live}),rows(run));
});

test('bounded plaintext truncation is explicit; duplicate alias fields and alternative choices never double count',t=>{
 const h=harness(t),p=new ReasoningProjection(h.db,identity);
 p.observe({choices:[{index:1,delta:{reasoning:'OTHER'}}]});
 p.observe(frame({reasoning_content:'primary',reasoning:'duplicate',reasoning_text:'duplicate'}));
 p.observe(frame({reasoning:'x'.repeat(300*1024)}));p.finish(true);
 const final=h.events().at(-1)!.payload;
 assert.equal(final.text.length,256*1024);assert.equal(final.truncated,true);assert.ok(final.text.startsWith('primary'));assert.ok(!final.text.includes('duplicate'));assert.ok(!final.text.includes('OTHER'));
});

test('gateway rejects cross-attempt and cross-run reservation before claiming or contacting provider',async t=>{
 const h=harness(t),tickets=new TicketRegistry(h.db);
 const ticket=tickets.mint({attemptId:'a',runId:'r',roleId:'ordinary',modelConfigId:'mc',modelId:'test-model',policyVersion:'1'},60000);
 const gateway=new ModelGatewayServer({db:h.db,tickets,registry:h.registry,vault:{get:()=>{throw new Error('must not load a key');}},bindingOf:()=>({configId:'mc',sessionRef:'synthetic',baseUrl:'https://127.0.0.1:1',providerPreset:'custom',modelId:'test-model',contextWindow:8192,maxOutputTokens:512,configRevision:1}),abortOf:()=>undefined});
 await gateway.ready;t.after(()=>gateway.close());
 const body=JSON.stringify({model:'test-model',messages:[{role:'user',content:'test'}],stream:true,max_tokens:512}),hash=ModelRequestRegistry.hashBody(body);
 const reservation=h.registry.propose({attemptId:'a',runId:'r',roleId:'ordinary',kind:'main',bodyHash:hash,estimatedInputTokens:20,maxOutputTokens:512,inputMessageIds:[],sourceSeq:null,checkpointId:null,turnId:null,clientMessageId:null,provider:'custom',model:'test-model',contextWindow:8192,frozenMaxOutput:512,reserveOutputTokens:2048});
 h.db.db.exec(`INSERT INTO attempts(id,phase_task_id,number,status,created_at,updated_at) VALUES ('a2','pt',2,'running','t','t');
 INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,config_snapshot_json,created_at,updated_at) VALUES ('other','p','c','pv','ordinary','succeeded','{}','t','t');`);
 for(const [attempt,run] of [['a2','r'],['a','other']]){
  h.db.db.prepare('UPDATE model_requests SET attempt_id=?,run_id=? WHERE id=?').run(attempt!,run!,reservation.requestId);
  const response=await fetch(gateway.baseUrl+'/chat/completions',{signal:AbortSignal.timeout(5000),method:'POST',headers:{authorization:'Bearer '+ticket.token,'content-type':'application/json','x-prism-reservation':reservation.reservation,'x-prism-body-hash':hash},body});
  assert.equal(response.status,403);assert.equal((await response.json() as {error:{code:string}}).error.code,'RESERVATION_INVALID');
  assert.equal(h.registry.row(reservation.requestId)!.state,'reserved');assert.equal(h.events().length,0);
 }
});

// Real local TLS provider -> actual Pi SDK -> trusted gateway -> persisted projection.
// Test keys/cert/database are synthetic and temporary; no external network or real credentials.
for(const protocol of ['openai-completions','anthropic-messages'] as const)test(`real HTTPS + Pi ${protocol}: plaintext only, internal kinds denied, cancelled retained`,{timeout:20000},async t=>{
 const h=harness(t),cert=join(h.dir,'cert.pem'),key=join(h.dir,'key.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-keyout',key,'-out',cert,'-days','1','-nodes','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 let mode:'plain'|'signature'|'cancel'|'broken'='plain',abort=new AbortController(),calls=0;
 const server=createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{
  calls++;req.resume();req.on('end',()=>{
   res.writeHead(200,{'content-type':'text/event-stream'});
   const event=(data:Record<string,unknown>)=>res.write(`${protocol==='anthropic-messages'?`event: ${data.type}\n`:''}data: ${JSON.stringify(data)}\n\n`);
   if(protocol==='openai-completions'){
    const chunk=(delta:unknown,finish:string|null=null)=>event({id:'synthetic',object:'chat.completion.chunk',model:'test-model',choices:[{index:0,delta,finish_reason:finish}]});
    chunk({role:'assistant'});
    if(mode!=='signature'){chunk({reasoning_content:'initial '});chunk({reasoning:'middle '});chunk({reasoning_text:'delta'});}
    chunk({reasoning_details:[{type:'reasoning.encrypted',data:'SECRET'}],thinkingSignature:'SECRET'});
    if(mode==='cancel'){setTimeout(()=>abort.abort(),30);return;}
    if(mode==='broken'){setTimeout(()=>res.destroy(),30);return;}
    chunk({content:'answer'});chunk({},'stop');res.end('data: [DONE]\n\n');
   }else{
    event({type:'message_start',message:{id:'synthetic',type:'message',role:'assistant',model:'test-model',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}});
    event({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:mode==='signature'?'':'initial ',signature:''}});
    if(mode!=='signature')event({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'delta'}});
    event({type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'SECRET'}});
    event({type:'content_block_stop',index:0});
    event({type:'content_block_start',index:1,content_block:{type:'redacted_thinking',data:'SECRET'}});event({type:'content_block_stop',index:1});
    if(mode==='cancel'){setTimeout(()=>abort.abort(),30);return;}
    if(mode==='broken'){setTimeout(()=>res.destroy(),30);return;}
    event({type:'content_block_start',index:2,content_block:{type:'text',text:'answer'}});event({type:'content_block_stop',index:2});
    event({type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:2}});event({type:'message_stop'});res.end();
   }
  });
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const tickets=new TicketRegistry(h.db),ticket=tickets.mint({attemptId:'a',runId:'r',roleId:'ordinary',modelConfigId:'mc',modelId:'test-model',policyVersion:'1'},60000);
 const gateway=new ModelGatewayServer({db:h.db,tickets,registry:h.registry,vault:{get:()=> 'synthetic-test-key'},bindingOf:()=>({configId:'mc',sessionRef:'synthetic',baseUrl:`https://127.0.0.1:${(server.address() as {port:number}).port}`,providerPreset:'custom',modelId:'test-model',protocol,contextWindow:8192,maxOutputTokens:512,configRevision:1}),abortOf:()=>abort.signal,profile:{...RUNTIME_STREAM_PROFILE,allowLoopbackForTest:true,caCertPem:readFileSync(cert,'utf8')}});
 await gateway.ready;t.after(async()=>{await gateway.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const request=async(kind:RequestKind)=>{
  const body=JSON.stringify({model:'test-model',messages:[{role:'user',content:'test'}],stream:true,max_tokens:512}),hash=ModelRequestRegistry.hashBody(body);
  const reservation=h.registry.propose({attemptId:'a',runId:'r',roleId:'ordinary',kind,bodyHash:hash,estimatedInputTokens:20,maxOutputTokens:512,inputMessageIds:[],sourceSeq:null,checkpointId:null,turnId:null,clientMessageId:null,provider:'custom',model:'test-model',contextWindow:8192,frozenMaxOutput:512,reserveOutputTokens:2048});
  const response=await fetch(gateway.baseUrl+'/chat/completions',{signal:AbortSignal.timeout(5000),method:'POST',headers:{authorization:'Bearer '+ticket.token,'content-type':'application/json','x-prism-reservation':reservation.reservation,'x-prism-body-hash':hash},body});
  assert.equal(response.status,200);const wire=await response.text();assert.ok(!wire.includes('SECRET'));
  return h.events().filter(e=>e.payload.requestId===reservation.requestId);
 };
 const plain=await request('main');assert.ok(plain.length>=2);assert.equal(plain.at(-1)!.payload.text,protocol==='openai-completions'?'initial middle delta':'initial delta');assert.equal(plain.at(-1)!.payload.state,'completed');
 assert.equal((await request('compaction')).length,0);assert.equal((await request('repair')).length,0);
 mode='signature';assert.equal((await request('main')).length,0);
 mode='broken';const broken=await request('main');assert.equal(broken.at(-1)!.payload.state,'interrupted');
 mode='cancel';const cancelled=await request('main');assert.equal(cancelled.at(-1)!.payload.state,'interrupted');
 assert.equal(calls,6);assert.ok(!JSON.stringify(h.events()).includes('SECRET'));
});

// 弱网心跳：非终态run的SSE流空闲时发注释帧（PRISM_SSE_HEARTBEAT_IDLE_MS覆盖间隔，仅测试调短）。
// 客户端watchdog据此在30s无字节时判半开连接并重连；注释帧不进data解析，不影响事件投影。
test('SSE idle heartbeat emits comment frames on non-terminal runs',async t=>{
 const previous=process.env.PRISM_SSE_HEARTBEAT_IDLE_MS;
 process.env.PRISM_SSE_HEARTBEAT_IDLE_MS='300';
 t.after(()=>{if(previous===undefined)delete process.env.PRISM_SSE_HEARTBEAT_IDLE_MS;else process.env.PRISM_SSE_HEARTBEAT_IDLE_MS=previous;});
 const h=harness(t);
 const app=Fastify();registerRunRoutes(app,{db:h.db,dataDir:h.dir,supervisor:{} as Supervisor},req=>({userId:'u'}));
 await app.listen({port:0,host:'127.0.0.1'});t.after(()=>app.close());
 const controller=new AbortController();
 const response=await fetch(`http://127.0.0.1:${(app.server.address() as {port:number}).port}/api/v1/runs/r/events/stream`,{signal:controller.signal});
 assert.equal(response.status,200);
 const reader=response.body!.getReader();let wire='';let pings=0;
 try{
  const deadline=Date.now()+3000;
  while(Date.now()<deadline){
   const {done,value}=await reader.read();
   if(done)break;
   wire+=new TextDecoder().decode(value);
   pings=(wire.match(/: ping/g)??[]).length;
   if(pings>=2)break;
  }
 }finally{controller.abort();try{reader.releaseLock();}catch{ /* already released on abort */ }}
 assert.ok(pings>=2,`expected at least two heartbeat frames, wire=${JSON.stringify(wire.slice(0,400))}`);
 assert.ok(wire.includes('"type":"snapshot"'));
 // 注释帧不产生data事件：投影事件仍与HTTP侧一致
 const http=(await app.inject({method:'GET',url:'/api/v1/runs/r/events'})).json().data.events;
 const dataFrames=wire.split('\n\n').filter(s=>s.startsWith('data: ')).map(s=>JSON.parse(s.slice(6))).filter(e=>e.type==='event').map(e=>e.event);
 assert.deepEqual(dataFrames,http);
});

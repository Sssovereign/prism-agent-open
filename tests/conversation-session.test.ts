import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RealRunSession, failureOfRun } from '../web/view-model/realRun.js';
import type { ConversationEvent, ConversationRun, ConversationWindow } from '../contracts/conversation.js';
const run=(events:ConversationEvent[]=[],status='running'):ConversationRun=>({id:'r',mode:'ordinary',status,createdAt:'2026-11-12T00:00:00Z',messages:[],events,tools:[],approvals:[],throughSeq:events.at(-1)?.seq??0});
const windowOf=(r:ConversationRun):ConversationWindow=>({conversationId:'c',runs:[r],hasOlder:false,before:'r'});
const response=(data:unknown)=>new Response(JSON.stringify({requestId:'fixture',data}),{status:200});
const event=(seq:number,type:string,payload:Record<string,unknown>):ConversationEvent=>({seq,type,payload});
// Test transport injection only: no network, no credentials and no actual service.
interface TestAccess {handleFrame(frame:{type:string;event?:ConversationEvent;run?:{id:string;status:string}}):void}
const access=(s:RealRunSession)=>s as unknown as TestAccess;
test('failed conversation snapshot restores persisted error details without SSE replay', async t=>{
 const failed={...run([event(4,'run.failed',{error:'CREDENTIAL_REQUIRED',message:'401 fixture invalid key',retryable:false})],'failed'),stopReason:'CREDENTIAL_REQUIRED'};
 t.mock.method(globalThis,'fetch',async()=>response(windowOf(failed)));
 const s=new RealRunSession('r');t.after(()=>s.dispose());await s.retryHistory();
 assert.deepEqual(s.failure.value,{code:'CREDENTIAL_REQUIRED',message:'401 fixture invalid key',retryable:false});
});
test('historical errors use the latest failure and disappear while retrying or after success',()=>{
 const history=[event(1,'run.failed',{error:'CREDENTIAL_REQUIRED',message:'old key error'}),event(2,'run.resumed',{}),event(3,'run.failed',{error:'MODEL_QUOTA_EXCEEDED',message:'current quota error',retryable:false})];
 assert.equal(failureOfRun({...run(history,'failed'),stopReason:'MODEL_QUOTA_EXCEEDED'})?.message,'current quota error');
 assert.equal(failureOfRun(run(history,'running')),null);
 assert.equal(failureOfRun(run(history,'succeeded')),null);
 assert.deepEqual(failureOfRun({...run(history,'failed'),stopReason:'RUNNER_EXITED'}),{code:'RUNNER_EXITED'});
});
test('HTTP arriving behind SSE unions older seqs and cannot reset completed live text',async t=>{
 let resolve!:(value:Response)=>void;t.mock.method(globalThis,'fetch',()=>new Promise<Response>(r=>resolve=r));
 const s=new RealRunSession('r');t.after(()=>s.dispose());
 const loading=s.retryHistory();
 access(s).handleFrame({type:'event',event:event(3,'message.completed',{role:'assistant',messageId:'a',content:'完整正文'})});
 resolve(response(windowOf(run([event(1,'message.delta',{messageId:'a',content:'旧'}),event(2,'tool.started',{invocationId:'t',tool:'read_file'})]))));await loading;
 assert.deepEqual(s.runs.value[0]?.events.map(e=>e.seq),[1,2,3]);
 const rows=s.turns.value.flatMap(t=>t.segments.flatMap(s=>s.rows));assert.equal(rows.filter(r=>r.id==='a').length,1);const text=rows.find(r=>r.id==='a');assert.equal(text?.kind==='assistant'&&text.text,'完整正文');assert.equal(s.streamingText.value,'');
 access(s).handleFrame({type:'event',event:event(1,'message.delta',{messageId:'a',content:'重复旧正文'})});assert.equal(s.runs.value[0]?.events.length,3);
});
test('newer HTTP response wins; disposed session ignores pending response',async t=>{
 const pending:Array<(value:Response)=>void>=[];t.mock.method(globalThis,'fetch',()=>new Promise<Response>(r=>pending.push(r)));
 const s=new RealRunSession('r');t.after(()=>s.dispose());const older=s.retryHistory(),newer=s.retryHistory();pending[1]!(response(windowOf(run([event(2,'message.completed',{role:'assistant',messageId:'a',content:'新'})],'succeeded'))));await newer;pending[0]!(response(windowOf(run([],'running'))));await older;assert.equal(s.status.value,'succeeded');assert.equal(s.runs.value[0]?.events.length,1);
 const late=s.retryHistory();s.dispose();pending[2]!(response(windowOf(run([],'failed'))));await late;assert.equal(s.status.value,'succeeded');
});
test('tool details are lazy and concurrent expands share a request',async t=>{
 let calls=0,resolve!:(value:Response)=>void;t.mock.method(globalThis,'fetch',()=>{calls++;return new Promise<Response>(r=>resolve=r);});
 const s=new RealRunSession('r');t.after(()=>s.dispose());s.runs.value=[{...run(),tools:[{invocationId:'t',tool:'read_file',state:'succeeded'}]}];assert.equal(calls,0);const a=s.loadToolResult('t'),b=s.loadToolResult('t');assert.equal(calls,1);resolve(response({preview:'结果',truncated:false}));await Promise.all([a,b]);await s.loadToolResult('t');assert.equal(calls,1);assert.equal(s.details.value.t?.resultPreview,'结果');
});
test('steer passes stable client ID and reports accepted even when history refresh fails',async t=>{
 const bodies:string[]=[];t.mock.method(globalThis,'fetch',(url:string,init?:RequestInit)=>{if(url.endsWith('/steer')){bodies.push(String(init?.body));return Promise.resolve(response({messageId:'m',duplicate:true}));}return Promise.reject(new Error('fixture history unavailable'));});
 const s=new RealRunSession('r');t.after(()=>s.dispose());const result=await s.steer('补充','client-stable');assert.deepEqual(JSON.parse(bodies[0]!),{text:'补充',clientMessageId:'client-stable'});assert.equal(result.accepted,true);assert.equal(result.messageId,'m');assert.equal(s.busy.value,false);assert.match(s.loadError.value,/unavailable/);
});

test('late usage response cannot overwrite newer snapshot or disposed session', async t=>{
 const pending:Array<(value:Response)=>void>=[];t.mock.method(globalThis,'fetch',()=>new Promise<Response>(resolve=>pending.push(resolve)));
 const session=new RealRunSession('r');t.after(()=>session.dispose());
 const older=session.refreshUsage(),newer=session.refreshUsage();
 pending[1]!(response({scope:'conversation',conversationId:'new'}));await newer;
 pending[0]!(response({scope:'conversation',conversationId:'old'}));await older;
 assert.equal(session.usage.value?.conversationId,'new');
 const late=session.refreshUsage();session.dispose();pending[2]!(response({scope:'conversation',conversationId:'disposed'}));await late;
 assert.equal(session.usage.value?.conversationId,'new');
});

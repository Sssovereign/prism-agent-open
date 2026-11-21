import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Db} from '../src/storage/db.js';
import {migrate,defaultMigrationsDir} from '../src/storage/migrate.js';
import {ModelRequestRegistry,LIMITS,type ProposeInput} from '../src/agent/modelRequests.js';
import {estimateTokensOf,estimateRequestTokens,IMAGE_ESTIMATED_TOKENS} from '../src/agent/tokenEstimate.js';
import {markGateRejection,takeGateRejection} from '../src/agent/modelGateError.js';

// 背景（2026-11-20生产事故回归）：门禁曾把图片base64当文本估算（1.4MB图→642k token假阳性），
// 且预算不足直接拒绝而非收紧输出。本文件锁定修复行为：图片固定预算、收紧优先、归因不可重试。

function harness(t:{after(fn:()=>unknown):unknown}){
 const dir=mkdtempSync(join(tmpdir(),'context-budget-')),db=new Db(join(dir,'test.sqlite'));
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
 const requestRows=()=>db.db.prepare('SELECT max_output_tokens AS maxOutput,estimated_input_tokens AS estimated FROM model_requests').all();
 return {db,registry,requestRows};
}

const hash='a'.repeat(64);
const proposeInput=(over:Partial<ProposeInput>={}):ProposeInput=>({attemptId:'a',runId:'r',roleId:'ordinary',kind:'main',bodyHash:hash,estimatedInputTokens:20,maxOutputTokens:512,inputMessageIds:[],sourceSeq:null,checkpointId:null,turnId:null,clientMessageId:null,provider:'custom',model:'test-model',contextWindow:8192,frozenMaxOutput:512,reserveOutputTokens:2048,...over});

// —— P0-1 估算器 ——

test('text-only estimate is unchanged by the image-aware path', () => {
    const body=JSON.stringify({model:'test-model',messages:[{role:'user',content:[{type:'text',text:'你好，请总结这份文档。'}]}]});
    assert.equal(estimateRequestTokens(body,JSON.parse(body)),estimateTokensOf(body));
});

test('base64 image payload counts as fixed budget, not linear in bytes', () => {
    const url=`data:image/png;base64,${'A'.repeat(1_500_000)}`;
    const body=JSON.stringify({model:'test-model',messages:[{role:'user',content:[{type:'text',text:'看看这张图'},{type:'image_url',image_url:{url}}]}]});
    const oldWay=estimateTokensOf(body);
    const stripped={model:'test-model',messages:[{role:'user',content:[{type:'text',text:'看看这张图'},{type:'image_url',image_url:{url:''}}]}]};
    const expected=Math.ceil(JSON.stringify(stripped).length/3)+64+IMAGE_ESTIMATED_TOKENS;
    const actual=estimateRequestTokens(body,JSON.parse(body));
    assert.equal(actual,expected);
    assert.ok(actual<oldWay/100,`剥离后估算(${actual})应远低于当文本估算(${oldWay})`);
});

test('multiple images each add one fixed budget', () => {
    const mk=()=>'data:image/png;base64,'+'B'.repeat(50_000);
    const parsed={messages:[
        {role:'user',content:[{type:'image_url',image_url:{url:mk()}},{type:'image_url',image_url:{url:mk()}}]},
        {role:'user',content:[{type:'image_url',image_url:{url:mk()}}]},
    ]};
    const stripped={messages:[
        {role:'user',content:[{type:'image_url',image_url:{url:''}},{type:'image_url',image_url:{url:''}}]},
        {role:'user',content:[{type:'image_url',image_url:{url:''}}]},
    ]};
    const body=JSON.stringify(parsed);
    const expected=Math.ceil(JSON.stringify(stripped).length/3)+64+3*IMAGE_ESTIMATED_TOKENS;
    assert.equal(estimateRequestTokens(body,JSON.parse(body)),expected);
});

test('pi-native image blocks (bare base64 data) are stripped the same way', () => {
    const data='C'.repeat(200_000);
    const body=JSON.stringify({messages:[{role:'user',content:[{type:'image',data,mimeType:'image/png'}]}]});
    const expected=Math.ceil(JSON.stringify({messages:[{role:'user',content:[{type:'image',data:'',mimeType:'image/png'}]}]}).length/3)+64+IMAGE_ESTIMATED_TOKENS;
    assert.equal(estimateRequestTokens(body,JSON.parse(body)),expected);
});

test('non-data image URLs are counted as images but kept intact', () => {
    const url='https://example.com/a.png';
    const body=JSON.stringify({messages:[{role:'user',content:[{type:'image_url',image_url:{url}}]}]});
    const expected=Math.ceil(body.length/3)+64+IMAGE_ESTIMATED_TOKENS;
    assert.equal(estimateRequestTokens(body,JSON.parse(body)),expected);
});

test('unparsable body falls back to whole-text estimate', () => {
    assert.equal(estimateRequestTokens('{not json',undefined),estimateTokensOf('{not json'));
});

// —— P0-2 门禁：收紧优先、低于下限才拒绝 ——

test('ample budget reserves the full requested output', t => {
    const h=harness(t);
    const reservation=h.registry.propose(proposeInput());
    assert.equal(reservation.maxOutputTokens,512);
    assert.equal(h.requestRows()[0]?.maxOutput,512);
});

test('tight budget shrinks this request output instead of rejecting', t => {
    const h=harness(t);
    // 窗口8192−预留2048−估算5000=可用1144：高于下限1024、低于请求的2048 → 收紧到1144
    const reservation=h.registry.propose(proposeInput({estimatedInputTokens:5000,maxOutputTokens:2048,frozenMaxOutput:2048}));
    assert.equal(reservation.maxOutputTokens,1144);
    assert.equal(h.requestRows()[0]?.maxOutput,1144);
});

test('below floor is a true overflow and still rejects', t => {
    const h=harness(t);
    // 8192−2048−6000=144 < 1024 → 拒绝且不留行
    assert.throws(()=>h.registry.propose(proposeInput({estimatedInputTokens:6000,maxOutputTokens:2048,frozenMaxOutput:2048})),
        (error:unknown)=>error instanceof Error && 'code' in error && (error as {code:string}).code==='CONTEXT_LIMIT_EXCEEDED');
    assert.equal(h.requestRows().length,0);
});

test('null contextWindow skips budget math as before', t => {
    const h=harness(t);
    const reservation=h.registry.propose(proposeInput({estimatedInputTokens:2_000_000,contextWindow:null}));
    assert.equal(reservation.maxOutputTokens,512);
});

// —— P1-6 归因 ——

test('gate rejection is attributed once as non-retryable CONTEXT_LIMIT_EXCEEDED', () => {
    markGateRejection('预计输入840572超过上下文预算（窗口1000000，预留16384），请整理上下文或缩小输入');
    const failure=takeGateRejection();
    assert.deepEqual(
        failure && {code:failure.code,retryable:failure.retryable},
        {code:'CONTEXT_LIMIT_EXCEEDED',retryable:false});
    assert.ok(failure?.message.includes('请整理上下文'));
    assert.equal(takeGateRejection(),null);
});

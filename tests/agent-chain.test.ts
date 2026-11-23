import Fastify from 'fastify';
import {registerRunRoutes} from '../src/agent/runRoutes.js';
import {ApiError} from '../contracts/errors.js';
import {deleteArchivedConversation} from '../src/projects/archive.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, chmodSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { randomUUID,createHash } from 'node:crypto';
import { Db } from '../src/storage/db.js';
import { migrate, defaultMigrationsDir } from '../src/storage/migrate.js';
import { TicketRegistry } from '../src/agent/tickets.js';
import { ModelRequestRegistry } from '../src/agent/modelRequests.js';
import { ModelGatewayServer } from '../src/agent/gatewayServer.js';
import { Supervisor } from '../src/agent/supervisor.js';
import { CredentialVault } from '../src/models/vault.js';
import { saveAttachment } from '../src/agent/attachments.js';
import { RUNTIME_STREAM_PROFILE } from '../src/models/streamNetwork.js';

// —— 普通Agent真实执行链集成测试（计划v1.6 §12里程碑#1） ——
// 真实runner子进程 + 真实Pi会话 + 真实网关HTTP + 受控本机HTTPS上游（脚本化OpenAI SSE）。
// 验证：目标→模型→工具(经监督器门禁+broker写真实文件)→观察→继续→自然答复→Run成功→用量与事件。

const here = dirname(fileURLToPath(import.meta.url));
const runnerEntry = fileURLToPath(new URL('../src/agent/runnerMain.js', import.meta.url));

interface UpstreamState { memoryFailure?:'selector'|'extraction'|'slow-extraction'; researchInvalidOnce?:boolean; researchInvalidAlways?:boolean; mode: 'tool_then_done' | 'slow' | 'error' | 'history' | 'research' | 'memory'; requests: string[];failure?:{status:number;message:string};subagentMode?:'reply'|'slow'|'loop';subagentAborted?:boolean;usageTokens?:number;customTool?:{name:string;args:Record<string,unknown>};toolQueue?:Array<{name:string;args:Record<string,unknown>}> }

function sseData(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunk(delta: Record<string, unknown>, finishReason?: string, usage?: Record<string, unknown>): string {
  const body: Record<string, unknown> = { id: 'chatcmpl-x', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason: finishReason ?? null }] };
  if (usage) body.usage = usage;
  return sseData(body);
}

const FAKE_USAGE = { prompt_tokens: 120, completion_tokens: 24, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } };

async function httpsFixture(t: { after(fn: () => unknown): unknown }, state: UpstreamState): Promise<{ server: Server; baseUrl: string; certPem: string }> {
  const dir = mkdtempSync(join(tmpdir(), 't05-upstream-'));
  const cert = join(dir, 'cert.pem'), key = join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert,
    '-days', '2', '-nodes', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const certPem = readFileSync(cert, 'utf8');
  const server = createHttpsServer({ key: readFileSync(key, 'utf8'), cert: certPem }, (req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
    req.on('end', () => {
      state.requests.push(body);
      if(state.memoryFailure&&((state.memoryFailure==='selector'&&body.includes('选择明确有助于当前用户问题的记忆'))||(state.memoryFailure!=='selector'&&body.includes('你现在是项目记忆提炼代理')))){
        if(state.memoryFailure==='slow-extraction'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(chunk({content:'正在提炼'}));const timer=setInterval(()=>res.write(chunk({content:'…'})),300);res.on('close',()=>clearInterval(timer));return;}
        res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'memory fixture unavailable'}}));return;
      }
      const usage={...FAKE_USAGE,prompt_tokens:state.usageTokens??FAKE_USAGE.prompt_tokens};
      if (state.mode === 'error' || req.headers.authorization !== 'Bearer sk-test') { res.writeHead(state.failure?.status??401,{'content-type':'application/json'}); res.end(JSON.stringify({error:{message:state.failure?.message??'fixture authorization rejected'}})); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      if (state.mode === 'history') { res.write(chunk({role:'assistant',content:body.includes('[平台重新回答]')?'重新生成的完整答复':body.includes('PERSISTED_MEMORY_WORD')?'PERSISTED_MEMORY_WORD':'MISSING_CONTEXT'},'stop',usage)); res.end('data: [DONE]\n\n'); return; }
      if (state.mode === 'slow') {
        // 永不完成的慢流：周期发文本增量，不给finish_reason
        let n = 0;
        const timer = setInterval(() => {
          try { res.write(chunk({ content: '…' })); n += 1; if (n > 600) clearInterval(timer); } catch { clearInterval(timer); }
        }, 100);
        timer.unref?.();
        req.on('close', () => clearInterval(timer));
        return;
      }
      let parsed: { messages?: Array<{ role?: string; content?: unknown }>;tools?:Array<{function?:{name?:string}}> };
      try { parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }>;tools?:Array<{function?:{name?:string}}> }; }
      catch { parsed = {}; }
      if(state.mode==='memory'&&body.includes('选择明确有助于当前用户问题的记忆')){
        res.write(chunk({role:'assistant',content:JSON.stringify({selected_memories:['preference.md']})},'stop',usage));res.end('data: [DONE]\n\n');return;
      }
      if(state.mode==='memory'&&body.includes('你现在是项目记忆提炼代理')){
        if(!(parsed.messages??[]).some(m=>m.role==='tool'))res.write(chunk({role:'assistant',tool_calls:[{index:0,id:'extract-1',type:'function',function:{name:'memory_write',arguments:JSON.stringify({path:'automatic.md',content:'---\nname: automatic\ndescription: 提炼得到的偏好\nmetadata:\n  type: feedback\n---\nAUTO_MEMORY_SENTINEL'})}}]},'tool_calls',usage));
        else res.write(chunk({role:'assistant',content:'已保存记忆'},'stop',usage));
        res.end('data: [DONE]\n\n');return;
      }
      if(state.mode==='research') {
        const prompts=(parsed.messages??[]).filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.map((x:{text?:string})=>x.text??'').join(''):JSON.stringify(m.content));
        const prompt=prompts.find(p=>p.includes('执行身份：'))??'';
        const label=/执行身份：([^；]+)/.exec(prompt)?.[1]??'unknown';
        let records:Array<{id:string;kind:string;content:string}>=[];
        try{const material=JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n')+2));records=Array.isArray(material)?material:material.records;}catch{ /* assertions below expose malformed input */ }
        const source=records.find(r=>r.kind==='source');
        if(!(parsed.messages??[]).some(m=>m.role==='tool')&&source){
          // toolQueue：按发起顺序逐阶段出队（研究场景多工具直测）；缺省回落customTool/默认research_read
          const toolChoice=state.toolQueue?.length?state.toolQueue.shift()!:{name:state.customTool?.name??'research_read',args:state.customTool?.args??{recordId:source.id}};
          res.write(chunk({role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:toolChoice.name,arguments:JSON.stringify(toolChoice.args)}}]},'tool_calls',usage));
        }else{
          const claims=records.filter(r=>r.kind==='statement').flatMap(r=>JSON.parse(r.content).claims);
          const v2=prompt.includes('research-v2');
          const taskCard=prompt.startsWith('[研究任务卡 ');
          const extra:Record<string,unknown>={};
          if(v2&&label.startsWith('juror')){
            const criteria=JSON.parse((taskCard ? /^评审标准（mustHave=true为必达条件）：(\[.*\])。$/m : /评审标准（mustHave=true为必达条件）：(\[.*?\])。/).exec(prompt)?.[1]??'[]') as Array<{id:string;mustHave:boolean}>;
            const judge=label==='juror1'?'insufficient':'pass';
            extra.verdict=judge;
            extra.criterionEvaluations=criteria.map(c=>({criterionId:c.id,status:judge==='pass'&&c.mustHave?'satisfied':'insufficient',reason:'合成验收'}));
          }
          if(v2&&label==='host'&&prompt.includes('本议题需要做出决定')){
            const candidates=JSON.parse((taskCard ? /^候选方案（ID：文本）：(\[.*\])$/m : /候选方案（ID：文本）：(\[.*?\])。/).exec(prompt)?.[1]??'[]') as Array<{id:string}>;
            extra.disposition={kind:'adopt',candidateId:candidates[0]?.id,hardConstraints:'合成硬约束',basisClaimIds:claims.slice(0,4).map((c:{id:string})=>c.id)};
          }
          if(v2&&label==='aggregate'){extra.blockingItems=[];extra.nextSteps=['合成下一步'];}
          const output={text:label==='host'?'HOST_SENTINEL：证据与反证需要保留。':`${label}独立分析`,claims:source?[{key:'c1',text:'样本有限',evidence:[{sourceId:source.id,quote:'样本只有两组'}],respondsTo:label==='pro'||label==='con'?claims.slice(-1).map((c:{id:string})=>c.id):[]}]:[],limitations:['需要更多样本'],...(label==='host'?{objections:claims.map((c:{id:string})=>({claimId:c.id,resolution:'unresolved',reason:'样本有限'}))}:{}),...(label.startsWith('juror')&&!v2?{verdict:label==='juror1'?'insufficient':'con'}:{}),...(v2&&(label==='host'||label==='aggregate')?{summary:`${label}摘要`}:{}),...extra};
          res.write(chunk({role:'assistant',content:JSON.stringify(state.researchInvalidOnce||state.researchInvalidAlways?{...output,claims:[{key:'bad',text:'bad',evidence:[{sourceId:'unknown',quote:'fake'}]}]}:output)},'stop',usage));
          state.researchInvalidOnce=false;
        }
        res.end('data: [DONE]\n\n');return;
      }
      if(state.customTool?.name==='agent'&&!parsed.tools?.some(t=>t.function?.name==='agent')){
        if(state.subagentMode==='slow'){
          res.write(chunk({role:'assistant',content:'正在核对'}));
          const timer=setInterval(()=>res.write(chunk({content:'…'})),500);
          res.on('close',()=>{clearInterval(timer);state.subagentAborted=true;});return;
        }
        if(state.subagentMode==='loop'){
          res.write(chunk({role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'AGENTS.md'})}}]},'tool_calls',usage));
        }else res.write(chunk({role:'assistant',content:'子代理核对完成'},'stop',usage));
        res.end('data: [DONE]\n\n');return;
      }
      const hasToolResult = (parsed.messages ?? []).some(m => m.role === 'tool');
      void (async () => {
        if (hasToolResult) {
          // 第二轮：文本答复+usage（分片发送形成有效测速窗口）
          res.write(chunk({ role: 'assistant', content: '' }));
          for (const piece of ['已经', '完成：', 'hello.txt 已写入项目目录。']) {
            await new Promise(r => setTimeout(r, 120));
            res.write(chunk({ content: piece }));
          }
          res.write(chunk({}, 'stop', usage));
          res.end('data: [DONE]\n\n');
        }
        else {
          // 第一轮：要求写文件（经网关→runner代理→监督器门禁→broker）
          await new Promise(r => setTimeout(r, 80));
          res.write(chunk({ role: 'assistant', content: '' }));
          res.write(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: state.customTool?.name??'write_file', arguments: '' } }] }));
          await new Promise(r => setTimeout(r, 60));
          res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(state.customTool?.args??{path:'hello.txt',content:'hi'}) } }] }));
          res.write(chunk({}, 'tool_calls', usage));
          res.end('data: [DONE]\n\n');
        }
      })();
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const port = (server.address() as { port: number }).port;
  t.after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { server, baseUrl: `https://127.0.0.1:${port}`, certPem };
}

interface Harness {
  db: Db; supervisor: Supervisor; gateway: ModelGatewayServer;
  dataDir: string; projectDir: string; userId: string; projectId: string;
  modelConfigId: string; sessionId: string;
  close(): Promise<void>;
}

async function buildHarness(t: { after(fn: () => unknown): unknown }, upstream: { baseUrl: string; certPem: string }, memoryEnabled=false): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 't05-data-'));
  const projectDir = mkdtempSync(join(tmpdir(), 't05-project-'));
  writeFileSync(join(projectDir, 'AGENTS.md'), '# 测试项目规则\n保持文件小而清晰。\n');
  const db = new Db(join(dataDir, 'workbench.sqlite'));
  migrate(db, defaultMigrationsDir());
  const now = new Date().toISOString();
  const userId = randomUUID(), projectId = randomUUID(), modelConfigId = randomUUID();
  db.db.prepare(`INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at)
    VALUES (?,?,?,'','',0,?,?)`).run(userId, 'tester', 'x', now, now);
  db.db.prepare('INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(projectId, userId, '链路测试项目', now, now);
  db.db.prepare(`INSERT INTO workspace_grants(id,project_id,canonical_root,access,revision,selected_by,excludes_json,created_at,updated_at)
    VALUES (?,?,?,'write',1,?,'[]',?,?)`).run(randomUUID(), projectId, projectDir, userId, now, now);
  db.db.prepare(`INSERT INTO model_configs(id,owner_user_id,preset,name,base_url,api_protocol,revision,enabled,search_provider,created_at,updated_at)
    VALUES (?,?,?,?,?,'openai-completions',1,1,'zhipu',?,?)`)
    .run(modelConfigId, userId, 'openai', '测试上游', upstream.baseUrl, now, now);
  db.db.prepare(`INSERT INTO model_entries(id,config_id,model_id,display_name,parameters_json,enabled,created_at,updated_at)
    VALUES (?,?,?,'测试模型','{"contextWindow":16384,"maxOutputTokens":1024}',1,?,?)`)
    .run(randomUUID(), modelConfigId, 'test-model', now, now);

  const sessionId = 'sess-chain-test';
  const vault = new CredentialVault();
  vault.set(sessionId, modelConfigId, 'sk-test', new Date(Date.now() + 3600_000).toISOString());
  const tickets = new TicketRegistry(db);
  const registry = new ModelRequestRegistry(db, runId => {
    const row = db.db.prepare('SELECT status, cancel_requested_at FROM runs WHERE id=?').get(runId) as
      { status: string; cancel_requested_at: string | null } | undefined;
    return !!row && (row.status === 'cancelling' || !!row.cancel_requested_at);
  });
  const gateway = new ModelGatewayServer({
    db, tickets, registry, vault,
    bindingOf: attemptId => supervisor.bindingFor(attemptId),
    abortOf: attemptId => supervisor.abortSignalFor(attemptId),
    profile: { ...RUNTIME_STREAM_PROFILE, caCertPem: upstream.certPem, allowLoopbackForTest: true },
  });
  const supervisor: Supervisor = new Supervisor({
    db, dataDir, tickets, registry, vault, gateway,
    runnerEntry, nodePath: process.execPath,
    bindingCaCertPem: upstream.certPem,
  });
  // Legacy chain fixtures test foreground behavior; memory has dedicated end-to-end scenarios below.
  const runtimeSettings=supervisor.runtimeSettings.bind(supervisor);
  supervisor.runtimeSettings=userId=>({...runtimeSettings(userId),memoryEnabled:memoryEnabled&&runtimeSettings(userId).memoryEnabled!==false});
  await gateway.ready;
  const close = async (): Promise<void> => {
    await supervisor.stop();
    await gateway.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  };
  t.after(close);
  return { db, supervisor, gateway, dataDir, projectDir, userId, projectId, modelConfigId, sessionId, close };
}

function waitForStatus(db: Db, runId: string, statuses: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const row = db.db.prepare('SELECT status FROM runs WHERE id=?').get(runId) as { status: string } | undefined;
      if (row && statuses.includes(row.status)) { clearInterval(timer); resolve(row.status); }
      else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        const events = db.db.prepare('SELECT seq,type,payload_json FROM run_events ORDER BY seq').all() as unknown as Array<{ seq: number; type: string; payload_json: string }>;
        reject(new Error(`等待状态${statuses.join('/')}超时；当前=${row?.status ?? '无'}；事件=${events.map(e => `${e.seq}:${e.type}`).join(',')}`));
      }
    }, 400);
    timer.unref?.();
  });
}

test('结构化报错验收：真实runner分类帧、运行与attempt落库一致，原地重试可恢复', async t=>{
 const state:UpstreamState={mode:'error',requests:[]};
 const upstream=await httpsFixture(t,state),h=await buildHarness(t,upstream);
 const cases=[
  {status:401,message:'Invalid API key provided',code:'CREDENTIAL_REQUIRED',retryable:false},
  {status:429,message:'You exceeded your current quota, please check your plan and billing details.',code:'MODEL_QUOTA_EXCEEDED',retryable:false},
  {status:429,message:'Too many requests, please slow down',code:'PROVIDER_RATE_LIMIT',retryable:true},
  {status:504,message:'Request timed out',code:'MODEL_TIMEOUT',retryable:true},
  {status:502,message:'Bad Gateway',code:'PROVIDER_ERROR',retryable:true},
  {status:400,message:'Malformed request body',code:'PROVIDER_ERROR',retryable:false},
  {status:400,message:"This model's maximum context length is 16384 tokens. However, you requested 20000 tokens.",code:'CONTEXT_LIMIT_EXCEEDED',retryable:false},
 ];
 for(const sample of cases){await t.test(sample.code+': '+sample.status,async()=>{
  state.mode='error';state.failure=sample;
  const created=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'检查错误后恢复',modelConfigId:h.modelConfigId,modelId:'test-model'});
  assert.equal(await waitForStatus(h.db,created.runId,['failed','succeeded','needs_reconciliation'],30_000),'failed');
  const run=h.db.db.prepare('SELECT stop_reason FROM runs WHERE id=?').get(created.runId)!;
  const attempt=h.db.db.prepare('SELECT a.id,a.status,a.error_code FROM attempts a JOIN phase_tasks pt ON pt.active_attempt_id=a.id WHERE pt.run_id=?').get(created.runId)!;
  assert.equal(run.stop_reason,sample.code);assert.equal(attempt.error_code,sample.code);assert.equal(attempt.status,'failed');
  const failures=h.db.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='run.failed'").all(created.runId);
  assert.equal(failures.length,1);const payload=JSON.parse(String(failures[0]!.payload_json));
  assert.equal(payload.error,sample.code);assert.equal(payload.retryable===true,sample.retryable);assert.ok(payload.message.includes(sample.message));
  if(sample.status===400)assert.equal(h.db.db.prepare("SELECT COUNT(*) n FROM run_events WHERE run_id=? AND type='run.retry_scheduled' AND json_extract(payload_json,'$.source')='supervisor'").get(created.runId)!.n,0);
  if(sample.status===401){
   for(let i=0;i<100&&h.db.db.prepare("SELECT 1 FROM worker_instances WHERE attempt_id=? AND state IN ('starting','running','stopping')").get(String(attempt.id));i++)await new Promise(r=>setTimeout(r,50));
   const counts=()=>['runs','conversations'].map(table=>h.db.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n),before=counts();
   state.mode='history';delete state.failure;
   const result=await h.supervisor.retryFailedRun(created.runId,h.userId,h.sessionId,String(attempt.id));
   assert.notEqual(result.attemptId,attempt.id);assert.deepEqual(counts(),before);
   assert.equal(await waitForStatus(h.db,created.runId,['succeeded','failed'],30_000),'succeeded');
   assert.equal(h.db.db.prepare("SELECT count(*) n FROM messages WHERE run_id=? AND author_type='user'").get(created.runId)!.n,1);
  }
 });}
 await t.test('SIGKILL仍归RUNNER_EXITED',async()=>{
  state.mode='slow';delete state.failure;const requestsBefore=state.requests.length;
  const created=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'检查执行进程强制中断',modelConfigId:h.modelConfigId,modelId:'test-model'});
  const activeWorker=h.db.db.prepare("SELECT w.pid FROM worker_instances w JOIN attempts a ON a.id=w.attempt_id JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=? AND w.state='running'");
  for(let i=0;i<100&&(state.requests.length===requestsBefore||!activeWorker.get(created.runId));i++)await new Promise(r=>setTimeout(r,50));
  assert.ok(state.requests.length>requestsBefore);
  const worker=activeWorker.get(created.runId);
  assert.ok(worker?.pid, '执行进程应已登记为运行中');
  process.kill(Number(worker.pid),'SIGKILL');
  assert.equal(await waitForStatus(h.db,created.runId,['failed','needs_reconciliation'],30_000),'failed');
  assert.equal(h.db.db.prepare('SELECT stop_reason FROM runs WHERE id=?').get(created.runId)!.stop_reason,'RUNNER_EXITED');
  const payload=JSON.parse(String(h.db.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='run.failed'").get(created.runId)!.payload_json));
  assert.equal(payload.error,'RUNNER_EXITED');assert.equal(payload.signal,'SIGKILL');
 });
});

test('纵向链路：目标→真实runner→工具写真实文件→自然答复→Run成功+用量', async t => {
  const state: UpstreamState = { mode: 'tool_then_done', requests: [] };
  const upstream = await httpsFixture(t, state);
  const h = await buildHarness(t, upstream);

  const created = h.supervisor.createOrdinaryRun({
    userId: h.userId, sessionId: h.sessionId, projectId: h.projectId,
    conversationId: null,
    objective: '请在项目目录创建hello.txt，内容为hi，然后告诉我完成。',
    modelConfigId: h.modelConfigId, modelId: 'test-model',
  });
  assert.equal(created.waitingInput, false);
  const finalStatus = await waitForStatus(h.db, created.runId, ['succeeded', 'failed', 'cancelled', 'needs_reconciliation'], 90_000);
  assert.equal(finalStatus, 'succeeded');

  // 真实文件落盘（broker写入项目根，不是scratch）
  assert.ok(existsSync(join(h.projectDir, 'hello.txt')), 'hello.txt应写入授权项目目录');
  assert.equal(readFileSync(join(h.projectDir, 'hello.txt'), 'utf8'), 'hi');

  // 消息：用户目标 + agent自然答复
  const run = h.db.db.prepare('SELECT conversation_id, stop_reason FROM runs WHERE id=?').get(created.runId) as { conversation_id: string; stop_reason: string };
  const messages = h.db.db.prepare(`SELECT author_type, content_json FROM messages WHERE conversation_id=? ORDER BY seq`).all(run.conversation_id) as unknown as Array<{ author_type: string; content_json: string }>;
  assert.ok(messages.length >= 2, `应有用户+agent消息，实际${messages.length}`);
  assert.equal(messages[0]!.author_type, 'user');
  const last = messages[messages.length - 1]!;
  assert.equal(last.author_type, 'agent');
  assert.ok((JSON.parse(last.content_json) as { text: string }).text.includes('完成'), '最终答复应为自然语言');

  // 用量：每请求一条usage（provider口径，非估算）
  const usage = h.db.db.prepare('SELECT request_id, input_tokens, output_tokens, usage_source, speed_valid, status FROM usage_entries WHERE run_id=?').all(created.runId) as unknown as Array<{ input_tokens: number; output_tokens: number; usage_source: string; speed_valid: number; status: string }>;
  assert.ok(usage.length >= 2, `应有≥2条用量，实际${usage.length}`);
  for (const row of usage) {
    assert.equal(row.status, 'completed');
    assert.equal(row.usage_source, 'provider');
    assert.ok(row.input_tokens > 0 && row.output_tokens > 0);
  }
  assert.ok(usage.some(u => u.speed_valid === 1), '应存在有效测速样本（分片流>200ms）');

  // 模型请求登记全部终结且只调用上游两次
  const requests = h.db.db.prepare(`SELECT state FROM model_requests WHERE run_id=?`).all(created.runId) as unknown as Array<{ state: string }>;
  assert.ok(requests.length >= 2);
  assert.ok(requests.every(r => r.state === 'completed'), `model_requests应全部completed：${JSON.stringify(requests)}`);
  assert.equal(state.requests.length, 2);

  // 事件：工具经门禁执行并公开可见
  const events = h.db.db.prepare(`SELECT type FROM run_events WHERE run_id=? AND visibility='public'`).all(created.runId) as unknown as Array<{ type: string }>;
  const types = new Set(events.map(e => e.type));
  for (const expected of ['run.started', 'tool.started', 'tool.completed', 'message.completed', 'run.succeeded']) {
    assert.ok(types.has(expected), `缺少事件${expected}（实际：${[...types].join(',')}）`);
  }
  // 归档永久删除覆盖真实runner生成的完整关系图，而非只删一个空会话。
  for(let i=0;i<50;i++){
    const live=h.db.db.prepare(`SELECT COUNT(*) n FROM worker_instances WHERE state IN ('starting','running','stopping')`).get() as {n:number};
    if(!live.n)break;await new Promise(r=>setTimeout(r,100));
  }
  h.db.db.prepare('UPDATE conversations SET archived_at=? WHERE id=?').run(new Date().toISOString(),run.conversation_id);
  deleteArchivedConversation(h.db,h.userId,run.conversation_id);
  assert.equal(h.db.db.prepare('SELECT id FROM runs WHERE id=?').get(created.runId),undefined);
  assert.equal(h.db.db.prepare('SELECT id FROM conversations WHERE id=?').get(run.conversation_id),undefined);
  assert.equal((h.db.db.prepare('PRAGMA foreign_key_check').all()).length,0,'删除后没有悬空外键');
  assert.equal(readFileSync(join(h.projectDir,'hello.txt'),'utf8'),'hi','删除任务历史不得删除或改写项目文件');
});

test('取消：运行中撤票+终止进程组→cancelled；上游流中止', async t => {
  const state: UpstreamState = { mode: 'slow', requests: [] };
  const upstream = await httpsFixture(t, state);
  const h = await buildHarness(t, upstream);
  const created = h.supervisor.createOrdinaryRun({
    userId: h.userId, sessionId: h.sessionId, projectId: h.projectId,
    conversationId: null, objective: '慢慢写一段长文。',
    modelConfigId: h.modelConfigId, modelId: 'test-model',
  });
  await waitForStatus(h.db, created.runId, ['running'], 30_000);
  // 等待首个上游请求真实发出
  await new Promise(r => setTimeout(r, 1_500));
  assert.ok(state.requests.length >= 1, '取消前应已发出上游请求');
  const cancelled = await h.supervisor.cancelRun(created.runId, 'user_requested');
  assert.equal(cancelled, true);
  const finalStatus = await waitForStatus(h.db, created.runId, ['cancelled', 'needs_reconciliation'], 30_000);
  assert.equal(finalStatus, 'cancelled', '应确认清理后进入cancelled');
  // attempt与worker实例终结
  const attempt = h.db.db.prepare(`SELECT a.status FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=?`).get(created.runId) as { status: string };
  assert.equal(attempt.status, 'cancelled');
  const worker = h.db.db.prepare(`SELECT wi.state FROM worker_instances wi JOIN attempts a ON a.id=wi.attempt_id JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=?`).get(created.runId) as { state: string };
  assert.equal(worker.state, 'stopped');
});


test('上游认证失败必须标记Run失败，不能用空答复冒充成功', async t => {
 const state: UpstreamState={mode:'error',requests:[]};const upstream=await httpsFixture(t,state);const h=await buildHarness(t,upstream);
 const created=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'请创建文件，失败时必须如实报告。',modelConfigId:h.modelConfigId,modelId:'test-model'});
 const status=await waitForStatus(h.db,created.runId,['succeeded','failed','cancelled','needs_reconciliation'],30000);
 assert.equal(status,'failed');
 const successes=h.db.db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id=? AND type='run.succeeded'").get(created.runId) as {n:number};assert.equal(successes.n,0);
});


test('同会话追问从持久消息恢复上下文，跨项目会话不能复用', async t => {
 const state: UpstreamState={mode:'history',requests:[]};const upstream=await httpsFixture(t,state);const h=await buildHarness(t,upstream);
 const first=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'请记住PERSISTED_MEMORY_WORD，不调用工具。',modelConfigId:h.modelConfigId,modelId:'test-model'});
 assert.equal(await waitForStatus(h.db,first.runId,['succeeded','failed'],30000),'succeeded');
 const second=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:first.conversationId,objective:'刚才让你记住的词是什么？',modelConfigId:h.modelConfigId,modelId:'test-model'});
 assert.equal(await waitForStatus(h.db,second.runId,['succeeded','failed'],30000),'succeeded');
 const request=JSON.parse(state.requests[state.requests.length-1]!) as {messages:Array<{role:string;content:unknown}>};
 assert.ok(request.messages.some(m=>m.role==='assistant' && JSON.stringify(m.content).includes('PERSISTED_MEMORY_WORD')),'追问应携带持久化助手答复');
 assert.ok(request.messages.some(m=>m.role==='user' && JSON.stringify(m.content).includes('PERSISTED_MEMORY_WORD')),'追问应携带上一轮用户消息');
 const other=randomUUID(),now=new Date().toISOString();h.db.db.prepare('INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(other,h.userId,'其他项目',now,now);
 h.db.db.prepare("INSERT INTO workspace_grants(id,project_id,canonical_root,access,revision,selected_by,excludes_json,created_at,updated_at) VALUES (?,?,?,'read',1,?,'[]',?,?)").run(randomUUID(),other,h.projectDir,h.userId,now,now);
 assert.throws(()=>h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:other,conversationId:first.conversationId,objective:'不能跨项目',modelConfigId:h.modelConfigId,modelId:'test-model'}));
});

test('请求批准模式：普通文件写入也需确认，修改项目默认模式不能放行既有任务',async t=>{
 const state:UpstreamState={mode:'tool_then_done',requests:[]};const h=await buildHarness(t,await httpsFixture(t,state));
 const created=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'创建hello.txt',modelConfigId:h.modelConfigId,modelId:'test-model',approvalMode:'ask'});
 assert.equal(await waitForStatus(h.db,created.runId,['waiting_approval','failed'],40000),'waiting_approval');
 assert.equal(existsSync(join(h.projectDir,'hello.txt')),false);
 h.db.db.prepare("UPDATE projects SET approval_mode='full' WHERE id=?").run(h.projectId);
 const a=h.db.db.prepare("SELECT id FROM approvals WHERE state='pending'").get() as {id:string};assert.ok(a);
 const reviewApp=Fastify();registerRunRoutes(reviewApp,{db:h.db,dataDir:h.dataDir,supervisor:h.supervisor},()=>({userId:h.userId}));t.after(()=>reviewApp.close());
 const visible=await reviewApp.inject({url:`/api/v1/runs/${created.runId}/approvals`});
 assert.equal(visible.statusCode,200);assert.equal(visible.json().data.approvals[0].review.text,'hi');assert.equal(visible.json().data.approvals[0].canonicalArgsJson,undefined,'原始参数只经明确review入口按白名单显示');
 const fullReview=await reviewApp.inject({url:`/api/v1/runs/${created.runId}/approvals/${a.id}/review`});assert.equal(fullReview.statusCode,200);assert.equal(fullReview.body,'hi');assert.ok(String(fullReview.headers['content-type']).startsWith('text/plain'));
 const otherApp=Fastify();otherApp.setErrorHandler((err,_req,reply)=>reply.code(err instanceof ApiError?err.status:500).send({error:'denied'}));registerRunRoutes(otherApp,{db:h.db,dataDir:h.dataDir,supervisor:h.supervisor},()=>({userId:'another-user'}));t.after(()=>otherApp.close());
 assert.equal((await otherApp.inject({url:`/api/v1/runs/${created.runId}/approvals/${a.id}/review`})).statusCode,404);

 assert.equal(existsSync(join(h.projectDir,'hello.txt')),false,'项目默认模式变化不得自动批准正在等待的工具');
 h.supervisor.decideApproval(a.id,'approved',h.userId);await h.supervisor.executeApproved(created.runId,a.id);
 assert.equal(await waitForStatus(h.db,created.runId,['succeeded','failed'],40000),'succeeded');
 assert.equal(readFileSync(join(h.projectDir,'hello.txt'),'utf8'),'hi');
 const tools=(await reviewApp.inject({url:`/api/v1/runs/${created.runId}/tools`})).json().data.tools;
 assert.equal(tools[0].args.path,'hello.txt');assert.equal(tools[0].state,'succeeded');
 const toolResult=await reviewApp.inject({url:`/api/v1/runs/${created.runId}/tools/${tools[0].invocationId}`});assert.equal(toolResult.statusCode,200);assert.ok(toolResult.json().data.preview);
 assert.equal((await otherApp.inject({url:`/api/v1/runs/${created.runId}/tools/${tools[0].invocationId}`})).statusCode,404);
 const r=h.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(created.runId) as {config_snapshot_json:string};assert.equal(JSON.parse(r.config_snapshot_json).approvalMode,'ask');
});

test('完全授权：删除无需再批准，审批模式按任务启动时冻结',async t=>{
 const state:UpstreamState={mode:'tool_then_done',requests:[],customTool:{name:'delete_file',args:{path:'hello.txt',expected_hash:createHash('sha256').update('hi').digest('hex')}}};
 const h=await buildHarness(t,await httpsFixture(t,state));writeFileSync(join(h.projectDir,'hello.txt'),'hi');
 const created=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'删除hello.txt',modelConfigId:h.modelConfigId,modelId:'test-model',approvalMode:'full'});
 h.db.db.prepare("UPDATE projects SET approval_mode='ask' WHERE id=?").run(h.projectId);
 assert.equal(await waitForStatus(h.db,created.runId,['succeeded','failed','waiting_approval'],40000),'succeeded');
 assert.equal(existsSync(join(h.projectDir,'hello.txt')),false);assert.equal((h.db.db.prepare('SELECT COUNT(*) n FROM approvals').get() as {n:number}).n,0);
});

test('请求批准模式读取无需审批；旧只读标记不再限制本机文件写入',async t=>{
 const readState:UpstreamState={mode:'tool_then_done',requests:[],customTool:{name:'read_file',args:{path:'AGENTS.md'}}};
 const h=await buildHarness(t,await httpsFixture(t,readState));
 const first=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'读取规则',modelConfigId:h.modelConfigId,modelId:'test-model',approvalMode:'ask'});
 assert.equal(await waitForStatus(h.db,first.runId,['succeeded','failed','waiting_approval'],40000),'succeeded');
 assert.equal((h.db.db.prepare('SELECT COUNT(*) n FROM approvals').get() as {n:number}).n,0);
 const writeState:UpstreamState={mode:'tool_then_done',requests:[]};const h2=await buildHarness(t,await httpsFixture(t,writeState));
 h2.db.db.prepare("UPDATE workspace_grants SET access='read' WHERE project_id=?").run(h2.projectId);
 const second=h2.supervisor.createOrdinaryRun({userId:h2.userId,sessionId:h2.sessionId,projectId:h2.projectId,conversationId:null,objective:'尝试写文件',modelConfigId:h2.modelConfigId,modelId:'test-model',approvalMode:'full'});
 await waitForStatus(h2.db,second.runId,['succeeded','failed'],40000);
 assert.equal(readFileSync(join(h2.projectDir,'hello.txt'),'utf8'),'hi','本机访问模式不再应用旧目录只读限制');
 const written=h2.db.db.prepare("SELECT state FROM tool_invocations WHERE run_id=? AND tool_name='write_file'").get(second.runId) as {state:string};assert.equal(written.state,'succeeded');
});

test('等待批准期间的新补充优先：批准旧操作不能绕过未消费输入门禁',async t=>{
 const state:UpstreamState={mode:'tool_then_done',requests:[]};const h=await buildHarness(t,await httpsFixture(t,state));
 const created=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'创建hello.txt',modelConfigId:h.modelConfigId,modelId:'test-model',approvalMode:'ask'});
 assert.equal(await waitForStatus(h.db,created.runId,['waiting_approval','failed'],40000),'waiting_approval');
 const a=h.db.db.prepare("SELECT id FROM approvals WHERE state='pending'").get() as {id:string};
 h.supervisor.steer(created.runId,h.userId,'先不要写文件，请处理这条新补充。','pending-before-approval');
 h.supervisor.decideApproval(a.id,'approved',h.userId);await h.supervisor.executeApproved(created.runId,a.id);
 assert.equal(await waitForStatus(h.db,created.runId,['succeeded','failed'],40000),'succeeded');
 assert.equal(existsSync(join(h.projectDir,'hello.txt')),false);
 const invocation=h.db.db.prepare("SELECT state,error_code FROM tool_invocations WHERE run_id=? AND tool_name='write_file'").get(created.runId) as {state:string;error_code:string};
 assert.equal(invocation.state,'cancelled');assert.equal(invocation.error_code,'DEFERRED_BY_USER_INPUT');
 assert.ok(state.requests.at(-1)?.includes('先不要写文件'));
});


test('runtime settings real runner: temperature0 freeze, stable full messages, queued manual compaction confirms actual sources',async t=>{
 const state:UpstreamState={mode:'history',requests:[]};const upstream=await httpsFixture(t,state);const h=await buildHarness(t,upstream);
 h.db.db.prepare("UPDATE model_entries SET model_id='gpt-4o',parameters_json=? WHERE config_id=?").run(JSON.stringify({temperature:0,contextWindow:65536,maxOutputTokens:16000,thinkingMode:'off'}),h.modelConfigId);
 h.db.db.prepare('INSERT INTO agent_runtime_settings(user_id,settings_json,updated_at) VALUES (?,?,?)').run(h.userId,JSON.stringify({autoCompaction:false,keepRecentTurns:1}),new Date().toISOString());
 const input={userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,modelConfigId:h.modelConfigId,modelId:'gpt-4o',objective:'PERSISTED_MEMORY_WORD'};
 const first=h.supervisor.createOrdinaryRun({...input,conversationId:null});
 assert.equal(await waitForStatus(h.db,first.runId,['succeeded','failed'],90000),'succeeded');
 const now=new Date().toISOString();
 for(let i=0;i<8;i++){
 const seq=3+i;
 h.db.db.prepare("INSERT INTO messages(id,conversation_id,run_id,author_type,role_id,seq,visibility,state,content_json,consumed_cursor_json,created_at,updated_at) VALUES (?,?,?,?,'ordinary',?,'public','published',?,'{}',?,?)").run(randomUUID(),first.conversationId,first.runId,i%2===0?'user':'agent',seq,JSON.stringify({text:'PERSISTED_MEMORY_WORD '+('历史真实内容 '+i+' ').repeat(800)}),now,now);
 }
 h.db.db.prepare('UPDATE conversations SET last_message_seq=10 WHERE id=?').run(first.conversationId);
 const second=h.supervisor.createOrdinaryRun({...input,conversationId:first.conversationId});
 assert.deepEqual(h.supervisor.compactRun(second.runId,h.userId),{accepted:true,queued:true,duplicate:false});
 assert.equal(h.supervisor.compactRun(second.runId,h.userId).duplicate,true);
 assert.equal(await waitForStatus(h.db,second.runId,['succeeded','failed'],90000),'succeeded');
 const snapshot=JSON.parse((h.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(second.runId) as {config_snapshot_json:string}).config_snapshot_json);
 assert.equal(snapshot.parameters.requested.maxOutputTokens,16000);assert.equal(snapshot.parameters.effective.maxOutputTokens,16000);assert.equal(snapshot.parameters.effective.temperature,0);
 for(const body of state.requests){const parsed=JSON.parse(body);assert.equal(parsed.temperature,0);assert.equal(parsed.max_tokens,16000);}
 const cp=h.db.db.prepare("SELECT * FROM context_checkpoints WHERE run_id=? AND state='confirmed'").get(second.runId) as {kept_entry_ids_json:string;source_manifest_json:string}|undefined;
 const events=h.db.db.prepare('SELECT type,payload_json FROM run_events WHERE run_id=? ORDER BY seq').all(second.runId) as unknown as Array<{type:string;payload_json:string}>;
 assert.ok(cp,JSON.stringify(events.filter(e=>e.type.includes('compaction'))));
 const manifest=JSON.parse(cp.source_manifest_json);assert.ok(manifest.summarizedIds.length>0);assert.deepEqual(JSON.parse(cp.kept_entry_ids_json),manifest.keptIds);
 assert.equal((h.db.db.prepare("SELECT COUNT(*) n FROM model_requests WHERE run_id=? AND request_kind='compaction' AND state='completed'").get(second.runId) as {n:number}).n,1);
 const complete=events.filter(e=>e.type==='message.completed').map(e=>JSON.parse(e.payload_json));const final=complete.find(e=>e.role==='agent');const assistant=complete.find(e=>e.messageId===final.sourceAssistantMessageId);
 assert.ok(final.messageId);assert.equal(assistant.content,final.content);assert.ok(assistant.messageId);
 assert.throws(()=>h.supervisor.compactRun(second.runId,h.userId));
});


test('runtime safety: same-run tool claim excluded, compact preflight protects unconsumed input and cancellation',async t=>{
 const state:UpstreamState={mode:'slow',requests:[]};const upstream=await httpsFixture(t,state);const h=await buildHarness(t,upstream);
 const created=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'pending input',modelConfigId:h.modelConfigId,modelId:'test-model'});
 const active=h.supervisor.active.get(created.runId)!;
 assert.throws(()=>h.supervisor.compactRun(created.runId,'another-user'));
 const phase=(h.db.db.prepare('SELECT phase_task_id FROM attempts WHERE id=?').get(active.attemptId) as {phase_task_id:string}).phase_task_id;
 const now=new Date().toISOString();
 h.db.db.prepare("INSERT INTO tool_invocations(id,run_id,phase_task_id,attempt_id,call_key,tool_name,tool_version,args_hash,redacted_args_json,state,created_at,updated_at) VALUES (?,?,?,?,?,'read_file','v1','hash','{}','claimed',?,?)").run(randomUUID(),created.runId,phase,active.attemptId,'busy-tool',now,now);
 type Callback=(ok:boolean,payload?:unknown,error?:{code:string;message:string})=>void;
 const internal=h.supervisor as unknown as {handleToolProposed(active:unknown,payload:unknown,cb:Callback):Promise<void>;handleAgentFrame(active:unknown,frame:unknown,cb:Callback):Promise<void>};
 let code='';await internal.handleToolProposed(active,{toolName:'read_file',args:{path:'AGENTS.md'}},(_ok,_p,e)=>{code=e?.code??'';});assert.equal(code,'REQUEST_IN_PROGRESS');
 const sourceManifest={firstKeptEntryId:'b',summarizedIds:['a'],keptIds:['b'],previousCheckpointEntryId:null};
 await internal.handleAgentFrame(active,{method:'compaction_preflight',payload:{sourceManifest,inputThroughSeq:1}},(_ok,_p,e)=>{code=e?.code??'';});assert.equal(code,'REQUEST_IN_PROGRESS');
 assert.equal((h.db.db.prepare('SELECT COUNT(*) n FROM context_checkpoints WHERE run_id=?').get(created.runId) as {n:number}).n,0);
 await h.supervisor.cancelRun(created.runId,'test-cancel');
 assert.throws(()=>h.supervisor.compactRun(created.runId,h.userId));
 await internal.handleAgentFrame(active,{method:'compaction_preflight',payload:{}},(_ok,_p,e)=>{code=e?.code??'';});assert.equal(code,'REQUEST_IN_PROGRESS');
});
test('runtime settings auto compaction: threshold invokes metered summary and confirms actual sources',async t=>{
 const state:UpstreamState={mode:'history',requests:[]};const upstream=await httpsFixture(t,state);const h=await buildHarness(t,upstream);
 h.db.db.prepare("UPDATE model_entries SET model_id='gpt-4o',parameters_json=? WHERE config_id=?").run(JSON.stringify({temperature:0,contextWindow:65536,maxOutputTokens:16000,thinkingMode:'off'}),h.modelConfigId);
 h.db.db.prepare('INSERT INTO agent_runtime_settings(user_id,settings_json,updated_at) VALUES (?,?,?)').run(h.userId,JSON.stringify({autoCompaction:true,keepRecentTurns:1}),new Date().toISOString());
 const input={userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,modelConfigId:h.modelConfigId,modelId:'gpt-4o',objective:'PERSISTED_MEMORY_WORD'};
 const first=h.supervisor.createOrdinaryRun({...input,conversationId:null});
 assert.equal(await waitForStatus(h.db,first.runId,['succeeded','failed'],90000),'succeeded');
 const now=new Date().toISOString();
 for(let i=0;i<8;i++){
 const seq=3+i;
 h.db.db.prepare("INSERT INTO messages(id,conversation_id,run_id,author_type,role_id,seq,visibility,state,content_json,consumed_cursor_json,created_at,updated_at) VALUES (?,?,?,?,'ordinary',?,'public','published',?,'{}',?,?)").run(randomUUID(),first.conversationId,first.runId,i%2===0?'user':'agent',seq,JSON.stringify({text:'PERSISTED_MEMORY_WORD '+('历史真实内容 '+i+' ').repeat(800)}),now,now);
 }
 h.db.db.prepare('UPDATE conversations SET last_message_seq=10 WHERE id=?').run(first.conversationId);
 state.usageTokens=50000;
 const second=h.supervisor.createOrdinaryRun({...input,conversationId:first.conversationId});

 assert.equal(await waitForStatus(h.db,second.runId,['succeeded','failed'],90000),'succeeded');
 const snapshot=JSON.parse((h.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(second.runId) as {config_snapshot_json:string}).config_snapshot_json);
 assert.equal(snapshot.parameters.requested.maxOutputTokens,16000);assert.equal(snapshot.parameters.effective.maxOutputTokens,16000);assert.equal(snapshot.parameters.effective.temperature,0);
 for(const body of state.requests){const parsed=JSON.parse(body);assert.equal(parsed.temperature,0);assert.equal(parsed.max_tokens,16000);}
 const cp=h.db.db.prepare("SELECT * FROM context_checkpoints WHERE run_id=? AND state='confirmed'").get(second.runId) as {kept_entry_ids_json:string;source_manifest_json:string}|undefined;
 const events=h.db.db.prepare('SELECT type,payload_json FROM run_events WHERE run_id=? ORDER BY seq').all(second.runId) as unknown as Array<{type:string;payload_json:string}>;
 assert.ok(cp,JSON.stringify(events.filter(e=>e.type.includes('compaction'))));
 const manifest=JSON.parse(cp.source_manifest_json);assert.ok(manifest.summarizedIds.length>0);assert.deepEqual(JSON.parse(cp.kept_entry_ids_json),manifest.keptIds);
 assert.equal((h.db.db.prepare("SELECT COUNT(*) n FROM model_requests WHERE run_id=? AND request_kind='compaction' AND state='completed'").get(second.runId) as {n:number}).n,1);
 const complete=events.filter(e=>e.type==='message.completed').map(e=>JSON.parse(e.payload_json));const final=complete.find(e=>e.role==='agent');const assistant=complete.find(e=>e.messageId===final.sourceAssistantMessageId);
 assert.ok(final.messageId);assert.equal(assistant.content,final.content);assert.ok(assistant.messageId);
 assert.throws(()=>h.supervisor.compactRun(second.runId,h.userId));
});



test('本机访问：文件工具可在项目外创建、读取、修改和删除；命令直接写入项目外真实目录', async t => {
 const state:UpstreamState={mode:'tool_then_done',requests:[]};
 const h=await buildHarness(t,await httpsFixture(t,state));
 const outside=mkdtempSync(join(tmpdir(),'agent-outside-'));
 t.after(()=>rmSync(outside,{recursive:true,force:true}));
 const target=join(outside,'nested','外部文件.txt');
 const run=async(name:string,args:Record<string,unknown>,mode:'ask'|'full'='full')=>{
  state.customTool={name,args};
  return h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'操作合成的项目外测试文件',modelConfigId:h.modelConfigId,modelId:'test-model',approvalMode:mode});
 };
 const finish=async(id:string)=>{
  assert.equal(await waitForStatus(h.db,id,['succeeded','failed'],40000),'succeeded');
  const row=h.db.db.prepare('SELECT state,result_json FROM tool_invocations WHERE run_id=?').get(id) as {state:string;result_json:string};
  assert.equal(row.state,'succeeded');
  return row.result_json;
 };
 const create=await run('write_file',{path:target,content:'outside-v1'},'ask');
 assert.equal(await waitForStatus(h.db,create.runId,['waiting_approval','failed'],40000),'waiting_approval');
 assert.equal(existsSync(target),false,'确认之前不能写入');
 const approval=h.db.db.prepare("SELECT a.id FROM approvals a JOIN tool_invocations ti ON ti.id=a.invocation_id WHERE ti.run_id=?").get(create.runId) as {id:string};
 h.supervisor.decideApproval(approval.id,'approved',h.userId);await h.supervisor.executeApproved(create.runId,approval.id);
 await finish(create.runId);assert.equal(readFileSync(target,'utf8'),'outside-v1');
 const read=await run('read_file',{path:target});assert.ok((await finish(read.runId)).includes('outside-v1'));
 const edit=await run('write_file',{path:target,content:'outside-v2',expected_hash:createHash('sha256').update('outside-v1').digest('hex')});
 await finish(edit.runId);assert.equal(readFileSync(target,'utf8'),'outside-v2');
 const link=join(h.projectDir,'outside-link.txt');symlinkSync(target,link);chmodSync(target,0o755);
 const linkEdit=await run('write_file',{path:'outside-link.txt',content:'outside-v3',expected_hash:createHash('sha256').update('outside-v2').digest('hex')});
 await finish(linkEdit.runId);assert.equal(readFileSync(target,'utf8'),'outside-v3');assert.equal(statSync(target).mode&0o777,0o755);
 const linkDelete=await run('delete_file',{path:'outside-link.txt',expected_hash:createHash('sha256').update('outside-v3').digest('hex')});
 await finish(linkDelete.runId);assert.equal(existsSync(link),false);assert.equal(existsSync(target),true,'删除软链不能删除它指向的文件');
 const shell=await run('bash',{command:`pwd; printf shell > '${join(outside,'shell.txt')}'`});
 assert.ok((await finish(shell.runId)).includes('exitCode'));assert.equal(readFileSync(join(outside,'shell.txt'),'utf8'),'shell');
 const del=await run('delete_file',{path:target,expected_hash:createHash('sha256').update('outside-v3').digest('hex')});
 await finish(del.runId);assert.equal(existsSync(target),false);
});

test('排队消息在主轮完成边界进入真实Pi上下文，且仅投递一次',async t=>{
 const {enqueueMessage}=await import('../src/agent/conversationQueue.js');
 const state:UpstreamState={mode:'tool_then_done',requests:[]};const h=await buildHarness(t,await httpsFixture(t,state));
 const created=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'请创建hello.txt',modelConfigId:h.modelConfigId,modelId:'test-model'});
 const item=enqueueMessage(h.db,created.runId,h.userId,{text:'QUEUED_FOLLOWUP_MARKER',clientKey:'stable-queue-id'});
 assert.equal(await waitForStatus(h.db,created.runId,['succeeded','failed'],40000),'succeeded');
 const row=h.db.db.prepare('SELECT state,message_id FROM conversation_queue WHERE id=?').get(item.id) as {state:string;message_id:string};assert.equal(row.state,'dispatched');
 const messages=h.db.db.prepare('SELECT content_json,consumed_cursor_json FROM messages WHERE client_message_id=?').all(`queue:${item.id}`) as Array<{content_json:string;consumed_cursor_json:string|null}>;
 assert.equal(messages.length,1);assert.ok(messages[0]!.consumed_cursor_json);assert.ok(state.requests.some(r=>r.includes('QUEUED_FOLLOWUP_MARKER')));
});


test('子代理真实执行链：独立会话经同一网关计量并返回主会话',async t=>{
 const state:UpstreamState={mode:'tool_then_done',requests:[],subagentMode:'reply',customTool:{name:'agent',args:{prompt:'只读核对项目规则'}}};
 const h=await buildHarness(t,await httpsFixture(t,state));
 const created=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'派出研究子代理',modelConfigId:h.modelConfigId,modelId:'test-model'});
 assert.equal(await waitForStatus(h.db,created.runId,['succeeded','failed'],40000),'succeeded');
 const row=h.db.db.prepare("SELECT state,result_json FROM tool_invocations WHERE run_id=? AND tool_name='agent'").get(created.runId) as {state:string;result_json:string};
 assert.equal(row.state,'succeeded');assert.ok(row.result_json.includes('子代理核对完成'));assert.equal(state.requests.length,3);
 assert.equal((h.db.db.prepare('SELECT COUNT(*) n FROM usage_entries WHERE run_id=?').get(created.runId) as {n:number}).n,3);
});

test('子代理超时会中止模型流，主会话可收到真实失败结果后继续',async t=>{
 const state:UpstreamState={mode:'tool_then_done',requests:[],subagentMode:'slow',customTool:{name:'agent',args:{prompt:'慢速研究'}}};
 const h=await buildHarness(t,await httpsFixture(t,state));
 h.db.db.prepare('INSERT INTO agent_runtime_settings(user_id,settings_json,updated_at) VALUES (?,?,?)').run(h.userId,JSON.stringify({autoCompaction:true,keepRecentTurns:3,subagent:{enabled:true,maxSteps:3,timeoutSeconds:10}}),new Date().toISOString());
 const created=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'测试子代理停止',modelConfigId:h.modelConfigId,modelId:'test-model'});
 assert.equal(await waitForStatus(h.db,created.runId,['succeeded','failed'],40000),'succeeded');
 const row=h.db.db.prepare("SELECT state,result_json FROM tool_invocations WHERE run_id=? AND tool_name='agent'").get(created.runId) as {state:string;result_json:string};
 assert.equal(row.state,'failed');assert.ok(row.result_json.includes('超时'),row.result_json);assert.equal(state.subagentAborted,true);
});


test('子代理只读工具实际可用，并在工具步数上限停止，不继续派发调用',async t=>{
 const state:UpstreamState={mode:'tool_then_done',requests:[],subagentMode:'loop',customTool:{name:'agent',args:{prompt:'循环读取项目规则'}}};
 const h=await buildHarness(t,await httpsFixture(t,state));
 h.db.db.prepare('INSERT INTO agent_runtime_settings(user_id,settings_json,updated_at) VALUES (?,?,?)').run(h.userId,JSON.stringify({autoCompaction:true,keepRecentTurns:3,subagent:{enabled:true,maxSteps:1,timeoutSeconds:10}}),new Date().toISOString());
 const created=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'测试子代理工具上限',modelConfigId:h.modelConfigId,modelId:'test-model'});
 assert.equal(await waitForStatus(h.db,created.runId,['succeeded','failed'],40000),'succeeded');
 const reads=h.db.db.prepare("SELECT state FROM tool_invocations WHERE run_id=? AND tool_name='read_file'").all(created.runId) as Array<{state:string}>;
 assert.equal(reads.length,1);assert.equal(reads[0]!.state,'succeeded');
 const parent=h.db.db.prepare("SELECT state,result_json FROM tool_invocations WHERE run_id=? AND tool_name='agent'").get(created.runId) as {state:string;result_json:string};
 assert.equal(parent.state,'failed');assert.ok(parent.result_json.includes('步数'),parent.result_json);
});


test('真实图片链：附件、后续追问与read_image均保留图片到上游，审计结果不保存base64',async t=>{
 const state:UpstreamState={mode:'history',requests:[]},upstream=await httpsFixture(t,state),h=await buildHarness(t,upstream);
 h.db.db.prepare("UPDATE model_entries SET model_id='gpt-4o' WHERE config_id=?").run(h.modelConfigId);
 const {saveAttachment}=await import('../src/agent/attachments.js');
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPQqLhEU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAPHFyEwoyF0pAAAAAElFTkSuQmCC','base64');
 const image=saveAttachment(h.db,h.dataDir,h.userId,'sample.png',bytes);writeFileSync(join(h.projectDir,'sample.png'),bytes);
 const make=(objective:string,conversationId?:string,attachmentIds?:string[])=>h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,modelConfigId:h.modelConfigId,modelId:'gpt-4o',objective,conversationId:conversationId??null,attachmentIds});
 const first=make('看图片',undefined,[image.id]);assert.equal(await waitForStatus(h.db,first.runId,['succeeded','failed'],15000),'succeeded');assert.ok(state.requests.at(-1)!.includes('data:image/png;base64,'));
 const next=make('继续解释图片',first.conversationId);assert.equal(await waitForStatus(h.db,next.runId,['succeeded','failed'],15000),'succeeded');assert.ok(state.requests.at(-1)!.includes('data:image/png;base64,'));
 state.mode='tool_then_done';state.customTool={name:'read_image',args:{path:'sample.png'}};
 const read=make('读取图片');assert.equal(await waitForStatus(h.db,read.runId,['succeeded','failed'],15000),'succeeded');assert.ok(state.requests.at(-1)!.includes('data:image/png;base64,'));
 const result=h.db.db.prepare("SELECT result_json FROM tool_invocations WHERE run_id=? AND tool_name='read_image'").get(read.runId) as {result_json:string};assert.ok(!result.result_json.includes(bytes.toString('base64')));
});


test('提示词设置注入：mainAppend先于项目规则入主链路，子代理自定义追加在只读基底之后',async t=>{
 const state:UpstreamState={mode:'tool_then_done',requests:[],subagentMode:'reply',customTool:{name:'agent',args:{prompt:'只读核对项目规则'}}};
 const h=await buildHarness(t,await httpsFixture(t,state));
 h.db.db.prepare('INSERT INTO agent_runtime_settings(user_id,settings_json,updated_at) VALUES (?,?,?)').run(h.userId,JSON.stringify({autoCompaction:true,keepRecentTurns:3,prompts:{mainAppend:'PRISM_MAIN_APPEND_MARKER_X7',subagent:'PRISM_SUBAGENT_MARKER_K3'}}),new Date().toISOString());
 const created=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'派出研究子代理',modelConfigId:h.modelConfigId,modelId:'test-model'});
 assert.equal(await waitForStatus(h.db,created.runId,['succeeded','failed'],40000),'succeeded');
 assert.equal(state.requests.length,3);
 const mainBody=state.requests[0]!;
 assert.ok(mainBody.includes('PRISM_MAIN_APPEND_MARKER_X7'),'主链路请求应含自定义附加提示');
 assert.ok(mainBody.includes('<user_instructions source='),'自定义提示应以user_instructions标签注入');
 assert.ok(mainBody.includes('保持文件小而清晰'),'AGENTS.md项目规则仍应注入');
 assert.ok(mainBody.indexOf('user_instructions')<mainBody.indexOf('project_rules'),'用户级提示应先于项目规则');
 const subBody=state.requests.filter(b=>{try{return !JSON.parse(b).tools?.some((tl:{function?:{name?:string}})=>tl.function?.name==='agent');}catch{return false;}})[0]!;
 assert.ok(subBody.includes('PRISM_SUBAGENT_MARKER_K3'),'子代理请求应含自定义提示');
 assert.ok(subBody.includes('只读研究子代理'),'子代理内置只读基底必须保留');
 assert.ok(subBody.indexOf('只读研究子代理')<subBody.indexOf('PRISM_SUBAGENT_MARKER_K3'),'自定义应追加在基底之后');
 const row=h.db.db.prepare("SELECT state FROM tool_invocations WHERE run_id=? AND tool_name='agent'").get(created.runId) as {state:string};
 assert.equal(row.state,'succeeded');
});

test('提示词设置注入：手动压缩请求携带自定义compaction提示词且保留内置基底',async t=>{
 const state:UpstreamState={mode:'history',requests:[]};const upstream=await httpsFixture(t,state);const h=await buildHarness(t,upstream);
 h.db.db.prepare("UPDATE model_entries SET model_id='gpt-4o',parameters_json=? WHERE config_id=?").run(JSON.stringify({temperature:0,contextWindow:65536,maxOutputTokens:16000,thinkingMode:'off'}),h.modelConfigId);
 h.db.db.prepare('INSERT INTO agent_runtime_settings(user_id,settings_json,updated_at) VALUES (?,?,?)').run(h.userId,JSON.stringify({autoCompaction:false,keepRecentTurns:1,prompts:{compaction:'PRISM_COMPACTION_MARKER_Q5'}}),new Date().toISOString());
 const input={userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,modelConfigId:h.modelConfigId,modelId:'gpt-4o',objective:'PERSISTED_MEMORY_WORD'};
 const first=h.supervisor.createOrdinaryRun({...input,conversationId:null});
 assert.equal(await waitForStatus(h.db,first.runId,['succeeded','failed'],90000),'succeeded');
 const now=new Date().toISOString();
 for(let i=0;i<8;i++){
  const seq=3+i;
  h.db.db.prepare("INSERT INTO messages(id,conversation_id,run_id,author_type,role_id,seq,visibility,state,content_json,consumed_cursor_json,created_at,updated_at) VALUES (?,?,?,?,'ordinary',?,'public','published',?,'{}',?,?)").run(randomUUID(),first.conversationId,first.runId,i%2===0?'user':'agent',seq,JSON.stringify({text:'PERSISTED_MEMORY_WORD '+('历史真实内容 '+i+' ').repeat(800)}),now,now);
 }
 h.db.db.prepare('UPDATE conversations SET last_message_seq=10 WHERE id=?').run(first.conversationId);
 const second=h.supervisor.createOrdinaryRun({...input,conversationId:first.conversationId});
 assert.deepEqual(h.supervisor.compactRun(second.runId,h.userId),{accepted:true,queued:true,duplicate:false});
 assert.equal(await waitForStatus(h.db,second.runId,['succeeded','failed'],90000),'succeeded');
 assert.equal((h.db.db.prepare("SELECT COUNT(*) n FROM model_requests WHERE run_id=? AND request_kind='compaction' AND state='completed'").get(second.runId) as {n:number}).n,1);
 const compactionBody=state.requests.find(b=>b.includes('PRISM_COMPACTION_MARKER_Q5'));
 assert.ok(compactionBody,'压缩请求应携带自定义compaction提示词');
 assert.ok(compactionBody!.includes('1200字以内'),'压缩内置基底（结构与字数约束）必须保留');
 assert.ok(compactionBody!.indexOf('1200字以内')<compactionBody!.indexOf('PRISM_COMPACTION_MARKER_Q5'),'自定义应追加在基底之后');
 assert.ok(state.requests.filter(b=>b!==compactionBody).every(b=>!b.includes('PRISM_COMPACTION_MARKER_Q5')),'主链路请求不应携带压缩提示词');
});

test('真实Pi重新回答在同一Run发起新attempt，平台明确重答指令且不重复创建用户消息',async t=>{
 const state:UpstreamState={mode:'history',requests:[]},h=await buildHarness(t,await httpsFixture(t,state));
 const run=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'PERSISTED_MEMORY_WORD 请回答',modelConfigId:h.modelConfigId,modelId:'test-model'});
 assert.equal(await waitForStatus(h.db,run.runId,['succeeded','failed'],60000),'succeeded');
 const first=String(h.db.db.prepare('SELECT a.id FROM attempts a JOIN phase_tasks p ON p.id=a.phase_task_id WHERE p.run_id=? ORDER BY a.number DESC LIMIT 1').get(run.runId)!.id);
 const result=await h.supervisor.retryFailedRun(run.runId,h.userId,h.sessionId,first,true);
 assert.equal(await waitForStatus(h.db,run.runId,['succeeded','failed'],60000),'succeeded');
 assert.ok(state.requests.some(body=>body.includes('[平台重新回答]')&&body.includes('PERSISTED_MEMORY_WORD')));
 assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM runs').get()!.n,1);assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM conversations').get()!.n,1);
 assert.equal(h.db.db.prepare("SELECT COUNT(*) n FROM messages WHERE author_type='user'").get()!.n,1);
 assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM attempts').get()!.n,2);
 const {readConversationWindow}=await import('../src/agent/conversationProjection.js'),{projectTurn}=await import('../web/conversation/project.js');
 const turn=projectTurn(readConversationWindow(h.db,run.runId,h.userId).runs[0]!);assert.equal(turn.segments.at(-1)!.final!.text,'重新生成的完整答复');assert.ok(turn.segments.at(-1)!.final!.createdAt);
 assert.equal((await h.supervisor.retryFailedRun(run.runId,h.userId,h.sessionId,first,true)).attemptId,result.attemptId);
});

test('技能真实链路：Pi命令展开内置技能，读取工具可访问包内资源且禁用技能不广告',async t=>{
 const {builtinSkillsRoot,setSkillEnabled}=await import('../src/agent/skillCatalog.js');
 const state:UpstreamState={mode:'tool_then_done',requests:[],customTool:{name:'read_file',args:{path:join(builtinSkillsRoot(),'prism-guide','SKILL.md')}}};
 const h=await buildHarness(t,await httpsFixture(t,state));setSkillEnabled(h.db,h.userId,'pdf',false);
 const created=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'/skill:prism-guide 说明技能入口',modelConfigId:h.modelConfigId,modelId:'test-model'});
 assert.equal(await waitForStatus(h.db,created.runId,['succeeded','failed'],40000),'succeeded');
 const first=JSON.parse(state.requests[0]!);const body=JSON.stringify(first.messages);assert.ok(body.includes('棱镜使用指南'));assert.ok(body.includes('<skill name='));assert.ok(body.includes('说明技能入口'));assert.ok(!body.includes('<name>pdf</name>'));
 const result=h.db.db.prepare("SELECT state FROM tool_invocations WHERE run_id=? AND tool_name='read_file'").get(created.runId) as {state:string};assert.equal(result.state,'succeeded');assert.ok(state.requests[1]!.includes('本机创建'));
});


test('0.0.2 research: 真实Pi辩论→陪审复核、受控工具、盲评与程序计票',async t=>{
 const state:UpstreamState={mode:'research',requests:[]},upstream=await httpsFixture(t,state),h=await buildHarness(t,upstream);
 // 本用例的脚本上游固定从首包取出全部主张并核对9次工具/18次请求；使用足够窗口。
 // 小窗口目录分页和超过600KB资料分别由专项覆盖，不要求长资料仍全部内嵌。
 h.db.db.prepare('UPDATE model_entries SET parameters_json=? WHERE config_id=?').run(JSON.stringify({contextWindow:131072,maxOutputTokens:1024}),h.modelConfigId);
 const choice={modelConfigId:h.modelConfigId,modelId:'test-model'},models=Object.fromEntries(['pro','con','host','juror1','juror2','juror3','aggregate'].map(s=>[s,choice]));
 const input={userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,objective:'是否采用方案A',rounds:1,models,sources:[{title:'样本资料',content:'方案A成本下降10%，但样本只有两组。'}],policyVersion:'research-v1'};
 const debate=h.supervisor.research.create({...input,mode:'debate'});
 assert.equal(await waitForStatus(h.db,debate.runId,['succeeded','failed'],60_000),'succeeded');
 const report=h.supervisor.research.report(debate.runId)!;assert.equal(report.claimCount,5);assert.equal(report.evidenceCount,5);
 const requestsBefore=state.requests.length;
 const jury=h.supervisor.research.create({...input,mode:'jury',sources:[],sourceRunId:debate.runId});
 assert.equal(await waitForStatus(h.db,jury.runId,['succeeded','failed'],60_000),'succeeded');
 assert.deepEqual(h.supervisor.research.report(jury.runId)!.tally,{pro:0,con:2,mixed:0,insufficient:1,abstain:0});
 const inputs=state.requests.slice(requestsBefore).map(r=>JSON.parse(r));
 for(const request of inputs){const text=JSON.stringify(request.messages);const tools=request.tools.map((x:{function:{name:string}})=>x.function.name).sort();if(text.includes('执行身份：juror')){assert.ok(!text.includes('HOST_SENTINEL'));assert.deepEqual(tools,['research_read','research_search','web_fetch','web_search']);}if(text.includes('执行身份：aggregate')){assert.ok(text.includes('HOST_SENTINEL'));assert.deepEqual(tools,['research_read','research_search','verify_source']);}}
 assert.equal(h.db.db.prepare("SELECT COUNT(*) n FROM tool_invocations WHERE run_id IN (?,?) AND state='succeeded'").get(debate.runId,jury.runId)!.n,9);
 assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM usage_entries WHERE run_id IN (?,?)').get(debate.runId,jury.runId)!.n,18);
 assert.equal(h.db.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('research v2真实链路：辩论决策处置、陪审逐项评审、程序计票与快照冻结',async t=>{
 const state:UpstreamState={mode:'research',requests:[]},upstream=await httpsFixture(t,state),h=await buildHarness(t,upstream);
 h.db.db.prepare('UPDATE model_entries SET parameters_json=? WHERE config_id=?').run(JSON.stringify({contextWindow:131072,maxOutputTokens:1024}),h.modelConfigId);
 const choice={modelConfigId:h.modelConfigId,modelId:'test-model'},models=Object.fromEntries(['pro','con','host','juror1','juror2','juror3','aggregate'].map(s=>[s,choice]));
 // v2辩论：创建即冻结决策命题与候选（未给ID由服务端按序分配），主持交付处置并用主张锚定依据。
 const debate=h.supervisor.research.create({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,mode:'debate',objective:'是否采用方案A',rounds:1,models,sources:[{title:'样本资料',content:'方案A成本下降10%，但样本只有两组。'}],decision:{proposition:'是否采用方案A',candidates:[{text:'采用方案A'},{text:'维持现状'}]}});
 assert.equal(await waitForStatus(h.db,debate.runId,['succeeded','failed'],60_000),'succeeded');
 const debateReport=h.supervisor.research.report(debate.runId)!;
 assert.equal(debateReport.version,2);assert.equal(debateReport.summary,'host摘要');
 assert.equal(debateReport.disposition?.kind,'adopt');assert.equal(debateReport.disposition?.candidateId,'cand-1');assert.equal(debateReport.disposition?.hardConstraints,'合成硬约束');
 assert.ok(debateReport.disposition?.basisClaimIds?.length);
 assert.equal(debateReport.decision?.required,true);assert.deepEqual(debateReport.decision?.candidates.map(c=>c.id),['cand-1','cand-2']);
 const debateSnap=(JSON.parse((h.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(debate.runId) as {config_snapshot_json:string}).config_snapshot_json) as {researchProtocol:{policyVersion:string;decision:{required:boolean;proposition:string;candidates:Array<{id:string;text:string}>}}}).researchProtocol;
 assert.equal(debateSnap.policyVersion,'research-v2');assert.equal(debateSnap.decision.proposition,'是否采用方案A');assert.deepEqual(debateSnap.decision.candidates.map(c=>c.text),['采用方案A','维持现状']);
 // v2陪审：被评对象与标准快照，逐项判定覆盖全部标准；必达满足才可投通过；汇总带阻断项与下一步。
 const jury=h.supervisor.research.create({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,mode:'jury',objective:'方案A交付评审',models,sources:[{title:'样本资料',content:'方案A成本下降10%，但样本只有两组。'}],subject:{title:'方案A交付说明',content:'方案A计划先上线可读性，成本下降10%，样本只有两组。'},criteria:[{id:'s1',text:'成本下降有据',mustHave:true},{id:'s2',text:'样本充分',mustHave:false}]});
 assert.equal(await waitForStatus(h.db,jury.runId,['succeeded','failed'],60_000),'succeeded');
 const juryReport=h.supervisor.research.report(jury.runId)!;
 assert.equal(juryReport.version,2);assert.equal(juryReport.summary,'aggregate摘要');
 assert.deepEqual(juryReport.tally,{pass:2,conditional_pass:0,fail:0,insufficient:1,abstain:0});
 assert.deepEqual(juryReport.majority,{key:'pass',count:2});
 assert.deepEqual(juryReport.criterionSummary?.map(c=>({id:c.id,satisfied:c.satisfied,unmet:c.unmet,insufficient:c.insufficient})),[{id:'s1',satisfied:2,unmet:0,insufficient:1},{id:'s2',satisfied:0,unmet:0,insufficient:3}]);
 assert.deepEqual(juryReport.nextSteps,['合成下一步']);
 const jurySnap=(JSON.parse((h.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(jury.runId) as {config_snapshot_json:string}).config_snapshot_json) as {researchProtocol:{subject:{title:string};criteria:Array<{id:string;mustHave:boolean}>}}).researchProtocol;
 assert.equal(jurySnap.subject.title,'方案A交付说明');assert.deepEqual(jurySnap.criteria.map(c=>c.id),['s1','s2']);assert.deepEqual(jurySnap.criteria.map(c=>c.mustHave),[true,false]);
 assert.equal(h.db.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('0.0.2 research: 真实Pi拒绝模型请求的隐藏文件工具，任务保留真实引证',async t=>{
 const state:UpstreamState={mode:'research',requests:[],customTool:{name:'write_file',args:{path:'research-escape.txt',content:'forbidden'}}},upstream=await httpsFixture(t,state),h=await buildHarness(t,upstream);
 const choice={modelConfigId:h.modelConfigId,modelId:'test-model'};
 const run=h.supervisor.research.create({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,mode:'debate',objective:'研究工具边界',rounds:1,models:{pro:choice,con:choice,host:choice},sources:[{title:'原文',content:'样本只有两组'}],policyVersion:'research-v1'});
 assert.equal(await waitForStatus(h.db,run.runId,['succeeded','failed'],60_000),'succeeded');assert.equal(existsSync(join(h.projectDir,'research-escape.txt')),false);
 assert.equal(h.db.db.prepare("SELECT COUNT(*) n FROM tool_invocations WHERE run_id=? AND tool_name='write_file'").get(run.runId)!.n,0);
});

test('research v1受限视图：项目规则、技能装配与附加工作目录不进入执行上下文',async t=>{
 // P1修复：规则/技能/附加根属ordinaryTools能力束——固定v1 run必须维持旧受限视图，
 // 否则旧研究的执行输入随主会话配置漂移（v1语义：初始提示不继承AGENTS.md、技能与附加目录）。
 const state:UpstreamState={mode:'research',requests:[]},upstream=await httpsFixture(t,state),h=await buildHarness(t,upstream);
 h.db.db.prepare('UPDATE model_entries SET parameters_json=? WHERE config_id=?').run(JSON.stringify({contextWindow:131072,maxOutputTokens:1024}),h.modelConfigId);
 // 附加根已授权在场：v1 run也不得随workspace_roots注入
 const extraRoot=mkdtempSync(join(tmpdir(),'t05-extra-'));
 t.after(()=>rmSync(extraRoot,{recursive:true,force:true}));
 const nowIso=new Date().toISOString();
 h.db.db.prepare('UPDATE workspace_grants SET is_primary=1 WHERE project_id=?').run(h.projectId);
 h.db.db.prepare(`INSERT INTO workspace_grants(id,project_id,canonical_root,access,revision,selected_by,is_primary,excludes_json,created_at,updated_at) VALUES (?,?,?,'write',1,?,0,'[]',?,?)`)
  .run(randomUUID(),h.projectId,extraRoot,h.userId,nowIso,nowIso);
 const choice={modelConfigId:h.modelConfigId,modelId:'test-model'},models=Object.fromEntries(['pro','con','host'].map(s=>[s,choice]));
 const run=h.supervisor.research.create({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,mode:'debate',objective:'是否采用方案A',rounds:1,models,sources:[{title:'样本资料',content:'方案A成本下降10%，但样本只有两组。'}],policyVersion:'research-v1'});
 assert.equal(await waitForStatus(h.db,run.runId,['succeeded','failed'],60_000),'succeeded');
 const first=state.requests[0]!;
 assert.ok(!first.includes('测试项目规则'),'v1研究不下发项目规则');
 assert.ok(!first.includes('workspace_roots'),'v1研究不下发附加工作目录块');
 const skillsEvent=h.db.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='run.skills' ORDER BY seq LIMIT 1").get(run.runId) as {payload_json:string};
 assert.equal(JSON.parse(skillsEvent.payload_json).count,0,'v1研究技能装配固定为空');
 assert.equal(h.db.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('research v2普通工具真实链路：参与者经门禁读取项目文件，写入/命令/记忆不下发，规则与技能随装配',async t=>{
 const state:UpstreamState={mode:'research',requests:[],customTool:{name:'read_file',args:{path:'notes.md'}}},upstream=await httpsFixture(t,state),h=await buildHarness(t,upstream);
 h.db.db.prepare('UPDATE model_entries SET parameters_json=? WHERE config_id=?').run(JSON.stringify({contextWindow:131072,maxOutputTokens:1024}),h.modelConfigId);
 writeFileSync(join(h.projectDir,'notes.md'),'项目笔记：方案A样本只有两组。\n');
 const choice={modelConfigId:h.modelConfigId,modelId:'test-model'},models=Object.fromEntries(['pro','con','host'].map(s=>[s,choice]));
 // v2 run（不固定policyVersion）：ordinaryTools=true，参与者携带普通只读工具与项目规则
 const run=h.supervisor.research.create({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,mode:'debate',objective:'是否采用方案A',rounds:1,models,sources:[{title:'样本资料',content:'方案A成本下降10%，但样本只有两组。'}]});
 assert.equal(await waitForStatus(h.db,run.runId,['succeeded','failed'],60_000),'succeeded');
 const snap=JSON.parse((h.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(run.runId) as {config_snapshot_json:string}).config_snapshot_json) as {researchCapabilities?:{ordinaryTools?:boolean}};
 assert.equal(snap.researchCapabilities?.ordinaryTools,true);
 // 首请求工具清单：研究工具+四个普通只读工具；副作用工具（write_file/bash/agent/memory_*）不下发
 const first=JSON.parse(state.requests[0]!) as {messages:unknown;tools:Array<{function:{name:string}}>};
 const tools=first.tools.map(x=>x.function.name);
 for(const name of ['research_read','research_search','read_file','read_image','list_dir','grep_files'])assert.ok(tools.includes(name),`缺少工具${name}`);
 for(const name of ['write_file','delete_file','bash','write_artifact','agent'])assert.ok(!tools.includes(name),`不应下发${name}`);
 assert.ok(!tools.some(n=>n.startsWith('memory_')),'研究不下发记忆工具');
 // 项目规则随bootstrap注入（AGENTS.md由harness预写）；技能装配事件不再固定为空
 assert.ok(JSON.stringify(first.messages).includes('测试项目规则'));
 const skillsEvent=h.db.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='run.skills' ORDER BY seq LIMIT 1").get(run.runId) as {payload_json:string};
 assert.ok(JSON.parse(skillsEvent.payload_json).count>0,'研究attempt应与普通任务共用已启用技能装配');
 // 门禁分流：read_file走普通执行器登记成功并归属阶段任务；文件内容回流进模型消息
 const row=h.db.db.prepare("SELECT state,phase_task_id FROM tool_invocations WHERE run_id=? AND tool_name='read_file'").get(run.runId) as {state:string;phase_task_id:string|null};
 assert.equal(row.state,'succeeded');assert.ok(row.phase_task_id);
 assert.ok(state.requests.some(r=>r.includes('项目笔记：方案A样本只有两组')));
 // 普通工具与研究工具同一研究预算池（checkBudget对tool_invocations计数）
 const used=(h.db.db.prepare("SELECT COUNT(*) n FROM tool_invocations WHERE run_id=? AND state='succeeded'").get(run.runId) as {n:number}).n;
 const limit=(h.db.db.prepare('SELECT tool_request_limit FROM research_runs WHERE run_id=?').get(run.runId) as {tool_request_limit:number}).tool_request_limit;
 assert.ok(used<=limit);assert.ok(used>=3,'至少三轮各一次工具调用');
 assert.equal(h.db.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('research显式附件真实链路：无vision启动明确失败不降级，vision模型收到图片且base64不落库',async t=>{
 const state:UpstreamState={mode:'research',requests:[]},upstream=await httpsFixture(t,state),h=await buildHarness(t,upstream);
 h.db.db.prepare('UPDATE model_entries SET parameters_json=? WHERE config_id=?').run(JSON.stringify({contextWindow:131072,maxOutputTokens:1024}),h.modelConfigId);
 // 真实32x32 PNG（Pi侧序列化要求可解码图片；saveAttachment只嗅探魔数但模型输入须完整字节）
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPQqLhEU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAPHFyEwoyF0pAAAAAElFTkSuQmCC','base64');
 const att=saveAttachment(h.db,h.dataDir,h.userId,'证据截图.png',png);
 const base64=png.toString('base64');
 const choice={modelConfigId:h.modelConfigId,modelId:'test-model'},models=Object.fromEntries(['pro','con','host'].map(s=>[s,choice]));
 const input={userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,mode:'debate' as const,objective:'是否采用方案A',rounds:1,models,sources:[{title:'样本资料',content:'方案A成本下降10%，但样本只有两组。'}],attachmentIds:[att.id]};
 // 场景一：角色模型无vision（创建时冻结）——创建阶段全角色预检整体拒绝（点名角色），不建run、不发模型请求；
 // 前端可换模型或移除图片后重试。不允许先跑前面角色再在后面失败。
 assert.throws(()=>h.supervisor.research.create(input),/不支持图片输入：pro、con、host/);
 assert.equal(state.requests.length,0);
 assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM runs').get()!.n,0);
 assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM research_runs').get()!.n,0);
 // 场景二：模型声明vision后新建研究——图片经bootstrap进入首请求，run正常完成
 h.db.db.prepare('UPDATE model_entries SET parameters_json=? WHERE config_id=?').run(JSON.stringify({contextWindow:131072,maxOutputTokens:1024,advanced:{image:true}}),h.modelConfigId);
 const run=h.supervisor.research.create(input);
 assert.equal(await waitForStatus(h.db,run.runId,['succeeded','failed'],60_000),'succeeded');
 assert.ok(state.requests[0]!.includes(base64.slice(0,32)),'图片字节应随首个模型请求下发');
 // 契约红线：base64只存在于attempt bootstrap文件与进程内存，不落任何研究/审计表
 const dbDump=JSON.stringify([
  h.db.db.prepare('SELECT content FROM research_records').all(),
  h.db.db.prepare('SELECT payload_json FROM run_events').all(),
  h.db.db.prepare('SELECT result_json FROM tool_invocations').all(),
  h.db.db.prepare('SELECT config_snapshot_json FROM runs').all(),
 ]);
 assert.ok(!dbDump.includes(base64.slice(0,32)),'附件base64不得落research_records/事件/工具结果/快照');
 assert.equal(h.db.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('research v2技能清单真实链路：manifest进入模型上下文，正文不预注入，禁用技能不出现，read_file按需可读',async t=>{
 const state:UpstreamState={mode:'research',requests:[]},upstream=await httpsFixture(t,state),h=await buildHarness(t,upstream);
 h.db.db.prepare('UPDATE model_entries SET parameters_json=? WHERE config_id=?').run(JSON.stringify({contextWindow:131072,maxOutputTokens:1024}),h.modelConfigId);
 // 项目技能两枚：alpha启用、beta禁用；SKILL.md正文带哨兵——正文不得整段注入初始prompt
 const skillDir=join(h.projectDir,'.prism','skills','alpha-method');
 mkdirSync(skillDir,{recursive:true});
 const skillPath=join(skillDir,'SKILL.md');
 writeFileSync(skillPath,'---\nname: alpha-method\ndescription: alpha论证方法说明\n---\nALPHA_BODY_SENTINEL 正文只应按需读取');
 mkdirSync(join(h.projectDir,'.prism','skills','beta-method'),{recursive:true});
 writeFileSync(join(h.projectDir,'.prism','skills','beta-method','SKILL.md'),'---\nname: beta-method\ndescription: beta禁用方法\n---\nBETA_BODY');
 const {setSkillEnabled}=await import('../src/agent/skillCatalog.js');
 setSkillEnabled(h.db,h.userId,'beta-method',false);
 state.customTool={name:'read_file',args:{path:skillPath}};
 const choice={modelConfigId:h.modelConfigId,modelId:'test-model'},models=Object.fromEntries(['pro','con','host'].map(s=>[s,choice]));
 const run=h.supervisor.research.create({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,mode:'debate',objective:'是否采用方案A',rounds:1,models,sources:[{title:'样本资料',content:'方案A成本下降10%，但样本只有两组。'}]});
 assert.equal(await waitForStatus(h.db,run.runId,['succeeded','failed'],60_000),'succeeded');
 const first=state.requests[0]!;
 // manifest真实进入模型上下文：技能名+description随<skills>区段到达（Pi available_skills同构，经read_file读取器说明）
 assert.ok(first.includes('alpha-method'),'技能名应随manifest进入模型上下文');
 assert.ok(first.includes('alpha论证方法说明'),'技能description应随manifest进入模型上下文');
 assert.ok(first.includes('read_file'),'manifest应点名read_file作为读取入口');
 // 正文不预注入：初始prompt不含SKILL.md正文哨兵
 assert.ok(!first.includes('ALPHA_BODY_SENTINEL'),'技能正文不得整段注入初始prompt');
 // 禁用技能不出现
 assert.ok(!first.includes('beta-method'),'禁用技能不得进入manifest');
 // R1修复：ordinaryTools运行的research systemPrompt不含“只能使用固定研究视图”矛盾句
 assert.ok(!first.includes('只能使用固定研究视图'),'ordinaryTools运行不应声明固定视图限制');
 assert.ok(first.includes('你是棱镜的研究 Agent'),'新版研究系统提示词已下发');
 assert.ok(first.includes('[研究任务卡 research-task-card-v1]'),'真实模型请求应携带新版任务卡');
 // 按需读取闭环：模型发起read_file(SKILL.md)→普通门禁执行→正文回流后续请求
 const row=h.db.db.prepare("SELECT state,phase_task_id FROM tool_invocations WHERE run_id=? AND tool_name='read_file'").get(run.runId) as {state:string;phase_task_id:string|null};
 assert.equal(row.state,'succeeded');
 assert.ok(row.phase_task_id,'技能读取应归属研究阶段任务并计入审计');
 assert.ok(state.requests.some(r=>r.includes('ALPHA_BODY_SENTINEL')),'正文应经read_file按需回流');
 assert.equal(h.db.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('research v2项目按需读取直测：附加根read_file/list_dir/grep_files可达，路径不冒充研究记录，副作用仍拒',async t=>{
 // D53边界映射：读取按本机账户权限（项目目录只是默认cwd，附加目录按绝对路径访问）；
 // 研究门禁路径上仍拒绝的边界=研究专用通道只认视图内recordId（路径语义被拒）+副作用工具不存在（v2 runner不下发）。
 const state:UpstreamState={mode:'research',requests:[],toolQueue:[
  {name:'list_dir',args:{path:'.'}},
  {name:'read_file',args:{path:'AGENTS.md'}},
  {name:'grep_files',args:{pattern:'测试项目规则',path:'.'}},
 ]},upstream=await httpsFixture(t,state),h=await buildHarness(t,upstream);
 h.db.db.prepare('UPDATE model_entries SET parameters_json=? WHERE config_id=?').run(JSON.stringify({contextWindow:131072,maxOutputTokens:1024}),h.modelConfigId);
 // 附加根：显式标记主目录is_primary=1后授权第二目录（migration 027语义）
 const extraRoot=mkdtempSync(join(tmpdir(),'t05-extra-'));
 t.after(()=>rmSync(extraRoot,{recursive:true,force:true}));
 writeFileSync(join(extraRoot,'extra.md'),'附加目录EXTRA_MARKER内容\n');
 const nowIso=new Date().toISOString();
 h.db.db.prepare('UPDATE workspace_grants SET is_primary=1 WHERE project_id=?').run(h.projectId);
 h.db.db.prepare(`INSERT INTO workspace_grants(id,project_id,canonical_root,access,revision,selected_by,is_primary,excludes_json,created_at,updated_at) VALUES (?,?,?,'write',1,?,0,'[]',?,?)`)
  .run(randomUUID(),h.projectId,extraRoot,h.userId,nowIso,nowIso);
 const choice={modelConfigId:h.modelConfigId,modelId:'test-model'},models=Object.fromEntries(['pro','con','host'].map(s=>[s,choice]));
 const base={userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,mode:'debate' as const,objective:'是否采用方案A',rounds:1,models,sources:[{title:'样本资料',content:'方案A成本下降10%，但样本只有两组。'}]};
 const run=h.supervisor.research.create(base);
 assert.equal(await waitForStatus(h.db,run.runId,['succeeded','failed'],60_000),'succeeded');
 // 主目录与附加根：list_dir覆盖cwd、read_file主目录、grep_files命中AGENTS.md规则——三者都经普通门禁记账成功
 for(const name of ['list_dir','read_file','grep_files']){
  const row=h.db.db.prepare("SELECT state,phase_task_id,result_json FROM tool_invocations WHERE run_id=? AND tool_name=?").get(run.runId,name) as {state:string;phase_task_id:string|null;result_json:string};
  assert.equal(row.state,'succeeded',`${name}应经普通门禁执行成功`);
  assert.ok(row.phase_task_id,`${name}应归属研究阶段任务`);
 }
 // 工具结果流回模型消息（规则内容与目录条目在第二轮请求中可见）
 assert.ok(state.requests.some(r=>r.includes('测试项目规则')),'read_file结果应回流');
 assert.ok(state.requests.some(r=>r.includes('AGENTS.md')),'list_dir条目应回流');
 // workspace_roots块注入：主目录+附加根都到达模型提示
 assert.ok(state.requests.some(r=>r.includes('workspace_roots')&&r.includes(extraRoot)),'附加目录应随workspace_roots注入');
 // bootstrap效果直证：bootstrap.json被runner读后即删（base64只短暂存在），改以两个可观察效果断言——
 // ①ordinaryTools清单生效=请求tools含四个普通只读工具；②additionalRoots生效=workspace_roots含附加根
 const firstReq=JSON.parse(state.requests[0]!) as {tools:Array<{function:{name:string}}>};
 const toolNames=firstReq.tools.map(x=>x.function.name);
 for(const name of ['read_file','read_image','list_dir','grep_files'])assert.ok(toolNames.includes(name),`研究请求应下发${name}`);
 for(const name of ['write_file','delete_file','bash','agent','write_artifact'])assert.ok(!toolNames.includes(name),`研究不应下发${name}`);
 // 路径不冒充研究记录：research_read传越界路径语义的recordId被研究专用通道拒绝
 state.toolQueue=[{name:'research_read',args:{recordId:'../../../outside-secret.txt'}}];
 const run2=h.supervisor.research.create({...base,objective:'越界探测'});
 assert.equal(await waitForStatus(h.db,run2.runId,['succeeded','failed'],60_000),'succeeded');
 const escRow=h.db.db.prepare("SELECT state,error_code FROM tool_invocations WHERE run_id=? AND tool_name='research_read' AND state='failed'").get(run2.runId) as {state:string;error_code:string}|undefined;
 assert.ok(escRow,'研究专用通道应拒绝非视图记录');
 assert.ok(escRow!.error_code==='NOT_FOUND'||escRow!.error_code==='POLICY_DENIED',escRow?.error_code);
 // 副作用边界：v2 run中write_file不在runner工具清单，pi报未知工具→无记账行、无文件产生，run仍完成
 state.toolQueue=[{name:'write_file',args:{path:'escape.txt',content:'forbidden'}}];
 const run3=h.supervisor.research.create({...base,objective:'尝试写文件'});
 assert.equal(await waitForStatus(h.db,run3.runId,['succeeded','failed'],60_000),'succeeded');
 assert.equal(h.db.db.prepare("SELECT COUNT(*) n FROM tool_invocations WHERE run_id=? AND tool_name='write_file'").get(run3.runId)!.n,0);
 assert.equal(existsSync(join(h.projectDir,'escape.txt')),false);
 assert.equal(h.db.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('research v2图片读取直测：read_image经门禁返回Pi原生image content，审计不落base64，无vision明确拒绝',async t=>{
 // 正场景：vision模型经研究普通门禁读项目内图片→工具结果以data URL回流模型
 const state:UpstreamState={mode:'research',requests:[],customTool:{name:'read_image',args:{path:'sample.png'}}},upstream=await httpsFixture(t,state),h=await buildHarness(t,upstream);
 h.db.db.prepare('UPDATE model_entries SET parameters_json=? WHERE config_id=?').run(JSON.stringify({contextWindow:131072,maxOutputTokens:1024,advanced:{image:true}}),h.modelConfigId);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPQqLhEU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAPHFyEwoyF0pAAAAAElFTkSuQmCC','base64');
 writeFileSync(join(h.projectDir,'sample.png'),png);
 const choice={modelConfigId:h.modelConfigId,modelId:'test-model'},models=Object.fromEntries(['pro','con','host'].map(s=>[s,choice]));
 const run=h.supervisor.research.create({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,mode:'debate',objective:'是否采用方案A',rounds:1,models,sources:[{title:'样本资料',content:'方案A成本下降10%，但样本只有两组。'}]});
 assert.equal(await waitForStatus(h.db,run.runId,['succeeded','failed'],60_000),'succeeded');
 // read_image结果以Pi原生image content（data URL）进入后续模型请求
 assert.ok(state.requests.at(-1)!.includes('data:image/png;base64,'),'图片应以Pi原生image content回流');
 const row=h.db.db.prepare("SELECT state,phase_task_id,result_json FROM tool_invocations WHERE run_id=? AND tool_name='read_image' AND state='succeeded'").get(run.runId) as {state:string;phase_task_id:string|null;result_json:string};
 assert.ok(row.phase_task_id,'read_image应归属研究阶段任务');
 // 审计面剥图：结果JSON与research_records/事件均无base64
 assert.ok(!row.result_json.includes(png.toString('base64').slice(0,32)),'审计result_json不得携带图片base64');
 const dump=JSON.stringify([h.db.db.prepare('SELECT content FROM research_records').all(),h.db.db.prepare('SELECT payload_json FROM run_events').all()]);
 assert.ok(!dump.includes(png.toString('base64').slice(0,32)));
 // 反场景：无vision模型→read_image明确拒绝（不静默返回文本占位），run仍按脚本完成
 const state2:UpstreamState={mode:'research',requests:[],customTool:{name:'read_image',args:{path:'sample.png'}}},h2=await buildHarness(t,await httpsFixture(t,state2));
 h2.db.db.prepare('UPDATE model_entries SET parameters_json=? WHERE config_id=?').run(JSON.stringify({contextWindow:131072,maxOutputTokens:1024}),h2.modelConfigId);
 const choice2={modelConfigId:h2.modelConfigId,modelId:'test-model'},models2=Object.fromEntries(['pro','con','host'].map(s=>[s,choice2]));
 const run2=h2.supervisor.research.create({userId:h2.userId,sessionId:h2.sessionId,projectId:h2.projectId,mode:'debate',objective:'是否采用方案A',rounds:1,models:models2,sources:[{title:'样本资料',content:'方案A成本下降10%，但样本只有两组。'}]});
 assert.equal(await waitForStatus(h2.db,run2.runId,['succeeded','failed'],60_000),'succeeded');
 const fail=h2.db.db.prepare("SELECT state,error_code FROM tool_invocations WHERE run_id=? AND tool_name='read_image' AND state='failed'").get(run2.runId) as {state:string;error_code:string};
 assert.ok(fail,'无vision模型的read_image应失败');
 assert.ok(!state2.requests.at(-1)!.includes('data:image/png;base64,'),'无vision不得返回图片content');
 assert.equal(h.db.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('research: 真实Pi对超过600KB资料完成三份独立初判及汇总，网关输入保持有界',async t=>{
 const state:UpstreamState={mode:'research',requests:[]},h=await buildHarness(t,await httpsFixture(t,state));
 const choice={modelConfigId:h.modelConfigId,modelId:'test-model'},content='样本只有两组。'+'资料'.repeat(9_990);
 const run=h.supervisor.research.create({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,mode:'jury',objective:'大资料独立评审',models:{juror1:choice,juror2:choice,juror3:choice,aggregate:choice},sources:Array.from({length:12},(_,i)=>({title:`完整资料${i}`,content})),policyVersion:'research-v1'});
 assert.equal(await waitForStatus(h.db,run.runId,['succeeded','failed'],60_000),'succeeded');
 const report=h.supervisor.research.report(run.runId)!;assert.equal(report.execution,'complete');
 // ≥3：三名陪审员各引证一次；v2装配下汇总的目录预算是字节级边界，目录里挤进source元数据条目时
 // 汇总者会经research_read取回原文并合法引证（+1），挤不进则不引证——两种都是正确装配行为。
 assert.ok(report.evidenceCount>=3);
 const records=h.supervisor.research.records(run.runId);assert.ok(Buffer.byteLength(JSON.stringify(records))>600_000);
 assert.equal(records.filter(r=>r.kind==='opinion').length,3);assert.ok(records.filter(r=>r.kind==='source').every(r=>r.content===content));
 assert.ok(state.requests.every(body=>body.length<100_000));
 assert.deepEqual(report.tally,{pro:0,con:2,mixed:0,insufficient:1,abstain:0});
});

test('0.0.2 research: 模型失败后原地重试只重跑未完成阶段',async t=>{
 const state:UpstreamState={mode:'error',requests:[]},upstream=await httpsFixture(t,state),h=await buildHarness(t,upstream);
 const choice={modelConfigId:h.modelConfigId,modelId:'test-model'};
 const run=h.supervisor.research.create({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,mode:'jury',objective:'研究恢复',models:{juror1:choice,juror2:choice,juror3:choice,aggregate:choice},sources:[{title:'原文',content:'样本只有两组'}],policyVersion:'research-v1'});
 assert.equal(await waitForStatus(h.db,run.runId,['failed'],30_000),'failed');
 const attempt=h.db.db.prepare('SELECT active_attempt_id FROM phase_tasks WHERE run_id=? AND phase_key=?').get(run.runId,'opinion_1')!;
 state.mode='research';await h.supervisor.retryFailedRun(run.runId,h.userId,h.sessionId,String(attempt.active_attempt_id));
 assert.equal(await waitForStatus(h.db,run.runId,['succeeded','failed'],60_000),'succeeded');assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=?').get(run.runId)!.n,5);
});


test('0.0.2 research: 真实执行身份的控制通道拒绝文件工具，取消不会发布结果',async t=>{
 const state:UpstreamState={mode:'slow',requests:[]},upstream=await httpsFixture(t,state),h=await buildHarness(t,upstream);
 const choice={modelConfigId:h.modelConfigId,modelId:'test-model'};
 const run=h.supervisor.research.create({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,mode:'debate',objective:'控制通道越界',rounds:1,models:{pro:choice,con:choice,host:choice},policyVersion:'research-v1'});
 for(let i=0;i<100&&!state.requests.length;i++)await new Promise(r=>setTimeout(r,30));
 const active=h.supervisor.active.get(run.runId)!;
 const rpc=h.supervisor as unknown as {handleToolProposed(active:unknown,payload:unknown,respond:(...args:unknown[])=>void):Promise<void>};
 await assert.rejects(rpc.handleToolProposed(active,{toolName:'write_file',args:{path:'forbidden.txt',content:'x',role:'host'}},()=>{}),/允许范围/);
 assert.equal(existsSync(join(h.projectDir,'forbidden.txt')),false);
 await h.supervisor.cancelRun(run.runId,'user_requested');assert.equal(await waitForStatus(h.db,run.runId,['cancelled'],30_000),'cancelled');assert.equal(h.supervisor.research.report(run.runId),null);
 assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM research_records WHERE run_id=?').get(run.runId)!.n,0);
});


test('research: 新任务卡无效引文收到局部修复提示，保留拒绝记录且不发布假证据',async t=>{
 const state:UpstreamState={mode:'research',requests:[],researchInvalidOnce:true},upstream=await httpsFixture(t,state),h=await buildHarness(t,upstream);
 const choice={modelConfigId:h.modelConfigId,modelId:'test-model'};
 const run=h.supervisor.research.create({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,mode:'jury',objective:'格式修复验收',models:{juror1:choice,juror2:choice,juror3:choice,aggregate:choice},sources:[{title:'原文',content:'样本只有两组'}],subject:{title:'测试对象',content:'测试材料'},criteria:[{id:'s1',text:'样本充分',mustHave:true}]});
 assert.equal(await waitForStatus(h.db,run.runId,['succeeded','failed'],60_000),'succeeded');
 const repair=state.requests.flatMap(request=>(JSON.parse(request).messages as Array<{role:string;content:unknown}>)).find(message=>message.role==='user'&&typeof message.content==='string'&&message.content.startsWith('上次交付被拒绝'));
 assert.ok(repair,'修复请求应包含新版局部反馈');
 assert.match(String(repair.content),/引文未通过逐字校验/);
 assert.match(String(repair.content),/分类：citation/);
 assert.doesNotMatch(String(repair.content),/研究任务卡|研究记录目录/);
 assert.ok(String(repair.content).length<600,'修复消息不重复发送任务卡或资料');
 assert.equal(h.db.db.prepare("SELECT COUNT(*) n FROM run_events WHERE run_id=? AND type='research.delivery.rejected'").get(run.runId)!.n,1);
 assert.equal(h.db.db.prepare("SELECT COUNT(*) n FROM evidence WHERE run_id=? AND excerpt='fake'").get(run.runId)!.n,0);
 assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=?').get(run.runId)!.n,4);
});

test('research: 旧装配run的修复轮保留字符串回退提示',async t=>{
 const state:UpstreamState={mode:'research',requests:[],researchInvalidOnce:true},upstream=await httpsFixture(t,state),h=await buildHarness(t,upstream);
 const choice={modelConfigId:h.modelConfigId,modelId:'test-model'};
 const run=h.supervisor.research.create({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,mode:'jury',objective:'旧装配修复回退',models:{juror1:choice,juror2:choice,juror3:choice,aggregate:choice},sources:[{title:'原文',content:'样本只有两组'}],policyVersion:'research-v1'});
 assert.equal(await waitForStatus(h.db,run.runId,['succeeded','failed'],60_000),'succeeded');
 const repair=state.requests.flatMap(request=>(JSON.parse(request).messages as Array<{role:string;content:unknown}>)).find(message=>message.role==='user'&&typeof message.content==='string'&&message.content.startsWith('平台结构校验未通过：'));
 assert.ok(repair,'旧装配run保留字符串修复回退');
 assert.match(String(repair.content),/引文未通过逐字校验/);
});

test('research: 两次修复耗尽以DELIVERY_INVALID终态失败，拒绝台账与修复轮一致，原地重试保留拒绝记录后恢复',async t=>{
 const state:UpstreamState={mode:'research',requests:[],researchInvalidAlways:true},upstream=await httpsFixture(t,state),h=await buildHarness(t,upstream);
 const choice={modelConfigId:h.modelConfigId,modelId:'test-model'};
 const run=h.supervisor.research.create({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,mode:'jury',objective:'修复耗尽验收',models:{juror1:choice,juror2:choice,juror3:choice,aggregate:choice},sources:[{title:'原文',content:'样本只有两组'}],subject:{title:'测试对象',content:'测试材料'},criteria:[{id:'s1',text:'样本充分',mustHave:true}]});
 assert.equal(await waitForStatus(h.db,run.runId,['failed'],90_000),'failed');
 // 唯一终态失败事件：DELIVERY_INVALID 且携带脱敏交付诊断，不进入自动重建
 const failed=h.db.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='run.failed'").all(run.runId) as Array<{payload_json:string}>;
 assert.equal(failed.length,1,'耗尽只产生一个终态失败事件');
 const failedPayload=JSON.parse(failed[0]!.payload_json) as {error:string;delivery?:{researchDelivery?:{maxRepairs?:number}};retryable?:boolean};
 assert.equal(failedPayload.error,'DELIVERY_INVALID');
 assert.equal(failedPayload.delivery?.researchDelivery?.maxRepairs,2);
 assert.equal(failedPayload.retryable,false);
 assert.equal(h.db.db.prepare("SELECT COUNT(*) n FROM run_events WHERE run_id=? AND type='run.retry_scheduled'").get(run.runId)!.n,0,'交付耗尽属不可自愈类，不排期自动重建');
 // 拒绝台账=初始提交+两次修复，逐条带分类与修复进度
 const rejections=h.db.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='research.delivery.rejected' ORDER BY rowid").all(run.runId) as Array<{payload_json:string}>;
 assert.equal(rejections.length,3,'初始提交+两次修复各一条拒绝');
 const parsed=rejections.map(r=>JSON.parse(r.payload_json) as {details?:{researchDelivery?:{category?:string;repairAttempt?:number;maxRepairs?:number}};proposal?:string});
 assert.deepEqual(parsed.map(p=>p.details?.researchDelivery?.repairAttempt),[1,2,2]);
 assert.ok(parsed.every(p=>p.details?.researchDelivery?.category==='citation'&&p.details.researchDelivery.maxRepairs===2));
 assert.ok(parsed.every(p=>typeof p.proposal==='string'&&p.proposal.includes('fake')),'候选输出仅随属主审计事件保留');
 assert.ok(!parsed.some(p=>JSON.stringify(p.details?.researchDelivery??{}).includes('fake')),'诊断对象不得携带被拒引文原文');
 assert.equal(h.supervisor.research.report(run.runId),null,'耗尽不发布报告');
 assert.equal(h.db.db.prepare("SELECT COUNT(*) n FROM research_records WHERE run_id=? AND kind='opinion'").get(run.runId)!.n,0,'不发布半成品意见');
 // 修复轮消费结构化诊断：局部提示带分类，不重复任务卡与资料
 const repair=state.requests.flatMap(request=>(JSON.parse(request).messages as Array<{role:string;content:unknown}>)).find(message=>message.role==='user'&&typeof message.content==='string'&&message.content.startsWith('上次交付被拒绝'));
 assert.ok(repair,'修复请求应走结构化诊断路径');
 assert.match(String(repair.content),/分类：citation/);
 assert.doesNotMatch(String(repair.content),/研究任务卡|研究记录目录/);
 // 原地重试：恢复输出后只重跑失败阶段，旧拒绝事件保留，报告正常生成
 state.researchInvalidAlways=false;
 const attempt=h.db.db.prepare('SELECT active_attempt_id FROM phase_tasks WHERE run_id=? AND phase_key=?').get(run.runId,'opinion_1')!;
 await h.supervisor.retryFailedRun(run.runId,h.userId,h.sessionId,String(attempt.active_attempt_id));
 assert.equal(await waitForStatus(h.db,run.runId,['succeeded','failed'],90_000),'succeeded');
 assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=?').get(run.runId)!.n,5,'重试只新增失败阶段与后续阶段attempt');
 assert.ok(h.supervisor.research.report(run.runId));
 assert.equal(h.db.db.prepare("SELECT COUNT(*) n FROM run_events WHERE run_id=? AND type='research.delivery.rejected'").get(run.runId)!.n,3,'重试成功后旧拒绝记录保留');
});


test('模型提问完整执行链：full授权也等待真实回答，答案进入下一次Pi模型请求',async t=>{
 const args={questions:[{header:'市场',question:'选择研究市场？',multiSelect:false,options:[{label:'A股',description:'内地市场'},{label:'美股',description:'美国市场'}]}]};
 const state:UpstreamState={mode:'tool_then_done',requests:[],customTool:{name:'AskUserQuestion',args}};
 const h=await buildHarness(t,await httpsFixture(t,state));
 const created=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'先确认研究市场再继续',modelConfigId:h.modelConfigId,modelId:'test-model',approvalMode:'full'});
 let questionId='';
 for(let i=0;i<100;i++){const row=h.db.db.prepare("SELECT id FROM user_questions WHERE run_id=? AND state='pending'").get(created.runId) as {id:string}|undefined;if(row){questionId=row.id;break;}await new Promise(r=>setTimeout(r,100));}
 assert.ok(questionId,'真实runner应提出待回答问题');
 assert.equal(state.requests.length,1,'回答前不能继续请求模型');
 const pendingActive=h.supervisor.active.get(created.runId)!;
 let prematureCode='';
 await (h.supervisor as unknown as {handleCompleteProposed(active:unknown,raw:unknown,respond:(ok:boolean,payload?:unknown,error?:{code:string})=>void):Promise<void>}).handleCompleteProposed(pendingActive,{summary:'不应提前完成'},(_ok,_payload,error)=>{prematureCode=error?.code??'';});
 assert.equal(prematureCode,'REQUEST_IN_PROGRESS');
 assert.equal(h.db.db.prepare('SELECT id FROM approvals LIMIT 1').get(),undefined);
 h.supervisor.userQuestions.respond(created.runId,questionId,h.userId,{action:'answer',answers:{'选择研究市场？':['A股']}});
 assert.equal(await waitForStatus(h.db,created.runId,['succeeded','failed'],40000),'succeeded');
 assert.equal(state.requests.length,2);
 const body=JSON.parse(state.requests[1]!) as {messages:Array<{role:string;content:string}>};
 const result=body.messages.find(m=>m.role==='tool');assert.ok(result);assert.match(result.content,/A股/);assert.match(result.content,/answers/);
 const saved=h.db.db.prepare("SELECT state,answers_json FROM user_questions WHERE id=?").get(questionId) as {state:string;answers_json:string};
 assert.equal(saved.state,'answered');assert.deepEqual(JSON.parse(saved.answers_json),{'选择研究市场？':['A股']});
});


test('提问等待中的停止与凭据失效会关闭问题，不继续调用模型',async t=>{
 for(const kind of ['cancel','credential'] as const){
 const args={questions:[{header:'范围',question:'选择研究范围？',multiSelect:false,options:[{label:'国内',description:'国内市场'},{label:'全球',description:'全球市场'}]}]};
 const state:UpstreamState={mode:'tool_then_done',requests:[],customTool:{name:'AskUserQuestion',args}};
 const h=await buildHarness(t,await httpsFixture(t,state));
 const created=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'等待澄清',modelConfigId:h.modelConfigId,modelId:'test-model'});
 let id='';for(let i=0;i<100;i++){const row=h.db.db.prepare("SELECT id FROM user_questions WHERE run_id=? AND state='pending'").get(created.runId) as {id:string}|undefined;if(row){id=row.id;break;}await new Promise(r=>setTimeout(r,100));}
 assert.ok(id);if(kind==='cancel')await h.supervisor.cancelRun(created.runId,'user_requested');else h.supervisor.onCredentialChanged({configId:h.modelConfigId});
 assert.equal(await waitForStatus(h.db,created.runId,[kind==='cancel'?'cancelled':'waiting_input'],20000),kind==='cancel'?'cancelled':'waiting_input');
 assert.equal((h.db.db.prepare('SELECT state FROM user_questions WHERE id=?').get(id) as {state:string}).state,'cancelled');
 assert.throws(()=>h.supervisor.userQuestions.respond(created.runId,id,h.userId,{action:'skip'}),/已结束/);
 assert.equal(state.requests.length,1);
 }
});


test('记忆完整链：selector只读召回→主任务→受限提炼写记忆，单独计量且不消费用户输入',async t=>{
 const state:UpstreamState={mode:'memory',requests:[]};const h=await buildHarness(t,await httpsFixture(t,state),true);
 const memory=await import('../src/agent/memoryStore.js');
 await memory.toolMemoryWrite(memory.memoryRootOf(h.dataDir,h.projectId),{path:'preference.md',content:'---\nname: preference\ndescription: 报告偏好\nmetadata:\n  type: user\n---\nRECALL_SENTINEL',expectedHash:null});
 const created=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'根据报告偏好完成本轮任务，并记住新反馈',modelConfigId:h.modelConfigId,modelId:'test-model'});
 assert.equal(await waitForStatus(h.db,created.runId,['succeeded','failed'],30000),'succeeded');
 const requests=h.db.db.prepare('SELECT request_kind,input_message_ids_json FROM model_requests WHERE run_id=? ORDER BY rowid').all(created.runId) as unknown as Array<{request_kind:string;input_message_ids_json:string}>;
 assert.deepEqual(requests.map(r=>r.request_kind),['memory_recall','main','main','memory_extraction','memory_extraction']);
 assert.equal(requests[0]!.input_message_ids_json,'[]');assert.equal(requests[3]!.input_message_ids_json,'[]');
 assert.ok(state.requests.some(body=>body.includes('RECALL_SENTINEL')&&!body.includes('选择明确有助于')),JSON.stringify(h.db.db.prepare("SELECT type,payload_json FROM run_events WHERE run_id=? AND type LIKE 'memory.%'").all(created.runId)));
 assert.match((await memory.readMemoryText(memory.memoryRootOf(h.dataDir,h.projectId),'automatic.md')).content,/AUTO_MEMORY_SENTINEL/);
 assert.match((await memory.readMemoryText(memory.memoryRootOf(h.dataDir,h.projectId),'MEMORY.md')).content,/automatic.md/);
 assert.equal((h.db.db.prepare('SELECT state FROM memory_extractions WHERE run_id=?').get(created.runId) as {state:string}).state,'completed');
 const usage=h.db.db.prepare('SELECT request_kind FROM usage_entries WHERE run_id=?').all(created.runId) as unknown as Array<{request_kind:string}>;assert.equal(usage.filter(r=>r.request_kind==='memory_extraction').length,2);
});

test('关闭记忆：真实模型请求不再含记忆工具和提示，不启动辅助调用',async t=>{
 const state:UpstreamState={mode:'history',requests:[]};const h=await buildHarness(t,await httpsFixture(t,state));
 const run=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'关闭记忆验收',modelConfigId:h.modelConfigId,modelId:'test-model'});
 assert.equal(await waitForStatus(h.db,run.runId,['succeeded','failed'],30000),'succeeded');
 assert.equal(state.requests.length,1);const body=JSON.parse(state.requests[0]!);assert.ok(!body.tools.some((t:{function:{name:string}})=>t.function.name.startsWith('memory_')));assert.ok(!JSON.stringify(body.messages).includes('memory_instructions'));
});


test('记忆辅助失败不改变主任务结果；失败提炼不推进完成游标',async t=>{
 for(const memoryFailure of ['selector','extraction'] as const){
 const state:UpstreamState={mode:'memory',requests:[],memoryFailure};const h=await buildHarness(t,await httpsFixture(t,state),true);const memory=await import('../src/agent/memoryStore.js');
 await memory.toolMemoryWrite(memory.memoryRootOf(h.dataDir,h.projectId),{path:'preference.md',content:'用户偏好',expectedHash:null});
 const run=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'完成任务并记住反馈',modelConfigId:h.modelConfigId,modelId:'test-model'});
 assert.equal(await waitForStatus(h.db,run.runId,['succeeded','failed'],30000),'succeeded');
 const row=h.db.db.prepare('SELECT state FROM memory_extractions WHERE run_id=?').get(run.runId) as {state:string};assert.equal(row.state,memoryFailure==='extraction'?'failed':'completed');
 const failed=h.db.db.prepare("SELECT request_kind FROM model_requests WHERE run_id=? AND state='failed'").all(run.runId) as unknown as Array<{request_kind:string}>;assert.ok(failed.some(r=>r.request_kind===`memory_${memoryFailure==='selector'?'recall':'extraction'}`));
 if(memoryFailure==='extraction'){const {MemoryLifecycle}=await import('../src/agent/memoryLifecycle.js');const service=new MemoryLifecycle(h.db,h.dataDir);const prior=h.db.db.prepare('SELECT id,attempt_id,conversation_id FROM memory_extractions WHERE run_id=?').get(run.runId) as {id:string;attempt_id:string;conversation_id:string};const retried=service.prepare(run.runId,prior.attempt_id,h.projectId,prior.conversation_id);assert.equal(retried.operationId,prior.id);service.finish(prior.id,prior.attempt_id,'completed');assert.equal(service.prepare(run.runId,prior.attempt_id,h.projectId,prior.conversation_id).skipped,'already-processed');}
 }
});
test('停止真实提炼会取消游标和上游请求，不再写入记忆',async t=>{
 const state:UpstreamState={mode:'memory',requests:[],memoryFailure:'slow-extraction'};const h=await buildHarness(t,await httpsFixture(t,state),true);
 const run=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'完成并记住反馈',modelConfigId:h.modelConfigId,modelId:'test-model'});
 let started=false;for(let i=0;i<100;i++){if(h.db.db.prepare("SELECT id FROM model_requests WHERE run_id=? AND request_kind='memory_extraction' AND state='started'").get(run.runId)){started=true;break;}await new Promise(r=>setTimeout(r,50));}assert.ok(started);
 await h.supervisor.cancelRun(run.runId,'user_requested');assert.equal(await waitForStatus(h.db,run.runId,['cancelled'],20000),'cancelled');
 assert.equal((h.db.db.prepare('SELECT state FROM memory_extractions WHERE run_id=?').get(run.runId) as {state:string}).state,'cancelled');assert.equal(existsSync(join(h.dataDir,'memory',h.projectId,'automatic.md')),false);
});
test('真实Pi交接保存走来源核对与回读，直接记忆写入跳过重复自动提炼',async t=>{
 const source='# 项目状态\n当前代码A，B未验证';const state:UpstreamState={mode:'memory',requests:[],customTool:{name:'memory_handoff_save',args:{source_hash:createHash('sha256').update(source).digest('hex'),summary:'当前代码A',verified:['A通过测试'],unverified:['B未验'],next_steps:['核对B']}}};const h=await buildHarness(t,await httpsFixture(t,state),true);writeFileSync(join(h.projectDir,'PROJECT_STATE.md'),source);
 const run=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'保存交接',modelConfigId:h.modelConfigId,modelId:'test-model'});assert.equal(await waitForStatus(h.db,run.runId,['succeeded','failed'],30000),'succeeded');
 assert.equal(state.requests.length,2);const receipt=h.db.db.prepare('SELECT source_hash FROM memory_handoffs WHERE project_id=?').get(h.projectId) as {source_hash:string};assert.equal(receipt.source_hash,state.customTool!.args.source_hash);assert.equal(h.db.db.prepare('SELECT count(*) n FROM memory_extractions WHERE run_id=?').get(run.runId)!.n,0);
});


test('相同文字的新一轮仍有独立提炼边界，同轮成功边界才去重',async t=>{
 const state:UpstreamState={mode:'memory',requests:[],memoryFailure:'extraction'};const h=await buildHarness(t,await httpsFixture(t,state),true);let conversationId:string|null=null;
 for(let i=0;i<2;i++){const run=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId,objective:'今天请保持相同偏好',modelConfigId:h.modelConfigId,modelId:'test-model'});conversationId=run.conversationId;assert.equal(await waitForStatus(h.db,run.runId,['succeeded','failed'],30000),'succeeded');}
 const rows=h.db.db.prepare('SELECT boundary_hash FROM memory_extractions WHERE conversation_id=?').all(conversationId) as unknown as Array<{boundary_hash:string}>;assert.equal(rows.length,2);assert.notEqual(rows[0]!.boundary_hash,rows[1]!.boundary_hash);
});


test('压缩预检编号：旧编号与重复提交拒绝，清单由监督器快照绑定，取消后不能提交', async t => {
 const state:UpstreamState={mode:'slow',requests:[]};const h=await buildHarness(t,await httpsFixture(t,state));
 const created=h.supervisor.createOrdinaryRun({userId:h.userId,sessionId:h.sessionId,projectId:h.projectId,conversationId:null,objective:'preflight fixture',modelConfigId:h.modelConfigId,modelId:'test-model'});
 const deadline=Date.now()+15_000;
 while(!state.requests.length&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,30));
 assert.ok(state.requests.length,'等待主请求消费初始输入');
 const active=h.supervisor.active.get(created.runId)!;
 type Result={ok:boolean;payload?:{preflightId?:string;checkpointId?:string};error?:{code:string}};
 const internal=h.supervisor as unknown as {handleAgentFrame(active:unknown,frame:unknown,cb:(ok:boolean,payload:Result['payload'],error:Result['error'])=>void):Promise<void>};
 const send=async(method:string,payload:unknown)=>{let result:Result={ok:false};await internal.handleAgentFrame(active,{method,payload},(ok,payload,error)=>{result={ok,payload,error};});return result;};
 const sourceManifest={firstKeptEntryId:'kept',summarizedIds:['old'],keptIds:['kept'],previousCheckpointEntryId:null};
 const first=await send('compaction_preflight',{sourceManifest,inputThroughSeq:1});assert.equal(first.ok,true);
 const second=await send('compaction_preflight',{sourceManifest,inputThroughSeq:1});assert.equal(second.ok,true);
 assert.notEqual(first.payload!.preflightId,second.payload!.preflightId);
 const propose=(preflightId?:string)=>send('context_checkpoint_proposed',{preflightId,summary:'压缩摘要',tokensBefore:100,tokensAfter:20,sourceManifest:{keptIds:['forged']},sourceSeq:999,firstKeptEntryId:'forged'});
 assert.equal((await propose()).error?.code,'VALIDATION_FAILED');
 assert.equal((await propose(first.payload!.preflightId)).error?.code,'VALIDATION_FAILED');
 sourceManifest.keptIds[0]='mutated';
 const accepted=await propose(second.payload!.preflightId);assert.equal(accepted.ok,true);
 const row=h.db.db.prepare('SELECT * FROM context_checkpoints WHERE id=?').get(accepted.payload!.checkpointId!)!;
 assert.equal(row.preflight_id,second.payload!.preflightId);
 assert.equal(row.first_kept_entry_id,'kept');assert.equal(row.kept_entry_ids_json,'["kept"]');assert.equal(row.source_seq,1);
 assert.equal(row.state,'proposed','仍须实际应用后才确认');
 assert.equal((await propose(second.payload!.preflightId)).error?.code,'VALIDATION_FAILED');
 const third=await send('compaction_preflight',{sourceManifest:{...sourceManifest,keptIds:['kept']},inputThroughSeq:1});assert.equal(third.ok,true);
 await h.supervisor.cancelRun(created.runId,'preflight-cancel');
 assert.equal((await propose(third.payload!.preflightId)).error?.code,'REQUEST_IN_PROGRESS');
 assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM context_checkpoints WHERE run_id=?').get(created.runId)!.n,1);
});

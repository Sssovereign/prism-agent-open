import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { randomUUID, createHash } from 'node:crypto';
import { Db } from '../src/storage/db.js';
import { migrate, defaultMigrationsDir } from '../src/storage/migrate.js';
import { TicketRegistry } from '../src/agent/tickets.js';
import { ModelRequestRegistry } from '../src/agent/modelRequests.js';
import { ModelGatewayServer } from '../src/agent/gatewayServer.js';
import { Supervisor } from '../src/agent/supervisor.js';
import { CredentialVault } from '../src/models/vault.js';
import { RUNTIME_STREAM_PROFILE } from '../src/models/streamNetwork.js';
import { buildContextManifest, resolveRequestInput, readProjectRules, PROJECT_RULES_MAX_BYTES } from '../src/agent/contextManifest.js';
import { SteerRegistry } from '../src/agent/steerRegistry.js';
import type { GrantRow } from '../src/files/picker.js';
import { waitStateVersion } from '../src/agent/waitStateVersion.js';

// —— 返修定向验证（ZCODE_ACCEPTANCE_FIX.md F01/F02/F05/F06） ——
// F05：请求输入seq绑定——压缩/修复不消费主输入；body构造后到达的补充保持未消费。
// F06：补充投递幂等——重复clientMessageId不重复入队；同ID不同内容拒绝；恰好投递一次。
// F02：项目AGENTS.md按授权与排除规则读取（越界/软链/超长/二进制显式拒绝）并注入system prompt。
// F01：同会话追问携带正式历史+已确认checkpoint摘要；manifest记入审计。

const here = dirname(fileURLToPath(import.meta.url));
const runnerEntry = fileURLToPath(new URL('../src/agent/runnerMain.js', import.meta.url));

interface UpstreamState { mode: 'history' | 'race' | 'f04' | 'f04replay' | 'f04read' | 'f07'; requests: string[]; hold?: Promise<void>; release?: () => void; f07?: { h1: string; hashCommand: string; evilCommand: string; externalWrite: () => void } }

function sseData(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
function chunk(delta: Record<string, unknown>, finishReason?: string, usage?: Record<string, unknown>): string {
  const body: Record<string, unknown> = { id: 'chatcmpl-x', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason: finishReason ?? null }] };
  if (usage) body.usage = usage;
  return sseData(body);
}
const FAKE_USAGE = { prompt_tokens: 120, completion_tokens: 24, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } };

async function httpsFixture(t: { after(fn: () => unknown): unknown }, state: UpstreamState): Promise<{ baseUrl: string; certPem: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'fix-upstream-'));
  const cert = join(dir, 'cert.pem'), key = join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert,
    '-days', '2', '-nodes', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const certPem = readFileSync(cert, 'utf8');
  const server = createHttpsServer({ key: readFileSync(key, 'utf8'), cert: certPem }, (req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
    req.on('end', () => {
      state.requests.push(body);
      if (req.headers.authorization !== 'Bearer sk-test') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture authorization rejected' } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      void (async () => {
        if (state.mode === 'history') {
          res.write(chunk({ role: 'assistant', content: body.includes('PERSISTED_MEMORY_WORD') ? 'PERSISTED_MEMORY_WORD' : 'MISSING_CONTEXT' }, 'stop', FAKE_USAGE));
          res.end('data: [DONE]\n\n');
          return;
        }
        // race：第一个请求被测试挂起（模拟在绑定完成后、响应前插入补充）；其后请求回文本答复
        if (state.mode === 'race') {
          if (state.requests.length === 1 && state.hold) await state.hold;
          res.write(chunk({ role: 'assistant', content: '' }));
          await new Promise(r => setTimeout(r, 150));
          const answer = state.requests.length === 1 ? '第一轮阶段性答复。' : '已收到补充，全部完成。';
          res.write(chunk({ role: 'assistant', content: answer }, 'stop', FAKE_USAGE));
          res.end('data: [DONE]\n\n');
          return;
        }
        // f07：写文件(broker)→bash相对路径hash(工作副本)→外部并发修改+过期expectedHash写(冲突)→
        // bash直写原项目目录(OS拒绝)→收尾
        if (state.mode === 'f07' && state.f07) {
          const f07 = state.f07;
          if (state.requests.length === 1) {
            res.write(chunk({ role: 'assistant', content: '' }));
            res.write(chunk({ tool_calls: [{ index: 0, id: 'call_w', type: 'function', function: { name: 'write_file', arguments: '' } }] }));
            await new Promise(r => setTimeout(r, 60));
            res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: 'README.md', content: 'modified-v2', expected_hash: f07.h1 }) } }] }));
            res.write(chunk({}, 'tool_calls', FAKE_USAGE));
            res.end('data: [DONE]\n\n');
            return;
          }
          if (state.requests.length === 2) {
            res.write(chunk({ role: 'assistant', content: '' }));
            res.write(chunk({ tool_calls: [{ index: 0, id: 'call_b1', type: 'function', function: { name: 'bash', arguments: '' } }] }));
            await new Promise(r => setTimeout(r, 60));
            res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: f07.hashCommand, timeout_ms: 30000 }) } }] }));
            res.write(chunk({}, 'tool_calls', FAKE_USAGE));
            res.end('data: [DONE]\n\n');
            return;
          }
          if (state.requests.length === 3) {
            f07.externalWrite(); // 外部并发修改原项目（不经broker）
            res.write(chunk({ role: 'assistant', content: '' }));
            res.write(chunk({ tool_calls: [{ index: 0, id: 'call_w2', type: 'function', function: { name: 'write_file', arguments: '' } }] }));
            await new Promise(r => setTimeout(r, 60));
            res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: 'README.md', content: 'should-fail', expected_hash: f07.h1 }) } }] }));
            res.write(chunk({}, 'tool_calls', FAKE_USAGE));
            res.end('data: [DONE]\n\n');
            return;
          }
          if (state.requests.length === 4) {
            res.write(chunk({ role: 'assistant', content: '' }));
            res.write(chunk({ tool_calls: [{ index: 0, id: 'call_b2', type: 'function', function: { name: 'bash', arguments: '' } }] }));
            await new Promise(r => setTimeout(r, 60));
            res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: f07.evilCommand, timeout_ms: 30000 }) } }] }));
            res.write(chunk({}, 'tool_calls', FAKE_USAGE));
            res.end('data: [DONE]\n\n');
            return;
          }
          res.write(chunk({ role: 'assistant', content: 'F07工作副本链路验证完成。' }, 'stop', FAKE_USAGE));
          res.end('data: [DONE]\n\n');
          return;
        }
        // f04/f04replay：请求1要求写文件；请求2挂起（工具已成功后测试注入凭据中断）；
        // f04恢复后回纯文本；f04replay恢复后重发同参数写文件（验证监督器回放门禁），随后纯文本收尾
        if (state.mode === 'f04' || state.mode === 'f04replay' || state.mode === 'f04read') {
          if (state.requests.length === 1) {
            res.write(chunk({ role: 'assistant', content: '' }));
            res.write(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: state.mode === 'f04read' ? 'read_file' : 'write_file', arguments: '' } }] }));
            await new Promise(r => setTimeout(r, 60));
            res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: state.mode === 'f04read' ? '{"path":"hello.txt"}' : '{"path":"hello.txt","content":"v1"}' } }] }));
            res.write(chunk({}, 'tool_calls', FAKE_USAGE));
            res.end('data: [DONE]\n\n');
            return;
          }
          if (state.requests.length === 2 && state.hold) await state.hold;
          if ((state.mode === 'f04replay' || state.mode === 'f04read') && state.requests.length === 3) {
            // 恢复后模型重发与中断前完全相同的工具调用：应被监督器按账本回放，不产生第二次副作用
            res.write(chunk({ role: 'assistant', content: '' }));
            res.write(chunk({ tool_calls: [{ index: 0, id: 'call_r', type: 'function', function: { name: state.mode === 'f04read' ? 'read_file' : 'write_file', arguments: '' } }] }));
            await new Promise(r => setTimeout(r, 60));
            res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: state.mode === 'f04read' ? '{"path":"hello.txt"}' : '{"path":"hello.txt","content":"v1"}' } }] }));
            res.write(chunk({}, 'tool_calls', FAKE_USAGE));
            res.end('data: [DONE]\n\n');
            return;
          }
          res.write(chunk({ role: 'assistant', content: '恢复后确认：账本已记载hello.txt已成功写入，无需重复执行，任务完成。' }, 'stop', FAKE_USAGE));
          res.end('data: [DONE]\n\n');
          return;
        }
      })().catch(() => { try { res.end(); } catch { /* 客户端已断开 */ } });
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', () => resolve()); server.once('error', reject); });
  const t05dir = dir;
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(t05dir, { recursive: true, force: true }); });
  return { baseUrl: `https://127.0.0.1:${(server.address() as { port: number }).port}`, certPem };
}

interface Harness { db: Db; supervisor: Supervisor; vault: CredentialVault; dataDir: string; projectDir: string; userId: string; projectId: string; modelConfigId: string; sessionId: string; close(): Promise<void> }

async function buildHarness(t: { after(fn: () => unknown): unknown }, upstream: { baseUrl: string; certPem: string }, opts?: { dataDir?: string; projectDir?: string; seed?: boolean }): Promise<Harness> {
  const reuse = !!(opts?.dataDir && opts?.projectDir);
  const seed = opts?.seed ?? !reuse; // 显式seed；未给目录时默认播种，复用目录时默认不播种
  const dataDir = opts?.dataDir ?? mkdtempSync(join(tmpdir(), 'fix-data-'));
  const projectDir = opts?.projectDir ?? mkdtempSync(join(tmpdir(), 'fix-project-'));
  if (seed) writeFileSync(join(projectDir, 'AGENTS.md'), '# 测试项目规则\nPRISM_RULE_MARKER_9F2A 保持文件小而清晰。\n');
  const db = new Db(join(dataDir, 'workbench.sqlite'));
  migrate(db, defaultMigrationsDir());
  const now = new Date().toISOString();
  let userId: string = randomUUID(), projectId: string = randomUUID(), modelConfigId: string = randomUUID();
  if (seed) {
    db.db.prepare(`INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at)
      VALUES (?,?,?,'','',0,?,?)`).run(userId, 'tester', 'x', now, now);
    db.db.prepare('INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(projectId, userId, '返修测试项目', now, now);
    db.db.prepare(`INSERT INTO workspace_grants(id,project_id,canonical_root,access,revision,selected_by,excludes_json,created_at,updated_at)
      VALUES (?,?,?,'write',1,?,'[]',?,?)`).run(randomUUID(), projectId, projectDir, userId, now, now);
    db.db.prepare(`INSERT INTO model_configs(id,owner_user_id,preset,name,base_url,api_protocol,revision,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,'openai-completions',1,1,?,?)`).run(modelConfigId, userId, 'openai', '测试上游', upstream.baseUrl, now, now);
    db.db.prepare(`INSERT INTO model_entries(id,config_id,model_id,display_name,parameters_json,enabled,created_at,updated_at)
      VALUES (?,?,?,'测试模型','{"contextWindow":16384,"maxOutputTokens":1024}',1,?,?)`).run(randomUUID(), modelConfigId, 'test-model', now, now);
  }
  else {
    const u = db.db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string };
    const p = db.db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string };
    const m = db.db.prepare('SELECT id FROM model_configs LIMIT 1').get() as { id: string };
    userId = u.id; projectId = p.id; modelConfigId = m.id;
  }

  const sessionId = 'sess-fix-test';
  const vault = new CredentialVault();
  vault.set(sessionId, modelConfigId, 'sk-test', new Date(Date.now() + 3600_000).toISOString());
  const tickets = new TicketRegistry(db);
  const registry = new ModelRequestRegistry(db, runId => {
    const row = db.db.prepare('SELECT status, cancel_requested_at FROM runs WHERE id=?').get(runId) as { status: string; cancel_requested_at: string | null } | undefined;
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
  const runtimeSettings=supervisor.runtimeSettings.bind(supervisor);supervisor.runtimeSettings=userId=>({...runtimeSettings(userId),memoryEnabled:false});
  await gateway.ready;
  let closedOnce = false;
  const close = async (): Promise<void> => {
    if (closedOnce) return; // 显式关闭+t.after钩子可能双重触发：幂等
    closedOnce = true;
    await supervisor.stop();
    await gateway.close();
    db.close();
    if (!reuse) {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  };
  t.after(() => { void close(); });
  return { db, supervisor, vault, dataDir, projectDir, userId, projectId, modelConfigId, sessionId, close };
}

function waitForStatus(db: Db, runId: string, statuses: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const row = db.db.prepare('SELECT status FROM runs WHERE id=?').get(runId) as { status: string } | undefined;
      if (row && statuses.includes(row.status)) { clearInterval(timer); resolve(row.status); }
      else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        const events = db.db.prepare('SELECT seq,type FROM run_events ORDER BY seq').all() as unknown as Array<{ seq: number; type: string }>;
        reject(new Error(`等待状态${statuses.join('/')}超时；当前=${row?.status ?? '无'}；事件=${events.map(e => `${e.seq}:${e.type}`).join(',')}`));
      }
    }, 400);
    timer.unref?.();
  });
}

// —— F05单元：请求输入seq绑定 ——

function seedBindingDb(t: { after(fn: () => unknown): unknown }): { db: Db; conversationId: string; ids: string[] } {
  const dataDir = mkdtempSync(join(tmpdir(), 'fix-bind-'));
  const db = new Db(join(dataDir, 'workbench.sqlite'));
  migrate(db, defaultMigrationsDir());
  t.after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const userId = randomUUID(), projectId = randomUUID(), conversationId = randomUUID();
  db.db.prepare(`INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,'','',0,?,?)`).run(userId, 'b', 'x', now, now);
  db.db.prepare('INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(projectId, userId, 'p', now, now);
  db.db.prepare(`INSERT INTO conversations(id,project_id,mode,title,last_message_seq,created_at,updated_at) VALUES (?,?, 'ordinary','c',3,?,?)`).run(conversationId, projectId, now, now);
  const mk = (seq: number, consumed: boolean): string => {
    const id = randomUUID();
    db.db.prepare(`INSERT INTO messages(id,conversation_id,run_id,author_type,role_id,seq,visibility,state,content_json,consumed_cursor_json,created_at,updated_at)
      VALUES (?,?,NULL,'user','ordinary',?,'public','published',?,?,?,?)`)
      .run(id, conversationId, seq, JSON.stringify({ text: `消息${seq}` }), consumed ? '{}' : null, now, now);
    return id;
  };
  const ids = [mk(1, false), mk(2, false), mk(3, true)]; // 目标(1)、补充(2)、已消费(3)
  return { db, conversationId, ids };
}

test('F05单元：main请求按inputThroughSeq绑定未消费用户消息；压缩/修复不消费；越界显式拒绝', t => {
  const { db, conversationId, ids } = seedBindingDb(t);
  // body只构造到目标seq=1：绑定目标；补充(seq=2)与已消费(seq=3)不绑定
  const first = resolveRequestInput(db, conversationId, 'main', 1, 1);
  assert.deepEqual(first.ids, [ids[0]]);
  assert.equal(first.sourceSeq, 1);
  // body构造到2：绑定目标+补充（此时补充真正进入请求才算消费）
  const second = resolveRequestInput(db, conversationId, 'main', 2, 1);
  assert.deepEqual(second.ids, [ids[0], ids[1]]);
  // 压缩/修复请求不消费主输入（无论游标多少）
  assert.deepEqual(resolveRequestInput(db, conversationId, 'compaction', 2, 1), { ids: [], sourceSeq: null });
  assert.deepEqual(resolveRequestInput(db, conversationId, 'repair', 2, 1), { ids: [], sourceSeq: null });
  // 越界/非法显式拒绝
  assert.throws(() => resolveRequestInput(db, conversationId, 'main', 0, 1), /REQUEST_INPUT_SEQ_BEFORE_OBJECTIVE/);
  assert.throws(() => resolveRequestInput(db, conversationId, 'main', 1.5, 1), /REQUEST_INPUT_SEQ_INVALID/);
  assert.throws(() => resolveRequestInput(db, conversationId, 'main', 99, 1), /REQUEST_INPUT_SEQ_AHEAD/);
  // 目标已消费后：只绑定剩余未消费
  db.db.prepare('UPDATE messages SET consumed_cursor_json=? WHERE id=?').run('{}', ids[0]!);
  const third = resolveRequestInput(db, conversationId, 'main', 2, 1);
  assert.deepEqual(third.ids, [ids[1]]);
});

// —— F06单元：SteerRegistry投递状态机 ——

test('F06单元：messageId幂等登记+同ID异文拒绝+恰好一次确认', () => {
  const reg = new SteerRegistry();
  assert.equal(reg.accept('m1', '补充A', 5), 'accepted');
  assert.equal(reg.accept('m1', '补充A', 5), 'duplicate', '重复通知幂等');
  assert.equal(reg.accept('m1', '篡改内容', 5), 'conflict', '同ID不同内容拒绝');
  assert.equal(reg.accept('m2', '补充A', 6), 'accepted', '不同ID相同文本是合法双发');
  assert.equal(reg.markApplied('m1'), true);
  assert.equal(reg.markApplied('m1'), false, '恰好一次：重复确认返回false');
  assert.equal(reg.isApplied('m1'), true);
  assert.equal(reg.isApplied('m2'), false);
  assert.equal(reg.seqOf('m1'), 5);
  // 文本匹配最早的未确认条目（FIFO）；已确认的m1不再匹配
  assert.equal(reg.matchOldestUnappliedByText('补充A'), 'm2');
  assert.deepEqual(reg.unappliedIds(), ['m2']);
});

// —— F06单元：监督器steer按clientMessageId幂等 ——

test('F06单元：监督器steer相同clientMessageId返回既有messageId且不重复入队', async t => {
  const state: UpstreamState = { mode: 'history', requests: [] };
  const upstream = await httpsFixture(t, state);
  const h = await buildHarness(t, upstream);
  // 建一个会话+run（真实执行与否不影响断言：steer幂等只依赖conversation与run存在）
  const created = h.supervisor.createOrdinaryRun({
    userId: h.userId, sessionId: h.sessionId, projectId: h.projectId, conversationId: null,
    objective: '仅用于steer幂等测试的目标。', modelConfigId: h.modelConfigId, modelId: 'test-model',
  });
  const run = h.db.db.prepare('SELECT conversation_id, status FROM runs WHERE id=?').get(created.runId) as { conversation_id: string; status: string };
  const first = h.supervisor.steer(created.runId, h.userId, '请补充说明A。', 'cmid-1');
  assert.equal(first.duplicate, false);
  const again = h.supervisor.steer(created.runId, h.userId, '请补充说明A。', 'cmid-1');
  assert.equal(again.messageId, first.messageId, '相同clientMessageId返回同一messageId');
  assert.equal(again.duplicate, true, '标记为重复');
  const third = h.supervisor.steer(created.runId, h.userId, '请补充说明B。', 'cmid-2');
  assert.notEqual(third.messageId, first.messageId);
  const rows = h.db.db.prepare('SELECT id, seq FROM messages WHERE conversation_id=? AND author_type=? ORDER BY seq').all(run.conversation_id, 'user') as unknown as Array<{ id: string; seq: number }>;
  assert.equal(rows.length, 3, '目标+两条补充=3条用户消息（重复clientMessageId未重复入队）');
  assert.ok(rows[0]!.seq < rows[1]!.seq && rows[1]!.seq < rows[2]!.seq, 'seq严格递增');
  if (['running', 'finalizing', 'cancelling'].includes(run.status)) {
    await waitForStatus(h.db, created.runId, ['succeeded', 'failed', 'cancelled'], 60_000);
  }
});

// —— F02单元：项目规则读取的本机文件语义 ——

test('F02单元：AGENTS.md读取——hash正确/兼容旧排除字段/软链与目录外路径/缺失/超长截断/二进制', t => {
  const root = mkdtempSync(join(tmpdir(), 'fix-rules-'));
  const outside = mkdtempSync(join(tmpdir(), 'fix-rules-out-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const grant = (excludes: string[] = []) => ({
    id: 'g', project_id: 'p', canonical_root: root, access: 'write' as const, revision: 1,
    selected_by: 'u', revoked_at: null, excludes_json: JSON.stringify(excludes), created_at: '', updated_at: '', is_primary: 0,
  });

  // 正常读取：hash=文件字节sha256
  writeFileSync(join(root, 'AGENTS.md'), '# 规则\n内容A\n');
  const ok = readProjectRules(grant());
  assert.ok(ok && !('deniedReason' in ok), '存在AGENTS.md应成功读取');
  assert.equal(ok?.hash, createHash('sha256').update(readFileSync(join(root, 'AGENTS.md'))).digest('hex'));
  assert.equal(ok?.truncated, false);
  assert.ok((ok as { content?: string })?.content!.includes('内容A'));

  // 旧目录排除字段不再限制本机Agent
  const excluded = readProjectRules(grant(['AGENTS.md']));
  assert.equal(excluded?.content, ok?.content);

  // 普通文件软链接按宿主权限读取，允许指向项目外
  rmSync(join(root, 'AGENTS.md'));
  writeFileSync(join(root, 'real-rules.md'), '# 根内规则');
  symlinkSync(join(root, 'real-rules.md'), join(root, 'AGENTS.md'));
  const symlinkInside = readProjectRules(grant());
  assert.equal(symlinkInside?.content, '# 根内规则');
  rmSync(join(root, 'AGENTS.md'));
  writeFileSync(join(outside, 'secret.md'), '外部秘密');
  symlinkSync(join(outside, 'secret.md'), join(root, 'AGENTS.md'));
  const symlinkOutside = readProjectRules(grant());
  assert.equal(symlinkOutside?.content, '外部秘密');
  rmSync(join(root, 'AGENTS.md'));

  // 缺失→null（非错误，不注入）
  assert.equal(readProjectRules(grant()), null);

  // 超长→截断并标注（32KiB上限）
  mkdirSync(join(root, 'sub'), { recursive: true });
  symlinkSync(join(root, 'big.md'), join(root, 'AGENTS.md'));
  rmSync(join(root, 'AGENTS.md'));
  writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(PROJECT_RULES_MAX_BYTES + 100));
  const big = readProjectRules(grant());
  assert.equal(big && 'deniedReason' in big ? undefined : big?.truncated, true);
  assert.equal(Buffer.byteLength((big as { content?: string })?.content ?? ''), PROJECT_RULES_MAX_BYTES);
  rmSync(join(root, 'AGENTS.md'));

  // 二进制（含0字节）→RULE_BINARY
  writeFileSync(join(root, 'AGENTS.md'), Buffer.from([0x23, 0x00, 0x41]));
  const binary = readProjectRules(grant());
  assert.equal(binary && 'deniedReason' in binary ? binary.deniedReason : '', 'RULE_BINARY');
});

// —— F01/F02集成：同会话追问携带正式历史+checkpoint摘要+项目规则（真实runner链路） ——

test('F01+F02集成：第二轮请求包含规则、历史与已确认checkpoint摘要；manifest审计齐全', async t => {
  const state: UpstreamState = { mode: 'history', requests: [] };
  const upstream = await httpsFixture(t, state);
  const h = await buildHarness(t, upstream);
  const first = h.supervisor.createOrdinaryRun({
    userId: h.userId, sessionId: h.sessionId, projectId: h.projectId, conversationId: null,
    objective: '请记住PERSISTED_MEMORY_WORD，不调用工具。', modelConfigId: h.modelConfigId, modelId: 'test-model',
  });
  assert.equal(await waitForStatus(h.db, first.runId, ['succeeded', 'failed'], 40_000), 'succeeded');

  // 模拟第一轮运行中已确认的checkpoint（压缩路径单独覆盖；此处验证跨Run继承语义）
  const run1 = h.db.db.prepare('SELECT conversation_id FROM runs WHERE id=?').get(first.runId) as { conversation_id: string };
  const attempt1 = h.db.db.prepare(`SELECT a.id FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=?`).get(first.runId) as { id: string };
  const checkpointId = randomUUID();
  const now = new Date().toISOString();
  h.db.db.prepare(`INSERT INTO context_checkpoints(id,run_id,attempt_id,conversation_id,preflight_id,summary_text,first_kept_entry_id,kept_entry_ids_json,source_seq,tokens_before,tokens_after,schema_version,prompt_version,policy_version,model_id,state,created_at,updated_at,confirmed_at)
    VALUES (?,?,?,?,?,?,NULL,'[]',0,100,80,'v1','p1','pol1','test-model','confirmed',?,?,?)`)
    .run(checkpointId, first.runId, attempt1.id, run1.conversation_id, randomUUID(),
      'CHECKPOINT_MARKER_C4: 此前已完成记忆任务，用户词为PERSISTED_MEMORY_WORD。', now, now, now);

  const second = h.supervisor.createOrdinaryRun({
    userId: h.userId, sessionId: h.sessionId, projectId: h.projectId, conversationId: first.conversationId,
    objective: '刚才让你记住的词是什么？checkpoint里记了什么？', modelConfigId: h.modelConfigId, modelId: 'test-model',
  });
  assert.equal(await waitForStatus(h.db, second.runId, ['succeeded', 'failed'], 40_000), 'succeeded');

  const request = JSON.parse(state.requests[state.requests.length - 1]!) as { messages: Array<{ role: string; content: unknown }> };
  const flattened = request.messages.map(m => `${m.role}:${JSON.stringify(m.content)}`).join('\n');
  assert.ok(request.messages.some(m => m.role === 'assistant' && JSON.stringify(m.content).includes('PERSISTED_MEMORY_WORD')), 'F01：追问携带上一轮助手答复');
  assert.ok(request.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('PERSISTED_MEMORY_WORD')), 'F01：追问携带上一轮用户消息');
  assert.ok(flattened.includes('CHECKPOINT_MARKER_C4'), 'F01：追问携带已确认checkpoint摘要');
  assert.ok(flattened.includes('PRISM_RULE_MARKER_9F2A'), 'F02：system prompt注入项目AGENTS.md规则');

  // 审计：两轮run都有context_manifest事件；第二轮含checkpointId与规则hash
  const manifests = h.db.db.prepare(`SELECT run_id, payload_json FROM run_events WHERE type='run.context_manifest' ORDER BY seq`).all() as unknown as Array<{ run_id: string; payload_json: string }>;
  assert.equal(manifests.length, 2, '每次attempt应记录上下文清单审计');
  const secondManifest = JSON.parse(manifests.find(m => m.run_id === second.runId)?.payload_json ?? '{}') as { historyCount?: number; checkpointId?: string | null; rulesHash?: string | null };
  assert.ok((secondManifest.historyCount ?? 0) >= 2, 'F01：清单含正式历史');
  assert.equal(secondManifest.checkpointId, checkpointId, 'F01：清单含已确认checkpoint');
  assert.ok(secondManifest.rulesHash, 'F02：清单含规则hash');
  const grant = h.db.db.prepare('SELECT * FROM workspace_grants WHERE project_id=?').get(h.projectId) as unknown as GrantRow;
  const resumed = buildContextManifest(h.db, {runId:second.runId, conversationId:first.conversationId, grant, checkpointFrom:'run'});
  assert.equal(resumed.inheritedCheckpoint, null, '同Run恢复不能误取其他Run的checkpoint');
});

// —— F05/F06集成：绑定完成后插入的补充保持未消费，直到真正进入后续请求 ——

test('F05+F06集成：绑定后steer保持未消费→completion被deferred→拾取投递→恰好一次确认', async t => {
  const state: UpstreamState = { mode: 'race', requests: [] };
  const upstream = await httpsFixture(t, state);
  const h = await buildHarness(t, upstream);
  let releaseFirst!: () => void;
  state.hold = new Promise<void>(r => { releaseFirst = r; });

  const created = h.supervisor.createOrdinaryRun({
    userId: h.userId, sessionId: h.sessionId, projectId: h.projectId, conversationId: null,
    objective: '请先等第一轮指示，然后按补充继续。', modelConfigId: h.modelConfigId, modelId: 'test-model',
  });
  // 等第一个上游请求到达（此刻绑定已完成：propose先于fetch）
  for (let i = 0; i < 100 && state.requests.length === 0; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(state.requests.length, 1, '应已发出第一个上游请求');

  // 竞态点：请求1绑定完成后才插入补充——不得被请求1消费
  const steerResult = h.supervisor.steer(created.runId, h.userId, 'RACE_STEER_MARKER_7B：请补充执行这一条。', null);
  const firstReq = h.db.db.prepare(`SELECT input_message_ids_json, source_seq FROM model_requests WHERE run_id=? ORDER BY created_at ASC LIMIT 1`).get(created.runId) as { input_message_ids_json: string; source_seq: number | null };
  assert.ok(!JSON.parse(firstReq.input_message_ids_json).includes(steerResult.messageId), 'F05：绑定完成后插入的补充不得被当前请求消费');

  releaseFirst();
  const finalStatus = await waitForStatus(h.db, created.runId, ['succeeded', 'failed'], 60_000);
  assert.equal(finalStatus, 'succeeded');

  // 第二个请求：body包含补充文本；绑定集合包含补充
  assert.equal(state.requests.length, 2, '补充应触发第二个上游请求');
  const secondBody = state.requests[1]!;
  assert.ok(secondBody.includes('RACE_STEER_MARKER_7B'), '补充文本应进入后续请求body');
  const secondReq = h.db.db.prepare(`SELECT input_message_ids_json, source_seq FROM model_requests WHERE run_id=? ORDER BY created_at ASC LIMIT 1 OFFSET 1`).get(created.runId) as { input_message_ids_json: string; source_seq: number | null };
  assert.ok(JSON.parse(secondReq.input_message_ids_json).includes(steerResult.messageId), '补充进入请求2的绑定集合');
  assert.ok((secondReq.source_seq ?? 0) >= 2, '请求2游标推进到补充seq');

  // 消费确认：补充已消费；恰好一次投递（accepted_applied事件=1）
  const steerRow = h.db.db.prepare('SELECT consumed_cursor_json FROM messages WHERE id=?').get(steerResult.messageId) as { consumed_cursor_json: string | null };
  assert.ok(steerRow.consumed_cursor_json, '补充应在进入请求2后标记已消费');
  const appliedEvents = h.db.db.prepare(`SELECT type FROM run_events WHERE run_id=? AND type='message.accepted_applied'`).all(created.runId) as unknown as Array<{ type: string }>;
  assert.equal(appliedEvents.length, 1, 'F06：accepted_applied恰好一次');

  // F02横向断言：同一请求system prompt含项目规则
  assert.ok(secondBody.includes('PRISM_RULE_MARKER_9F2A'), 'F02：请求2的system prompt含项目规则');
  void existsSync; void mkdirSync;
});

test('F01重启/撤权/跨用户：服务重启后追问仍携带历史；授权撤销与跨用户会话拒绝追问', async t => {
  const state: UpstreamState = { mode: 'history', requests: [] };
  const upstream = await httpsFixture(t, state);
  const dataDir = mkdtempSync(join(tmpdir(), 'fix-restart-data-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'fix-restart-proj-'));
  t.after(() => { rmSync(dataDir, { recursive: true, force: true }); rmSync(projectDir, { recursive: true, force: true }); });

  // 第一次"服务生命周期"：创建会话并完成首轮（seed:首次播种）
  const h1 = await buildHarness(t, upstream, { dataDir, projectDir, seed: true });
  const first = h1.supervisor.createOrdinaryRun({
    userId: h1.userId, sessionId: h1.sessionId, projectId: h1.projectId, conversationId: null,
    objective: '请记住PERSISTED_MEMORY_WORD，不调用工具。', modelConfigId: h1.modelConfigId, modelId: 'test-model',
  });
  assert.equal(await waitForStatus(h1.db, first.runId, ['succeeded', 'failed'], 40_000), 'succeeded');
  await h1.close();

  // 重启（同一数据目录重新构建全部服务）：追问必须从持久DB恢复上下文
  const h2 = await buildHarness(t, upstream, { dataDir, projectDir });
  const second = h2.supervisor.createOrdinaryRun({
    userId: h2.userId, sessionId: h2.sessionId, projectId: h2.projectId, conversationId: first.conversationId,
    objective: '刚才让你记住的词是什么？', modelConfigId: h2.modelConfigId, modelId: 'test-model',
  });
  assert.equal(await waitForStatus(h2.db, second.runId, ['succeeded', 'failed'], 40_000), 'succeeded');
  const request = JSON.parse(state.requests[state.requests.length - 1]!) as { messages: Array<{ role: string; content: unknown }> };
  assert.ok(request.messages.some(m => m.role === 'assistant' && JSON.stringify(m.content).includes('PERSISTED_MEMORY_WORD')), '重启后追问应携带重启前的助手答复');

  // 撤权后追问拒绝
  h2.db.db.prepare('UPDATE workspace_grants SET revoked_at=? WHERE project_id=?').run(new Date().toISOString(), h2.projectId);
  assert.throws(() => h2.supervisor.createOrdinaryRun({
    userId: h2.userId, sessionId: h2.sessionId, projectId: h2.projectId, conversationId: first.conversationId,
    objective: '撤权后不能再执行', modelConfigId: h2.modelConfigId, modelId: 'test-model',
  }), '授权撤销后创建追问run应被拒绝');

  // 跨用户拒绝：另一用户（自己的项目）复用本会话
  const now = new Date().toISOString();
  const otherUser = randomUUID(), otherProject = randomUUID();
  h2.db.db.prepare(`INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,'','',0,?,?)`).run(otherUser, 'other', 'x', now, now);
  h2.db.db.prepare('INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(otherProject, otherUser, '他人项目', now, now);
  h2.db.db.prepare(`INSERT INTO workspace_grants(id,project_id,canonical_root,access,revision,selected_by,excludes_json,created_at,updated_at) VALUES (?,?,?,'read',1,?,'[]',?,?)`)
    .run(randomUUID(), otherProject, projectDir, otherUser, now, now);
  assert.throws(() => h2.supervisor.createOrdinaryRun({
    userId: otherUser, sessionId: h2.sessionId, projectId: otherProject, conversationId: first.conversationId,
    objective: '跨用户不能复用会话', modelConfigId: h2.modelConfigId, modelId: 'test-model',
  }), '跨用户复用会话应被拒绝');
  await h2.close();
});

// —— F04集成：工具成功后清Key→waiting_input→重供Key→恢复，账本随恢复请求下发，副作用不重复 ——

test('F04集成：凭据中断→重供→恢复；恢复请求携带副作用账本；旧工具成功计数保持1；重复resume幂等', async t => {
  const state: UpstreamState = { mode: 'f04', requests: [] };
  const upstream = await httpsFixture(t, state);
  const h = await buildHarness(t, upstream);
  let releaseSecond!: () => void;
  state.hold = new Promise<void>(r => { releaseSecond = r; });

  const created = h.supervisor.createOrdinaryRun({
    userId: h.userId, sessionId: h.sessionId, projectId: h.projectId, conversationId: null,
    objective: '请创建hello.txt，内容为v1。', modelConfigId: h.modelConfigId, modelId: 'test-model',
  });
  // 等工具真实执行成功（tool.completed ok=true）且第二个上游请求已发出并被挂起
  for (let i = 0; i < 100; i++) {
    const done = h.db.db.prepare(`SELECT type FROM run_events WHERE run_id=? AND type='tool.completed'`).get(created.runId) as { type: string } | undefined;
    if (done && state.requests.length >= 2) break;
    await new Promise(r => setTimeout(r, 200));
  }
  const toolOk = h.db.db.prepare(`SELECT COUNT(*) c FROM run_events WHERE run_id=? AND type='tool.completed'`).get(created.runId) as { c: number };
  assert.equal(toolOk.c, 1, '中断前write_file应恰好成功执行一次');
  assert.equal(state.requests.length, 2, '第二个上游请求应在挂起中');

  const supplement = h.supervisor.steer(created.runId, h.userId, 'RECOVERY_PENDING_INPUT_7A：完成后请保留这个补充要求。', 'recovery-pending-7a');

  // 工具成功后清除Key→运行中任务转入waiting_input（凭据中断路径）
  h.vault.clear(h.sessionId);
  h.supervisor.onCredentialChanged({ sessionId: h.sessionId });
  assert.equal(await waitForStatus(h.db, created.runId, ['waiting_input'], 20_000), 'waiting_input');
  releaseSecond(); // 挂起的旧响应已无消费者（旧attempt已失败）
  const runRow = h.db.db.prepare('SELECT status, stop_reason, updated_at FROM runs WHERE id=?').get(created.runId) as { status: string; stop_reason: string; updated_at: string };
  assert.equal(runRow.stop_reason, 'CREDENTIAL_REQUIRED');
  const attempt1Failed = h.db.db.prepare(`SELECT a.status, a.error_code FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=? ORDER BY a.number ASC`).all(created.runId) as unknown as Array<{ status: string; error_code: string | null }>;
  assert.equal(attempt1Failed[0]!.status, 'failed');
  assert.equal(attempt1Failed[0]!.error_code, 'CREDENTIAL_REQUIRED');

  let reasonVersion = waitStateVersion(runRow);
  // 无Key恢复→拒绝（CREDENTIAL_REQUIRED）
  await assert.rejects(() => h.supervisor.resumeWaitingRun(created.runId, h.userId, h.sessionId, reasonVersion), /API Key/, '未重新提供Key不得恢复');
  // 错误reasonVersion→WAIT_STATE_CHANGED（重复resume/过期刷新防护）
  h.vault.set(h.sessionId, h.modelConfigId, 'sk-test', new Date(Date.now() + 3600_000).toISOString());
  await assert.rejects(() => h.supervisor.resumeWaitingRun(created.runId, h.userId, h.sessionId, 'wrong-version'), /等待原因已变化/, 'reasonVersion不匹配应拒绝');

  // 相同等待原因、不同时间也必须使旧页面失效；旧实现只截取原因前缀，无法区分。
  const changedAt = new Date(Date.parse(runRow.updated_at) + 1000).toISOString();
  h.db.db.prepare('UPDATE runs SET updated_at=? WHERE id=?').run(changedAt, created.runId);
  await assert.rejects(() => h.supervisor.resumeWaitingRun(created.runId, h.userId, h.sessionId, reasonVersion), /等待原因已变化/, '相同原因再次等待也不得接受过期版本');
  reasonVersion = waitStateVersion({stop_reason:runRow.stop_reason, updated_at:changedAt});

  // 重供Key→恢复
  const resumed = await h.supervisor.resumeWaitingRun(created.runId, h.userId, h.sessionId, reasonVersion);
  assert.ok(resumed.attemptId, '恢复应产生新attempt');
  // 幂等：恢复后run已非waiting_input，重复resume被拒
  await assert.rejects(() => h.supervisor.resumeWaitingRun(created.runId, h.userId, h.sessionId, reasonVersion), /不可恢复/, '重复resume应被拒绝');

  for (let i = 0; i < 100 && state.requests.length < 3; i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(state.requests[2]?.includes('RECOVERY_PENDING_INPUT_7A'), '恢复请求不能丢失同一Run中断前的用户补充');
  assert.equal(await waitForStatus(h.db, created.runId, ['succeeded', 'failed'], 60_000), 'succeeded');
  const consumedSupplement = h.db.db.prepare('SELECT consumed_cursor_json FROM messages WHERE id=?').get(supplement.messageId) as { consumed_cursor_json: string | null };
  assert.ok(consumedSupplement.consumed_cursor_json, '恢复补充实际进入请求后才能推进消费游标');
  assert.equal(state.requests.length, 3, '恢复后应恰好发出一个上游请求');

  // 恢复请求携带副作用账本（hello.txt已成功记载）且项目规则仍在
  const recoveredBody = state.requests[2]!;
  assert.ok(recoveredBody.includes('已执行的工具账本'), 'F04：恢复请求应注入副作用账本');
  assert.ok(recoveredBody.includes('hello.txt'), '账本应包含已写文件路径');
  assert.ok(recoveredBody.includes('PRISM_RULE_MARKER_9F2A'), '恢复请求同样注入项目规则（F02）');

  // 副作用计数：write_file真实执行=1；恢复attempt未再执行（账本+fixture纯文本）；无replay事件
  const succeededReal = h.db.db.prepare(`SELECT COUNT(*) c FROM tool_invocations WHERE run_id=? AND tool_name='write_file' AND state='succeeded' AND replayed_from_invocation_id IS NULL`).get(created.runId) as { c: number };
  assert.equal(succeededReal.c, 1, 'F04：write_file成功执行计数保持1');
  const replays = h.db.db.prepare(`SELECT COUNT(*) c FROM run_events WHERE run_id=? AND type='tool.replayed'`).get(created.runId) as { c: number };
  assert.equal(replays.c, 0);
  const attempts = h.db.db.prepare(`SELECT a.number, a.status FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=? ORDER BY a.number ASC`).all(created.runId) as unknown as Array<{ number: number; status: string }>;
  assert.deepEqual(attempts.map(a => a.status), ['failed', 'succeeded'], '旧attempt失败不交付，新attempt成功');
  // manifest审计：恢复attempt记录resume模式与账本条数
  const manifestRow = h.db.db.prepare(`SELECT payload_json FROM run_events WHERE run_id=? AND type='run.context_manifest' ORDER BY seq DESC LIMIT 1`).get(created.runId) as { payload_json: string };
  const manifest = JSON.parse(manifestRow.payload_json) as { mode?: string; ledgerCount?: number };
  assert.equal(manifest.mode, 'resume');
  assert.ok((manifest.ledgerCount ?? 0) >= 1, '恢复清单应含账本条目');
});

test('F04重放门禁：恢复后模型重发同参数写文件调用→按账本回放结果，真实执行计数仍为1', async t => {
  const state: UpstreamState = { mode: 'f04replay', requests: [] };
  const upstream = await httpsFixture(t, state);
  const h = await buildHarness(t, upstream);
  let releaseSecond!: () => void;
  state.hold = new Promise<void>(r => { releaseSecond = r; });

  const created = h.supervisor.createOrdinaryRun({
    userId: h.userId, sessionId: h.sessionId, projectId: h.projectId, conversationId: null,
    objective: '请创建hello.txt，内容为v1。', modelConfigId: h.modelConfigId, modelId: 'test-model',
  });
  for (let i = 0; i < 100; i++) {
    const done = h.db.db.prepare(`SELECT type FROM run_events WHERE run_id=? AND type='tool.completed'`).get(created.runId) as { type: string } | undefined;
    if (done && state.requests.length >= 2) break;
    await new Promise(r => setTimeout(r, 200));
  }
  h.vault.clear(h.sessionId);
  h.supervisor.onCredentialChanged({ sessionId: h.sessionId });
  assert.equal(await waitForStatus(h.db, created.runId, ['waiting_input'], 20_000), 'waiting_input');
  releaseSecond();
  const runRow = h.db.db.prepare('SELECT stop_reason, updated_at FROM runs WHERE id=?').get(created.runId) as { stop_reason: string; updated_at: string };
  h.vault.set(h.sessionId, h.modelConfigId, 'sk-test', new Date(Date.now() + 3600_000).toISOString());
  const reasonVersion = waitStateVersion(runRow);
  await h.supervisor.resumeWaitingRun(created.runId, h.userId, h.sessionId, reasonVersion);
  assert.equal(await waitForStatus(h.db, created.runId, ['succeeded', 'failed'], 60_000), 'succeeded');

  // 重发调用被回放：tool.replayed事件=1；真实执行write_file成功计数=1；attempt2的replay调用不产生tool.completed
  const replays = h.db.db.prepare(`SELECT payload_json FROM run_events WHERE run_id=? AND type='tool.replayed'`).all(created.runId) as unknown as Array<{ payload_json: string }>;
  assert.equal(replays.length, 1, '恢复后同参数重发应恰好回放一次');
  const replayPayload = JSON.parse(replays[0]!.payload_json) as { replayedFromInvocationId?: string };
  assert.ok(replayPayload.replayedFromInvocationId, '回放事件应指明来源调用');
  const succeededReal = h.db.db.prepare(`SELECT COUNT(*) c FROM tool_invocations WHERE run_id=? AND tool_name='write_file' AND state='succeeded' AND replayed_from_invocation_id IS NULL`).get(created.runId) as { c: number };
  assert.equal(succeededReal.c, 1, '真实执行计数保持1（回放行不计入真实执行）');
  const replayRow = h.db.db.prepare(`SELECT replayed_from_invocation_id FROM tool_invocations WHERE run_id=? AND replayed_from_invocation_id IS NOT NULL`).get(created.runId) as { replayed_from_invocation_id: string | null };
  assert.equal(replayRow.replayed_from_invocation_id, replayPayload.replayedFromInvocationId, '回放登记行与事件指向同一来源');
  // 回放结果回给了模型（第四次上游请求的上下文里含回放返回，任务仍收敛）
  assert.equal(state.requests.length, 4, '回放后模型收到结果并继续，发出收尾请求');
  const okEvents = h.db.db.prepare(`SELECT COUNT(*) c FROM run_events WHERE run_id=? AND type='tool.completed'`).get(created.runId) as { c: number };
  assert.equal(okEvents.c, 1, 'tool.completed仍只应有一次（首次真实执行）');
});

// —— 真实目录链路（真实runner+bash+网络策略） ——

test('本机目录集成：文件工具和shell共享真实目录；外部并发修改冲突保留提案；shell直写原目录成功', async t => {
  const state: UpstreamState = { mode: 'f07', requests: [] };
  const upstream = await httpsFixture(t, state);
  const h = await buildHarness(t, upstream);
  const H1 = createHash('sha256').update('base-v1').digest('hex');
  const H2 = createHash('sha256').update('modified-v2').digest('hex');
  writeFileSync(join(h.projectDir, 'README.md'), 'base-v1');
  const hashCommand = `${process.execPath} -e 'const fs=require("fs"),c=require("crypto");console.log("HASH:"+c.createHash("sha256").update(fs.readFileSync("README.md")).digest("hex"))'`;
  const evilCommand = `printf x > ${JSON.stringify(join(h.projectDir, 'evil.txt'))}`;
  state.f07 = { h1: H1, hashCommand, evilCommand, externalWrite: () => { writeFileSync(join(h.projectDir, 'README.md'), 'external-v3'); } };

  const created = h.supervisor.createOrdinaryRun({
    userId: h.userId, sessionId: h.sessionId, projectId: h.projectId, conversationId: null,
    objective: '请修改README并运行脚本验证。', modelConfigId: h.modelConfigId, modelId: 'test-model',
  });
  const finalStatus = await waitForStatus(h.db, created.runId, ['succeeded', 'failed'], 120_000);
  if (finalStatus !== 'succeeded') {
    const events = h.db.db.prepare(`SELECT seq, type, payload_json FROM run_events WHERE run_id=? ORDER BY seq`).all(created.runId) as unknown as Array<{ seq: number; type: string; payload_json: string }>;
    writeFileSync('/tmp/f07-debug.json', JSON.stringify({ finalStatus, requests: state.requests.map(r => r.slice(0, 300)), events: events.map(e => ({ seq: e.seq, type: e.type, payload: e.payload_json.slice(0, 400) })) }, null, 1));
  }
  assert.equal(finalStatus, 'succeeded');
  assert.equal(state.requests.length, 5);

  const ready = h.db.db.prepare(`SELECT payload_json FROM run_events WHERE run_id=? AND type='workspace.ready'`).all(created.runId) as Array<{ payload_json: string }>;
  assert.equal(ready.length, 1);
  assert.equal(JSON.parse(ready[0]!.payload_json).filesystem, 'host');
  const attempt = h.db.db.prepare(`SELECT a.id FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=? LIMIT 1`).get(created.runId) as { id: string };
  assert.equal(existsSync(join(h.dataDir, 'runtime', attempt.id, 'workcopy')), false, '不再创建副本');

  // 相对路径脚本应读到真实项目中的最新修改
  const bashRows = h.db.db.prepare(`SELECT result_json, state, error_code FROM tool_invocations WHERE run_id=? AND tool_name='bash' ORDER BY created_at ASC`).all(created.runId) as unknown as Array<{ result_json: string | null; state: string; error_code: string | null }>;
  assert.equal(bashRows.length, 2, '应有两次bash调用');
  const firstBashStored = JSON.parse(bashRows[0]!.result_json ?? '{}') as { preview?: string; stdout?: string; exitCode?: number };
  // result_json存的是脱敏预览形态（summarizeResult）：bash实际payload在preview字符串内
  const firstBash = (typeof firstBashStored.preview === 'string' ? JSON.parse(firstBashStored.preview) : firstBashStored) as { stdout?: string; exitCode?: number };
  assert.equal(bashRows[0]!.state, 'succeeded');
  assert.equal(firstBash.exitCode, 0, `相对路径hash命令应成功：${JSON.stringify(firstBash).slice(0, 300)}`);
  assert.ok((firstBash.stdout ?? '').includes(H2), `实测输入hash应等于最新修改（期望${H2.slice(0, 12)}…）：${firstBash.stdout ?? ''}`);

  // 外部并发修改→过期expectedHash写入被拒（冲突），原项目保留外部内容
  const conflictRow = h.db.db.prepare(`SELECT state, error_code, redacted_args_json FROM tool_invocations WHERE run_id=? AND tool_name='write_file' ORDER BY created_at ASC`).all(created.runId) as unknown as Array<{ state: string; error_code: string | null; redacted_args_json: string }>;
  assert.equal(conflictRow.length, 2);
  assert.equal(conflictRow[0]!.state, 'succeeded', '第一次broker写入应成功');
  assert.equal(conflictRow[1]!.state, 'failed');
  assert.equal(conflictRow[1]!.error_code, 'CURRENT_CONTENT_CHANGED', '外部并发修改应返回冲突');
  assert.ok(conflictRow[1]!.redacted_args_json.includes('README.md'), '冲突提案应保留登记（args可核对）');
  assert.equal(readFileSync(join(h.projectDir, 'README.md'), 'utf8'), 'external-v3', '原项目应保留外部并发修改内容');

  // bash#2直接修改真实项目，不再存在副本发布步骤
  const secondBashStored = JSON.parse(bashRows[1]!.result_json ?? '{}') as { preview?: string; exitCode?: number; stderr?: string };
  const secondBash = (typeof secondBashStored.preview === 'string' ? JSON.parse(secondBashStored.preview) : secondBashStored) as { exitCode?: number; stderr?: string };
  assert.equal(secondBash.exitCode, 0, 'shell应直接写入真实目录');
  assert.equal(readFileSync(join(h.projectDir, 'evil.txt'), 'utf8'), 'x');
});


test('长会话继续时保留最近历史，遗漏旧历史须提示；未消费的旧输入仍进入请求', async t => {
  const state: UpstreamState = { mode: 'history', requests: [] };
  const h = await buildHarness(t, await httpsFixture(t, state));
  const first = h.supervisor.createOrdinaryRun({ userId: h.userId, sessionId: h.sessionId, projectId: h.projectId, conversationId: null,
    objective: 'PERSISTED_MEMORY_WORD', modelConfigId: h.modelConfigId, modelId: 'test-model' });
  assert.equal(await waitForStatus(h.db, first.runId, ['succeeded', 'failed'], 40_000), 'succeeded');
  const now = new Date().toISOString();
  let seq = (h.db.db.prepare('SELECT last_message_seq FROM conversations WHERE id=?').get(first.conversationId) as { last_message_seq: number }).last_message_seq;
  for (let i = 0; i < 210; i++) {
    const text = i === 0 ? 'OLD_PENDING_INPUT_9F' : `LONG_ARCHIVE_${String(i).padStart(3, '0')}`;
    h.db.db.prepare(`INSERT INTO messages(id,conversation_id,run_id,author_type,role_id,seq,visibility,state,content_json,consumed_cursor_json,created_at,updated_at)
      VALUES (?,?,?,'user','ordinary',?,'public','published',?,?,?,?)`)
      .run(randomUUID(), first.conversationId, first.runId, ++seq, JSON.stringify({text}), i === 0 ? null : '{}', now, now);
  }
  h.db.db.prepare('UPDATE conversations SET last_message_seq=? WHERE id=?').run(seq, first.conversationId);
  const grant = h.db.db.prepare('SELECT * FROM workspace_grants WHERE project_id=?').get(h.projectId) as unknown as GrantRow;
  const recovered = buildContextManifest(h.db, {runId:first.runId, conversationId:first.conversationId, grant, checkpointFrom:'run'});
  assert.ok(recovered.historyMessages.some(m => m.role === 'user' && m.text === 'PERSISTED_MEMORY_WORD'), '长任务恢复必须保留原目标');
  assert.equal(recovered.restoredInputThroughSeq, seq, '恢复游标必须对应实际恢复的用户输入');
  assert.equal(recovered.historyTruncated, true);

  const second = h.supervisor.createOrdinaryRun({ userId: h.userId, sessionId: h.sessionId, projectId: h.projectId, conversationId: first.conversationId,
    objective: '继续最新的工作。', modelConfigId: h.modelConfigId, modelId: 'test-model' });
  assert.equal(await waitForStatus(h.db, second.runId, ['succeeded', 'failed'], 40_000), 'succeeded');
  const body = state.requests.at(-1)!;
  assert.ok(body.includes('LONG_ARCHIVE_209'), '超过200条后必须保留最近消息');
  assert.ok(!body.includes('LONG_ARCHIVE_001'), '旧的已消费消息应退出窗口');
  assert.ok(body.includes('OLD_PENDING_INPUT_9F'), '不能消费被历史窗口遗漏的用户输入');
  assert.ok(body.includes('较早历史已省略'), '历史截断须在模型上下文明确提示');
});

test('恢复后重复读取同一路径应读到外部更新，不能回放旧读取结果', async t => {
  const state: UpstreamState = { mode: 'f04read', requests: [] };
  const h = await buildHarness(t, await httpsFixture(t, state));
  writeFileSync(join(h.projectDir, 'hello.txt'), 'READ_BEFORE_RECOVERY');
  let release!: () => void;
  state.hold = new Promise<void>(r => { release = r; });
  t.after(() => release());
  const first = h.supervisor.createOrdinaryRun({ userId: h.userId, sessionId: h.sessionId, projectId: h.projectId, conversationId: null,
    objective: '读取hello.txt并报告最新内容。', modelConfigId: h.modelConfigId, modelId: 'test-model' });
  for (let i = 0; i < 100 && state.requests.length < 2; i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(state.requests[1]?.includes('READ_BEFORE_RECOVERY'));
  h.vault.clear(h.sessionId);
  h.supervisor.onCredentialChanged({ sessionId: h.sessionId });
  assert.equal(await waitForStatus(h.db, first.runId, ['waiting_input'], 20_000), 'waiting_input');
  release();
  writeFileSync(join(h.projectDir, 'hello.txt'), 'READ_AFTER_RECOVERY');
  h.vault.set(h.sessionId, h.modelConfigId, 'sk-test', new Date(Date.now() + 3600_000).toISOString());
  const row = h.db.db.prepare('SELECT stop_reason,updated_at FROM runs WHERE id=?').get(first.runId) as {stop_reason:string;updated_at:string};
  const version = waitStateVersion(row);
  await h.supervisor.resumeWaitingRun(first.runId, h.userId, h.sessionId, version);
  assert.equal(await waitForStatus(h.db, first.runId, ['succeeded', 'failed'], 40_000), 'succeeded');
  assert.ok(state.requests[3]?.includes('READ_AFTER_RECOVERY'), '恢复后的只读工具必须重新读取当前数据');
  const replays = h.db.db.prepare(`SELECT COUNT(*) n FROM tool_invocations WHERE run_id=? AND tool_name='read_file' AND replayed_from_invocation_id IS NOT NULL`).get(first.runId) as {n:number};
  assert.equal(replays.n, 0, '只读工具不应受防止重复副作用的回放门禁影响');
});

// —— 思考强度任务级覆盖：建单覆盖合并进冻结快照；默认仍取设置档位；目录外档位 fail-closed ——

test('思考强度任务级覆盖：glm-5.3 覆盖high进快照/缺省用设置档位low/覆盖off被目录拒绝', async t => {
  const state: UpstreamState = { mode: 'history', requests: [] };
  const upstream = await httpsFixture(t, state);
  const h = await buildHarness(t, upstream);
  // 播种 glm-5.3 条目：设置默认档位 low（目录结论 [low,high,max]，无 off）
  h.db.db.prepare(`INSERT INTO model_entries(id,config_id,model_id,display_name,parameters_json,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,1,?,?)`).run(randomUUID(), h.modelConfigId, 'glm-5.3', 'GLM', '{"contextWindow":65536,"maxOutputTokens":1024,"thinkingLevel":"low"}', new Date().toISOString(), new Date().toISOString());
  const snapshotOf = (runId: string): { thinkingLevel?: string; reasoning?: string } => {
    const row = h.db.db.prepare('SELECT config_snapshot_json FROM runs WHERE id=?').get(runId) as { config_snapshot_json: string };
    return (JSON.parse(row.config_snapshot_json).parameters?.effective ?? {}) as { thinkingLevel?: string; reasoning?: string };
  };
  // 覆盖 high：快照冻结任务窗口选择
  const overridden = h.supervisor.createOrdinaryRun({
    userId: h.userId, sessionId: h.sessionId, projectId: h.projectId, conversationId: null,
    objective: '思考强度覆盖测试目标。', modelConfigId: h.modelConfigId, modelId: 'glm-5.3', thinkingLevel: 'high',
  });
  assert.equal(snapshotOf(overridden.runId).thinkingLevel, 'high');
  assert.equal(snapshotOf(overridden.runId).reasoning, 'high');
  // 缺省：设置档位 low 生效（目录支持 medium 才默认 medium，glm 无 medium → low）
  const defaulted = h.supervisor.createOrdinaryRun({
    userId: h.userId, sessionId: h.sessionId, projectId: h.projectId, conversationId: null,
    objective: '思考强度默认档位测试目标。', modelConfigId: h.modelConfigId, modelId: 'glm-5.3',
  });
  assert.equal(snapshotOf(defaulted.runId).thinkingLevel, 'low');
  // 覆盖 off：glm 目录声明无 off → fail-closed
  assert.throws(() => h.supervisor.createOrdinaryRun({
    userId: h.userId, sessionId: h.sessionId, projectId: h.projectId, conversationId: null,
    objective: '思考强度非法档位测试目标。', modelConfigId: h.modelConfigId, modelId: 'glm-5.3', thinkingLevel: 'off',
  }), /思考级别支持/);
  // 未收录别名 + 显式档位 → 仍拒绝（verified=false fail-closed 不回归）
  assert.throws(() => h.supervisor.createOrdinaryRun({
    userId: h.userId, sessionId: h.sessionId, projectId: h.projectId, conversationId: null,
    objective: '未知模型档位测试目标。', modelConfigId: h.modelConfigId, modelId: 'test-model', thinkingLevel: 'high',
  }), /思考级别支持/);
});

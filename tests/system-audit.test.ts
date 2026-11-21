import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildProductApp } from '../src/app.js';
import { clearLoginFailures } from '../src/auth/routes.js';
import { deleteArchivedConversation } from '../src/projects/archive.js';
import { parseRpcPayload } from '../src/agent/mcpHttpClient.js';
import { currentCsrfToken, setCsrfToken, v1 } from '../web/api.js';

async function fixture(t: { after(fn: () => unknown): unknown }) {
  const dir = mkdtempSync(join(tmpdir(), 'prism-audit-'));
  const fx = buildProductApp(dir, { serveWeb: false });
  t.after(async () => { await fx.app.close(); clearLoginFailures(); rmSync(dir, { recursive: true, force: true }); });
  const password = 'SyntheticAudit2026!';
  const registered = await fx.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username: 'audit-user', password, confirmation: password } });
  assert.equal(registered.statusCode, 201);
  const uid = registered.json().data.user.id as string;
  const headers = { cookie: String(registered.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': registered.json().data.csrfToken as string };
  return { ...fx, dir, uid, password, headers };
}

test('审计回归：成功、失败和直接健康响应共用同一个请求追踪编号', async t => {
  const f = await fixture(t);
  const responses = [await f.app.inject({ url: '/api/v1/health' }), await f.app.inject({ url: '/api/v1/projects', headers: f.headers }), await f.app.inject({ url: '/api/v1/projects' })];
  for (const response of responses) assert.equal(response.headers['x-request-id'], response.json().requestId);
  const id = randomUUID();
  const custom = await f.app.inject({ url: '/api/v1/health', headers: { 'x-request-id': id } });
  assert.equal(custom.json().requestId, id);
});

test('审计回归：并发错误登录至多放行五次校验，其余立即限流', async t => {
  const f = await fixture(t); clearLoginFailures();
  const responses = await Promise.all(Array.from({ length: 9 }, () => f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'audit-user', password: 'wrong-password' } })));
  assert.equal(responses.filter(r => r.statusCode === 401).length, 5);
  assert.equal(responses.filter(r => r.statusCode === 429).length, 4);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'audit-user', password: f.password } })).statusCode, 429);
});

async function history(f: Awaited<ReturnType<typeof fixture>>) {
  const project = (await f.app.inject({ method: 'POST', url: '/api/v1/projects', headers: f.headers, payload: { name: 'audit-project' } })).json().data.id as string;
  const config = (await f.app.inject({ method: 'POST', url: '/api/v1/model-configs', headers: f.headers, payload: { preset: 'custom', name: 'audit-config', baseUrl: 'https://example.com/v1', models: [{ modelId: 'synthetic', displayName: 'synthetic', enabled: true, parameters: {} }] } })).json().data.id as string;
  const seed = () => {
    const [conversation, problem, run, binding, phase, attempt, invocation] = Array.from({ length: 7 }, () => randomUUID()) as [string,string,string,string,string,string,string];
    const now = new Date().toISOString(), db = f.db.db;
    db.prepare("INSERT INTO conversations(id,project_id,mode,title,archived_at,created_at,updated_at) VALUES (?,?,'ordinary','audit',?,?,?)").run(conversation, project, now, now, now);
    db.prepare('INSERT INTO problem_versions(id,conversation_id,version,objective,created_at,updated_at) VALUES (?,?,1,?,?,?)').run(problem, conversation, 'audit', now, now);
    db.prepare("INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,config_snapshot_json,created_at,updated_at) VALUES (?,?,?,?,'ordinary','succeeded','{}',?,?)").run(run, project, conversation, problem, now, now);
    db.prepare("INSERT INTO agent_bindings(id,run_id,role_id,model_config_id,model_id,created_at,updated_at) VALUES (?,?,'ordinary',?,'synthetic',?,?)").run(binding, run, config, now, now);
    db.prepare("INSERT INTO phase_tasks(id,run_id,agent_binding_id,phase_key,status,created_at,updated_at) VALUES (?,?,?,'main','succeeded',?,?)").run(phase, run, binding, now, now);
    db.prepare("INSERT INTO attempts(id,phase_task_id,number,status,created_at,updated_at) VALUES (?,?,1,'succeeded',?,?)").run(attempt, phase, now, now);
    db.prepare("INSERT INTO tool_invocations(id,run_id,phase_task_id,attempt_id,call_key,tool_name,tool_version,args_hash,state,created_at,updated_at) VALUES (?,?,?,?,?,'ask_user','v1','hash','succeeded',?,?)").run(invocation, run, phase, attempt, invocation, now, now);
    db.prepare("INSERT INTO user_questions(id,run_id,invocation_id,questions_json,state,created_at) VALUES (?,?,?,'[]','answered',?)").run(randomUUID(), run, invocation, now);
    db.prepare("INSERT INTO memory_extractions(id,project_id,conversation_id,run_id,attempt_id,boundary_hash,state,created_at) VALUES (?,?,?,?,?,?,'completed',?)").run(randomUUID(), project, conversation, run, attempt, run, now);
    db.prepare('INSERT INTO memory_handoffs(project_id,source_path,source_hash,memory_path,memory_hash,run_id,saved_at) VALUES (?,?,?,?,?,?,?)').run(project, run, 'hash', 'handoff/a.md', 'hash', run, now);
    return { conversation, run };
  };
  return { seed, project };
}

test('审计回归：含用户问答和记忆回执的归档可删除，其他任务记录保留', async t => {
  const f = await fixture(t), h = await history(f), removed = h.seed(), kept = h.seed();
  deleteArchivedConversation(f.db, f.uid, removed.conversation);
  for (const table of ['user_questions', 'memory_extractions', 'memory_handoffs']) {
    assert.equal(f.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id=?`).get(removed.run)?.n, 0);
    assert.equal(f.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id=?`).get(kept.run)?.n, 1);
  }
  assert.equal(f.db.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('审计回归：运行中的记忆提炼阻止删除归档', async t => {
  const f = await fixture(t), h = await history(f), item = h.seed();
  f.db.db.prepare("UPDATE memory_extractions SET state='running' WHERE run_id=?").run(item.run);
  assert.throws(() => deleteArchivedConversation(f.db, f.uid, item.conversation), (error: unknown) => (error as { code?: string }).code === 'CONVERSATION_BUSY');
});

test('审计回归：旧会话的迟到响应不能覆盖新CSRF或清空新登录状态', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; setCsrfToken(null); });
  for (const status of [200, 401]) {
    const oldToken = 'a'.repeat(64), newToken = 'b'.repeat(64);
    setCsrfToken(oldToken);
    let finish!: (response: Response) => void;
    globalThis.fetch = () => new Promise<Response>(resolve => { finish = resolve; });
    const result = v1('/api/v1/auth/me').catch(() => null);
    setCsrfToken(newToken);
    finish(new Response(JSON.stringify(status === 200 ? { data: { csrfToken: oldToken } } : { error: { code: 'SESSION_EXPIRED', message: 'expired' } }), { status }));
    await result;
    assert.equal(currentCsrfToken(), newToken);
  }
});

test('审计回归：MCP JSON与SSE只接受匹配请求ID的RPC响应', () => {
  const json = (value: unknown) => Buffer.from(JSON.stringify(value));
  assert.throws(() => parseRpcPayload(200, 'application/json', json({ jsonrpc: '2.0', id: 8, result: 'wrong' }), '7'));
  assert.throws(() => parseRpcPayload(200, 'application/json', json(null), '7'));
  assert.throws(() => parseRpcPayload(200, 'text/event-stream', Buffer.from('data: {"jsonrpc":"2.0","result":"no-id"}\n\n'), '7'));
  const sse = 'data: {"jsonrpc":"2.0","result":"no-id"}\n\ndata: {"jsonrpc":"2.0","id":7,"result":"correct"}\n\n';
  assert.equal(parseRpcPayload(200, 'text/event-stream', Buffer.from(sse), '7').result, 'correct');
});

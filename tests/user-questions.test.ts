import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildProductApp } from '../src/app.js';
import { hashPassword } from '../src/auth/passwords.js';
import { clearLoginFailures } from '../src/auth/routes.js';
import { parseUserQuestions, parseQuestionAnswers, readUserQuestions, UserQuestionService, QUESTION_AUTO_CONTINUE_MS } from '../src/agent/userQuestions.js';
import { requiresApproval } from '../src/agent/approvalPolicy.js';
import { toolSpec } from '../src/agent/toolExec.js';
import { readConversationWindow } from '../src/agent/conversationProjection.js';

const question = { header: '范围', question: '要分析哪些市场？', multiSelect: true, options: [{ label: 'A股', description: '中国内地市场' }, { label: '美股', description: '美国市场', preview: '美国上市公司' }] };
const input = { questions: [question, { ...question, header: '报告', question: '报告使用什么语言？', multiSelect: false, options: [{ label: '中文', description: '中文报告' }, { label: '英文', description: '英文报告' }] }] };
async function fixture(t: { after(fn: () => unknown): unknown }) {
    const dir = mkdtempSync(join(tmpdir(), 'prism-question-')), fx = buildProductApp(dir, { serveWeb: false });
    const now = new Date().toISOString(), userId = randomUUID(), projectId = randomUUID(), runId = randomUUID(), conversationId = randomUUID(), pv = randomUUID(), configId = randomUUID(), bindingId = randomUUID(), phaseId = randomUUID(), attemptId = randomUUID();
    const pw = await hashPassword('correct-horse-battery');
    fx.db.db.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)').run(userId, 'questions', pw.hash, pw.salt, pw.paramsJson, now, now);
    fx.db.db.prepare('INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(projectId, userId, '提问测试', now, now);
    fx.db.db.prepare("INSERT INTO conversations(id,project_id,mode,title,created_at,updated_at) VALUES (?,?,'ordinary','提问',?,?)").run(conversationId, projectId, now, now);
    fx.db.db.prepare('INSERT INTO problem_versions(id,conversation_id,version,objective,created_at,updated_at) VALUES (?,?,1,?,?,?)').run(pv, conversationId, '澄清范围', now, now);
    fx.db.db.prepare("INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,config_snapshot_json,created_at,updated_at) VALUES (?,?,?,?,'ordinary','running','{}',?,?)").run(runId, projectId, conversationId, pv, now, now);
    fx.db.db.prepare("INSERT INTO model_configs(id,owner_user_id,preset,name,base_url,created_at,updated_at) VALUES (?,?,'custom','fixture','https://example.com',?,?)").run(configId, userId, now, now);
    fx.db.db.prepare("INSERT INTO agent_bindings(id,run_id,role_id,model_config_id,model_id,created_at,updated_at) VALUES (?,?,'ordinary',?,'fixture',?,?)").run(bindingId, runId, configId, now, now);
    fx.db.db.prepare("INSERT INTO phase_tasks(id,run_id,agent_binding_id,phase_key,status,created_at,updated_at) VALUES (?,?,?,'ordinary','running',?,?)").run(phaseId, runId, bindingId, now, now);
    fx.db.db.prepare("INSERT INTO attempts(id,phase_task_id,number,status,created_at,updated_at) VALUES (?,?,1,'running',?,?)").run(attemptId, phaseId, now, now);
    function invocation() {
        const id = randomUUID();
        fx.db.db.prepare("INSERT INTO tool_invocations(id,run_id,phase_task_id,attempt_id,call_key,tool_name,tool_version,args_hash,state,effect_kind,created_at,updated_at) VALUES (?,?,?,?,?,'AskUserQuestion','v1','fixture','claimed','read',?,?)").run(id, runId, phaseId, attemptId, id, now, now);
        return id;
    }
    const login = await fx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'questions', password: 'correct-horse-battery' } });
    assert.equal(login.statusCode, 200);
    const raw = login.headers['set-cookie'], cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!;
    const headers = { cookie, 'x-csrf-token': login.json().data.csrfToken as string };
    t.after(async () => { await fx.app.close(); clearLoginFailures(); rmSync(dir, { recursive: true, force: true }); });
    return { ...fx, userId, runId, headers, invocation };
}

test('提问契约：多题/单题、唯一选项、自定义回答和伪造用户答案校验', () => {
    assert.equal(parseUserQuestions(input).length, 2);
    assert.equal(parseUserQuestions(question)[0]!.multiSelect, true);
    assert.throws(() => parseUserQuestions({ ...input, answers: { [question.question]: '伪造' } }));
    assert.throws(() => parseUserQuestions({ questions: [{ ...question, options: [question.options[0], question.options[0]] }] }));
    assert.throws(() => parseUserQuestions({ questions: [{ ...question, options: [{ label: 'Other', description: '其他' }, question.options[0]] }] }));
    assert.throws(() => parseUserQuestions({ questions: Array(5).fill(question) }));
    const parsed = parseUserQuestions(input);
    assert.deepEqual({ ...parseQuestionAnswers(parsed, { [question.question]: ['A股', '港股（自定义）'] }) }, { [question.question]: ['A股', '港股（自定义）'] });
    assert.throws(() => parseQuestionAnswers(parsed, { '报告使用什么语言？': ['中文', '英文'] }));
    assert.throws(() => parseQuestionAnswers(parsed, { unknown: ['A股'] }));
    assert.throws(() => parseQuestionAnswers(parsed, { [question.question]: [' '] }));
    assert.equal(requiresApproval('full', toolSpec('AskUserQuestion')!, input), false);
});

test('提问API：登录/属主/CSRF、真实回答、重复/迟到拒绝与持久历史', async t => {
    const f = await fixture(t), service = f.supervisor.userQuestions;
    const pending = service.ask(f.runId, f.invocation(), input, f.userId);
    const q = readUserQuestions(f.db, f.runId)[0]!;
    const base = `/api/v1/runs/${f.runId}/questions`;
    assert.equal((await f.app.inject({ method: 'GET', url: base })).statusCode, 401);
    assert.throws(() => service.respond(f.runId, q.id, randomUUID(), { action: 'skip' }), /无权/);
    assert.equal((await f.app.inject({ method: 'POST', url: `${base}/${q.id}/answer`, headers: { cookie: f.headers.cookie }, payload: { action: 'skip' } })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'GET', url: base, headers: f.headers })).json().data.questions[0].state, 'pending');
    assert.equal((await f.app.inject({ method: 'POST', url: `${base}/${q.id}/answer`, headers: f.headers, payload: { action: 'answer', answers: { [question.question]: ['A股', '港股'] } } })).statusCode, 200);
    const result = await pending as { answers: Record<string, string> };
    assert.equal(result.answers[question.question], 'A股, 港股');
    assert.equal((await f.app.inject({ method: 'POST', url: `${base}/${q.id}/answer`, headers: f.headers, payload: { action: 'skip' } })).statusCode, 409);
    const restored = readConversationWindow(f.db, f.runId, f.userId).runs[0]!.userQuestions![0]!;
    assert.equal(restored.state, 'answered'); assert.deepEqual(restored.answers[question.question], ['A股','港股']);
    assert.equal(f.db.db.prepare('SELECT id FROM approvals LIMIT 1').get(), undefined);
});

test('五分钟自动继续：空答案、首次操作永久暂停、到期与回答只生效一次', async t => {
    const f = await fixture(t); let clock = Date.now();
    const service = new UserQuestionService(f.db, () => {}, () => clock);
    const pending = service.ask(f.runId, f.invocation(), input, f.userId);
    const q = readUserQuestions(f.db, f.runId)[0]!;
    assert.equal(Date.parse(q.deadlineAt!) - Date.parse(q.createdAt), QUESTION_AUTO_CONTINUE_MS);
    clock += QUESTION_AUTO_CONTINUE_MS;
    service.expireDue(); service.expireDue();
    assert.deepEqual((await pending as { answers: unknown }).answers, {});
    assert.equal(readUserQuestions(f.db, f.runId)[0]!.state, 'auto_continued');
    assert.throws(() => service.respond(f.runId, q.id, f.userId, { action: 'skip' }), /已结束/);
    const paused = service.ask(f.runId, f.invocation(), input, f.userId), q2 = readUserQuestions(f.db, f.runId).find(x => x.state === 'pending')!;
    assert.equal(service.snooze(f.runId, q2.id, f.userId).paused, true);
    service.snooze(f.runId, q2.id, f.userId); clock += 2 * QUESTION_AUTO_CONTINUE_MS; service.expireDue();
    assert.equal(readUserQuestions(f.db, f.runId).find(x => x.id === q2.id)!.state, 'pending');
    service.respond(f.runId, q2.id, f.userId, { action: 'answer', answers: {} });
    assert.deepEqual((await paused as { answers: unknown }).answers, {});
});

test('设置开关：关闭立即暂停当前提问，重新开启不重启已有倒计时', async t => {
    const f = await fixture(t), service = f.supervisor.userQuestions;
    const pending = service.ask(f.runId, f.invocation(), input, f.userId), id = readUserQuestions(f.db, f.runId)[0]!.id;
    const change = (enabled: boolean) => f.app.inject({ method:'PUT',url:'/api/v1/agent-settings',headers:f.headers,payload:{autoCompaction:true,keepRecentTurns:3,askUserQuestionAutoResolutionEnabled:enabled} });
    assert.equal((await change(false)).statusCode, 200);
    assert.equal(readUserQuestions(f.db,f.runId)[0]!.deadlineAt,null);
    assert.equal((await change(true)).statusCode,200);
    assert.equal(readUserQuestions(f.db,f.runId)[0]!.deadlineAt,null);
    service.respond(f.runId,id,f.userId,{action:'skip'}); await pending;
    await change(false);
    const next = service.ask(f.runId,f.invocation(),input,f.userId);
    const q = readUserQuestions(f.db,f.runId).find(q=>q.state==='pending')!;
    assert.equal(q.deadlineAt,null); await change(true); assert.equal(readUserQuestions(f.db,f.runId).find(x=>x.id===q.id)!.deadlineAt,null);
    service.respond(f.runId,q.id,f.userId,{action:'skip'}); await next;
});

test('取消/进程恢复：问题关闭且拒绝迟到回答，不恢复已丢失的等待载体', async t => {
    const f = await fixture(t), service = f.supervisor.userQuestions;
    const pending = service.ask(f.runId,f.invocation(),input,f.userId), id = readUserQuestions(f.db,f.runId)[0]!.id;
    const rejected = assert.rejects(pending,/已结束/); service.cancelRun(f.runId,'USER_CANCELLED'); await rejected;
    assert.equal(readUserQuestions(f.db,f.runId)[0]!.state,'cancelled');
    assert.throws(()=>service.respond(f.runId,id,f.userId,{action:'skip'}),/已结束/);
    const inv = f.invocation();
    f.db.db.prepare("INSERT INTO user_questions(id,run_id,invocation_id,questions_json,state,created_at,deadline_at) VALUES (?,?,?,?,'pending',?,?)").run(randomUUID(),f.runId,inv,JSON.stringify(parseUserQuestions(input)),new Date().toISOString(),new Date(Date.now()+1000).toISOString());
    f.supervisor.recoverAtStartup();
    assert.equal(readUserQuestions(f.db,f.runId).filter(q=>q.state==='pending').length,0);
    assert.equal((f.db.db.prepare('SELECT status FROM runs WHERE id=?').get(f.runId) as {status:string}).status,'failed');
});

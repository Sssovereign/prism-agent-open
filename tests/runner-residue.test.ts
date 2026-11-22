import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildProductApp } from '../src/app.js';
import { hashPassword } from '../src/auth/passwords.js';
import { clearLoginFailures } from '../src/auth/routes.js';

// 进程残留收口（在制）：①recoverAtStartup按pid+ps启动时间戳身份核对后击杀上一世遗留runner；
// ②runner被SIGKILL升格时按登记文件清扫其bash命令进程组（身份核对防PID复用误杀）。

const POSIX = process.platform !== 'win32';

function psStamp(pid: number): string {
    if (!POSIX) return '';
    const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 });
    return result.status === 0 ? String(result.stdout ?? '').trim() : '';
}

function spawnSentinel(): ChildProcess {
    // 常驻哨兵：模拟遗留runner/命令组（无SIGTERM处理器，默认信号即死）
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000);'], { stdio: 'ignore', detached: true });
    child.unref();
    return child;
}

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise(r => setTimeout(r, 100));
    }
    return predicate();
}

async function fixture(t: { after(fn: () => unknown): unknown }) {
    const dir = mkdtempSync(join(tmpdir(), 'prism-residue-')), fx = buildProductApp(dir, { serveWeb: false });
    const now = new Date().toISOString(), userId = randomUUID(), projectId = randomUUID(), configId = randomUUID();
    const pw = await hashPassword('correct-horse-battery');
    fx.db.db.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)').run(userId, 'residue', pw.hash, pw.salt, pw.paramsJson, now, now);
    fx.db.db.prepare('INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(projectId, userId, '残留收口', now, now);
    fx.db.db.prepare("INSERT INTO model_configs(id,owner_user_id,preset,name,base_url,created_at,updated_at) VALUES (?,?,'custom','fixture','https://example.com',?,?)").run(configId, userId, now, now);
    t.after(async () => { await fx.app.close(); clearLoginFailures(); rmSync(dir, { recursive: true, force: true }); });
    const addRun = (status = 'running') => {
        // 同会话至多一个非终态run（idx_runs_active）：每个run独立会话与问题版本
        const runId = randomUUID(), phaseId = randomUUID(), attemptId = randomUUID(), binding = randomUUID(), conversationId = randomUUID(), pv = randomUUID();
        fx.db.db.prepare("INSERT INTO conversations(id,project_id,mode,title,created_at,updated_at) VALUES (?,?,'ordinary','残留',?,?)").run(conversationId, projectId, now, now);
        fx.db.db.prepare('INSERT INTO problem_versions(id,conversation_id,version,objective,created_at,updated_at) VALUES (?,?,1,?,?,?)').run(pv, conversationId, '残留收口', now, now);
        fx.db.db.prepare("INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,config_snapshot_json,created_at,updated_at) VALUES (?,?,?,?,'ordinary',?,'{}',?,?)").run(runId, projectId, conversationId, pv, status, now, now);
        fx.db.db.prepare("INSERT INTO agent_bindings(id,run_id,role_id,model_config_id,model_id,created_at,updated_at) VALUES (?,?,'ordinary',?,'fixture',?,?)").run(binding, runId, configId, now, now);
        fx.db.db.prepare("INSERT INTO phase_tasks(id,run_id,agent_binding_id,phase_key,status,created_at,updated_at) VALUES (?,?,?,'ordinary','running',?,?)").run(phaseId, runId, binding, now, now);
        fx.db.db.prepare("INSERT INTO attempts(id,phase_task_id,number,status,created_at,updated_at) VALUES (?,?,1,'running',?,?)").run(attemptId, phaseId, now, now);
        return { runId, phaseId, attemptId };
    };
    const addWorker = (attemptId: string, pid: number, stamp: string, state = 'running') => {
        const id = randomUUID();
        fx.db.db.prepare(`INSERT INTO worker_instances(id,attempt_id,host_id,pid,process_start_stamp,instance_nonce,state,heartbeat_at,created_at,updated_at)
            VALUES (?,?,'local',?,?,'nonce-residue',?,NULL,?,?)`).run(id, attemptId, pid, stamp, state, now, now);
        return id;
    };
    const groupsFileOf = (attemptId: string) => join(dir, 'runtime', attemptId, 'session', 'runner-groups.json');
    return { ...fx, dir, addRun, addWorker, groupsFileOf };
}

const auditEvents = (f: Awaited<ReturnType<typeof fixture>>, runId: string, type: string) =>
    f.db.db.prepare(`SELECT payload_json FROM run_events WHERE run_id=? AND type=? AND visibility='audit' ORDER BY seq DESC`).all(runId, type) as Array<{ payload_json: string }>;

test('启动对账：上一世遗留runner按身份戳击杀，戳不符仅标记不误杀', async t => {
    if (!POSIX) t.skip('身份戳依赖/bin/ps，Windows以nonce与自败机制兜底');
    const f = await fixture(t);
    const stale = spawnSentinel(), stranger = spawnSentinel();
    t.after(() => { for (const p of [stale, stranger]) { try { process.kill(-p.pid!, 'SIGKILL'); } catch { try { process.kill(p.pid!, 'SIGKILL'); } catch {} } } });
    const a = f.addRun(), b = f.addRun();
    f.addWorker(a.attemptId, stale.pid!, psStamp(stale.pid!));
    f.addWorker(b.attemptId, stranger.pid!, 'bogus-stamp');
    f.supervisor.recoverAtStartup();
    assert.equal(await waitFor(() => !alive(stale.pid!)), true, '身份相符的遗留runner应被击杀');
    assert.equal(alive(stranger.pid!), true, '戳不符的进程不得被误杀');
    for (const run of [a, b]) {
        assert.equal((f.db.db.prepare('SELECT status FROM runs WHERE id=?').get(run.runId) as { status: string }).status, 'failed');
        assert.equal((f.db.db.prepare(`SELECT state FROM worker_instances WHERE attempt_id=?`).get(run.attemptId) as { state: string }).state, 'lost');
        assert.equal((f.db.db.prepare(`SELECT error_code FROM attempts WHERE id=?`).get(run.attemptId) as { error_code: string }).error_code, 'INTERRUPTED_RESTART');
    }
    assert.equal(auditEvents(f, a.runId, 'runner.stale_kill').length, 1);
    assert.equal(auditEvents(f, b.runId, 'runner.stale_leftover').length, 1);
});

test('SIGKILL升格清扫：登记文件中身份相符的命令组被整组击杀，戳不符跳过', async t => {
    if (!POSIX) t.skip('身份戳依赖/bin/ps，Windows以taskkill /T与自败机制兜底');
    const f = await fixture(t);
    const tracked = spawnSentinel(), stranger = spawnSentinel();
    t.after(() => { for (const p of [tracked, stranger]) { try { process.kill(-p.pid!, 'SIGKILL'); } catch { try { process.kill(p.pid!, 'SIGKILL'); } catch {} } } });
    const run = f.addRun('cancelling');
    mkdirSync(join(f.dir, 'runtime', run.attemptId, 'session'), { recursive: true });
    writeFileSync(f.groupsFileOf(run.attemptId), JSON.stringify([{ pid: tracked.pid, stamp: psStamp(tracked.pid!) }, { pid: stranger.pid, stamp: 'bogus-stamp' }]));
    (f.supervisor as unknown as { sweepRunnerGroups: (a: string, r: string, reason: string) => void }).sweepRunnerGroups(run.attemptId, run.runId, 'test_escalation');
    assert.equal(await waitFor(() => !alive(tracked.pid!)), true, '登记且身份相符的命令组应被清扫');
    assert.equal(alive(stranger.pid!), true, '戳不符的组不得被误杀');
    const events = auditEvents(f, run.runId, 'runner.groups_swept');
    assert.equal(events.length, 1);
    const payload = JSON.parse(events[0]!.payload_json) as { killed: number[]; skipped: number; reason: string };
    assert.deepEqual(payload.killed, [tracked.pid]); assert.equal(payload.skipped, 1); assert.equal(payload.reason, 'test_escalation');
});

test('清扫对缺失/空登记文件为无操作，不产生事件', async t => {
    const f = await fixture(t);
    const run = f.addRun('cancelling');
    (f.supervisor as unknown as { sweepRunnerGroups: (a: string, r: string, reason: string) => void }).sweepRunnerGroups(run.attemptId, run.runId, 'no_file');
    assert.equal(auditEvents(f, run.runId, 'runner.groups_swept').length, 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildProductApp } from '../src/app.js';
import { toolSpec } from '../src/agent/toolExec.js';
import { requiresApproval } from '../src/agent/approvalPolicy.js';
import { replaceRunTodos, getRunTodos } from '../src/agent/runTodos.js';
import { hashPassword } from '../src/auth/passwords.js';
import { clearLoginFailures } from '../src/auth/routes.js';
import { Db } from '../src/storage/db.js';
import { migrate, defaultMigrationsDir } from '../src/storage/migrate.js';

/** 块D（子代理＋Todo）：run 级任务清单读写与上限、todo_write/agent 只读审批分类、todos 路由。 */

test('runTodos: 全量覆写语义，状态白名单与上限校验失败时保留原清单', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-todos-'));
    const db = new Db(join(dir, 'db.sqlite'));
    try {
        migrate(db, defaultMigrationsDir());
        const runId = randomUUID();
        const first = replaceRunTodos(db, runId, [
            { content: '调研', status: 'completed' },
            { content: '实现', status: 'in_progress' },
            { content: '验收', status: 'pending' },
        ]);
        assert.equal(first.length, 3);
        assert.deepEqual(first.map(t => t.position), [0, 1, 2]);
        // 覆写：第二次写入清空旧行，仅保留新清单
        const second = replaceRunTodos(db, runId, [{ content: '新的唯一任务', status: 'pending' }]);
        assert.equal(second.length, 1);
        assert.equal((db.db.prepare('SELECT COUNT(*) n FROM run_todos WHERE run_id=?').get(runId) as { n: number }).n, 1);
        const fetched = getRunTodos(db, runId);
        assert.equal(fetched.length, 1);
        assert.equal(fetched[0]!.content, '新的唯一任务');
        assert.deepEqual(fetched.map(t => t.position), [0]);
        // 状态白名单：非法状态整批拒绝且事务回滚（原清单保留）
        assert.throws(() => replaceRunTodos(db, runId, [{ content: 'x', status: 'done' } as never]), /状态不合法/);
        assert.equal(getRunTodos(db, runId)[0]!.content, '新的唯一任务');
        // 空内容拒绝
        assert.throws(() => replaceRunTodos(db, runId, [{ content: '  ', status: 'pending' }]), /缺少内容/);
        // 内容超长拒绝（≤500）
        assert.throws(() => replaceRunTodos(db, runId, [{ content: '长'.repeat(501), status: 'pending' }]), /超长/);
        // 501 项拒绝（≤50）
        assert.throws(() => replaceRunTodos(db, runId, Array.from({ length: 51 }, () => ({ content: 'x', status: 'pending' }))), /最多 50 项/);
        // 边界：恰好 50 项可行
        const max = replaceRunTodos(db, runId, Array.from({ length: 50 }, (_, i) => ({ content: `t${i}`, status: 'pending' })));
        assert.equal(max.length, 50);
        // status 缺省回退 pending
        const defaulted = replaceRunTodos(db, runId, [{ content: '默认态' } as never]);
        assert.equal(defaulted[0]!.status, 'pending');
    } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('审批分类：todo_write 与 agent 为只读类，任何审批模式都不逐次询问', () => {
    for (const name of ['todo_write', 'agent']) {
        const spec = toolSpec(name);
        assert.ok(spec, `应注册 ${name} 工具规格`);
        assert.equal(spec!.effect, 'read', `${name} 应为只读类（不审批、不参与 F04 重放）`);
        for (const mode of ['ask', 'auto', 'full'] as const) {
            assert.equal(requiresApproval(mode, spec!, name === 'todo_write' ? { todos: [{ content: 'a', status: 'pending' }] } : { prompt: '研究' }), false, `${name} 在 ${mode} 下不应询问`);
        }
    }
    // 对照组：delete_file 在 auto 模式下仍会询问（审批语义未被误伤）
    const del = toolSpec('delete_file');
    assert.ok(del);
    assert.equal(requiresApproval('auto', del!, { path: 'x.txt' }), true);
});

test('todos 路由：401 未登录 / 200 属主读取 / 404 他人 run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-todos-routes-'));
    const fx = buildProductApp(dir, { serveWeb: false });
    try {
        const anon = await fx.app.inject({ method: 'GET', url: `/api/v1/runs/${randomUUID()}/todos` });
        assert.equal(anon.statusCode, 401);
        const record = await hashPassword('correct-horse-battery');
        const now = new Date().toISOString();
        const mkUser = (username: string): string => {
            const uid = randomUUID();
            fx.db.tx(tx => tx.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)')
                .run(uid, username, record.hash, record.salt, record.paramsJson, now, now));
            return uid;
        };
        mkUser('todo-a');
        const bId = mkUser('todo-b');
        const login = async (username: string): Promise<{ cookie: string; headers: { cookie: string; 'x-csrf-token': string } }> => {
            const res = await fx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: 'correct-horse-battery' } });
            assert.equal(res.statusCode, 200);
            const raw = res.headers['set-cookie'];
            const cookie = (Array.isArray(raw) ? String(raw[0]) : String(raw)).split(';')[0]!;
            return { cookie, headers: { cookie, 'x-csrf-token': (res.json() as { data: { csrfToken: string } }).data.csrfToken } };
        };
        const a = await login('todo-a');
        const project = (await fx.app.inject({ method: 'POST', url: '/api/v1/projects', headers: a.headers, payload: { name: '清单项目' } })).json().data as { id: string };
        // 造 run：项目 → 会话 → problem_version → run
        const convId = randomUUID(), pv = randomUUID(), runId = randomUUID();
        fx.db.tx(tx => {
            tx.prepare("INSERT INTO conversations(id,project_id,mode,title,created_at,updated_at) VALUES (?,?,'ordinary','清单任务',?,?)").run(convId, project.id, now, now);
            tx.prepare('INSERT INTO problem_versions(id,conversation_id,version,objective,created_at,updated_at) VALUES (?,?,1,?,?,?)').run(pv, convId, '目标', now, now);
            tx.prepare("INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,config_snapshot_json,created_at,updated_at) VALUES (?,?,?,?,'ordinary','running','{}',?,?)").run(runId, project.id, convId, pv, now, now);
        });
        replaceRunTodos(fx.db, runId, [
            { content: '第一步：定位', status: 'completed' },
            { content: '第二步：复现', status: 'in_progress' },
            { content: '第三步：修复', status: 'pending' },
        ]);
        const list = await fx.app.inject({ method: 'GET', url: `/api/v1/runs/${runId}/todos`, headers: { cookie: a.cookie } });
        assert.equal(list.statusCode, 200);
        const todos = (list.json() as { data: { todos: Array<{ content: string; status: string; position: number }> } }).data.todos;
        assert.deepEqual(todos.map(t => t.content), ['第一步：定位', '第二步：复现', '第三步：修复']);
        assert.deepEqual(todos.map(t => t.status), ['completed', 'in_progress', 'pending']);
        // 他人 run：404 不泄露存在性
        const b = await login('todo-b');
        const stolen = await fx.app.inject({ method: 'GET', url: `/api/v1/runs/${runId}/todos`, headers: { cookie: b.cookie } });
        assert.equal(stolen.statusCode, 404);
        assert.equal(bId !== '', true);
        void bId;
    } finally {
        await fx.app.close();
        clearLoginFailures();
        rmSync(dir, { recursive: true, force: true });
    }
});

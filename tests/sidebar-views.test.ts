import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildProductApp } from '../src/app.js';
import { hashPassword } from '../src/auth/passwords.js';
import { clearLoginFailures } from '../src/auth/routes.js';

test('侧栏视图数据链：项目、更新排序、分组增改移除、未读标记持久化及属主隔离', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-sidebar-views-'));
    const fx = buildProductApp(dir, { serveWeb: false });
    try {
        const password = 'Synthetic-sidebar-check', pw = await hashPassword(password), now = new Date().toISOString();
        const uid = randomUUID(), stranger = randomUUID();
        for (const [id, name] of [[uid, 'views-check'], [stranger, 'views-other']]) fx.db.db.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)').run(id!, name!, pw.hash, pw.salt, pw.paramsJson, now, now);
        const login = await fx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'views-check', password } });
        const cookie = String(login.headers['set-cookie']).split(';')[0]!;
        const headers = { cookie, 'x-csrf-token': login.json().data.csrfToken as string };
        const project = (await fx.app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: '视图项目' } })).json().data.id as string;
        const seed = (title: string, updated: string, mode: 'ordinary'|'debate'|'jury' = 'ordinary') => {
            const c = randomUUID(), pv = randomUUID(), r = randomUUID();
            fx.db.tx(tx => {
                tx.prepare('INSERT INTO conversations(id,project_id,mode,title,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(c, project, mode, title, now, updated);
                tx.prepare('INSERT INTO problem_versions(id,conversation_id,version,objective,created_at,updated_at) VALUES (?,?,1,?,?,?)').run(pv, c, title, now, now);
                tx.prepare("INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,config_snapshot_json,created_at,updated_at) VALUES (?,?,?,?,'ordinary','succeeded','{}',?,?)").run(r, project, c, pv, now, now);
            });
            return c;
        };
        const older = seed('较早任务', '2026-01-01T00:00:00.000Z'), latest = seed('最新任务', now);
        const read = async () => (await fx.app.inject({ url: '/api/v1/sidebar', headers })).json().data;
        assert.deepEqual((await read()).tasks.map((t: { id: string }) => t.id), [latest, older]);
        const created = await fx.app.inject({ method: 'POST', url: '/api/v1/sidebar-groups', headers, payload: { name: '研究' } });
        assert.equal(created.statusCode, 201);
        const group = created.json().data.id as string;
        assert.equal((await fx.app.inject({ method: 'PATCH', url: `/api/v1/conversations/${latest}`, headers, payload: { groupId: group, unread: true, pinned: true } })).statusCode, 200);
        let tree = await read(), task = tree.tasks.find((t: { id: string }) => t.id === latest);
        assert.equal(task.groupId, group); assert.ok(task.unreadAt); assert.ok(task.pinnedAt);
        assert.equal((await fx.app.inject({ method: 'PATCH', url: `/api/v1/sidebar-groups/${group}`, headers, payload: { name: '已改名分组' } })).statusCode, 200);
        assert.equal((await read()).groups[0].name, '已改名分组');
        const other = await fx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'views-other', password } });
        const otherHeaders = { cookie: String(other.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': other.json().data.csrfToken as string };
        assert.equal((await fx.app.inject({ method: 'PATCH', url: `/api/v1/conversations/${latest}`, headers: otherHeaders, payload: { unread: false } })).statusCode, 404);
        assert.equal((await fx.app.inject({ method: 'DELETE', url: `/api/v1/sidebar-groups/${group}`, headers: otherHeaders })).statusCode, 404);
        assert.equal((await fx.app.inject({ method: 'PATCH', url: `/api/v1/conversations/${latest}`, headers, payload: { unread: false } })).statusCode, 200);
        assert.equal((await fx.app.inject({ method: 'DELETE', url: `/api/v1/sidebar-groups/${group}`, headers })).statusCode, 200);
        tree = await read(); task = tree.tasks.find((t: { id: string }) => t.id === latest);
        assert.equal(task.unreadAt, null); assert.equal(task.groupId, null); assert.equal(tree.tasks.length, 2);
        assert.equal(task.mode, 'ordinary');
        // The sidebar reports the conversation mode, independently of the latest run.
        const debate = seed('辩论任务', now, 'debate'), jury = seed('评审任务', now, 'jury');
        tree = await read();
        assert.equal(tree.tasks.find((t: { id: string }) => t.id === debate).mode, 'debate');
        assert.equal(tree.tasks.find((t: { id: string }) => t.id === jury).mode, 'jury');
        assert.equal((await fx.app.inject({ url: '/api/v1/sidebar', headers: otherHeaders })).json().data.tasks.length, 0);
        const runId=task.runId as string;
        const getTask=async()=> (await read()).tasks.find((t:{id:string})=>t.id===latest);
        const ack=async(marker:string)=>fx.app.inject({method:'PATCH',url:`/api/v1/conversations/${latest}`,headers,payload:{unread:false,readThrough:marker}});
        for(const type of ['agent.message_delta','tool.result','run.started'])fx.supervisor.emit(runId,type,{},'public');
        fx.supervisor.emit(runId,'run.failed',{},'audit');
        assert.equal((await getTask()).unreadAt,null,'过程事件和非公开事件不产生未读');
        fx.supervisor.emit(runId,'run.succeeded',{},'public');
        const first=(await getTask()).unreadAt as string;
        assert.ok(first,'后台任务完成应自动标为未读');
        assert.equal((await ack(first)).statusCode,200);
        assert.equal((await getTask()).unreadAt,null);
        for(const type of ['run.failed','run.waiting_input','run.needs_reconciliation','tool.awaiting_approval']){
            fx.supervisor.emit(runId,type,{},'public');
            const marker=(await getTask()).unreadAt as string;
            assert.ok(marker>first,'每次新通知更新游标，即使在同一毫秒内');
            await ack(first);
            assert.equal((await getTask()).unreadAt,marker,'迟到的已读回执不能清除新通知');
            await ack(marker);
            assert.equal((await getTask()).unreadAt,null);
        }
        assert.throws(()=>fx.db.tx(tx=>{
            tx.prepare("INSERT INTO run_events(run_id,seq,event_id,visibility,type,occurred_at,payload_json) VALUES (?,9999,?,'public','run.succeeded',?,'{}')").run(runId,randomUUID(),now);
            throw new Error('rollback-notification');
        }),/rollback-notification/);
        assert.equal((await getTask()).unreadAt,null,'事件回滚时未读标记一起回滚');
        assert.equal((await fx.app.inject({method:'PATCH',url:`/api/v1/conversations/${latest}`,headers,payload:{readThrough:first}})).statusCode,400);
        await fx.app.inject({method:'PATCH',url:`/api/v1/conversations/${latest}`,headers,payload:{archived:true}});
        fx.supervisor.emit(runId,'run.succeeded',{},'public');
        assert.equal((await getTask()).unreadAt,null,'归档任务不新增未读');
    } finally { await fx.app.close(); clearLoginFailures(); rmSync(dir, { recursive: true, force: true }); }
});

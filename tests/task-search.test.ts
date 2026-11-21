import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildProductApp } from '../src/app.js';
import { hashPassword } from '../src/auth/passwords.js';
import { clearLoginFailures } from '../src/auth/routes.js';

test('任务搜索：近期任务、标题与正文匹配、片段窗口、归档排除与属主隔离', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-task-search-'));
    const fx = buildProductApp(dir, { serveWeb: false });
    try {
        const password = 'Synthetic-task-search', pw = await hashPassword(password), now = new Date().toISOString();
        const uid = randomUUID(), stranger = randomUUID();
        for (const [id, name] of [[uid, 'search-check'], [stranger, 'search-other']]) fx.db.db.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)').run(id!, name!, pw.hash, pw.salt, pw.paramsJson, now, now);
        const login = await fx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'search-check', password } });
        const cookie = String(login.headers['set-cookie']).split(';')[0]!;
        const headers = { cookie, 'x-csrf-token': login.json().data.csrfToken as string };
        const other = await fx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'search-other', password } });
        const otherHeaders = { cookie: String(other.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': other.json().data.csrfToken as string };
        const project = (await fx.app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: '检索项目' } })).json().data.id as string;
        const seed = (title: string, updated: string) => {
            const c = randomUUID(), pv = randomUUID(), r = randomUUID();
            fx.db.tx(tx => {
                tx.prepare('INSERT INTO conversations(id,project_id,mode,title,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(c, project, 'ordinary', title, now, updated);
                tx.prepare('INSERT INTO problem_versions(id,conversation_id,version,objective,created_at,updated_at) VALUES (?,?,1,?,?,?)').run(pv, c, title, now, now);
                tx.prepare("INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,config_snapshot_json,created_at,updated_at) VALUES (?,?,?,?,'ordinary','succeeded','{}',?,?)").run(r, project, c, pv, now, now);
            });
            return { conversationId: c, runId: r };
        };
        const message = (runId: string, conversationId: string, seq: number, text: string, visibility = 'public', state = 'published') =>
            fx.db.db.prepare("INSERT INTO messages(id,conversation_id,run_id,author_type,role_id,seq,visibility,state,content_json,created_at,updated_at) VALUES (?,?,?,'user','ordinary',?,?,?,?,'t','t')").run(randomUUID(), conversationId, runId, seq, visibility, state, JSON.stringify({ text }));

        const recent = seed('存贷双高议题', '2026-03-01T00:00:00.000Z');
        const byTitle = seed('年度审计复盘', '2026-03-02T00:00:00.000Z');
        const byContent = seed('普通讨论', '2026-03-03T00:00:00.000Z');
        const archived = seed('已归档的存货分析', '2026-03-04T00:00:00.000Z');
        message(byContent.runId, byContent.conversationId, 1, '开场白部分先复述了项目背景与资料范围，又回顾了上一阶段的讨论结论、遗留问题与各方意见分歧，交代了所需的补充材料清单，本轮关注的重点是存货周转异常的预警信号，随后的讨论进入证据核对环节，各方就毛利率、现金流量与营业收入的多组口径反复比对，逐一登记待确认事项并约定下次复盘时间与责任人，提醒下周继续跟进未完成事项并同步进度给项目组其他成员。');
        message(byContent.runId, byContent.conversationId, 2, '补充记录：存货周转异常还包括毛利率与现金流背离。');
        message(byContent.runId, byContent.conversationId, 3, '私有草稿提到存货周转异常，但尚未发布，不应被搜到。', 'private');
        message(byContent.runId, byContent.conversationId, 4, '已放弃的消息同样不进索引：存货周转异常。', 'public', 'abandoned');
        fx.db.db.prepare('UPDATE conversations SET archived_at=? WHERE id=?').run(now, archived.conversationId);

        const get = async (q: string, limit?: string) => fx.app.inject({ url: `/api/v1/tasks/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`, headers });
        const items = (payload: { items: Array<{ id: string; searchSnippets?: string[] }> }) => payload.items;

        // Empty query = recent tasks, newest first, no snippets; archived excluded.
        const recentRead = items((await get('')).json().data);
        assert.deepEqual(recentRead.map(t => t.id), [byContent.conversationId, byTitle.conversationId, recent.conversationId]);
        assert.equal(recentRead[0]!.searchSnippets, undefined);

        // Title match: no snippets.
        const titleRead = items((await get('审计')).json().data);
        assert.deepEqual(titleRead.map(t => t.id), [byTitle.conversationId]);
        assert.equal(titleRead[0]!.searchSnippets, undefined);

        // Content match: snippets only from published+public messages, with ellipsis markers.
        const contentRead = items((await get('存货周转异常')).json().data);
        assert.deepEqual(contentRead.map(t => t.id), [byContent.conversationId]);
        const snippets = contentRead[0]!.searchSnippets!;
        assert.equal(snippets.length, 2);
        assert.ok(snippets[0]!.includes('存货周转异常'));
        assert.ok(snippets[0]!.startsWith('…') && snippets[0]!.endsWith('…'));
        assert.ok(snippets[1]!.includes('毛利率与现金流背离'));

        // Combined candidates keep the updatedAt order; the archived match is excluded entirely.
        const combined = items((await get('存货')).json().data);
        assert.deepEqual(combined.map(t => t.id), [byContent.conversationId]);
        assert.equal((await get('存货分析', '5')).json().data.items.length, 0, '归档任务不参与正文与标题检索');

        // Owner isolation: the stranger sees nothing.
        const strangerRead = await fx.app.inject({ url: `/api/v1/tasks/search?q=${encodeURIComponent('存货')}`, headers: otherHeaders });
        assert.deepEqual(items(strangerRead.json().data), []);
        const strangerRecent = await fx.app.inject({ url: '/api/v1/tasks/search', headers: otherHeaders });
        assert.deepEqual(items(strangerRecent.json().data), []);

        // Unauthenticated access is rejected by the shared v1 gate.
        assert.equal((await fx.app.inject({ url: '/api/v1/tasks/search' })).statusCode, 401);
    } finally {
        await fx.app.close();
        clearLoginFailures();
        rmSync(dir, { recursive: true, force: true });
    }
});

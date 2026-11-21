import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildUnifiedDiff, DIFF_TRUNCATED_MARKER_PREFIX } from '../src/agent/lineDiff.js';
import { getPlainTextPatchPreviewLines, getPatchPreviewLineContent, getLightweightDiffLineParts, parseTruncatedMarkerOmittedLineCount, inferDiffLanguage, MAX_PATCH_DIFF_SAFE_LINE_COUNT } from '../web/conversation/patchDiff.js';
import { buildProductApp } from '../src/app.js';
import { brokerWrite } from '../src/agent/toolExec.js';
import { hashPassword } from '../src/auth/passwords.js';
import { clearLoginFailures } from '../src/auth/routes.js';
import { changeLineStats } from '../src/agent/changeLineStats.js';
import { totalChangeLines } from '../web/conversation/changeStats.js';

/** 块F1（diff视图＋真实run证据/变更面板）：统一 diff 生成、补丁预览解析、changes/diff 路由与工具卡数据链。 */

test('变更行数：跳过文件头，保留正文中的加减号，超过预览上限仍完整统计', () => {
    const patch = buildUnifiedDiff('-- old\nkeep\n', '++ new\nkeep\nextra\n', 'a/x', 'b/x').patch;
    assert.deepEqual(changeLineStats(patch), { addedLines: 2, removedLines: 1, truncated: false });
    assert.deepEqual(changeLineStats(null), null, '历史缺补丁不冒充零行');
    assert.deepEqual(changeLineStats(null, 'same-hash', 'same-hash'), { addedLines: 0, removedLines: 0, truncated: false });
    const large = buildUnifiedDiff(null, Array.from({ length: 1500 }, (_, i) => `line${i}`).join('\n'), '/dev/null', 'b/x');
    assert.equal(changeLineStats(large.patch)?.addedLines, 1500, '不能按1200行前端预览统计');
    const truncated = buildUnifiedDiff(null, Array.from({ length: 4100 }, (_, i) => `line${i}`).join('\n'), '/dev/null', 'b/x');
    assert.deepEqual(changeLineStats(truncated.patch), { addedLines: 4000, removedLines: 0, truncated: true });
    assert.deepEqual(changeLineStats(''), { addedLines: 0, removedLines: 0, truncated: false });
    const changes = [
        { id: 'a', relative_path: 'x', operation: 'create', hasDiff: 1, lineStats: changeLineStats(large.patch) },
        { id: 'b', relative_path: 'x', operation: 'modify', hasDiff: 1, reverted_at: 'now', lineStats: changeLineStats(patch) },
        { id: 'c', relative_path: 'y', operation: 'modify', hasDiff: 0, lineStats: null },
    ];
    assert.deepEqual(totalChangeLines(changes), { addedLines: 1502, removedLines: 1, truncated: true });
    assert.deepEqual(totalChangeLines([]), { addedLines: 0, removedLines: 0, truncated: false });
});

test('lineDiff: 修改/新建/删除三类补丁、无变化空串、超限截断标记', () => {
    // 修改：含上下文与 hunk 头
    const modify = buildUnifiedDiff('a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nX\nd\ne\nf\ng\nh', 'a/t.txt', 'b/t.txt');
    assert.ok(modify.patch.startsWith('--- a/t.txt\n+++ b/t.txt\n'));
    // 变更在第3行，前文不足3行上下文 → hunk 从文件头起
    assert.ok(modify.patch.includes('@@ -1,6 +1,6 @@'), `应含 hunk 头：${modify.patch}`);
    assert.ok(modify.patch.includes('-c\n+X'));
    assert.equal(modify.addedLines, 1);
    assert.equal(modify.removedLines, 1);
    assert.equal(modify.truncated, false);
    // 新建：全部为加行
    const create = buildUnifiedDiff(null, 'l1\nl2', '/dev/null', 'b/new.txt');
    assert.ok(create.patch.includes('+++ b/new.txt'));
    assert.equal(create.addedLines, 2);
    assert.equal(create.removedLines, 0);
    assert.ok(create.patch.includes('+l1\n+l2'));
    // 删除：全部为减行
    const del = buildUnifiedDiff('x\ny', null, 'a/old.txt', '/dev/null');
    assert.equal(del.removedLines, 2);
    assert.equal(del.addedLines, 0);
    assert.ok(del.patch.includes('-x\n-y'));
    // 无变化：空补丁
    const same = buildUnifiedDiff('same\ncontent', 'same\ncontent', 'a/f', 'b/f');
    assert.equal(same.patch, '');
    assert.equal(same.addedLines, 0);
    // 单侧超 4000 行 → 截断标记且行数正确
    const bigBefore = Array.from({ length: 5000 }, (_, i) => `old${i}`).join('\n');
    const bigAfter = 'new1\nnew2';
    const truncated = buildUnifiedDiff(bigBefore, bigAfter, 'a/big', 'b/big');
    assert.equal(truncated.truncated, true);
    assert.ok(truncated.patch.includes(`${DIFF_TRUNCATED_MARKER_PREFIX}1000`), `应省略 1000 行：${truncated.patch.slice(-200)}`);
});

test('patchDiff: hunk 正文提取、文件头过滤、上限封顶与协议 marker', () => {
    const patch = '--- a/t.txt\n+++ b/t.txt\n@@ -1,4 +1,4 @@\n a\n-b\n+c\n d\n';
    const lines = getPlainTextPatchPreviewLines(patch);
    assert.deepEqual(lines, [' a', '-b', '+c', ' d']);
    assert.deepEqual(getLightweightDiffLineParts('+c'), { content: 'c', kind: 'added', marker: '+', raw: '+c' });
    assert.deepEqual(getLightweightDiffLineParts('-b'), { content: 'b', kind: 'removed', marker: '-', raw: '-b' });
    assert.deepEqual(getLightweightDiffLineParts(' a'), { content: 'a', kind: 'context', marker: ' ', raw: ' a' });
    assert.equal(getPatchPreviewLineContent('+hello'), 'hello');
    assert.equal(parseTruncatedMarkerOmittedLineCount(`${DIFF_TRUNCATED_MARKER_PREFIX}42`), 42);
    assert.equal(parseTruncatedMarkerOmittedLineCount(' a'), null);
    // 封顶：>1200 正文行追加截断行
    const big = `--- a/big\n+++ b/big\n@@ -1,1300 +1,1300 @@\n${Array.from({ length: 1300 }, (_, i) => ` line${i}`).join('\n')}\n`;
    const capped = getPlainTextPatchPreviewLines(big);
    assert.equal(capped.length, MAX_PATCH_DIFF_SAFE_LINE_COUNT + 1);
    assert.ok(parseTruncatedMarkerOmittedLineCount(capped.at(-1)!) !== null);
    // 协议行 "\ No newline" 保留
    const noEol = '--- a/t\n+++ b/t\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n';
    assert.ok(getPlainTextPatchPreviewLines(noEol).includes('\\ No newline at end of file'));
    // 语言推断
    assert.equal(inferDiffLanguage('src/app.ts'), 'typescript');
    assert.equal(inferDiffLanguage('README.md'), 'markdown');
    assert.equal(inferDiffLanguage('noext'), '');
});

test('changes/diff 路由：brokerWrite 落补丁 → changes hasDiff → diff 端点 → 工具结果 diff 元信息', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-changes-'));
    const workspace = mkdtempSync(join(tmpdir(), 'prism-changes-ws-'));
    const fx = buildProductApp(dir, { serveWeb: false });
    try {
        const record = await hashPassword('correct-horse-battery');
        const uid = randomUUID();
        const now = new Date().toISOString();
        fx.db.tx(tx => tx.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)')
            .run(uid, 'changer', record.hash, record.salt, record.paramsJson, now, now));
        const login = await fx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'changer', password: 'correct-horse-battery' } });
        const cookie = ((Array.isArray(login.headers['set-cookie']) ? String(login.headers['set-cookie'][0]) : String(login.headers['set-cookie']))).split(';')[0]!;
        const authHeaders = { cookie, 'x-csrf-token': (login.json() as { data: { csrfToken: string } }).data.csrfToken };
        // 项目 + 写授权（直插 grant 指向临时工作区）
        const project = (await fx.app.inject({ method: 'POST', url: '/api/v1/projects', headers: authHeaders, payload: { name: '变更项目' } })).json().data as { id: string };
        const grantId = randomUUID();
        fx.db.tx(tx => tx.prepare("INSERT INTO workspace_grants(id,project_id,canonical_root,access,revision,selected_by,excludes_json,created_at,updated_at) VALUES (?,?,?,'write',1,?,'[]',?,?)")
            .run(grantId, project.id, workspace, uid, now, now));
        const convId = randomUUID(), pv = randomUUID(), runId = randomUUID(), invocationId = randomUUID();
        fx.db.tx(tx => {
            tx.prepare("INSERT INTO conversations(id,project_id,mode,title,created_at,updated_at) VALUES (?,?,'ordinary','变更任务',?,?)").run(convId, project.id, now, now);
            tx.prepare('INSERT INTO problem_versions(id,conversation_id,version,objective,created_at,updated_at) VALUES (?,?,1,?,?,?)').run(pv, convId, '目标', now, now);
            tx.prepare("INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,config_snapshot_json,created_at,updated_at) VALUES (?,?,?,?,'ordinary','running','{}',?,?)").run(runId, project.id, convId, pv, now, now);
            // FK 链：model_configs → agent_bindings → phase_tasks → attempts → tool_invocations
            const configId = randomUUID(), bindingId = randomUUID(), phaseId = randomUUID(), attemptId = randomUUID();
            tx.prepare("INSERT INTO model_configs(id,owner_user_id,preset,name,base_url,api_protocol,revision,enabled,created_at,updated_at) VALUES (?,?,?,?,?,'openai-completions',1,1,?,?)")
                .run(configId, uid, 'custom', '测试配置', 'https://127.0.0.1', now, now);
            tx.prepare("INSERT INTO agent_bindings(id,run_id,role_id,model_config_id,model_id,prompt_version,policy_version,created_at,updated_at) VALUES (?,?,'ordinary',?,'test-model','v0','v0',?,?)")
                .run(bindingId, runId, configId, now, now);
            tx.prepare("INSERT INTO phase_tasks(id,run_id,agent_binding_id,phase_key,round_no,status,input_manifest_json,created_at,updated_at) VALUES (?,?,?,'ordinary',0,'pending','{}',?,?)")
                .run(phaseId, runId, bindingId, now, now);
            tx.prepare("INSERT INTO attempts(id,phase_task_id,number,status,created_at,updated_at) VALUES (?,?,1,'running',?,?)")
                .run(attemptId, phaseId, now, now);
            tx.prepare("INSERT INTO tool_invocations(id,run_id,phase_task_id,attempt_id,call_key,tool_name,tool_version,args_hash,canonical_exec_args_json,redacted_args_json,state,effect_kind,created_at,updated_at) VALUES (?,?,?,?,?,'write_file','v1','h','{}','{}','succeeded','fs_write',?,?)")
                .run(invocationId, runId, phaseId, attemptId, `k:${invocationId}`, now, now);
        });
        // create：写新文件
        const targetRel = 'notes/todo.txt';
        const grant = fx.db.db.prepare('SELECT * FROM workspace_grants WHERE id=?').get(grantId) as { id: string; project_id: string; canonical_root: string; access: 'read' | 'write'; revision: number; selected_by: string; revoked_at: string | null; excludes_json: string; created_at: string; updated_at: string; is_primary: number };
        const created = await brokerWrite(fx.db, { runId, invocationId, dataDir: dir }, grant, { operation: 'create', relativePath: targetRel, content: '第一行\n第二行\n', expectedHash: null });
        assert.ok(readFileSync(join(workspace, targetRel), 'utf8').includes('第一行'));
        // modify：改一行
        const modified = await brokerWrite(fx.db, { runId, invocationId, dataDir: dir }, grant, { operation: 'modify', relativePath: targetRel, content: '第一行\n改过的第二行\n', expectedHash: created.afterHash });
        assert.equal(modified.diffSummary.addedLines, 1);
        assert.equal(modified.diffSummary.removedLines, 1);
        assert.ok(join(dir, 'backups', runId), '应有备份目录');
        // 模拟监督器在工具完成后落 result_json（真实链中由 supervisor 写入）
        fx.db.db.prepare('UPDATE tool_invocations SET result_json=? WHERE id=?')
            .run(JSON.stringify({ path: targetRel, operation: 'modify', changeRecordId: modified.changeRecordId, diffSummary: modified.diffSummary }), invocationId);
        // changes 列表带 hasDiff
        const list = await fx.app.inject({ method: 'GET', url: `/api/v1/runs/${runId}/changes`, headers: { cookie } });
        assert.equal(list.statusCode, 200);
        const changes = (list.json() as { data: { changes: Array<{ id: string; operation: string; hasDiff: number; lineStats: { addedLines: number; removedLines: number; truncated: boolean } }> } }).data.changes;
        assert.equal(changes.length, 2);
        assert.ok(changes.every(change => change.hasDiff === 1), '两条变更都应有补丁');
        const modifyRecord = changes.find(change => change.operation === 'modify')!;
        assert.deepEqual(modifyRecord.lineStats, { addedLines: 1, removedLines: 1, truncated: false });
        assert.deepEqual(changes.find(change => change.operation === 'create')!.lineStats, { addedLines: 2, removedLines: 0, truncated: false });
        assert.equal(list.json().data.total, 2);
        assert.ok(changes.every(change => !('diff_patch' in change)), '列表只返回统计，不携带补丁正文');
        // diff 端点返回补丁正文
        const diffRes = await fx.app.inject({ method: 'GET', url: `/api/v1/runs/${runId}/changes/${modifyRecord.id}/diff`, headers: { cookie } });
        assert.equal(diffRes.statusCode, 200);
        const patch = (diffRes.json() as { data: { patch: string; path: string } }).data.patch;
        assert.ok(patch.includes('-第二行'), `补丁应含被替换行：${patch}`);
        assert.ok(patch.includes('+改过的第二行'));
        assert.equal((diffRes.json() as { data: { path: string } }).data.path, targetRel);
        // 工具结果端点带 diff 元信息
        const toolRes = await fx.app.inject({ method: 'GET', url: `/api/v1/runs/${runId}/tools/${invocationId}`, headers: { cookie } });
        assert.equal(toolRes.statusCode, 200);
        const diffMeta = (toolRes.json() as { data: { diff?: { changeRecordId: string; addedLines: number; removedLines: number } } }).data.diff;
        assert.ok(diffMeta, '写入工具结果应带 diff 元信息');
        assert.equal(diffMeta!.addedLines, 1);
        assert.equal(diffMeta!.removedLines, 1);
        // 他人 run 404 不泄露
        const stranger = await hashPassword('other-password-123');
        const uid2 = randomUUID();
        fx.db.tx(tx => tx.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)')
            .run(uid2, 'changer-b', stranger.hash, stranger.salt, stranger.paramsJson, now, now));
        const login2 = await fx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'changer-b', password: 'other-password-123' } });
        const cookie2 = ((Array.isArray(login2.headers['set-cookie']) ? String(login2.headers['set-cookie'][0]) : String(login2.headers['set-cookie']))).split(';')[0]!;
        assert.equal((await fx.app.inject({ method: 'GET', url: `/api/v1/runs/${runId}/changes/${modifyRecord.id}/diff`, headers: { cookie: cookie2 } })).statusCode, 404);
        assert.equal((await fx.app.inject({ method: 'GET', url: `/api/v1/runs/${runId}/changes`, headers: { cookie: cookie2 } })).statusCode, 404);
        // 无效记录 404
        assert.equal((await fx.app.inject({ method: 'GET', url: `/api/v1/runs/${runId}/changes/${randomUUID()}/diff`, headers: { cookie } })).statusCode, 404);
    } finally {
        await fx.app.close();
        clearLoginFailures();
        rmSync(dir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildProductApp } from '../src/app.js';
import { sniffImageMime, saveAttachment, loadAttachmentImages, normalizeAttachmentIds, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, attachmentView } from '../src/agent/attachments.js';
import { toolReadImage } from '../src/agent/toolExec.js';
import { summarizeResult } from '../src/agent/supervisor.js';
import { parseChatRequest } from '../src/agent/protocolAdapter.js';
import { resolveVisionSupport } from '../src/agent/modelCatalog.js';
import { hashPassword } from '../src/auth/passwords.js';
import { clearLoginFailures } from '../src/auth/routes.js';
import type { Db } from '../src/storage/db.js';

/** 块E2（附件/图片）：魔数嗅探、上传/归属路由、steer附件装载、read_image、网关图片透传、视觉位。 */

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(12, 7)]);
const FAKE_PNG = Buffer.from('这张不是图片，只是长得像png的文本'.repeat(2));
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(8, 1)]);

function multipartBody(data: Buffer, boundary: string): Buffer {
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="截图.png"\r\nContent-Type: image/png\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return Buffer.concat([head, data, tail]);
}

async function makeUser(fx: ReturnType<typeof buildProductApp>, username: string, password: string): Promise<{ uid: string; cookie: string; csrf: string }> {
    const record = await hashPassword(password);
    const uid = randomUUID();
    const now = new Date().toISOString();
    fx.db.tx(tx => tx.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)')
        .run(uid, username, record.hash, record.salt, record.paramsJson, now, now));
    const login = await fx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
    const cookie = ((Array.isArray(login.headers['set-cookie']) ? String(login.headers['set-cookie'][0]) : String(login.headers['set-cookie']))).split(';')[0]!;
    return { uid, cookie, csrf: (login.json() as { data: { csrfToken: string } }).data.csrfToken };
}

test('attachments helpers: 魔数嗅探、保存登记、归属装载、id规范化', async () => {
    assert.equal(sniffImageMime(PNG_BYTES), 'image/png');
    assert.equal(sniffImageMime(WEBP_BYTES), 'image/webp');
    assert.equal(sniffImageMime(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9)])), 'image/jpeg');
    assert.equal(sniffImageMime(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(6)])), 'image/gif');
    assert.equal(sniffImageMime(FAKE_PNG), null);
    assert.equal(sniffImageMime(Buffer.alloc(4)), null);

    const dir = mkdtempSync(join(tmpdir(), 'prism-att-'));
    const fx = buildProductApp(dir, { serveWeb: false });
    try {
        const uid = randomUUID(), strangerId = randomUUID(), now = new Date().toISOString();
        for (const id of [uid, strangerId]) {
            fx.db.tx(tx => tx.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)')
                .run(id, `att-user-${id.slice(0, 8)}`, 'h', 's', '{}', now, now));
        }
        const row = saveAttachment(fx.db, dir, uid, 'screenshots/我的截图.png', PNG_BYTES);
        assert.equal(row.mime, 'image/png');
        assert.equal(row.display_name, 'screenshots_我的截图.png');
        assert.equal(readFileSync(row.internal_path).equals(PNG_BYTES), true);
        assert.equal(row.sha256.length, 64);
        // 他人装载：整体拒绝（不泄露存在性）
        assert.throws(() => loadAttachmentImages(fx.db, strangerId, [row.id]), /附件不存在或无权访问/);
        const loaded = loadAttachmentImages(fx.db, uid, [row.id]);
        assert.equal(loaded.rows.length, 1);
        assert.equal(loaded.images[0]!.mimeType, 'image/png');
        assert.equal(Buffer.from(loaded.images[0]!.data, 'base64').equals(PNG_BYTES), true);
        // 任一缺失即整体拒绝（不部分装载）
        assert.throws(() => loadAttachmentImages(fx.db, uid, [row.id, '00000000-0000-4000-8000-000000000000']), /附件不存在或无权访问/);
        // 视图脱路径
        const view = attachmentView(row);
        assert.deepEqual(Object.keys(view).sort(), ['id', 'mime', 'name', 'sizeBytes']);
    } finally {
        await fx.app.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('normalizeAttachmentIds: 上限/去空/去重/类型', () => {
    assert.deepEqual(normalizeAttachmentIds(undefined), []);
    assert.deepEqual(normalizeAttachmentIds(null), []);
    assert.deepEqual(normalizeAttachmentIds(['a', ' b ']), ['a', 'b']);
    assert.throws(() => normalizeAttachmentIds('x'), /须为数组/);
    assert.throws(() => normalizeAttachmentIds(Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, i) => `id${i}`)), /最多/);
    // 空串剔除后仍有重复 → 拒绝
    assert.throws(() => normalizeAttachmentIds(['dup', '', 'dup']), /附件重复/);
    assert.equal(MAX_ATTACHMENT_BYTES, 10 * 1024 * 1024);
});

test('attachment routes: 上传multipart→登记→本人读取；伪造图片拒绝；他人404', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-att-routes-'));
    const fx = buildProductApp(dir, { serveWeb: false });
    try {
        const { uid, cookie, csrf } = await makeUser(fx, 'uploader', 'correct-horse-battery');
        const headers = { cookie, 'x-csrf-token': csrf };
        const boundary = 'prismTestBoundary123';
        // 合法png
        const upload = await fx.app.inject({ method: 'POST', url: '/api/v1/attachments', headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: multipartBody(PNG_BYTES, boundary) });
        assert.equal(upload.statusCode, 201, `上传应成功：${upload.body}`);
        const view = upload.json() as { data: { id: string; name: string; mime: string; sizeBytes: number } };
        assert.equal(view.data.mime, 'image/png');
        assert.equal(view.data.sizeBytes, PNG_BYTES.byteLength);
        // 元数据（本人）
        const meta = await fx.app.inject({ method: 'GET', url: `/api/v1/attachments/${view.data.id}`, headers: { cookie } });
        assert.equal(meta.statusCode, 200);
        // 原图（本人）：字节一致 + content-type
        const raw = await fx.app.inject({ method: 'GET', url: `/api/v1/attachments/${view.data.id}/raw`, headers: { cookie } });
        assert.equal(raw.statusCode, 200);
        assert.equal(raw.headers['content-type'], 'image/png');
        assert.equal(Buffer.from(raw.rawPayload).equals(PNG_BYTES), true);
        // 伪造png（魔数不符）
        const fakeBoundary = 'prismFakeBoundary456';
        const fake = await fx.app.inject({ method: 'POST', url: '/api/v1/attachments', headers: { ...headers, 'content-type': `multipart/form-data; boundary=${fakeBoundary}` }, payload: multipartBody(FAKE_PNG, fakeBoundary) });
        assert.equal(fake.statusCode, 400);
        // 缺文件
        const empty = await fx.app.inject({ method: 'POST', url: '/api/v1/attachments', headers, payload: {} });
        assert.notEqual(empty.statusCode, 201);
        // 他人：元数据与原图同形404
        const stranger = await makeUser(fx, 'uploader-b', 'other-password-123');
        assert.equal((await fx.app.inject({ method: 'GET', url: `/api/v1/attachments/${view.data.id}/raw`, headers: { cookie: stranger.cookie } })).statusCode, 404);
        assert.equal((await fx.app.inject({ method: 'GET', url: `/api/v1/attachments/${randomUUID()}/raw`, headers: { cookie } })).statusCode, 404);
        // 未登录401
        const anon = await fx.app.inject({ method: 'GET', url: `/api/v1/attachments/${view.data.id}/raw` });
        assert.equal([401, 403].includes(anon.statusCode), true);
        void uid;
    } finally {
        await fx.app.close();
        clearLoginFailures();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('supervisor.steer: 附件元数据入content_json；缺失/越权附件整体拒绝', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-steer-att-'));
    const fx = buildProductApp(dir, { serveWeb: false });
    try {
        const { uid, cookie, csrf } = await makeUser(fx, 'steerer', 'correct-horse-battery');
        const att = saveAttachment(fx.db, dir, uid, 'shot.png', PNG_BYTES);
        const now = new Date().toISOString();
        const project = (await fx.app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie, 'x-csrf-token': csrf }, payload: { name: '附件项目' } })).json().data as { id: string };
        const convId = randomUUID(), runId = randomUUID(), pvId = randomUUID();
        fx.db.tx(tx => {
            tx.prepare("INSERT INTO conversations(id,project_id,mode,title,created_at,updated_at) VALUES (?,?,'ordinary','附件任务',?,?)").run(convId, project.id, now, now);
            tx.prepare("INSERT INTO problem_versions(id,conversation_id,version,objective,created_at,updated_at) VALUES (?,?,1,?,?,?)").run(pvId, convId, '附件目标', now, now);
            tx.prepare("INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,config_snapshot_json,created_at,updated_at) VALUES (?,?,?,?, 'ordinary','created','{}',?,?)").run(runId, project.id, convId, pvId, now, now);
        });
        // 无活动worker：steer仅落消息行（消息与附件元数据可独立验证）
        const result = fx.supervisor.steer(runId, uid, '请看这张截图', null, [att.id]);
        assert.equal(result.duplicate, false);
        const row = fx.db.db.prepare('SELECT content_json FROM messages WHERE id=?').get(result.messageId) as { content_json: string };
        const content = JSON.parse(row.content_json) as { text: string; attachments: Array<{ id: string; name: string; mime: string }> };
        assert.equal(content.text, '请看这张截图');
        assert.equal(content.attachments?.[0]?.id, att.id);
        assert.ok(!row.content_json.includes('base64'), '库内不存图片正文');
        // 缺失附件：整体拒绝（ApexError→路由层映射；此处直接调supervisor验证语义）
        assert.throws(() => fx.supervisor.steer(runId, uid, '带缺失附件', null, ['00000000-0000-4000-8000-000000000000']), /NOT_FOUND|附件/);
        // >10张
        assert.throws(() => fx.supervisor.steer(runId, uid, '太多图片', null, Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () => att.id)), /最多|VALIDATION/);
    } finally {
        await fx.app.close();
        clearLoginFailures();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('read_image: grant路径解析+魔数校验；summarizeResult剥除base64', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'prism-readimg-ws-'));
    try {
        mkdirSync(join(workspace, 'assets'), { recursive: true });
        writeFileSync(join(workspace, 'assets', 'shot.png'), PNG_BYTES);
        writeFileSync(join(workspace, 'assets', 'fake.png'), FAKE_PNG);
        writeFileSync(join(workspace, 'assets', 'big.webp'), Buffer.concat([Buffer.from(WEBP_BYTES), Buffer.alloc(MAX_ATTACHMENT_BYTES)]));
        const grant = { canonical_root: workspace } as never;
        const ok = await toolReadImage(grant, { path: 'assets/shot.png' });
        assert.equal(ok.mime, 'image/png');
        assert.equal(ok.sizeBytes, PNG_BYTES.byteLength);
        assert.equal(Buffer.from(ok.imageData, 'base64').equals(PNG_BYTES), true);
        assert.equal(ok.path, join('assets', 'shot.png'));
        // 伪造图片拒绝
        await assert.rejects(() => toolReadImage(grant, { path: 'assets/fake.png' }), /不是可识别的图片/);
        // 超10MiB拒绝（WEBP头+填充）
        await assert.rejects(() => toolReadImage(grant, { path: 'assets/big.webp' }), /10MiB/);
        // summarizeResult：result_json永不存base64
        const summarized = summarizeResult(ok);
        assert.equal(summarized._imageElided, true);
        assert.ok(String(summarized.imageData).includes('已省略'));
        assert.ok(!JSON.stringify(summarized).includes(ok.imageData.slice(0, 40)), 'base64不得进入摘要');
        // 普通结果不受影响
        const plain = summarizeResult({ path: 'a', sizeBytes: 3 });
        assert.equal(plain._imageElided, undefined);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test('protocolAdapter: 用户消息图片分块透传；外链图片与非法mime拒绝', () => {
    const dataUrl = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
    const parsed = parseChatRequest({
        model: 'test-model',
        messages: [
            { role: 'system', content: '系统提示' },
            { role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image_url', image_url: { url: dataUrl } }] },
            { role: 'user', content: '纯文本补充' },
        ],
        max_tokens: 100,
    });
    const withImage = parsed.messages[0] as { role: string; content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> };
    assert.equal(withImage.role, 'user');
    assert.deepEqual(withImage.content.map(b => b.type), ['text', 'image']);
    assert.equal(withImage.content[0]!.text, '看这张图');
    assert.equal(withImage.content[1]!.mimeType, 'image/png');
    assert.equal(Buffer.from(withImage.content[1]!.data!, 'base64').equals(PNG_BYTES), true);
    const plain = parsed.messages[1] as { role: string; content: string };
    assert.equal(plain.content, '纯文本补充');
    assert.equal(parsed.systemPrompt, '系统提示');
    // 外链图片拒绝
    assert.throws(() => parseChatRequest({ model: 'm', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }] }), /data URL/);
    // 非法mime拒绝
    assert.throws(() => parseChatRequest({ model: 'm', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:application/pdf;base64,AAAA' } }] }] }), /PNG\/JPEG\/GIF\/WEBP/);
    // tool角色路径不受影响（仍文本）
    const toolMsg = parseChatRequest({ model: 'm', messages: [{ role: 'tool', tool_call_id: 'x', content: '结果' }] });
    assert.equal((toolMsg.messages[0] as { content: unknown }).content !== undefined, true);
});

test('resolveVisionSupport: 以 pi-ai 随包目录为唯一事实来源', () => {
    // 目录实测：deepseek-flash 声明 input=["text","image"]；deepseek-v4-pro 纯文本
    assert.equal(resolveVisionSupport('openai-completions', 'https://api.deepseek.com', 'deepseek-flash'), true);
    assert.equal(resolveVisionSupport('openai-completions', 'https://api.deepseek.com', 'deepseek-v4-pro'), false);
    // baseUrl 尾斜杠与模型 id 大小写不敏感
    assert.equal(resolveVisionSupport('openai-completions', 'https://api.deepseek.com/', 'DeepSeek-Flash'), true);
    // 目录未收录 baseUrl（GLM 标准端点）→ 按 modelId 全目录唯一匹配
    assert.equal(resolveVisionSupport('openai-completions', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3'), false);
    assert.equal(resolveVisionSupport('openai-completions', 'https://open.bigmodel.cn/api/coding/paas/v4', 'glm-5.3'), false);
    // 目录按 openai-responses 家族收录的模型，换 openai-completions 协议访问仍按模型事实判定
    assert.equal(resolveVisionSupport('openai-completions', 'https://api.openai.com/v1', 'gpt-4o'), true);
    // Anthropic是协议，不自动赋予视觉；已收录Claude仍可看图，未知别名和GLM-5.3不可。
    assert.equal(resolveVisionSupport('anthropic-messages', 'https://example.invalid', 'claude-sonnet-4-5'), true);
    assert.equal(resolveVisionSupport('anthropic-messages', 'https://open.bigmodel.cn/api/anthropic', 'glm-5.3'), false);
    assert.equal(resolveVisionSupport('anthropic-messages', 'https://open.bigmodel.cn/api/anthropic', 'glm-5.3-flash'), true);
    assert.equal(resolveVisionSupport('anthropic-messages', 'https://example.invalid', 'travel-agent'), false);
    // 目录查不到的自定义模型：不猜，按不支持
    assert.equal(resolveVisionSupport('openai-completions', 'https://relay.example.invalid/v1', 'travel-agent'), false);
    assert.equal(resolveVisionSupport('openai-completions', 'https://api.deepseek.com', ''), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildProductApp } from '../src/app.js';
import { extractHtmlText, fetchUrlText, clearFetchCache, type WebFetchToolResult } from '../src/agent/webTools.js';
import { getSearchSettings, setSearchProvider, setSearchCredential, clearSearchCredential, searchWebForUser } from '../src/agent/searchSettings.js';
import { requiresApproval } from '../src/agent/approvalPolicy.js';
import { TOOL_SPECS } from '../src/agent/toolExec.js';
import { ApiError } from '../contracts/errors.js';
import { Db } from '../src/storage/db.js';
import { migrate, defaultMigrationsDir } from '../src/storage/migrate.js';

/** 块A（联网工具）：抓取文本提取/URL校验/缓存、搜索设置持久化与内存Key、审批归类。真实出网请求不在此测。 */

test('webTools: extractHtmlText 去脚本、块级换行、解实体', () => {
    const { title, text } = extractHtmlText('<html><head><title>示例 &amp; 测试</title><style>.x{}</style></head><body><script>alert(1)</script><h1>标题一</h1><p>第一段 &lt;标签&gt;。</p><p>第二段</p></body></html>');
    assert.equal(title, '示例 & 测试');
    assert.ok(text.includes('标题一'));
    assert.ok(text.includes('第一段 <标签>。'));
    assert.ok(!text.includes('alert'));
    assert.ok(!text.includes('.x{}'));
    assert.ok(!text.includes('<p>'));
    assert.ok(!text.includes('<h1>'));
});

test('webTools: extractHtmlText 数字实体', () => {
    const { text } = extractHtmlText('<p>Copyright &#169; 2026</p>');
    assert.ok(text.includes('Copyright © 2026'));
});

test('webTools: fetchUrlText 拒绝非https与内网地址', async () => {
    await assert.rejects(() => fetchUrlText('http://example.com/x'), /https/);
    await assert.rejects(() => fetchUrlText('https://127.0.0.1/x'), /不受允许|受限/);
    await assert.rejects(() => fetchUrlText('https://user:pass@example.com/x'), /账号/);
    await assert.rejects(() => fetchUrlText('https://10.0.0.5/x'), /不受允许|受限/);
    await assert.rejects(() => fetchUrlText('not a url'), /URL 无效/);
});

test('webTools: fetchUrlText 未命中时拒绝而非冒充成功', async () => {
    clearFetchCache();
    void ({} as WebFetchToolResult);
    // 本机守卫下不可达地址必须显式失败（Fake-IP环境为DNS失败，标准环境为连接失败），不允许返回伪造正文
    await assert.rejects(() => fetchUrlText('https://prism-fetch-nonexistent.invalid/x'), /无法连接|域名解析|URL 无效|DNS解析失败|公网DNS未返回安全地址/);
});

test('approval: web_fetch/web_search 归为只读，任何模式不询问', () => {
    for (const name of ['web_fetch', 'web_search']) {
        const spec = TOOL_SPECS.find(t => t.name === name);
        assert.ok(spec, `${name} spec 存在`);
        assert.equal(spec.effect, 'read');
        assert.equal(requiresApproval('ask', spec, {}), false);
        assert.equal(requiresApproval('auto', spec, {}), false);
        assert.equal(requiresApproval('full', spec, {}), false);
    }
});

test('searchSettings: provider与Key本机持久化、未配置明确报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-search-'));
    try {
        const db = new Db(join(dir, 'db.sqlite'));
        migrate(db, defaultMigrationsDir());
        db.tx(tx => tx.prepare("INSERT INTO users(id,username,password_hash,password_salt,password_params_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
            .run('01234567-89ab-4def-8901-234567890abc', 'searcher', 'x', 's', '{}', '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z'));
        const uid = '01234567-89ab-4def-8901-234567890abc';
        assert.equal(getSearchSettings(db, uid).provider, 'none');
        await assert.rejects(() => searchWebForUser(db, uid, 'q', 5), /未配置联网搜索/);
        setSearchProvider(db, uid, 'bocha');
        await assert.rejects(() => searchWebForUser(db, uid, 'q', 5), /API Key/);
        setSearchCredential(db,uid, 'sk-test-123');
        assert.equal(getSearchSettings(db, uid).credentialStored, true);
        clearSearchCredential(db,uid);
        assert.equal(getSearchSettings(db, uid).credentialStored, false);
        // 无效 provider 拒绝
        assert.throws(() => setSearchProvider(db, uid, 'google' as never), /搜索服务不存在/);
        // Key 白名单校验：含空白拒绝
        assert.throws(() => setSearchCredential(db,uid, 'a b'), /格式无效/);
        db.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('searchRoutes: 未登录401', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-search-routes-'));
    try {
        const fx = buildProductApp(dir, { serveWeb: false });
        const anon = await fx.app.inject({ method: 'GET', url: '/api/v1/search-settings' });
        assert.equal(anon.statusCode, 401);
        fx.app.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

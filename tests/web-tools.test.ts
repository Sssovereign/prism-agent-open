import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildProductApp } from '../src/app.js';
import { extractHtmlText, fetchUrlText, clearFetchCache, normalizeQuoteText, type WebFetchToolResult } from '../src/agent/webTools.js';
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

test('webTools: extractHtmlText 剥除中文句内标签折行空格，保留拉丁词间空格', () => {
    // 内联标签折叠成空格会在中文句内留下"回购或 增持计划"式空格——模型逐字引文时归一化导致校验误拒
    const { text } = extractHtmlText('<p>盘后披露超2亿元<a>回购</a>或<em>增持计划</em>公告，<a>光模块</a>表现较弱。iPhone 15 and vivo X200 上市。</p>');
    assert.ok(text.includes('盘后披露超2亿元回购或增持计划公告，光模块表现较弱。'));
    assert.ok(text.includes('iPhone 15 and vivo X200 上市。'));
});

test('webTools: normalizeQuoteText 分隔标点等价（2026-11-23实机：资料"，"被复述为"、"）', () => {
    const source = '创业板指周下跌3.8%，上证50逆势周上涨0.4%。市场下挫，银行等防御性板块上涨。';
    const retold = '创业板指周下跌3.8%、上证50逆势周上涨0.4%。市场下挫、银行等防御性板块上涨。';
    assert.equal(normalizeQuoteText(source).includes(normalizeQuoteText(retold)), true, '顿号↔逗号必须等价');
    // 半角/全角分号冒号同属分隔等价类
    assert.equal(normalizeQuoteText('融资余额：22466亿元；降幅25%').includes(normalizeQuoteText('融资余额: 22466亿元; 降幅25%')), true);
    // 拉丁词间空格与实质换词仍拒绝
    assert.equal(normalizeQuoteText('iPhone 15 Pro上市').includes(normalizeQuoteText('iPhone 15Pro上市')), false);
    assert.equal(normalizeQuoteText('银行等防御性板块上涨').includes(normalizeQuoteText('银行等防御板块上涨')), false);
    // 终止标点不等价：句号↔问号是语气变化
    assert.equal(normalizeQuoteText('本周会企稳吗。').includes(normalizeQuoteText('本周会企稳吗？')), false);
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

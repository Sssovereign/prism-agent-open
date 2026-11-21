'use strict';
// 出网守卫纯函数测试（node:test；无 Electron 依赖——守卫刻意自含为纯逻辑+可注入解析器）
const test = require('node:test');
const assert = require('node:assert/strict');
const { protocolVerdict, publicAddress, isFakeIp, hostVerdict, clearVerdictCache, buildRequestGuard } = require('./browser-guard.cjs');

test('协议判定：主框架仅 http/https，子资源放行 data:/blob:', () => {
    assert.deepEqual(protocolVerdict('https://example.com/', 'mainFrame'), { cancel: false });
    assert.deepEqual(protocolVerdict('http://example.com/', 'mainFrame'), { cancel: false });
    assert.equal(protocolVerdict('file:///etc/passwd', 'mainFrame').cancel, true);
    assert.equal(protocolVerdict('javascript:void(0)', 'mainFrame').cancel, true);
    assert.equal(protocolVerdict('ws://example.com/', 'mainFrame').cancel, true);
    assert.equal(protocolVerdict('data:image/png;base64,AAAA', 'mainFrame').cancel, true, '主框架不允许 data:');
    assert.equal(protocolVerdict('data:image/png;base64,AAAA', 'image').cancel, false, '子资源允许 data: 图片');
    assert.equal(protocolVerdict('blob:https://example.com/x', 'script').cancel, false);
    assert.equal(protocolVerdict('file:///tmp/x', 'image').cancel, true, '子资源仍拒 file:');
    assert.equal(protocolVerdict('::::', 'mainFrame').cancel, true, '畸形URL拒绝');
});

test('地址判定与 network.ts 纪律一致：私网/Fake-IP 拒、公网放行', () => {
    for (const bad of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.0.1', '169.254.1.1', '198.18.5.5', '198.19.1.1', '100.64.0.1', '0.1.2.3', '224.0.0.1'])
        assert.equal(publicAddress(bad), false, `${bad} 应为受限地址`);
    for (const good of ['8.8.8.8', '1.1.1.1', '223.5.5.5', '2606:4700:4700::1111'])
        assert.equal(publicAddress(good), true, `${good} 应为公网地址`);
    assert.equal(publicAddress('2001:db8::1'), false, '文档保留段拒绝');
    assert.equal(publicAddress('fe80::1'), false);
    assert.equal(isFakeIp('198.18.0.1'), true);
    assert.equal(isFakeIp('198.19.255.1'), true);
    assert.equal(isFakeIp('198.20.0.1'), false);
});

test('hostVerdict：Fake-IP 全命中时经 DoH 复核，复核结论决定放行', async () => {
    clearVerdictCache();
    const fakeLookup = async () => [{ address: '198.18.3.7', family: 4 }];
    const allow = await hostVerdict('example.com', { lookupFn: fakeLookup, dohFn: async () => [{ address: '93.184.216.34', family: 4 }] });
    assert.deepEqual(allow, { cancel: false });
    const deny = await hostVerdict('evil.example.com', { lookupFn: fakeLookup, dohFn: async () => [{ address: '192.168.1.9', family: 4 }] });
    assert.deepEqual(deny, { cancel: true, reason: 'RESTRICTED_ADDRESS' });
    const dohFail = await hostVerdict('down.example.com', { lookupFn: fakeLookup, dohFn: async () => { throw new Error('DNS_TIMEOUT'); } });
    assert.equal(dohFail.cancel, true, 'DoH 复核失败按拒绝（策略不放松）');
});

test('hostVerdict：直连解析命中私网即拒；结果带缓存', async () => {
    clearVerdictCache();
    let calls = 0;
    const lookupFn = async () => { calls++; return [{ address: '10.0.0.7', family: 4 }]; };
    const first = await hostVerdict('internal.example.com', { lookupFn, dohFn: async () => { throw new Error('不应调用DoH'); } });
    assert.equal(first.cancel, true);
    const second = await hostVerdict('internal.example.com', { lookupFn, dohFn: async () => { throw new Error('不应调用DoH'); } });
    assert.equal(second.cancel, true);
    assert.equal(calls, 1, '命中缓存不再解析');
    clearVerdictCache();
});

test('hostVerdict：解析失败/空结果拒绝', async () => {
    clearVerdictCache();
    const fail = await hostVerdict('nx.example.com', { lookupFn: async () => { throw new Error('ENOTFOUND'); }, dohFn: async () => { throw new Error('DNS'); } });
    assert.equal(fail.cancel, true);
    const empty = await hostVerdict('empty.example.com', { lookupFn: async () => [], dohFn: async () => [] });
    assert.equal(empty.cancel, true);
});

test('buildRequestGuard：协议拒绝同步 cancel，主机判定异步 cancel', async () => {
    clearVerdictCache();
    const logs = [];
    const guard = buildRequestGuard({ onLog: m => logs.push(m) });
    const file = await new Promise(resolve => guard({ url: 'file:///etc/passwd', resourceType: 'mainFrame' }, resolve));
    assert.deepEqual(file, { cancel: true });
    const verdict = await new Promise(resolve => guard(
        { url: 'http://192.168.1.5/admin', resourceType: 'mainFrame' },
        resolve,
    ));
    assert.deepEqual(verdict, { cancel: true });
    assert.ok(logs.some(m => m.includes('RESTRICTED_ADDRESS') || m.includes('PROTOCOL_')), '拒绝应落日志');
});

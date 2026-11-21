import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {ChildProcess} from 'node:child_process';
import {assertNavigableUrl, assertPanelRect, connectDesktopBrowserHost, executeBrowserTool, type DesktopBrowserHost} from '../src/agent/desktopBrowser.js';
import {requiresApproval} from '../src/agent/approvalPolicy.js';
import {TOOL_SPECS, toolSpec} from '../src/agent/toolExec.js';

function fakeChild(): ChildProcess & { send: (message: unknown) => void; lastMessage: Record<string, unknown> | null } {
    const child = new EventEmitter() as unknown as ChildProcess & { send: (message: unknown) => void; lastMessage: Record<string, unknown> | null };
    Object.defineProperty(child, 'connected', { value: true });
    child.lastMessage = null;
    (child as unknown as { send: (message: unknown) => void }).send = (message: unknown) => { child.lastMessage = message as Record<string, unknown>; };
    return child;
}

test('browser 工具清单：六个工具、effect=browser、highImpact 语义正确', () => {
    const names = TOOL_SPECS.filter(s => s.name.startsWith('browser_')).map(s => s.name);
    assert.deepEqual(names, ['browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_fill', 'browser_back']);
    for (const name of names) {
        const spec = toolSpec(name)!;
        assert.equal(spec.effect, 'browser');
    }
    assert.equal(toolSpec('browser_click')!.highImpact({}), true);
    assert.equal(toolSpec('browser_fill')!.highImpact({}), true);
    assert.equal(toolSpec('browser_navigate')!.highImpact({}), false);
    assert.equal(toolSpec('browser_snapshot')!.highImpact({}), false);
});

test('browser 审批语义：auto/full 不询问，ask 仅点击/填写询问', () => {
    const mode = (name: string, m: 'ask' | 'auto' | 'full') => requiresApproval(m, toolSpec(name)!, {});
    for (const name of ['browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_back']) {
        assert.equal(mode(name, 'ask'), false, `${name} 在 ask 模式不应询问`);
        assert.equal(mode(name, 'auto'), false);
        assert.equal(mode(name, 'full'), false);
    }
    for (const name of ['browser_click', 'browser_fill']) {
        assert.equal(mode(name, 'ask'), true, `${name} 在 ask 模式应询问`);
        assert.equal(mode(name, 'auto'), false);
        assert.equal(mode(name, 'full'), false);
    }
});

test('assertNavigableUrl：协议/账号信息/本机主机名/私网IP/长度校验', () => {
    assert.equal(assertNavigableUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
    assert.equal(assertNavigableUrl('http://example.com'), 'http://example.com/');
    assert.equal(assertNavigableUrl('https://8.8.8.8/dns-query'), 'https://8.8.8.8/dns-query');
    assert.throws(() => assertNavigableUrl('ftp://example.com'), /仅支持 http\/https/);
    assert.throws(() => assertNavigableUrl('file:///etc/passwd'), /仅支持 http\/https/);
    assert.throws(() => assertNavigableUrl('javascript:alert(1)'), /仅支持 http\/https/);
    assert.throws(() => assertNavigableUrl('https://user:pass@example.com/'), /账号或密码/);
    assert.throws(() => assertNavigableUrl('https://localhost/x'), /本机或内网主机名/);
    assert.throws(() => assertNavigableUrl('https://a.local/x'), /本机或内网主机名/);
    assert.throws(() => assertNavigableUrl('http://127.0.0.1:8080/'), /私有或保留IP/);
    assert.throws(() => assertNavigableUrl('http://192.168.1.1/'), /私有或保留IP/);
    assert.throws(() => assertNavigableUrl('http://169.254.1.1/'), /私有或保留IP/);
    assert.throws(() => assertNavigableUrl(`https://example.com/${'a'.repeat(2100)}`), /2048/);
    assert.throws(() => assertNavigableUrl(''), /不能为空/);
    assert.throws(() => assertNavigableUrl('not a url'), /无效的URL/);
});

test('executeBrowserTool：宿主不可用与参数校验在分发前失败', async () => {
    const unavailable: DesktopBrowserHost = { available: false, execute: async () => { throw new Error('不应执行'); }, panel: async () => ({ visible: false }), state: async () => ({ visible: false }), close() {} };
    await assert.rejects(() => executeBrowserTool(unavailable, 'browser_navigate', { url: 'https://example.com' }), /BROWSER_UNAVAILABLE|桌面版/);
    await assert.rejects(() => executeBrowserTool(unavailable, 'browser_click', {}), /BROWSER_UNAVAILABLE|桌面版/);
    const host: DesktopBrowserHost = {
        available: true,
        execute: async (method, args) => ({ method, args }),
        panel: async () => ({ visible: false }),
        state: async () => ({ visible: false }),
        close() {},
    };
    await assert.rejects(() => executeBrowserTool(host, 'browser_click', {}), /ref、selector 或 text/);
    await assert.rejects(() => executeBrowserTool(host, 'browser_fill', { selector: '#q', value: '' }), /不能为空/);
    await assert.rejects(() => executeBrowserTool(host, 'browser_navigate', { url: 'http://10.0.0.1/' }), /私有或保留IP/);
    const clicked = await executeBrowserTool(host, 'browser_click', { ref: 3 }) as { method: string; args: Record<string, unknown> };
    assert.equal(clicked.method, 'click');
    assert.deepEqual(clicked.args, { ref: 3 });
    const filled = await executeBrowserTool(host, 'browser_fill', { selector: '#q', value: '贵州茅台', submit: true }) as { args: Record<string, unknown> };
    assert.deepEqual(filled.args, { selector: '#q', value: '贵州茅台', submit: true });
});

test('desktopBrowser 客户端：能力公告→execute 往返→错误回传→exit 拒发', async () => {
    const child = fakeChild();
    const host = connectDesktopBrowserHost(child);
    assert.equal(host.available, false);
    // 主进程 attach 时的主动公告
    child.emit('message', { type: 'browser:capability', version: 1 });
    assert.equal(host.available, true);
    const pending = host.execute('snapshot', {}, 1000);
    assert.equal(child.lastMessage?.type, 'browser:execute');
    const requestId = (child.lastMessage as { requestId: string }).requestId;
    child.emit('message', { type: 'browser:execute-result', requestId, ok: true, result: { url: 'https://example.com', title: 'Example' } });
    assert.deepEqual(await pending, { url: 'https://example.com', title: 'Example' });
    // 重复 requestId 结果只消费一次
    const second = host.execute('back', {}, 1000);
    const secondId = (child.lastMessage as { requestId: string }).requestId;
    child.emit('message', { type: 'browser:execute-result', requestId: secondId, ok: false, error: { code: 'BROWSER_FAILED', message: '没有可后退的历史' } });
    child.emit('message', { type: 'browser:execute-result', requestId: secondId, ok: true, result: { replay: true } });
    await assert.rejects(() => second, /没有可后退的历史/);
    // exit 后 execute 明确失败
    child.emit('exit', 1);
    await assert.rejects(() => host.execute('snapshot', {}, 1000), /已断开/);
});

test('desktopBrowser 启动：错过主动公告时发送 hello，无回复时保留不可用状态', async () => {
    const child = fakeChild();
    const host = connectDesktopBrowserHost(child);
    const ready = host.probe();
    assert.equal(child.lastMessage?.type, 'browser:hello');
    child.emit('message', { type: 'browser:capability', version: 1, requestId: child.lastMessage?.requestId });
    assert.equal(await ready, true);
    assert.equal(host.available, true);
    child.emit('disconnect');
    assert.equal(host.available, false);
    const unsupported = connectDesktopBrowserHost(fakeChild());
    assert.equal(await unsupported.probe(25), false);
    assert.equal(unsupported.available, false);
    unsupported.close();
});

test('desktopBrowser 客户端：命令超时明确报错', async () => {
    const child = fakeChild();
    const host = connectDesktopBrowserHost(child);
    child.emit('message', { type: 'browser:capability', version: 1 });
    const pending = host.execute('snapshot', {}, 30);
    await assert.rejects(() => pending, /超时/);
});

test('assertPanelRect：数值/范围校验与归一化', () => {
    assert.deepEqual(assertPanelRect({ x: 10.4, y: 20.6, width: 900.2, height: 600 }), { x: 10, y: 21, width: 900, height: 600 });
    assert.throws(() => assertPanelRect({ x: 'a', y: 0, width: 500, height: 500 }), /数值字段/);
    assert.throws(() => assertPanelRect({ x: -1, y: 0, width: 500, height: 500 }), /越界/);
    assert.throws(() => assertPanelRect({ x: 0, y: 0, width: 100, height: 500 }), /200–8000/);
    assert.throws(() => assertPanelRect({ x: 0, y: 0, width: 9000, height: 500 }), /200–8000/);
    assert.throws(() => assertPanelRect(undefined), /数值字段/);
});

test('desktopBrowser 客户端：panel/state 往返与矩形校验', async () => {
    const child = fakeChild();
    const host = connectDesktopBrowserHost(child);
    child.emit('message', { type: 'browser:capability', version: 1 });
    await assert.rejects(() => host.panel({ visible: true }), /数值字段/); // 客户端侧先校验矩形
    const pending = host.panel({ visible: true, rect: { x: 100, y: 50, width: 800, height: 600 } });
    assert.equal(child.lastMessage?.type, 'browser:panel');
    const requestId = (child.lastMessage as { requestId: string }).requestId;
    child.emit('message', { type: 'browser:panel-result', requestId, ok: true, result: { visible: true, url: 'https://example.com/', title: 'Example Domain' } });
    assert.deepEqual(await pending, { visible: true, url: 'https://example.com/', title: 'Example Domain' });
    const statePending = host.state();
    assert.equal(child.lastMessage?.type, 'browser:state');
    const stateId = (child.lastMessage as { requestId: string }).requestId;
    child.emit('message', { type: 'browser:state-result', requestId: stateId, ok: true, result: { open: true, visible: false, url: 'https://example.com/' } });
    assert.deepEqual(await statePending, { open: true, visible: false, url: 'https://example.com/' });
    const hiding = host.panel({ visible: false });
    assert.equal(child.lastMessage?.type, 'browser:panel');
    assert.deepEqual((child.lastMessage as Record<string, unknown>).visible, false);
    const hideId = (child.lastMessage as { requestId: string }).requestId;
    child.emit('message', { type: 'browser:panel-result', requestId: hideId, ok: true, result: { visible: false } });
    assert.deepEqual(await hiding, { visible: false });
});

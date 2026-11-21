'use strict';
// 内嵌无头浏览器宿主（R1）：隐藏 BrowserWindow 承载页面，backend 经 browser:* IPC 驱动。
// 与目录选择器同一私有通道模式（不进 ipcMain），attach 时主动公告能力消除启动竞态。
// 边界：独立分区 session（无 Cookie 持久化、不注入桌面令牌）、权限/下载/popup 全拒、
// 出网守卫经 browser-guard.cjs。无 <webview>、不触碰主窗口的 will-attach-webview 加固。
// 面板版（后续 R）复用同一命令面：渲染端 <webview> guest 就位后按同一 dispatcher 切换执行目标。

const { BrowserWindow, session } = require('electron');
const { randomUUID } = require('node:crypto');
const { buildRequestGuard } = require('./browser-guard.cjs');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PARTITION = 'prism-agent-browser';
const VIEW_WIDTH = 1280;
const VIEW_HEIGHT = 800;
const SNAPSHOT_TEXT_LIMIT = 12_000;
const SNAPSHOT_ELEMENT_LIMITS = { links: 60, inputs: 40, buttons: 30 };
const COMMANDS = new Set(['navigate', 'back', 'snapshot', 'screenshot', 'click', 'fill']);

// 页面内 JS 对话框（alert/confirm/prompt）会阻塞隐藏窗口的执行管线：dom-ready 后在页面世界覆写为无操作。
const DIALOG_OVERRIDE_SCRIPT = 'window.alert=()=>{};window.confirm=()=>false;window.prompt=()=>null;';
// 快照脚本：正文文本 + 可交互元素清单（ref 编号与主进程侧 ref 表对应），供模型定位点击/填写目标。
const SNAPSHOT_SCRIPT = `(() => {
  const visible = el => {
    if (!(el instanceof Element)) return false;
    const rects = el.getClientRects();
    if (!rects.length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const cssPath = el => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (typeof node.id === 'string' && node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let seg = node.localName;
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter(c => c.localName === node.localName);
        if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(seg);
      node = parent;
    }
    if (node === document.documentElement) parts.unshift('html');
    return parts.join('>');
  };
  const elements = [];
  let ref = 0;
  const push = (el, kind, extra) => {
    ref += 1;
    const item = { ref, kind, path: cssPath(el), text: (el.innerText || el.value || '').trim().slice(0, 120), ...extra };
    elements.push(item);
  };
  const seenHref = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    if (elements.length >= ${SNAPSHOT_ELEMENT_LIMITS.links} ) break;
    if (!visible(a)) continue;
    const href = a.href;
    if (!href || href.startsWith('javascript:') || seenHref.has(href)) continue;
    seenHref.add(href);
    push(a, 'link', { href: href.slice(0, 500) });
  }
  for (const el of document.querySelectorAll('input, textarea, select')) {
    if (elements.length >= ${SNAPSHOT_ELEMENT_LIMITS.links + SNAPSHOT_ELEMENT_LIMITS.inputs}) break;
    if (!visible(el)) continue;
    const type = el instanceof HTMLSelectElement ? 'select' : (el.getAttribute('type') || (el instanceof HTMLTextAreaElement ? 'textarea' : 'text')).toLowerCase();
    const label = el.labels && el.labels[0] ? el.labels[0].innerText.trim().slice(0, 80) : (el.getAttribute('aria-label') || el.getAttribute('name') || '');
    push(el, 'input', { inputType: type, placeholder: (el.getAttribute('placeholder') || '').slice(0, 80), label, valueLength: (el.value || '').length });
  }
  for (const el of document.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')) {
    if (elements.length >= ${SNAPSHOT_ELEMENT_LIMITS.links + SNAPSHOT_ELEMENT_LIMITS.inputs + SNAPSHOT_ELEMENT_LIMITS.buttons}) break;
    if (!visible(el)) continue;
    push(el, 'button', {});
  }
  const text = (document.body ? document.body.innerText : '').slice(0, ${SNAPSHOT_TEXT_LIMIT});
  return { url: location.href, title: document.title, readyState: document.readyState, text, elements, truncated: (document.body ? document.body.innerText.length : 0) > ${SNAPSHOT_TEXT_LIMIT} };
})()`;

const CLICK_TEXT_SCRIPT = text => `(() => {
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const wanted = ${JSON.stringify(String(text))};
  const candidates = [...document.querySelectorAll('a, button, [role=button], input[type=submit], input[type=button], summary, label[for]')];
  const target = candidates.find(el => visible(el) && ((el.innerText || el.value || '').trim().includes(wanted) || (el.getAttribute('aria-label') || '').trim().includes(wanted)));
  if (!target) return { found: false };
  target.scrollIntoView({ block: 'center' });
  target.click();
  return { found: true, url: location.href };
})()`;

/** 元素操作（点击/填写）：path 定位 + 页面内执行；失败统一报“请重新快照”。 */
const ELEMENT_ACTION_SCRIPT = `((action) => {
  const el = document.querySelector(action.path);
  if (!(el instanceof Element)) return { found: false };
  if (action.op === 'click') {
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { found: true, url: location.href };
  }
  if (el instanceof HTMLSelectElement) {
    const wanted = action.value;
    const match = [...el.options].find(o => o.value === wanted || o.text === wanted);
    if (!match) return { found: false };
    el.value = match.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { found: true, url: location.href };
  }
  const setter = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
  setter ? setter.call(el, action.value) : (el.value = action.value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (action.submit) {
    const form = el.closest('form');
    if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    else {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    }
  }
  return { found: true, url: location.href };
})`;

class BrowserHost {
    constructor(onLog, getParent) {
        this.onLog = onLog;
        this.getParent = getParent;
        this.win = null;
        this.unwatchParent = null;
        this.refs = new Map();      // ref → css path（快照时建立，导航后失效）
        this.guard = buildRequestGuard({ onLog });
        this.sessionWired = false;
    }

    ensureWindow() {
        if (this.win && !this.win.isDestroyed()) return this.win.webContents;
        const win = new BrowserWindow({
            width: VIEW_WIDTH, height: VIEW_HEIGHT, show: false, title: '棱镜内嵌浏览器',
            // 无边框：隐藏承载与面板化（R2，setParentWindow 贴抽屉矩形）同一窗口，面板态即嵌入式观感
            frame: false,
            webPreferences: {
                nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
                backgroundThrottling: false, partition: PARTITION,
            },
        });
        win.on('closed', () => {
            if (this.win === win) {
                this.unwatchParent?.();
                this.unwatchParent = null;
                this.win = null;
            }
            this.refs.clear();
        });
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.webContents.setAudioMuted(true);
        win.webContents.on('dom-ready', () => { win.webContents.executeJavaScript(DIALOG_OVERRIDE_SCRIPT, true).catch(() => { /* 预置失败不放大 */ }); });
        if (!this.sessionWired) {
            this.sessionWired = true;
            const browserSession = session.fromPartition(PARTITION);
            browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
            browserSession.setPermissionCheckHandler(() => false);
            browserSession.on('will-download', event => event.preventDefault());
            browserSession.webRequest.onBeforeRequest(this.guard);
        }
        this.win = win;
        this.refs.clear();
        return win.webContents;
    }

    page(wc) { return { url: wc.getURL(), title: wc.getTitle() }; }

    /** 等页面就绪：executeJavaScript 在导航 commit 窗口可能永久挂起（R90 真机冒烟实测），
     *  deadline 用独立定时器兜底——首轮求值挂起时不依赖轮询链自身的超时检查。 */
    waitForSettled(wc, timeoutMs) {
        return new Promise(resolve => {
            const timer = setTimeout(() => { settled = true; resolve(); }, timeoutMs);
            timer.unref();
            let settled = false;
            const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
            const poll = () => {
                if (wc.isDestroyed()) return done();
                wc.executeJavaScript('document.readyState', true).then(state => {
                    if (state === 'complete' || state === 'interactive') return done();
                    setTimeout(poll, 250);
                }, () => done());
            };
            poll();
        });
    }

    async navigate({ url }) {
        const wc = this.ensureWindow();
        let target;
        try { target = new URL(String(url ?? '')); }
        catch { const e = new Error('无效的URL'); e.code = 'VALIDATION_FAILED'; throw e; }
        if (target.protocol !== 'https:' && target.protocol !== 'http:') { const e = new Error('浏览器仅支持 http/https 地址'); e.code = 'VALIDATION_FAILED'; throw e; }
        this.refs.clear();
        await Promise.race([
            wc.loadURL(target.href).catch(error => { if (!`${error?.message ?? ''}`.includes('ERR_ABORTED')) throw error; }),
            new Promise((_, reject) => { const t = setTimeout(() => reject(Object.assign(new Error('页面加载超时（20秒）'), { code: 'BROWSER_TIMEOUT' })), 20_000); t.unref(); }),
        ]);
        await this.waitForSettled(wc, 5000);
        return this.page(wc);
    }

    async back() {
        const wc = this.ensureWindow();
        if (!wc.navigationHistory.canGoBack()) { const e = new Error('没有可后退的历史'); e.code = 'VALIDATION_FAILED'; throw e; }
        this.refs.clear();
        const done = new Promise(resolve => wc.once('did-stop-loading', resolve));
        wc.goBack();
        await Promise.race([done, new Promise(resolve => { const t = setTimeout(resolve, 8000); t.unref(); })]);
        await this.waitForSettled(wc, 5000);
        return this.page(wc);
    }

    async snapshot() {
        const wc = this.ensureWindow();
        await this.waitForSettled(wc, 5000);
        const data = await wc.executeJavaScript(SNAPSHOT_SCRIPT, true);
        this.refs.clear();
        for (const element of data.elements) this.refs.set(element.ref, element);
        return { url: data.url, title: data.title, text: data.text, truncatedText: data.truncated, elements: data.elements.map(({ path, ...rest }) => rest) };
    }

    async screenshot() {
        const wc = this.ensureWindow();
        await this.waitForSettled(wc, 3000);
        const image = await wc.capturePage();
        if (image.isEmpty()) { const e = new Error('截图为空：页面尚未渲染完成，请稍后重试'); e.code = 'BROWSER_FAILED'; throw e; }
        const size = image.getSize();
        return { imageData: image.toPNG().toString('base64'), mime: 'image/png', width: size.width, height: size.height };
    }

    /** 元素操作脚本执行：点击/提交会立刻触发导航并挂起 executeJavaScript 的返回（R90 真机冒烟实测），
     *  主框架导航事件先行时提前兑现为 found=true——无头窗口内除本次操作外没有其他导航来源，归因安全。 */
    runActionScript(wc, expression) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = outcome => {
                if (settled) return;
                settled = true;
                wc.removeListener('did-start-navigation', onNav);
                resolve(outcome);
            };
            const onNav = (_event, _url, _isInPlace, isMainFrame) => {
                if (isMainFrame) finish({ found: true, url: wc.getURL() });
            };
            wc.on('did-start-navigation', onNav);
            wc.executeJavaScript(expression, true).then(finish, error => {
                if (settled) return;
                settled = true;
                wc.removeListener('did-start-navigation', onNav);
                reject(error);
            });
        });
    }

    async click(args) {
        const wc = this.ensureWindow();
        let outcome;
        if (args.text !== undefined && args.ref === undefined && args.selector === undefined) {
            outcome = await this.runActionScript(wc, CLICK_TEXT_SCRIPT(args.text));
        } else {
            const path = this.pathOf(args);
            outcome = await this.runActionScript(wc, `${ELEMENT_ACTION_SCRIPT}(${JSON.stringify({ op: 'click', path })})`);
        }
        if (!outcome?.found) { const e = new Error('目标元素不存在或已变化，请重新 browser_snapshot'); e.code = 'VALIDATION_FAILED'; throw e; }
        await this.waitForSettled(wc, 3000);
        return { ok: true, ...this.page(wc) };
    }

    async fill(args) {
        const wc = this.ensureWindow();
        const path = this.pathOf(args);
        const outcome = await this.runActionScript(wc, `${ELEMENT_ACTION_SCRIPT}(${JSON.stringify({ op: 'fill', path, value: String(args.value ?? ''), submit: args.submit === true })})`);
        if (!outcome?.found) { const e = new Error('目标输入框不存在或已变化，请重新 browser_snapshot'); e.code = 'VALIDATION_FAILED'; throw e; }
        await this.waitForSettled(wc, args.submit === true ? 5000 : 1000);
        return { ok: true, ...this.page(wc) };
    }

    pathOf(args) {
        const fromRef = args.ref !== undefined ? this.refs.get(Number(args.ref)) : undefined;
        const path = fromRef?.path ?? (typeof args.selector === 'string' && args.selector ? args.selector : '');
        if (!path || path.length > 500) { const e = new Error('元素定位无效：请先 browser_snapshot 获取 ref'); e.code = 'VALIDATION_FAILED'; throw e; }
        return path;
    }

    async execute(method, args) {
        if (!COMMANDS.has(method)) { const e = new Error('未知浏览器命令'); e.code = 'VALIDATION_FAILED'; throw e; }
        if (method === 'navigate') return await this.navigate(args);
        if (method === 'back') return await this.back();
        if (method === 'snapshot') return await this.snapshot();
        if (method === 'screenshot') return await this.screenshot();
        if (method === 'click') return await this.click(args);
        return await this.fill(args);
    }

    /** 面板化：把抽屉的视口矩形换算为桌面坐标（DIP），showInactive 不抢焦点。
     *  命令面/会话/守卫不变——面板只是同一承载的可见形态。 */
    panelShow({ x, y, width, height }) {
        const wc = this.ensureWindow();
        const win = this.win;
        const parent = this.getParent?.();
        this.unwatchParent?.();
        this.unwatchParent = null;
        const attached = parent && !parent.isDestroyed();
        if (attached && win.getParentWindow() !== parent) win.setParentWindow(parent);
        const place = () => {
            if (win.isDestroyed() || (attached && parent.isDestroyed())) return;
            const origin = attached ? parent.getContentBounds() : { x: 0, y: 0 };
            const zoom = attached ? parent.webContents.getZoomFactor() : 1;
            win.setBounds({
                x: origin.x + Math.max(0, Math.round((Number(x) || 0) * zoom)),
                y: origin.y + Math.max(0, Math.round((Number(y) || 0) * zoom)),
                width: Math.min(8000, Math.max(200, Math.round((Number(width) || 0) * zoom))),
                height: Math.min(8000, Math.max(200, Math.round((Number(height) || 0) * zoom))),
            });
        };
        // 先可见再贴界：隐藏窗口先 setBounds 后显示会被 macOS 级联放置改写 origin（R2 冒烟实测）
        if (!win.isVisible()) win.showInactive();
        place();
        if (attached) {
            // Windows 上子窗口不会随父窗口自动移动，窗口变动时重新贴合。
            parent.on('move', place);
            parent.on('resize', place);
            this.unwatchParent = () => {
                parent.removeListener('move', place);
                parent.removeListener('resize', place);
            };
        }
        return { visible: true, ...this.page(wc) };
    }

    panelHide() {
        this.unwatchParent?.();
        this.unwatchParent = null;
        if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
        return { visible: false };
    }

    state() {
        if (!this.win || this.win.isDestroyed()) return { open: false, visible: false };
        return { open: true, visible: this.win.isVisible(), ...this.page(this.win.webContents) };
    }

    destroy() {
        this.panelHide();
        this.refs.clear();
        if (this.win && !this.win.isDestroyed()) this.win.destroy();
        this.win = null;
    }
}

const METHOD_TIMEOUTS = { navigate: 25_000, back: 15_000, snapshot: 15_000, screenshot: 15_000, click: 15_000, fill: 15_000 };

/**
 * 挂载 backend→main 浏览器通道：hello/capability 公告 + browser:execute 幂等分发。
 * allowed() 为 false（更新切换中/退出中）时命令按 BROWSER_UNAVAILABLE 快速失败。
 */
function attachBrowserHost(child, { onLog = () => {}, allowed = () => true, getParent = null } = {}) {
    let closed = false;
    let host = null;
    let denyLogged = false;
    const pending = new Map();
    const seen = new Set();
    const send = message => { if (!closed && child.connected) { try { child.send(message, () => {}); } catch { /* 已断开 */ } } };
    const reply = (requestId, body, resultType = 'browser:execute-result') => { const entry = pending.get(requestId); if (entry) { clearTimeout(entry.timer); pending.delete(requestId); } send({ type: resultType, requestId, ...body }); };
    // 面板/状态是 UI 通道（渲染端→backend→main），同步完成、独立于模型命令面
    const panelOp = (message, resultType) => {
        if (!allowed()) return send({ type: resultType, requestId: message.requestId, ok: false, error: { code: 'BROWSER_UNAVAILABLE', message: '浏览器宿主当前不可用，请稍后重试' } });
        try {
            host ??= new BrowserHost(onLog, getParent);
            const result = message.visible === false ? host.panelHide()
                : message.state === true ? host.state()
                : host.panelShow(message.rect ?? {});
            send({ type: resultType, requestId: message.requestId, ok: true, result });
        } catch (error) {
            send({ type: resultType, requestId: message.requestId, ok: false, error: { code: error?.code ?? 'BROWSER_FAILED', message: String(error?.message ?? error).slice(0, 300) } });
        }
    };
    const onMessage = message => {
        if (closed) return;
        if (message?.type === 'browser:hello') {
            send({ type: 'browser:capability', ...(UUID_RE.test(String(message.requestId ?? '')) ? { requestId: message.requestId } : {}), version: 1 });
            return;
        }
        if (message?.type === 'browser:panel') {
            const requestId = String(message.requestId ?? '');
            if (!UUID_RE.test(requestId) || seen.has(requestId)) return;
            if (seen.size > 10000) seen.clear();
            seen.add(requestId);
            return panelOp({ ...message, requestId }, 'browser:panel-result');
        }
        if (message?.type === 'browser:state') {
            const requestId = String(message.requestId ?? '');
            if (!UUID_RE.test(requestId)) return;
            return panelOp({ ...message, requestId, state: true }, 'browser:state-result');
        }
        if (message?.type !== 'browser:execute') return;
        const requestId = String(message.requestId ?? '');
        if (!UUID_RE.test(requestId)) return;
        if (seen.has(requestId)) return;
        if (seen.size > 10000) seen.clear();
        seen.add(requestId);
        if (!allowed()) {
            if (!denyLogged) { denyLogged = true; onLog('[browser-host] 宿主当前不可用（更新/退出流程），浏览器命令拒绝'); }
            reply(requestId, { ok: false, error: { code: 'BROWSER_UNAVAILABLE', message: '浏览器宿主当前不可用，请稍后重试' } });
            return;
        }
        const method = String(message.method ?? '');
        if (!COMMANDS.has(method)) return reply(requestId, { ok: false, error: { code: 'VALIDATION_FAILED', message: '未知浏览器命令' } });
        host ??= new BrowserHost(onLog, getParent);
        const timer = setTimeout(() => reply(requestId, { ok: false, error: { code: 'BROWSER_TIMEOUT', message: '浏览器命令超时' } }), METHOD_TIMEOUTS[method] ?? 15_000);
        timer.unref();
        pending.set(requestId, { timer });
        host.execute(method, message.args ?? {}).then(
            result => reply(requestId, { ok: true, result }),
            error => reply(requestId, { ok: false, error: { code: error?.code ?? 'BROWSER_FAILED', message: String(error?.message ?? error).slice(0, 300) } }),
        );
    };
    const close = () => {
        if (closed) return;
        closed = true;
        for (const [requestId, entry] of pending) { clearTimeout(entry.timer); pending.delete(requestId); }
        host?.destroy();
        host = null;
        child.removeListener('message', onMessage);
        child.removeListener('exit', close);
        child.removeListener('disconnect', close);
    };
    child.on('message', onMessage);
    child.once('exit', close);
    child.once('disconnect', close);
    // 主动公告；后端晚挂载时也可用 hello 请求重发。
    send({ type: 'browser:capability', version: 1 });
    return { close };
}

function newRequestId() { return randomUUID(); }

module.exports = { attachBrowserHost, newRequestId, SNAPSHOT_SCRIPT, ELEMENT_ACTION_SCRIPT, COMMANDS };

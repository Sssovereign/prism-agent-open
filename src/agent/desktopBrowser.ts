import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { ApiError, type ErrorCode } from '../../contracts/errors.js';
import { publicAddress, resolvePinnedAddress } from '../models/network.js';

/**
 * 内嵌浏览器（R1 无头版）：桌面宿主（Electron 主进程）以隐藏窗口承载页面，
 * 监督器经 node IPC `browser:execute` 驱动。与目录选择器同一 RPC 模式：
 * 主进程 attach 时主动公告能力；后端晚监听错过公告时，主动发送 hello 探测。
 * 请求带 UUID 编号幂等去重，超时明确报错。
 * 会话边界：专用分区（无登录态/Cookie 持久化）、协议白名单、私网与 Fake-IP 守卫在宿主侧二次执行。
 */

export interface DesktopBrowserHost {
    /** 主进程公告的浏览器能力（桌面版可用；纯 Web/受控验证环境为 false） */
    readonly available: boolean;
    execute(method: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
    /** 面板化（UI 通道，R2）：把同一 guest 窗口贴到渲染端抽屉矩形 / 收回后台隐藏 */
    panel(args: { visible: boolean; rect?: PanelRect }): Promise<BrowserPanelState>;
    /** 面板与页面当前状态（面板工具栏轮询用） */
    state(): Promise<BrowserPanelState>;
    close(): void;
}

export interface PanelRect { x: number; y: number; width: number; height: number }
export interface BrowserPanelState { open?: boolean; visible: boolean; url?: string; title?: string }

interface PendingEntry {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

const RESULT_TYPES = new Set(['browser:execute-result', 'browser:panel-result', 'browser:state-result']);

/** 面板矩形校验（渲染端上报的视口相对 CSS 像素）：宿主侧再做数值兜底。 */
export function assertPanelRect(raw: unknown): PanelRect {
    const rect = (raw ?? {}) as Partial<Record<keyof PanelRect, unknown>>;
    const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN);
    const x = num(rect.x), y = num(rect.y), width = num(rect.width), height = num(rect.height);
    if ([x, y, width, height].some(Number.isNaN)) throw new ApiError('VALIDATION_FAILED', '面板矩形缺少有效的数值字段');
    if (x < 0 || y < 0 || x > 20_000 || y > 20_000) throw new ApiError('VALIDATION_FAILED', '面板矩形坐标越界');
    if (width < 200 || height < 200 || width > 8000 || height > 8000) throw new ApiError('VALIDATION_FAILED', '面板矩形尺寸超出 200–8000 像素范围');
    return { x, y, width, height };
}

export function connectDesktopBrowserHost(child: ChildProcess): DesktopBrowserHost & { probe(timeoutMs?: number): Promise<boolean> } {
    const pending = new Map<string, PendingEntry>();
    const seen = new Set<string>();
    let available = false;
    let closed = false;
    let disconnected = false;
    let sawReply = false;
    let probePending: Promise<boolean> | undefined;
    let finishProbe: ((result: boolean) => void) | undefined;
    const send = (message: Record<string, unknown>) => {
        if (closed) return;
        try { child.send(message); } catch { /* IPC已断开：execute 走超时/断开路径 */ }
    };
    child.on('message', raw => {
        if (closed) return;
        const message = raw as { type?: string; requestId?: string; version?: number } | null;
        if (!message || typeof message.type !== 'string') return;
        if (message.type === 'browser:capability') {
            available = typeof message.version === 'number' && message.version >= 1;
            if (available) finishProbe?.(true);
            return;
        }
        if (!RESULT_TYPES.has(message.type)) return;
        const requestId = typeof message.requestId === 'string' ? message.requestId : '';
        const entry = pending.get(requestId);
        if (!entry || seen.has(requestId)) return;
        seen.add(requestId);
        if (seen.size > 10000) seen.clear();
        pending.delete(requestId);
        clearTimeout(entry.timer);
        sawReply = true;
        const payload = message as { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } };
        if (payload.ok) entry.resolve(payload.result);
        else entry.reject(new ApiError((payload.error?.code ?? 'BROWSER_FAILED') as ErrorCode, payload.error?.message ?? '浏览器命令执行失败'));
    });
    const onExit = () => {
        disconnected = true;
        available = false;
        finishProbe?.(false);
        for (const [id, entry] of pending) {
            clearTimeout(entry.timer);
            entry.reject(new ApiError('BROWSER_UNAVAILABLE', '浏览器宿主已断开'));
            pending.delete(id);
        }
    };
    child.once('exit', onExit);
    child.once('disconnect', onExit);
    const request = (type: string, body: Record<string, unknown>, resultType: string, timeoutMs: number, label: string) => {
        if (closed || disconnected || !child.connected) throw new ApiError('BROWSER_UNAVAILABLE', '浏览器宿主已断开：请重启应用后重试');
        if (!available) throw new ApiError('BROWSER_UNAVAILABLE', '浏览器宿主未就绪：请重启应用后重试');
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(requestId);
                reject(new ApiError('BROWSER_TIMEOUT', `浏览器命令超时（${label}）`));
            }, timeoutMs);
            timer.unref();
            pending.set(requestId, { resolve, reject, timer });
            send({ type, requestId, ...body });
        });
    };
    return {
        get available() { return available; },
        async probe(timeoutMs = 2000) {
            if (available || closed || disconnected || !child.connected) return available;
            if (probePending) return probePending;
            probePending = new Promise(resolve => {
                const deadline = setTimeout(() => finishProbe?.(false), timeoutMs);
                finishProbe = result => { clearTimeout(deadline); finishProbe = undefined; resolve(result); };
            });
            send({ type: 'browser:hello', requestId: randomUUID() });
            try { return await probePending; }
            finally { probePending = undefined; }
        },
        async execute(method, args, timeoutMs = 8000) {
            return await request('browser:execute', { method, args }, 'browser:execute-result', timeoutMs, method);
        },
        async panel(args) {
            const rect = args.visible ? assertPanelRect(args.rect) : undefined;
            return await request('browser:panel', { visible: args.visible, ...(rect ? { rect } : {}) }, 'browser:panel-result', 5000, 'panel') as BrowserPanelState;
        },
        async state() {
            return await request('browser:state', {}, 'browser:state-result', 3000, 'state') as BrowserPanelState;
        },
        close() {
            closed = true;
            available = false;
            finishProbe?.(false);
            for (const [, entry] of pending) { clearTimeout(entry.timer); entry.reject(new ApiError('BROWSER_UNAVAILABLE', '浏览器宿主已关闭')); }
            pending.clear();
        },
    };
}

// —— 工具执行（监督器可信侧） ——

const NAVIGATE_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 8_000;

export const BROWSER_METHOD_TIMEOUTS: Record<string, number> = {
    navigate: NAVIGATE_TIMEOUT_MS,
    back: COMMAND_TIMEOUT_MS,
    snapshot: COMMAND_TIMEOUT_MS,
    screenshot: COMMAND_TIMEOUT_MS,
    click: COMMAND_TIMEOUT_MS,
    fill: COMMAND_TIMEOUT_MS,
};

function invalid(message: string): ApiError {
    return new ApiError('VALIDATION_FAILED', message);
}

/** 导航URL校验：协议/账号信息/长度/主机名（本机域、IP直连私网）。域名解析校验在浏览器工具执行时统一进行。 */
export function assertNavigableUrl(raw: unknown): string {
    const input = String(raw ?? '').trim();
    if (!input) throw invalid('导航地址不能为空');
    if (input.length > 2048) throw invalid('URL超过2048字符上限');
    let url: URL;
    try { url = new URL(input); }
    catch { throw invalid('无效的URL'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid('浏览器仅支持 http/https 地址');
    if (url.username || url.password) throw invalid('URL不应包含账号或密码信息');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!host) throw invalid('URL缺少主机名');
    if (/(?:^|\.)localhost$|\.local$|\.internal$/i.test(host)) throw invalid('不允许访问本机或内网主机名');
    if (isIP(host) && !publicAddress(host)) throw invalid('不允许直接访问私有或保留IP地址');
    return url.href;
}

async function assertResolvableHost(url: string): Promise<void> {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) return; // IP直连已在 assertNavigableUrl 校验
    try {
        // 复用模型网关的解析纪律：Fake-IP 命中改走公共 DoH 复核，私网/保留地址一律拒绝
        await resolvePinnedAddress(host, AbortSignal.timeout(7_000));
    }
    catch (error) {
        throw new ApiError('POLICY_DENIED', `浏览器导航被拒：域名解析到受限或不可达地址（${error instanceof ApiError ? error.message : '解析失败'}）`);
    }
}

/** 监督器 browser_* 工具的统一入口；宿主不可用/超时/守卫拒绝都按明确错误码返回。 */
export async function executeBrowserTool(host: DesktopBrowserHost, name: string, args: Record<string, unknown>): Promise<unknown> {
    const method = name === 'browser_navigate' ? 'navigate'
        : name === 'browser_back' ? 'back'
        : name === 'browser_snapshot' ? 'snapshot'
        : name === 'browser_screenshot' ? 'screenshot'
        : name === 'browser_click' ? 'click'
        : name === 'browser_fill' ? 'fill'
        : null;
    if (!method) throw new ApiError('POLICY_DENIED', '未知浏览器工具');
    if (!host.available) throw new ApiError('BROWSER_UNAVAILABLE', '浏览器宿主不可用：内嵌浏览器需要桌面版运行');
    let payload: Record<string, unknown> = {};
    if (method === 'navigate') {
        const url = assertNavigableUrl(args.url);
        await assertResolvableHost(url);
        payload = { url };
    }
    else if (method === 'click') {
        if (args.ref === undefined && args.selector === undefined && args.text === undefined) throw invalid('点击须提供 ref、selector 或 text 之一');
        payload = pick(args, ['ref', 'selector', 'text']);
    }
    else if (method === 'fill') {
        const value = String(args.value ?? '');
        if (args.ref === undefined && args.selector === undefined) throw invalid('填写须提供 ref 或 selector');
        if (!value) throw invalid('填写内容不能为空');
        payload = { ...pick(args, ['ref', 'selector', 'submit']), value };
    }
    const timeoutMs = BROWSER_METHOD_TIMEOUTS[method]!;
    return await host.execute(method, payload, timeoutMs);
}

function pick(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of keys) if (args[key] !== undefined) out[key] = args[key];
    return out;
}

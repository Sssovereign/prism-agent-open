import { request as httpsRequest } from 'node:https';
import { ApiError } from '../../contracts/errors.js';
import { assertPinnableRequest, describeTransportError, resolvePinnedAddress } from './network.js';

/**
 * 正式模型请求的受控真流式传输（计划v1.6 §5）。
 * 与探测用 pinnedFetch（缓冲、20s/128KiB/2MiB）不同：
 * - 收到上游响应头后立即返回 Response(ReadableStream)，逐chunk转发，禁止Buffer.concat整个SSE再返回；
 * - 连接超时60s（头未到达）、无流数据空闲90s（收到数据即重置）、总时长由调用方预算控制；
 * - 正式模型HTTP请求初始上限8MiB、单次SSE响应32MiB，按实际字节累计，超限中断并记具体错误；
 * - 取消/错误/背压正确传递：上游abort即destroy socket，下游不读即暂停。
 * caCertPem 仅用于测试注入受控上游的测试信任配置；生产路径不传，保持Node默认根校验（不关闭TLS校验）。
 */
export interface StreamProfile {
    connectTimeoutMs: number;
    idleTimeoutMs: number;
    requestBodyLimitBytes: number;
    responseLimitBytes: number;
    caCertPem?: string;
    /** 仅测试注入：受控本机HTTPS上游（127.0.0.1测试证书）需要显式放行回环。生产网关不设置此值，无环境变量/浏览器开关。 */
    allowLoopbackForTest?: boolean;
}
export const RUNTIME_STREAM_PROFILE: StreamProfile = {
    connectTimeoutMs: 60_000,
    idleTimeoutMs: 90_000,
    requestBodyLimitBytes: 8 * 1024 * 1024,
    responseLimitBytes: 32 * 1024 * 1024,
};
export const PROBE_STREAM_PROFILE: StreamProfile = {
    connectTimeoutMs: 20_000,
    idleTimeoutMs: 0,
    requestBodyLimitBytes: 128 * 1024,
    responseLimitBytes: 2 * 1024 * 1024,
};
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ExtraHeaders = Record<string, string>;

/**
 * 构造受控真流式fetch。headersToInject由调用方（网关协议adapter）按请求注入
 * （票据/reservation/body hash等），不进入全局状态。
 */
export function streamingPinnedFetch(baseUrl: string, profile: StreamProfile): { fetch: FetchLike; injectHeaders(headers: ExtraHeaders): FetchLike } {
    const base = new URL(baseUrl);
    const raw: FetchLike = async (input, init) => {
        const req = new Request(input, init);
        assertPinnableRequest(base, req);
        const host = new URL(req.url).hostname.replace(/^\[|\]$/g, '');
        const chosen = await resolvePinnedAddress(host, req.signal, profile.allowLoopbackForTest === true);
        const bytes = req.method === 'GET' ? undefined : Buffer.from(await req.arrayBuffer());
        if (bytes && bytes.length > profile.requestBodyLimitBytes)
            throw new ApiError('INPUT_TOO_LARGE', `模型请求超过大小限制（>${Math.round(profile.requestBodyLimitBytes / 1024)}KiB）`);
        const url = new URL(req.url);
        const signal = req.signal;
        return await new Promise<Response>((resolveResponse, rejectSetup) => {
            let settled = false;
            let request: ReturnType<typeof httpsRequest>;
            // destroy注入的具体错误优先于流层面的一般性错误（空闲超时/大小上限/取消保留原始ApiError类型）。
            let pendingError: ApiError | null = null;
            let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
            const failStream = (error: unknown) => {
                const apiError = pendingError ?? (error instanceof ApiError ? error : new ApiError(signal.aborted ? 'MODEL_TIMEOUT' : 'PROVIDER_ERROR', signal.aborted ? '模型请求已取消或超时' : `模型响应中断，请重试（${describeTransportError(error)}）`));
                if (streamController) {
                    try { streamController.error(apiError); } catch { /* already closed */ }
                }
                else if (!settled) {
                    settled = true;
                    rejectSetup(apiError);
                }
            };
            const fail = (error: unknown) => {
                if (settled) return;
                settled = true;
                rejectSetup(error instanceof ApiError ? error : new ApiError(signal.aborted ? 'MODEL_TIMEOUT' : 'PROVIDER_ERROR', signal.aborted ? '模型请求已取消或超时' : `无法连接接口，请检查地址和网络（${describeTransportError(error)}）`));
            };
            const destroyWith = (error: ApiError) => {
                pendingError = error;
                request?.destroy(error);
            };
            const connectTimer = profile.connectTimeoutMs > 0
                ? setTimeout(() => { destroyWith(new ApiError('MODEL_TIMEOUT', '连接模型接口超时')); }, profile.connectTimeoutMs)
                : null;
            if (connectTimer) connectTimer.unref?.();
            request = httpsRequest(url, {
                method: req.method,
                headers: Object.fromEntries(req.headers),
                signal,
                ca: profile.caCertPem,
                lookup: ((_name: string, opts: { all?: boolean }, callback: (...args: unknown[]) => void) => opts.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family)) as never,
            }, response => {
                if (connectTimer) clearTimeout(connectTimer);
                if (settled) { response.destroy(); return; }
                const status = response.statusCode ?? 502;
                const headers = new Headers();
                for (const [key, value] of Object.entries(response.headers))
                    if (value !== undefined)
                        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
                // 背压：ReadableStream pull为0时node流暂停（默认不自动续读）。
                let pushed = 0;
                let idleTimer: ReturnType<typeof setTimeout> | null = null;
                const armIdle = () => {
                    if (profile.idleTimeoutMs <= 0) return;
                    if (idleTimer) clearTimeout(idleTimer);
                    idleTimer = setTimeout(() => {
                        destroyWith(new ApiError('MODEL_TIMEOUT', `模型流空闲超过${Math.round(profile.idleTimeoutMs / 1000)}秒`));
                    }, profile.idleTimeoutMs);
                    idleTimer.unref?.();
                };
                const stream = new ReadableStream<Uint8Array>({
                    start(controller) {
                        streamController = controller;
                        armIdle();
                        response.on('data', (chunk: Buffer) => {
                            armIdle();
                            pushed += chunk.length;
                            if (pushed > profile.responseLimitBytes) {
                                destroyWith(new ApiError('INPUT_TOO_LARGE', `单次模型响应超过大小限制（>${Math.round(profile.responseLimitBytes / (1024 * 1024))}MiB）`));
                                return;
                            }
                            try { controller.enqueue(new Uint8Array(chunk)); }
                            catch { /* 下游已关闭 */ }
                        });
                        response.on('end', () => {
                            if (idleTimer) clearTimeout(idleTimer);
                            try { controller.close(); } catch { /* already closed */ }
                        });
                        response.on('error', (error: unknown) => {
                            if (idleTimer) clearTimeout(idleTimer);
                            failStream(error);
                        });
                    },
                    cancel() {
                        if (idleTimer) clearTimeout(idleTimer);
                        request.destroy();
                    },
                });
                // 客户端取消：关闭socket（断言：取消后上游连接中断）。
                signal.addEventListener('abort', () => destroyWith(new ApiError('MODEL_TIMEOUT', '模型请求已取消')), { once: true });
                settled = true;
                resolveResponse(new Response(stream, { status, headers }));
            });
            request.on('error', error => {
                if (connectTimer) clearTimeout(connectTimer);
                fail(error);
            });
            if (bytes) request.write(bytes);
            request.end();
        });
    };
    return {
        fetch: raw,
        injectHeaders(headers: ExtraHeaders) {
            return async (input, init) => {
                const request = new Request(input, init);
                const merged = new Headers(request.headers);
                for (const [key, value] of Object.entries(headers)) merged.set(key, value);
                return raw(new Request(request, { headers: merged }));
            };
        },
    };
}

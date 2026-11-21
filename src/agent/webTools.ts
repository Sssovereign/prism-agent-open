import { request as httpsRequest } from 'node:https';
import { ApiError } from '../../contracts/errors.js';
import { createWebSearcher, parseSearchHttpResponse, type SearchHttpRequest } from './searchProviders.js';
import type { EnabledSearchProvider } from '../../contracts/search.js';
export { SEARCH_PROVIDERS, type SearchProvider, type WebSearchToolResult } from '../../contracts/search.js';
import { resolvePinnedAddress, publicAddress } from '../models/network.js';

/**
 * 联网工具（web_fetch / web_search）的可信执行实现。
 * 与文件抓取资源（files/broker.ts）分离：这里面向 Agent 工具返回文本而非入库资源。
 * 安全边界：仅公开 HTTPS；DNS 解析固定首个公开地址（Fake-IP 走公共 DNS 复核）；
 * 重定向逐跳复核，最多 3 跳；响应与正文有大小上限；无 Cookie/凭据外带。
 */

const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 20_000;
const MAX_REDIRECT_HOPS = 3;
const SEARCH_TIMEOUT_MS = 25_000;
const MAX_SEARCH_BYTES = 1024 * 1024;


// —— 抓取结果缓存（进程内 LRU，与上游 webfetch cache 语义对齐的最小实现） ——

interface CacheEntry { at: number; result: WebFetchToolResult }
const fetchCache = new Map<string, CacheEntry>();
const FETCH_CACHE_TTL_MS = 10 * 60_000;
const FETCH_CACHE_CAPACITY = 50;

export function clearFetchCache(): void { fetchCache.clear(); }

export interface WebFetchToolResult {
    url: string;
    finalUrl: string;
    status: number;
    contentType: string;
    title: string | null;
    content: string;
    truncated: boolean;
    cache: 'hit' | 'miss';
    fetchedAt: string;
}

interface PinnedResponse { status: number; headers: Headers; bytes: Buffer; url: string }

async function pinnedRequest(url: URL, init: { method: string; headers: Record<string, string>; body?: Buffer; signal: AbortSignal; maxBytes: number }): Promise<PinnedResponse> {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const chosen = await resolvePinnedAddress(host, init.signal);
    return new Promise<PinnedResponse>((resolve, reject) => {
        const req = httpsRequest(url, {
            method: init.method,
            headers: init.headers,
            signal: init.signal,
            lookup: ((_name: string, opts: { all?: boolean }, callback: (...args: unknown[]) => void) =>
                opts.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family)) as never,
        }, response => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > init.maxBytes) { req.destroy(); reject(new ApiError('INPUT_TOO_LARGE', `响应超过 ${(init.maxBytes / 1024 / 1024).toFixed(0)}MiB 上限`)); return; }
                chunks.push(chunk);
            });
            response.on('end', () => {
                const headers = new Headers();
                for (const [key, value] of Object.entries(response.headers))
                    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
                resolve({ status: response.statusCode ?? 502, headers, bytes: Buffer.concat(chunks), url: url.href });
            });
            response.on('error', () => reject(new ApiError('PROVIDER_ERROR', '响应中断，请重试')));
        });
        req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error('TIMEOUT')));
        req.on('error', error => reject(new ApiError(init.signal.aborted ? 'MODEL_TIMEOUT' : 'PROVIDER_ERROR', init.signal.aborted ? '请求已取消或超时' : `无法连接：${error.message.slice(0, 80)}`)));
        if (init.body) req.write(init.body);
        req.end();
    });
}

function assertFetchableUrl(rawUrl: string): URL {
    let url: URL;
    try { url = new URL(rawUrl.trim()); }
    catch { throw new ApiError('VALIDATION_FAILED', 'URL 无效'); }
    if (url.protocol !== 'https:') throw new ApiError('VALIDATION_FAILED', '仅支持 https:// 地址');
    if (url.username || url.password || url.hash) throw new ApiError('VALIDATION_FAILED', 'URL 不能包含账号信息或锚点');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (isIPHost(hostname) && !publicAddress(hostname)) throw new ApiError('POLICY_DENIED', '目标地址不受允许（内网/本机地址）');
    return url;
}

/** MCP 远程传输复用同一传输纪律：https/DNS 钉扎/私网拒绝/大小上限。仅 POST JSON；上限对齐 runner 帧 8MiB。 */
export async function pinnedJsonPost(rawUrl: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<PinnedResponse> {
    const url = assertFetchableUrl(rawUrl);
    return pinnedRequest(url, {
        method: 'POST',
        headers,
        body: Buffer.from(JSON.stringify(body), 'utf8'),
        signal: AbortSignal.timeout(timeoutMs),
        maxBytes: 8 * 1024 * 1024,
    });
}

function isIPHost(hostname: string): boolean {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(':');
}

async function boundedFetchPage(url: URL, hop: number, chain: string[], signal: AbortSignal): Promise<PinnedResponse> {
    if (hop > MAX_REDIRECT_HOPS) throw new ApiError('VALIDATION_FAILED', '重定向次数过多');
    const response = await pinnedRequest(url, {
        method: 'GET',
        headers: { 'user-agent': 'PrismAgent/0.2 web-fetch', accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6' },
        signal,
        maxBytes: MAX_FETCH_BYTES,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new ApiError('VALIDATION_FAILED', '重定向缺少目标地址');
        const next = new URL(location, url);
        if (next.protocol !== 'https:') throw new ApiError('POLICY_DENIED', '重定向目标须仍为 https://');
        if (chain.includes(next.href)) throw new ApiError('VALIDATION_FAILED', '检测到重定向环');
        const nextHost = next.hostname.replace(/^\[|\]$/g, '');
        if (isIPHost(nextHost) && !publicAddress(nextHost)) throw new ApiError('POLICY_DENIED', '重定向目标不受允许');
        return boundedFetchPage(next, hop + 1, [...chain, url.href], signal);
    }
    if (response.status >= 400) throw new ApiError('PROVIDER_ERROR', `目标返回 HTTP ${response.status}`);
    return response;
}

/** 极简 HTML→文本：去 script/style，块级换行，剥标签，解常用实体。 */
export function extractHtmlText(html: string): { title: string | null; text: string } {
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre|table|ul|ol)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
    text = decodeEntities(text).replace(/[ \t\r\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { title: titleMatch ? decodeEntities(titleMatch[1]!).trim().slice(0, 200) : null, text };
}

function decodeEntities(input: string): string {
    return input
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#0?39;|&apos;/gi, "'")
        .replace(/&#(\d+);/g, (_, code: string) => {
            const point = Number(code);
            return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
        });
}

export async function fetchUrlText(rawUrl: string, opts: { fresh?: boolean } = {}): Promise<WebFetchToolResult> {
    const url = assertFetchableUrl(rawUrl);
    const cacheKey = url.href;
    if (!opts.fresh) {
        const cached = fetchCache.get(cacheKey);
        if (cached && Date.now() - cached.at < FETCH_CACHE_TTL_MS) {
            fetchCache.delete(cacheKey);
            fetchCache.set(cacheKey, cached); // LRU touch
            return { ...cached.result, cache: 'hit' };
        }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS + 5_000);
    try {
        const response = await boundedFetchPage(url, 0, [url.href], controller.signal);
        const contentType = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
        let title: string | null = null;
        let text: string;
        if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
            const extracted = extractHtmlText(response.bytes.toString('utf8'));
            title = extracted.title;
            text = extracted.text;
        }
        else if (/^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded))/.test(contentType) || contentType === 'application/octet-stream' && looksLikeText(response.bytes)) {
            text = response.bytes.toString('utf8');
        }
        else {
            throw new ApiError('VALIDATION_FAILED', `不支持的响应类型（${contentType}），仅抓取文本类内容`);
        }
        if (text.includes('\0')) throw new ApiError('VALIDATION_FAILED', '响应疑似二进制内容，已拒绝');
        const truncated = text.length > MAX_TEXT_CHARS;
        const result: WebFetchToolResult = {
            url: url.href,
            finalUrl: response.url,
            status: response.status,
            contentType,
            title,
            content: truncated ? text.slice(0, MAX_TEXT_CHARS) : text,
            truncated,
            cache: 'miss',
            fetchedAt: new Date().toISOString(),
        };
        fetchCache.set(cacheKey, { at: Date.now(), result });
        while (fetchCache.size > FETCH_CACHE_CAPACITY) {
            const oldest = fetchCache.keys().next().value;
            if (oldest === undefined) break;
            fetchCache.delete(oldest);
        }
        return result;
    }
    finally {
        clearTimeout(timer);
    }
}

function looksLikeText(bytes: Buffer): boolean {
    const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
    return !sample.includes(0);
}

// —— 搜索 ——

async function requestSearchJson(request: SearchHttpRequest, provider: EnabledSearchProvider): Promise<unknown> {
    const parsed = assertFetchableUrl(request.url);
    const payload = request.body === undefined ? undefined : Buffer.from(request.body, 'utf8');
    if (payload && payload.byteLength > 128 * 1024) throw new ApiError('INPUT_TOO_LARGE', '搜索请求超过大小限制');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
        const response = await pinnedRequest(parsed, {
            method: request.method,
            headers: { 'user-agent': 'PrismAgent/0.2 web-search', ...request.headers },
            body: payload, signal: controller.signal, maxBytes: MAX_SEARCH_BYTES,
        });
        return parseSearchHttpResponse(response.status,response.bytes.toString('utf8'),provider);
    }
    finally { clearTimeout(timer); }
}

export const searchWeb = createWebSearcher(requestSearchJson);

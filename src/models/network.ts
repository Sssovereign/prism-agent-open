import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { ApiError } from '../../contracts/errors.js';
import type { ModelConfigInput } from '../../contracts/v1.js';
const denied = new BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const)
    denied.addSubnet(ip, bits, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
denied.addSubnet('2001::', 23, 'ipv6');
denied.addSubnet('2001:db8::', 32, 'ipv6');
denied.addSubnet('2002::', 16, 'ipv6');
export function publicAddress(ip: string) { const family = isIP(ip); return family === 4 ? !denied.check(ip, 'ipv4') : family === 6 && globalV6.check(ip, 'ipv6') && !denied.check(ip, 'ipv6'); }
export function validateEndpoint(input: ModelConfigInput): string {
    let url: URL;
    try {
        url = new URL(input.baseUrl);
    }
    catch {
        throw new ApiError('VALIDATION_FAILED', '请输入有效的 API 地址');
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /(?:^|\.)(?:localhost|local|internal)$/.test(hostname) || isIP(hostname) && !publicAddress(hostname))
        throw new ApiError('VALIDATION_FAILED', 'API 地址须为公开 HTTPS 地址，不能包含账号、密钥参数或本机地址');
    const normalized = url.href.replace(/\/+$/, '').replace(input.protocol === 'anthropic-messages' ? /\/v1(?:\/messages)?$/ : /\/chat\/completions$/, '');
    return normalized;
}
/** 请求URL必须落在配置的base origin/path内；GET/POST；仅允许SDK固定的Messages beta参数，拒绝其余query/fragment/账号信息。探测与正式流共享。 */
export function assertPinnableRequest(base: URL, req: Request): void {
    const url = new URL(req.url);
    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/`) || !['GET', 'POST'].includes(req.method) || (url.search && !(url.search === '?beta=true' && url.pathname.endsWith('/v1/messages'))) || url.hash || url.username || url.password)
        throw new ApiError('POLICY_DENIED', '模型请求地址不符合当前接口配置');
}
/** Fake-IP proxies can return 198.18/15. Resolve only that case through fixed HTTPS DNS
 * servers; never connect to the fake address or relax the public-IP/TLS checks. */
export function isFakeIp(ip: string): boolean { return /^198\.(18|19)\./.test(ip); }
export function publicDnsAnswers(data: unknown): Array<{ address: string; family: number }> {
    const answers = (data as { Answer?: Array<{ type?: number; data?: string }> })?.Answer ?? [];
    const ips = answers.filter(a => a.type === 1 || a.type === 28).map(a => ({ address: String(a.data ?? ''), family: a.type === 1 ? 4 : 6 }));
    if (!ips.length || ips.some(a => !publicAddress(a.address))) throw new ApiError('POLICY_DENIED', '公网DNS未返回安全地址');
    return ips;
}
async function resolveProxyDns(host: string, signal: AbortSignal): Promise<{ address: string; family: number }> {
    const attempt = (server: { ip: string; name: string; path: string }) => new Promise<{ address: string; family: number }>((resolve, reject) => {
        if (signal.aborted) { reject(new ApiError('MODEL_TIMEOUT', '域名解析已取消')); return; }
        const req = httpsRequest({ hostname:server.ip, servername:server.name, path:`${server.path}?name=${encodeURIComponent(host)}&type=A`, method:'GET', headers:{host:server.name,accept:'application/dns-json'}, signal }, res => {
            if (res.statusCode !== 200) { res.resume(); reject(new Error('DNS_STATUS')); return; }
            const chunks: Buffer[]=[]; let bytes=0;
            res.on('data', chunk => { bytes+=chunk.length; if(bytes>16384)req.destroy(new Error('DNS_SIZE')); else chunks.push(Buffer.from(chunk)); });
            res.on('error',reject);
            res.on('end',()=>{try{resolve(publicDnsAnswers(JSON.parse(Buffer.concat(chunks).toString('utf8')))[0]!);}catch(e){reject(e);}});
        });
        req.setTimeout(7000,()=>req.destroy(new Error('DNS_TIMEOUT'))); req.on('error',reject); req.end();
    });
    // global代理模式下DoH本身也走节点，单个解析器可能不通；并行查询任一有效即用，全部失败7秒封顶，不再串行翻倍。
    try {
        return await Promise.any([{ip:'223.5.5.5',name:'dns.alidns.com',path:'/resolve'}, {ip:'1.1.1.1',name:'cloudflare-dns.com',path:'/dns-query'}, {ip:'8.8.8.8',name:'dns.google',path:'/resolve'}].map(attempt));
    } catch {
        if (signal.aborted) throw new ApiError('MODEL_TIMEOUT', '域名解析已取消');
        // 任一解析器失败（含DNS返回受限地址）都只是换路失败；全部失败统一按旧文案报错，策略不放松。
        throw new ApiError('PROVIDER_ERROR', '代理DNS解析失败，请检查网络连接');
    }
}
/** DNS解析并固定首个公开地址；取消感知。allowLoopback仅供受控测试上游（测试证书+显式注入）使用。 */
export async function resolvePinnedAddress(host: string, signal: AbortSignal, allowLoopback = false): Promise<{ address: string; family: number }> {
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new ApiError('MODEL_TIMEOUT', '连接测试已取消或超时'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        const addresses = await Promise.race([
            lookup(host, { all: true, verbatim: true }).catch(() => { throw new ApiError('PROVIDER_ERROR', '域名解析失败，请检查网络或代理'); }),
            aborted,
        ]);
        if (!allowLoopback && !isIP(host) && addresses.length && addresses.every(a => isFakeIp(a.address))) return await resolveProxyDns(host, signal);
        const allowed = (a: { address: string }) => allowLoopback ? isLoopback(a.address) || publicAddress(a.address) : publicAddress(a.address);
        if (!addresses.length || addresses.some(a => !allowed(a)))
            throw new ApiError('POLICY_DENIED', '域名解析到受限地址，请检查代理或 DNS 设置');
        return addresses[0]!;
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
function isLoopback(ip: string): boolean {
    const family = isIP(ip);
    if (family === 4) return ip.startsWith('127.');
    if (family === 6) return ip === '::1';
    return false;
}
/** 传输层原始错误摘述：优先errno code（ECONNRESET等，弱网分类器按此识别瞬态），
 * 无code回退message；包进自身错误文案时必须保留，否则pi与监督器的瞬态重试全部失明。 */
export function describeTransportError(error: unknown): string {
    if (error instanceof Error) {
        const code = (error as NodeJS.ErrnoException).code;
        return (typeof code === 'string' && code ? code : error.message).slice(0, 80);
    }
    return String(error).slice(0, 80);
}
/** DNS answers are checked then pinned to the TLS connection; redirects are never followed. */
export function pinnedFetch(baseUrl: string): typeof fetch {
    const base = new URL(baseUrl);
    return async (input, init) => {
        const req = new Request(input, init);
        assertPinnableRequest(base, req);
        const host = req.url && new URL(req.url).hostname.replace(/^\[|\]$/g, '');
        const chosen = await resolvePinnedAddress(host, req.signal);
        const bytes = req.method === 'GET' ? undefined : Buffer.from(await req.arrayBuffer());
        if (bytes && bytes.length > 128 * 1024)
            throw new ApiError('INPUT_TOO_LARGE', '模型请求超过大小限制');
        return new Promise<Response>((resolve, reject) => {
            const url = new URL(req.url);
            const request = httpsRequest(url, { method: req.method, headers: Object.fromEntries(req.headers), signal: req.signal,
                lookup: ((_name: string, opts: {
                    all?: boolean;
                }, callback: (...args: unknown[]) => void) => opts.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family)) as never,
            }, response => {
                const chunks: Buffer[] = [];
                let size = 0;
                response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2 * 1024 * 1024) {
                    request.destroy();
                    reject(new ApiError('INPUT_TOO_LARGE', '模型响应超过大小限制'));
                }
                else
                    chunks.push(chunk); });
                response.on('end', () => { const headers = new Headers(); for (const [key, value] of Object.entries(response.headers))
                    if (value !== undefined)
                        headers.set(key, Array.isArray(value) ? value.join(', ') : value); resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 502, headers })); });
                response.on('error', (error: unknown) => reject(new ApiError('PROVIDER_ERROR', `模型响应中断，请重试（${describeTransportError(error)}）`)));
            });
            request.setTimeout(20000, () => request.destroy(new Error('TIMEOUT')));
            request.on('error', (error: unknown) => reject(new ApiError(req.signal.aborted ? 'MODEL_TIMEOUT' : 'PROVIDER_ERROR', req.signal.aborted ? '连接测试已取消或超时' : `无法连接接口，请检查地址和网络（${describeTransportError(error)}）`)));
            if (bytes)
                request.write(bytes);
            request.end();
        });
    };
}

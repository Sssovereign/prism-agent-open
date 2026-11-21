'use strict';
// 内嵌浏览器出网守卫（desktop 壳自含，不依赖业务编译产物）。
// 与 src/models/network.ts 同一纪律：私网/保留地址 BlockList + Fake-IP(198.18/15)
// 命中改走公共 DoH 复核；此处多一层——Chromium 的全部请求（含重定向与子资源）都在
// session.webRequest 层重查，代理 Fake-IP 隧道按 DoH 复核结论放行。
// 本文件刻意复制 network.ts 的子网清单：desktop 层保持自含（同 policy.cjs 先例），
// 两边清单不一致时以 network.ts 为准并同次同步。

const { BlockList, isIP } = require('node:net');
const { lookup } = require('node:dns').promises;
const { request: httpsRequest } = require('node:https');

const denied = new BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]])
    denied.addSubnet(ip, bits, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
denied.addSubnet('2001::', 23, 'ipv6');
denied.addSubnet('2001:db8::', 32, 'ipv6');
denied.addSubnet('2002::', 16, 'ipv6');

function publicAddress(ip) {
    const family = isIP(ip);
    return family === 4 ? !denied.check(ip, 'ipv4') : family === 6 && globalV6.check(ip, 'ipv6') && !denied.check(ip, 'ipv6');
}
function isFakeIp(ip) { return /^198\.(18|19)\./.test(ip); }

const MAIN_FRAME_PROTOCOLS = new Set(['http:', 'https:']);
const SUBRESOURCE_PROTOCOLS = new Set(['http:', 'https:', 'data:', 'blob:', 'about:']);

/** 协议层判定（主框架仅 http/https；子资源另放行 data:/blob:/about:，file:/javascript:/ws: 一律拒）。 */
function protocolVerdict(url, resourceType) {
    let parsed;
    try { parsed = new URL(url); }
    catch { return { cancel: true, reason: 'MALFORMED_URL' }; }
    const allowed = resourceType === 'mainFrame' ? MAIN_FRAME_PROTOCOLS : SUBRESOURCE_PROTOCOLS;
    return allowed.has(parsed.protocol) ? { cancel: false } : { cancel: true, reason: `PROTOCOL_${parsed.protocol.replace(':', '').toUpperCase()}` };
}

function verdictForAddresses(addresses) {
    if (!addresses.length) return { cancel: true, reason: 'DNS_EMPTY' };
    return addresses.some(a => !publicAddress(a.address)) ? { cancel: true, reason: 'RESTRICTED_ADDRESS' } : { cancel: false };
}

// —— DoH 复核（Fake-IP 环境）：并行查询三个公共解析器，任一返回全公网地址即放行 ——
const DOH_RESOLVERS = [
    { ip: '223.5.5.5', name: 'dns.alidns.com', path: '/resolve' },
    { ip: '1.1.1.1', name: 'cloudflare-dns.com', path: '/dns-query' },
    { ip: '8.8.8.8', name: 'dns.google', path: '/resolve' },
];
function dohLookup(host, timeoutMs = 6000) {
    const attempt = server => new Promise((resolve, reject) => {
        const req = httpsRequest({
            hostname: server.ip, servername: server.name,
            path: `${server.path}?name=${encodeURIComponent(host)}&type=A`,
            method: 'GET', headers: { host: server.name, accept: 'application/dns-json' },
        }, res => {
            if (res.statusCode !== 200) { res.resume(); reject(new Error('DNS_STATUS')); return; }
            const chunks = []; let bytes = 0;
            res.on('data', chunk => { bytes += chunk.length; if (bytes > 16384) req.destroy(new Error('DNS_SIZE')); else chunks.push(chunk); });
            res.on('error', reject);
            res.on('end', () => {
                try {
                    const answers = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.Answer ?? [];
                    const ips = answers.filter(a => a.type === 1 || a.type === 28).map(a => ({ address: String(a.data ?? ''), family: a.type === 1 ? 4 : 6 }));
                    ips.length ? resolve(ips) : reject(new Error('DNS_NO_ANSWER'));
                } catch (error) { reject(error); }
            });
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('DNS_TIMEOUT')));
        req.on('error', reject);
        req.end();
    });
    return Promise.any(DOH_RESOLVERS.map(attempt));
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 512;
const verdictCache = new Map();

/** 主机名解析判定：Fake-IP 全命中时走 DoH 复核；私网/保留/复核失败一律拒。resolvers 可注入供测试。 */
async function hostVerdict(host, { lookupFn = lookup, dohFn = dohLookup, now = Date.now } = {}) {
    if (isIP(host)) return publicAddress(host) ? { cancel: false } : { cancel: true, reason: 'RESTRICTED_ADDRESS' };
    const cached = verdictCache.get(host);
    if (cached && cached.expires > now()) return cached.verdict;
    let verdict;
    try {
        let addresses = await lookupFn(host, { all: true, verbatim: true });
        if (addresses.length && addresses.every(a => isFakeIp(a.address)))
            addresses = await dohFn(host);
        verdict = verdictForAddresses(addresses);
    }
    catch {
        verdict = { cancel: true, reason: 'DNS_VERIFY_FAILED' };
    }
    if (verdictCache.size >= CACHE_MAX) {
        const firstKey = verdictCache.keys().next().value;
        if (firstKey !== undefined) verdictCache.delete(firstKey);
    }
    verdictCache.set(host, { verdict, expires: now() + CACHE_TTL_MS });
    return verdict;
}

function clearVerdictCache() { verdictCache.clear(); }

/** session.webRequest.onBeforeRequest 处理器：协议判定 → 主机解析判定，任一拒绝即 cancel。 */
function buildRequestGuard({ onLog = () => {}, resourceTypeFilter = null } = {}) {
    let denyLogCount = 0;
    return (details, callback) => {
        if (resourceTypeFilter && !resourceTypeFilter.has(details.resourceType)) return callback({ cancel: false });
        const protocol = protocolVerdict(details.url, details.resourceType);
        if (protocol.cancel) {
            if (denyLogCount < 50) { denyLogCount++; onLog(`[browser-guard] 拦截 ${details.resourceType} ${details.url.slice(0, 120)}（${protocol.reason}）`); }
            return callback({ cancel: true });
        }
        let host;
        try { host = new URL(details.url).hostname.replace(/^\[|\]$/g, ''); }
        catch { return callback({ cancel: true }); }
        if (!host || host.endsWith('.localhost')) return callback({ cancel: true });
        hostVerdict(host).then(verdict => {
            if (verdict.cancel && denyLogCount < 50) { denyLogCount++; onLog(`[browser-guard] 拦截 ${details.resourceType} ${details.url.slice(0, 120)}（${verdict.reason}）`); }
            callback({ cancel: !!verdict.cancel });
        }, () => callback({ cancel: true }));
    };
}

module.exports = { publicAddress, isFakeIp, protocolVerdict, hostVerdict, buildRequestGuard, clearVerdictCache, dohLookup, DOH_RESOLVERS };

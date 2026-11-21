// 受限更新下载：逐跳校验来源，截止时间覆盖响应体，下载失败清理暂存。
// 弱网续传：网络类中断保留部分文件，下次尝试Range续传（前缀重算哈希保证整包digest一致）。
'use strict';
const { createHash } = require('node:crypto');
const { mkdirSync, rmSync, statSync } = require('node:fs');
const { open } = require('node:fs/promises');
const { dirname } = require('node:path');
const MAX_REDIRECTS = 3, MAX_MANIFEST_PROBES = 5;
class FeedError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; }
}
async function responseFor(url, headers, guard, signal) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    guard(current);
    const response = await fetch(current, { headers, redirect: 'manual', signal });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel();
      const next = new URL(response.headers.get('location'), current).href;
      guard(next);
      if (hop === MAX_REDIRECTS) throw new FeedError('FEED_REDIRECT_LIMIT');
      current = next; continue;
    }
    if (response.status === 200 || response.status === 206) return response; // 206=Range续传部分内容
    await response.body?.cancel();
    if (response.status === 404) throw new FeedError('FEED_NOT_FOUND');
    if ([403, 429].includes(response.status)) throw new FeedError('FEED_RATE_LIMITED', String(response.status));
    throw new FeedError('FEED_HTTP_STATUS', String(response.status));
  }
}
function networkError(error, signal) {
  return error instanceof FeedError ? error : new FeedError(signal.aborted ? 'FEED_TIMEOUT' : 'FEED_NETWORK', error.message);
}
async function fetchBuffer(url, headers, guard, maxBytes, timeoutMs = 30000) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await responseFor(url, headers, guard, signal);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw new FeedError('FEED_PAYLOAD_TOO_LARGE');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (error) { throw networkError(error, signal); }
}
function downloadGuardFor({ githubRepo, localFeedUrl }) {
  if (localFeedUrl) {
    const source = new URL(localFeedUrl);
    if (source.protocol !== 'http:' || source.hostname !== '127.0.0.1' || source.username || source.password) throw new FeedError('FEED_LOCAL_SOURCE_INVALID');
    return target => {
      const parsed = new URL(target);
      if (parsed.origin !== source.origin || parsed.username || parsed.password) throw new FeedError('FEED_REDIRECT_DENIED');
    };
  }
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(githubRepo ?? '')) throw new FeedError('FEED_REPO_INVALID');
  const allowed = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
  return target => {
    const parsed = new URL(target);
    if (parsed.protocol !== 'https:' || !allowed.has(parsed.host) || parsed.username || parsed.password ||
      (parsed.host === 'github.com' && !parsed.pathname.startsWith(`/${githubRepo}/releases/download/`))) throw new FeedError('FEED_REDIRECT_DENIED');
  };
}
async function listReleases({ githubRepo, localFeedUrl }) {
  const local = !!localFeedUrl;
  const guard = local ? downloadGuardFor({ localFeedUrl }) : target => {
    const parsed = new URL(target);
    if (parsed.protocol !== 'https:' || parsed.host !== 'api.github.com' || parsed.pathname !== `/repos/${githubRepo}/releases`) throw new FeedError('FEED_REDIRECT_DENIED');
  };
  if (!local) downloadGuardFor({ githubRepo });
  const bytes = await fetchBuffer(localFeedUrl || `https://api.github.com/repos/${githubRepo}/releases?per_page=30`,
    { Accept: 'application/vnd.github+json', 'User-Agent': 'prism-updater', 'X-GitHub-Api-Version': '2022-11-28' }, guard, 16 * 1024 * 1024);
  let releases;
  try { releases = JSON.parse(bytes.toString('utf8')); } catch { throw new FeedError('FEED_JSON_INVALID'); }
  if (!Array.isArray(releases)) throw new FeedError('FEED_SHAPE_INVALID');
  return releases.filter(item => item && !item.draft).map(item => ({
    tag: String(item.tag_name ?? ''), prerelease: item.prerelease === true,
    notes: typeof item.body === 'string' ? item.body : '', publishedAt: item.published_at ?? null,
    assetNames: Array.isArray(item.assets) ? item.assets.filter(asset => !asset.state || asset.state === 'uploaded').map(asset => asset.name) : null,
    assets: Array.isArray(item.assets) ? item.assets.filter(asset => !asset.state || asset.state === 'uploaded').map(asset => ({ name: asset.name, size: asset.size, digest: asset.digest })) : [],
  }));
}
function pickAssets(names, { platform, arch, packageFile }) {
  const manifest = `manifest-${platform}-${arch}.json`, signature = `${manifest}.sig`;
  return [manifest, signature, packageFile].every(name => names.includes(name)) ? { manifest, signature, package: packageFile } : null;
}
// 弱网断点续传：网络类中断（超时/重置/Range错位）保留部分文件用Range续传，最多4次尝试；
// 服务器不支持Range（返回200）则整包重来；确定性失败（大小/状态码/重定向/guard）立即放弃并清理。
const DOWNLOAD_ATTEMPTS = 4;
const RESUMABLE_CODES = new Set(['FEED_NETWORK', 'FEED_TIMEOUT', 'FEED_PARTIAL_TRUNCATED', 'FEED_RANGE_MISMATCH']);
async function downloadToFile(url, guard, destPath, maxBytes, onProgress, timeoutMs = 120000) {
  let lastError = null;
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs);
    let file, completed = false, partialKept = false;
    try {
      let base = 0;
      if (attempt > 0) {
        try { base = statSync(destPath).size; } catch { base = 0; }
        if (base <= 0 || base > maxBytes) base = 0;
      }
      const response = await responseFor(url, { 'User-Agent': 'prism-updater', ...(base > 0 ? { Range: `bytes=${base}-` } : {}) }, guard, signal);
      const contentLength = Number(response.headers.get('content-length'));
      if (response.status === 206) {
        const rangeStart = Number(/^bytes (\d+)-/.exec(String(response.headers.get('content-range') ?? ''))?.[1] ?? NaN);
        if (rangeStart !== base) throw new FeedError('FEED_RANGE_MISMATCH');
      }
      else if (response.status === 200) { if (base > 0) rmSync(destPath, { force: true }); base = 0; } // 服务端不支持Range：整包重来
      else throw response.status === 404 ? new FeedError('FEED_NOT_FOUND')
        : [403, 429].includes(response.status) ? new FeedError('FEED_RATE_LIMITED', String(response.status))
        : new FeedError('FEED_HTTP_STATUS', String(response.status));
      if (base + (Number.isFinite(contentLength) ? contentLength : 0) > maxBytes) throw new FeedError('FEED_PAYLOAD_TOO_LARGE');
      mkdirSync(dirname(destPath), { recursive: true, mode: 0o700 });
      file = await open(destPath, base > 0 ? 'r+' : 'wx', 0o600);
      const hash = createHash('sha256');
      if (base > 0) {
        // 续传先重算已有前缀哈希：最终digest仍是整包sha256，校验语义不变
        const prefix = Buffer.allocUnsafe(1024 * 1024);
        for (let offset = 0; offset < base;) {
          const { bytesRead } = await file.read(prefix, 0, Math.min(prefix.length, base - offset), offset);
          if (bytesRead <= 0) throw new FeedError('FEED_PARTIAL_TRUNCATED');
          hash.update(prefix.subarray(0, bytesRead)); offset += bytesRead;
        }
      }
      let size = base;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) throw new FeedError('FEED_PAYLOAD_TOO_LARGE');
        hash.update(chunk);
        await file.write(chunk, 0, chunk.length, size - chunk.length);
        onProgress?.({ receivedBytes: size });
      }
      completed = true;
      return { sha256: hash.digest('hex'), size, resumed: base > 0 };
    } catch (error) {
      lastError = networkError(error, signal);
      if (!(lastError instanceof FeedError) || !RESUMABLE_CODES.has(lastError.code)) throw lastError;
      partialKept = attempt < DOWNLOAD_ATTEMPTS - 1;
    } finally {
      if (file) await file.close();
      if (!completed && !partialKept) rmSync(destPath, { force: true });
    }
  }
  throw lastError ?? new FeedError('FEED_NETWORK', 'download attempts exhausted');
}
module.exports = { FeedError, listReleases, pickAssets, downloadToFile, downloadGuardFor, fetchBuffer, MAX_MANIFEST_PROBES };

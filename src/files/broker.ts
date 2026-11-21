// 受控读取代理：授权内目录列表、不可变文件快照、上传与联网抓取的版本化。
// 越界/软链/超限一律明确失败；错误信息不含绝对路径、Key或原始headers。
import { createHash, randomUUID } from 'node:crypto';
import { readdir, stat, readFile, mkdir, writeFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { join, basename } from 'node:path';
import type { Db } from '../storage/db.js';
import { PathDenied, normalizeRelative, resolveWithinGrant, isInside } from './paths.js';
import { getGrant, type GrantRow } from './picker.js';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

function nowIso(): string { return new Date().toISOString(); }

export class GrantDenied extends Error {}

/** 校验项目归属+有效授权；他人/不存在/已撤销同形404（GrantDenied由路由转NOT_FOUND）。 */
export function requireActiveGrant(db: Db, projectId: string, grantId: string): GrantRow {
  const row = getGrant(db, projectId, grantId);
  if (!row || row.revoked_at !== null) throw new GrantDenied('授权无效');
  return row;
}

/** excludes语义与listFiles一致：命中即PathDenied；供资料导入等受控读取复用。 */
export function checkExcludes(grant: GrantRow, relativePath: string): void {
  for (const excluded of JSON.parse(grant.excludes_json) as string[]) {
    if (isInside(excluded, relativePath)) throw new PathDenied('路径无效');
  }
}

export interface FileEntry { name: string; type: 'file' | 'directory'; sizeBytes: number | null }

/** 只列授权范围：每项都经软链/越界校验，错误统一"路径无效"。 */
export async function listFiles(grant: GrantRow, relativePath: string): Promise<{ path: string; entries: FileEntry[] }> {
  const rel = relativePath === '.' || relativePath === '' ? '' : normalizeRelative(relativePath);
  checkExcludes(grant, rel);
  const dirReal = await resolveWithinGrant(grant.canonical_root, rel === '' ? '.' : rel);
  const dirents = await readdir(dirReal, { withFileTypes: true });
  const entries: FileEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue; // 软链不列出，防止借目录名探测
    const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
    try {
      checkExcludes(grant, childRel);
    } catch { continue; }
    if (dirent.isDirectory()) entries.push({ name: dirent.name, type: 'directory', sizeBytes: null });
    else if (dirent.isFile()) {
      const st = await stat(join(dirReal, dirent.name)).catch(() => null);
      entries.push({ name: dirent.name, type: 'file', sizeBytes: st?.size ?? null });
    }
  }
  entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1);
  return { path: rel, entries };
}

function fileStorePath(dataDir: string, resourceId: string, version: number, hash: string): string {
  return join(dataDir, 'files', resourceId, String(version), hash);
}

async function persistBytes(db: Db, dataDir: string, input: {
  projectId: string; grantId: string | null; kind: 'upload' | 'local' | 'web';
  displayName: string; bytes: Buffer; sourceUrl?: string; locator: Record<string, unknown>;
}): Promise<{ resourceId: string; version: number; contentHash: string; sizeBytes: number }> {
  const contentHash = createHash('sha256').update(input.bytes).digest('hex');
  const sizeBytes = input.bytes.byteLength;
  const id = randomUUID();
  const ts = nowIso();
  const storedPath = fileStorePath(dataDir, id, 1, contentHash);
  await mkdir(join(dataDir, 'files', id, '1'), { recursive: true, mode: 0o700 });
  await writeFile(storedPath, input.bytes); // 数据库与文件不跨介质原子提交：先落盘登记（孤立文件启动清理后续任务）
  db.tx(tx => {
    tx.prepare(`INSERT INTO resources(id, project_id, grant_id, kind, display_name, current_version, visibility, created_at, updated_at)
                VALUES (?,?,?,?,?,1,'private',?,?)`)
      .run(id, input.projectId, input.grantId, input.kind, input.displayName, ts, ts);
    tx.prepare(`INSERT INTO resource_versions(id, resource_id, version, content_hash, locator_manifest_json, source_url, fetched_at, stored_path, size_bytes, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), id, 1, contentHash, JSON.stringify(input.locator), input.sourceUrl ?? null, input.kind === 'web' ? ts : null, storedPath, sizeBytes, ts, ts);
  });
  return { resourceId: id, version: 1, contentHash, sizeBytes };
}

/** ReadBroker快照：读取授权内文件实际字节，登记不可变resource/version/hash。 */
export async function snapshotFile(db: Db, dataDir: string, projectId: string, grantId: string, relativePath: string): Promise<{ resourceId: string; version: number; displayName: string; sizeBytes: number; contentHash: string }> {
  const grant = requireActiveGrant(db, projectId, grantId);
  const rel = normalizeRelative(relativePath);
  checkExcludes(grant, rel);
  const target = await resolveWithinGrant(grant.canonical_root, rel);
  const st = await stat(target).catch(() => { throw new PathDenied('对象不存在或越界'); });
  if (!st.isFile()) throw new PathDenied('仅支持文件');
  if (st.size > MAX_FILE_BYTES) {
    const error = new Error('文件超过50MiB上限') as Error & { code?: string };
    error.code = 'INPUT_TOO_LARGE';
    throw error;
  }
  const bytes = await readFile(target);
  return persistBytes(db, dataDir, {
    projectId, grantId, kind: 'local', displayName: basename(rel),
    bytes, locator: { grantId, relativePath: rel, snapshotAt: nowIso() },
  }).then(r => ({ ...r, displayName: basename(rel) }));
}

/** 上传：已由multipart层限制50MiB；此处登记并落盘。 */
export async function saveUpload(db: Db, dataDir: string, projectId: string, filename: string, bytes: Buffer): Promise<{ resourceId: string; version: number; contentHash: string; sizeBytes: number }> {
  const safeName = basename(filename).replace(/[\r\n]/g, '').slice(0, 200) || '未命名';
  return persistBytes(db, dataDir, { projectId, grantId: null, kind: 'upload', displayName: safeName, bytes, locator: { originalName: safeName, uploadedAt: nowIso() } });
}

// —— 联网抓取：拒绝本地/内网地址与重定向绕过 ——

const PRIVATE_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/3'];

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function isPrivateIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return PRIVATE_V4.some(cidr => {
    const [network, bitsStr] = cidr.split('/');
    const bits = Number(bitsStr);
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    // 两侧都转无符号：带符号位网络的 & 结果为负int32，不转置会漏判192.168/10/172.16等
    return ((value & mask) >>> 0) === ((ipv4ToInt(network!) & mask) >>> 0);
  });
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('::ffff:')) return isPrivateIpv4(lower.slice(7)); // IPv4映射地址
  return false;
}

function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return true; // 无法识别的格式一律视为不可抓取
}

async function assertPublicHost(hostname: string): Promise<void> {
  if (process.env.DEBATE_ALLOW_LOCAL_FETCH === '1') return; // 仅测试钩子，回执如实记录
  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) throw new Error('HOST_DENIED');
    return;
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true }).catch(() => { throw new Error('HOST_DENIED'); });
  if (addresses.length === 0 || addresses.some(a => isPrivateAddress(a.address))) throw new Error('HOST_DENIED');
}

export interface WebFetchResult { resourceId: string; version: number; contentHash: string; sizeBytes: number; finalUrl: string }

/** 抓取并版本化：逐跳重新校验地址（防重定向绕过）；仅http/https；≤50MiB。 */
export async function fetchWebResource(db: Db, dataDir: string, projectId: string, rawUrl: string): Promise<WebFetchResult> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error('URL_INVALID'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL_INVALID');
  if (url.username || url.password) throw new Error('URL_INVALID');

  const response = await boundedFetch(url, 0);
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_FILE_BYTES) throw new Error('INPUT_TOO_LARGE');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_FILE_BYTES) throw new Error('INPUT_TOO_LARGE');
  const saved = await persistBytes(db, dataDir, {
    projectId, grantId: null, kind: 'web', displayName: basename(url.pathname) || url.hostname,
    bytes: buffer, sourceUrl: response.url || url.href,
    locator: { finalUrl: response.url || url.href, contentType, fetchedAt: nowIso() },
  });
  return { ...saved, finalUrl: response.url || url.href };
}

async function boundedFetch(url: URL, hop: number, redirectChain: string[] = []): Promise<{ ok: true; headers: Headers; arrayBuffer: () => Promise<ArrayBuffer>; url: string }> {
  if (hop > 3) throw new Error('URL_INVALID');
  await assertPublicHost(url.hostname);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'DebateWorkbench/0.2 resource-fetch' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.arrayBuffer().catch(() => undefined);
      if (!location) throw new Error('URL_INVALID');
      const next = new URL(location, url);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('URL_INVALID');
      if (redirectChain.includes(next.href)) throw new Error('URL_INVALID'); // 重定向环
      await assertPublicHost(next.hostname); // 重定向逐跳校验，不允许绕回内网
      return boundedFetch(next, hop + 1, [...redirectChain, url.href]);
    }
    if (!response.ok) throw new Error('FETCH_FAILED');
    return { ok: true, headers: response.headers, arrayBuffer: () => response.arrayBuffer(), url: response.url || url.href };
  } finally {
    clearTimeout(timer);
  }
}

// —— 资源列表与版本读取 ——

export interface ResourceRow { id: string; project_id: string; grant_id: string | null; kind: string; display_name: string; current_version: number; visibility: string; created_at: string; updated_at: string }
export interface ResourceVersionRow { id: string; resource_id: string; version: number; content_hash: string; locator_manifest_json: string; source_url: string | null; fetched_at: string | null; stored_path: string; size_bytes: number; created_at: string }

export interface ResourceView {
  id: string; projectId: string; grantId: string | null; kind: string; displayName: string;
  currentVersion: number; visibility: string; createdAt: string; updatedAt: string;
  versions: Array<{ version: number; contentHash: string; sizeBytes: number; sourceUrl: string | null; fetchedAt: string | null }>;
}

export function listResources(db: Db, projectId: string): ResourceView[] {
  const rows = db.db.prepare('SELECT * FROM resources WHERE project_id = ? ORDER BY created_at DESC, id').all(projectId) as unknown as ResourceRow[];
  return rows.map(row => ({
    id: row.id, projectId: row.project_id, grantId: row.grant_id, kind: row.kind, displayName: row.display_name,
    currentVersion: row.current_version, visibility: row.visibility, createdAt: row.created_at, updatedAt: row.updated_at,
    versions: (db.db.prepare('SELECT * FROM resource_versions WHERE resource_id = ? ORDER BY version DESC').all(row.id) as unknown as ResourceVersionRow[])
      .map(v => ({ version: v.version, contentHash: v.content_hash, sizeBytes: v.size_bytes, sourceUrl: v.source_url, fetchedAt: v.fetched_at })),
  }));
}

export function getResourceVersion(db: Db, projectId: string, resourceId: string, version: number): { resource: ResourceRow; file: ResourceVersionRow } | undefined {
  if (!/^[0-9a-f-]{36}$/.test(resourceId)) return undefined;
  const resource = db.db.prepare('SELECT * FROM resources WHERE id = ?').get(resourceId) as unknown as ResourceRow | undefined;
  if (!resource || resource.project_id !== projectId) return undefined;
  const file = db.db.prepare('SELECT * FROM resource_versions WHERE resource_id = ? AND version = ?').get(resourceId, version) as unknown as ResourceVersionRow | undefined;
  if (!file) return undefined;
  return { resource, file };
}

export function storedFileExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

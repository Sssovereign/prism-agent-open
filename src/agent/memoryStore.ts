import { createHash, randomUUID } from 'node:crypto';
import { constants, mkdirSync, readdirSync, readFileSync, lstatSync, openSync, closeSync, readSync, realpathSync, rmSync, fstatSync } from 'node:fs';
import { mkdir, readFile, writeFile, lstat, unlink, rename, open, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ApiError } from '../../contracts/errors.js';

export const MEMORY_INDEX_FILENAME = 'MEMORY.md';
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference', 'handoff'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export const MAX_MEMORY_FILE_BYTES = 64 * 1024;
export function isMemoryType(value: string): value is MemoryType { return (MEMORY_TYPES as readonly string[]).includes(value); }
export function memoryRootOf(dataDir: string, projectId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new ApiError('VALIDATION_FAILED', '项目标识无效');
    return join(dataDir, 'memory', projectId);
}
export interface MemoryFrontmatter { name?: string; description?: string; type?: MemoryType }
export function parseMemoryFrontmatter(text: string): MemoryFrontmatter {
    const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
    if (lines[0]?.trim() !== '---') return {};
    const end = lines.indexOf('---', 1); if (end < 0) return {};
    const out: MemoryFrontmatter = {}; let metadata = false;
    for (const line of lines.slice(1, end)) {
        const m = /^(\s*)([A-Za-z_-]+):\s*(.*)$/.exec(line); if (!m) continue;
        const key = m[2]!, value = (m[3] ?? '').trim().replace(/^["']|["']$/g, '');
        if (!m[1]) { metadata = key === 'metadata'; if (key === 'name' && value) out.name = value; else if (key === 'description' && value) out.description = value; else if (key === 'type' && isMemoryType(value)) out.type = value; }
        else if (metadata && key === 'type' && isMemoryType(value)) out.type = value;
    }
    return out;
}
function ensureRoot(root: string): string {
    for (const path of [dirname(resolve(root)), resolve(root)]) {
        mkdirSync(path, { recursive: true, mode: 0o700 });
        const info = lstatSync(path);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new ApiError('POLICY_DENIED', '记忆目录不能是软链接');
    }
    return realpathSync(root);
}
export function resolveMemoryPath(root: string, input: string): { absolute: string; display: string } {
    const path = typeof input === 'string' ? input.trim() : '';
    if (!path || path.includes('\0') || path.includes('\\') || isAbsolute(path) || path.split('/').some(s => !s || s === '.' || s === '..') || !path.endsWith('.md')) throw new ApiError('VALIDATION_FAILED', '记忆路径须为根内相对 .md 路径，不允许 .. 或软链接');
    const absolute = resolve(root, path);
    if (!absolute.startsWith(resolve(root) + sep)) throw new ApiError('POLICY_DENIED', '记忆路径越界');
    return { absolute, display: path };
}
/** Validate every directory component, not only the lexical file name. */
function checkedPath(root: string, input: string, createParents = false): { absolute: string; display: string } {
    const realRoot = ensureRoot(root), target = resolveMemoryPath(realRoot, input), parts = target.display.split('/'); let current = realRoot;
    for (const part of parts.slice(0, -1)) {
        current = join(current, part);
        if (createParents) { try { mkdirSync(current, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
        let info; try { info = lstatSync(current); } catch { throw new ApiError('NOT_FOUND', '记忆目录不存在'); }
        if (!info.isDirectory() || info.isSymbolicLink()) throw new ApiError('POLICY_DENIED', '记忆路径不能经过软链接');
    }
    try { const info = lstatSync(target.absolute); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new ApiError('POLICY_DENIED', '记忆目标须为普通文件，不能是链接'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return target;
}
export interface MemoryManifestEntry { filename: string; description?: string; type?: MemoryType; mtimeMs: number; sizeBytes: number }
export function scanMemoryManifest(root: string): MemoryManifestEntry[] {
    ensureRoot(root); const entries: MemoryManifestEntry[] = []; let scanned = 0;
    function walk(dir: string, depth: number): void {
        if (depth > 16 || scanned >= 500) return;
        for (const item of readdirSync(dir, { withFileTypes: true })) {
            if (scanned++ >= 500) return;
            const path = join(dir, item.name);
            if (item.isSymbolicLink()) continue;
            if (item.isDirectory()) { walk(path, depth + 1); continue; }
            if (!item.isFile() || !item.name.endsWith('.md') || item.name === MEMORY_INDEX_FILENAME) continue;
            let fd: number | undefined;
            try {
                const info = lstatSync(path); if (info.size > MAX_MEMORY_FILE_BYTES || info.nlink !== 1) continue;
                fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const buffer = Buffer.alloc(8192), count = readSync(fd, buffer, 0, buffer.length, 0);
                const front = parseMemoryFrontmatter(buffer.subarray(0, count).toString('utf8').split('\n').slice(0, 30).join('\n'));
                entries.push({ filename: relative(root, path).split(sep).join('/'), ...(front.description ? { description: front.description } : {}), ...(front.type ? { type: front.type } : {}), mtimeMs: Math.round(info.mtimeMs), sizeBytes: info.size });
            } catch { /* File removed while collecting a read-only snapshot. */ }
            finally { if (fd !== undefined) closeSync(fd); }
        }
    }
    walk(root, 0); return entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filename.localeCompare(b.filename)).slice(0, 200);
}
function safeCut(text: string, length: number): string { const cut = text.slice(0, length); return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut; }
export function formatMemoryIndex(raw: string): string {
    const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
    if (!text) return '';
    const lines = text.split('\n'); if (lines.length <= 200 && text.length <= 25000) return text;
    let retained = lines.slice(0, 200).join('\n');
    if (retained.length > 25000) { const boundary = retained.lastIndexOf('\n', 25000); retained = boundary > 0 ? retained.slice(0, boundary) : safeCut(retained, 25000); }
    const omitted = text.slice(retained.length).trimStart().split('\n')[0] ?? '';
    return `${retained}\n\n> 记忆索引已截断（最多200行／25000字符）；未载入部分从“${safeCut(omitted, 79)}${omitted.length > 79 ? '…' : ''}”开始。请按需读取原索引。`;
}
export function readMemoryIndex(root: string): string | null {
    const target = checkedPath(root, MEMORY_INDEX_FILENAME); let fd: number | undefined;
    try { fd = openSync(target.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); if(fstatSync(fd).size>MAX_MEMORY_FILE_BYTES)throw new ApiError('INPUT_TOO_LARGE','记忆索引超过64KiB上限');return formatMemoryIndex(readFileSync(fd, 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    finally { if (fd !== undefined) closeSync(fd); }
}
/** Cross-process writer lock: hash check and rename/delete belong to one critical section. */
async function locked<T>(root: string, action: () => Promise<T>): Promise<T> {
    const real = ensureRoot(root), lock = join(real, '.writer-lock'), started = Date.now();
    for (;;) {
        try { await mkdir(lock, { mode: 0o700 }); break; }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
            if (Date.now() - started > 5000) throw new ApiError('RESOURCE_BUSY', '记忆正在由其他任务更新，请稍后重新读取');
            await new Promise(r => setTimeout(r, 20));
        }
    }
    try { await writeFile(join(lock, 'owner'), String(process.pid), { mode: 0o600 }); return await action(); }
    finally { await rm(lock, { recursive: true, force: true }); }
}
async function bytesOf(root: string, path: string): Promise<Buffer> {
    const target = checkedPath(root, path); let handle;
    try { handle = await open(target.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1) throw new ApiError('POLICY_DENIED', '记忆目标不是普通文件'); if (info.size > MAX_MEMORY_FILE_BYTES) throw new ApiError('INPUT_TOO_LARGE', '记忆文件超过64KiB读取上限'); const bytes = await handle.readFile(); if (bytes.length > MAX_MEMORY_FILE_BYTES) throw new ApiError('INPUT_TOO_LARGE', '记忆文件超过64KiB读取上限'); if (bytes.includes(0)) throw new ApiError('VALIDATION_FAILED', '记忆内容不是文本'); checkedPath(root, path); return bytes; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError('NOT_FOUND', '记忆文件不存在'); throw e; }
    finally { await handle?.close(); }
}
export interface MemoryReadResult { path: string; hash: string; sizeBytes: number; totalLines: number; startLine: number; content: string; truncated: boolean }
export async function toolMemoryRead(root: string, args: { path: string; offset?: number; limit?: number }): Promise<MemoryReadResult> {
    const bytes = await bytesOf(root, args.path), lines = bytes.toString('utf8').split('\n'), offset = Math.max(1, Math.floor(args.offset ?? 1)), limit = Math.min(2000, Math.max(1, Math.floor(args.limit ?? 400))), selected = lines.slice(offset - 1, offset - 1 + limit);
    return { path: args.path, hash: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, totalLines: lines.length, startLine: offset, content: selected.map((line, i) => `${offset + i}\t${line}`).join('\n'), truncated: offset - 1 + selected.length < lines.length };
}
export async function readMemoryText(root: string, path: string): Promise<{ content: string; hash: string }> { const bytes = await bytesOf(root, path); return { content: bytes.toString('utf8'), hash: createHash('sha256').update(bytes).digest('hex') }; }
export interface MemoryWriteResult { path: string; operation: 'create' | 'modify'; hash: string; sizeBytes: number }
export async function toolMemoryWrite(root: string, args: { path: string; content: string; expectedHash: string | null }): Promise<MemoryWriteResult> {
    const bytes = Buffer.from(args.content, 'utf8'); if (bytes.length > MAX_MEMORY_FILE_BYTES) throw new ApiError('INPUT_TOO_LARGE', '单个记忆文件不超过64KiB'); if (bytes.includes(0)) throw new ApiError('VALIDATION_FAILED', '记忆内容须为文本');
    return locked(root, async () => {
        const target = checkedPath(root, args.path, true); let current: { content: string; hash: string } | undefined;
        try { current = await readMemoryText(root, args.path); } catch (e) { if (!(e instanceof ApiError && e.code === 'NOT_FOUND')) throw e; }
        if (current && (!args.expectedHash || current.hash !== args.expectedHash)) throw new ApiError('CURRENT_CONTENT_CHANGED', '记忆文件已被修改，请先 memory_read 读取最新内容');
        if (!current && args.expectedHash) throw new ApiError('VALIDATION_FAILED', '新记忆文件不应携带 expected_hash');
        const tmp = `${target.absolute}.prism-tmp-${randomUUID()}`;
        try { await writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' }); checkedPath(root, args.path); await rename(tmp, target.absolute); }
        finally { await unlink(tmp).catch(() => {}); }
        return { path: target.display, operation: current ? 'modify' : 'create', hash: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length };
    });
}
export async function toolMemoryDelete(root: string, args: { path: string; expectedHash: string }): Promise<{ path: string; operation: 'delete' }> {
    return locked(root, async () => { const current = await readMemoryText(root, args.path); if (!args.expectedHash || current.hash !== args.expectedHash) throw new ApiError('CURRENT_CONTENT_CHANGED', '记忆文件已被修改，请先 memory_read 读取最新内容'); const target = checkedPath(root, args.path); await unlink(target.absolute); return { path: target.display, operation: 'delete' }; });
}
export interface MemoryBootstrap { index: string | null; files: MemoryManifestEntry[] }
export function buildMemoryBootstrap(dataDir: string, projectId: string): MemoryBootstrap { const root = memoryRootOf(dataDir, projectId); ensureRoot(root); return { index: readMemoryIndex(root), files: scanMemoryManifest(root) }; }

export async function updateMemoryIndex(root: string, path: string, deleted = false): Promise<void> {
    if (path === MEMORY_INDEX_FILENAME) return;
    let front: MemoryFrontmatter = {};
    if (!deleted) front = parseMemoryFrontmatter((await readMemoryText(root, path)).content);
    const title = (front.description ?? front.name ?? path).replace(/[\r\n\[\]]/g, ' ').slice(0, 160);
    for (let retry = 0; retry < 4; retry++) {
        let current: { content: string; hash: string } | null = null;
        try { current = await readMemoryText(root, MEMORY_INDEX_FILENAME); } catch (e) { if (!(e instanceof ApiError && e.code === 'NOT_FOUND')) throw e; }
        const lines = (current?.content ?? '').split('\n').filter(line => line.trim() && !line.includes(`](${path})`));
        if (!deleted) lines.push(`- [${title}](${path})`);
        try { await toolMemoryWrite(root, { path: MEMORY_INDEX_FILENAME, content: lines.join('\n') + '\n', expectedHash: current?.hash ?? null }); return; }
        catch (e) { if (!(e instanceof ApiError && e.code === 'CURRENT_CONTENT_CHANGED') || retry === 3) throw e; }
    }
}

/** Called once before workers start; never reclaim a live writer's lock. */
export function recoverMemoryLocks(dataDir: string): void {
    const base=join(dataDir,'memory');let entries:import('node:fs').Dirent[];try{if(lstatSync(base).isSymbolicLink())return;entries=readdirSync(base,{withFileTypes:true});}catch{return;}
    for(const entry of entries){if(!entry.isDirectory()||entry.isSymbolicLink())continue;const lock=join(base,entry.name,'.writer-lock');try{const info=lstatSync(lock);if(!info.isDirectory()||info.isSymbolicLink())continue;let pid=0;try{pid=Number(readFileSync(join(lock,'owner'),'utf8'));}catch{}if(pid>0&&Number.isSafeInteger(pid)){try{process.kill(pid,0);continue;}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')continue;}}else if(Date.now()-info.mtimeMs<5000)continue;rmSync(lock,{recursive:true,force:true});}catch{}}
}

import { createHash, randomUUID } from 'node:crypto';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname, sep, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Db } from '../storage/db.js';
import { ApiError } from '../../contracts/errors.js';
import type { HandoffSaveInput, MemoryExtractionContext } from '../../contracts/memory.js';
import { memoryRootOf, buildMemoryBootstrap, readMemoryText, toolMemoryWrite, updateMemoryIndex } from './memoryStore.js';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function sanitizeMemoryText(text: string): string {
    return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[已移除私钥]').replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[已移除密钥]');
}
export class MemoryLifecycle {
    constructor(private db: Db, private dataDir: string) {}
    async recall(projectId: string, selected: unknown): Promise<Array<{ path: string; hash: string; content: string }>> {
        if (!Array.isArray(selected) || selected.some(p => typeof p !== 'string') || selected.length > 5) throw new ApiError('VALIDATION_FAILED', '记忆召回最多选择5项');
        const root = memoryRootOf(this.dataDir, projectId), files = buildMemoryBootstrap(this.dataDir, projectId).files;
        const results = []; let budget = 20000;
        for (const path of new Set(selected as string[])) {
            if (!files.some(f => f.filename === path)) continue;
            try { const memory = await readMemoryText(root, path); const content = sanitizeMemoryText(memory.content).slice(0, Math.min(6000, budget)); if (!content) break; results.push({ path, hash: memory.hash, content }); budget -= content.length; }
            catch (e) { if (!(e instanceof ApiError && e.code === 'NOT_FOUND')) throw e; }
        }
        return results;
    }
    prepare(runId: string, attemptId: string, projectId: string, conversationId: string): MemoryExtractionContext {
        if (this.db.db.prepare("SELECT id FROM tool_invocations WHERE run_id=? AND tool_name IN ('memory_write','memory_delete','memory_handoff_save') AND state='succeeded' LIMIT 1").get(runId)) return { skipped: 'direct-memory-write' };
        const rows = this.db.db.prepare("SELECT author_type AS role,content_json FROM messages WHERE run_id=? AND state='published' AND visibility='public' AND author_type='user' ORDER BY seq").all(runId) as unknown as Array<{ role: string; content_json: string }>;
        const latest = this.db.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='message.completed' ORDER BY seq DESC LIMIT 1").get(runId) as { payload_json: string } | undefined;
        const assistant = latest ? JSON.parse(latest.payload_json) : {};
        if (!rows.length || typeof assistant.content !== 'string' || !assistant.content.trim()) return { skipped: 'no-conversation-prose' };
        const boundaryHash = hash(runId + JSON.stringify(rows) + assistant.content);
        const existing = this.db.db.prepare('SELECT id,state FROM memory_extractions WHERE conversation_id=? AND boundary_hash=?').get(conversationId, boundaryHash) as { id: string; state: string } | undefined;
        if (existing?.state === 'completed' || existing?.state === 'running') return { skipped: 'already-processed' };
        const id = existing?.id ?? randomUUID(), now = new Date().toISOString();
        this.db.db.prepare("INSERT INTO memory_extractions(id,project_id,conversation_id,run_id,attempt_id,boundary_hash,state,created_at) VALUES (?,?,?,?,?,?,'running',?) ON CONFLICT(conversation_id,boundary_hash) DO UPDATE SET attempt_id=excluded.attempt_id,state='running',created_at=excluded.created_at,ended_at=NULL,error=NULL").run(id, projectId, conversationId, runId, attemptId, boundaryHash, now);
        const messages = rows.map(r => ({ role: r.role, text: sanitizeMemoryText(String(JSON.parse(r.content_json).text ?? '')).slice(0, 4000) }));
        messages.push({ role: 'assistant', text: sanitizeMemoryText(assistant.content).slice(0, 6000) });
        let budget = 12000; const bounded = messages.slice(-12).reverse().map(m => { const text = m.text.slice(0, Math.max(0, budget)); budget -= text.length; return { ...m, text }; }).reverse().filter(m => m.text);
        return { operationId: id, messages: bounded, files: buildMemoryBootstrap(this.dataDir, projectId).files };
    }
    finish(operationId: string, attemptId: string, state: 'completed' | 'failed' | 'cancelled', error?: string): boolean {
        return this.db.db.prepare("UPDATE memory_extractions SET state=?,ended_at=?,error=? WHERE id=? AND attempt_id=? AND state='running'").run(state, new Date().toISOString(), error?.slice(0, 300) ?? null, operationId, attemptId).changes === 1;
    }
    cancel(attemptId: string): void { this.db.db.prepare("UPDATE memory_extractions SET state='cancelled',ended_at=? WHERE attempt_id=? AND state='running'").run(new Date().toISOString(), attemptId); }
    recover(): void { this.db.db.prepare("UPDATE memory_extractions SET state='cancelled',ended_at=? WHERE state='running'").run(new Date().toISOString()); }
    private async stateFile(workspace: string, sourcePath: string): Promise<{ path: string; content: string; hash: string }> {
        if (!/^(?:[\w\-.]+\/)*PROJECT_STATE\.md$/.test(sourcePath) || sourcePath.split('/').some(x => x === '.' || x === '..')) throw new ApiError('VALIDATION_FAILED', '交接来源须为项目内的PROJECT_STATE.md');
        const root = resolve(workspace), path = resolve(root, sourcePath); if (!path.startsWith(root + sep)) throw new ApiError('POLICY_DENIED', '交接来源越界');
        let parent = dirname(path); while (parent !== root) { const st = await lstat(parent); if (!st.isDirectory() || st.isSymbolicLink()) throw new ApiError('POLICY_DENIED', '交接来源不能经过软链接'); parent = dirname(parent); }
        const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try { const info = await file.stat(); if (!info.isFile() || info.size > 1024 * 1024) throw new ApiError('INPUT_TOO_LARGE', '交接状态文件超过1MiB或不是普通文件'); const content = await file.readFile('utf8'); return { path: sourcePath, content, hash: hash(content) }; }
        finally { await file.close(); }
    }
    async saveHandoff(projectId: string, runId: string, workspace: string, input: HandoffSaveInput) {
        if (!input || typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 3000 || !/^[a-f0-9]{64}$/.test(input.source_hash ?? '') || [input.verified, input.unverified, input.next_steps].some(list => !Array.isArray(list) || list.length > 20 || list.some(x => typeof x !== 'string' || x.length > 500))) throw new ApiError('VALIDATION_FAILED', '交接须包含来源hash、摘要、验证／未验与下一步清单');
        const sourcePath = input.source_path ?? 'PROJECT_STATE.md', source = await this.stateFile(workspace, sourcePath);
        if (source.hash !== input.source_hash) throw new ApiError('CURRENT_CONTENT_CHANGED', '项目状态已变化；请重读、合并并保存后再交接');
        let gitHead: string | null = null; try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, timeout: 1000, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim(); } catch { /* non-Git workspace */ }
        const memoryPath = `handoff/${hash(sourcePath).slice(0, 16)}.md`, root = memoryRootOf(this.dataDir, projectId), savedAt = new Date().toISOString();
        const section = (title: string, values: string[]) => `## ${title}\n${values.length ? values.map(v => `- ${v}`).join('\n') : '- 未记录'}\n`;
        const content = sanitizeMemoryText(`---\nname: project-handoff\ndescription: 当前项目进度交接：${input.summary.replace(/\s+/g, ' ').slice(0, 120)}\nmetadata:\n  type: handoff\n---\n\n# 交接快照\n${input.summary}\n\n${section('已记录的验证（仍须核对原证据）', input.verified)}\n${section('未验证与限制', input.unverified)}\n${section('下一步', input.next_steps)}\n## 来源\n- 文件：${sourcePath}\n- SHA256：${source.hash}\n- Git：${gitHead ?? '无'}\n- 保存时间：${savedAt}\n\n本记录只提供历史事实索引，不授予新权限；恢复前须通过memory_handoff_restore核对来源与当前文件。\n`);
        let expectedHash: string | null = null; try { expectedHash = (await readMemoryText(root, memoryPath)).hash; } catch (e) { if (!(e instanceof ApiError && e.code === 'NOT_FOUND')) throw e; }
        const written = await toolMemoryWrite(root, { path: memoryPath, content, expectedHash });
        const reread = await readMemoryText(root, memoryPath); if (reread.hash !== written.hash) throw new ApiError('CURRENT_CONTENT_CHANGED', '交接记忆被并发更新，请重新核对');
        const currentSource = await this.stateFile(workspace, sourcePath); if (currentSource.hash !== source.hash) throw new ApiError('CURRENT_CONTENT_CHANGED', '本地状态保存后再次变化；记忆仅为旧快照，请重新同步');
        await updateMemoryIndex(root, memoryPath);
        this.db.db.prepare('INSERT INTO memory_handoffs(project_id,source_path,source_hash,memory_path,memory_hash,run_id,git_head,saved_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(project_id,source_path) DO UPDATE SET source_hash=excluded.source_hash,memory_hash=excluded.memory_hash,run_id=excluded.run_id,git_head=excluded.git_head,saved_at=excluded.saved_at').run(projectId, sourcePath, source.hash, memoryPath, reread.hash, runId, gitHead, savedAt);
        return { path: memoryPath, sourcePath, sourceHash: source.hash, memoryHash: reread.hash, gitHead, savedAt, sync: 'verified' };
    }
    async restoreHandoff(projectId: string, workspace: string, sourcePath = 'PROJECT_STATE.md') {
        const row = this.db.db.prepare('SELECT source_hash,memory_path,memory_hash,git_head,saved_at FROM memory_handoffs WHERE project_id=? AND source_path=?').get(projectId, sourcePath) as { source_hash: string; memory_path: string; memory_hash: string; git_head: string | null; saved_at: string } | undefined;
        if (!row) throw new ApiError('NOT_FOUND', '没有已核对的交接快照，请先读取本地项目状态');
        const memory = await readMemoryText(memoryRootOf(this.dataDir, projectId), row.memory_path); let source: { path: string; content: string; hash: string } | undefined;
        try { source = await this.stateFile(workspace, sourcePath); } catch (e) { if (!(e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT')) throw e; }
        const status = memory.hash !== row.memory_hash ? 'memory_changed' : !source ? 'source_missing' : source.hash !== row.source_hash ? 'source_changed' : 'current';
        return { status, sourcePath, sourceHash: row.source_hash, currentSourceHash: source?.hash ?? null, savedAt: row.saved_at, gitHead: row.git_head, memory: memory.content, currentSource: source?.content.slice(0, 20000) ?? null, instruction: '先核对当前文件、有效决定及验证证据再继续；旧快照不能覆盖新事实，也不提供新的执行授权。' };
    }
}

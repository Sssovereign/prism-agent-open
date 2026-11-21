import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, realpathSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import type { Db } from '../storage/db.js';
import { ApiError } from '../../contracts/errors.js';
import type { FileRewindPreview } from '../../contracts/deliverables.js';
import { resolveAgentPath } from './toolExec.js';

interface Change {
  id: string; rowid: number; relative_path: string; operation: string; before_hash: string | null;
  after_hash: string | null; backup_ref: string | null; canonical_root: string; revoked_at: string | null;
  target_path: string | null; before_mode: number | null; reverted_at: string | null;
}
interface Plan { path: string; display: string; records: Change[]; before: Buffer | null; current: Buffer | null; mode: number; currentMode: number; currentHash: string; beforeHash: string }
const hash = (bytes: Buffer | null) => bytes === null ? '' : createHash('sha256').update(bytes).digest('hex');
function sameBytes(a: Buffer | null, b: Buffer | null): boolean { return a === null || b === null ? a === b : a.equals(b); }
/** replay调用沿用原结果里的changeRecordId；撤销后的成功历史不能再冒充已存在的副作用。 */
export function wasFileChangeReverted(db: Db, resultJson: string | null): boolean {
  if (!resultJson) return false;
  try { const id = JSON.parse(resultJson).changeRecordId; return typeof id === 'string' && !!db.db.prepare('SELECT id FROM change_records WHERE id=? AND reverted_at IS NOT NULL').get(id); }
  catch { return false; }
}
function current(path: string): { bytes: Buffer | null; mode: number } {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error('unsupported_checkpoint');
    if (info.size > 50 * 1024 * 1024) throw new Error('file_read_failed');
    return { bytes: readFileSync(path), mode: info.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: null, mode: 0o644 };
    throw error;
  }
}
function canonicalTarget(c: Change): string {
  const path = resolveAgentPath(c.canonical_root, c.relative_path);
  const target = join(realpathSync(dirname(path)), path.slice(dirname(path).length + 1));
  // 修改软链的旧记录缺少目标身份，不能猜测原始目标；新记录仍需确保父目录未换向。
  if (c.target_path && resolve(c.target_path) !== target) throw new Error('unsupported_checkpoint');
  if (!c.target_path && target !== resolve(path)) throw new Error('unsupported_checkpoint');
  return target;
}
function backup(dataDir: string, runId: string, c: Change): Buffer | null {
  if (c.before_hash === null) return null;
  if (!c.backup_ref) throw new Error('checkpoint_missing');
  try {
    const path = realpathSync(c.backup_ref), root = realpathSync(join(dataDir, 'backups', runId));
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error();
    const bytes = readFileSync(path);
    if (hash(bytes) !== c.before_hash) throw new Error();
    return bytes;
  } catch { throw new Error('checkpoint_unreadable'); }
}

/** ZCode fileRewindPreview / fileRewindApply 语义：本轮文件工具改动，先全量预检；有冲突则整批拒绝。 */
export function prepareFileRewind(db: Db, dataDir: string, runId: string): { preview: FileRewindPreview; plans: Plan[] } {
  const records = db.db.prepare(`SELECT cr.*,cr.rowid,p.backup_ref,g.canonical_root,g.revoked_at
    FROM change_records cr LEFT JOIN publications p ON p.id=cr.publication_id
    JOIN workspace_grants g ON g.id=cr.grant_id WHERE cr.run_id=? AND cr.state='applied' ORDER BY cr.rowid`).all(runId) as unknown as Change[];
  const preview: FileRewindPreview = { canApply: false, previewToken: '', reverted: records.length > 0 && records.every(c => c.reverted_at), safeFiles: [], unsafeFiles: [], ignoredFiles: [] };
  const bash = db.db.prepare("SELECT count(*) AS n FROM tool_invocations WHERE run_id=? AND tool_name='bash' AND state IN ('succeeded','unknown','running')").get(runId) as { n: number };
  if (bash.n) preview.ignoredFiles.push({ path: 'bash / shell', operationCount: bash.n, reason: 'bash_ignored' });
  const groups = new Map<string, Change[]>(), plans: Plan[] = [];
  for (const c of records.filter(c => !c.reverted_at)) {
    try {
      if (c.revoked_at) throw new Error('grant_revoked');
      const target = canonicalTarget(c);
      groups.set(target, [...(groups.get(target) ?? []), c]);
    } catch (error) { preview.unsafeFiles.push({ path: c.relative_path, operationCount: 1, reason: error instanceof Error && ['grant_revoked', 'unsupported_checkpoint'].includes(error.message) ? error.message : 'unsupported_checkpoint' }); }
  }
  for (const [path, changes] of groups) {
    const first = changes[0]!, last = changes.at(-1)!;
    try {
      // 不能绕过较晚轮次的写入，即使较晚轮次恰好写回同样内容。
      const later = db.db.prepare(`SELECT cr.*,cr.rowid,g.canonical_root FROM change_records cr JOIN workspace_grants g ON g.id=cr.grant_id
        WHERE cr.rowid>? AND cr.state='applied' AND cr.reverted_at IS NULL AND cr.run_id<>?`).all(last.rowid, runId) as unknown as Change[];
      if (later.some(c => resolve(c.target_path ?? resolveAgentPath(c.canonical_root,c.relative_path)) === path)) throw new Error('external_modified');
      for (let i = 1; i < changes.length; i++) if ((changes[i]!.before_hash ?? '') !== (changes[i - 1]!.after_hash ?? '')) throw new Error('external_modified');
      // 所有备份都校验，避免跨越损坏的中间检查点。
      const snapshots = changes.map(c => backup(dataDir, runId, c));
      const observed = current(path);
      const currentHash = hash(observed.bytes);
      if (currentHash !== (last.after_hash ?? '')) throw new Error('external_modified');
      plans.push({ path, display: first.relative_path, records: changes, before: snapshots[0]!, current: observed.bytes, currentMode: observed.mode, currentHash, beforeHash: first.before_hash ?? '', mode: first.before_mode ?? observed.mode });
      preview.safeFiles.push({ path: first.relative_path, operationCount: changes.length });
    } catch (error) {
      const reason = error instanceof Error && ['external_modified','checkpoint_missing','checkpoint_unreadable','unsupported_checkpoint'].includes(error.message) ? error.message : 'file_read_failed';
      preview.unsafeFiles.push({ path: first.relative_path, operationCount: changes.length, reason });
    }
  }
  preview.canApply = plans.length > 0 && preview.unsafeFiles.length === 0;
  preview.previewToken = createHash('sha256').update(JSON.stringify({ records: records.map(c => [c.id,c.reverted_at,c.before_hash,c.after_hash,c.target_path]), safe: preview.safeFiles, unsafe: preview.unsafeFiles, current: plans.map(p => p.currentHash) })).digest('hex');
  return { preview, plans };
}

function replace(path: string, bytes: Buffer | null, mode: number): void {
  if (bytes === null) { unlinkSync(path); return; }
  const tmp = `${path}.prism-rewind-${randomUUID()}`;
  try { writeFileSync(tmp, bytes, { mode, flag: 'wx' }); renameSync(tmp, path); }
  finally { try { unlinkSync(tmp); } catch { /* rename already consumed it */ } }
}

/** 同步预检与提交不向事件循环让出，避免本服务工具执行插入；外部进程的并发修改仍以逐文件内容复检保护。 */
export function applyFileRewind(db: Db, dataDir: string, runId: string, token: string): FileRewindPreview {
  const run = db.db.prepare('SELECT status,project_id FROM runs WHERE id=?').get(runId) as { status: string; project_id: string };
  if (!['succeeded','failed','cancelled'].includes(run.status)) throw new ApiError('RUN_STILL_ACTIVE', '请先停止本轮任务，再撤销文件');
  if (db.db.prepare("SELECT id FROM runs WHERE project_id=? AND status NOT IN ('succeeded','failed','cancelled') LIMIT 1").get(run.project_id)
    // 执行进程只拦截本项目：其他项目的worker（或残留stopped前状态）不应永久挡住本项目的撤销。
    || db.db.prepare(`SELECT w.id FROM worker_instances w JOIN attempts a ON a.id=w.attempt_id JOIN phase_tasks pt ON pt.id=a.phase_task_id
      JOIN runs r ON r.id=pt.run_id WHERE r.project_id=? AND w.state IN ('starting','running','stopping') LIMIT 1`).get(run.project_id))
    throw new ApiError('CONVERSATION_BUSY', '仍有任务或执行进程未停止，请稍后重试撤销');
  const { preview, plans } = prepareFileRewind(db, dataDir, runId);
  if (preview.reverted) return preview;
  if (!preview.canApply || preview.previewToken !== token) throw new ApiError('CURRENT_CONTENT_CHANGED', '预检结果已变化或存在冲突，请重新检查；未写入任何文件');
  const dir = join(dataDir, 'rewinds', runId, randomUUID());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 保留逐文件恢复副本和意图，进程突然退出时可核对；不宣称文件系统与SQLite跨介质原子。
  plans.forEach((p, i) => { if (p.current !== null) writeFileSync(join(dir, `${i}.before`), p.current, { mode: 0o600 }); });
  const manifest = plans.map((p, i) => ({ path: p.path, backup: p.current === null ? null : `${i}.before`, mode: p.currentMode, beforeHash: p.currentHash, afterHash: p.beforeHash, records: p.records.map(c => c.id) }));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ state: 'prepared', files: manifest }), { mode: 0o600 });
  const applied: Plan[] = [];
  try {
    for (const p of plans) {
      if (canonicalTarget(p.records[0]!) !== p.path || !sameBytes(current(p.path).bytes, p.current)) throw new ApiError('CURRENT_CONTENT_CHANGED','文件在撤销过程中发生变化');
      // create→delete 本轮净效果为空时无需 unlink 不存在的文件。
      if (p.before !== null || p.current !== null) replace(p.path, p.before, p.mode);
      applied.push(p);
    }
    db.tx(tx => {
      const ts = new Date().toISOString();
      for (const p of plans) for (const c of p.records) tx.prepare('UPDATE change_records SET reverted_at=?,updated_at=? WHERE id=?').run(ts,ts,c.id);
      const seq=(tx.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM run_events WHERE run_id=?').get(runId) as {seq:number}).seq;
      tx.prepare("INSERT INTO run_events(run_id,seq,event_id,visibility,type,occurred_at,payload_json) VALUES (?,?,?,'public','workspace.files_reverted',?,?)").run(runId,seq,randomUUID(),ts,JSON.stringify({files:plans.map(p=>p.display)}));
      tx.prepare('UPDATE runs SET updated_at=? WHERE id=?').run(ts,runId);
    });
  } catch (error) {
    let restored = true;
    for (const p of applied.reverse()) {
      try { if (!sameBytes(current(p.path).bytes, p.before)) throw new Error(); if (p.current !== null || p.before !== null) replace(p.path,p.current,p.currentMode); }
      catch { restored = false; }
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ state: restored ? 'rolled_back' : 'needs_reconciliation', files: manifest }), { mode: 0o600 });
    throw new ApiError(restored ? 'CURRENT_CONTENT_CHANGED' : 'RECONCILIATION_REQUIRED', restored ? '撤销未完成，已恢复本次写入；请重新预检' : '撤销未完成，部分文件需核对，恢复副本已保留');
  }
  // 成功状态以数据库为准，回执写入失败不再触发文件回滚。
  try { writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ state: 'applied', files: manifest }), { mode: 0o600 }); } catch { /* prepared manifest plus DB timestamps remain */ }
  return prepareFileRewind(db,dataDir,runId).preview;
}

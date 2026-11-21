// 目录选择票据：原生适配器返回路径，HTTP仅暴露创建者的一次性票据。
// 选择路径存票据selected_path（仅可信侧）；任何API响应不回显绝对路径，grant亦只出目录名。
import { createLocalDirectoryChooser, type DirectoryChooser } from './directoryChooser.js';
import { canonicalDirectory } from './paths.js';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Db } from '../storage/db.js';

export const TICKET_TTL_MS = 10 * 60_000;

export interface PickerTicketRow {
  id: string; user_id: string; project_id: string; nonce_hash: string; state: 'pending' | 'selected' | 'cancelled' | 'failed' | 'expired' | 'claimed';
  expires_at: string; grant_id: string | null; created_at: string; updated_at: string; selected_path: string | null;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function nowIso(): string { return new Date().toISOString(); }

function touch(db: Db, id: string, fields: Partial<{ state: string; grant_id: string | null; selected_path: string | null }>): void {
  const sets = ['updated_at = ?'];
  const args: unknown[] = [nowIso()];
  for (const [column, value] of Object.entries(fields)) { sets.push(`${column} = ?`); args.push(value); }
  args.push(id);
  db.tx(tx => tx.prepare(`UPDATE picker_tickets SET ${sets.join(', ')} WHERE id = ?`).run(...(args as never[])));
}

/** 读取票据并按需过期；不存在/他人票据均返回undefined（同形404由路由层处理）。 */
export function getTicket(db: Db, ticketId: string, userId: string): PickerTicketRow | undefined {
  if (!/^[0-9a-f-]{36}$/.test(ticketId)) return undefined;
  const row = db.db.prepare('SELECT * FROM picker_tickets WHERE id = ?').get(ticketId) as unknown as PickerTicketRow | undefined;
  if (!row || row.user_id !== userId) return undefined;
  let state = row.state;
  if (['pending', 'selected'].includes(state) && new Date(row.expires_at).getTime() <= Date.now()) {
    touch(db, row.id, { state: 'expired', selected_path: null });
    active.get(db)?.get(row.id)?.abort();
    state = 'expired';
  }
  return { ...row, state, selected_path: state === 'expired' ? null : row.selected_path };
}

/**
 * 发起选择：登记pending票据（nonce原文仅本次返回），随后在本机弹出原生目录选择框。
 * 选择结果异步回写票据；HTTP请求立即返回202，前端轮询GET /directory-pickers/:ticket。
 */
export function startPicker(db: Db, userId: string, projectId: string, chooser: DirectoryChooser = createLocalDirectoryChooser()): { ticketId: string; nonce: string; expiresAt: string } {
  chooser.assertAvailable();
  const id = randomUUID();
  const nonce = randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + TICKET_TTL_MS).toISOString();
  const ts = nowIso();
  db.tx(tx => tx.prepare(
    "INSERT INTO picker_tickets(id, user_id, project_id, nonce_hash, state, expires_at, created_at, updated_at) VALUES (?,?,?,?,'pending',?,?,?)"
  ).run(id, userId, projectId, sha256(nonce), expiresAt, ts, ts));
  runNativeChooser(db, id, expiresAt, chooser);
  return { ticketId: id, nonce, expiresAt };
}

const active = new WeakMap<Db, Map<string, AbortController>>();
export function closeFilePickers(db: Db): void {
  const pending = active.get(db);
  active.delete(db);
  for (const [id, controller] of pending ?? []) {
    db.db.prepare("UPDATE picker_tickets SET state='cancelled',selected_path=NULL WHERE id=? AND state='pending'").run(id);
    controller.abort();
  }
}
export function cancelPicker(db: Db, id: string, userId: string, nonce: string): boolean {
  const row = getTicket(db, id, userId);
  if (!row || row.nonce_hash !== sha256(nonce)) return false;
  db.db.prepare("UPDATE picker_tickets SET state='cancelled',selected_path=NULL WHERE id=? AND state IN ('pending','selected')").run(id);
  active.get(db)?.get(id)?.abort();
  return true;
}
function runNativeChooser(db: Db, id: string, expiresAt: string, chooser: DirectoryChooser): void {
  let pending = active.get(db);
  if (!pending) { pending = new Map(); active.set(db, pending); }
  const controller = new AbortController();
  pending.set(id, controller);
  const finish = (state: string, path: string | null = null) => {
    if (active.get(db) !== pending || !pending.delete(id)) return;
    const now = nowIso();
    db.db.prepare("UPDATE picker_tickets SET state=?,selected_path=?,updated_at=? WHERE id=? AND state='pending' AND expires_at>?").run(state, path, now, id, now);
    db.db.prepare("UPDATE picker_tickets SET state='expired',selected_path=NULL,updated_at=? WHERE id=? AND state='pending' AND expires_at<=?").run(now, id, now);
  };
  void chooser.choose(id, Date.parse(expiresAt), 'grant', controller.signal)
    .then(result => finish(result.state, result.state === 'selected' ? result.path : null), () => finish('failed'));
}

export interface GrantRow { id: string; project_id: string; canonical_root: string; access: 'read' | 'write'; revision: number; selected_by: string; revoked_at: string | null; excludes_json: string; created_at: string; updated_at: string; is_primary: number }

function normalize(input: string): string {
  const parts = input.split(/[\\/]+/).filter(p => p !== '' && p !== '.' && p !== '..');
  return parts.join('/');
}

/** 仅创建者凭nonce领取：state=selected、未过期、项目匹配才产生grant；票据转claimed。 */
export function claimGrant(db: Db, input: { ticketId: string; nonce: string; userId: string; projectId: string; access: 'read' | 'write'; excludes?: string[] }): GrantRow | undefined {
  const row = getTicket(db, input.ticketId, input.userId);
  if (!row) return undefined;
  if (row.nonce_hash !== sha256(input.nonce)) return undefined;
  if (row.state !== 'selected' || !row.selected_path) return undefined;
  if (row.project_id !== input.projectId) return undefined;
  let root: string;
  try { root = canonicalDirectory(row.selected_path); } catch { return undefined; }
  const id = randomUUID();
  const ts = nowIso();
  const excludes = (input.excludes ?? []).map(e => normalize(e));
  const grant: GrantRow = {
    id, project_id: input.projectId, canonical_root: root, access: input.access, revision: 1,
    selected_by: input.userId, revoked_at: null, excludes_json: JSON.stringify(excludes), created_at: ts, updated_at: ts, is_primary: 0,
  };
  db.tx(tx => {
    const claimed = tx.prepare("UPDATE picker_tickets SET state='claimed',selected_path=NULL,updated_at=? WHERE id=? AND state='selected' AND expires_at>?").run(ts, input.ticketId, ts);
    if (claimed.changes !== 1) throw new Error('Picker ticket expired');
    tx.prepare(`INSERT INTO workspace_grants(id, project_id, canonical_root, access, revision, selected_by, revoked_at, excludes_json, created_at, updated_at, is_primary)
                VALUES (?,?,?,?,?,?,NULL,?,?,?,0)`)
      .run(grant.id, grant.project_id, grant.canonical_root, grant.access, grant.revision, grant.selected_by, grant.excludes_json, grant.created_at, grant.updated_at);
    tx.prepare("UPDATE picker_tickets SET grant_id = ? WHERE id = ? AND state = 'claimed'").run(id, input.ticketId);
  });
  return grant;
}

export function getGrant(db: Db, projectId: string, grantId: string): GrantRow | undefined {
  if (!/^[0-9a-f-]{36}$/.test(grantId)) return undefined;
  const row = db.db.prepare('SELECT * FROM workspace_grants WHERE id = ?').get(grantId) as unknown as GrantRow | undefined;
  if (!row || row.project_id !== projectId) return undefined;
  return row;
}

/** 授权脱敏视图：canonical_root绝不外显，仅目录名。 */
export function grantView(row: GrantRow): { id: string; access: string; revision: number; displayName: string; revoked: boolean; excludes: string[]; createdAt: string; isPrimary: boolean } {
  return {
    id: row.id, access: row.access, revision: row.revision,
    displayName: basename(row.canonical_root) || '已选目录', revoked: row.revoked_at !== null,
    excludes: JSON.parse(row.excludes_json) as string[], createdAt: row.created_at,
    isPrimary: row.is_primary === 1,
  };
}

export function revokeGrant(db: Db, projectId: string, grantId: string): boolean {
  const row = getGrant(db, projectId, grantId);
  if (!row || row.revoked_at !== null) return false;
  const ts = nowIso();
  db.tx(tx => {
    tx.prepare('UPDATE workspace_grants SET revoked_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, grantId);
    // 移除主要目录时提升剩余最早授权为主要（ZCode ProjectEditor：primary 随首个剩余 root 保持存在）。
    if (row.is_primary === 1) {
      tx.prepare(`UPDATE workspace_grants SET is_primary = 1, updated_at = ? WHERE id = (
        SELECT id FROM workspace_grants WHERE project_id = ? AND revoked_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1)`).run(ts, projectId);
    }
  });
  return true;
}

/** 设为主要工作目录：事务内清掉项目内其他主要标记（仅影响后续任务的工作目录绑定）。 */
export function setPrimaryGrant(db: Db, projectId: string, grantId: string): GrantRow | undefined {
  const row = getGrant(db, projectId, grantId);
  if (!row || row.revoked_at !== null) return undefined;
  const ts = nowIso();
  db.tx(tx => {
    tx.prepare('UPDATE workspace_grants SET is_primary = 0, updated_at = ? WHERE project_id = ? AND revoked_at IS NULL').run(ts, projectId);
    tx.prepare('UPDATE workspace_grants SET is_primary = 1, updated_at = ? WHERE id = ?').run(ts, grantId);
  });
  return getGrant(db, projectId, grantId);
}

/** 测试出口：将票据置为已选择并注入路径（生产流程由可信适配器写入）。不导出到HTTP层。 */
export function markTicketSelectedForTest(db: Db, ticketId: string, path: string): void {
  touch(db, ticketId, { state: 'selected', selected_path: path });
}

// /api/v1/projects：私有项目列表/创建/查询/改名与归档。归属校验失败一律404（不泄露存在性）。
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ok, okList, fail, encodeCursor, decodeCursor, pageSizeOf } from '../http.js';
import type { Db } from '../storage/db.js';
import type { DirectoryChooser } from '../files/directoryChooser.js';
import { LocalProjectPicker, selectionView } from './localPicker.js';
import type { ReplaceFolderInput } from './localPicker.js';
import { grantView } from '../files/picker.js';
import type { GrantRow } from '../files/picker.js';
import { registerSidebarRoutes } from './sidebar.js';
import type {ApprovalMode} from '../../contracts/permissions.js';

export interface ProjectRow { id: string; owner_user_id: string; name: string; archived_at: string | null; created_at: string; updated_at: string; approval_mode?:ApprovalMode }

export function getOwnedProject(db: Db, projectId: string, userId: string): ProjectRow | undefined {
  const row = db.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as unknown as ProjectRow | undefined;
  if (!row || row.owner_user_id !== userId) return undefined; // 归属不符与不存在同形：404
  return row;
}

export function requireOwnedProject(db: Db, projectId: string, userId: string): ProjectRow {
  const row = getOwnedProject(db, projectId, userId);
  if (!row) throw new NotFound();
  return row;
}

export class NotFound extends Error {}

export function projectView(row: ProjectRow): { id: string; name: string; archived: boolean; createdAt: string; updatedAt: string; approvalMode:ApprovalMode } {
  return { id: row.id, name: row.name, archived: row.archived_at !== null, createdAt: row.created_at, updatedAt: row.updated_at, approvalMode:row.approval_mode??'auto' };
}

// 项目详情与编辑响应共用：主要目录在前；displayName 沿用 grantView 的路径隐私策略（不回传绝对路径）。
export function projectGrants(db: Db, projectId: string) {
  const rows = db.db.prepare('SELECT * FROM workspace_grants WHERE project_id=? AND revoked_at IS NULL ORDER BY is_primary DESC, created_at ASC, id ASC').all(projectId) as unknown as GrantRow[];
  return rows.map(grantView);
}

export interface AuthedRequest { session?: { userId: string; username: string } }
export type AuthExtractor = (req: unknown) => { userId: string; username: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerProjectRoutes(app: FastifyInstance, db: Db, auth: AuthExtractor, directoryChooser?: DirectoryChooser): void {
  const reqAuth = (req: any) => auth(req) as { userId: string };
  const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  registerSidebarRoutes(app, db, auth);
  const picker = new LocalProjectPicker(db, directoryChooser);
  app.addHook('onClose', async () => picker.close());
  app.post('/api/v1/project-directory-pickers', { schema: { body: { type: 'object', additionalProperties: false, properties: {} } } }, async (req, reply) => {
    return ok(req, reply, picker.start(reqAuth(req).userId), 202);
  });
  app.get<{ Params: { ticket: string } }>('/api/v1/project-directory-pickers/:ticket', async (req, reply) => {
    const row = picker.get(req.params.ticket, reqAuth(req).userId);
    if (!row) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    return ok(req, reply, selectionView(row));
  });
  app.delete<{ Params: { ticket: string }; Body: { nonce: string } }>('/api/v1/project-directory-pickers/:ticket', { schema: {
    body: { type:'object', required:['nonce'], additionalProperties:false, properties:{nonce:{type:'string',minLength:1,maxLength:128}} },
  } }, async (req, reply) => {
    if (!picker.cancel(req.params.ticket, reqAuth(req).userId, req.body.nonce)) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    return ok(req, reply, { cancelled: true });
  });
  // 新建本地项目的正式入口：文件夹必填（folders 多文件夹，首个为主要目录；folder 为旧单文件夹兼容）。
  const folderSchema = { type:'object', required:['pickerTicket','nonce','access'], additionalProperties:false,
    properties:{pickerTicket:{type:'string',pattern:uuidPattern},nonce:{type:'string',minLength:1,maxLength:128},access:{enum:['read','write']}} };
  app.post<{ Body: { name: string; folder?: { pickerTicket: string; nonce: string; access: 'read' | 'write' }; folders?: Array<{ pickerTicket: string; nonce: string; access: 'read' | 'write' }> } }>('/api/v1/projects/local', { schema: { body: {
    type:'object', required:['name'], additionalProperties:false,
    properties:{ name:{type:'string',minLength:1,maxLength:120},
      folder: folderSchema,
      folders:{type:'array',minItems:1,maxItems:10,items:folderSchema} },
  } } }, async (req, reply) => {
    const name = req.body.name.trim();
    if (!name) return fail(req, reply, 'VALIDATION_FAILED', '项目名不能为空');
    const folders = req.body.folders ?? (req.body.folder ? [req.body.folder] : []);
    if (!folders.length) return fail(req, reply, 'VALIDATION_FAILED', '请至少选择一个本地文件夹');
    const result = picker.create(reqAuth(req).userId, name, folders);
    return ok(req, reply, { ...projectView(result.project), grant: grantView(result.grant), grants: result.grants.map(grantView) }, 201);
  });

  app.get('/api/v1/projects', async (req, reply) => {
    const { userId } = reqAuth(req);
    const offset = decodeCursor((req.query as { cursor?: string }).cursor);
    const limit = pageSizeOf((req.query as { limit?: string }).limit);
    const rows = db.db.prepare('SELECT * FROM projects WHERE owner_user_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?')
      .all(userId, limit + 1, offset) as unknown as ProjectRow[];
    const nextCursor = rows.length > limit ? encodeCursor(offset + limit) : null;
    return okList(req, reply, rows.slice(0, limit).map(projectView), nextCursor);
  });

  app.post('/api/v1/projects', { schema: { body: {
    type: 'object', required: ['name'], additionalProperties: false,
    properties: { name: { type: 'string', minLength: 1, maxLength: 120 } },
  } } }, async (req, reply) => {
    const { userId } = reqAuth(req);
    const name = (req.body as { name: string }).name.trim();
    if (!name) return fail(req, reply, 'VALIDATION_FAILED', '项目名不能为空');
    const id = randomUUID();
    const now = new Date().toISOString();
    db.tx(tx => tx.prepare('INSERT INTO projects(id, owner_user_id, name, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(id, userId, name, now, now));
    const row = db.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow;
    return ok(req, reply, projectView(row), 201);
  });

  app.get<{ Params: { id: string } }>('/api/v1/projects/:id', { schema: { params: {
    type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: uuidPattern } },
  } } }, async (req, reply) => {
    const { userId } = reqAuth(req);
    const row = getOwnedProject(db, req.params.id, userId);
    if (!row) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    return ok(req, reply, { ...projectView(row), grants: projectGrants(db, row.id) });
  });

  // 编辑项目的文件夹条目：grantId=保留现有授权；pickerTicket+nonce=新选票据。首项为主要目录。
  const editFolderSchema = { type:'object', additionalProperties:false,
    properties:{ grantId:{type:'string',pattern:uuidPattern}, pickerTicket:{type:'string',pattern:uuidPattern},
      nonce:{type:'string',minLength:1,maxLength:128}, access:{enum:['read','write']} } };
  app.patch<{ Params: { id: string } }>('/api/v1/projects/:id', { schema: {
    params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: uuidPattern } } },
    body: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, archived: { type: 'boolean' }, pinned: { type: 'boolean' }, approvalMode:{enum:['ask','auto','full']},
      folders: { type:'array', minItems:1, maxItems:10, items: editFolderSchema } } },
  } }, async (req, reply) => {
    const { userId } = reqAuth(req);
    const row = getOwnedProject(db, req.params.id, userId);
    if (!row) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    const body = req.body as { name?: string; archived?: boolean; pinned?: boolean; approvalMode?:ApprovalMode; folders?: ReplaceFolderInput[] };
    const now = new Date().toISOString();
    if (body.folders !== undefined) {
      for (const folder of body.folders) {
        if (!folder.grantId && !(folder.pickerTicket && folder.nonce)) return fail(req, reply, 'VALIDATION_FAILED', '文件夹条目须为保留授权（grantId）或新选票据（pickerTicket+nonce）');
      }
      // 整表替换绑定；票据校验/冲突检查/软撤销都在事务内，失败即回滚。
      picker.replaceRoots(userId, row.id, body.folders);
    }
    const name = body.name !== undefined ? body.name.trim() : row.name;
    if (!name) return fail(req, reply, 'VALIDATION_FAILED', '项目名不能为空');
    const archivedAt = body.archived === undefined ? row.archived_at : (body.archived ? row.archived_at ?? now : null);
    if (body.archived && db.db.prepare("SELECT id FROM runs WHERE project_id=? AND status NOT IN ('succeeded','failed','cancelled') LIMIT 1").get(row.id)) return fail(req,reply,'RESOURCE_BUSY','请先停止此项目的任务，再归档');
    const pin = db.db.prepare('SELECT pinned_at FROM projects WHERE id=?').get(row.id) as {pinned_at:string|null};
    const pinnedAt = body.pinned === undefined ? pin.pinned_at : body.pinned ? pin.pinned_at ?? now : null;
    db.tx(tx => tx.prepare('UPDATE projects SET name = ?, archived_at = ?, pinned_at=?, approval_mode=?, updated_at = ? WHERE id = ?')
      .run(name, archivedAt, pinnedAt, body.approvalMode??row.approval_mode??'auto', now, row.id));
    const updated = db.db.prepare('SELECT * FROM projects WHERE id = ?').get(row.id) as unknown as ProjectRow;
    return ok(req, reply, { ...projectView(updated), grants: projectGrants(db, row.id) });
  });
}

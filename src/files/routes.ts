// T03 路由：目录授权（票据/选择器/grants）、授权内文件、快照、上传、联网资料与版本读取。
// 全部逐次鉴权（项目归属）；他人对象与不存在同形404；错误不回显绝对路径。
import type { FastifyInstance } from 'fastify';
import { basename } from 'node:path';
import { ok, fail } from '../http.js';
import type { Db } from '../storage/db.js';
import { NotFound } from '../projects/routes.js';
import type { AuthExtractor } from '../projects/routes.js';
import type { DirectoryChooser } from './directoryChooser.js';
import { closeFilePickers, cancelPicker, startPicker, getTicket, claimGrant, grantView, revokeGrant, setPrimaryGrant, getGrant } from './picker.js';
import { PathDenied } from './paths.js';
import { GrantDenied, requireActiveGrant, listFiles, snapshotFile, saveUpload, fetchWebResource, listResources, getResourceVersion, storedFileExists, MAX_FILE_BYTES } from './broker.js';

const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

interface PathError extends Error { code?: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerFileRoutes(app: FastifyInstance, db: Db, auth: AuthExtractor, dataDir: string, directoryChooser?: DirectoryChooser): void {
  const reqAuth = (req: any) => auth(req) as { userId: string };

  app.addHook('onClose', async () => closeFilePickers(db));

  // —— 目录选择票据 ——

  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/directory-picker', { schema: {
    params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: uuidPattern } } },
    body: { type: 'object', additionalProperties: false, properties: { access: { enum: ['read', 'write'] } } },
  } }, async (req, reply) => {
    const { userId } = reqAuth(req);
    const project = db.db.prepare('SELECT id FROM projects WHERE id = ? AND owner_user_id = ?').get(req.params.id, userId) as { id: string } | undefined;
    if (!project) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    const access = ((req.body as { access?: 'read' | 'write' } | undefined)?.access ?? 'read');
    const ticket = startPicker(db, userId, req.params.id, directoryChooser);
    // access随票据领取时生效：存入前端待提交体，不落到票据表（领取时再次传入并校验项目归属）
    return reply.code(202).header('x-request-id', req.id).send({
      data: { pickerTicket: { id: ticket.ticketId, expiresAt: ticket.expiresAt, access }, nonce: ticket.nonce },
      requestId: req.id,
    });
  });

  app.get<{ Params: { ticket: string } }>('/api/v1/directory-pickers/:ticket', { schema: {
    params: { type: 'object', required: ['ticket'], additionalProperties: false, properties: { ticket: { type: 'string', pattern: uuidPattern } } },
  } }, async (req, reply) => {
    const { userId } = reqAuth(req);
    const row = getTicket(db, req.params.ticket, userId);
    if (!row) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    return ok(req, reply, {
      state: row.state,
      // 仅selected/claimed且本账号票据可见目录名；绝不回显绝对路径
      directoryName: row.selected_path ? basename(row.selected_path) : null,
      grantId: row.grant_id,
      expiresAt: row.expires_at,
    });
  });

  app.delete<{ Params: { ticket: string }; Body: { nonce: string } }>('/api/v1/directory-pickers/:ticket', { schema: {
    body: { type: 'object', required: ['nonce'], additionalProperties: false, properties: { nonce: { type: 'string', minLength: 1, maxLength: 128 } } },
  } }, async (req, reply) => {
    if (!cancelPicker(db, req.params.ticket, reqAuth(req).userId, req.body.nonce)) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    return ok(req, reply, { cancelled: true });
  });

  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/grants', { schema: {
    params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: uuidPattern } } },
    body: { type: 'object', required: ['pickerTicket', 'nonce', 'access'], additionalProperties: false, properties: {
      pickerTicket: { type: 'string', pattern: uuidPattern },
      nonce: { type: 'string', minLength: 16, maxLength: 128 },
      access: { enum: ['read', 'write'] },
      excludes: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 400 } },
    } },
  } }, async (req, reply) => {
    const { userId } = reqAuth(req);
    const body = req.body as { pickerTicket: string; nonce: string; access: 'read' | 'write'; excludes?: string[] };
    if (!ownedProject(db, req.params.id, userId)) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    const grant = claimGrant(db, { ticketId: body.pickerTicket, nonce: body.nonce, userId, projectId: req.params.id, access: body.access, excludes: body.excludes });
    if (!grant) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问'); // 伪造票据/nonce/他人票据/重复领取同形
    return ok(req, reply, grantView(grant), 201);
  });

  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/grants', { schema: {
    params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: uuidPattern } } },
  } }, async (req, reply) => {
    const { userId } = reqAuth(req);
    const project = db.db.prepare('SELECT id FROM projects WHERE id = ? AND owner_user_id = ?').get(req.params.id, userId) as { id: string } | undefined;
    if (!project) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    const rows = db.db.prepare('SELECT * FROM workspace_grants WHERE project_id = ? ORDER BY is_primary DESC, created_at ASC, id').all(req.params.id) as never[];
    return ok(req, reply, (rows as ReturnType<typeof getGrant>[]).filter(Boolean).map(g => grantView(g!)));
  });

  app.get<{ Params: { id: string; grantId: string } }>('/api/v1/projects/:id/grants/:grantId', { schema: {
    params: { type: 'object', required: ['id', 'grantId'], additionalProperties: false,
      properties: { id: { type: 'string', pattern: uuidPattern }, grantId: { type: 'string', pattern: uuidPattern } } },
  } }, async (req, reply) => {
    const { userId } = reqAuth(req);
    if (!ownedProject(db, req.params.id, userId)) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    const grant = getGrant(db, req.params.id, req.params.grantId);
    if (!grant) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    return ok(req, reply, grantView(grant));
  });

  app.patch<{ Params: { id: string; grantId: string }; Body: { access: 'read' | 'write'; revision: number } }>('/api/v1/projects/:id/grants/:grantId', { schema: {
    params: { type:'object', required:['id','grantId'], additionalProperties:false, properties:{id:{type:'string',pattern:uuidPattern},grantId:{type:'string',pattern:uuidPattern}} },
    body: { type:'object', required:['access','revision'], additionalProperties:false, properties:{access:{enum:['read','write']},revision:{type:'integer',minimum:1}} },
  } }, async (req,reply) => {
    const {userId}=reqAuth(req);
    if (!ownedProject(db,req.params.id,userId)) return fail(req,reply,'NOT_FOUND','对象不存在或无权访问');
    const grant=getGrant(db,req.params.id,req.params.grantId);
    if (!grant || grant.revoked_at) return fail(req,reply,'NOT_FOUND','文件夹授权不存在');
    const active=db.db.prepare("SELECT id FROM runs WHERE project_id=? AND status IN ('created','queued','running','waiting_approval','cancelling') LIMIT 1").get(req.params.id);
    if(active) return fail(req,reply,'RESOURCE_BUSY','请先停止此项目正在执行的任务，再调整文件权限');
    const changed=db.db.prepare('UPDATE workspace_grants SET access=?,revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=? AND revoked_at IS NULL').run(req.body.access,new Date().toISOString(),grant.id,req.params.id,req.body.revision);
    if(!changed.changes)return fail(req,reply,'CONFIG_CHANGED','文件权限已变化，请重新载入');
    return ok(req,reply,grantView(getGrant(db,req.params.id,grant.id)!));
  });

  app.post<{ Params: { id: string; grantId: string } }>('/api/v1/projects/:id/grants/:grantId/primary', { schema: {
    params: { type: 'object', required: ['id', 'grantId'], additionalProperties: false,
      properties: { id: { type: 'string', pattern: uuidPattern }, grantId: { type: 'string', pattern: uuidPattern } } },
  } }, async (req, reply) => {
    const { userId } = reqAuth(req);
    if (!ownedProject(db, req.params.id, userId)) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    const grant = setPrimaryGrant(db, req.params.id, req.params.grantId);
    if (!grant) return fail(req, reply, 'NOT_FOUND', '文件夹授权不存在');
    return ok(req, reply, grantView(grant));
  });

  app.delete<{ Params: { id: string; grantId: string } }>('/api/v1/projects/:id/grants/:grantId', { schema: {
    params: { type: 'object', required: ['id', 'grantId'], additionalProperties: false,
      properties: { id: { type: 'string', pattern: uuidPattern }, grantId: { type: 'string', pattern: uuidPattern } } },
  } }, async (req, reply) => {
    const { userId } = reqAuth(req);
    if (!ownedProject(db, req.params.id, userId)) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    const done = revokeGrant(db, req.params.id, req.params.grantId);
    if (!done) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    return ok(req, reply, { revoked: true });
  });

  // —— 授权内文件 ——

  app.get<{ Params: { id: string }; Querystring: { grantId?: string; relativePath?: string } }>('/api/v1/projects/:id/files', { schema: {
    params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: uuidPattern } } },
    querystring: { type: 'object', additionalProperties: false, properties: { grantId: { type: 'string', pattern: uuidPattern }, relativePath: { type: 'string', maxLength: 1000 } } },
  } }, async (req, reply) => {
    const { userId } = reqAuth(req);
    if (!ownedProject(db, req.params.id, userId)) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    const grantId = (req.query as { grantId?: string }).grantId;
    const relativePath = (req.query as { relativePath?: string }).relativePath ?? '.';
    if (!grantId) return fail(req, reply, 'VALIDATION_FAILED', '缺少grantId');
    try {
      const grant = requireActiveGrant(db, req.params.id, grantId);
      const result = await listFiles(grant, relativePath);
      return ok(req, reply, result);
    } catch (error) {
      return fileError(req, reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/file-snapshots', { schema: {
    params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: uuidPattern } } },
    body: { type: 'object', required: ['grantId', 'relativePath'], additionalProperties: false, properties: {
      grantId: { type: 'string', pattern: uuidPattern }, relativePath: { type: 'string', minLength: 1, maxLength: 1000 },
    } },
  } }, async (req, reply) => {
    const { userId } = reqAuth(req);
    if (!ownedProject(db, req.params.id, userId)) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    const body = req.body as { grantId: string; relativePath: string };
    try {
      const result = await snapshotFile(db, dataDir, req.params.id, body.grantId, body.relativePath);
      return ok(req, reply, result, 201);
    } catch (error) {
      return fileError(req, reply, error);
    }
  });

  // —— 上传（multipart，50MiB流式上限） ——

  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/uploads', { schema: {
    params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: uuidPattern } } },
  } }, async (req, reply) => {
    const { userId } = reqAuth(req);
    if (!ownedProject(db, req.params.id, userId)) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    const file = await (req as unknown as { file: () => Promise<MultipartFile | undefined> }).file();
    if (!file) return fail(req, reply, 'VALIDATION_FAILED', '缺少上传文件');
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of file.file) {
      total += (chunk as Buffer).byteLength;
      chunks.push(chunk as Buffer);
    }
    // busboy在fileSize上限处截断并置truncated标记；截断不是完整文件，必须拒绝
    const truncated = (file.file as unknown as { truncated?: boolean }).truncated === true;
    if (truncated || total > MAX_FILE_BYTES) {
      return fail(req, reply, 'INPUT_TOO_LARGE', '上传超过50MiB上限', { status: 413 });
    }
    const result = await saveUpload(db, dataDir, req.params.id, file.filename, Buffer.concat(chunks));
    return ok(req, reply, { resourceId: result.resourceId, version: result.version, contentHash: result.contentHash, sizeBytes: result.sizeBytes, displayName: file.filename }, 201);
  });

  // —— 联网资料 ——

  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/web-resources', { schema: {
    params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: uuidPattern } } },
    body: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { type: 'string', minLength: 8, maxLength: 2048 } } },
  } }, async (req, reply) => {
    const { userId } = reqAuth(req);
    if (!ownedProject(db, req.params.id, userId)) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    const url = (req.body as { url: string }).url;
    try {
      const result = await fetchWebResource(db, dataDir, req.params.id, url);
      return ok(req, reply, result, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message === 'HOST_DENIED') return fail(req, reply, 'POLICY_DENIED', '该地址不可抓取（本地/内网）', { status: 403 });
      if (message === 'URL_INVALID') return fail(req, reply, 'VALIDATION_FAILED', 'URL不合法');
      if (message === 'INPUT_TOO_LARGE') return fail(req, reply, 'INPUT_TOO_LARGE', '抓取内容超过50MiB上限', { status: 413 });
      return fail(req, reply, 'PROVIDER_ERROR', '抓取失败', { status: 502 });
    }
  });

  // —— 资源列表与版本 ——

  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/resources', { schema: {
    params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: uuidPattern } } },
  } }, async (req, reply) => {
    const { userId } = reqAuth(req);
    if (!ownedProject(db, req.params.id, userId)) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    return ok(req, reply, listResources(db, req.params.id));
  });

  app.get<{ Params: { id: string; resourceId: string; version: string }; Querystring: { view?: string } }>('/api/v1/projects/:id/resources/:resourceId/versions/:version', { schema: {
    params: { type: 'object', required: ['id', 'resourceId', 'version'], additionalProperties: false, properties: {
      id: { type: 'string', pattern: uuidPattern }, resourceId: { type: 'string', pattern: uuidPattern }, version: { type: 'string', pattern: '^[0-9]+$' } },
    },
    querystring: { type: 'object', additionalProperties: false, properties: { view: { enum: ['metadata', 'preview', 'download'] } } },
  } }, async (req, reply) => {
    const { userId } = reqAuth(req);
    if (!ownedProject(db, req.params.id, userId)) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    const view = (req.query as { view?: string }).view ?? 'metadata';
    const found = getResourceVersion(db, req.params.id, req.params.resourceId, Number(req.params.version));
    if (!found) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    if (view === 'metadata') {
      return ok(req, reply, {
        resourceId: found.resource.id, displayName: found.resource.display_name, kind: found.resource.kind,
        version: found.file.version, contentHash: found.file.content_hash, sizeBytes: found.file.size_bytes,
        sourceUrl: found.file.source_url, fetchedAt: found.file.fetched_at, locator: JSON.parse(found.file.locator_manifest_json),
      });
    }
    if (!(await storedFileExists(found.file.stored_path))) {
      return fail(req, reply, 'ARTIFACT_MISSING', '原文件缺失，无法提供');
    }
    if (view === 'download') {
      const bytes = await import('node:fs/promises').then(fs => fs.readFile(found.file.stored_path));
      return reply.code(200).header('content-type', 'application/octet-stream; charset=utf-8')
        .header('x-content-type-options', 'nosniff')
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(found.resource.display_name)}`)
        .send(bytes);
    }
    // preview：文本类且≤1MiB给内容，否则download_only
    const textLike = /\.(txt|md|csv|json|ts|tsx|js|mjs|log)$/i.test(found.resource.display_name) || (found.file.locator_manifest_json.includes('contentType') && JSON.parse(found.file.locator_manifest_json).contentType?.startsWith('text/'));
    const previewable = textLike && found.file.size_bytes <= 1024 * 1024;
    if (!previewable) return ok(req, reply, { kind: 'download_only', truncated: false, downloadAvailable: true });
    const bytes = await import('node:fs/promises').then(fs => fs.readFile(found.file.stored_path));
    return ok(req, reply, { kind: 'text', content: bytes.toString('utf8').slice(0, 1024 * 1024), truncated: bytes.byteLength > 1024 * 1024, downloadAvailable: true });
  });
}

function ownedProject(db: Db, projectId: string, userId: string): boolean {
  return (db.db.prepare('SELECT 1 FROM projects WHERE id = ? AND owner_user_id = ?').get(projectId, userId) as unknown | undefined) !== undefined;
}

function fileError(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply, error: unknown): import('fastify').FastifyReply {
  const code = (error as PathError).code;
  if (error instanceof PathDenied || error instanceof GrantDenied) return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
  if (code === 'INPUT_TOO_LARGE') return fail(req, reply, 'INPUT_TOO_LARGE', '文件超过50MiB上限', { status: 413 });
  if (code === 'ENOENT') return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
  throw error;
}

interface MultipartFile { filename: string; file: AsyncIterable<Buffer>; fields: Record<string, unknown> }

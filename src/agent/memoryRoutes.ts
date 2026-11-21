import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../storage/db.js';
import { ApiError } from '../../contracts/errors.js';
import { ok } from '../http.js';
import { memoryRootOf, buildMemoryBootstrap, readMemoryText, toolMemoryWrite, updateMemoryIndex } from './memoryStore.js';
export function registerMemoryRoutes(app: FastifyInstance, db: Db, dataDir: string, auth: (request: FastifyRequest) => { userId: string }): void {
    function owned(projectId: string, userId: string): void { if (!db.db.prepare('SELECT id FROM projects WHERE id=? AND owner_user_id=?').get(projectId, userId)) throw new ApiError('NOT_FOUND', '项目不存在或无权访问'); }
    app.get('/api/v1/memory', async (req, reply) => {
        const { userId } = auth(req), projects = db.db.prepare('SELECT id,name FROM projects WHERE owner_user_id=? ORDER BY updated_at DESC').all(userId) as unknown as Array<{ id: string; name: string }>;
        return ok(req, reply, { projects: projects.map(project => {
            const context = buildMemoryBootstrap(dataDir, project.id);
            return { ...project, files: context.files, hasIndex: context.index !== null };
        }) });
    });
    app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/v1/projects/:id/memory/file', async (req, reply) => {
        owned(req.params.id, auth(req).userId); const memory = await readMemoryText(memoryRootOf(dataDir, req.params.id), req.query.path ?? 'MEMORY.md');
        return ok(req, reply, { path: req.query.path ?? 'MEMORY.md', ...memory });
    });
    app.put<{ Params: { id: string }; Body: { path?: string; content?: string; expectedHash?: string } }>('/api/v1/projects/:id/memory/file', async (req, reply) => {
        owned(req.params.id, auth(req).userId); const body = req.body;
        if (!body || typeof body.path !== 'string' || typeof body.content !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedHash ?? '')) throw new ApiError('VALIDATION_FAILED', '修改记忆须提供当前版本hash');
        const root = memoryRootOf(dataDir, req.params.id), saved = await toolMemoryWrite(root, { path: body.path, content: body.content, expectedHash: body.expectedHash! });
        await updateMemoryIndex(root, body.path); return ok(req, reply, saved);
    });
}

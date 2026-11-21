import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../storage/db.js';
import { ApiError } from '../../contracts/errors.js';
import { ok } from '../http.js';
import { getSkillsCatalog, setSkillEnabled } from './skillCatalog.js';
import { installSkillPackage, removeSkillPackage, readSkillPackages, normalizeSkillSource } from './skillPackages.js';
import { SKILL_PACKAGE_CATALOG, SKILL_PACKAGE_CATALOG_UPDATED_AT } from './skillPackageCatalog.js';

/** 设置→技能：约定目录扫描＋启停开关。projectId 可选，提供时合并项目级目录。 */
export function registerSkillRoutes(app: FastifyInstance, db: Db): void {
    function userId(req: FastifyRequest): string {
        const session = (req as unknown as { session?: { userId?: string } }).session;
        if (!session?.userId) throw new ApiError('AUTH_REQUIRED', '请先登录');
        return session.userId;
    }

    function workspaceRootOf(req: FastifyRequest, projectId: string | undefined): string | undefined {
        if (!projectId) return undefined;
        if (!/^[0-9a-f-]{36}$/.test(projectId)) throw new ApiError('VALIDATION_FAILED', 'projectId 不合法');
        const project = db.db.prepare('SELECT owner_user_id FROM projects WHERE id=?').get(projectId) as { owner_user_id: string } | undefined;
        if (!project || project.owner_user_id !== userId(req)) throw new ApiError('NOT_FOUND', '项目不存在或无权访问');
        return (db.db.prepare('SELECT canonical_root FROM workspace_grants WHERE project_id=? AND revoked_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1').get(projectId) as {canonical_root:string}|undefined)?.canonical_root;
    }

    app.get('/api/v1/skills', async (req, reply) => {
        const projectId = (req.query as { projectId?: string }).projectId;
        const catalog = getSkillsCatalog(db, userId(req), workspaceRootOf(req, projectId));
        return ok(req, reply, catalog);
    });

    app.post('/api/v1/skills/packages', async (req,reply)=> {
        const body=req.body as {source?:unknown;skillPath?:unknown};
        const entry=await installSkillPackage(db,userId(req),body?.source,undefined,body?.skillPath);
        return ok(req,reply,entry);
    });
    /** 已安装插件（技能包）清单：插件页独立消费，不依赖技能目录扫描。 */
    app.get('/api/v1/skills/packages', async (req, reply) => {
        return ok(req, reply, readSkillPackages(db, userId(req)).map(({ paths: _paths, ...dto }) => dto));
    });
    /** 推荐技能包目录：只读清单＋按账号派生 installed；来源返回归一化形态，与安装记录直接可比。 */
    app.get('/api/v1/skills/packages/catalog', async (req, reply) => {
        const installed = new Set(readSkillPackages(db, userId(req)).map(p => p.source));
        const entries = SKILL_PACKAGE_CATALOG.map(entry => {
            const source = normalizeSkillSource(entry.source);
            return { ...entry, source, installed: installed.has(source) };
        });
        return ok(req, reply, { updatedAt: SKILL_PACKAGE_CATALOG_UPDATED_AT, entries });
    });
    app.post('/api/v1/skills/packages/:id/update',async(req,reply)=>{
        return ok(req,reply,await installSkillPackage(db,userId(req),undefined,(req.params as {id:string}).id));
    });
    app.delete('/api/v1/skills/packages/:id',async(req,reply)=>{
        await removeSkillPackage(db,userId(req),(req.params as {id:string}).id);
        return ok(req,reply,{removed:true});
    });

    app.put('/api/v1/skills/:name/enabled', async (req, reply) => {
        const name = (req.params as { name?: string }).name ?? '';
        const body = (req.body ?? {}) as { enabled?: unknown };
        if (typeof body.enabled !== 'boolean') throw new ApiError('VALIDATION_FAILED', '缺少 enabled 布尔值');
        return ok(req, reply, setSkillEnabled(db, userId(req), name, body.enabled));
    });
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../storage/db.js';
import { ApiError } from '../../contracts/errors.js';
import { ok } from '../http.js';
import { getSearchSettings, setSearchProvider, setSearchCredential, clearSearchCredential, clearSearchSource, resolveSearchKey } from './searchSettings.js';
import { searchWeb, type SearchProvider } from './webTools.js';

/** 设置→联网搜索：provider 持久化 + 本机加密 API Key（或引用模型接口 Key）+ 连接测试。 */
export function registerSearchRoutes(app: FastifyInstance, db: Db): void {
    function userId(req: FastifyRequest): string {
        const session = (req as unknown as { session?: { userId?: string } }).session;
        if (!session?.userId) throw new ApiError('AUTH_REQUIRED', '请先登录');
        return session.userId;
    }

    app.get('/api/v1/search-settings', async (req, reply) => ok(req, reply, getSearchSettings(db, userId(req))));

    app.put('/api/v1/search-settings', async (req, reply) => {
        const body = (req.body ?? {}) as { provider?: unknown; sourceConfigId?: unknown };
        if (typeof body.provider !== 'string') throw new ApiError('VALIDATION_FAILED', '缺少 provider');
        if (body.sourceConfigId !== undefined && body.sourceConfigId !== null && typeof body.sourceConfigId !== 'string') throw new ApiError('VALIDATION_FAILED', 'sourceConfigId 无效');
        return ok(req, reply, setSearchProvider(db, userId(req), body.provider as SearchProvider, body.sourceConfigId as string | null | undefined));
    });

    app.put('/api/v1/search-settings/credential', async (req, reply) => {
        const body = (req.body ?? {}) as { apiKey?: unknown };
        if (typeof body.apiKey !== 'string' || !body.apiKey.trim()) throw new ApiError('VALIDATION_FAILED', '缺少 API Key');
        setSearchCredential(db,userId(req), body.apiKey);
        return ok(req, reply, { stored: true });
    });

    app.delete('/api/v1/search-settings/credential', async (req, reply) => {
        clearSearchCredential(db,userId(req));
        return ok(req, reply, { stored: false });
    });

    app.delete('/api/v1/search-settings/source', async (req, reply) => {
        clearSearchSource(db, userId(req));
        return ok(req, reply, getSearchSettings(db, userId(req)));
    });

    app.post('/api/v1/search-settings/test', async (req, reply) => {
        const uid = userId(req);
        const settings = getSearchSettings(db, uid);
        if (settings.provider === 'none') throw new ApiError('SEARCH_NOT_CONFIGURED', '请先选择搜索服务');
        const { key, source } = resolveSearchKey(db, uid);
        const started = Date.now();
        const result = await searchWeb(settings.provider, key, 'prism 连接测试', 1);
        return ok(req, reply, { ok: true, provider: settings.provider, keySource: source, latencyMs: Date.now() - started, sample: result.results[0]?.title ?? null, resultCount: result.results.length });
    });
}

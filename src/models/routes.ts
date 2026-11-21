import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Db } from '../storage/db.js';
import { ApiError } from '../../contracts/errors.js';
import type { ModelConfigInput, ModelEntryInput } from '../../contracts/v1.js';
import { DEFAULT_AGENT_SETTINGS, normalizeAgentSettings, AGENT_PROMPT_MAX_CHARS, type AgentRuntimeSettings } from '../../contracts/models.js';
import type { ModelConfigView } from '../../contracts/models.js';
import { validateModelConfigInput, validate } from '../contracts/schemas.js';
import { ok } from '../http.js';
import { CredentialVault } from './vault.js';
import { ModelGateway, type ModelTransport } from './gateway.js';
import { resolveModelParameters } from './parameterResolver.js';
import { modelMetadata } from './modelMetadata.js';
import { resolveVisionSupport, resolveModelContextWindow, resolveModelMaxOutputTokens, resolveModelProvider, resolveThinkingCapability } from '../agent/modelCatalog.js';
import { validateEndpoint } from './network.js';
import { searchBindingForBaseUrl, searchReuseForBaseUrl } from '../../contracts/search.js';
interface Session {
    userId: string;
    sessionId: string;
    expiresAt: string;
}
interface Row {
    id: string;
    owner_user_id: string;
    preset: ModelConfigInput['preset'];
    name: string;
    base_url: string;
    api_protocol: ModelConfigInput['protocol'];
    revision: number;
    enabled: number;
    search_provider: string | null;
    updated_at: string;
}
export function registerModelRoutes(app: FastifyInstance, db: Db, transport?: ModelTransport, hooks?: {
    vault?: CredentialVault;
    /** 凭据变化通知（清除/登出/配置停用改端点）→监督器中断受影响Run。 */
    onCredentialChanged?: (input: { sessionId?: string; configId?: string }) => void;
    onQuestionAutoResolutionDisabled?: (userId: string) => void;
}) {
    const vault = hooks?.vault ?? new CredentialVault(), gateway = new ModelGateway(transport), active = new Set<string>();
    function session(req: FastifyRequest): Session { const s = (req as unknown as {
        session?: Session;
    }).session; if (!s)
        throw new ApiError('AUTH_REQUIRED', '请先登录'); return s; }
    function owned(id: string, userId: string): Row { const row = db.db.prepare('SELECT * FROM model_configs WHERE id=? AND owner_user_id=?').get(id, userId) as unknown as Row | undefined; if (!row)
        throw new ApiError('NOT_FOUND', '对象不存在或无权访问'); return row; }
    function view(row: Row, s: Session): ModelConfigView {
        const entries = db.db.prepare('SELECT model_id,display_name,enabled,parameters_json FROM model_entries WHERE config_id=? ORDER BY rowid').all(row.id) as unknown as Array<{
            model_id: string;
            display_name: string;
            enabled: number;
            parameters_json: string;
        }>;
        return { id: row.id, preset: row.preset, protocol: row.api_protocol ?? 'openai-completions', name: row.name, baseUrl: row.base_url, revision: row.revision, enabled: !!row.enabled, hasCredential: !!vault.get(s.sessionId, row.id), updatedAt: row.updated_at, searchProvider: row.search_provider ?? null, searchBinding: searchBindingForBaseUrl(row.base_url), models: entries.map(e => { const metadata=modelMetadata(row.api_protocol??'openai-completions',row.base_url,e.model_id,JSON.parse(e.parameters_json)); return ({ metadata, modelId: e.model_id, displayName: e.display_name, enabled: !!e.enabled, parameters: JSON.parse(e.parameters_json), visionSupported: metadata.image, contextWindowDefault: resolveModelContextWindow(row.base_url, e.model_id) ?? null, maxOutputTokensDefault: resolveModelMaxOutputTokens(row.base_url, e.model_id) ?? null, providerId: resolveModelProvider(row.base_url, e.model_id) ?? null, thinkingLevels: metadata.thinkingLevels }); }) };
    }
    // view() 下发的只读展示字段（visionSupported/contextWindowDefault）会在 PATCH 合并与前端草稿回传时混入 models；
    // schema additionalProperties:false 会拒绝，先投影回纯 ModelEntryInput 再校验
    function sanitizeModelsInput(models: unknown): unknown { return Array.isArray(models) ? models.map(m => (m && typeof m === 'object' && !Array.isArray(m) ? { modelId: (m as Record<string, unknown>).modelId, displayName: (m as Record<string, unknown>).displayName, enabled: (m as Record<string, unknown>).enabled, parameters: (m as Record<string, unknown>).parameters } : m)) : models; }
    function input(body: unknown): ModelConfigInput { const candidate = body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>), models: sanitizeModelsInput((body as Record<string, unknown>).models) } : body; const result = validateModelConfigInput(candidate); if (!result.ok)
        throw new ApiError('VALIDATION_FAILED', '接口名称、地址或模型配置不合法'); const value = result.value; if (!value.name.trim() || value.models.length > 100 || value.models.some(m => !m.modelId.trim() || !m.displayName.trim()) || new Set(value.models.map(m => m.modelId.trim())).size !== value.models.length)
        throw new ApiError('VALIDATION_FAILED', '请填写接口名称和不重复的模型 ID（最多100个）'); for (const m of value.models) resolveModelParameters(value.protocol??'openai-completions',value.baseUrl??'',m.modelId.trim(),m.parameters); return { ...value, name: value.name.trim(), baseUrl: validateEndpoint(value), models: value.models.map(m => ({ ...m, modelId: m.modelId.trim(), displayName: m.displayName.trim() })) }; }
    function insertEntries(configId: string, models: ModelEntryInput[], now: string) { for (const m of models)
        db.db.prepare('INSERT INTO model_entries(id,config_id,model_id,display_name,parameters_json,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), configId, m.modelId, m.displayName, JSON.stringify(m.parameters), m.enabled ? 1 : 0, now, now); }
    // 接口级搜索能力位（学 ZCode 勾选持久化）：勾选时按 baseUrl 推导厂商；推导不命中视为无效勾选
    function resolveSearchProvider(baseUrl: string, searchEnabled: boolean | undefined): string | null {
        if (!searchEnabled) return null;
        const reuse = searchReuseForBaseUrl(baseUrl);
        if (!reuse) throw new ApiError('VALIDATION_FAILED', '该接口地址无法推导搜索服务，无法启用联网搜索（仅支持与模型接口同厂商的搜索服务）');
        return reuse.provider;
    }
    app.get('/api/v1/agent-settings',async(req,reply)=>{
        const user=session(req);
        const row=db.db.prepare('SELECT settings_json FROM agent_runtime_settings WHERE user_id=?').get(user.userId) as {settings_json:string}|undefined;
        return ok(req,reply,normalizeAgentSettings(row?JSON.parse(row.settings_json):{}));
    });
    app.put('/api/v1/agent-settings',async(req,reply)=>{
        const user=session(req),raw=req.body as AgentRuntimeSettings;
        if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['autoCompaction','keepRecentTurns','subagent','prompts','askUserQuestionAutoResolutionEnabled','memoryEnabled'].includes(k))||typeof raw.autoCompaction!=='boolean'||!Number.isInteger(raw.keepRecentTurns)||raw.keepRecentTurns<1||raw.keepRecentTurns>20) throw new ApiError('VALIDATION_FAILED','保留轮次须为1—20，自动压缩须为布尔值');
        if(raw.askUserQuestionAutoResolutionEnabled!==undefined&&typeof raw.askUserQuestionAutoResolutionEnabled!=='boolean')throw new ApiError('VALIDATION_FAILED','提问自动继续须为布尔值');
        if(raw.memoryEnabled!==undefined&&typeof raw.memoryEnabled!=='boolean')throw new ApiError('VALIDATION_FAILED','记忆开关须为布尔值');
        if(raw.subagent&&(typeof raw.subagent.enabled!=='boolean'||!Number.isInteger(raw.subagent.maxSteps)||raw.subagent.maxSteps<1||raw.subagent.maxSteps>50||!Number.isInteger(raw.subagent.timeoutSeconds)||raw.subagent.timeoutSeconds<10||raw.subagent.timeoutSeconds>600||Object.keys(raw.subagent).some(k=>!['enabled','maxSteps','timeoutSeconds'].includes(k))))throw new ApiError('VALIDATION_FAILED','子代理步数须为1—50，超时须为10—600秒');
        if(raw.prompts&&(typeof raw.prompts!=='object'||Array.isArray(raw.prompts)||Object.keys(raw.prompts).some(k=>!['subagent','compaction','mainAppend'].includes(k))||Object.values(raw.prompts).some(v=>v!==undefined&&(typeof v!=='string'||v.trim().length>AGENT_PROMPT_MAX_CHARS))))throw new ApiError('VALIDATION_FAILED',`自定义提示词须为文本且不超过${AGENT_PROMPT_MAX_CHARS}字`);
        db.db.prepare('INSERT INTO agent_runtime_settings(user_id,settings_json,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json,updated_at=excluded.updated_at').run(user.userId,JSON.stringify(normalizeAgentSettings(raw)),new Date().toISOString());
        if(raw.askUserQuestionAutoResolutionEnabled===false)hooks?.onQuestionAutoResolutionDisabled?.(user.userId);
        return ok(req,reply,normalizeAgentSettings(raw));
    });
    app.post('/api/v1/model-configs/resolve-model', async (req, reply) => {
        session(req);
        const body = req.body as { protocol?: unknown; baseUrl?: unknown; modelId?: unknown; parameters?: unknown };
        if (!body || !['openai-completions','anthropic-messages'].includes(String(body.protocol)) || typeof body.baseUrl !== 'string' || body.baseUrl.length > 2000 || typeof body.modelId !== 'string' || !body.modelId.trim() || body.modelId.length > 200 || (body.parameters !== undefined && (!body.parameters || typeof body.parameters !== 'object' || Array.isArray(body.parameters)))) throw new ApiError('VALIDATION_FAILED','模型配置解析参数无效');
        return ok(req,reply,modelMetadata(body.protocol as ModelConfigInput['protocol'] & string,body.baseUrl,body.modelId,(body.parameters??{}) as Record<string,unknown>));
    });
    app.get('/api/v1/model-configs', async (req, reply) => { const s = session(req); const rows = db.db.prepare('SELECT * FROM model_configs WHERE owner_user_id=? ORDER BY created_at,id').all(s.userId) as unknown as Row[]; return ok(req, reply, rows.map(r => view(r, s))); });
    app.post('/api/v1/model-configs', async (req, reply) => { const s = session(req), data = input(req.body); const count = db.db.prepare('SELECT count(*) AS n FROM model_configs WHERE owner_user_id=?').get(s.userId) as {
        n: number;
    }; if (count.n >= 50)
        throw new ApiError('VALIDATION_FAILED', '每个账号最多配置50个接口'); const id = randomUUID(), now = new Date().toISOString(); db.tx(() => { db.db.prepare('INSERT INTO model_configs(id,owner_user_id,preset,name,base_url,api_protocol,search_provider,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, s.userId, data.preset, data.name, data.baseUrl, data.protocol ?? 'openai-completions', resolveSearchProvider(data.baseUrl, data.searchEnabled), now, now); insertEntries(id, data.models, now); }); return ok(req, reply, view(owned(id, s.userId), s), 201); });
    app.patch<{
        Params: {
            id: string;
        };
    }>('/api/v1/model-configs/:id', async (req, reply) => {
        const s = session(req), row = owned(req.params.id, s.userId);
        const raw = req.body as Record<string, unknown> | null;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            throw new ApiError('VALIDATION_FAILED', '配置格式不合法');
        const { revision, enabled, ...rest } = raw;
        if (!Number.isInteger(revision) || typeof revision !== 'number' || enabled !== undefined && typeof enabled !== 'boolean')
            throw new ApiError('VALIDATION_FAILED', '缺少有效的配置版本');
        if (revision !== row.revision) throw new ApiError('CONFIG_CHANGED', '配置已在其他窗口更新，请重新载入后再保存');
        const current = view(row, s);
        const data = input({preset:current.preset,protocol:current.protocol,name:current.name,baseUrl:current.baseUrl,models:current.models,...rest}), now = new Date().toISOString();
        if (data.searchEnabled === true && enabled === false)
            throw new ApiError('VALIDATION_FAILED', '接口停用时不能启用联网搜索');
        // 能力位解析：显式勾选→按新地址推导；显式取消→清空；未传→保持现状，但地址变更致推导失效时联动解除
        let nextSearchProvider: string | null;
        if (data.searchEnabled === true) nextSearchProvider = resolveSearchProvider(data.baseUrl, true);
        else if (data.searchEnabled === false) nextSearchProvider = null;
        else if (row.search_provider && searchReuseForBaseUrl(data.baseUrl)?.provider !== row.search_provider) nextSearchProvider = null;
        else nextSearchProvider = row.search_provider;
        db.tx(() => { const result = db.db.prepare('UPDATE model_configs SET preset=?,name=?,base_url=?,api_protocol=?,enabled=?,search_provider=?,revision=revision+1,updated_at=? WHERE id=? AND owner_user_id=? AND revision=?').run(data.preset, data.name, data.baseUrl, data.protocol ?? 'openai-completions', enabled === undefined ? row.enabled : enabled ? 1 : 0, nextSearchProvider, now, row.id, s.userId, revision); if (!result.changes)
            throw new ApiError('CONFIG_CHANGED', '配置已在其他窗口更新，请重新载入后再保存'); db.db.prepare('DELETE FROM model_entries WHERE config_id=?').run(row.id); insertEntries(row.id, data.models, now); });
        const clearingKey = row.base_url !== data.baseUrl || row.api_protocol !== (data.protocol ?? 'openai-completions') || enabled === false;
        // Key 被清除时同步解除联网搜索对本接口的 Key 引用（引用失效不再残留）
        if (clearingKey) db.db.prepare('UPDATE search_settings SET source_config_id=NULL WHERE source_config_id=?').run(row.id);
        vault.configChanged(row.id, clearingKey);
        hooks?.onCredentialChanged?.({ configId: row.id });
        return ok(req, reply, view(owned(row.id, s.userId), s));
    });
    app.put<{
        Params: {
            id: string;
        };
    }>('/api/v1/model-configs/:id/credential', async (req, reply) => { const s = session(req), row = owned(req.params.id, s.userId); if (!row.enabled)
        throw new ApiError('MODEL_UNAVAILABLE', '请先启用此接口'); const result = validate<{
        apiKey: string;
    }>('CredentialInput', req.body); if (!result.ok || /[\s\x00-\x1f\x7f]/.test(result.ok ? result.value.apiKey : ''))
        throw new ApiError('VALIDATION_FAILED', 'API Key 格式不合法'); vault.set(s.sessionId, row.id, result.value.apiKey, s.expiresAt); return ok(req, reply, { hasCredential: true }); });
    app.delete<{
        Params: {
            id: string;
        };
    }>('/api/v1/model-configs/:id/credential', async (req, reply) => { const s = session(req); owned(req.params.id, s.userId); vault.forget(s.sessionId, req.params.id); hooks?.onCredentialChanged?.({ configId: req.params.id }); return ok(req, reply, { hasCredential: false }); });
    app.delete('/api/v1/model-credentials', async (req, reply) => { const s = session(req); const ids=vault.forget(s.sessionId); for(const configId of ids)hooks?.onCredentialChanged?.({ configId }); return ok(req, reply, { cleared: true }); });
    for (const action of ['test', 'discover'] as const)
        app.post<{
            Params: {
                id: string;
            };
        }>(`/api/v1/model-configs/:id/${action}`, async (req, reply) => {
            const s = session(req), row = owned(req.params.id, s.userId), config = view(row, s), raw = req.body as Record<string, unknown> | null;
            if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !(action === 'test' ? ['modelId', 'revision'] : ['revision']).includes(k)) || raw.revision !== row.revision)
                throw new ApiError('CONFIG_CHANGED', '配置已变更，请保存最新配置后重试');
            if (!config.enabled)
                throw new ApiError('MODEL_UNAVAILABLE', '请先启用此接口');
            const key = vault.get(s.sessionId, row.id);
            if (!key)
                throw new ApiError('CREDENTIAL_REQUIRED', '请先填写并保存此账号的 API Key');
            const modelId = typeof raw.modelId === 'string' ? raw.modelId : '';
            if (action === 'test' && !config.models.some(m => m.modelId === modelId && m.enabled))
                throw new ApiError('MODEL_UNAVAILABLE', '请先保存并启用要测试的模型');
            const activeId = `${s.sessionId}:${row.id}`;
            if (active.has(activeId))
                throw new ApiError('REQUEST_IN_PROGRESS', '该接口已有测试正在进行');
            active.add(activeId);
            const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000), untrack = vault.track(s.sessionId, row.id, controller);
            try {
                const result = action === 'test' ? await gateway.test(config, modelId, key, controller.signal) : await gateway.discover(config, key, controller.signal);
                if (controller.signal.aborted)
                    throw new ApiError('MODEL_TIMEOUT', '连接测试已取消或超时');
                return ok(req, reply, result);
            }
            finally {
                clearTimeout(timer);
                untrack();
                active.delete(activeId);
            }
        });
    app.addHook('onSend', async (req, reply, payload) => { if (req.method === 'POST' && req.routeOptions.url === '/api/v1/auth/logout' && reply.statusCode === 200) {
        const s = (req as unknown as {
            session?: Session;
        }).session;
        if (s) {
            vault.clear(s.sessionId);
            hooks?.onCredentialChanged?.({ sessionId: s.sessionId });
        }
    } return payload; });
    // 共享vault由buildProductApp统一dispose；本地实例随路由关闭释放
    if (!hooks?.vault) app.addHook('onClose', async () => vault.dispose());
}

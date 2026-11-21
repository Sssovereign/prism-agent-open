import { normalizeContext, type Model } from '@earendil-works/pi-ai';
import { streamSimple as streamOpenAI } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { ApiError } from '../../contracts/errors.js';
import type { ModelConfigView } from '../../contracts/models.js';
import { resolveModelParameters } from './parameterResolver.js';
import { thinkingPayloadHook } from './advancedOptions.js';
import { pinnedFetch } from './network.js';
import { resolveVisionSupport, resolveThinkingCapability } from '../agent/modelCatalog.js';
export type ModelTransport = (baseUrl: string) => typeof fetch;
export class ModelGateway {
    constructor(private readonly transport: ModelTransport = pinnedFetch) { }
    async test(config: ModelConfigView, modelId: string, apiKey: string, signal: AbortSignal): Promise<{
        success: true;
        latencyMs: number;
    }> {
        let safeError: ApiError | undefined, status = 0;
        const upstream = this.transport(config.baseUrl);
        const fetch_: typeof fetch = async (input, init) => { try {
            const response = await upstream(input, init);
            status = response.status;
            return response;
        }
        catch (e) {
            safeError = e instanceof ApiError ? e : new ApiError('PROVIDER_ERROR', '无法连接接口，请检查地址和网络');
            throw new Error('MODEL_CONNECTION_FAILED');
        } };
        const parameters=resolveModelParameters(config.protocol??'openai-completions',config.baseUrl,modelId,config.models.find(m=>m.modelId===modelId)?.parameters??{});
        // 思考三件套按厂商文档核实层+目录解析：级别映射随 Model 下发（非恒等映射的厂商翻译必需）；
        // compat 合并顺序 vendorFacts > 目录 > 正则推导（中转方言不猜，交给 pi-ai detectCompat），
        // supportsStore/developerRole 是棱镜策略位钉死
        const thinking=resolveThinkingCapability(config.protocol??'openai-completions',config.baseUrl,modelId,parameters.advanced);
        const model = { id: modelId, name: modelId, api: config.protocol ?? 'openai-completions', provider: 'prism-custom', baseUrl: config.baseUrl, input: resolveVisionSupport(config.protocol ?? 'openai-completions', config.baseUrl, modelId, parameters.advanced) ? ['text', 'image'] : ['text'], reasoning: parameters.effective.thinkingLevel!=='off' && parameters.capability.thinkingLevels.length>0, contextWindow: parameters.effective.contextWindow, maxTokens: 128, cost: { tiers: [], input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...(thinking.thinkingLevelMap ? { thinkingLevelMap: thinking.thinkingLevelMap } : {}), compat: { requiresThinkingAsText:false, supportsReasoningEffort:parameters.capability.id==='openai-reasoning-v1', maxTokensField: parameters.capability.id==='openai-reasoning-v1'?'max_completion_tokens':'max_tokens', ...(thinking.catalogCompat??{}), ...(thinking.vendorCompat??{}), supportsStore: false, supportsDeveloperRole: false } } as Model<'openai-completions' | 'anthropic-messages'>;
        const start = performance.now();
        const result = await (config.protocol === 'anthropic-messages' ? streamAnthropic : streamOpenAI)(model as never, normalizeContext({ messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }] }), { apiKey, fetch: fetch_, signal, temperature:parameters.effective.temperature, reasoning:parameters.effective.reasoning, maxTokens: 128, timeoutMs: 20000, maxRetries: 0, env: {}, onPayload:thinkingPayloadHook(parameters.advanced,parameters.effective.thinkingLevel) }).result();
        if (safeError)
            throw safeError;
        if (signal.aborted)
            throw new ApiError('MODEL_TIMEOUT', '连接测试已取消或超时');
        if (status === 401 || status === 403)
            throw new ApiError('MODEL_UNAVAILABLE', '接口拒绝访问，请检查 API Key、套餐端点和模型权限');
        if (status === 429)
            throw new ApiError('PROVIDER_RATE_LIMIT', '接口限流或额度不足，请稍后再试');
        if (status === 404)
            throw new ApiError('MODEL_UNAVAILABLE', '接口或模型不存在，请检查 API 地址和模型 ID');
        if (result.stopReason === 'error' || result.stopReason === 'aborted' || status < 200 || status >= 300)
            throw new ApiError('PROVIDER_ERROR', '接口未通过测试，请检查协议兼容性和模型配置');
        return { success: true, latencyMs: Math.round(performance.now() - start) };
    }
    async discover(config: ModelConfigView, apiKey: string, signal: AbortSignal) {
        const response = await this.transport(config.baseUrl)(`${config.baseUrl}${config.protocol === 'anthropic-messages' ? '/v1/models' : '/models'}`, { headers: config.protocol === 'anthropic-messages' ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${apiKey}` }, signal });
        if (!response.ok)
            throw new ApiError('MODEL_UNAVAILABLE', '接口未提供可用模型列表，可继续手动添加模型 ID');
        const data = await response.json() as {
            data?: Array<{
                id?: unknown;
            }>;
        };
        if (!Array.isArray(data.data))
            throw new ApiError('MODEL_UNAVAILABLE', '接口返回格式不兼容，可继续手动添加模型 ID');
        return { models: [...new Set(data.data.map(m => m.id).filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200 && !id.includes(apiKey)))].slice(0, 100) };
    }
}

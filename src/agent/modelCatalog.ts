// 模型能力：默认复用Pi目录，官方已核实的模型事实纠偏；显式用户配置可覆盖。
// 协议不赋予模型视觉能力。按端点/id索引目录，未收录或同名条目冲突时保守处理。
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import type { ModelProtocol } from '../../contracts/v1.js';
import { modelCapability, THINKING_LEVELS, type FrozenModelParameters, type ThinkingLevel, type ModelAdvancedOptions } from '../../contracts/models.js';
import { ApiError } from '../../contracts/errors.js';
import { lookupVendorEndpointFact } from './vendorFacts.js';

interface CatalogHit { id: string; hasImage: boolean; contextWindow: number; maxOutput: number; provider: string; thinkingLevels: ThinkingLevel[]; thinkingLevelMap: Record<string, string | null> | undefined; compat: Record<string, unknown> | undefined }

/** 思考能力 = 厂商文档核实层（vendorFacts，最高优先）合并目录事实与正则回落（temperature 门控与 id 语义保持不变）。 */
export type ThinkingCapability = FrozenModelParameters['capability'] & {
    /** 级别映射（级别翻译用；未收录为 undefined） */
    thinkingLevelMap: Record<string, string | null> | undefined;
    /** 目录条目 compat（仅 baseUrl 精确命中时采信——中转方言不猜，交给 pi-ai detectCompat 按 baseUrl 识别） */
    catalogCompat: Record<string, unknown> | undefined;
    /** 厂商文档方言 compat（vendorFacts 端点命中时携带，合并优先级高于目录） */
    vendorCompat: Record<string, unknown> | undefined;
    /** 事实来源：vendor-docs=官方文档核实；vendor-docs-undocumented=端点官方未载明思考控制（诚实降级）；未命中为 undefined */
    vendorSource: 'vendor-docs' | 'vendor-docs-undocumented' | undefined;
    userConfigured?: boolean;
};

// baseUrl 缺失（旧快照/部分调用路径）时按空串处理，回落 id 匹配而不是抛错
const normBase = (value: string): string => (value ?? '').trim().replace(/\/+$/, '').toLowerCase();

// 原始厂商目录（厂商自有 API 与官方套餐端点）。同名条目窗口结论冲突时优先采信厂商条目：
// 模型事实以厂商为准，聚合转发商（openrouter/radius/opencode 等）目录是转述，常滞后或数值口径
// 不同（如 glm-5.3 多数厂商写 1000000、radius 写 1048576）。未列入的供应商按聚合商处理（保守）。
const FIRST_PARTY_PROVIDERS = new Set([
    'anthropic', 'openai', 'openai-codex', 'deepseek', 'google',
    'zai', 'zai-coding-cn', 'minimax', 'minimax-cn', 'moonshotai', 'moonshotai-cn', 'kimi-coding',
    'qwen-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual', 'qwen-token-plan-individual-cn',
    'xiaomi', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'xiaomi-token-plan-ams', 'ant-ling', 'meta',
]);

let byBase: Map<string, CatalogHit[]> | null = null;
let byId: Map<string, CatalogHit[]> | null = null;

function indexCatalog(): void {
    if (byBase && byId) return;
    const base = new Map<string, CatalogHit[]>();
    const id = new Map<string, CatalogHit[]>();
    for (const provider of getBuiltinProviders()) {
        for (const model of getBuiltinModels(provider)) {
            // 档位枚举与映射过滤交给Pi；非思考模型在产品契约中仍用[]表示隐藏/禁用选择器，
            // 不把Pi的['off']直接下发，否则前端会把它误显示为可调思考模型。
            const hit: CatalogHit = { id: model.id.toLowerCase(), hasImage: model.input.includes('image'), contextWindow: model.contextWindow, maxOutput: model.maxTokens, provider, thinkingLevels: model.reasoning ? getSupportedThinkingLevels(model) : [], thinkingLevelMap: model.thinkingLevelMap as Record<string, string | null> | undefined, compat: model.compat as Record<string, unknown> | undefined };
            const baseKey = normBase(model.baseUrl);
            const baseList = base.get(baseKey);
            if (baseList) baseList.push(hit); else base.set(baseKey, [hit]);
            const idList = id.get(hit.id);
            if (idList) idList.push(hit); else id.set(hit.id, [hit]);
        }
    }
    byBase = base;
    byId = id;
}

export function resolveVisionSupport(protocol: ModelProtocol, baseUrl: string, modelId: string, advanced?: ModelAdvancedOptions): boolean {
    if (advanced?.image !== undefined) return advanced.image;
    if (advanced?.smartConfig === false) return false;
    // GLM-5.3官方明确仅文本；Flash/FlashX是不同的原生多模态型号。
    // 协议不代表视觉能力，不能把所有Anthropic兼容模型按Claude处理。
    if (modelId.trim().toLowerCase() === 'glm-5.3') return false;
    indexCatalog();
    const id = modelId.trim().toLowerCase();
    if (!id) return false;
    const atBase = byBase!.get(normBase(baseUrl))?.filter(h => h.id === id);
    if (atBase && atBase.length > 0) return atBase[0]!.hasImage;
    const anywhere = byId!.get(id);
    if (anywhere && anywhere.length > 0) {
        // 同名条目能力结论冲突（不同家族挂了不同实现）时不猜，按不支持
        const outcomes = new Set(anywhere.map(h => h.hasImage));
        return outcomes.size === 1 && anywhere[0]!.hasImage;
    }
    return false;
}

/** 目录声明的上下文窗口（模型事实，与访问协议无关）；未收录或厂商条目仍冲突时返回 undefined，由调用方回落默认值。
 * 端点收录 → 同 id 全目录唯一结论 → 厂商条目唯一结论（排除聚合转发商）→ undefined。 */
export function resolveModelContextWindow(baseUrl: string, modelId: string): number | undefined {
    indexCatalog();
    const id = modelId.trim().toLowerCase();
    if (!id) return undefined;
    const atBase = byBase!.get(normBase(baseUrl))?.filter(h => h.id === id);
    if (atBase && atBase.length > 0) return atBase[0]!.contextWindow;
    const anywhere = byId!.get(id);
    if (anywhere && anywhere.length > 0) {
        const outcomes = new Set(anywhere.map(h => h.contextWindow));
        if (outcomes.size === 1) return anywhere[0]!.contextWindow;
        // 全目录冲突：先排除聚合转发商，仅原始厂商之间仍各执一词才不猜
        const vendorHits = anywhere.filter(h => FIRST_PARTY_PROVIDERS.has(h.provider));
        const vendorOutcomes = new Set(vendorHits.map(h => h.contextWindow));
        return vendorOutcomes.size === 1 ? vendorHits[0]!.contextWindow : undefined;
    }
    return undefined;
}

/** 目录收录的供应商身份（pi 目录 provider 字段，如 deepseek/zai/zai-coding-cn），供展示层识别品牌。
 * 查找顺序与 resolveModelContextWindow 相同；同 id 被多家供应商收录时不猜（品牌归一交给展示层），返回 undefined。 */
export function resolveModelProvider(baseUrl: string, modelId: string): string | undefined {
    indexCatalog();
    const id = modelId.trim().toLowerCase();
    if (!id) return undefined;
    const atBase = byBase!.get(normBase(baseUrl))?.filter(h => h.id === id);
    if (atBase && atBase.length > 0) return atBase[0]!.provider;
    const anywhere = byId!.get(id);
    if (anywhere && anywhere.length > 0) {
        const outcomes = new Set(anywhere.map(h => h.provider));
        return outcomes.size === 1 ? anywhere[0]!.provider : undefined;
    }
    return undefined;
}

/** 目录声明的单次最大输出（maxTokens，模型事实），即默认请求值；未收录/冲突回落 undefined，
 * 由调用方保持保守默认（4096），生效再受上下文窗口 1/4 约束。
 * 查找顺序与 resolveModelContextWindow 相同：端点收录 → 同 id 全目录唯一结论 → 厂商条目唯一结论 → undefined。 */
export function resolveModelMaxOutputTokens(baseUrl: string, modelId: string): number | undefined {
    indexCatalog();
    const id = modelId.trim().toLowerCase();
    if (!id) return undefined;
    const atBase = byBase!.get(normBase(baseUrl))?.filter(h => h.id === id);
    if (atBase && atBase.length > 0) return atBase[0]!.maxOutput;
    const anywhere = byId!.get(id);
    if (anywhere && anywhere.length > 0) {
        const outcomes = new Set(anywhere.map(h => h.maxOutput));
        if (outcomes.size === 1) return anywhere[0]!.maxOutput;
        const vendorHits = anywhere.filter(h => FIRST_PARTY_PROVIDERS.has(h.provider));
        const vendorOutcomes = new Set(vendorHits.map(h => h.maxOutput));
        return vendorOutcomes.size === 1 ? vendorHits[0]!.maxOutput : undefined;
    }
    return undefined;
}

function capabilityFromHit(hit: CatalogHit, fallback: FrozenModelParameters['capability'], compat: CatalogHit['compat']): ThinkingCapability {
    const levels = hit.thinkingLevels;
    // 非思考目录模型不升级能力（gpt-4o 等回落正则结论，保住 temperature 门控）
    if (levels.length === 0) return { ...fallback, thinkingLevelMap: undefined, catalogCompat: undefined, vendorCompat: undefined, vendorSource: undefined };
    // id 语义不变：正则已识别的家族保留其 id（驱动 reasoning_effort/max_completion_tokens 线上格式）；
    // 仅当正则不认识时才标记为目录思考模型
    return { ...fallback, id: fallback.verified ? fallback.id : 'catalog-thinking-v1', verified: true, thinkingLevels: [...levels], thinkingLevelMap: hit.thinkingLevelMap, catalogCompat: compat, vendorCompat: undefined, vendorSource: undefined };
}

/** 思考能力解析（厂商官方文档核实层最高优先）：vendorFacts 端点×协议精确命中（per-model 逐模型档位；
 * undocumented 端点诚实降级为无档位）→ pi-ai 目录 baseUrl 精确命中（带 compat）→ 同 id 全目录唯一结论
 * （级别与映射一致；compat 不采信——中转方言交给 pi-ai detectCompat）→ 正则回落。
 * temperature 门控与正则 id 始终保留，目录只升级 verified + thinkingLevels。 */
function resolveAutomaticThinkingCapability(protocol: ModelProtocol, baseUrl: string, modelId: string): ThinkingCapability {
    const fallback = modelCapability(protocol, modelId);
    indexCatalog();
    // vendorFacts 命中：per-model=文档档位直接授信；undocumented=该端点官方未载明思考控制，
    // 显式降级（verified:false、无级别）而不是沿用目录/正则推断冒充已验证能力
    const vendor = lookupVendorEndpointFact(protocol, baseUrl);
    if (vendor && vendor.thinkingControl === 'undocumented')
        return { ...fallback, id: 'unverified', verified: false, thinkingLevels: [], thinkingLevelMap: undefined, catalogCompat: undefined, vendorCompat: undefined, vendorSource: 'vendor-docs-undocumented' };
    const id = modelId.trim().toLowerCase();
    if (!id) return { ...fallback, thinkingLevelMap: undefined, catalogCompat: undefined, vendorCompat: undefined, vendorSource: undefined };
    if (vendor && vendor.thinkingControl === 'per-model') {
        const fact = vendor.models?.find(candidate => candidate.modelId === id);
        if (fact) return { id: 'vendor-docs-v1', verified: true, thinkingLevels: [...fact.levels], temperature: fact.temperature, thinkingLevelMap: { ...fact.levelMap }, catalogCompat: undefined, vendorCompat: vendor.compat, vendorSource: 'vendor-docs' };
        // 端点已核实但该模型未逐条记载：不猜，继续目录/正则链
    }
    const atBase = byBase!.get(normBase(baseUrl))?.filter(h => h.id === id);
    if (atBase && atBase.length > 0) return capabilityFromHit(atBase[0]!, fallback, atBase[0]!.compat);
    const anywhere = byId!.get(id);
    if (anywhere && anywhere.length > 0) {
        // 级别与映射结论需全目录一致（不同家族同名条目各执一词时不猜）；compat 不随 id 匹配带出——
        // 该端点未必说同一方言（如标准端点仅收录同厂其他模型），交给 pi-ai detectCompat 按 baseUrl 识别
        const outcomes = new Set(anywhere.map(h => JSON.stringify([h.thinkingLevels, h.thinkingLevelMap ?? null])));
        if (outcomes.size === 1) return capabilityFromHit(anywhere[0]!, fallback, undefined);
    }
    return { ...fallback, thinkingLevelMap: undefined, catalogCompat: undefined, vendorCompat: undefined, vendorSource: undefined };
}

/** 手动配置作为显式覆盖；未载明端点须提供请求映射，不假称官方已验证。 */
export function resolveThinkingCapability(protocol: ModelProtocol, baseUrl: string, modelId: string, advanced?: ModelAdvancedOptions): ThinkingCapability {
    const base = resolveAutomaticThinkingCapability(protocol, baseUrl, modelId);
    if (!advanced || (advanced.smartConfig !== false && advanced.thinkingLevels === undefined && !advanced.thinkingParameterMap)) return base;
    const levels = advanced.thinkingLevels ?? (advanced.smartConfig === false ? [] : base.thinkingLevels);
    if (advanced.thinkingParameterMap && !levels.length) throw new ApiError('VALIDATION_FAILED', '填写推理参数映射时，至少需要一个推理等级');
    if (levels.length && (!base.verified || levels.some(level => !base.thinkingLevels.includes(level))) && !advanced.thinkingParameterMap)
        throw new ApiError('VALIDATION_FAILED', '此接口的手动推理等级需要填写推理参数映射');
    return { ...base, id: advanced.thinkingParameterMap ? 'manual-thinking-v1' : base.id, verified: true, thinkingLevels: [...levels], thinkingLevelMap: advanced.thinkingParameterMap ? Object.fromEntries(THINKING_LEVELS.map(level=>[level,levels.includes(level)?level:null])) : base.thinkingLevelMap, userConfigured: true };
}

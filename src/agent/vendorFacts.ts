// 厂商官方文档核实层（vendorFacts）：思考控制事实以各模型公司 API 开发文档为准，
// 解析优先级高于 pi-ai 随包目录与正则白名单（见 modelCatalog.resolveThinkingCapability）。
// 只收录逐条查阅过官方文档的「端点×协议×模型」组合，每条事实在 docs/vendor-facts/vendor-api-facts.json
// 留有来源 URL、访问日期与原文引用；本模块只携带解析所需的最小事实（档位/映射/方言 compat/temperature 门控）。
// 官方文档未载明思考控制的端点显式登记为 undocumented（如智谱 Anthropic 兼容端点），
// 解析时诚实降级为无思考档位——不沿用目录推断冒充已验证能力。
import type { ModelProtocol } from '../../contracts/v1.js';
import type { ThinkingLevel } from '../../contracts/models.js';

export interface VendorFactSource { topic: string; url: string; accessed: string; quote: string }
export interface VendorModelThinkingFact {
    /** 目录模型 id（小写） */
    modelId: string;
    /** 文档载明的思考档位（含 off=可关闭） */
    levels: ThinkingLevel[];
    /** 档位→厂商线上参数值；null=该档不存在（显式记录，便于与目录哨兵比对） */
    levelMap: Record<string, string | null>;
    /** 文档载明默认档 */
    defaultLevel: ThinkingLevel;
    /** 是否接受显式 temperature（false=文档要求勿传/固定值） */
    temperature: boolean;
    notes?: string[];
}
/** pi-ai Model.compat 的思考相关方言位（展开进 vendorCompat，合并优先级最高） */
export interface VendorEndpointCompat { thinkingFormat?: string; supportsReasoningEffort?: boolean; maxTokensField?: 'max_tokens' | 'max_completion_tokens'; [key: string]: unknown }
export interface VendorEndpointFact {
    vendor: string;
    protocol: ModelProtocol;
    baseUrl: string;
    /** per-model=逐模型档位已核实；undocumented=该端点官方文档未载明思考控制（诚实降级为无档位） */
    thinkingControl: 'per-model' | 'undocumented';
    compat?: VendorEndpointCompat;
    models?: VendorModelThinkingFact[];
    sources: VendorFactSource[];
}

// kimi-k3 / k3.1-pro：reasoning_effort 仅 low/high/max（默认 max），始终思考不可关，
// thinking 参数不支持，temperature 固定 1.0 勿显式传入——off/minimal/medium/xhigh 记 null
const kimiLevelMap: Record<string, string | null> = { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' };
// GLM-5.3 系列（5.3/FLASH/FLASHX）：始终思考（disabled 报错），reasoning_effort 仅接受 low/high/max，其余报错
const glm53LevelMap: Record<string, string | null> = { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' };
// GLM-5.2：可关闭；effort 全枚举，low/medium 映射为 high、xhigh 映射为 max，none/minimal=放弃思考（文档载明的映射照录）
const glm52LevelMap: Record<string, string | null> = { off: 'none', minimal: 'minimal', low: 'high', medium: 'high', high: 'high', xhigh: 'max', max: 'max' };

export const VENDOR_ENDPOINT_FACTS: VendorEndpointFact[] = [
    {
        vendor: 'Moonshot AI（Kimi 开放平台）',
        protocol: 'openai-completions',
        baseUrl: 'https://api.moonshot.cn/v1',
        thinkingControl: 'per-model',
        compat: { thinkingFormat: 'openai', supportsReasoningEffort: true, maxTokensField: 'max_tokens', requiresReasoningContentOnAssistantMessages: true },
        models: [
            { modelId: 'kimi-k3', levels: ['low', 'high', 'max'], levelMap: kimiLevelMap, defaultLevel: 'max', temperature: false, notes: ['始终开启思考模式，目前关不了；thinking 参数不支持；temperature 固定 1.0 请勿显式传入'] },
            { modelId: 'kimi-k3.1-pro', levels: ['low', 'high', 'max'], levelMap: kimiLevelMap, defaultLevel: 'max', temperature: false, notes: ['始终进行推理且保留式思考始终开启；无需（也不应）传入 thinking 参数；temperature 固定 1.0 请勿显式传入'] },
        ],
        sources: [
            { topic: '端点', url: 'https://platform.kimi.com/docs/guide/kimi-k3-quickstart', accessed: '2026-11-14', quote: 'base_url="https://api.moonshot.cn/v1"；cURL 示例调用 https://api.moonshot.cn/v1/chat/completions' },
            { topic: 'kimi-k3 思考与档位', url: 'https://platform.kimi.com/docs/guide/kimi-k3-quickstart', accessed: '2026-11-14', quote: 'K3 始终开启思考模式；推理强度支持 low / high / max 三档（默认 max）' },
            { topic: 'kimi-k3.1-pro 思考与档位', url: 'https://platform.kimi.com/docs/guide/use-thinking-models', accessed: '2026-11-14', quote: '始终进行推理且保留式思考（Preserved Thinking）始终开启；无需（也不应）传入 thinking 参数；reasoning_effort 支持 "low" / "high" / "max"（默认 "max"）' },
            { topic: 'temperature', url: 'https://platform.kimi.com/docs/guide/use-thinking-models', accessed: '2026-11-14', quote: '无需设置 temperature。kimi-k3.1-pro 和 kimi-k3 的 temperature 固定为 1.0，请勿显式传入' },
            { topic: '多轮 assistant message 回传', url: 'https://platform.kimi.com/docs/guide/kimi-k3-quickstart', accessed: '2026-11-14', quote: '多轮对话和工具调用时，将 API 返回的完整 assistant message 原样加入下一次请求' },
        ],
    },
    {
        vendor: '智谱 AI（GLM 开放平台）',
        protocol: 'openai-completions',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        thinkingControl: 'per-model',
        compat: { thinkingFormat: 'zai', supportsReasoningEffort: true, maxTokensField: 'max_tokens' },
        models: [
            { modelId: 'glm-5.3', levels: ['low', 'high', 'max'], levelMap: glm53LevelMap, defaultLevel: 'max', temperature: true, notes: ['始终思考，thinking.type 传 disabled 将报错；reasoning_effort 仅接受 max/high/low，其余输入报错；1M 上下文 / 128K 最大输出'] },
            { modelId: 'glm-5.3-flash', levels: ['low', 'high', 'max'], levelMap: glm53LevelMap, defaultLevel: 'max', temperature: true, notes: ['与 glm-5.3 同约束：始终思考、effort 仅 max/high/low；1M 上下文 / 128K 最大输出；视觉输入；建议 thinking.clear_thinking:false'] },
            { modelId: 'glm-5.3-flashx', levels: ['low', 'high', 'max'], levelMap: glm53LevelMap, defaultLevel: 'max', temperature: true, notes: ['GLM-5.3 系列同约束：effort 仅接受 max/high/low'] },
            { modelId: 'glm-5.2', levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], levelMap: glm52LevelMap, defaultLevel: 'max', temperature: true, notes: ['可关闭（thinking.type=disabled 仅 GLM-5.2 支持）；文档载明映射：low/medium→high、xhigh→max，none/minimal=放弃思考'] },
        ],
        sources: [
            { topic: '端点', url: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3', accessed: '2026-11-14', quote: 'OpenAI Chat Completion 协议的 Base URL 为 https://open.bigmodel.cn/api/paas/v4' },
            { topic: 'glm-5.3 强制思考与档位', url: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3', accessed: '2026-11-14', quote: '思考功能始终开启，仅支持 thinking.type:"enabled"；reasoning_effort 取值为 low、high、max，默认值为 max' },
            { topic: 'GLM-5.3 系列档位约束', url: 'https://docs.bigmodel.cn/cn/guide/capabilities/thinking', accessed: '2026-11-14', quote: 'GLM-5.3 GLM-5.3-FLASH 不再支持关闭思考（API 请求中 thinking.type 传 disabled 将会报错）；GLM-5.3 系列 API 中仅接受 max、high、low，其余输入将报错；low 仅 GLM-5.3 支持' },
            { topic: 'glm-5.3-flash 能力', url: 'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash', accessed: '2026-11-14', quote: 'thinking.type 仅支持 enabled，不支持关闭思考；上下文窗口 1M，最大输出 128K；输入模态为视频、图像、文本、文件' },
            { topic: 'glm-5.2 全枚举与映射', url: 'https://docs.bigmodel.cn/cn/guide/capabilities/thinking', accessed: '2026-11-14', quote: 'GLM-5.2 支持 max、xhigh、high、medium、low、minimal、none；none 或 minimal 代表模型放弃思考；low / medium 映射为 high；xhigh 映射为 max；禁用深度思考仅 GLM-5.2 支持' },
            { topic: 'temperature', url: 'https://docs.bigmodel.cn/cn/guide/capabilities/thinking', accessed: '2026-11-14', quote: '文档未载明思考开启时的 temperature 限制（示例使用 temperature:1.0）' },
        ],
    },
    {
        vendor: '智谱 AI（GLM Coding Plan）',
        protocol: 'openai-completions',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        thinkingControl: 'per-model',
        compat: { thinkingFormat: 'zai', supportsReasoningEffort: true, maxTokensField: 'max_tokens' },
        models: [
            { modelId: 'glm-5.3', levels: ['low', 'high', 'max'], levelMap: glm53LevelMap, defaultLevel: 'max', temperature: true, notes: ['Coding Plan 已全量支持；档位约束同标准端点'] },
            { modelId: 'glm-5.3-flash', levels: ['low', 'high', 'max'], levelMap: glm53LevelMap, defaultLevel: 'max', temperature: true, notes: ['Coding Plan 已全量支持；档位约束同标准端点'] },
        ],
        sources: [
            { topic: '端点', url: 'https://docs.bigmodel.cn/cn/coding-plan/tool/others', accessed: '2026-11-14', quote: '编程端点为 https://open.bigmodel.cn/api/coding/paas/v4，支持 Anthropic 协议和 OpenAI 协议两种接入方式' },
            { topic: 'Coding Plan 协议限制', url: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3', accessed: '2026-11-14', quote: '订阅过 GLM Coding Plan 的用户暂时您只能通过 OpenAI Chat Completion 协议调用模型 API' },
            { topic: 'Coding Plan 模型支持', url: 'https://docs.bigmodel.cn/cn/coding-plan/latest-model', accessed: '2026-11-14', quote: '已全量支持 GLM-5.3 和 GLM-5.3-Flash' },
        ],
    },
    {
        // Anthropic 兼容端点官方文档只覆盖 base_url 替换与 SDK 示例，未载明 thinking/budget_tokens；
        // 显式登记 undocumented：解析时诚实降级为无思考档位（思考强度在该端点不可控）
        vendor: '智谱 AI（GLM Anthropic 兼容端点）',
        protocol: 'anthropic-messages',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        thinkingControl: 'undocumented',
        sources: [
            { topic: '端点', url: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3', accessed: '2026-11-14', quote: 'Anthropic Message 协议（https://open.bigmodel.cn/api/anthropic）' },
            { topic: 'thinking 控制未载明', url: 'https://docs.bigmodel.cn/cn/guide/develop/claude/introduction', accessed: '2026-11-14', quote: '页面仅覆盖 base_url 替换与多语言 SDK 示例，未提及 thinking/extended thinking/budget_tokens；"某些场景下智谱与 Claude 接口仍存在差异，但不影响整体兼容性"' },
        ],
    },
    {
        // DeepSeek：thinking.type enabled/disabled + reasoning_effort none/low/high/max（默认 effort high），
        // 思考默认开启可关闭；文档载明兼容映射 minimal→low、medium/xhigh→high。目录条目缺
        // supportsReasoningEffort（棱镜显式 compat 会盖掉 detectCompat）→ 此前 effort 档位静默丢失，
        // 事实层显式补上。temperature [0,2] 接受但思考模式下无效
        vendor: 'DeepSeek（深度求索）',
        protocol: 'openai-completions',
        baseUrl: 'https://api.deepseek.com',
        thinkingControl: 'per-model',
        compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true, maxTokensField: 'max_tokens' },
        models: [
            { modelId: 'deepseek-flash', levels: ['off', 'low', 'high', 'max'], levelMap: { minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'high', max: 'max' }, defaultLevel: 'high', temperature: true, notes: ['当前由 DeepSeek-V4.1-Flash-1017 供服务；思考默认开启，type:"disabled" 或 effort:"none" 关闭；默认 effort high；带 tools 时必须完整回传 reasoning_content 否则 400'] },
            { modelId: 'deepseek-v4-pro', levels: ['off', 'low', 'high', 'max'], levelMap: { minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'high', max: 'max' }, defaultLevel: 'high', temperature: true, notes: ['档位枚举与 deepseek-flash 一致（文档同一 effort 说明覆盖两模型）'] },
        ],
        sources: [
            { topic: '端点', url: 'https://api-docs.deepseek.com/', accessed: '2026-11-14', quote: 'base_url (OpenAI) https://api.deepseek.com；base_url (Anthropic) https://api.deepseek.com/anthropic' },
            { topic: '模型枚举', url: 'https://api-docs.deepseek.com/api/create-chat-completion', accessed: '2026-11-14', quote: 'model "Possible values: deepseek-flash, deepseek-v4-pro"；"Use deepseek-flash as the model name. It is now served by DeepSeek-V4.1-Flash-1017"' },
            { topic: 'thinking 与 effort 优先级', url: 'https://api-docs.deepseek.com/api/create-chat-completion', accessed: '2026-11-14', quote: 'When thinking is omitted or null, the mode follows reasoning_effort; if reasoning_effort is also omitted, thinking is enabled' },
            { topic: 'effort 档位与映射', url: 'https://api-docs.deepseek.com/api/create-chat-completion', accessed: '2026-11-14', quote: 'Possible values: none, low, high, max... The default effort is high. For compatibility..., minimal is accepted and mapped to low, and medium/xhigh are accepted and mapped to high' },
            { topic: 'temperature', url: 'https://api-docs.deepseek.com/api/create-chat-completion', accessed: '2026-11-14', quote: 'Possible values: >= 0 and <= 2；Default value: 1... Has no effect in thinking mode' },
            { topic: '工具回传', url: 'https://api-docs.deepseek.com/zh-cn/guides/thinking_mode', accessed: '2026-11-14', quote: '带 tools 时必须完整回传 reasoning_content，否则 API 会返回 400 报错' },
        ],
    },
    {
        // 阿里 Qwen（百炼/DashScope OpenAI 兼容模式）：qwen3.8 混合思考系列 enable_thinking（非 OpenAI
        // 标准参数，HTTP JSON body 直接携带）+ reasoning_effort xhigh(默认)/medium/low，映射
        // max/high→xhigh、minimal→low、none→关闭。pi-ai qwen 方言（enable_thinking）原生支持；
        // 目录未收录 compatible-mode 端点，detectCompat 也不识别 dashscope → 事实层钉住方言与 max_tokens
        vendor: '阿里云（Qwen 百炼/DashScope）',
        protocol: 'openai-completions',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        thinkingControl: 'per-model',
        compat: { thinkingFormat: 'qwen', supportsReasoningEffort: true, maxTokensField: 'max_tokens' },
        models: [
            { modelId: 'qwen3.8-max', levels: ['off', 'low', 'medium', 'xhigh'], levelMap: { minimal: 'low', low: 'low', medium: 'medium', high: 'xhigh', xhigh: 'xhigh', max: 'xhigh' }, defaultLevel: 'xhigh', temperature: true, notes: ['混合思考默认开启，enable_thinking=false 或 effort none 关闭；文档默认档 xhigh（棱镜默认档策略仍为 medium）；文档映射 max→xhigh、high→xhigh、minimal→low'] },
            { modelId: 'qwen3.8-max-0902', levels: ['off', 'low', 'medium', 'xhigh'], levelMap: { minimal: 'low', low: 'low', medium: 'medium', high: 'xhigh', xhigh: 'xhigh', max: 'xhigh' }, defaultLevel: 'xhigh', temperature: true, notes: ['同 qwen3.8-max'] },
            { modelId: 'qwen3.8-flash', levels: ['off', 'low', 'medium', 'xhigh'], levelMap: { minimal: 'low', low: 'low', medium: 'medium', high: 'xhigh', xhigh: 'xhigh', max: 'xhigh' }, defaultLevel: 'xhigh', temperature: true, notes: ['同 qwen3.8-max；多轮 preserve_thinking 默认 true，需完整回传 reasoning_content'] },
            { modelId: 'qwen3.8-27b', levels: ['off', 'low', 'medium', 'xhigh'], levelMap: { minimal: 'low', low: 'low', medium: 'medium', high: 'xhigh', xhigh: 'xhigh', max: 'xhigh' }, defaultLevel: 'xhigh', temperature: true, notes: ['同 qwen3.8-max'] },
        ],
        sources: [
            { topic: '端点', url: 'https://help.aliyun.com/zh/model-studio/base-url', accessed: '2026-11-14', quote: '国内（华北2北京）OpenAI 兼容 https://dashscope.aliyuncs.com/compatible-mode/v1；国际（新加坡）https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
            { topic: 'enable_thinking', url: 'https://help.aliyun.com/zh/model-studio/deep-thinking', accessed: '2026-11-14', quote: '设为 true：模型先思考再回复；设为 false：模型直接回复；该参数非 OpenAI 标准参数，通过 Python SDK 调用时请放入 extra_body' },
            { topic: 'qwen3.8 effort 档位', url: 'https://help.aliyun.com/zh/model-studio/deep-thinking', accessed: '2026-11-14', quote: '默认值为 xhigh 可选值：xhigh（默认）：高力度推理 medium：中力度推理 low：低力度推理 max 映射为 xhigh，high 映射为 xhigh，minimal 映射为 low，none 映射为 enable_thinking=False' },
            { topic: 'temperature', url: 'https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions', accessed: '2026-11-14', quote: '取值范围： [0, 2)，不建议取值为 0；qwen3.8-max/qwen3.8-flash（思考模式）文本输入 1.0，0.6 以下的 temperature 值会默认改为 0.6' },
            { topic: '多轮回传', url: 'https://help.aliyun.com/zh/model-studio/deep-thinking', accessed: '2026-11-14', quote: '使用 qwen3.8-max/qwen3.8-flash 时，preserve_thinking 默认为 true，必须将历史对话中所有的 reasoning_content 完整回传' },
        ],
    },
];

const normBase = (value: string): string => (value ?? '').trim().replace(/\/+$/, '').toLowerCase();

let byBase: Map<string, VendorEndpointFact> | null = null;
function indexFacts(): Map<string, VendorEndpointFact> {
    if (byBase) return byBase;
    const index = new Map<string, VendorEndpointFact>();
    for (const fact of VENDOR_ENDPOINT_FACTS) index.set(`${normBase(fact.baseUrl)}|${fact.protocol}`, fact);
    byBase = index;
    return index;
}

/** 端点×协议 精确命中厂商事实；自定义中转/未收录端点返回 undefined（回落目录与正则链，不猜） */
export function lookupVendorEndpointFact(protocol: ModelProtocol, baseUrl: string): VendorEndpointFact | undefined {
    return indexFacts().get(`${normBase(baseUrl)}|${protocol}`);
}

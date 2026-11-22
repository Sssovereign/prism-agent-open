import type { ModelConfigInput, ModelEntryInput, ModelProtocol } from './v1.js';
import type { SearchBindingInfo } from './search.js';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function isThinkingLevel(value: unknown): value is ThinkingLevel { return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value); }
/** 思考级别中文标签（设置页与任务窗口共用）。 */
// 与 ZCode zh-CN 词表对齐（i18n/locales/zh-CN.ts chat.toolbar.thoughtLevel.value.*）
export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = { off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' };
/** 用户显式模型配置；不冒充官方能力。JSON映射仅能覆盖模型参数，不能改消息、工具或鉴权。 */
export interface ModelAdvancedOptions {
    smartConfig?: boolean;
    image?: boolean;
    thinkingLevels?: ThinkingLevel[];
    thinkingParameterMap?: Record<string, unknown>;
}
export interface ModelMetadataView {
    smartConfig: boolean;
    source: 'manual' | 'vendor-docs' | 'catalog' | 'unverified';
    image: boolean;
    thinkingLevels: ThinkingLevel[];
    thinkingParameterMap: Record<string, unknown> | null;
    defaults: { image: boolean; thinkingLevels: ThinkingLevel[]; contextWindow: number | null; maxOutputTokens: number };
}
export interface FrozenModelParameters {
    requested: Record<string, unknown>;
    /** contextWindow=null＝目录未收录且未手填：窗口未知不造数（D55 不猜），消费端按未知降级 */
    effective: { temperature?: number; contextWindow: number | null; maxOutputTokens: number; thinkingLevel: ThinkingLevel; reasoning?: Exclude<ThinkingLevel, 'off'> };
    capability: { id: string; verified: boolean; thinkingLevels: ThinkingLevel[]; temperature: boolean };
    adjustments: Array<{field:string;reason:string;requested:unknown;effective:unknown}>;
    policyVersion: 'runtime-parameters-v1';
    advanced?: ModelAdvancedOptions;
}
/** Conservative protocol/model allowlist. A custom alias is not evidence of support. */
export function modelCapability(protocol: ModelProtocol, modelId: string): FrozenModelParameters['capability'] {
    if (protocol === 'openai-completions' && /^(gpt-4o|gpt-4o-mini|gpt-4\.1|gpt-4\.1-mini|gpt-4\.1-nano)(-\d{4}-\d{2}-\d{2})?$/.test(modelId))
        return { id:'openai-text-v1', verified:true, temperature:true, thinkingLevels:[] };
    if (protocol === 'openai-completions' && /^(o3|o3-mini|o4-mini)(-\d{4}-\d{2}-\d{2})?$/.test(modelId))
        return { id:'openai-reasoning-v1', verified:true, temperature:false, thinkingLevels:['low','medium','high'] };
    if (protocol === 'anthropic-messages' && /^(claude-3-7-sonnet-20250219|claude-sonnet-4-20250514|claude-opus-4-20250514)$/.test(modelId))
        return { id:'anthropic-budget-v1', verified:true, temperature:true, thinkingLevels:['off','low','medium','high'] };
    return { id:'unverified', verified:false, temperature:false, thinkingLevels:[] };
}
export interface SubagentSettings { enabled:boolean; maxSteps:number; timeoutSeconds:number }
export const DEFAULT_SUBAGENT_SETTINGS:SubagentSettings={enabled:true,maxSteps:20,timeoutSeconds:120};
/** 子代理内置系统提示词（只读研究代理的安全约束是基底，用户自定义只能追加，不能替换）。 */
export const DEFAULT_SUBAGENT_SYSTEM_PROMPT = [
    '你是主代理派出的只读研究子代理。你的职责：独立调查、检索与汇总，并把结论以文本返回给主代理。',
    '约束：只有只读工具（读取文件/浏览目录/搜索文件/联网抓取/搜索网页/任务清单）；不能写文件、删除文件、执行命令或派生更深层子代理。',
    '行为：聚焦主代理交给的具体问题，引用具体文件路径与来源；找不到就明说，不猜测；完成后输出一段完整结论（要点+证据位置），不要反问主代理。',
].join('\n');
/** 压缩器内置系统提示词（摘要的结构与字数约束是基底，用户自定义只能追加）。 */
export const DEFAULT_COMPACTION_SYSTEM_PROMPT = '你是执行链的上下文压缩器。基于对话记录生成结构化摘要，供后续继续执行任务：保留任务目标与用户补充、已完成的关键操作与结果（文件路径/命令/结论）、未完成事项与下一步、重要约束与错误教训。只概括记录中真实发生的内容，不得编造；摘要控制在1200字以内。';
/** 系统提示词自定义：均为「追加」语义——内置默认始终保留为基底，自定义文本附于其后；trim 后空串视为未设置。mainAppend 追加在主链路 system prompt（项目规则之前）。 */
export interface AgentPromptSettings { subagent?:string; compaction?:string; mainAppend?:string }
export interface AgentRuntimeSettings { autoCompaction:boolean; keepRecentTurns:number; subagent?:SubagentSettings; prompts?:AgentPromptSettings; askUserQuestionAutoResolutionEnabled?:boolean; /** 持久记忆库开关（按项目隔离，普通任务生效）；缺省开启 */ memoryEnabled?:boolean;
    /** 研究能力位：参与者可用 MCP 工具（仅只读声明工具，发起研究时逐工具显式勾选冻结）；缺省开启 */ researchMcpTools?:boolean;
    /** 研究能力位：技能正文冻结注入为分析方法（发起时显式选择）；缺省开启 */ researchSkillMethods?:boolean;
    /** 研究能力位：项目记忆索引作只读背景上下文注入；缺省开启 */ researchMemory?:boolean;
    /** 研究能力位：主持/汇总可用 verify_source 核验引证来源（不新增证据）；缺省开启 */ researchHostVerify?:boolean;
    /** 研究 run 级模型请求上限（发起时冻结，40—400）；缺省240（ordinaryTools 阶段按需读取每次工具回合计入请求，80 已不够一场完整辩论） */ researchModelRequestLimit?:number;
    /** 研究 run 级工具请求上限（发起时冻结，60—600）；缺省480 */ researchToolRequestLimit?:number }
export const AGENT_PROMPT_MAX_CHARS = 8000;
const AGENT_PROMPT_KEYS: Array<keyof AgentPromptSettings> = ['subagent','compaction','mainAppend'];
/** 规整自定义提示词：非法输入整体丢弃，逐键 trim、限长，全空视为未设置（输出不含 prompts 键）。 */
export function normalizeAgentPrompts(value:unknown):AgentPromptSettings|undefined{
    if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
    const raw=value as Record<string,unknown>,result:AgentPromptSettings={};
    let any=false;
    for(const key of AGENT_PROMPT_KEYS){
        const v=raw[key];
        if(typeof v!=='string')continue;
        const text=v.trim().slice(0,AGENT_PROMPT_MAX_CHARS);
        if(!text)continue;
        result[key]=text;any=true;
    }
    return any?result:undefined;
}
function clampIntSetting(v:unknown,min:number,max:number,dflt:number):number{ const n=typeof v==='number'&&Number.isFinite(v)?Math.floor(v):NaN; return Number.isNaN(n)?dflt:Math.min(max,Math.max(min,n)); }
export function normalizeAgentSettings(value:Partial<AgentRuntimeSettings>):AgentRuntimeSettings{
    const base:AgentRuntimeSettings={...DEFAULT_AGENT_SETTINGS,...value,subagent:{...DEFAULT_SUBAGENT_SETTINGS,...value.subagent}};
    base.memoryEnabled=value.memoryEnabled!==false;
    // 研究能力位：缺省开启（自由度归还用户，默认安全语义由协议冻结与只读过滤保证）
    base.researchMcpTools=value.researchMcpTools!==false;
    base.researchSkillMethods=value.researchSkillMethods!==false;
    base.researchMemory=value.researchMemory!==false;
    base.researchHostVerify=value.researchHostVerify!==false;
    base.researchModelRequestLimit=clampIntSetting(value.researchModelRequestLimit,40,400,240);
    base.researchToolRequestLimit=clampIntSetting(value.researchToolRequestLimit,60,600,480);
    const prompts=normalizeAgentPrompts(value.prompts);
    if(prompts){base.prompts=prompts;return base;}
    delete base.prompts;
    return base;
}
export const DEFAULT_AGENT_SETTINGS: AgentRuntimeSettings = { autoCompaction:true, keepRecentTurns:3, memoryEnabled:true, subagent:{...DEFAULT_SUBAGENT_SETTINGS}, askUserQuestionAutoResolutionEnabled:true, researchMcpTools:true, researchSkillMethods:true, researchMemory:true, researchHostVerify:true, researchModelRequestLimit:240, researchToolRequestLimit:480 };
export interface ModelConfigView extends Omit<ModelConfigInput, 'models'> {
    id: string;
    revision: number;
    enabled: boolean;
    hasCredential: boolean;
    updatedAt: string;
    /** 接口级搜索能力位（勾选持久化的厂商 id；null=未勾选，回落全局搜索设置）。 */
    searchProvider: string | null;
    /** 服务端按 baseUrl 推导的绑定信息：勾选可用性/厂商/套餐端点警告。 */
    searchBinding: SearchBindingInfo;
    /** 图片输入能力由服务端按 pi-ai 目录解析后下发；前端不再自判 */
    models: Array<ModelEntryInput & { metadata?: ModelMetadataView; visionSupported: boolean; /** 目录声明的上下文窗口（未收录/冲突为 null，前端显「未收录」不造数） */ contextWindowDefault: number | null; /** 目录声明的思考级别（空数组=不支持，前端禁用下拉） */ thinkingLevels: ThinkingLevel[]; /** 目录声明的单次最大输出（未收录/冲突为 null，前端回落 4096） */ maxOutputTokensDefault: number | null; /** pi 目录供应商身份（deepseek/zai/…，未收录/冲突 null），前端据此渲染品牌标识 */ providerId: string | null }>;
}
/** 厂商预设目录：对齐本地品牌图标（web/providerBrands.ts）逐一提供官方默认接口地址，protocol 随预设选定
 *  （Anthropic 走原生 anthropic-messages，其余为 OpenAI Chat Completions 兼容）。逐家查阅开发文档核对
 *  （2026-11-16，原文引用与 URL 留档 docs/vendor-facts/vendor-api-facts.json 与本轮回执）：
 *  deepseek=api-docs.deepseek.com；qwen=help.aliyun.com/zh/model-studio/base-url；kimi=platform.kimi.com
 *  kimi-k3-quickstart；minimax=platform.minimax.cn text-generation；xiaomi=mimo.mi.com first-api-call；
 *  hunyuan=cloud.tencent.com/document/product/1729/111007；volcengine=www.volcengine.com/docs/82379；
 *  stepfun=platform.stepfun.com（海外 platform.stepfun.ai）；siliconflow=docs.siliconflow.cn
 *  chat-completions；openai=developers.openai.com/api/reference；anthropic=platform.claude.com
 *  docs/en/api/messages（官方 base https://api.anthropic.com，SDK 拼 /v1/messages）；xai=docs.x.ai
 *  （/v1/chat/completions 官方标注 legacy 仍受支持，主推 /v1/responses——棱镜未实现 Responses 协议）；
 *  openrouter=openrouter.ai/docs/api-reference/overview；opencode=pi 目录内置 provider（Zen 网关）。
 *  模型 ID 取自各文档示例与 pi-ai 随包目录（node_modules @earendil-works/pi-ai providers/data）。 */
export const MODEL_PRESETS: Array<{
    id: ModelConfigInput['preset'];
    name: string;
    baseUrl: string;
    protocol: ModelProtocol;
    models: string[];
}> = [
    // 国内（图标覆盖：deepseek/zai/qwen/tencent/volcengine/moonshot-kimi/minimax/xiaomi/stepfun/siliconflow）
    { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', protocol: 'openai-completions', models: ['deepseek-flash', 'deepseek-v4-pro'] },
    { id: 'glm-cn-coding', name: 'GLM 国内 Coding Plan', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', protocol: 'openai-completions', models: ['glm-5.3', 'glm-5.3-flash'] },
    { id: 'glm-cn-standard', name: 'GLM 国内标准 API', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai-completions', models: ['glm-5.3', 'glm-5.3-flash'] },
    { id: 'qwen', name: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'openai-completions', models: ['qwen3.8-max', 'qwen3.8-flash'] },
    { id: 'qianfan', name: '百度千帆', baseUrl: 'https://qianfan.baidubce.com/v2', protocol: 'openai-completions', models: ['ernie-4.5-turbo-128k-preview'] },
    { id: 'kimi', name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', protocol: 'openai-completions', models: ['kimi-k3.1-pro', 'kimi-k3'] },
    { id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimax.cn/v1', protocol: 'openai-completions', models: ['MiniMax-M3.1-Flash', 'MiniMax-M3'] },
    { id: 'xiaomi', name: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', protocol: 'openai-completions', models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'] },
    { id: 'hunyuan', name: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', protocol: 'openai-completions', models: ['hunyuan-turbos-latest', 'hunyuan-vision'] },
    { id: 'volcengine', name: '火山方舟（豆包）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', protocol: 'openai-completions', models: ['doubao-seed-1-6-250615'] },
    { id: 'stepfun', name: '阶跃星辰', baseUrl: 'https://api.stepfun.com/v1', protocol: 'openai-completions', models: ['step-5-preview'] },
    { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', protocol: 'openai-completions', models: ['deepseek-ai/DeepSeek-V3.2'] },
    // 国际（zai/openai/anthropic/xai）
    { id: 'glm-global-coding', name: 'GLM 国际 Coding Plan', baseUrl: 'https://api.z.ai/api/coding/paas/v4', protocol: 'openai-completions', models: ['glm-5.3', 'glm-5.3-flash'] },
    { id: 'glm-global-standard', name: 'GLM 国际标准 API', baseUrl: 'https://api.z.ai/api/paas/v4', protocol: 'openai-completions', models: ['glm-5.3', 'glm-5.3-flash'] },
    { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-completions', models: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-5.5'] },
    { id: 'anthropic', name: 'Anthropic（Claude）', baseUrl: 'https://api.anthropic.com', protocol: 'anthropic-messages', models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'] },
    { id: 'xai', name: 'xAI（Grok）', baseUrl: 'https://api.x.ai/v1', protocol: 'openai-completions', models: ['grok-4.7', 'grok-4.6'] },
    // 聚合网关（openrouter/opencode——本地均有品牌图标）
    { id: 'openrouter', name: 'OpenRouter（聚合）', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai-completions', models: ['~openai/gpt-sol-latest', 'openai/gpt-5.2'] },
    { id: 'opencode', name: 'OpenCode Zen（聚合）', baseUrl: 'https://opencode.ai/inference/openai/v1', protocol: 'openai-completions', models: ['glm-5.3', 'deepseek-v4-pro'] },
    // 自定义：协议由表单「API 类型」选择，预设不代答
    { id: 'custom', name: '自定义', baseUrl: '', protocol: 'openai-completions', models: [] },
];

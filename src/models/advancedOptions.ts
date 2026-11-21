import { ApiError } from '../../contracts/errors.js';
import { isThinkingLevel, THINKING_LEVELS, type ModelAdvancedOptions, type ThinkingLevel } from '../../contracts/models.js';

const PAYLOAD_KEYS = new Set(['thinking', 'output_config', 'reasoning_effort', 'reasoning', 'enable_thinking']);
function fail(message: string): never { throw new ApiError('VALIDATION_FAILED', message); }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** JSON数据模板，不执行CEL/JS；限制能改写的供应商参数，不能覆盖消息、模型、工具、流或凭据。 */
export function parseAdvancedOptions(raw: unknown): ModelAdvancedOptions | undefined {
    if (raw === undefined) return undefined;
    if (!object(raw) || Object.keys(raw).some(k => !['smartConfig','image','thinkingLevels','thinkingParameterMap'].includes(k))) fail('模型高级配置格式无效');
    for (const key of ['smartConfig','image']) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') fail('智能配置和图片能力须为布尔值');
    if (raw.thinkingLevels !== undefined && (!Array.isArray(raw.thinkingLevels) || raw.thinkingLevels.length > 7 || raw.thinkingLevels.some(v => !isThinkingLevel(v)) || new Set(raw.thinkingLevels).size !== raw.thinkingLevels.length)) fail('推理等级须为不重复的受支持档位');
    if (Array.isArray(raw.thinkingLevels) && raw.thinkingLevels.some((level,index,all)=>index>0&&THINKING_LEVELS.indexOf(level)<=THINKING_LEVELS.indexOf(all[index-1]))) fail('推理等级须按强度从低到高排列');
    if (raw.thinkingParameterMap !== undefined) {
        const map = raw.thinkingParameterMap;
        if (!object(map) || !Object.keys(map).length || JSON.stringify(map).length > 8000) fail('推理参数映射须为非空JSON对象，最多8000字符');
        function inspect(value: unknown, depth = 0): void {
            if (depth > 8) fail('推理参数映射嵌套过深');
            if (object(value)) for (const [key,child] of Object.entries(value)) {
                if (['__proto__','constructor','prototype'].includes(key)) fail('推理参数映射含无效字段');
                inspect(child, depth + 1);
            }
            else if (Array.isArray(value)) value.forEach(child => inspect(child, depth + 1));
            else if (value !== null && !['string','number','boolean'].includes(typeof value)) fail('推理参数映射须为JSON数据');
        }
        inspect(map);
        const keyed = Object.keys(map).every(isThinkingLevel);
        const payloads = keyed ? Object.values(map) : [map];
        for (const payload of payloads) if (!object(payload) || !Object.keys(payload).length || Object.keys(payload).some(k => !PAYLOAD_KEYS.has(k))) fail('推理映射仅支持thinking、output_config、reasoning_effort、reasoning和enable_thinking');
        if (keyed && Array.isArray(raw.thinkingLevels) && raw.thinkingLevels.some(level => !(String(level) in map))) fail('每个推理等级都需要对应的请求映射');
    }
    return JSON.parse(JSON.stringify(raw)) as ModelAdvancedOptions;
}

export function mappedThinkingPayload(advanced: ModelAdvancedOptions | undefined, level: ThinkingLevel): Record<string, unknown> | undefined {
    const map = advanced?.thinkingParameterMap;
    if (!map) return undefined;
    const keyed = Object.keys(map).every(isThinkingLevel);
    const payload = keyed ? map[level] : map;
    if (!object(payload)) fail('当前档位缺少推理参数映射');
    const substitute = (value: unknown): unknown => {
        if (value === '$level') return level;
        if (Array.isArray(value)) return value.map(substitute);
        if (object(value)) return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,substitute(v)]));
        return value;
    };
    return substitute(payload) as Record<string, unknown>;
}

/** 在Pi构建完成的请求体上应用已校验配置；两条调用链共用，保留冻结参数和相同线上语义。 */
export function thinkingPayloadHook(advanced: ModelAdvancedOptions | undefined, level: ThinkingLevel) {
    const patch = mappedThinkingPayload(advanced, level);
    if (!patch) return undefined;
    return (payload: unknown): unknown => {
        const base = { ...(payload as Record<string, unknown>) };
        // 移除Pi默认推理方言，防止与用户选定的兼容协议参数并存冲突。
        for (const key of PAYLOAD_KEYS) delete base[key];
        return { ...base, ...patch };
    };
}

import { ApiError } from '../../contracts/errors.js';
import { type FrozenModelParameters, type ThinkingLevel, THINKING_LEVELS, isThinkingLevel } from '../../contracts/models.js';
import type { ModelProtocol } from '../../contracts/v1.js';
import { resolveModelContextWindow, resolveModelMaxOutputTokens, resolveThinkingCapability } from '../agent/modelCatalog.js';
import { parseAdvancedOptions, mappedThinkingPayload } from './advancedOptions.js';

export function resolveModelParameters(protocol: ModelProtocol, baseUrl: string, modelId: string, raw: Record<string, unknown>): FrozenModelParameters {
    const fail = (message:string):never => { throw new ApiError('VALIDATION_FAILED',message); };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('模型参数必须是对象');
    for (const key of Object.keys(raw)) if (!['temperature','contextWindow','maxOutputTokens','thinkingMode','thinkingLevel','advanced'].includes(key)) fail(`不支持模型参数：${key}`);
    const advanced = parseAdvancedOptions(raw.advanced);
    const integer = (key:string, fallback:number, min:number, max:number) => {
        const value=raw[key]??fallback;
        if (typeof value!=='number'||!Number.isInteger(value)||value<min||value>max) return fail(`${key}须为${min}—${max}整数`);
        return value;
    };
    // 上下文窗口是模型事实：显式覆盖 > pi-ai 目录档案 > null（未知不造数，D55 不猜）。
    // 未知窗口的降级由消费端承担：自动压缩禁用（无法安全判定触发点）、窗口 1/4 上限不生效
    const catalogWindow=resolveModelContextWindow(baseUrl,modelId);
    const explicitWindow=raw.contextWindow;
    const contextWindow=explicitWindow===undefined||explicitWindow===null
        ?catalogWindow??null
        :(typeof explicitWindow==='number'&&Number.isInteger(explicitWindow)&&explicitWindow>=4096&&explicitWindow<=2000000
            ?explicitWindow
            :fail('contextWindow须为4096—2000000整数'));
    // 单次最大输出是模型事实：未手填默认直接取 pi 目录 maxTokens（未收录保守 4096），
    // 生效受上下文窗口 1/4 约束（保留输入与压缩预算）；窗口未知时仅受平台上限约束
    const catalogMaxOutput=resolveModelMaxOutputTokens(baseUrl,modelId);
    const requestedOutput=integer('maxOutputTokens',catalogMaxOutput??4096,1,2000000);
    const maxOutputTokens=contextWindow===null?requestedOutput:Math.min(requestedOutput,Math.floor(contextWindow/4));
    // 思考能力来自 pi-ai 目录（白名单回落）；temperature 门控语义不变
    const capability=resolveThinkingCapability(protocol,baseUrl,modelId,advanced);
    const adjustments:FrozenModelParameters['adjustments']=[];
    if(maxOutputTokens!==requestedOutput) adjustments.push({field:'maxOutputTokens',reason:'不超过上下文窗口的1/4；保留输入与压缩预算',requested:requestedOutput,effective:maxOutputTokens});
    if(contextWindow===null) adjustments.push({field:'contextWindow',reason:'pi 目录未收录且未手填：窗口未知不造默认值，自动压缩已禁用',requested:null,effective:null});
    if(raw.thinkingMode!==undefined&&!['auto','on','off'].includes(String(raw.thinkingMode))) fail('无效thinkingMode');
    if(raw.thinkingLevel!==undefined&&!isThinkingLevel(raw.thinkingLevel)) fail(`无效thinkingLevel（须为${THINKING_LEVELS.join('/')}）`);
    if(raw.thinkingLevel!==undefined&&raw.thinkingMode!==undefined&&raw.thinkingMode!=='auto') fail('thinkingLevel不能与旧thinkingMode同时指定');
    const explicit=raw.thinkingLevel??(raw.thinkingMode==='on'?'medium':raw.thinkingMode==='off'?'off':undefined);
    let thinkingLevel:ThinkingLevel='off';
    // 厂商文档核实层：端点未载明思考控制（vendor-docs-undocumented）时显式档位不报错而是降级忽略——
    // 存量参数不至于让建单失败，按模型默认思考执行（思考本身未必可关，只是强度不可控）
    const vendorSuppressed=capability.vendorSource==='vendor-docs-undocumented'&&!capability.userConfigured;
    if(explicit!==undefined) {
        if(vendorSuppressed) {
            adjustments.push({field:'thinkingLevel',reason:'该端点官方文档未载明思考强度控制，忽略显式档位，按模型默认思考执行',requested:explicit,effective:'off'});
        } else {
            if (!capability.verified || (explicit!=='off'&&!capability.thinkingLevels.includes(explicit as ThinkingLevel)) || (explicit==='off'&&capability.thinkingLevels.length>0&&!capability.thinkingLevels.includes('off'))) fail('该模型没有已验证的思考级别支持，请使用默认或受支持模型');
            thinkingLevel=explicit as ThinkingLevel;
        }
    } else if(capability.thinkingLevels.includes('medium')) thinkingLevel='medium';
    else if(advanced?.thinkingParameterMap&&capability.thinkingLevels.length) thinkingLevel=capability.thinkingLevels.at(-1)!;
    if(raw.thinkingMode!==undefined) adjustments.push({field:'thinkingMode',reason:raw.thinkingMode==='auto'?'兼容auto：使用已验证模型默认；未知模型不发送reasoning参数':'旧模式显式映射为思考级别',requested:raw.thinkingMode,effective:thinkingLevel});
    if(!capability.verified&&!vendorSuppressed) adjustments.push({field:'thinkingLevel',reason:'模型能力未验证，不发送思考控制参数；不代表上游已关闭思考',requested:raw.thinkingLevel??raw.thinkingMode??null,effective:null});
    let temperature:number|undefined;
    if(raw.temperature!==undefined) {
        if(typeof raw.temperature!=='number'||!Number.isFinite(raw.temperature)||raw.temperature<0||raw.temperature>2) fail('temperature须为0—2数字');
        if(!capability.temperature) fail('该模型未验证temperature支持');
        if(protocol==='anthropic-messages'&&(Number(raw.temperature)>1||thinkingLevel!=='off')) fail('Anthropic温度须为0—1，启用思考时不接受temperature');
        temperature=raw.temperature as number;
    }
    // 手动映射覆盖的是实际选中档位，建单/连接测试前即确认有对应请求参数。
    if (advanced?.thinkingParameterMap) mappedThinkingPayload(advanced, thinkingLevel);
    return {requested:{...raw},effective:{contextWindow,maxOutputTokens,thinkingLevel,...(thinkingLevel!=='off'?{reasoning:thinkingLevel}:{}),...(temperature!==undefined?{temperature}:{})},capability,adjustments,policyVersion:'runtime-parameters-v1',...(advanced?{advanced}:{})};
}

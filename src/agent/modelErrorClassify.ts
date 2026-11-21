// 模型错误结构化分类：把 pi AssistantMessage 的错误映射为统一 ErrorCode，供 run_failed 帧
// → runs.stop_reason / attempts.error_code 与前端归因文案使用。
// 分类器复用 pi-ai 公开导出（isContextOverflow 覆盖 20+ 厂商溢出文案；
// isRetryableAssistantError 判定瞬态 provider/transport 错误，且把 quota/billing 归为不可重试），
// specific 码按 errorMessage 文本特征识别；原始错误文本原样透传，展示截断由调用方负责。
import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from '@earendil-works/pi-ai';

export type ModelErrorCode =
    | 'CONTEXT_LIMIT_EXCEEDED'
    | 'CREDENTIAL_REQUIRED'
    | 'MODEL_QUOTA_EXCEEDED'
    | 'MODEL_TIMEOUT'
    | 'PROVIDER_RATE_LIMIT'
    | 'PROVIDER_ERROR';

export interface ClassifiedModelError {
    code: ModelErrorCode;
    message: string;
    retryable: boolean;
}

// 文案特征按优先级排列：quota 先于 rate（OpenAI 把配额耗尽包在 429 里，pi 亦将其归为不可重试）；
// auth 先于 rate（401/403 响应体不会含 429）。数字状态码用词边界匹配，避免命中正文里的长数字。
const QUOTA_PATTERN = /quota|billing|insufficient(?:[_ ](?:funds|credit|balance))|exceeded your current limit|余额不足|欠费|配额/i;
const AUTH_PATTERN = /\b40[13]\b|invalid[_ ]api[_ ]key|incorrect api key|unauthorized|authentication(?: failed)?|api key.{0,20}(?:invalid|not valid|expired)|无可用凭据|认证失败/i;
const RATE_PATTERN = /\b429\b|rate[_ ]?limit|too many requests|overloaded/i;
const TIMEOUT_PATTERN = /\b504\b|\btimeout\b|timed out|\betimedout\b|\beconnaborted\b/i;
// 弱网/高丢包的传输层错误：结构化 code（diagnostics.error.code）精确识别，文案兜底覆盖无诊断的场景。
const NETWORK_CODE_PATTERN = /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|EAI_AGAIN|UND_ERR[A-Z0-9_]*|ERR_SSL_[A-Z0-9_]*BAD_RECORD_MAC)$/;
const NETWORK_TEXT_PATTERN = /fetch failed|socket hang up|client network socket disconnected|premature close|\beconnreset\b|\beconnrefused\b|\beconnaborted\b|\betimedout\b|\bund_err[a-z_]*/i;

// 结构化优先：pi 在 diagnostics 里保留原始抛出值（name/message/code），比 errorMessage 文案更可靠。
// 只认字符串网络错误码——数字码是HTTP状态（401/500），归状态语义判定，不进网络码分支。
function diagnosticNetworkCode(message: AssistantMessage): string | null {
    const diagnostics = Array.isArray(message.diagnostics) ? message.diagnostics : [];
    for (const diagnostic of diagnostics) {
        const code = diagnostic?.error?.code;
        if (typeof code === 'string' && NETWORK_CODE_PATTERN.test(code.trim())) return code.trim();
    }
    return null;
}

export function classifyModelError(message: AssistantMessage, contextWindow?: number): ClassifiedModelError {
    const raw = typeof message.errorMessage === 'string' ? message.errorMessage : '';
    const text = raw.slice(0, 4000);
    if (isContextOverflow(message, contextWindow)) {
        // 仅错误文案判定生效：pi 的静默溢出（stop+usage超窗）由会话内部压缩处理，不进入本分类路径
        return { code: 'CONTEXT_LIMIT_EXCEEDED', message: raw || '上下文超出模型窗口', retryable: false };
    }
    if (QUOTA_PATTERN.test(text)) return { code: 'MODEL_QUOTA_EXCEEDED', message: raw, retryable: false };
    if (AUTH_PATTERN.test(text)) return { code: 'CREDENTIAL_REQUIRED', message: raw, retryable: false };
    if (RATE_PATTERN.test(text)) return { code: 'PROVIDER_RATE_LIMIT', message: raw, retryable: true };
    if (TIMEOUT_PATTERN.test(text)) return { code: 'MODEL_TIMEOUT', message: raw, retryable: true };
    if (diagnosticNetworkCode(message) !== null || NETWORK_TEXT_PATTERN.test(text)) {
        return { code: 'PROVIDER_ERROR', message: raw, retryable: true };
    }
    if (isRetryableAssistantError(message)) return { code: 'PROVIDER_ERROR', message: raw, retryable: true };
    return { code: 'PROVIDER_ERROR', message: raw || '模型请求失败', retryable: false };
}

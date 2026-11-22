import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyModelError } from '../src/agent/modelErrorClassify.js';
import type { AssistantMessage } from '@earendil-works/pi-ai';

// 仅构造分类所需的 AssistantMessage 形状（errorMessage/usage/stopReason）；其余字段与分类无关。
const failing = (errorMessage: string): AssistantMessage => ({
    role: 'assistant', content: [], api: 'openai-completions', provider: 'prism-gateway', model: 'test-model',
    usage: { input: 0, output: 0 }, stopReason: 'error', errorMessage, timestamp: 0,
} as unknown as AssistantMessage);

test('provider overflow messages classify as CONTEXT_LIMIT_EXCEEDED and are not retryable', () => {
    const overflow = classifyModelError(failing("This model's maximum context length is 131072 tokens. However, you requested about 140000 tokens."));
    assert.equal(overflow.code, 'CONTEXT_LIMIT_EXCEEDED');
    assert.equal(overflow.retryable, false);
    const anthropic = classifyModelError(failing('Your prompt is too long: 200001 tokens > 200000 maximum'));
    assert.equal(anthropic.code, 'CONTEXT_LIMIT_EXCEEDED');
    assert.equal(anthropic.retryable, false);
});

test('classifier is error-path only: silent overflow (stopReason stop) belongs to pi internal compaction', () => {
    // pi 的 isContextOverflow 仅对 stopReason==='error' 做文案判定；静默溢出（stop+usage超窗）
    // 由 pi 会话内部压缩处理，不会进入本分类器的调用路径（runnerMain 仅对 error 消息分类）
    const silent = { ...failing('ok'), usage: { input: 9000, output: 1 }, stopReason: 'stop' } as unknown as AssistantMessage;
    assert.equal(classifyModelError(silent, 8192).code, 'PROVIDER_ERROR');
});

test('quota/billing exhaustion maps to MODEL_QUOTA_EXCEEDED even when wrapped in 429', () => {
    const quota = classifyModelError(failing('(429): {"error":{"message":"You exceeded your current quota, please check your plan and billing details."}}'));
    assert.equal(quota.code, 'MODEL_QUOTA_EXCEEDED');
    assert.equal(quota.retryable, false);
    const chinese = classifyModelError(failing('欠费停机，请充值后重试'));
    assert.equal(chinese.code, 'MODEL_QUOTA_EXCEEDED');
});

test('auth failures map to CREDENTIAL_REQUIRED', () => {
    const invalidKey = classifyModelError(failing('(401): Invalid API key provided'));
    assert.equal(invalidKey.code, 'CREDENTIAL_REQUIRED');
    const expired = classifyModelError(failing('(403): authentication failed: api key has expired'));
    assert.equal(expired.code, 'CREDENTIAL_REQUIRED');
    assert.equal(expired.retryable, false);
});

test('rate limit and timeout map to retryable specific codes', () => {
    const rate = classifyModelError(failing('(429): Too many requests, please slow down'));
    assert.equal(rate.code, 'PROVIDER_RATE_LIMIT');
    assert.equal(rate.retryable, true);
    const timeout = classifyModelError(failing('Request timed out after 30000ms'));
    assert.equal(timeout.code, 'MODEL_TIMEOUT');
    assert.equal(timeout.retryable, true);
});

test('transient provider errors via pi classifier map to retryable codes', () => {
    const gateway = classifyModelError(failing('(502): Bad Gateway'));
    assert.equal(gateway.code, 'PROVIDER_ERROR');
    assert.equal(gateway.retryable, true);
    // overloaded_error按文案特征归入限流族（同样可重试）
    const overloaded = classifyModelError(failing('(503): overloaded_error'));
    assert.equal(overloaded.code, 'PROVIDER_RATE_LIMIT');
    assert.equal(overloaded.retryable, true);
    const transport = classifyModelError(failing('fetch failed: ECONNRESET'));
    assert.equal(transport.code, 'PROVIDER_ERROR');
    assert.equal(transport.retryable, true);
});

test('deterministic unknown errors map to PROVIDER_ERROR not retryable; empty message gets fallback text', () => {
    const deterministic = classifyModelError(failing('malformed request body rejected by gateway'));
    assert.equal(deterministic.code, 'PROVIDER_ERROR');
    assert.equal(deterministic.retryable, false);
    const empty = classifyModelError(failing(''));
    assert.equal(empty.code, 'PROVIDER_ERROR');
    assert.equal(empty.message, '模型请求失败');
    assert.equal(empty.retryable, false);
});

// 结构化信号优先：pi把原始抛出值保留在diagnostics里，错误码比errorMessage文案更可靠（弱网丢包场景）
const withDiagnostic = (code: string | undefined, errorMessage: string): AssistantMessage => ({
    ...failing(errorMessage),
    diagnostics: [{ type: 'request_error', timestamp: 0, error: { name: 'Error', message: errorMessage, ...(code !== undefined ? { code } : {}) } }],
} as unknown as AssistantMessage);

test('structured network codes in diagnostics map to retryable PROVIDER_ERROR regardless of message text', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC']) {
        const result = classifyModelError(withDiagnostic(code, 'Request failed'));
        assert.equal(result.retryable, true, code);
        assert.equal(result.code, 'PROVIDER_ERROR', code);
    }
    // 非网络码不进该分支：数字HTTP状态码（401/500）不据此标可重试
    const httpStatus = classifyModelError(withDiagnostic('401', 'request rejected'));
    assert.equal(httpStatus.retryable, false);
    const plain = classifyModelError(withDiagnostic(undefined, 'malformed request body'));
    assert.equal(plain.retryable, false);
});

test('network error message patterns act as fallback when diagnostics are absent', () => {
    for (const text of ['fetch failed', 'TypeError: terminated: premature close', 'socket hang up', 'client network socket disconnected before TLS', 'send: ETIMEDOUT']) {
        const result = classifyModelError(failing(text));
        assert.equal(result.retryable, true, text);
    }
});

// 自身传输包装（streamNetwork/network）必须按瞬态识别：2026-11-22实机辩论主持阶段，
// DeepSeek流中断被包装成纯中文'模型响应中断，请重试'，pi重试/监督器白名单全部失明 → 整run失败。
test('prism transport wraps are retryable: with original code appended and bare', () => {
    // 新包装：原始错误码保留在括号内
    const withCode = classifyModelError(failing('模型响应中断，请重试（ECONNRESET）'));
    assert.equal(withCode.code, 'PROVIDER_ERROR');
    assert.equal(withCode.retryable, true);
    const connect = classifyModelError(failing('无法连接接口，请检查地址和网络（ECONNREFUSED）'));
    assert.equal(connect.retryable, true);
    // 兜底：即使原始错误无errno code（普通Error），包装文案本身按传输层瞬态处理
    const bare = classifyModelError(failing('模型响应中断，请重试（boom）'));
    assert.equal(bare.retryable, true);
    const plain = classifyModelError(failing('模型响应中断，请重试'));
    assert.equal(plain.retryable, true);
});

test('non-retryable families still win over structured network codes (quota/auth ordering preserved)', () => {
    const quota = classifyModelError(withDiagnostic('ECONNRESET', 'You exceeded your current quota, please check your plan and billing details.'));
    assert.equal(quota.code, 'MODEL_QUOTA_EXCEEDED');
    assert.equal(quota.retryable, false);
    const auth = classifyModelError(withDiagnostic('ECONNRESET', '(401): Invalid API key provided'));
    assert.equal(auth.code, 'CREDENTIAL_REQUIRED');
    assert.equal(auth.retryable, false);
});

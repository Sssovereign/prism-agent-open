import type { ClassifiedModelError } from './modelErrorClassify.js';

/**
 * 上下文预算门禁拒绝登记（P1-6错误归因）：门禁在worker自定义fetch内抛出
 * CONTEXT_LIMIT_EXCEEDED，pi/OpenAI SDK会把它包装成APIConnectionError（"Connection error."），
 * 缺省分类落入瞬态PROVIDER_ERROR/retryable=true。登记标记让模型错误分类优先归因为
 * CONTEXT_LIMIT_EXCEEDED（不可重试），文案保留门禁的可操作建议原文。
 */
let pending: ClassifiedModelError | null = null;

export function markGateRejection(message: string): void {
    pending = { code: 'CONTEXT_LIMIT_EXCEEDED', message, retryable: false };
}

/** 分类处优先消费；取走即清除（一次拒绝只归因一次，后续错误回归常规分类）。 */
export function takeGateRejection(): ClassifiedModelError | null {
    const current = pending;
    pending = null;
    return current;
}

// 统一错误呈现层（参照 zai-org/ZCode providerBusinessError / ChatErrorBanner 裁剪）：
// - describeApiError：ApiError → 文案 + 恢复动作（code→action 映射对齐上游 providerBusinessError 的
//   “错误码映射到具体恢复动作”模式）；未收录码回退服务端 message。
// - stopReasonText：runs.stop_reason 全量文案表（supervisor 写入值 + 模型错误分类器新增值 +
//   pi 消息级 stopReason 透传值）。
// - formatErrorCopyText：复制用错误摘要（文案+code+requestId/runId），对齐上游 buildErrorCopyText。
// 文案经 web/ui/i18n 按语言呈现：中文模式沿用既有契约（服务端 message 优先，保持具体性）；
// 英文模式对登记过 errors.<CODE> 的码改用字典翻译，未登记仍回落服务端 message。
// node:test 直接可测（vue 响应式在 node 可用）；呈现决策与字典覆盖度由 tests/i18n.test.ts 把关。
import { ApiError } from '../api.js';
import { t, hasTranslation, currentLocale } from './i18n/index.js';

export type ErrorActionKind = 'login' | 'open-model-settings' | 'open-search-settings';

export interface ErrorAction {
  kind: ErrorActionKind;
  label: string;
}

export interface ErrorPresentation {
  message: string;
  retryable: boolean;
  code?: string;
  requestId?: string;
  detail?: string;
  action?: ErrorAction;
}

/** code → 恢复动作/可重试提示。message 不在此覆盖（呈现规则见 describeApiError），仅登记动作与重试性。
 * 导出供覆盖度测试：服务端新增错误码时必须在此显式登记呈现决策。 */
export const ERROR_CODE_PRESETS: Record<string, { action?: ErrorActionKind; retryableHint?: boolean }> = {
  // 400
  VALIDATION_FAILED: {},
  IDEMPOTENCY_CONFLICT: {},
  REQUEST_IN_PROGRESS: { retryableHint: true },
  PROTOCOL_INVALID: {},
  // 401/403
  AUTH_REQUIRED: { action: 'login' },
  SESSION_EXPIRED: { action: 'login' },
  CSRF_DENIED: {},
  POLICY_DENIED: {},
  TICKET_INVALID: {},
  RESERVATION_INVALID: {},
  // 404
  NOT_FOUND: {},
  ARTIFACT_MISSING: {},
  // 更新屏障与切换流程：UPDATE_PENDING 提示重试，屏障打开属于流程冲突，快照失败可重试
  UPDATE_PENDING: { retryableHint: true },
  UPDATE_BARRIER_OPEN: {},
  UPDATE_SNAPSHOT_FAILED: { retryableHint: true },
  // 409
  CONFIG_CHANGED: {},
  INPUT_CHANGED: {},
  WRITE_CONFLICT: {},
  CURRENT_CONTENT_CHANGED: {},
  RECONCILIATION_REQUIRED: {},
  CONVERSATION_BUSY: {},
  PROJECT_ARCHIVED: {},
  MIGRATION_CHECKSUM_MISMATCH: {},
  REQUEST_ALREADY_STARTED: {},
  RUN_NOT_ACTIVE: {},
  RUN_NOT_RESUMABLE: {},
  WAIT_STATE_CHANGED: {},
  RUN_STILL_ACTIVE: {},
  WORKER_NOT_CLEANED: {},
  ATTEMPT_NOT_ACTIVE: {},
  WORKING_COPY_CONFLICT: {},
  ARTIFACT_HASH_MISMATCH: {},
  DELIVERY_INVALID_STATE: {},
  // 413
  INPUT_TOO_LARGE: {},
  // 422
  CREDENTIAL_REQUIRED: { action: 'open-model-settings' },
  MODEL_UNAVAILABLE: { action: 'open-model-settings' },
  DELIVERY_INVALID: {},
  SANDBOX_UNAVAILABLE: { retryableHint: true },
  MODE_NOT_AVAILABLE: {},
  CONTEXT_LIMIT_EXCEEDED: {},
  SEARCH_NOT_CONFIGURED: { action: 'open-search-settings' },
  BROWSER_UNAVAILABLE: { retryableHint: false },
  BROWSER_TIMEOUT: { retryableHint: true },
  BROWSER_FAILED: { retryableHint: true },
  // 429
  RESOURCE_BUSY: { retryableHint: true },
  PROVIDER_RATE_LIMIT: { retryableHint: true },
  MODEL_QUOTA_EXCEEDED: { action: 'open-model-settings' },
  // 5xx
  PROVIDER_ERROR: { retryableHint: true },
  TOOL_TIMEOUT: { retryableHint: true },
  MODEL_TIMEOUT: { retryableHint: true },
  INTERNAL_ERROR: { retryableHint: true },
};

/** 恢复动作标签（i18n 字典，渲染期调用即响应语言切换）。 */
export function actionLabel(kind: ErrorActionKind): string {
  return t(`error.action.${kind}`);
}

/** message 呈现规则：中文模式服务端 message 优先（既有契约）；英文模式对登记过 errors.<CODE> 的码
 * 用字典翻译，未登记仍回落服务端 message（宁可中文也不空白）。 */
function presentMessage(error: ApiError, fallbackMessage: string): string {
  if (currentLocale() === 'en') {
    const key = `errors.${error.code}`;
    if (hasTranslation(key)) return t(key);
  }
  return error.message || fallbackMessage;
}

export function describeApiError(error: unknown, fallbackMessage = t('error.fallback')): ErrorPresentation {
  if (error instanceof ApiError) {
    const preset = ERROR_CODE_PRESETS[error.code];
    return {
      message: presentMessage(error, fallbackMessage),
      retryable: error.retryable ?? preset?.retryableHint === true,
      code: error.code,
      requestId: error.requestId,
      detail: error.details && Object.keys(error.details).length ? JSON.stringify(error.details, null, 2) : undefined,
      action: preset?.action ? { kind: preset.action, label: actionLabel(preset.action) } : undefined,
    };
  }
  if (error instanceof Error) return { message: error.message || fallbackMessage, retryable: false };
  if (typeof error === 'string' && error.trim()) return { message: error, retryable: false };
  return { message: fallbackMessage, retryable: false };
}

/** 未收录值原样返回（服务端 TEXT 自由列，新值不致显示为空）。 */
export function stopReasonText(reason: string | null | undefined): string {
  if (!reason) return '';
  const key = `stopReason.${reason}`;
  return hasTranslation(key) ? t(key) : reason;
}

export function formatErrorCopyText(parts: { message: string; code?: string; requestId?: string; runId?: string }): string {
  const lines = [t('error.copy.message', { message: parts.message })];
  if (parts.code) lines.push(t('error.copy.code', { code: parts.code }));
  if (parts.requestId) lines.push(t('error.copy.requestId', { id: parts.requestId }));
  if (parts.runId) lines.push(t('error.copy.runId', { id: parts.runId }));
  return lines.join('\n');
}

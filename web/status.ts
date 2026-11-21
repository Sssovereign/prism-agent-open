// 状态文案与语义类别：文字+颜色双通道，不单靠颜色表达状态。
// 文案走 i18n 字典（status.<key>），未收录状态原样返回（服务端自由列）。
import { t, hasTranslation } from './ui/i18n/index.js';

export type StatusKind = 'active' | 'done' | 'fail' | 'idle';

export function statusLabel(status: string): string {
  const key = `status.${status}`;
  return hasTranslation(key) ? t(key) : status;
}

export function statusKind(status: string): StatusKind {
  if (status === 'running' || status === 'queued' || status === 'waiting_approval') return 'active';
  if (status === 'succeeded') return 'done';
  if (status === 'failed' || status === 'needs_reconciliation') return 'fail';
  return 'idle';
}

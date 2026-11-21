/**
 * 轻量 toast 提示（Vue 移植）。
 * 行为与 zai-org/ZCode a9fe401 packages/ui/src/components/ui/toast.tsx 逐项对齐：
 * 4 位置、6 变体、dedupeKey 去重（新结果替换旧结果并移到栈底）、进度更新、
 * 默认 3000ms 自动消失、200ms 过渡后移除、可带 action 与手动关闭。
 * 调用方式：`import { toast } from "@/ui/toast"; toast("message");`
 */
import { reactive } from 'vue';

export type ToastPosition = 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center';
export type ToastVariant = 'default' | 'update' | 'source-server-update' | 'info' | 'warning' | 'success';

/** 长耗时操作的进度：value 取 0..1，label 为进度条下方的数量说明。只在 notice 样式中渲染。 */
export interface ToastProgress {
  value: number;
  label: string;
  tone?: 'destructive';
}

export interface ToastOptions {
  durationMs?: number;
  position?: ToastPosition;
  variant?: ToastVariant;
  actionLabel?: string;
  onAction?: () => void;
  dismissible?: boolean;
  dismissLabel?: string;
  /** 同一业务目标与动作的稳定键；新结果替换旧结果并移到栈底。 */
  dedupeKey?: string;
  /** 顶部居中可锚定到某元素下方（设置页分区提示等）。 */
  anchorId?: string;
  progress?: ToastProgress;
}

export interface ToastItem {
  id: number;
  message: string;
  durationMs: number;
  position: ToastPosition;
  variant?: ToastVariant;
  actionLabel?: string;
  onAction?: () => void;
  dismissible?: boolean;
  dismissLabel?: string;
  anchorId?: string;
  dedupeKey?: string;
  progress?: ToastProgress;
}

export type ToastUpdate = Partial<Omit<ToastItem, 'id'>>;

export const DEFAULT_TOAST_DURATION_MS = 3000;
export const TOAST_TRANSITION_DURATION_MS = 200;

export const toastState = reactive<{ items: ToastItem[] }>({ items: [] });

function upsertToastItem(items: readonly ToastItem[], item: ToastItem): ToastItem[] {
  if (!item.dedupeKey) return [...items, item];
  return [...items.filter((current) => current.dedupeKey !== item.dedupeKey), item];
}

let nextId = 0;

export function toast(message: string, options?: ToastOptions): number {
  const id = nextId++;
  const item: ToastItem = {
    id,
    message,
    durationMs: options?.durationMs ?? DEFAULT_TOAST_DURATION_MS,
    position: options?.position ?? 'top-center',
    variant: options?.variant ?? 'default',
    actionLabel: options?.actionLabel,
    onAction: options?.onAction,
    dismissible: options?.dismissible,
    dismissLabel: options?.dismissLabel,
    anchorId: options?.anchorId,
    dedupeKey: options?.dedupeKey,
    progress: options?.progress,
  };
  toastState.items = upsertToastItem(toastState.items, item);
  return id;
}

/** 更新已有 Toast，把同一长耗时操作的阶段变化收敛到一个提示中。 */
export function updateToast(id: number, patch: ToastUpdate): void {
  toastState.items = toastState.items.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

export function dismissToast(id: number): void {
  toastState.items = toastState.items.filter((item) => item.id !== id);
}

/** 便捷变体（与上游调用点习惯一致：info/warning/success + notice 样式）。 */
export function toastInfo(message: string, options?: Omit<ToastOptions, 'variant'>): number {
  return toast(message, { ...options, variant: 'info' });
}
export function toastWarning(message: string, options?: Omit<ToastOptions, 'variant'>): number {
  return toast(message, { ...options, variant: 'warning' });
}
export function toastSuccess(message: string, options?: Omit<ToastOptions, 'variant'>): number {
  return toast(message, { ...options, variant: 'success' });
}
export function toastError(message: string, options?: Omit<ToastOptions, 'variant'>): number {
  return toast(message, { ...options, variant: 'warning', durationMs: options?.durationMs ?? 6000 });
}

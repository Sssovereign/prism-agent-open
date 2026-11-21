<script setup lang="ts">
/** 单条 toast：进入动画、自动消失计时、200ms 过渡后移除。
 *  对齐 ZCode a9fe401 toast.tsx 的 ToastMessage。 */
import { onMounted, ref, watch } from 'vue';
import type { ToastItem } from '../../ui/toast';
import { TOAST_TRANSITION_DURATION_MS } from '../../ui/toast';

const props = defineProps<{ item: ToastItem; isBottom?: boolean }>();
const emit = defineEmits<{ done: [id: number] }>();

const visible = ref(false);
let removeTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleTimeout(durationMs: number) {
  if (removeTimer !== undefined) clearTimeout(removeTimer);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  removeTimer = setTimeout(() => {
    visible.value = false;
    removeTimer = setTimeout(() => emit('done', props.item.id), TOAST_TRANSITION_DURATION_MS);
  }, durationMs);
}

onMounted(() => {
  requestAnimationFrame(() => { visible.value = true; });
  scheduleTimeout(props.item.durationMs);
});

// 持续中的 Toast 用 duration=0；切到终态时更新 duration，重新启动自动消失计时。
watch(() => props.item.durationMs, (value) => scheduleTimeout(value));

function dismissWithTransition() {
  if (removeTimer !== undefined) clearTimeout(removeTimer);
  visible.value = false;
  removeTimer = setTimeout(() => emit('done', props.item.id), TOAST_TRANSITION_DURATION_MS);
}

function handleAction() {
  props.item.onAction?.();
  dismissWithTransition();
}

const title = props.item.message.split('\n')[0] ?? '';
const body = props.item.message.split('\n').slice(1).join('\n').trim();
const isNotice = props.item.variant === 'info' || props.item.variant === 'warning' || props.item.variant === 'success';
const isUpdate = props.item.variant === 'update';
const isSourceServerUpdate = props.item.variant === 'source-server-update';
const isTopRight = props.item.position === 'top-right';
</script>

<template>
  <div class="toast-msg" :class="[`variant-${item.variant ?? 'default'}`, {
    'pos-top-right': isTopRight,
    'pos-bottom': !!isBottom,
    visible,
  }]">
    <template v-if="isSourceServerUpdate">
      <div class="ssu-row">
        <span class="dot dot-solid" aria-hidden="true"></span>
        <div class="ssu-copy">
          <div class="ssu-title">{{ title }}</div>
          <div v-if="body" class="ssu-body">{{ body }}</div>
        </div>
        <button v-if="item.actionLabel" type="button" class="ssu-action" @click="handleAction">{{ item.actionLabel }}</button>
        <button v-if="item.dismissible" type="button" class="dismiss dismiss-lg" :aria-label="item.dismissLabel ?? 'Close'" @click="dismissWithTransition">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
        </button>
      </div>
    </template>
    <template v-else-if="isUpdate">
      <div class="update-row">
        <span class="dot" aria-hidden="true"></span>
        <div class="update-copy">
          <div class="update-title">{{ title }}</div>
          <div v-if="body" class="update-body">{{ body }}</div>
        </div>
        <button v-if="item.actionLabel" type="button" class="update-action" @click="handleAction">{{ item.actionLabel }}</button>
      </div>
    </template>
    <template v-else-if="isNotice">
      <div class="notice-row">
        <svg v-if="item.progress" class="notice-icon spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
        <svg v-else-if="item.variant === 'warning'" class="notice-icon notice-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
        <svg v-else-if="item.variant === 'success'" class="notice-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.801 10A10 10 0 1 1 17 3.335" /><path d="m9 11 3 3L22 4" /></svg>
        <svg v-else class="notice-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
        <div v-if="item.progress" class="notice-progress" data-testid="toast-progress">
          <span class="notice-title">{{ title }}</span>
          <div class="progress-track" role="progressbar" :aria-valuenow="Math.round(Math.min(Math.max(item.progress.value, 0), 1) * 100)" aria-valuemin="0" aria-valuemax="100">
            <div class="progress-fill" :class="{ destructive: item.progress.tone === 'destructive' }" :style="{ width: `${Math.round(Math.min(Math.max(item.progress.value, 0), 1) * 100)}%` }"></div>
          </div>
          <span class="notice-label">{{ item.progress.label }}</span>
        </div>
        <div v-else class="notice-copy">
          <div class="notice-main">
            <div class="notice-title">{{ title }}</div>
            <div v-if="body" class="notice-body">{{ body }}</div>
          </div>
          <button v-if="item.actionLabel" type="button" class="notice-action" @click="handleAction">{{ item.actionLabel }}</button>
        </div>
        <button v-if="item.dismissible" type="button" class="dismiss" :aria-label="item.dismissLabel ?? 'Close'" @click="dismissWithTransition">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
        </button>
      </div>
    </template>
    <template v-else>{{ item.message }}</template>
  </div>
</template>

<style scoped>
.toast-msg {
  border-radius: 16px;
  border: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-toast) 60%, transparent);
  color: var(--color-foreground);
  font-size: var(--text-ui-base);
  box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  transition: transform 200ms cubic-bezier(0.77, 0, 0.175, 1), opacity 200ms cubic-bezier(0.77, 0, 0.175, 1);
  transform: translateY(-4px) scale(0.98);
  opacity: 0;
}
.toast-msg.pos-top-right { transform: translateX(calc(100% + 1rem)); }
.toast-msg.pos-bottom { transform: translateY(4px) scale(0.98); }
.toast-msg.visible { transform: translate(0, 0) scale(1); opacity: 1; }
@media (prefers-reduced-motion: reduce) {
  .toast-msg { transform: none; transition: opacity 200ms cubic-bezier(0.77, 0, 0.175, 1); }
  .toast-msg.pos-top-right, .toast-msg.pos-bottom { transform: none; }
}

.variant-default { padding: 12px 16px; white-space: pre-line; }
.variant-update, .variant-source-server-update { width: min(300px, calc(100vw - 1rem)); max-width: min(300px, calc(100vw - 1rem)); border-color: var(--color-popover-border); transform-origin: bottom left; }
.variant-source-server-update { width: min(480px, calc(100vw - 2rem)); color: var(--color-foreground); }
.variant-info, .variant-warning, .variant-success { width: min(536px, calc(100vw - 2rem)); color: var(--color-foreground); }

.dot { width: 8px; height: 8px; flex-shrink: 0; border-radius: 50%; background: color-mix(in srgb, var(--color-primary) 80%, transparent); box-shadow: 0 0 0 4px var(--color-accent); }
.dot-solid { background: var(--color-primary); margin-top: 6px; }

.ssu-row { display: flex; min-width: 0; align-items: flex-start; gap: 12px; padding: 12px 16px; }
.ssu-copy { min-width: 0; flex: 1; }
.ssu-title { overflow-wrap: break-word; font-size: var(--text-ui-base); font-weight: 500; line-height: 20px; color: var(--color-foreground); }
.ssu-body { margin-top: 4px; white-space: pre-line; overflow-wrap: break-word; font-size: var(--text-ui-sm); line-height: 20px; color: var(--color-foreground-subtle); }
.ssu-action { height: 32px; flex-shrink: 0; white-space: nowrap; border: 0; border-radius: 6px; background: var(--color-primary); color: var(--color-primary-foreground); padding: 0 12px; font-size: var(--text-ui-base); font-weight: 500; transition: background-color 150ms; }
.ssu-action:hover { background: color-mix(in srgb, var(--color-primary) 90%, transparent); }

.update-row { display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 8px 10px; }
.update-copy { min-width: 0; flex: 1; }
.update-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-ui-base); font-weight: 500; color: var(--color-foreground); }
.update-body { margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-ui-base); line-height: 16px; color: var(--color-foreground-subtle); }
.update-action { height: 28px; max-width: 56px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 0; border-radius: 6px; background: var(--color-secondary); color: var(--color-foreground); padding: 0 8px; font-size: var(--text-ui-base); font-weight: 500; transition: background-color 150ms; }
.update-action:hover { background: var(--color-hover); }

.notice-row { display: flex; min-width: 0; align-items: center; gap: 16px; padding: 0 16px; }
.notice-icon { width: 16px; height: 16px; flex-shrink: 0; color: var(--color-foreground-subtle); }
.notice-icon.notice-warning { color: var(--color-warning); }
.spin { animation: toast-spin 1s linear infinite; }
@keyframes toast-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
.notice-progress { display: flex; min-width: 0; flex: 1 0 0; flex-direction: column; gap: 6px; padding: 12px 0; font-size: 14px; }
.notice-copy { display: flex; min-width: 0; flex: 1 0 0; align-items: flex-start; gap: 16px; padding: 12px 0; font-size: 14px; }
.notice-main { min-width: 0; flex: 1; line-height: 20px; }
.notice-title { color: var(--color-foreground); }
.notice-body { margin-top: 2px; white-space: pre-line; color: var(--color-foreground-subtle); }
.notice-label { font-size: var(--text-ui-sm); font-variant-numeric: tabular-nums; color: var(--color-foreground-subtle); }
.notice-action { max-width: 50%; align-self: center; flex-shrink: 0; white-space: normal; overflow-wrap: break-word; text-align: left; border: 0; background: transparent; color: var(--color-foreground); padding: 0; font-weight: 500; line-height: 1.375; text-decoration: underline; text-underline-offset: 2px; }
.notice-action:hover { color: var(--color-foreground-subtle); }

.progress-track { position: relative; display: flex; height: 4px; width: 100%; align-items: center; overflow-x: hidden; border-radius: 6px; background: var(--color-surface-hover); }
.progress-fill { height: 100%; border-radius: 999px; background: var(--color-foreground-subtle); transition: width 150ms; }
.progress-fill.destructive { background: var(--color-destructive); }

.dismiss { display: flex; width: 24px; height: 24px; flex-shrink: 0; align-items: center; justify-content: center; border: 0; border-radius: 6px; background: transparent; color: var(--color-foreground-subtle); padding: 0; }
.dismiss:hover { background: var(--color-hover); color: var(--color-foreground); }
.dismiss svg { width: 14px; height: 14px; }
.dismiss-lg { width: 28px; height: 28px; }
</style>

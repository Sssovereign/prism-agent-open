<script setup lang="ts">
// 统一错误横幅（参照 zai-org/ZCode ChatErrorBanner 裁剪）：destructive 着色 + 详情展开 +
// 复制错误（文案/错误码/requestId/runId）+ 定向恢复动作。上游错误一律走横幅而非 toast
// （ZCode toast 同样没有 error 变体）；详情保留原始错误文本用于排查，仅主文案做归因翻译。
import { ref, computed, onBeforeUnmount } from 'vue';
import { formatErrorCopyText } from '../ui/errorPresentation';
import { toast } from '../ui/toast';
const props = withDefaults(defineProps<{
  message: string;
  /** 原始错误文本（如 provider 返回体）；提供时展示“展开详情”与“复制错误” */
  detail?: string;
  code?: string;
  requestId?: string;
  runId?: string;
  /** danger=失败终态（destructive着色）；warning=已停止/待核对（沿用警告着色） */
  tone?: 'danger' | 'warning';
  /** 定向恢复动作按钮文案（如“打开模型设置”）；点击冒泡 action 事件由宿主分发 */
  actionLabel?: string;
  dismissible?: boolean;
}>(), { tone: 'danger' });
const emit = defineEmits<{ (e: 'action'): void; (e: 'dismiss'): void }>();
const detailsOpen = ref(false);
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
const copyText = computed(() => formatErrorCopyText({ message: props.detail || props.message, code: props.code, requestId: props.requestId, runId: props.runId }));
async function copyError(): Promise<void> {
  try {
    await navigator.clipboard.writeText(copyText.value);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied.value = false; }, 1800);
  } catch {
    toast('复制失败，请展开详情手动选择文本复制', { variant: 'warning' });
  }
}
onBeforeUnmount(() => clearTimeout(copiedTimer));
</script>
<template>
  <div class="error-banner" :data-tone="tone" role="alert">
    <svg class="banner-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
    <div class="banner-body">
      <p class="banner-message">{{ message }}</p>
      <div v-if="detail" class="banner-details">
        <button type="button" class="banner-link" :aria-expanded="detailsOpen" @click="detailsOpen = !detailsOpen">{{ detailsOpen ? '收起详情' : '展开详情' }}</button>
        <pre v-show="detailsOpen" class="banner-detail-text" tabindex="0">{{ detail }}</pre>
      </div>
    </div>
    <div class="banner-actions">
      <button v-if="actionLabel" type="button" class="banner-action" @click="emit('action')">{{ actionLabel }}</button>
      <button v-if="detail || code || requestId || runId" type="button" class="banner-link" @click="copyError">{{ copied ? '已复制' : '复制错误' }}</button>
      <button v-if="dismissible" type="button" class="banner-link" aria-label="关闭错误提示" @click="emit('dismiss')">关闭</button>
    </div>
  </div>
</template>
<style scoped>
.error-banner{display:flex;align-items:flex-start;gap:10px;margin:8px 0;padding:10px 12px;border:1px solid color-mix(in srgb,var(--danger) 30%,transparent);border-radius:10px;background:color-mix(in srgb,var(--danger) 10%,var(--bg-card));color:var(--danger);font-size:var(--text-ui-sm);line-height:1.5}
.error-banner[data-tone=warning]{border-color:color-mix(in srgb,var(--warning) 30%,transparent);background:color-mix(in srgb,var(--warning) 10%,var(--bg-card));color:var(--warning)}
.banner-icon{width:16px;height:16px;flex:none;margin-top:2px}
.banner-body{flex:1;min-width:0}
.banner-message{margin:0;font-weight:500;overflow-wrap:anywhere}
.banner-details{margin-top:2px}
.banner-detail-text{max-height:200px;overflow:auto;margin:6px 0 0;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--fg-subtle);font:var(--text-ui-caption)/1.6 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
.banner-actions{display:flex;flex:none;flex-wrap:wrap;align-items:center;gap:6px}
.banner-action{padding:3px 10px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:var(--text-ui-caption);cursor:pointer}
.banner-action:hover{background:var(--hover)}
.banner-link{padding:3px 4px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:var(--text-ui-caption);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.banner-link:hover{background:var(--hover)}
button:focus-visible{outline:2px solid currentColor;outline-offset:2px}
@media(max-width:640px){.error-banner{flex-wrap:wrap}.banner-actions{margin-left:26px;flex-basis:calc(100% - 26px)}}
@media(prefers-reduced-motion:reduce){.error-banner{transition:none}}
</style>

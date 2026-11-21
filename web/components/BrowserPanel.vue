<script setup lang="ts">
// 内嵌浏览器面板（R2）：同一 guest 承载的可见形态——渲染端上报本面板在视口中的矩形，
// 桌面宿主把无边框 guest 窗口贴进来（showInactive 不抢焦点）。切走 tab / 关闭抽屉 /
// 打开覆盖对话框时收回后台，页面与会话状态不中断。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { v1 } from '../api';

const props = defineProps<{ active: boolean; suppressed?: boolean }>();

const available = ref<boolean | null>(null);   // null=查询中，false=纯 Web 或宿主未就绪
const page = ref<{ url?: string; title?: string }>({});
const host = ref<HTMLElement | null>(null);
let observer: ResizeObserver | null = null;
let pollTimer: number | null = null;
let syncTimer: number | null = null;
let visible = false;

async function sendPanel(visibleNow: boolean): Promise<void> {
  if (available.value !== true || !host.value) return;
  const rect = host.value.getBoundingClientRect();
  try {
    const panel = await v1<{ visible: boolean; url?: string; title?: string }>('/api/v1/browser/panel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visible: visibleNow, ...(visibleNow ? { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } : {}) }),
    });
    visible = panel.visible;
    if (panel.visible) page.value = { url: panel.url, title: panel.title };
  } catch { /* 面板同步失败由下一轮轮询纠正 */ }
}

// ResizeObserver 高频回调：尾随去抖后重新贴矩形
function scheduleSync() {
  if (syncTimer !== null) window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => { syncTimer = null; if (props.active && !props.suppressed) void sendPanel(true); }, 150);
}

async function refreshState() {
  if (available.value === false) return;
  try {
    const info = await v1<{ available: boolean; panel: { visible: boolean; url?: string; title?: string } | null }>('/api/v1/browser');
    available.value = info.available;
    if (info.panel) page.value = { url: info.panel.url, title: info.panel.title };
  } catch { available.value = false; }
}

watch(() => props.active, active => {
  if (active) void sendPanel(true);
  else if (visible) void sendPanel(false);
});
watch(() => props.suppressed, suppressed => {
  if (suppressed) { if (visible) void sendPanel(false); }
  else if (props.active) void sendPanel(true);
});

onMounted(async () => {
  await refreshState();
  observer = new ResizeObserver(() => { if (props.active && !props.suppressed) scheduleSync(); });
  if (host.value) observer.observe(host.value);
  pollTimer = window.setInterval(() => void refreshState(), 2500);
  if (props.active && !props.suppressed) void sendPanel(true);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  if (pollTimer !== null) window.clearInterval(pollTimer);
  if (syncTimer !== null) window.clearTimeout(syncTimer);
  if (visible) void sendPanel(false);
});
</script>

<template>
  <div class="browser-panel">
    <div class="browser-meta">
      <span class="browser-dot" :class="{ on: !!page.url }" aria-hidden="true"></span>
      <span class="browser-title">{{ page.title || (available === false ? '内嵌浏览器不可用' : '等待页面…') }}</span>
      <span class="browser-url" :title="page.url">{{ page.url }}</span>
    </div>
    <div ref="host" class="browser-host">
      <p v-if="available === false" class="browser-empty">内嵌浏览器仅桌面版可用。网页取证与无 Key 搜索由任务中的 agent 以 browser_* 工具驱动；面板是同一承载的可见形态。</p>
    </div>
  </div>
</template>

<style scoped>
.browser-panel{display:flex;flex-direction:column;height:100%;min-height:0}
.browser-meta{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border-subtle);font-size:var(--text-ui-small);color:var(--fg-subtle);min-width:0}
.browser-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--border-strong)}
.browser-dot.on{background:var(--accent)}
.browser-title{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg)}
.browser-url{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.browser-host{position:relative;flex:1;min-height:200px;background:var(--bg-canvas)}
.browser-empty{margin:24px 16px;font-size:var(--text-ui-base);color:var(--fg-subtle);line-height:1.6}
</style>

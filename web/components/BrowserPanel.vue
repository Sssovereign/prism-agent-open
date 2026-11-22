<script setup lang="ts">
// 内嵌浏览器面板（R2）：同一 guest 承载的可见形态——渲染端上报本面板在视口中的矩形，
// 桌面宿主把无边框 guest 窗口贴进来（showInactive 不抢焦点）。切走 tab / 关闭抽屉 /
// 打开覆盖对话框时收回后台，页面与会话状态不中断。
// R3 工具栏：返回 + 地址栏 + 刷新。用户导航走 /browser/command（navigate/back 白名单，
// 与模型 browser_* 工具共用同一 guest 与同一套 URL 校验纪律）；模型驱动时序仍由任务事件流公告。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { v1 } from '../api';

const props = defineProps<{ active: boolean; suppressed?: boolean }>();

const available = ref<boolean | null>(null);   // null=查询中，false=纯 Web 或宿主未就绪
const page = ref<{ url?: string; title?: string }>({});
const host = ref<HTMLElement | null>(null);
const urlDraft = ref('');
const navigating = ref(false);
const navError = ref('');
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

// —— 工具栏（R3） ——

// 页面 URL 变化（模型导航/轮询回填）时同步地址栏草稿；用户正在编辑时不覆盖
watch(() => page.value.url, url => { if (document.activeElement !== urlInput.value) urlDraft.value = url ?? ''; });
const urlInput = ref<HTMLInputElement | null>(null);

/** 无协议输入补全 https://；其余原样（服务端 assertNavigableUrl 统一校验）。 */
function normalizeInputUrl(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

async function runCommand(method: 'navigate' | 'back', args: Record<string, unknown> = {}): Promise<void> {
  if (available.value !== true || navigating.value) return;
  navigating.value = true; navError.value = '';
  try {
    const panel = await v1<{ url?: string; title?: string }>('/api/v1/browser/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, args }),
    });
    page.value = { url: panel.url, title: panel.title };
    urlDraft.value = panel.url ?? '';
  } catch (error) {
    navError.value = error instanceof Error ? error.message : '浏览器命令执行失败';
  } finally { navigating.value = false; }
}

function submitNavigate() {
  const raw = urlDraft.value.trim();
  if (!raw) return;
  if (raw === page.value.url) { void runCommand('navigate', { url: raw }); return; }
  void runCommand('navigate', { url: normalizeInputUrl(raw) });
}
function reload() { const url = page.value.url; if (url) void runCommand('navigate', { url }); }
function goBack() { void runCommand('back'); }

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
  urlDraft.value = page.value.url ?? '';
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
    <div class="browser-toolbar">
      <button type="button" class="browser-btn" title="返回上一页" :disabled="available !== true || navigating" @click="goBack">←</button>
      <input
        ref="urlInput"
        v-model="urlDraft"
        class="browser-address"
        :disabled="available !== true"
        :placeholder="available === false ? '内嵌浏览器不可用' : '输入网址，回车打开'"
        spellcheck="false"
        enterkeyhint="go"
        @keydown.enter.prevent="submitNavigate"
      />
      <button type="button" class="browser-btn" title="重新加载当前页" :disabled="available !== true || navigating || !page.url" @click="reload">⟳</button>
    </div>
    <div class="browser-meta">
      <span class="browser-dot" :class="{ on: !!page.url }" aria-hidden="true"></span>
      <span class="browser-title">{{ navigating ? '正在打开页面…' : (page.title || (available === false ? '内嵌浏览器不可用' : '等待页面…')) }}</span>
      <span class="browser-url" :title="page.url">{{ page.url }}</span>
    </div>
    <p v-if="navError" class="browser-nav-error">{{ navError }}</p>
    <div ref="host" class="browser-host">
      <p v-if="available === false" class="browser-empty">内嵌浏览器仅桌面版可用。网页取证与无 Key 搜索由任务中的 agent 以 browser_* 工具驱动；面板是同一承载的可见形态。</p>
    </div>
  </div>
</template>

<style scoped>
.browser-panel{display:flex;flex-direction:column;height:100%;min-height:0}
.browser-toolbar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--border-subtle)}
.browser-btn{flex:none;width:26px;height:26px;border:1px solid var(--border-subtle);border-radius:6px;background:transparent;color:var(--fg-subtle);font-size:14px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.browser-btn:hover:not(:disabled){border-color:var(--border-strong);color:var(--fg)}
.browser-btn:disabled{opacity:.45;cursor:default}
.browser-address{flex:1;min-width:0;height:26px;padding:0 8px;border:1px solid var(--border-subtle);border-radius:6px;background:var(--bg-canvas);color:var(--fg);font-size:var(--text-ui-small)}
.browser-address:focus{outline:none;border-color:var(--accent)}
.browser-address:disabled{opacity:.55}
.browser-meta{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border-subtle);font-size:var(--text-ui-small);color:var(--fg-subtle);min-width:0}
.browser-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--border-strong)}
.browser-dot.on{background:var(--accent)}
.browser-title{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg)}
.browser-url{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.browser-nav-error{margin:0;padding:6px 10px;border-bottom:1px solid var(--border-subtle);font-size:var(--text-ui-small);color:var(--danger)}
.browser-host{position:relative;flex:1;min-height:200px;background:var(--bg-canvas)}
.browser-empty{margin:24px 16px;font-size:var(--text-ui-base);color:var(--fg-subtle);line-height:1.6}
</style>

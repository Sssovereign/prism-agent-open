<script lang="ts">
// Mermaid shares global renderer configuration across component instances.
let renderQueue: Promise<unknown> = Promise.resolve();
let idSeq = 0;
</script>
<script setup lang="ts">
/** Mermaid 图表块（块E1）：按 ZCode mermaid-block.tsx 语义复刻（React→Vue）。
 *  主题感知（dark class＋系统偏好）、渲染串行队列、解析失败回退纯文本、
 *  双击打开大图预览。mermaid 动态分包加载。 */
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { resolveMermaidAutoRenderDecision, getCurrentMermaidDocumentVisibility } from '../conversation/mermaidSupport';
const props = defineProps<{ code: string; onOpenPreview?: () => void }>();
type RenderState = { status: 'loading' } | { status: 'ready'; svg: string } | { status: 'plaintext' };
const state = ref<RenderState>({ status: 'loading' });
const emit = defineEmits<{ (e: 'previewSvg', svg: string | null): void }>();
const trimmedCode = computed(() => props.code.trim());
// khroma 不支持 oklab/color-mix 结果：先经浏览器解析主题 token，再 canvas 采样成 rgb/rgba。
const MERMAID_COLOR_CANVAS_SENTINEL = '#010203';
let resolverEl: HTMLSpanElement | null = null;
let normalizeCtx: CanvasRenderingContext2D | null = null;
function setupColorProbe(): void {
  if (resolverEl || typeof document === 'undefined') return;
  resolverEl = document.createElement('span');
  const canvas = document.createElement('canvas');
  canvas.width = 1; canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx) ctx.globalCompositeOperation = 'copy';
  normalizeCtx = ctx;
}
function normalizeCssColorForMermaid(raw: string, fallback: string): string {
  setupColorProbe();
  if (!raw || !resolverEl || !normalizeCtx || !document.body) return raw || fallback;
  try {
    document.body.appendChild(resolverEl);
    resolverEl.style.color = '';
    resolverEl.style.color = raw;
    const resolved = getComputedStyle(resolverEl).color;
    if (!resolved) return fallback;
    normalizeCtx.clearRect(0, 0, 1, 1);
    normalizeCtx.fillStyle = MERMAID_COLOR_CANVAS_SENTINEL;
    const sentinel = normalizeCtx.fillStyle;
    normalizeCtx.fillStyle = resolved;
    if (normalizeCtx.fillStyle === sentinel) return fallback;
    normalizeCtx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 255] = normalizeCtx.getImageData(0, 0, 1, 1).data;
    const alpha = +(a / 255).toFixed(3);
    return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
  } catch { return fallback; } finally { resolverEl.remove(); }
}
function resolveCssColor(variableName: string, fallback: string): string {
  if (typeof document === 'undefined' || !document.body) return fallback;
  const probe = document.createElement('span');
  probe.style.color = `var(${variableName})`;
  probe.style.pointerEvents = 'none';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return normalizeCssColorForMermaid(color, fallback);
}
const darkRevision = ref(0);
function resolveDark(): boolean {
  if (typeof document !== 'undefined') {
    const theme = document.documentElement.dataset.theme;
    if (theme === 'dark' || theme === 'light') return theme === 'dark';
    if (document.documentElement.classList.contains('dark')) return true;
  }
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}
function buildConfig(): Record<string, unknown> {
  const dark = resolveDark();
  const background = resolveCssColor('--color-card', dark ? '#18181b' : '#ffffff');
  const surface = resolveCssColor('--color-surface', dark ? '#27272a' : '#f4f4f5');
  const accent = resolveCssColor('--color-accent', dark ? '#1f2937' : '#f0f9ff');
  const text = resolveCssColor('--color-foreground', dark ? '#f4f4f5' : '#27272a');
  const subtleText = resolveCssColor('--color-foreground-subtle', dark ? '#a1a1aa' : '#52525b');
  const border = resolveCssColor('--color-border', dark ? '#3f3f46' : '#d4d4d8');
  return {
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    securityLevel: 'strict',
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: 'base',
    themeVariables: {
      actorBkg: background, actorBorder: border, actorTextColor: text,
      background, lineColor: subtleText, mainBkg: background, nodeBorder: border,
      noteBkgColor: accent, noteTextColor: text, primaryBorderColor: border,
      primaryColor: surface, primaryTextColor: text, secondaryBorderColor: border,
      secondaryColor: accent, secondaryTextColor: text, signalColor: subtleText,
      signalTextColor: text, tertiaryBorderColor: border, tertiaryColor: background,
      tertiaryTextColor: text, textColor: text,
    },
  };
}
function hashMermaidCode(code: string): string {
  let hash = 2166136261;
  for (let index = 0; index < code.length; index += 1) { hash ^= code.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
}
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(task, task);
  renderQueue = run.then(() => undefined, () => undefined);
  return run;
}
let ticketSeq = 0;
watch(() => [trimmedCode.value, darkRevision.value] as const, ([code]) => {
  const ticket = ++ticketSeq;
  if (!code) { state.value = { status: 'plaintext' }; emit('previewSvg', null); return; }
  const decision = resolveMermaidAutoRenderDecision(code, { documentVisibilityState: getCurrentMermaidDocumentVisibility() });
  if (!decision.shouldRender) { state.value = { status: 'plaintext' }; emit('previewSvg', null); return; }
  state.value = { status: 'loading' };
  emit('previewSvg', null);
  const renderId = `prism-mermaid-${hashMermaidCode(code)}-${++idSeq}`;
  void enqueue(async () => {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize(buildConfig() as never);
    return mermaid.render(renderId, code);
  })
    .then(({ svg }: { svg: string }) => {
      if (ticket === ticketSeq) { state.value = { status: 'ready', svg }; emit('previewSvg', svg); }
    })
    .catch(() => {
      // 流式未完成或非标准语法常见；退回纯文本保留内容可读，不用错误面板打断阅读。
      if (ticket === ticketSeq) { state.value = { status: 'plaintext' }; emit('previewSvg', null); }
    });
}, { immediate: true });
const mediaListener = (): void => { darkRevision.value++; };
const themeObserver = typeof MutationObserver !== 'undefined' ? new MutationObserver(mediaListener) : null;
if (typeof document !== 'undefined') themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', mediaListener);
if (typeof window !== 'undefined') window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', mediaListener);
onBeforeUnmount(() => {
  ticketSeq++;
  themeObserver?.disconnect();
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', mediaListener);
  if (typeof window !== 'undefined') window.matchMedia?.('(prefers-color-scheme: dark)').removeEventListener?.('change', mediaListener);
});
</script>
<template>
  <div class="mermaid-block" data-mermaid-block>
    <div class="mermaid-viewport">
      <div v-if="state.status==='loading'" class="mermaid-status"><svg class="mermaid-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span>正在渲染图表…</span></div>
      <pre v-else-if="state.status==='plaintext'" class="mermaid-plain">{{ code }}</pre>
      <div v-else class="mermaid-figure" role="img" aria-label="Mermaid 图表" @dblclick="props.onOpenPreview?.()" v-html="state.svg"></div>
    </div>
  </div>
</template>
<style scoped>
/* mermaid-block.tsx: group/mermaid relative min-h-32 w-full bg-card；视口 max-h-420 p-3 overflow-auto。 */
.mermaid-block{position:relative;min-height:128px;width:100%;background:var(--bg-card)}
.mermaid-viewport{max-height:420px;overflow:auto;padding:12px;color:var(--fg)}
.mermaid-status{display:flex;min-height:112px;align-items:center;justify-content:center;gap:8px;color:var(--fg-subtle);font-size:var(--text-ui-base)}
.mermaid-spin{animation:mermaid-rotate 1s linear infinite}
@keyframes mermaid-rotate{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.mermaid-spin{animation:none}}
.mermaid-plain{margin:0;min-height:112px;min-width:max-content;background:transparent;font-family:var(--font-mono);color:var(--fg);font-size:var(--text-ui-base);line-height:1.625}
.mermaid-figure{display:flex;min-height:112px;min-width:max-content;align-items:center;justify-content:center}
.mermaid-figure :deep(svg){height:auto;max-width:none}
</style>

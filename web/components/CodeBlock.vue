<script setup lang="ts">
/** Markdown 代码块（块E1）：按 ZCode code-block.tsx 语义复刻（React→Vue）。
 *  头部＝文件图标＋语言小写 mono＋换行/预览/复制按钮；正文＝Mermaid 分支或
 *  Shiki CodeViewer；Mermaid 渲染成功后挂大图预览对话框。
 *  上游按扩展名映射文件图标图片，此处统一使用本机ZCode同源Material图标集。 */
import { ref, computed } from 'vue';
import { shouldRenderMermaidCodeBlock, resolveMermaidAutoRenderDecision } from '../conversation/mermaidSupport';
import CodeViewer from './CodeViewer.vue';
import FileIcon from './FileIcon.vue';
import MermaidBlock from './MermaidBlock.vue';
import DiagramPreviewDialog from './DiagramPreviewDialog.vue';
const props = withDefaults(defineProps<{ code: string; language?: string; fontSizePx?: number }>(), { language: '', fontSizePx: 14 });
const isWrapped = ref(false);
const previewSvg = ref<string | null>(null);
const previewOpen = ref(false);
const isMermaid = computed(() => shouldRenderMermaidCodeBlock(props.language, props.code));
// 渲染预算门禁：超预算/页面隐藏时不进入 Mermaid render，展示原代码。
const mermaidRenderable = computed(() => isMermaid.value && resolveMermaidAutoRenderDecision(props.code.trim()).shouldRender);
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copyCode(): Promise<void> {
  if (copied.value) return;
  try {
    await navigator.clipboard.writeText(props.code);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied.value = false; }, 2000);
  } catch { /* 剪贴板不可用时静默（无权环境） */ }
}
const mermaidPreviewAvailable = computed(() => isMermaid.value && !!previewSvg.value);
function openPreview(): void { if (mermaidPreviewAvailable.value) previewOpen.value = true; }
</script>
<template>
  <div class="code-block" :data-language="language">
    <div class="code-header">
      <div class="code-title">
        <FileIcon :language="language" :size="16" />
        <span class="code-filename">{{ language.trim().toLowerCase() || 'text' }}</span>
      </div>
      <div class="code-actions">
        <button v-if="isMermaid" type="button" class="code-icon-button" :disabled="!mermaidPreviewAvailable" aria-label="打开图表预览" title="打开图表预览" @click="openPreview"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></button>
        <button v-else type="button" class="code-icon-button" :class="{ 'is-active': isWrapped }" :aria-pressed="isWrapped" aria-label="切换换行" title="切换换行" @click="isWrapped = !isWrapped"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 6h18"/><path d="M3 12h13a3 3 0 1 1 0 6h-4"/><path d="m13 16-2 2 2 2"/><path d="M3 18h4"/></svg></button>
        <button type="button" class="code-icon-button" aria-label="复制代码" title="复制代码" @click="copyCode"><svg v-if="copied" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg><svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>
      </div>
    </div>
    <div class="code-body">
      <MermaidBlock v-if="mermaidRenderable" :code="code" @preview-svg="previewSvg = $event" @open-preview="openPreview" />
      <CodeViewer v-else :code="code" :language="language" :wrap-long-lines="isWrapped" :font-size-px="fontSizePx" />
    </div>
    <DiagramPreviewDialog v-if="isMermaid && previewSvg" :open="previewOpen" :svg="previewSvg" title="图表预览" @update:open="previewOpen = $event" />
  </div>
</template>
<style scoped>
/* CodeBlockContainer: group relative w-full overflow-hidden rounded-xl bg-background；消息内上下文为卡片底。 */
.code-block{position:relative;width:100%;overflow:hidden;border-radius:12px;background:var(--bg-card);border:1px solid var(--border);contain-intrinsic-size:auto 200px;content-visibility:auto;margin:12px 0}
/* CodeBlockHeader: flex items-center justify-between gap-3 px-3 py-2 text-ui-base fg-subtle。 */
.code-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;font-size:var(--text-ui-base);color:var(--fg-subtle)}
.code-title{display:flex;align-items:center;gap:8px;min-width:0}
.code-file-icon{flex-shrink:0;color:var(--fg-subtlest)}
.code-filename{font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:lowercase}
.code-actions{display:flex;align-items:center;gap:2px;margin:-4px -4px -4px 0;flex-shrink:0}
.code-icon-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:var(--fg-subtle);cursor:pointer;flex-shrink:0}
.code-icon-button:hover{background:var(--color-surface-hover);color:var(--fg)}
.code-icon-button.is-active{background:var(--color-surface)}
.code-icon-button:disabled{opacity:.4;cursor:default}
.code-icon-button:disabled:hover{background:transparent;color:var(--fg-subtle)}
/* CodeBlock 正文：p-2 pt-0 pb-3。 */
.code-body{padding:0 8px 12px}
.code-body :deep(.code-viewer .code-pre){border:0;border-radius:0;background:transparent;padding:4px}
</style>

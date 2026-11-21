<script setup lang="ts">
/** 高亮轻量 diff（块F1）：按 ZCode highlighted-lightweight-diff-preview.tsx 语义复刻——
 *  首帧直接渲染轻量行（不阻塞展开交互），shiki token 异步补齐后逐行换装；
 *  高亮失败/语言未知停留在纯文本。语言由路径扩展名推断。 */
import { ref, watch, onBeforeUnmount } from 'vue';
import { getPlainTextPatchPreviewLines, getPatchPreviewLineContent, inferDiffLanguage, parseTruncatedMarkerOmittedLineCount } from '../conversation/patchDiff';
import { createHighlightCoordinator, resolveCodeTheme, type TokenizedCode } from '../conversation/shikiSupport';
import LightweightDiffPreview from './LightweightDiffPreview.vue';
const props = withDefaults(defineProps<{ patch: string; path: string; fontSizePx?: number; showLineNumbers?: boolean; wrapLongLines?: boolean }>(), { fontSizePx: 12, showLineNumbers: false, wrapLongLines: false });
const previewLines = ref<string[]>([]);
const tokens = ref<TokenizedCode | null>(null);
let coordinator: ReturnType<typeof createHighlightCoordinator> | null = null;
let ids = new Set<string>();
let aliases = new Map<string, string>();
let loadPromise: Promise<void> | null = null;
let seq = 0;
const callback = (result: TokenizedCode): void => { tokens.value = result; };
function ensureRuntime(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const shiki = await import('shiki');
    ids = new Set(Object.keys(shiki.bundledLanguages));
    aliases = new Map(shiki.bundledLanguagesInfo.flatMap(info => (info.aliases ?? []).map(alias => [alias, info.id] as const)));
    coordinator = createHighlightCoordinator({
      createHighlighter: async (language, theme) => {
        const highlighter = await shiki.createHighlighter({ langs: [language as never], themes: [theme as never] });
        return highlighter as unknown as import('../conversation/shikiSupport').LoadedHighlighter;
      },
    });
  })();
  return loadPromise;
}
// 可高亮的正文行（跳过截断标记行与协议行）；与 previewLines 的消费顺序一致
function contentLines(): string[] {
  return previewLines.value
    .filter(line => parseTruncatedMarkerOmittedLineCount(line) === null && !line.startsWith('\\ '))
    .map(getPatchPreviewLineContent);
}
watch(() => [props.patch, props.path] as const, ([patch, path]) => {
  const ticket = ++seq;
  tokens.value = null;
  previewLines.value = getPlainTextPatchPreviewLines(patch);
  const language = inferDiffLanguage(path);
  if (!language) return;
  if (!coordinator) { void ensureRuntime().then(() => { if (ticket === seq) requestHighlight(ticket, language); }); return; }
  requestHighlight(ticket, language);
}, { immediate: true });
function requestHighlight(ticket: number, language: string): void {
  if (!coordinator) return;
  const contents = contentLines();
  if (!contents.length) return;
  const sync = coordinator.highlightCode(contents.join('\n'), language, resolveCodeTheme(), ids, aliases, result => { if (ticket === seq) tokens.value = result; });
  if (sync) tokens.value = sync;
}
onBeforeUnmount(() => { seq++; });
</script>
<template>
  <LightweightDiffPreview :lines="previewLines" :tokens="tokens" :font-size-px="fontSizePx" :show-line-numbers="showLineNumbers" :wrap-long-lines="wrapLongLines" />
</template>

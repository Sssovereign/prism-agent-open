<script setup lang="ts">
/** Shiki 代码视图（块E1）：按 ZCode code-viewer.tsx + shikiHighlighter.ts 语义复刻。
 *  上游正文委托 @pierre/diffs 的 Shadow DOM File 组件；此处以 shiki codeToTokens
 *  直渲染等效实现（差异如实记回执）：纯文本语言旁路高亮、tokens 缓存键、
 *  lang 别名解析与 log 回退沿用上游；主题按应用 data-theme 解析并在切换时重新高亮。
 *  shiki 经动态 import 分包，首次代码块渲染时才加载。 */
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { createHighlightCoordinator, createRawCodeTokens, resolveCodeTheme, type TokenizedCode } from '../conversation/shikiSupport';
const props = withDefaults(defineProps<{ code: string; language: string; wrapLongLines?: boolean; fontSizePx?: number; showLineNumbers?: boolean; maxHeightPx?: number }>(), { wrapLongLines: false, fontSizePx: 14, showLineNumbers: false, maxHeightPx: 440 });
const tokenized = ref<TokenizedCode>(createRawCodeTokens(props.code));
let coordinator: ReturnType<typeof createHighlightCoordinator> | null = null;
let ids = new Set<string>();
let aliases = new Map<string, string>();
let loadPromise: Promise<void> | null = null;
let callbackSeq = 0;
const callback = (result: TokenizedCode): void => { tokenized.value = result; };
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
watch(() => [props.code, props.language], () => {
  const ticket = ++callbackSeq;
  if (!coordinator) {
    tokenized.value = createRawCodeTokens(props.code);
    void ensureRuntime().then(() => { if (ticket === callbackSeq) requestHighlight(ticket); }).catch(()=>{});
    return;
  }
  requestHighlight(ticket);
}, { immediate: true });
function requestHighlight(ticket: number): void {
  if (!coordinator) return;
  tokenized.value=createRawCodeTokens(props.code);
  const sync = coordinator.highlightCode(props.code, props.language, resolveCodeTheme(), ids, aliases, result => { if (ticket === callbackSeq) tokenized.value = result; });
  // 缓存命中同步返回（回调走微任务）；未命中返回 null，保持 rawTokens 直到异步完成。
  if (sync) tokenized.value = sync;
}
let themeObserver:MutationObserver|undefined;
onMounted(()=>{themeObserver=new MutationObserver(()=>{const ticket=++callbackSeq;tokenized.value=createRawCodeTokens(props.code);if(coordinator)requestHighlight(ticket);else void ensureRuntime().then(()=>{if(ticket===callbackSeq)requestHighlight(ticket);}).catch(()=>{});});themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','class']});});
onBeforeUnmount(() => { callbackSeq++;themeObserver?.disconnect(); });
</script>
<template>
  <div class="code-viewer" :data-code-theme="resolveCodeTheme()" :data-language="language" :class="{ 'is-wrapped': wrapLongLines }">
    <table v-if="showLineNumbers" class="code-lines"><tbody>
      <tr v-for="(line, index) in tokenized.tokens" :key="index">
        <td class="code-linenum">{{ index + 1 }}</td>
        <td class="code-line"><span v-for="(token, ti) in line" :key="ti" :style="{ color: token.color }">{{ token.content }}</span><br v-if="line.length===0" /></td>
      </tr>
    </tbody></table>
    <pre v-else class="code-pre" :style="{ fontSize: `${fontSizePx}px`, color: tokenized.fg === 'inherit' ? undefined : tokenized.fg, maxHeight: maxHeightPx ? `${maxHeightPx}px` : undefined }"><code><span v-for="(line, index) in tokenized.tokens" :key="index" class="code-line-block"><template v-if="line.length"><span v-for="(token, ti) in line" :key="ti" :style="{ color: token.color }">{{ token.content }}</span></template><br v-else /></span></code></pre>
  </div>
</template>
<style scoped>
.code-viewer{min-width:0;color:var(--fg)}.code-viewer code{font:inherit;background:none;padding:0;border:0}
.code-pre{margin:0;border:0;border-radius:0;padding:4px;background:transparent;white-space:pre;overflow:auto;font-family:var(--font-mono);line-height:1.6}
.code-viewer.is-wrapped .code-pre{white-space:pre-wrap;overflow-wrap:anywhere}
.code-line-block{display:block;min-height:1.6em}
.code-lines{border-collapse:collapse;width:100%;font-family:var(--font-mono);line-height:1.6}
.code-linenum{text-align:right;padding-right:12px;color:var(--fg-subtlest);user-select:none;width:1%;white-space:nowrap}
.code-line{white-space:pre;overflow-wrap:normal}
.is-wrapped .code-line{white-space:pre-wrap;overflow-wrap:anywhere}
</style>

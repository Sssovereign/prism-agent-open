<script setup lang="ts">
/** 轻量 diff 预览（块F1）：按 ZCode lightweight-diff-preview.tsx 逐值复刻（React→Vue）。
 *  行背景 color-mix 14%、inset 3px 状态条、行号 gutter 18% 底＋sticky、
 *  截断标记行、换行/字号/行号可配；协议 marker 不当内容显示。
 *  tokens 可选：就绪后按内容行游标逐行换装 shiki token（HighlightedLightweightDiffPreview 语义）。 */
import { computed } from 'vue';
import { getLightweightDiffLineParts, parseTruncatedMarkerOmittedLineCount, type LightweightDiffLineKind } from '../conversation/patchDiff';
import type { TokenizedCode } from '../conversation/shikiSupport';
const props = withDefaults(defineProps<{ lines: string[]; fontSizePx?: number; showLineNumbers?: boolean; wrapLongLines?: boolean; tokens?: TokenizedCode | null }>(), { fontSizePx: 12, showLineNumbers: false, wrapLongLines: false, tokens: null });
function lineStyle(kind: LightweightDiffLineKind): Record<string, string> {
  if (kind === 'added') return { backgroundColor: 'color-mix(in srgb, var(--color-diff-added) 14%, transparent)', boxShadow: 'inset 3px 0 0 var(--color-diff-added)' };
  if (kind === 'removed') return { backgroundColor: 'color-mix(in srgb, var(--color-diff-removed) 14%, transparent)', boxShadow: 'inset 3px 0 0 var(--color-diff-removed)' };
  return {};
}
function gutterStyle(kind: LightweightDiffLineKind): Record<string, string> {
  if (kind === 'added') return { backgroundColor: 'color-mix(in srgb, var(--color-diff-added) 18%, var(--color-background))', boxShadow: 'inset 3px 0 0 var(--color-diff-added)', color: 'var(--color-diff-added)' };
  if (kind === 'removed') return { backgroundColor: 'color-mix(in srgb, var(--color-diff-removed) 18%, var(--color-background))', boxShadow: 'inset 3px 0 0 var(--color-diff-removed)', color: 'var(--color-diff-removed)' };
  return { backgroundColor: 'var(--color-background)' };
}
interface DiffRow { omitted: number | null; kind: LightweightDiffLineKind; content: string; tokenLine: Array<{ color: string; content: string }> | null }
const rows = computed<DiffRow[]>(() => {
  let cursor = 0;
  return props.lines.map(line => {
    const omitted = parseTruncatedMarkerOmittedLineCount(line);
    if (omitted !== null) return { omitted, kind: 'context' as const, content: '', tokenLine: null };
    const parts = getLightweightDiffLineParts(line);
    // tokens 按内容行顺序消费；协议行（\ No newline…）不占 token 行
    const tokenLine = props.tokens && !line.startsWith('\\ ') ? props.tokens.tokens[cursor++] ?? null : null;
    return { omitted: null, kind: parts.kind, content: parts.content || ' ', tokenLine };
  });
});
</script>
<template>
  <div class="light-diff" data-lightweight-diff-preview>
    <div class="light-diff-content" :class="{ 'is-wrapped': wrapLongLines }" :style="{ fontSize: `${fontSizePx}px` }">
      <template v-for="(row, index) in rows" :key="index">
        <div v-if="row.omitted !== null" class="light-diff-truncated">{{ row.omitted }} 行已省略</div>
        <div v-else class="light-diff-row" :style="lineStyle(row.kind)">
          <span v-if="showLineNumbers" aria-hidden="true" class="light-diff-gutter" :class="`is-${row.kind}`" :style="gutterStyle(row.kind)">{{ index + 1 }}</span>
          <code class="light-diff-code" :class="{ 'is-wrapped': wrapLongLines }"><template v-if="row.tokenLine"><span v-for="(token, ti) in row.tokenLine" :key="ti" :style="{ color: token.color }">{{ token.content }}</span></template><template v-else>{{ row.content }}</template></code>
        </div>
      </template>
    </div>
  </div>
</template>
<style scoped>
.light-diff{width:100%;min-width:0;overflow:auto;background:var(--color-background)}
.light-diff-content{min-width:100%;font-family:var(--font-mono);line-height:1.625;color:var(--fg)}
.light-diff-content:not(.is-wrapped){width:max-content}
.light-diff-row{display:flex;min-width:100%;width:100%}
.light-diff-gutter{position:sticky;left:0;z-index:1;flex-shrink:0;width:48px;padding:0 8px;border-right:1px solid var(--border);text-align:right;user-select:none;font-variant-numeric:tabular-nums;color:var(--fg-subtlest)}
.light-diff-code{display:block;flex:1;padding:0 12px}
.light-diff-code.is-wrapped{white-space:pre-wrap;overflow-wrap:break-word}
.light-diff-code:not(.is-wrapped){white-space:pre}
.light-diff-truncated{padding:4px 12px;color:var(--fg-subtle)}
</style>

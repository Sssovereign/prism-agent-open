<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { createReasoningScrollFollow } from './reasoningScroll';
import type { ConversationReasoningRow } from '../../contracts/conversation';
import MotionDisclosure from './MotionDisclosure.vue';
const props=defineProps<{row:ConversationReasoningRow}>();
// User-controlled only: arriving deltas and terminal events never change disclosure state.
const open=ref(false);
const viewport=ref<HTMLElement>(), content=ref<HTMLElement>();
const follow=createReasoningScrollFollow();
let resizeObserver:ResizeObserver|undefined;
let touchY:number|undefined;
function syncScroll() { if (viewport.value) follow.sync(viewport.value, open.value); }
function onScroll() { if (open.value && viewport.value) follow.onScroll(viewport.value); }
function onWheel(event:WheelEvent) { if (event.deltaY < 0) follow.pause(); }
function onTouchStart(event:TouchEvent) { touchY=event.touches[0]?.clientY; }
function onTouchMove(event:TouchEvent) {
  const nextY=event.touches[0]?.clientY;
  if (nextY !== undefined && touchY !== undefined && nextY > touchY) follow.pause();
  touchY=nextY;
}
function onKeydown(event:KeyboardEvent) {
  if (['ArrowUp','PageUp','Home'].includes(event.key) || (event.key===' ' && event.shiftKey)) follow.pause();
}
// Read the bottom lock from scroll events BEFORE a delta changes scrollHeight.
// Post-flush writes use the new layout; hidden blocks neither scroll nor lose the reader's choice.
watch(() => props.row.text, syncScroll, {flush:'post'});
watch([viewport, content, open], () => {
  resizeObserver?.disconnect();
  resizeObserver=undefined;
  if (!open.value || !viewport.value) return;
  syncScroll();
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver=new ResizeObserver(syncScroll);
    resizeObserver.observe(viewport.value);
    if (content.value) resizeObserver.observe(content.value);
  }
}, {flush:'post'});
onBeforeUnmount(() => resizeObserver?.disconnect());
const preview=computed(()=>props.row.text.replace(/\r\n?/g,'\n').split('\n').find(line=>line.trim())?.trim()??'');
const stateLabel=computed(()=>props.row.state==='streaming'?'思考中':props.row.state==='interrupted'?'思考已中断':'思考');
</script>
<template>
 <MotionDisclosure v-if="row.text.trim()" v-model:open="open" :label="`${open?'收起':'展开'}${stateLabel}`" class="reasoning-block" :data-reasoning-state="row.state">
  <template #summary>
   <span class="reasoning-label" :class="{shimmer:row.state==='streaming'}">{{ stateLabel }}</span>
   <span v-if="!open" class="reasoning-preview">{{ preview }}</span>
   <svg class="reasoning-chevron" :class="{expanded:open}" aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
  </template>
  <div ref="viewport" class="reasoning-text" tabindex="0" role="region" aria-label="推理内容正文" @scroll="onScroll" @wheel.stop="onWheel" @touchstart.stop="onTouchStart" @touchmove.stop="onTouchMove" @keydown.stop="onKeydown"><div ref="content">{{ row.text }}</div></div>
  <p class="reasoning-note">模型返回的推理文本{{ row.truncated?'，内容过长已截断':'，可能不完整' }}。</p>
 </MotionDisclosure>
</template>
<style scoped>
/* Behavior reference: ZCode packages/ui/src/components/ai-elements/reasoning.tsx,
   derived upstream from Vercel ai-elements (Apache-2.0); independent Vue implementation.
   300ms disclosure / 4s text shimmer; shared MotionDisclosure measures height/opacity. */
.reasoning-block{min-width:0;padding:3px 0;color:var(--fg-subtle)}
.reasoning-block :deep(.disclosure-trigger){width:100%;min-width:0;align-items:baseline;gap:10px;line-height:1.7}
.reasoning-label{flex:none;font-size:12px;font-weight:400;color:var(--fg-subtlest)}
.reasoning-preview{min-width:0;flex:1;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;font-size:var(--text-ui-sm);text-align:left;color:var(--fg-subtle)}
.reasoning-chevron{flex:none;margin-left:auto;align-self:center;opacity:.55;transition:transform 300ms ease}
.reasoning-chevron.expanded{transform:rotate(90deg)}
.reasoning-note{margin:6px 0 4px 12px;font-size:11px;line-height:1.5;color:var(--fg-subtle)}
.reasoning-text{box-sizing:border-box;max-height:240px;scroll-behavior:auto;overflow:auto;overscroll-behavior:contain;white-space:pre-wrap;overflow-wrap:anywhere;font:var(--text-ui-sm)/1.85 var(--font-ui,sans-serif);padding:8px 12px;border-left:1px solid var(--border);scrollbar-gutter:stable}
.reasoning-text:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.shimmer{background:linear-gradient(90deg,var(--fg-subtle) 0%,var(--fg-subtle) 35%,var(--fg) 50%,var(--fg-subtle) 65%,var(--fg-subtle) 100%);background-size:200% 100%;background-clip:text;-webkit-background-clip:text;color:transparent;animation:reasoning-shimmer 4s linear infinite}
@keyframes reasoning-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
@media(prefers-reduced-motion:reduce){.shimmer{animation:none;background:none;color:var(--fg-subtle)}.reasoning-chevron{transition:none}}
</style>

<script setup lang="ts">
/** 图表大图预览对话框（块E1）：按 ZCode diagram-preview-dialog.tsx 语义复刻。
 *  滚轮以光标为中心缩放、拖拽平移、键盘 +/−/0、双档按钮与适应视口；
 *  上游的缩放下拉（50/100/200）简化为内联"适应"按钮，差异记回执。 */
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import {ignoredKeyEvent} from '../keyboardShortcuts';
import { clampDiagramScale, fitDiagramToViewport, panDiagram, zoomDiagramAtPoint, type DiagramViewportTransform } from '../conversation/diagramViewport';
const props = defineProps<{ open: boolean; svg: string; title: string }>();
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>();
const defaultTransform: DiagramViewportTransform = { scale: 1, translateX: 0, translateY: 0 };
const transform = ref<DiagramViewportTransform>({ ...defaultTransform });
const viewport = ref<HTMLElement | null>(null);
const figure = ref<HTMLElement | null>(null);
const zoomPercent = computed(() => Math.round(transform.value.scale * 100));
function resetTransform(): void { transform.value = { ...defaultTransform }; }
function zoomBy(factor: number): void {
  const rect = viewport.value?.getBoundingClientRect();
  const center = rect ? { x: rect.width / 2, y: rect.height / 2 } : { x: 0, y: 0 };
  transform.value = zoomDiagramAtPoint(transform.value, center, transform.value.scale * factor);
}
function zoomToScale(scale: number): void {
  const rect = viewport.value?.getBoundingClientRect();
  const center = rect ? { x: rect.width / 2, y: rect.height / 2 } : { x: 0, y: 0 };
  transform.value = zoomDiagramAtPoint(transform.value, center, clampDiagramScale(scale));
}
function zoomToFit(): void {
  const viewportRect = viewport.value?.getBoundingClientRect();
  const figureRect = figure.value?.getBoundingClientRect();
  if (!viewportRect || !figureRect || figureRect.width <= 0 || figureRect.height <= 0) { resetTransform(); return; }
  transform.value = fitDiagramToViewport({ diagramWidth: figureRect.width, diagramHeight: figureRect.height, viewportWidth: viewportRect.width, viewportHeight: viewportRect.height });
}
function onWheel(event: WheelEvent): void {
  event.preventDefault();
  const rect = viewport.value?.getBoundingClientRect();
  if (!rect) return;
  const factor = event.deltaY < 0 ? 1.18 : 0.85;
  transform.value = zoomDiagramAtPoint(transform.value, { x: event.clientX - rect.left, y: event.clientY - rect.top }, transform.value.scale * factor);
}
let dragPointerId: number | null = null;
let dragLast = { x: 0, y: 0 };
function onPointerDown(event: PointerEvent): void {
  if (dragPointerId !== null) return;
  dragPointerId = event.pointerId;
  dragLast = { x: event.clientX, y: event.clientY };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function onPointerMove(event: PointerEvent): void {
  if (dragPointerId !== event.pointerId) return;
  const delta = { x: event.clientX - dragLast.x, y: event.clientY - dragLast.y };
  dragLast = { x: event.clientX, y: event.clientY };
  transform.value = panDiagram(transform.value, delta);
}
function onPointerUp(event: PointerEvent): void {
  if (dragPointerId === event.pointerId) dragPointerId = null;
}
function onKeyDown(event: KeyboardEvent): void {
  if (!props.open || ignoredKeyEvent(event) || event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && event.key !== '+')) return;
  const modal = [...document.querySelectorAll('[role=dialog][aria-modal=true]')].at(-1);
  if (!modal?.matches('.diagram-overlay')) return;
  if (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable=true]')) return;
  if (!['Escape','+','=','-','0'].includes(event.key)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (event.key === 'Escape') { emit('update:open', false); return; }
  if (event.key === '+' || event.key === '=') { zoomBy(1.18); return; }
  if (event.key === '-') { zoomBy(0.85); return; }
  if (event.key === '0') { zoomToFit(); }
}
function onKeydownCapture(event: KeyboardEvent): void { if (props.open) onKeyDown(event); }
if (typeof window !== 'undefined') window.addEventListener('keydown', onKeydownCapture);
onBeforeUnmount(() => { if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydownCapture); });
watch(() => props.open, open => { if (!open) resetTransform(); else zoomToFit(); });
function close(): void { emit('update:open', false); }
</script>
<template>
  <Teleport to="body">
    <div v-if="open" class="diagram-overlay" role="dialog" aria-modal="true" :aria-label="title" @wheel="onWheel">
      <header class="diagram-toolbar">
        <span class="diagram-title">{{ title }}</span>
        <div class="diagram-actions">
          <button type="button" class="diagram-button" aria-label="缩小" title="缩小" @click="zoomBy(0.85)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg></button>
          <span class="diagram-percent">{{ zoomPercent }}%</span>
          <button type="button" class="diagram-button" aria-label="放大" title="放大" @click="zoomBy(1.18)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
          <button type="button" class="diagram-button diagram-fit" @click="zoomToFit">适应</button>
          <button type="button" class="diagram-button" aria-label="关闭" title="关闭" @click="close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
      </header>
      <div ref="viewport" class="diagram-viewport" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp" @dblclick="close">
        <div ref="figure" class="diagram-figure" :style="{ transform: `translate(${transform.translateX}px, ${transform.translateY}px) scale(${transform.scale})` }" v-html="svg"></div>
      </div>
    </div>
  </Teleport>
</template>
<style scoped>
.diagram-overlay{position:fixed;inset:0;z-index:80;display:flex;flex-direction:column;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(6px)}
.diagram-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border)}
.diagram-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-ui-base);font-weight:500;color:var(--fg)}
.diagram-actions{display:flex;align-items:center;gap:4px;flex-shrink:0}
.diagram-button{display:inline-flex;align-items:center;justify-content:center;height:28px;min-width:28px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:var(--fg-subtle);cursor:pointer;font-size:var(--text-ui-sm)}
.diagram-button:hover{background:var(--color-surface-hover);color:var(--fg)}
.diagram-percent{min-width:44px;text-align:center;font:var(--text-ui-sm) var(--font-mono);color:var(--fg-subtlest)}
.diagram-fit{padding:0 10px}
.diagram-viewport{flex:1;overflow:hidden;cursor:grab;touch-action:none}
.diagram-viewport:active{cursor:grabbing}
.diagram-figure{display:inline-block;transform-origin:0 0;min-width:100%}
.diagram-figure :deep(svg){max-width:none;height:auto}
</style>

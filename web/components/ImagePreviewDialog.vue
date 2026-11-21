<script setup lang="ts">
/** 图片大图预览对话框（块E2）：按 diagram-preview-dialog.tsx 交互语义复刻到 img 源——
 *  滚轮以光标为中心缩放、拖拽平移、键盘 +/−/0/Escape、适应视口按钮。 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import {ignoredKeyEvent} from '../keyboardShortcuts';
import { clampDiagramScale, fitDiagramToViewport, panDiagram, zoomDiagramAtPoint, type DiagramViewportTransform } from '../conversation/diagramViewport';
const props = defineProps<{ open: boolean; src: string; title: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();
const defaultTransform: DiagramViewportTransform = { scale: 1, translateX: 0, translateY: 0 };
const transform = ref<DiagramViewportTransform>({ ...defaultTransform });
const viewport = ref<HTMLElement | null>(null);
const image = ref<HTMLImageElement | null>(null);
const loaded = ref(false);
const dragging = ref(false);
const zoomPercent = computed(() => Math.round(transform.value.scale * 100));
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
  const el = image.value, rect = viewport.value?.getBoundingClientRect();
  const naturalWidth = el?.naturalWidth ?? 0, naturalHeight = el?.naturalHeight ?? 0;
  if (!rect || !naturalWidth || !naturalHeight) { transform.value = { ...defaultTransform }; return; }
  // 以原图自然尺寸为基准适配（transform外层不再叠加默认缩放）
  transform.value = fitDiagramToViewport({ diagramWidth: naturalWidth, diagramHeight: naturalHeight, viewportWidth: rect.width, viewportHeight: rect.height });
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
  dragging.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function onPointerMove(event: PointerEvent): void {
  if (dragPointerId !== event.pointerId) return;
  const delta = { x: event.clientX - dragLast.x, y: event.clientY - dragLast.y };
  dragLast = { x: event.clientX, y: event.clientY };
  transform.value = panDiagram(transform.value, delta);
}
function onPointerUp(event: PointerEvent): void {
  if (dragPointerId === event.pointerId) { dragPointerId = null; dragging.value = false; }
}
function onKeyDown(event: KeyboardEvent): void {
  if (!props.open || ignoredKeyEvent(event) || event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && event.key !== '+')) return;
  const modal = [...document.querySelectorAll('[role=dialog][aria-modal=true]')].at(-1);
  if (!modal?.matches('.image-preview-overlay')) return;
  if (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable=true]')) return;
  if (!['Escape','+','=','-','0'].includes(event.key)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (event.key === 'Escape') { emit('close'); return; }
  if (event.key === '+' || event.key === '=') { zoomBy(1.18); return; }
  if (event.key === '-') { zoomBy(0.85); return; }
  if (event.key === '0') { zoomToFit(); }
}
watch(() => props.open, open => {
  if (open) { loaded.value = !!image.value?.complete; transform.value = { ...defaultTransform }; window.addEventListener('keydown', onKeyDown, true); }
  else window.removeEventListener('keydown', onKeyDown, true);
});
function onImageLoad(): void { loaded.value = true; }
onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown, true));
onMounted(() => { if (props.open) window.addEventListener('keydown', onKeyDown, true); });
</script>
<template>
  <Teleport to="body">
    <div v-if="open" class="image-preview-overlay" role="dialog" aria-modal="true" :aria-label="`图片预览：${title}`">
      <header class="image-preview-toolbar">
        <span class="image-preview-title" :title="title">{{ title }}</span>
        <span class="image-preview-actions">
          <button type="button" aria-label="缩小" @click="zoomBy(0.85)">−</button>
          <span class="image-preview-zoom" aria-live="polite">{{ zoomPercent }}%</span>
          <button type="button" aria-label="放大" @click="zoomBy(1.18)">+</button>
          <button type="button" aria-label="适应窗口" @click="zoomToFit()">适应</button>
          <button type="button" aria-label="关闭预览" @click="emit('close')">×</button>
        </span>
      </header>
      <div ref="viewport" class="image-preview-viewport" @wheel="onWheel" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp">
        <img
          ref="image" :src="src" :alt="title" draggable="false"
          class="image-preview-figure"
          :class="{ dragging: dragging }"
          :style="{ transform: `translate(${transform.translateX}px, ${transform.translateY}px) scale(${transform.scale})` }"
          @load="onImageLoad"
        />
        <p v-if="!loaded" class="image-preview-loading">正在加载图片…</p>
      </div>
    </div>
  </Teleport>
</template>
<style scoped>
/* 对齐 diagram-preview-dialog 的层级/工具条/画布语义；img 代替 svg 容器 */
.image-preview-overlay { position: fixed; inset: 0; z-index: 90; display: flex; flex-direction: column; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(4px); }
.image-preview-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); color: var(--fg); font: 400 var(--text-ui-sm)/20px var(--font-ui, sans-serif); }
.image-preview-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.image-preview-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.image-preview-actions button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; height: 28px; min-width: 28px; padding: 0 8px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--fg); font: 400 var(--text-ui-sm)/20px var(--font-ui, sans-serif); cursor: pointer; }
.image-preview-actions button:hover { background: var(--hover); border-color: var(--border-hover); }
.image-preview-zoom { min-width: 44px; text-align: center; color: var(--fg-subtle); font-variant-numeric: tabular-nums; }
.image-preview-viewport { position: relative; flex: 1; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.image-preview-figure { max-width: none; user-select: none; transform-origin: center center; will-change: transform; box-shadow: 0 8px 40px rgb(0 0 0 / 30%); cursor: grab; }
.image-preview-figure.dragging { cursor: grabbing; }
.image-preview-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--fg-subtle); font-size: var(--text-ui-sm); pointer-events: none; }
</style>

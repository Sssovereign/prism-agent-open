<script setup lang="ts">
import { onBeforeUnmount } from 'vue';
import { DEFAULT_DRAWER_WIDTH } from '../layout/drawerWidth';
const props = defineProps<{ width: number; min: number; max: number; defaultWidth?: number }>();
const emit = defineEmits<{ (e: 'update:width', width: number): void; (e: 'resizing', active: boolean): void }>();
let drag: { id: number; x: number; width: number; target: HTMLElement } | undefined;
const update = (width: number) => emit('update:width', Math.round(Math.max(props.min, Math.min(width, props.max))));
function finish() {
  if (!drag) return;
  const { target, id } = drag; drag = undefined;
  if (target.hasPointerCapture(id)) target.releasePointerCapture(id);
  document.body.classList.remove('resizing-drawer');
  window.removeEventListener('blur', finish); emit('resizing', false);
}
function begin(event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary) return;
  event.preventDefault(); finish();
  const target = event.currentTarget as HTMLElement;
  drag = { id: event.pointerId, x: event.clientX, width: props.width, target };
  target.setPointerCapture(event.pointerId); target.focus();
  document.body.classList.add('resizing-drawer'); window.addEventListener('blur', finish); emit('resizing', true);
}
function move(event: PointerEvent) { if (drag?.id === event.pointerId) update(drag.width + drag.x - event.clientX); }
function key(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  update(event.key === 'Home' ? (props.defaultWidth ?? DEFAULT_DRAWER_WIDTH) : event.key === 'End' ? props.max : props.width + (event.key === 'ArrowLeft' ? 16 : -16));
}
onBeforeUnmount(finish);
</script>
<template>
  <div class="drawer-resize" role="separator" aria-label="调整详情面板宽度" aria-orientation="vertical" :aria-valuemin="min" :aria-valuemax="max" :aria-valuenow="width" tabindex="0" title="拖动调整宽度，双击恢复默认" @pointerdown="begin" @pointermove="move" @pointerup="finish" @pointercancel="finish" @lostpointercapture="finish" @keydown="key" @dblclick="update(props.defaultWidth ?? DEFAULT_DRAWER_WIDTH)"></div>
</template>
<style scoped>
.drawer-resize{position:absolute;inset:0 auto 0 0;width:7px;z-index:3;cursor:col-resize;touch-action:none}
.drawer-resize::after{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;transition:background .15s}
.drawer-resize:hover::after,.drawer-resize:focus-visible::after{background:var(--color-icon-blue,var(--fg-subtle))}
.drawer-resize:focus-visible{outline:1px solid var(--fg-subtle);outline-offset:-1px}
</style>

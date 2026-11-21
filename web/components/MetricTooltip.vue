<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
const props = withDefaults(defineProps<{ text: string; disabled?: boolean; onlyWhenClipped?: boolean }>(), { disabled: false, onlyWhenClipped: true });
const root = ref<HTMLElement | null>(null), tip = ref<HTMLElement | null>(null), shown = ref(false);
const id = useId(); const pos = ref({ left: '12px', top: '12px' }); let timer: ReturnType<typeof setTimeout> | undefined;
function hide() { clearTimeout(timer); shown.value = false; }
function schedule() {
  hide(); if (props.disabled) return;
  const label = root.value?.querySelector<HTMLElement>('[data-metric-label]');
  if (props.onlyWhenClipped && label && label.scrollWidth <= label.clientWidth) return;
  timer = setTimeout(async () => {
    if (props.disabled) return; shown.value = true; await nextTick();
    const a = root.value?.getBoundingClientRect(), b = tip.value?.getBoundingClientRect();
    if (a && b) pos.value = { left: `${Math.max(12, Math.min(a.left + a.width / 2 - b.width / 2, innerWidth - b.width - 12))}px`, top: `${Math.max(12, a.top - b.height - 8)}px` };
  }, 200);
}
watch(() => props.disabled, hide); onBeforeUnmount(hide);
</script>
<template>
  <span ref="root" class="metric-tooltip-anchor" @mouseenter="schedule" @mouseleave="hide" @focusin="schedule" @focusout="hide" @pointerdown="hide" @keydown.esc="hide">
    <slot :describedby="shown ? id : undefined" />
    <Teleport to="body"><div v-if="shown && !disabled" :id="id" ref="tip" role="tooltip" class="metric-tooltip" :style="pos">{{ text }}</div></Teleport>
  </span>
</template>
<style scoped>
.metric-tooltip-anchor{display:inline-flex;min-width:0;max-width:100%}
.metric-tooltip{position:fixed;z-index:1200;max-width:min(360px,calc(100vw - 24px));padding:6px 10px;border-radius:8px;background:var(--dsw-specific-menu,#fff);color:var(--dsw-alias-label-secondary,#555);box-shadow:0 3px 18px #0002;font:12px/18px -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;overflow-wrap:anywhere;pointer-events:none}
</style>

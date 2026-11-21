<script setup lang="ts">
/** Toast 宿主：4 个固定栈 + anchorId 锚定栈，Teleport 到 body。
 *  对齐 ZCode a9fe401 toast.tsx 的 ToastContainer / AnchoredToastStack。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { dismissToast, toastState, type ToastItem, type ToastPosition } from '../../ui/toast';
import ToastMessage from './ToastMessage.vue';

const topCenterItems = computed(() => toastState.items.filter((item) => item.position === 'top-center' && !item.anchorId));
const topRightItems = computed(() => toastState.items.filter((item) => item.position === 'top-right'));
const bottomLeftItems = computed(() => toastState.items.filter((item) => item.position === 'bottom-left'));
const bottomCenterItems = computed(() => toastState.items.filter((item) => item.position === 'bottom-center'));

const anchoredGroups = computed(() => {
  const map = new Map<string, ToastItem[]>();
  for (const item of toastState.items) {
    if (item.position !== 'top-center' || !item.anchorId) continue;
    const list = map.get(item.anchorId) ?? [];
    list.push(item);
    map.set(item.anchorId, list);
  }
  return [...map.entries()];
});

const anchorLefts = ref(new Map<string, number | null>());
let resizeObserver: ResizeObserver | null = null;
let mutationObserver: MutationObserver | null = null;

function resolveToastAnchorLeft(rect: Pick<DOMRect, 'left' | 'width'>): number {
  return rect.left + rect.width / 2;
}

function syncAnchorPositions() {
  const next = new Map<string, number | null>();
  for (const [anchorId] of anchoredGroups.value) {
    const anchor = document.getElementById(anchorId);
    let observed = observedAnchors.get(anchorId) ?? null;
    if (anchor !== observed) {
      if (observed) resizeObserver?.unobserve(observed);
      observed = anchor;
      if (observed) resizeObserver?.observe(observed);
      observedAnchors.set(anchorId, observed);
    }
    next.set(anchorId, observed ? resolveToastAnchorLeft(observed.getBoundingClientRect()) : null);
  }
  // 清理不再使用的观察
  for (const [anchorId, observed] of observedAnchors) {
    if (!next.has(anchorId) && observed) { resizeObserver?.unobserve(observed); observedAnchors.delete(anchorId); }
  }
  anchorLefts.value = next;
}

const observedAnchors = new Map<string, HTMLElement | null>();

onMounted(() => {
  resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => syncAnchorPositions());
  mutationObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => syncAnchorPositions());
  mutationObserver?.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', syncAnchorPositions);
  document.addEventListener('scroll', syncAnchorPositions, { capture: true, passive: true });
  syncAnchorPositions();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  mutationObserver?.disconnect();
  window.removeEventListener('resize', syncAnchorPositions);
  document.removeEventListener('scroll', syncAnchorPositions, true);
});

watch(anchoredGroups, () => syncAnchorPositions());

function onDone(id: number) {
  dismissToast(id);
}
</script>

<template>
  <Teleport to="body">
    <div class="toast-stack stack-top-center">
      <ToastMessage v-for="item in topCenterItems" :key="item.id" :item="item" @done="onDone" />
    </div>
    <div class="toast-stack stack-top-right">
      <ToastMessage v-for="item in topRightItems" :key="item.id" :item="item" @done="onDone" />
    </div>
    <div class="toast-stack stack-bottom-left">
      <ToastMessage v-for="item in bottomLeftItems" :key="item.id" :item="item" is-bottom @done="onDone" />
    </div>
    <div class="toast-stack stack-bottom-center">
      <ToastMessage v-for="item in bottomCenterItems" :key="item.id" :item="item" is-bottom @done="onDone" />
    </div>
    <div v-for="[anchorId, anchorItems] in anchoredGroups" :key="anchorId" class="toast-stack stack-top-center stack-anchored"
      :style="anchorLefts.get(anchorId) == null ? undefined : { left: `${anchorLefts.get(anchorId)}px` }">
      <ToastMessage v-for="item in anchorItems" :key="item.id" :item="item" @done="onDone" />
    </div>
  </Teleport>
</template>

<style scoped>
.toast-stack { position: fixed; z-index: 9999; display: flex; flex-direction: column; gap: 8px; }
.stack-top-center { top: 64px; left: 50%; transform: translateX(-50%); align-items: center; }
.stack-anchored { transform: none; }
.stack-top-right { top: 64px; right: 16px; max-width: calc(100vw - 2rem); align-items: flex-end; }
.stack-bottom-left { bottom: calc(1rem + env(safe-area-inset-bottom)); left: 16px; align-items: flex-start; }
.stack-bottom-center { bottom: calc(1rem + env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%); align-items: center; }
</style>

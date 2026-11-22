<script setup lang="ts">
/**
 * ResearchRail —— 研究面板左缘阶段导航轨。
 *
 * 交互与 ConversationRail（ZCode TurnNavigator 复刻）同款：每条阶段一根 2px 线、
 * 悬停涟漪按距离衰减、预览气泡 portal 到 body；条目为研究阶段发言，同组紧凑、
 * 换组留空档（+6px），用于长辩论/评审时间线的快速定位。
 * 类名沿用 tn- 前缀便于与 ConversationRail 逐条对照；定位与裁剪逻辑同源
 * （portal 到 body 以躲开 overflow 裁剪；缩放页坐标除回 zoom）。
 */
import {computed,ref,nextTick,onMounted,onBeforeUnmount,useId} from 'vue';
import {t} from '../ui/i18n/index';

export interface ResearchRailItem {
  id: string;
  /** 阶段标签（正方 · 开题 等，由面板按语言组装）。 */
  label: string;
  /** 状态文案（待执行/执行中/已提交·等待整批发布…）。 */
  stateText: string;
  /** 该阶段是否执行中（线与预览提亮）。 */
  running: boolean;
  /** 发言摘要；无发言时由面板给占位文案。 */
  excerpt: string;
  /** 是否换组（与上一条分组键不同）：线距加大留空档。 */
  gap: boolean;
}

const props = withDefaults(defineProps<{ items: ResearchRailItem[]; activeId?: string }>(), { activeId: '' });
const emit = defineEmits<{ (e: 'locate', item: ResearchRailItem): void }>();

// 条目纵向布局：行距 10px（对齐 ConversationRail），换组额外 +6px 空档。
const ITEM_STEP = 10;
const GROUP_GAP = 6;
const offsets = computed<number[]>(() => {
  const out: number[] = [];
  let y = 0;
  for (const item of props.items) { out.push(y); y += ITEM_STEP + (item.gap ? GROUP_GAP : 0); }
  return out;
});
const trackHeight = computed(() => (offsets.value.length ? offsets.value[offsets.value.length - 1]! + ITEM_STEP : 0));

const tooltipId = useId();
const interaction = ref<number | null>(null);
const tipIndex = ref<number | null>(null);
const tipStyle = ref<{ left: string; top: string }>({ left: '0px', top: '0px' });
const hitEls = ref<HTMLElement[]>([]), tip = ref<HTMLElement>();
let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

async function openTip(index: number) {
  const anchor = hitEls.value[index];
  if (!anchor) return;
  const rect = anchor.getBoundingClientRect();
  const zoom = Number.parseFloat(getComputedStyle(document.body).zoom || '1') || 1;
  tipStyle.value = { left: `${rect.right / zoom + 8}px`, top: `${rect.top / zoom}px` };
  tipIndex.value = index; await nextTick();
  const box = tip.value?.getBoundingClientRect(); if (box && tipIndex.value === index) tipStyle.value = { left: `${Math.max(8, Math.min(rect.right + 8, innerWidth - box.width - 8)) / zoom}px`, top: `${Math.max(8, Math.min(rect.top, innerHeight - box.height - 8)) / zoom}px` };
}

const activeIndex = computed(() => {
  if (!props.activeId) return -1;
  const i = props.items.findIndex(item => item.id === props.activeId);
  return i >= 0 ? i : -1;
});

function lineStyle(index: number): { opacity: number; scaleX: number; focus: boolean } {
  const d = interaction.value === null ? undefined : Math.abs(index - interaction.value);
  const unit = d === undefined
    ? { opacity: 0.58, scaleX: 1, focus: false }
    : d === 0 ? { opacity: 1, scaleX: 2.6, focus: true }
      : d === 1 ? { opacity: 0.86, scaleX: 1.7, focus: false }
        : d === 2 ? { opacity: 0.72, scaleX: 1.25, focus: false }
          : { opacity: 0.58, scaleX: 1, focus: false };
  const activeNoHover = d === undefined && index === activeIndex.value;
  const item = props.items[index];
  return {
    opacity: activeNoHover ? 0.9 : item?.running ? Math.max(unit.opacity, 0.72) : unit.opacity,
    scaleX: unit.scaleX,
    focus: unit.focus || activeNoHover,
  };
}

function onEnter(index: number) {
  clearTimeout(closeTimer);
  openTimer = setTimeout(() => { openTip(index); }, 120);
  interaction.value = index;
}

function onLeave() {
  clearTimeout(openTimer);
  closeTimer = setTimeout(() => { tipIndex.value = null; }, 80);
  interaction.value = null;
}

function onFocus(index: number) {
  clearTimeout(openTimer); clearTimeout(closeTimer);
  openTip(index);
  interaction.value = index;
}

function onBlur() { onLeave(); }

function setTip(el: unknown) { tip.value = el instanceof HTMLElement ? el : undefined; }
function setHitEl(index: number, el: unknown) { if (el instanceof HTMLElement) hitEls.value[index] = el; }

function closeTip() { clearTimeout(openTimer); clearTimeout(closeTimer); tipIndex.value = null; interaction.value = null; }
function onClick(item: ResearchRailItem) { closeTip(); emit('locate', item); }
onMounted(() => { window.addEventListener('resize', closeTip); window.addEventListener('scroll', closeTip, true); });
onBeforeUnmount(() => { closeTip(); window.removeEventListener('resize', closeTip); window.removeEventListener('scroll', closeTip, true); });
</script>

<template>
  <nav v-if="items.length >= 2" class="turn-nav" :aria-label="t('research.rail.label')">
    <div class="tn-scroll" @pointerleave="onLeave()" @scroll="closeTip">
      <div class="tn-inner" :style="{ height: `${trackHeight}px` }">
        <div v-for="(item, index) in items" :key="item.id" class="tn-item" :style="{ transform: `translateY(${offsets[index]}px)` }">
          <button
            class="tn-hit"
            type="button"
            :aria-label="t('research.rail.jump', { label: item.label })"
            :aria-describedby="tipIndex === index ? `${tooltipId}-${index}` : undefined"
            :aria-posinset="index + 1"
            :aria-setsize="items.length"
            :aria-current="index === activeIndex ? 'location' : undefined"
            :data-active="item.id === activeId ? 'true' : 'false'"
            :data-running="item.running ? 'true' : 'false'"
            :ref="(el) => setHitEl(index, el)"
            @pointerenter="onEnter(index)"
            @pointerleave="onLeave()"
            @focus="onFocus(index)"
            @blur="onBlur()"
            @click="onClick(item)"
          >
            <span class="tn-enter" aria-hidden="true">
              <span
                class="tn-line"
                :class="{ 'is-focus': lineStyle(index).focus }"
                :style="{ opacity: lineStyle(index).opacity, transform: `scaleX(${lineStyle(index).scaleX})` }"
              ></span>
            </span>
          </button>
          <Teleport to="body">
            <Transition name="tn-preview"><div v-if="tipIndex === index" :ref="setTip" class="tn-tip" role="tooltip" :id="`${tooltipId}-${index}`" :style="tipStyle"><header class="tn-tip-meta"><span>{{ item.label }}</span><span>{{ item.stateText }}</span></header>
              <p class="tn-tip-lead">{{ item.excerpt }}</p>
            </div></Transition>
          </Teleport>
        </div>
      </div>
    </div>
  </nav>
</template>

<style scoped>
/* 几何与配色对齐 ConversationRail（ZCode TurnNavigator 复刻）：48px 轨列、
   12px 基线宽、行距 10px、涟漪 scaleX 距离衰减、≥864px 容器宽才显示。 */
.turn-nav {
  position: absolute;
  inset: 0 auto 0 0;
  width: 48px;
  z-index: 10;
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transform: translateX(-8px);
  transition: opacity 150ms ease-out, transform 150ms ease-out, visibility 150ms;
  --tn-foreground: var(--fg);
  --tn-subtlest: var(--fg-subtlest);
}

@container conversation (min-width: 864px) {
  .turn-nav {
    opacity: 1;
    visibility: visible;
    transform: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .turn-nav, .tn-line { transition: none !important; }
  .tn-enter { animation: none !important; }
}
.tn-scroll {
  pointer-events: auto;
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  width: 36px;
  max-height: calc(100% - 96px);
  padding: 4px 0;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-width: none;
}
.tn-scroll::-webkit-scrollbar { display: none; }
.tn-inner { position: relative; width: 36px; }
.tn-item {
  position: absolute;
  left: 0;
  top: 0;
  height: 10px;
  width: 36px;
}
.tn-hit {
  display: flex;
  height: 10px;
  width: 36px;
  align-items: center;
  justify-content: flex-start;
  border-radius: 2px;
  border: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
}
.tn-hit:focus-visible {
  outline: 2px solid var(--fg-subtle);
  outline-offset: 2px;
}
@keyframes tn-nav-enter {
  0% { opacity: 0; transform: translate(-6px); }
  to { opacity: 1; transform: translate(0); }
}
.tn-enter {
  display: block;
  animation: 0.18s ease-out tn-nav-enter;
}
.tn-line {
  display: block;
  height: 2px;
  width: 12px;
  transform-origin: left;
  border-radius: 9999px;
  background: var(--tn-subtlest);
  transition: height 150ms ease-out, opacity 150ms ease-out, transform 150ms ease-out, background-color 150ms ease-out;
}
.tn-line.is-focus { background: var(--tn-foreground); }
/* 气泡 portal 到 body，变量定义在自身：teleport 后不再继承 .turn-nav */
.tn-tip {
  --tn-tip-bg: var(--bg-panel);
  --tn-tip-border: var(--border);
  --tn-tip-fg: var(--fg);
  --tn-tip-fg-80: var(--fg-subtle);
  --tn-tip-subtle: var(--fg-subtlest);
  position: fixed;
  width: 320px;
  max-width: calc(100vw - 32px);
  box-sizing: border-box;
  padding: 12px;
  border-radius: 12px;
  background: var(--tn-tip-bg);
  border: 1px solid var(--tn-tip-border);
  box-shadow: 0 8px 24px rgb(0 0 0 / .14);
  color: var(--tn-tip-fg);
  font: 400 14px/20px var(--font-ui, sans-serif);
  pointer-events: none;
  z-index: 20;
}

.tn-tip-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--fg-subtlest); font-size: 12px; margin-bottom: 8px; }
.tn-preview-enter-active, .tn-preview-leave-active { transition: opacity .15s ease, transform .15s ease; }
.tn-preview-enter-from, .tn-preview-leave-to { opacity: 0; transform: translateX(-4px) scale(.98); }
@media (prefers-reduced-motion: reduce) { .tn-preview-enter-active, .tn-preview-leave-active { transition: none; } }
.tn-tip-lead {
  margin: 0;
  font-weight: 500;
  white-space: pre-line;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}
</style>

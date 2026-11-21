<script setup lang="ts">
// 逐值移植 ZCode composer 思考强度滑杆（packages/ui/src/chat-input-toolbar/ComposerModelMenu.tsx
// 的 effort 区块 + composer-thought-slider.css + ComposerEffortHeading.tsx）：
// 标题行(思考强度+当前值) / 轨道 / 绿色填充 / 最高档 oklch 渐变与气泡 / 档位圆点 / 白色圆钮 /
// 隐形 range 承接点击拖拽与方向键。提交链路与上游 React 语义逐条对齐：
// onChange 绑定原生 input 事件（拖动中连续触发，跨档即提交 → 实时跟手）；
// pointerup 兜底；keyup 仅白名单导航键（缺失档位时 range 物理位置仍为 0，
// Home/点击首格不触发 input，须在明确完成手势时接纳首格选择）。off 档不填充。
import { computed, ref } from 'vue';
import RollingLabel from './RollingLabel.vue';

export interface ThoughtLevelOption { value: string; label: string }
const props = withDefaults(defineProps<{
  label: string;
  value: string;
  levels: readonly ThoughtLevelOption[];
  disabled?: boolean;
  /** GLM Highspeed/FlashX 显示名命中时填充转蓝（最高档蓝→紫），按上游 isGlmHighspeedModel 判定后传入 */
  highspeed?: boolean;
  /** 标题行右侧键帽（上游 ComposerEffortHeading 的 ControlShortcutBadge，多档才显示） */
  shortcut?: string;
  /** 嵌入自带 8px 内边距的容器（模型菜单 effort 区）时去掉自身 padding */
  unpadded?: boolean;
}>(), { disabled: false, highspeed: false, shortcut: '', unpadded: false });
const emit = defineEmits<{ (e: 'change', value: string): void }>();

// ZCode thoughtLevelOptions.ts 的 NO_THOUGHT_LEVEL_VALUES；'' 为棱镜"默认（不发送思考参数）"档
const NO_THOUGHT_VALUES = new Set(['', 'disabled', 'false', 'no', 'none', 'nothink', 'no-think', 'no_think', 'off']);
function isNoThought(value: string): boolean { return NO_THOUGHT_VALUES.has(value.trim().toLowerCase()); }

const currentIndex = computed(() => props.levels.findIndex(level => level.value === props.value));
const currentValid = computed(() => currentIndex.value >= 0);
const currentLabel = computed(() => (currentValid.value ? props.levels[currentIndex.value]!.label : '—'));
const sliderDisabled = computed(() => props.disabled || props.levels.length < 2);
const sliderProgress = computed(() => (props.levels.length > 1 && currentIndex.value >= 0 ? (currentIndex.value / (props.levels.length - 1)) * 100 : 0));
const sliderFilled = computed(() => currentIndex.value >= 0 && !isNoThought(props.levels[currentIndex.value]!.value));
const isMax = computed(() => sliderFilled.value && currentIndex.value === props.levels.length - 1 && !sliderDisabled.value);
// 与上游一致：填充宽度含半枚钮，让首尾档位的圆钮/圆点/点击坐标完全对齐
const fillWidth = computed(() => (sliderFilled.value ? `calc(14px + (100% - 28px) * ${sliderProgress.value / 100})` : '0'));
const thumbLeft = computed(() => `calc((100% - 28px) * ${sliderProgress.value / 100})`);
// 模型或档位目录变化时只重置视觉层，避免跨模型补间（上游用同样的 key 思路）
const visualKey = computed(() => `${props.value}:${props.levels.map(level => level.value).join('|')}`);

// 固定种子避免重渲染重新随机，让最高档气泡错峰流动（上游 EFFORT_BUBBLES 原样移植）
const BUBBLES = [
  { top: 4, size: 2, duration: 2.6, delay: -0.4 },
  { top: 14, size: 3, duration: 3.2, delay: -2.1 },
  { top: 8, size: 4, duration: 2.8, delay: -1.1 },
  { top: 18, size: 2, duration: 3.6, delay: -0.8 },
  { top: 3, size: 3, duration: 3, delay: -2.5 },
  { top: 12, size: 2, duration: 3.4, delay: -1.7 },
  { top: 6, size: 3, duration: 3.1, delay: -0.9 },
  { top: 17, size: 4, duration: 2.9, delay: -2.3 },
  { top: 10, size: 2, duration: 3.5, delay: -0.2 },
  { top: 2, size: 2, duration: 2.7, delay: -1.8 },
  { top: 15, size: 3, duration: 3.3, delay: -1.2 },
  { top: 7, size: 4, duration: 3.6, delay: -3.1 },
];
// Highspeed 变体：同布局更快的气泡（上游 HIGHSPEED_BUBBLES 推导原样移植）
const bubbles = computed(() => (props.highspeed
  ? Array.from({ length: 32 }, (_, index) => ({ ...BUBBLES[index % BUBBLES.length]!, duration: (8 + (index % 5)) / 10, delay: -index * 0.137 }))
  : BUBBLES));

const hoveredStop = ref<string | null>(null);
function selectSliderValue(index: number) {
  const level = props.levels[index];
  if (!sliderDisabled.value && level && level.value !== props.value) emit('change', level.value);
}
function onPointerMove(event: PointerEvent) {
  // 原生 range 覆盖圆点，用坐标反馈悬停，避免圆点截获拖拽事件（上游同款几何）
  const rect = (event.currentTarget as HTMLInputElement).getBoundingClientRect();
  const trackWidth = rect.width - 28;
  const index = Math.round(((event.clientX - rect.left - 14) / trackWidth) * (props.levels.length - 1));
  const level = props.levels[index];
  const center = rect.left + 14 + (trackWidth * index) / (props.levels.length - 1);
  hoveredStop.value = !sliderDisabled.value && event.pointerType !== 'touch' && level && Math.abs(event.clientX - center) <= 10
    ? `${props.value}:${level.value}`
    : null;
}
function onKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape') {
    // Escape 放行给外层菜单关闭；其余键归滑杆（上游同款）
    event.stopPropagation();
    if (sliderDisabled.value && event.key !== 'Tab') event.preventDefault();
  }
}
// 上游 ComposerModelMenu.tsx 的 keyup 白名单：非导航键（如 Tab）keyup 不提交
const KEYUP_COMMIT_KEYS = new Set(['Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown']);
function onKeyUp(event: KeyboardEvent) {
  if (KEYUP_COMMIT_KEYS.has(event.key)) selectSliderValue(Number((event.currentTarget as HTMLInputElement).value));
}
</script>

<template>
  <div class="thought-block" :class="{ 'is-unpadded': unpadded }">
    <div class="thought-heading">
      <span class="thought-heading-label">{{ label }}</span>
      <span class="thought-heading-value"><RollingLabel :label="currentLabel" /></span>
      <kbd v-if="shortcut" class="thought-kbd">{{ shortcut }}</kbd>
    </div>
    <div v-if="levels.length > 1" class="composer-thought-slider" :data-disabled="sliderDisabled">
      <div :key="visualKey" aria-hidden="true" class="slider-visual">
        <div class="thought-track" :data-progress="sliderFilled ? sliderProgress : 0">
          <div class="thought-track-border"></div>
          <div class="thought-fill" :data-max="isMax" :data-highspeed="highspeed" :style="{ width: fillWidth }">
            <div v-if="isMax" class="thought-bubbles">
              <span v-for="(bubble, index) in bubbles" :key="index" class="thought-bubble" :style="{ top: `${bubble.top}px`, animationDuration: `${bubble.duration}s`, animationDelay: `${bubble.delay}s` }">
                <span :style="{ width: `${bubble.size}px`, height: `${bubble.size}px` }"></span>
              </span>
            </div>
          </div>
        </div>
        <div class="thought-stops">
          <span v-for="level in levels" :key="level.value" class="thought-stop" :data-filled="sliderFilled && levels.indexOf(level) <= currentIndex" :data-hovered="!sliderDisabled && hoveredStop === `${value}:${level.value}`"></span>
        </div>
        <div class="thought-thumb" :style="{ left: thumbLeft }"></div>
      </div>
      <input
        type="range"
        :min="0"
        :max="Math.max(0, levels.length - 1)"
        step="1"
        :value="Math.max(0, currentIndex)"
        :aria-disabled="sliderDisabled"
        :aria-label="label"
        :aria-valuetext="currentLabel"
        class="thought-range"
        @pointerdown="sliderDisabled && $event.preventDefault()"
        @pointerleave="hoveredStop = null"
        @pointermove="onPointerMove"
        @click.stop
        @keydown="onKeyDown"
        @keyup="onKeyUp"
        @pointerup="selectSliderValue(Number(($event.currentTarget as HTMLInputElement).value))"
        @input="selectSliderValue(Number(($event.currentTarget as HTMLInputElement).value))"
      />
    </div>
  </div>
</template>

<style scoped>
/* 移植 composer-thought-slider.css；色彩对齐 PRISM 语义 token，蓝/紫取上游 Tailwind blue-500/purple-500 */
.thought-block { padding: 8px; }
.thought-block.is-unpadded { padding: 0; }
.thought-heading { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 14px; line-height: 20px; }
.thought-heading-label { color: var(--fg-subtle); font-size: 12px; line-height: 16px; }
.thought-heading-value { color: var(--fg); }
/* 上游 ControlShortcutBadge：h-4 rounded-md bg-tooltip-tag px-1.5 text-ui-xs font-medium；Apple 平台 SF 字体 */
.thought-kbd { display: inline-flex; flex: none; align-items: center; height: 16px; margin-left: auto; padding: 0 6px; border-radius: 6px; background: color-mix(in srgb, var(--fg) 15%, transparent); color: color-mix(in srgb, var(--fg) 65%, transparent); font: 500 10px/1 -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif; }
.composer-thought-slider { --composer-thought-slider-thumb: #fff; --composer-thought-max-accent: #3b82f6; --composer-thought-highspeed-accent: #a855f7; position: relative; height: 32px; width: 100%; border-radius: 9999px; }
.composer-thought-slider[data-disabled="true"] { opacity: 0.5; }
.composer-thought-slider:has(.thought-range:focus-visible) { outline: 2px solid var(--border-hover); outline-offset: 2px; }
.slider-visual { position: absolute; inset: 0; pointer-events: none; }
.thought-track { position: absolute; inset-inline: 0; top: 4px; height: 24px; overflow: hidden; border-radius: 9999px; background: color-mix(in srgb, var(--fg) 10%, transparent); }
.thought-track-border { position: absolute; inset: 0; border-radius: inherit; border: 1px solid color-mix(in srgb, var(--fg) 10%, transparent); }
.thought-fill { position: absolute; inset-block: 0; left: 0; overflow: hidden; border-radius: 9999px; background: var(--success); transition: width 120ms ease-out; }
.thought-fill::before { content: ""; position: absolute; inset: 0; border-radius: inherit; opacity: 0; transition: opacity 200ms ease-out; background: linear-gradient(270deg in oklch shorter hue, var(--composer-thought-max-accent) 0%, var(--success) 100%); }
.thought-fill[data-highspeed="true"] { background: var(--composer-thought-max-accent); }
.thought-fill[data-highspeed="true"]::before { background: linear-gradient(90deg in oklab, var(--composer-thought-max-accent) 0%, var(--composer-thought-highspeed-accent) 100%); }
.thought-fill[data-max="true"]::before { opacity: 1; }
.thought-bubbles { position: absolute; inset: 0; }
.thought-bubble { position: absolute; inset-inline: 0; opacity: 0; animation: thought-bubble-flow linear infinite; }
.thought-bubble > span { display: block; border-radius: 9999px; background: #fff; }
@keyframes thought-bubble-flow { 0% { transform: translateX(104%); opacity: 0; } 15%, 80% { opacity: 0.4; } 100% { transform: translateX(-4%); opacity: 0; } }
.thought-stops { position: absolute; inset-inline: 14px; inset-block: 0; display: flex; align-items: center; justify-content: space-between; }
.thought-stop { width: 4px; height: 4px; flex: none; border-radius: 9999px; background: var(--fg-subtlest); scale: 1; transition: scale 120ms ease-out, opacity 120ms ease-out; }
.thought-stop[data-filled="true"] { background: #fff; opacity: 0.3; }
.thought-stop[data-hovered="true"] { scale: 1.75; opacity: 1; }
.thought-thumb { position: absolute; top: 2px; width: 28px; height: 28px; border-radius: 9999px; background: var(--composer-thought-slider-thumb); box-shadow: 0 1px 2px rgb(0 0 0 / 0.05); transition: left 120ms ease-out; }
/* 原生滑块尺寸与可视滑块一致，确保首尾档位及点击/拖动坐标对齐（上游同款） */
.thought-range { position: absolute; inset: 0; margin: 0; height: 32px; width: 100%; cursor: pointer; appearance: none; background: transparent; outline: none; }
.thought-range[aria-disabled="true"] { cursor: default; }
.thought-range::-webkit-slider-runnable-track { height: 32px; background: transparent; }
.thought-range::-webkit-slider-thumb { appearance: none; width: 28px; height: 28px; margin-top: 2px; border: 0; border-radius: 50%; background: transparent; }
.thought-range::-moz-range-track { height: 32px; background: transparent; }
.thought-range::-moz-range-thumb { width: 28px; height: 28px; border: 0; border-radius: 50%; background: transparent; }
.thought-range::-moz-range-progress { background: transparent; }
@media (prefers-reduced-motion: reduce) {
  .thought-bubbles { display: none; }
  .thought-bubble { animation: none; }
  .thought-stop, .thought-thumb, .thought-fill, .thought-fill::before { transition: none; }
}
</style>

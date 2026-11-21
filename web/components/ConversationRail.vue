<script setup lang="ts">
/**
 * ConversationRail —— 会话左缘问题导航轨。
 *
 * 参照 ZCode 桌面端 TurnNavigator 移植布局与交互；采用应用主题变量，补齐消息时间与视口边界
 * （/Applications/ZCode.app asar → out/renderer/assets/styles-a4AckxCl.js 中
 * sDn/cDn + h_t 涟漪 + l_t/c_t 预览截断，o_t=220、s_t=2；本文件注释保留出处）。
 *
 * 结构与行为（与 ZCode 一致）：
 *  - 每条「真实用户提问」一根 2px 线（h-0.5），基宽 12px（w-3），行距 10px，
 *    命中区高 10px（h-2.5）、宽 36px（w-9）；轨列宽 48px（w-12），内层 left-3。
 *  - 悬停涟漪 h_t：与所指线的距离 d 决定 scaleX/opacity——
 *    d0: scaleX 2.6 / opacity 1 / 前景色；d1: 1.7 / 0.86；d2: 1.25 / 0.72；
 *    d≥3: 1 / 0.58；无悬停时全部 scaleX 1 / 0.58，活动线改用前景色 + 0.9，
 *    运行中的线 opacity 至少 0.72。150ms ease-out 过渡 + 入场动画 0.18s。
 *  - 预览气泡：宽 w-80（320px）、p-3、space-y-2；提问段 line-clamp-2
 *    font-medium；回复段 line-clamp-3，有正文 text/80、无正文/运行中用
 *    foreground-subtle；预览文本按 l_t 截断（220 字符、最多 2 段、
 *    单换行折叠为空格、双换行分段、超长 slice(0,217).trimEnd()+"..."）。
 *  - 会话容器宽 ≥864px 才显示（@container conversation），<2 条不渲染。
 *
 * 颜色与portal气泡均取应用语义变量，随data-theme切换；不再固定为暗色。
 */
import { computed, ref, nextTick, onMounted, onBeforeUnmount, useId } from 'vue';
import MessageTime from '../conversation/MessageTime.vue';

export interface RailItem {
  id: string;
  /** 所属工作轮 id（对齐 d_t 的 turnId），用于定位跳转。 */
  runId: string;
  /** 该条对应的用户提问原文。 */
  queryText: string;
  createdAt?: string;
  /** 轮次内助手正文行（每行为一段）。 */
  assistantTexts: string[];
  /** 该轮是否运行中（线与预览提亮）。 */
  running: boolean;
}

const props = withDefaults(defineProps<{ items: RailItem[]; activeId?: string }>(), { activeId: '' });
const emit = defineEmits<{ (e: 'locate', item: RailItem): void }>();

const tooltipId=useId();
const interaction = ref<number | null>(null);
const tipIndex = ref<number | null>(null);
// 气泡 portal 到 body（对齐 Radix Tooltip 的 portal 行为）：否则会被轨滚动容器的
// overflow 裁剪。定位在打开瞬间按锚点按钮实测：side=right(sideOffset 8)、align=start
//（气泡顶 = 按钮顶）。缩放页（校准 zoom）下 rect 是视觉坐标，需除回缩放坐标系。
const tipStyle = ref<{ left: string; top: string }>({ left: '0px', top: '0px' });
const hitEls = ref<HTMLElement[]>([]),tip=ref<HTMLElement>();
let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

async function openTip(index: number) {
  const anchor = hitEls.value[index];
  if (!anchor) return;
  const rect = anchor.getBoundingClientRect();
  const zoom = Number.parseFloat(getComputedStyle(document.body).zoom || '1') || 1;
  tipStyle.value = { left: `${rect.right / zoom + 8}px`, top: `${rect.top / zoom}px` };
  tipIndex.value = index;await nextTick();
  const box=tip.value?.getBoundingClientRect();if(box&&tipIndex.value===index)tipStyle.value={left:`${Math.max(8,Math.min(rect.right+8,innerWidth-box.width-8))/zoom}px`,top:`${Math.max(8,Math.min(rect.top,innerHeight-box.height-8))/zoom}px`};
}

// —— l_t / c_t 预览截断（出处：styles-a4AckxCl.js o_t=220, s_t=2）——
const MAX_PREVIEW_CHARS = 220;
const MAX_PREVIEW_PARAGRAPHS = 2;
const USER_FALLBACK = '用户输入';
const ASSISTANT_EMPTY = '暂无助手正文';
const ASSISTANT_RUNNING = '助手仍在工作';

function clipPreview(text: string, limit: number): string {
  const max = Math.max(8, limit);
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

function buildPreview(texts: string[], fallback: string): string {
  const limit = Math.max(8, MAX_PREVIEW_CHARS);
  const maxParagraphs = Math.trunc(Math.max(1, MAX_PREVIEW_PARAGRAPHS));
  let out = '';
  let inGap = false;
  let gapNewlines = 0;
  let paragraph = 1;
  for (const text of texts) {
    if (out) { inGap = true; gapNewlines = 2; }
    for (const ch of text) {
      if (/\s/u.test(ch)) { inGap = true; if (ch === '\n') gapNewlines += 1; continue; }
      if (inGap && out) {
        if (gapNewlines >= 2) {
          if (paragraph >= maxParagraphs) return clipPreview(out, limit);
          paragraph += 1;
          out += '\n';
        } else {
          out += ' ';
        }
      }
      out += ch;
      inGap = false;
      gapNewlines = 0;
      if (out.length > limit) return clipPreview(out, limit);
    }
  }
  return out || fallback;
}

interface PreviewItem { userPreview: string; assistantPreview: string; assistantKind: 'text' | 'running' | 'empty' }

const previews = computed<PreviewItem[]>(() => props.items.map(item => {
  const assistantPreview = item.assistantTexts.length > 0
    ? buildPreview(item.assistantTexts, ASSISTANT_EMPTY)
    : (item.running ? ASSISTANT_RUNNING : ASSISTANT_EMPTY);
  return {
    userPreview: buildPreview([item.queryText], USER_FALLBACK),
    assistantPreview,
    assistantKind: item.assistantTexts.length > 0 ? 'text' as const : (item.running ? 'running' as const : 'empty' as const),
  };
}));

// —— h_t 涟漪（出处同上）——
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
  clearTimeout(openTimer);clearTimeout(closeTimer);
  openTip(index);
  interaction.value = index;
}

function onBlur() { onLeave(); }

function setTip(el:unknown){tip.value=el instanceof HTMLElement?el:undefined;}
function setHitEl(index: number, el: unknown) { if (el instanceof HTMLElement) hitEls.value[index] = el; }

function closeTip(){clearTimeout(openTimer);clearTimeout(closeTimer);tipIndex.value=null;interaction.value=null;}
function onClick(item: RailItem) {closeTip();emit('locate', item);}
onMounted(()=>{window.addEventListener('resize',closeTip);window.addEventListener('scroll',closeTip,true);});
onBeforeUnmount(()=>{closeTip();window.removeEventListener('resize',closeTip);window.removeEventListener('scroll',closeTip,true);});
</script>

<template>
  <nav v-if="items.length >= 2" class="turn-nav" aria-label="对话问题导航">
    <div class="tn-scroll" @pointerleave="onLeave()" @scroll="closeTip">
      <div class="tn-inner" :style="{ height: `${items.length * 10}px` }">
        <div v-for="(item, index) in items" :key="item.id" class="tn-item" :style="{ transform: `translateY(${index * 10}px)` }">
          <button
            class="tn-hit"
            type="button"
            :aria-label="`跳转到第 ${index + 1} 条问题`"
            :aria-describedby="tipIndex===index?`${tooltipId}-${index}`:undefined"
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
            <Transition name="tn-preview"><div v-if="tipIndex === index" :ref="setTip" class="tn-tip" role="tooltip" :id="`${tooltipId}-${index}`" :style="tipStyle"><header class="tn-tip-meta"><span>第 {{ index + 1 }} 条提问</span><MessageTime :value="item.createdAt" /></header>
              <p class="tn-tip-lead">{{ previews[index]?.userPreview }}</p>
              <p class="tn-tip-body" :class="{ 'is-plain': previews[index]?.assistantKind === 'text' }">{{ previews[index]?.assistantPreview }}</p>
            </div></Transition>
          </Teleport>
        </div>
      </div>
    </div>
  </nav>
</template>

<style scoped>
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
  /* theme-zai-dark 实测色（浅色档按 theme-zai-light 推导） */
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
/* 入场动画（出处：@keyframes zcode-turn-navigator-enter） */
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
/* 气泡 portal 到 body（Radix Tooltip 同款），变量定义在自身：teleport 后不再继承 .turn-nav */
.tn-tip {
  --tn-tip-bg: var(--bg-panel);
  --tn-tip-border: var(--border);
  --tn-tip-fg: var(--fg);
  --tn-tip-fg-80: var(--fg-subtle);
  --tn-tip-subtle: var(--fg-subtlest);
  position: fixed; /* left/top 由 openTip 按锚点按钮实测（side right+8 / align start） */
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

.tn-tip-meta{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--fg-subtlest);font-size:12px;margin-bottom:8px}
.tn-preview-enter-active,.tn-preview-leave-active{transition:opacity .15s ease,transform .15s ease}
.tn-preview-enter-from,.tn-preview-leave-to{opacity:0;transform:translateX(-4px) scale(.98)}
@media(prefers-reduced-motion:reduce){.tn-preview-enter-active,.tn-preview-leave-active{transition:none}}
.tn-tip-lead {
  margin: 0;
  font-weight: 500;
  white-space: pre-line;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.tn-tip-body {
  margin: 8px 0 0;
  color: var(--tn-tip-subtle);
  white-space: pre-line;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}
.tn-tip-body.is-plain { color: var(--tn-tip-fg-80); }
</style>

<script setup lang="ts">
// 逐值复刻 ZCode 合并模型菜单（ModelConfigSelect.tsx composerOptions 分支 + ComposerModelMenu.tsx
// + ComposerProviderMenu.tsx + dropdown-menu.tsx）：
// 主面板 w-72(288px)：供应商子菜单触发行(logo+名称+接入徽章+右箭头) / 分隔线 / 「模型」标签 /
// 模型单选行(名称+视觉徽章+右侧勾，选中不关菜单，可继续调档) / 分隔线 / 思考强度区(标题+^T键帽+滑杆)。
// 供应商列表是锚定首行的子菜单：贴主面板外缘 4px、顶部对齐主面板，右侧放不下翻到左侧（上游 Radix
// subContent + sideOffset/alignOffset + collisionPadding 12 的等效实现）。
// 语义同上游：点供应商即切连接并自动选同模型名的模型（chooseConnectionModel），点模型不关菜单，
// Esc 先收子菜单再收主菜单，Tab 直接关闭，外侧点击关闭，peer 菜单互斥。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import type { CSSProperties } from 'vue';
import UiIcon from './UiIcon.vue';
import ThoughtSlider, { type ThoughtLevelOption } from './ThoughtSlider.vue';
import RollingLabel from './RollingLabel.vue';
import ProviderMark from './ProviderMark.vue';
import type { ModelConfigView } from '../../contracts/models';
import { THINKING_LEVEL_LABELS } from '../../contracts/models';
import {ignoredKeyEvent} from '../keyboardShortcuts';
import {popupLayout} from '../ui/popupLayout';

interface ModelItem { value: string; name: string; vision: boolean; providerId: string | null }
interface ProviderGroup { key: string; label: string; providerId: string | null; baseUrl: string; items: ModelItem[] }

const props = withDefaults(defineProps<{
  configs: ModelConfigView[];
  binding: string;
  /** 任务窗口思考强度覆盖（''=跟随设置档位） */
  thinkingLevel?: string;
  thinkingShortcut?: string;
  disabled?: boolean;
  busy?: boolean;
}>(), { thinkingLevel: '', disabled: false, busy: false });
const emit = defineEmits<{
  (e: 'select-model', value: string): void;
  (e: 'update:thinkingLevel', value: string): void;
  (e: 'open-settings'): void;
  (e: 'open-change', open: boolean): void;
}>();

// 上游 MODEL_CONFIG_SELECT_BADGE_CLASS_NAME：接入徽章与视觉徽章共用这组 pill 样式
const PROVIDER_BADGE = 'API';

const groups = computed<ProviderGroup[]>(() => props.configs
  .filter(config => config.enabled)
  .map(config => {
    const items = config.models.filter(model => model.enabled).map(model => ({
      value: `${config.id}:${model.modelId}`,
      name: model.displayName,
      vision: model.visionSupported,
      providerId: model.providerId,
    }));
    // 同一配置共享 baseUrl，供应商身份取首个目录命中；品牌归一（含主机兜底）在 ProviderMark 处理
    return { key: config.id, label: config.name, providerId: items.find(item => item.providerId)?.providerId ?? null, baseUrl: config.baseUrl, items };
  }));
const hasConfigs = computed(() => groups.value.length > 0);

// 上游 ComposerModelMenu：selected=含当前值的组，展示组=selected ?? 首组（空绑定时仍可浏览首组）
const selectedGroup = computed(() => groups.value.find(group => group.items.some(item => item.value === props.binding)) ?? null);
const viewGroup = computed(() => selectedGroup.value ?? groups.value[0] ?? null);
const currentGroupSelected = computed(() => Boolean(selectedGroup.value) && viewGroup.value?.key === selectedGroup.value?.key);

// 思考档位（对齐上游 levels：只含目录档位，无合成"默认"格；off=关闭是 deepseek 目录自带档；
// 未指定值 '' 时 findIndex=-1 → 标题显示 '—'、滑杆不填充，与上游未选择态一致）
const selectedModel = computed(() => selectedGroup.value?.items.find(item => item.value === props.binding) ?? null);
const model = computed(() => {
  if (!selectedModel.value) return null;
  const [configId, modelId] = props.binding.split(':');
  return props.configs.find(config => config.id === configId)?.models.find(item => item.modelId === modelId && item.enabled) ?? null;
});
const sliderLevels = computed<ThoughtLevelOption[]>(() => (model.value?.thinkingLevels ?? []).map(level => ({ value: level, label: THINKING_LEVEL_LABELS[level as keyof typeof THINKING_LEVEL_LABELS] ?? level })));
const thinkingVisible = computed(() => (model.value?.thinkingLevels?.length ?? 0) > 0);
// 任务窗口覆盖为 ''（跟随设置档位）时回显模型条目的设置档位——对齐上游 ComposerModelMenu 的
// options.value=生效档位语义（打开菜单即显示当前档位），'—' 只保留给「浏览非选中分组」与
// 「条目档位不在目录级别中」两种真未选择态
const effectiveLevel = computed(() => {
  if (props.thinkingLevel) return props.thinkingLevel;
  const stored = model.value?.parameters?.thinkingLevel;
  return typeof stored === 'string' && sliderLevels.value.some(level => level.value === stored) ? stored : '';
});
// 上游单档分支不渲染滑杆也不带快捷键键帽
const showShortcut = computed(() => sliderLevels.value.length > 1);
const effortLabel = computed(() => (currentGroupSelected.value ? sliderLevels.value.find(level => level.value === effectiveLevel.value)?.label ?? '—' : '—'));
const effortDisabled = computed(() => props.disabled || props.busy);
// ZCode ComposerModelMenu.isGlmHighspeedModel：只按选中模型显示名判定
const thinkingHighspeed = computed(() => {
  const name = selectedModel.value?.name ?? '';
  return /glm/i.test(name) && /highspeed|flashx/i.test(name);
});
const triggerThoughtLabel = computed(() => {
  if (!props.binding) return '';
  return sliderLevels.value.find(level => level.value === effectiveLevel.value)?.label ?? '';
});

const id=useId();
const trigger = ref<HTMLButtonElement>();
const root = ref<HTMLElement>();
const panel = ref<HTMLElement>();
const subPanel = ref<HTMLElement>();
const providerRow = ref<HTMLButtonElement>();
const open = ref(false);
const subOpen = ref(false);
const stackedSub=ref(false);
const positioned = ref(false);
const subPositioned = ref(false);
const position = ref<CSSProperties>({});
const subPosition = ref<CSSProperties>({});
const openWidth = ref(0);
let observer: ResizeObserver | undefined;
let frame = 0;
let disposed = false;

function focusTrigger() { trigger.value?.focus({ preventScroll: true }); }
function close(restore = true) {
  if (!open.value) return;
  open.value = false;
  subOpen.value = false;
  subPositioned.value = false;
  observer?.disconnect();
  cancelAnimationFrame(frame);
  emit('open-change', false);
  if (restore) focusTrigger();
}
function mainItems() { return Array.from(panel.value?.querySelectorAll<HTMLButtonElement>('[data-choice]:not(:disabled)') ?? []); }
function subItems() { return Array.from(subPanel.value?.querySelectorAll<HTMLButtonElement>('[data-choice]:not(:disabled)') ?? []); }
function focusIn(nodes: HTMLButtonElement[], index: number) {
  const target = nodes[(index + nodes.length) % nodes.length];
  target?.focus({ preventScroll: true });
  target?.scrollIntoView({ block: 'nearest' });
}
function cycle(nodes: HTMLButtonElement[], current: Element | null, step: 1 | -1 | 'home' | 'end') {
  if (!nodes.length) return;
  if (step === 'home') { focusIn(nodes, 0); return; }
  if (step === 'end') { focusIn(nodes, nodes.length - 1); return; }
  const index = current ? nodes.indexOf(current as HTMLButtonElement) : -1;
  focusIn(nodes, index + step);
}

function viewportEdges() {
  const view = window.visualViewport;
  return {
    left: (view?.offsetLeft ?? 0) + 12,
    top: (view?.offsetTop ?? 0) + 12,
    right: (view?.offsetLeft ?? 0) + (view?.width ?? window.innerWidth) - 12,
    bottom: (view?.offsetTop ?? 0) + (view?.height ?? window.innerHeight) - 12,
  };
}
function place() {
  const anchor = trigger.value;
  const menu = panel.value;
  if (!open.value || !anchor || !menu) return;
  const rect = anchor.getBoundingClientRect();
  const edge = viewportEdges();
  const width = Math.min(288, Math.max(0, edge.right - edge.left));
  menu.style.width=`${width}px`;
  const fitted=popupLayout(rect,{left:edge.left-12,top:edge.top-12,width:edge.right-edge.left+24,height:edge.bottom-edge.top+24},{width,height:menu.scrollHeight+2,maxHeight:480,padding:12});
  position.value={width:`${fitted.width}px`,maxHeight:`${fitted.maxHeight}px`,left:`${fitted.left}px`,top:`${fitted.top}px`};
  positioned.value = true;
  if (subOpen.value) placeSub();
}
// 上游：子菜单锚定行内缘并补偿父面板 padding 后外框对齐留 4px、顶部对齐主面板（alignOffset=menu.top-row.top），
// 默认放右侧，与 collisionPadding 12 的可用空间冲突时整体翻到左侧——取"右侧放得下否则翻左"的等效定位。
function placeSub() {
  const menu = panel.value;
  const sub = subPanel.value;
  if (!open.value || !subOpen.value || !menu || !sub) return;
  const rect = menu.getBoundingClientRect();
  const edge = viewportEdges();
  const width=Math.min(288,Math.max(0,edge.right-edge.left));
  sub.style.width=`${width}px`;
  const maxHeight=Math.max(0,edge.bottom-edge.top);
  const height=Math.min(sub.scrollHeight+2,maxHeight);
  const rightSpace=edge.right-rect.right-4,leftSpace=rect.left-edge.left-4;
  stackedSub.value=Math.max(rightSpace,leftSpace)<width;
  const left=stackedSub.value?rect.left:rightSpace>=width?rect.right+4:rect.left-4-width;
  subPosition.value={width:`${width}px`,left:`${Math.max(edge.left,Math.min(left,edge.right-width))}px`,top:`${Math.max(edge.top,Math.min(rect.top,edge.bottom-height))}px`,maxHeight:`${maxHeight}px`};
  subPositioned.value = true;
}
function schedulePlace(event?: Event) {
  if (!open.value || (event?.target instanceof Node && (panel.value?.contains(event.target) || subPanel.value?.contains(event.target)))) return;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(place);
}
async function show() {
  if (props.disabled || props.busy || open.value) return;
  document.dispatchEvent(new CustomEvent('composer-picker-open', { detail: id }));
  positioned.value = false;
  subPositioned.value = false;
  openWidth.value = trigger.value?.offsetWidth ?? 0;
  open.value = true;
  emit('open-change', true);
  await nextTick();
  if (!open.value || disposed) return;
  place();
  await nextTick();
  if(!open.value||disposed)return;
  observer = observer ?? new ResizeObserver(() => schedulePlace());
  if (panel.value) observer.observe(panel.value);
  if (trigger.value) observer.observe(trigger.value);
  // Radix 初始焦点落在选中项上
  const nodes = mainItems();
  const checked = nodes.findIndex(node => node.getAttribute('aria-checked') === 'true');
  focusIn(nodes, Math.max(checked, 0));
}
async function toggleSub() {
  if (subOpen.value) { closeSub(); return; }
  subOpen.value = true;
  await nextTick();
  if (!subOpen.value) return;
  placeSub();
  await nextTick();
  if(!open.value||!subOpen.value)return;
  const nodes = subItems();
  const checked = nodes.findIndex(node => node.getAttribute('aria-checked') === 'true');
  focusIn(nodes, Math.max(checked, 0));
}
function closeSub(refocus = true) {
  subOpen.value = false;
  subPositioned.value = false;
  if (refocus) void nextTick(()=>{if(open.value)providerRow.value?.focus({ preventScroll: true });});
}
// 上游 chooseConnectionModel：优先同模型名，否则首项；无可用模型的组只浏览不选择
function chooseProvider(group: ProviderGroup) {
  if(props.disabled||props.busy)return;
  closeSub();
  if (!group.items.length) return;
  const modelId = props.binding.split(':')[1] ?? '';
  const target = group.items.find(item => item.value === `${group.key}:${modelId}`) ?? group.items[0]!;
  if (target.value !== props.binding) emit('select-model', target.value);
}
function selectModel(item: ModelItem) {
  if(props.disabled||props.busy)return;
  // 上游 composer 语义：选模型后菜单保持打开，可继续调思考档位
  if (item.value !== props.binding) emit('select-model', item.value);
}
function openSettings() {
  close(false);
  emit('open-settings');
}

function triggerKey(event: KeyboardEvent) {
  if (ignoredKeyEvent(event) || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    void show();
  }
}
function panelKey(event: KeyboardEvent) {
  event.stopPropagation();
  if (ignoredKeyEvent(event) || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'Escape') { event.preventDefault(); close(); return; }
  if (event.key === 'Tab') { close(); return; }
  const nodes = mainItems();
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    cycle(nodes, document.activeElement, event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    cycle(nodes, document.activeElement, event.key === 'Home' ? 'home' : 'end');
  } else if (event.key === 'ArrowRight' && document.activeElement === providerRow.value) {
    event.preventDefault();
    void toggleSub();
  }
}
function subPanelKey(event: KeyboardEvent) {
  event.stopPropagation();
  if (ignoredKeyEvent(event) || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'Escape' || event.key === 'ArrowLeft') { event.preventDefault(); closeSub(); return; }
  if (event.key === 'Tab') { close(); return; }
  const nodes = subItems();
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    cycle(nodes, document.activeElement, event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    cycle(nodes, document.activeElement, event.key === 'Home' ? 'home' : 'end');
  }
}
function outside(event: PointerEvent) {
  if (!open.value || !(event.target instanceof Node)) return;
  if (trigger.value?.contains(event.target) || panel.value?.contains(event.target) || subPanel.value?.contains(event.target)) return;
  const target = event.target instanceof Element ? event.target : null;
  close(!target?.closest('button, input, textarea, select, a[href], [tabindex], [contenteditable=true]'));
}
function focusOutside(event: FocusEvent) {
  if (!open.value || !(event.target instanceof Node)) return;
  if (trigger.value?.contains(event.target) || panel.value?.contains(event.target) || subPanel.value?.contains(event.target)) return;
  close(false);
}
function peerOpened(event: Event) {
  if ((event as CustomEvent<string>).detail !== id) close(false);
}
watch(() => props.disabled||props.busy, disabled => { if (disabled) close(); });
watch([groups, () => props.binding], async () => {
  await nextTick();
  if (!open.value) return;
  if (document.activeElement === document.body) {
    const nodes = mainItems();
    const checked = nodes.findIndex(node => node.getAttribute('aria-checked') === 'true');
    focusIn(nodes, Math.max(checked, 0));
  }
  place();
});
onMounted(() => {
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('focusin', focusOutside);
  document.addEventListener('composer-picker-open', peerOpened);
  window.addEventListener('resize', schedulePlace);
  window.addEventListener('scroll', schedulePlace, true);
  window.visualViewport?.addEventListener('resize', schedulePlace);
  window.visualViewport?.addEventListener('scroll', schedulePlace);
});
onBeforeUnmount(() => {
  disposed = true;
  close(false);
  observer?.disconnect();
  cancelAnimationFrame(frame);
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('focusin', focusOutside);
  document.removeEventListener('composer-picker-open', peerOpened);
  window.removeEventListener('resize', schedulePlace);
  window.removeEventListener('scroll', schedulePlace, true);
  window.visualViewport?.removeEventListener('resize', schedulePlace);
  window.visualViewport?.removeEventListener('scroll', schedulePlace);
});
defineExpose({ focusTrigger, close });
</script>

<template>
  <span ref="root" class="composer-model-menu">
    <button
      ref="trigger"
      class="composer-model-trigger"
      :class="{ 'is-open': open, 'is-empty': !binding }"
      type="button"
      :disabled="disabled||busy"
      :title="disabled ? '运行中的任务不能切换模型' : undefined"
      :aria-label="`任务模型：${selectedModel?.name ?? '选择模型'}`"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-controls="open ? 'composer-model-menu-panel' : undefined"
      :style="open ? { minWidth: `${Math.max(openWidth, 128)}px`, maxWidth: `${Math.max(openWidth, 128)}px` } : undefined"
      @click="open ? close() : show()"
      @keydown="triggerKey"
    >
      <!-- 上游打开态：触发器文案切为居中的「选择模型」占位（ComposerTriggerTransition） -->
      <span v-if="open" class="composer-model-trigger-open">选择模型</span>
      <template v-else>
        <!-- 关闭态标识位同上游按所选模型派生：有品牌→品牌图标，无→通用盒子 -->
        <ProviderMark :provider-id="selectedGroup?.providerId" :base-url="selectedGroup?.baseUrl">
          <UiIcon name="model" :size="16" />
        </ProviderMark>
        <RollingLabel class="composer-model-trigger-label" :label="selectedModel?.name ?? '选择模型'" />
        <span v-if="triggerThoughtLabel" class="composer-model-trigger-thought">{{ triggerThoughtLabel }}</span>
        <UiIcon class="composer-model-trigger-chevron" name="chevron-down" :size="14" />
      </template>
    </button>
    <Teleport to="body">
      <section
        v-if="open"
        :id="`${id}-panel`"
        ref="panel"
        class="composer-model-menu-panel"
        :inert="subOpen&&stackedSub"
        role="menu"
        aria-label="模型"
        :style="[position, { visibility: positioned ? 'visible' : 'hidden' }]"
        @keydown="panelKey"
      >
        <template v-if="hasConfigs">
          <button
            ref="providerRow"
            class="composer-model-row composer-model-provider-trigger"
            type="button"
            role="menuitem"
            data-choice
            tabindex="-1"
            :aria-expanded="subOpen"
            aria-haspopup="menu"
            @click="toggleSub"
          >
            <ProviderMark :provider-id="viewGroup?.providerId" :base-url="viewGroup?.baseUrl">
              <UiIcon name="package" :size="16" />
            </ProviderMark>
            <span class="composer-model-provider-name">{{ viewGroup?.label ?? '—' }}</span>
            <span class="composer-model-badge">{{ PROVIDER_BADGE }}</span>
            <UiIcon class="composer-model-chevron-right" name="chevron-right" :size="16" />
          </button>
          <div class="composer-model-sep" role="separator"></div>
          <div class="composer-model-label" role="presentation">模型</div>
          <div class="composer-model-list" role="group" aria-label="模型列表">
            <button
              v-for="item in viewGroup?.items ?? []"
              :key="item.value"
              class="composer-model-row composer-model-item"
              type="button"
              role="menuitemradio"
              data-choice
              tabindex="-1"
              :aria-checked="item.value === binding"
              :title="item.name"
              @click="selectModel(item)"
            >
              <span class="composer-model-copy">
                <span class="composer-model-name">{{ item.name }}</span>
                <span v-if="item.vision" class="composer-model-badge composer-model-badge-vision">视觉</span>
              </span>
              <UiIcon v-if="item.value === binding" class="composer-model-check" name="check" :size="16" />
            </button>
          </div>
          <template v-if="thinkingVisible">
            <div class="composer-model-sep" role="separator"></div>
            <div class="composer-model-effort" role="presentation">
              <ThoughtSlider
                label="思考强度"
                :levels="sliderLevels"
                :value="effectiveLevel"
                :highspeed="thinkingHighspeed"
                :disabled="effortDisabled"
                :shortcut="showShortcut ? (thinkingShortcut ?? '') : ''"
                unpadded
                @change="emit('update:thinkingLevel', $event)"
              />
            </div>
          </template>
        </template>
        <button
          v-else
          class="composer-model-row composer-model-item"
          type="button"
          role="menuitem"
          data-choice
          tabindex="-1"
          @click="openSettings"
        >
          <span class="composer-model-name">连接模型</span>
        </button>
      </section>
      <section
        v-if="open && subOpen"
        ref="subPanel"
        class="composer-model-submenu"
        role="menu"
        aria-label="供应商"
        :style="[subPosition, { visibility: subPositioned ? 'visible' : 'hidden' }]"
        @keydown="subPanelKey"
      >
        <button v-if="stackedSub" class="composer-model-row" type="button" role="menuitem" data-choice tabindex="-1" @click="closeSub()"><UiIcon name="arrow-left"/>返回模型</button>
        <button
          v-for="group in groups"
          :key="group.key"
          class="composer-model-row composer-model-item composer-model-provider"
          type="button"
          role="menuitemradio"
          data-choice
          tabindex="-1"
          :aria-checked="group.key === viewGroup?.key"
          @click="chooseProvider(group)"
        >
          <ProviderMark :provider-id="group.providerId" :base-url="group.baseUrl">
            <UiIcon name="package" :size="16" />
          </ProviderMark>
          <span class="composer-model-provider-name">{{ group.label }}</span>
          <span class="composer-model-badge">{{ PROVIDER_BADGE }}</span>
          <UiIcon v-if="group.key === viewGroup?.key" class="composer-model-check" name="check" :size="16" />
        </button>
        <div class="composer-model-sep" role="separator"></div>
        <button
          class="composer-model-row composer-model-item"
          type="button"
          role="menuitem"
          data-choice
          tabindex="-1"
          @click="openSettings"
        >
          <span class="composer-model-name">管理模型</span>
        </button>
      </section>
    </Teleport>
  </span>
</template>

<style scoped>
/* 尺寸/间距取上游：Content p-1 rounded-lg；行 min-h-8 pl-2 pr-8 gap-2 rounded-md；
   分隔线 -mx-1 my-1 h-px bg-border/50；模型列表 max-h-60；标签 px-2 py-1.5 text-ui-sm */
.composer-model-menu { display: inline-flex; align-items: center; min-width: 0; max-width: 240px; vertical-align: middle; }
.composer-model-trigger { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: flex-start; gap: 4px; width: auto; min-width: 0; max-width: 100%; height: 28px; min-height: 28px; margin: 0; padding: 0 6px 0 8px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--fg); font: 400 14px/20px var(--font-ui, sans-serif); letter-spacing: normal; text-align: left; white-space: nowrap; cursor: pointer; transition: background-color .1s, color .1s; }
.composer-model-trigger:hover:not(:disabled), .composer-model-trigger.is-open { background: var(--color-menu-hover, var(--hover)); }
.composer-model-trigger.is-empty:not(:disabled) { color: var(--fg-subtle); }
.composer-model-trigger:disabled { cursor: not-allowed; opacity: .5; }
.composer-model-trigger:focus-visible { outline: 2px solid var(--fg-subtle); outline-offset: 1px; }
.composer-model-trigger-open { flex: 1; overflow: hidden; text-overflow: ellipsis; text-align: center; color: var(--fg-subtle); }
.composer-model-trigger-label { min-width: 0; }
.composer-model-trigger-thought { flex: none; color: var(--fg-subtle); }
.composer-model-trigger-chevron { color: var(--fg-subtle); }
.composer-model-menu-panel, .composer-model-submenu { position: fixed; z-index: 1800; box-sizing: border-box; display: flex; flex-direction: column; gap: 2px; padding: 4px; border: 1px solid var(--color-popover-border, var(--border)); border-radius: 8px; background: var(--color-menu, var(--bg-panel)); color: var(--fg); font: 400 var(--text-ui-base, 14px)/20px var(--font-ui, sans-serif); letter-spacing: normal; box-shadow: 0 4px 6px -1px #0000001a, 0 2px 4px -2px #0000001a; }
.composer-model-menu-panel { width: 288px; overflow-y: hidden; }
.composer-model-submenu { min-width: 128px; width: max-content; max-width: calc(100vw - 24px); overflow-y: auto; overscroll-behavior: contain; }
.composer-model-row { box-sizing: border-box; position: relative; display: flex; align-items: center; gap: 8px; flex: none; width: 100%; min-width: 0; min-height: 32px; margin: 0; padding: 4px 32px 4px 8px; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; text-align: left; white-space: nowrap; cursor: default; }
.composer-model-row:hover, .composer-model-row:focus { background: var(--color-menu-hover, var(--hover)); outline: none; }
/* 供应商触发行 hover/展开为 menu-hover 的 50%（上游 triggerProps data-[highlighted]/data-[state=open]） */
.composer-model-provider-trigger { gap: 12px; }
.composer-model-provider-trigger:hover, .composer-model-provider-trigger:focus, .composer-model-provider-trigger[aria-expanded="true"] { background: color-mix(in srgb, var(--color-menu-hover, var(--hover)) 50%, transparent); }
.composer-model-provider-name { min-width: 0; flex: 1 1 auto; overflow: hidden; white-space: normal; overflow-wrap: anywhere; text-align: left; }
.composer-model-provider-trigger .composer-model-provider-name { white-space: nowrap; text-overflow: ellipsis; }
.composer-model-badge { flex: none; max-width: 192px; overflow: hidden; text-overflow: ellipsis; padding: 0 4px; border-radius: 9999px; background: color-mix(in srgb, var(--fg) 7%, transparent); color: var(--fg-subtle); font-size: var(--text-ui-xs, 10px); font-weight: 500; line-height: normal; }
.composer-model-badge-vision { border: 1px solid var(--border); }
.composer-model-chevron-right { margin-left: auto; color: var(--fg-subtle); }
.composer-model-sep { flex: none; height: 1px; margin: 4px -4px; background: color-mix(in srgb, var(--border) 50%, transparent); }
.composer-model-label { flex: none; padding: 6px 8px; color: var(--fg-subtle); font-size: var(--text-ui-sm, 12px); font-weight: 500; }
.composer-model-list { display: flex; flex: 0 1 auto; flex-direction: column; gap: 2px; min-height: 0; max-height: 240px; overflow-y: auto; overscroll-behavior: contain; }
.composer-model-copy { display: flex; flex: 1; align-items: center; gap: 6px; min-width: 0; }
.composer-model-name { min-width: 0; white-space:normal;overflow-wrap:anywhere;text-align:left; }
.composer-model-check { position: absolute; right: 8px; top: 8px; color: var(--fg-subtle); pointer-events: none; }
.composer-model-effort { flex: none; padding: 8px; border-radius: 6px; }
.composer-model-effort:hover { background: var(--color-menu-hover, var(--hover)); }
.composer-model-effort :deep(.composer-thought-slider[data-disabled="true"]) { opacity: .5; }
@container composer (max-width: 600px) {
  .composer-model-trigger-thought { display: none; }
}
</style>

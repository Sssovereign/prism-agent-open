<script lang="ts">
import type { UiIconName } from './UiIcon.vue';
export interface ComposerSelectOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
  icon?: UiIconName;
  disabled?: boolean;
}
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import type { CSSProperties } from 'vue';
import UiIcon from './UiIcon.vue';
import {popupLayout} from '../ui/popupLayout';

// Presentation only: values belong to the owner. No synthetic value is emitted on open/filter.
const props = withDefaults(defineProps<{
  value: string;
  options: readonly ComposerSelectOption[];
  label: string;
  placeholder?: string;
  triggerLabel?: string;
  icon?: UiIconName;
  disabled?: boolean;
  title?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  width?: number;
  compact?: boolean;
  warning?: boolean;
  actionLabel?: string;
  actionIcon?: UiIconName;
  note?: string;
  variant?: 'ghost'|'field';
  iconOnly?: boolean;
  actionMode?: boolean;
}>(), { placeholder: '请选择', searchable: false, searchPlaceholder: '搜索…', emptyText: '没有匹配的选项', width: 256, compact: false, warning: false });
const emit = defineEmits<{
  (e: 'change', value: string): void;
  (e: 'action'): void;
  (e: 'open-change', open: boolean): void;
}>();
const id = useId();
const trigger = ref<HTMLButtonElement>();
const panel = ref<HTMLElement>();
const search = ref<HTMLInputElement>();
const open = ref(false);
const query = ref('');
const positioned = ref(false);
const position = ref<CSSProperties>({});
const selected = computed(() => props.options.find(option => option.value === props.value));
const displayLabel = computed(() => props.triggerLabel ?? selected.value?.label ?? props.placeholder);
const visible = computed(() => {
  const term = query.value.trim().toLocaleLowerCase();
  // Include visible group names and descriptions in search, without changing the value.
  return props.options.filter(option => [option.label,option.description,option.group].filter(Boolean).join(' ').toLocaleLowerCase().includes(term));
});
let observer: ResizeObserver | undefined;
let frame = 0;
let disposed = false;
let typed='',typedAt=0;

function focusTrigger() { trigger.value?.focus({ preventScroll: true }); }
function close(restore = true) {
  if (!open.value) return;
  open.value = false;
  observer?.disconnect();
  cancelAnimationFrame(frame);
  emit('open-change', false);
  // Synchronous restoration: a subsequently opened dialog must own the next focus.
  if (restore) focusTrigger();
}
function items() { return Array.from(panel.value?.querySelectorAll<HTMLButtonElement>('[data-choice]:not(:disabled)') ?? []); }
function focusItem(index: number) {
  const nodes = items();
  const target = nodes[(index + nodes.length) % nodes.length];
  target?.focus({ preventScroll: true });
  target?.scrollIntoView({ block: 'nearest' });
}
function place() {
  const anchor = trigger.value;
  const menu = panel.value;
  if (!open.value || !anchor || !menu) return;
  const rect = anchor.getBoundingClientRect();
  const viewport = window.visualViewport;
  const view={left:viewport?.offsetLeft??0,top:viewport?.offsetTop??0,width:viewport?.width??window.innerWidth,height:viewport?.height??window.innerHeight};
  if(rect.bottom<view.top||rect.top>view.top+view.height||rect.right<view.left||rect.left>view.left+view.width){close(false);return;}
  for(let parent=anchor.parentElement;parent&&parent!==document.body;parent=parent.parentElement){const style=getComputedStyle(parent),bounds=parent.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(style.overflowY)&&(rect.bottom<=bounds.top||rect.top>=bounds.bottom)){close(false);return;}}
  const width=Math.min(props.variant==='field'?Math.max(props.width,rect.width):props.width,Math.max(0,view.width-16));
  menu.style.width=`${width}px`;
  const fitted=popupLayout(rect,view,{width,height:menu.scrollHeight+2});
  position.value={width:`${fitted.width}px`,maxHeight:`${fitted.maxHeight}px`,left:`${fitted.left}px`,top:`${fitted.top}px`};
  positioned.value = true;
}
function schedulePlace(event?: Event) {
  if (!open.value || (event?.target instanceof Node && panel.value?.contains(event.target))) return;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(place);
}
async function show(edge?: 'first' | 'last') {
  if (props.disabled || open.value) return;
  // Peer menus close without stealing focus; works across multiple permission controls in Settings.
  document.dispatchEvent(new CustomEvent('composer-picker-open', { detail: id }));
  query.value = '';
  typed='';typedAt=0;
  positioned.value = false;
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
  if (props.searchable && !edge) search.value?.focus({ preventScroll: true });
  else {
    const nodes = items();
    const checked = nodes.findIndex(node => node.getAttribute('aria-checked') === 'true');
    if(nodes.length)focusItem(edge === 'last' ? nodes.length - 1 : edge === 'first' ? 0 : Math.max(checked, 0));
    else panel.value?.focus({preventScroll:true});
  }
}
function select(option: ComposerSelectOption) {
  if (props.disabled || option.disabled || !props.options.some(item => item.value === option.value && !item.disabled)) return;
  close();
  emit('change', option.value);
}
function action() {
  if (props.disabled) return;
  close();
  emit('action');
}
function triggerKey(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation();
    void show(event.key === 'ArrowDown' ? 'first' : 'last');
  }
}
function panelKey(event: KeyboardEvent) {
  // Do not leak Escape into Settings' dialog or Enter into the task composer.
  event.stopPropagation();
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Escape') { event.preventDefault(); close(); return; }
  // Restore the logical tab origin before the browser performs normal traversal; never select on Tab.
  if (event.key === 'Tab') { close(); return; }
  const inSearch = event.target === search.value;
  const nodes = items();
  const index = nodes.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    focusItem(inSearch ? (event.key === 'ArrowDown' ? 0 : nodes.length - 1) : index + (event.key === 'ArrowDown' ? 1 : -1));
  } else if (!inSearch && (event.key === 'Home' || event.key === 'End')) {
    event.preventDefault();
    focusItem(event.key === 'Home' ? 0 : nodes.length - 1);
  } else if (inSearch && event.key === 'Enter') {
    event.preventDefault();
    const first = visible.value.find(option => !option.disabled);
    if (first) select(first);
  } else if (!inSearch && props.searchable && event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    query.value += event.key;
    search.value?.focus();
  } else if(!inSearch&&!props.searchable&&event.key.length===1&&event.key!==' '&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
    event.preventDefault();const now=Date.now();typed=now-typedAt<700?typed+event.key:event.key;typedAt=now;
    const prefix=([...typed].every(ch=>ch===typed[0])?typed[0]!:typed).toLocaleLowerCase();
    const matches=nodes.map((node,i)=>({node,i})).filter(({node})=>node.textContent?.trim().toLocaleLowerCase().startsWith(prefix));
    const next=matches.find(({i})=>i>index)??matches[0];if(next)focusItem(next.i);
  }
}
function outside(event: PointerEvent) {
  if (!open.value || !(event.target instanceof Node) || trigger.value?.contains(event.target) || panel.value?.contains(event.target)) return;
  const target = event.target instanceof Element ? event.target : null;
  close(!target?.closest('button, input, textarea, select, a[href], [tabindex], [contenteditable=true]'));
}
function focusOutside(event: FocusEvent) {
  if (open.value && event.target instanceof Node && !trigger.value?.contains(event.target) && !panel.value?.contains(event.target)) close(false);
}
function peerOpened(event: Event) { if ((event as CustomEvent<string>).detail !== id) close(false); }
watch(() => props.disabled, disabled => { if (disabled) close(); });
watch([visible, () => props.actionLabel, () => props.width], async () => {
  await nextTick();
  if (!open.value) return;
  // A filtered/deleted focused option must not leave keyboard focus on body.
  if (document.activeElement === document.body) {
    if (props.searchable) search.value?.focus();
    else focusItem(0);
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
  <span class="composer-select" :class="{ 'is-compact': compact,'is-field':variant==='field','is-icon-only':iconOnly }">
    <button :id="`${id}-trigger`" ref="trigger" class="composer-select-trigger" :class="{ 'is-warning': warning }" type="button" :disabled="disabled" :title="title || (actionMode ? label : displayLabel)" :aria-label="actionMode ? label : `${label}：${displayLabel}`" :aria-haspopup="searchable ? 'dialog' : 'menu'" :aria-expanded="open" :aria-controls="open ? `${id}-panel` : undefined" @click="open ? close() : show()" @keydown="triggerKey">
      <slot name="leading"><UiIcon v-if="icon" :name="icon" /></slot>
      <span class="composer-select-label">{{ displayLabel }}</span>
      <UiIcon class="composer-select-chevron" name="chevron-down" :size="14" />
    </button>
    <Teleport to="body">
      <section v-if="open" :id="`${id}-panel`" ref="panel" class="composer-select-panel" :class="{ 'has-search': searchable }" :role="searchable ? 'dialog' : 'menu'" :aria-label="label" tabindex="-1" :style="[position, { visibility: positioned ? 'visible' : 'hidden' }]" @keydown="panelKey">
        <div v-if="searchable" class="composer-select-search">
          <UiIcon name="search" />
          <input ref="search" v-model="query" type="text" role="searchbox" :aria-label="searchPlaceholder" :aria-controls="`${id}-items`" :placeholder="searchPlaceholder" autocomplete="off" spellcheck="false" />
        </div>
        <div :id="`${id}-items`" class="composer-select-items" :role="searchable ? 'menu' : undefined" :aria-label="searchable ? label : undefined">
          <template v-for="(option, index) in visible" :key="option.value">
            <div v-if="option.group && (index === 0 || option.group !== visible[index - 1]?.group)" class="composer-select-group" role="presentation">{{ option.group }}</div>
            <button class="composer-select-option" :class="{ 'is-rich': option.description }" type="button" :role="actionMode?'menuitem':'menuitemradio'" :aria-checked="actionMode?undefined:option.value === value" :disabled="option.disabled" :title="[option.label, option.description].filter(Boolean).join(' · ')" tabindex="-1" data-choice @click="select(option)">
              <slot name="option-leading" :option="option"><UiIcon v-if="option.icon" :name="option.icon" :size="option.description ? 18 : 16" /></slot>
              <span class="composer-select-copy"><span class="composer-select-option-label">{{ option.label }}</span><span v-if="option.description" class="composer-select-description">{{ option.description }}</span></span>
              <UiIcon v-if="option.value === value" class="composer-select-check" name="check" :size="16" />
            </button>
          </template>
          <p v-if="!visible.length" class="composer-select-empty" role="status">{{ emptyText }}</p>
        </div>
        <!-- ZCode ComposerModelMenu：模型列表与思考强度滑杆等自定义区块之间用分隔线隔开 -->
        <div v-if="$slots.footer" class="composer-select-extra" role="presentation"><slot name="footer" /></div>
        <div v-if="actionLabel" class="composer-select-footer" :role="searchable ? 'menu' : undefined" :aria-label="searchable ? '更多操作' : undefined">
          <button class="composer-select-action" type="button" role="menuitem" tabindex="-1" data-choice @click="action"><UiIcon v-if="actionIcon" :name="actionIcon" /><span>{{ actionLabel }}</span></button>
        </div>
        <p v-if="note" class="composer-select-note">{{ note }}</p>
      </section>
    </Teleport>
  </span>
</template>

<style scoped>
.composer-select { display: inline-flex; align-items: center; min-width: 0; max-width: 240px; vertical-align: middle; }
.composer-select-trigger { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: space-between; gap: 4px; width: auto; min-width: 0; max-width: 100%; height: 28px; min-height: 28px; margin: 0; padding: 0 6px 0 8px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--fg); font: 400 var(--ui-font-size,14px)/1.5 var(--font-ui, sans-serif); letter-spacing: normal; text-align: left; white-space: nowrap; cursor: pointer; transition: background-color .1s, color .1s; }
.composer-select-trigger:hover:not(:disabled), .composer-select-trigger[aria-expanded=true] { background: var(--hover); }
.composer-select-trigger.is-warning { color: var(--warning); background: transparent; }
.composer-select-trigger.is-warning:hover:not(:disabled), .composer-select-trigger.is-warning[aria-expanded=true] { background: var(--hover); color: var(--warning); }
.composer-select-trigger:disabled { cursor: not-allowed; opacity: .5; }
.composer-select-trigger:focus-visible { outline: 2px solid var(--fg-subtle); outline-offset: 1px; }
.composer-select-label { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.composer-select-chevron { color: var(--fg-subtle); }
.composer-select-panel { position: fixed; z-index: 1800; box-sizing: border-box; display: flex; flex-direction: column; min-width: 0; overflow: auto; overscroll-behavior: contain; padding: 4px; border: 1px solid var(--color-popover-border, var(--border)); border-radius: 8px; background: var(--color-menu, var(--bg-panel)); color: var(--fg); font: 400 var(--ui-font-size,14px)/1.5 var(--font-ui, sans-serif); letter-spacing: normal; box-shadow: 0 4px 6px -1px #0000001a, 0 2px 4px -2px #0000001a; }
.composer-select-panel.has-search { padding: 0; }
.composer-select-search { display: flex; align-items: center; gap: 8px; flex: none; height: 41px; padding: 4px 12px; border-bottom: 1px solid var(--border); color: var(--fg-subtlest); }
.composer-select-search input { display: block; width: 100%; min-width: 0; height: 32px; margin: 0; padding: 0; border: 0; border-radius: 0; background: transparent; color: var(--fg); font: inherit; outline: none; box-shadow: none; }
.composer-select-search:focus-within { box-shadow: inset 0 -1px var(--border-hover); }
.composer-select-search input::placeholder { color: var(--fg-subtlest); }
.composer-select-items { display: flex; flex: 0 1 auto; min-height: 0; flex-direction: column; gap: 2px; max-height: 300px; overflow-y: auto; overscroll-behavior: contain; }
.has-search .composer-select-items { padding: 4px; max-height: 240px; }
.composer-select-group { flex: none; padding: 6px 8px; overflow-wrap:anywhere;white-space:normal; color: var(--fg-subtlest); font-size: 12px; line-height: 18px; }
.composer-select-option, .composer-select-action { box-sizing: border-box; position: relative; display: flex; align-items: center; gap: 8px; flex: none; width: 100%; min-width: 0; min-height: 32px; margin: 0; padding: 6px 32px 6px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--fg); font: inherit; text-align: left; cursor: pointer; }
.composer-select-option.is-rich { min-height: 52px; gap: 12px; align-items: flex-start; padding-top: 8px; padding-bottom: 8px; }
.composer-select-option.is-rich .composer-select-option-label { line-height: 18px; }
.composer-select-option.is-rich > .ui-icon { margin-top: 2px; }
.composer-select-copy { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.composer-select-option-label { overflow-wrap:anywhere;white-space:normal; font-weight: 400; }
.composer-select-description { overflow-wrap:anywhere;white-space:normal; color: var(--fg-subtle); font-size: 12px; line-height: 16px; }
.composer-select-check { position: absolute; right: 8px; top: 8px; color: var(--fg-subtle); }
.composer-select-option:hover:not(:disabled), .composer-select-option:focus, .composer-select-action:hover, .composer-select-action:focus { background: var(--color-menu-hover, var(--hover)); outline: none; }
.composer-select-option:focus-visible, .composer-select-action:focus-visible { outline: 1px solid var(--border-hover); outline-offset: -1px; }
.composer-select-option:disabled { opacity: .5; cursor: not-allowed; }
.composer-select-footer { flex: none; padding: 4px 0 0; margin-top: 4px; border-top: 1px solid var(--border); }
.composer-select-extra { flex: none; margin-top: 4px; padding-top: 4px; border-top: 1px solid color-mix(in srgb, var(--border) 50%, transparent); }
.has-search .composer-select-footer { margin-top: 0; padding: 4px; }
.composer-select-action { padding-right: 8px; }
.composer-select-empty, .composer-select-note { margin: 0; padding: 8px; color: var(--fg-subtle); font-size: 12px; line-height: 18px; }
.composer-select-note { flex: none; margin-top: 4px; border-top: 1px solid var(--border); }
.composer-select.is-field{display:flex;width:100%;max-width:none;}
.is-field .composer-select-trigger{width:100%;height:auto;min-height:32px;padding:5px 9px;border-color:var(--border);border-radius:7px;background:var(--bg-input);}
.is-icon-only .composer-select-trigger{width:28px;padding:0;justify-content:center;}
.is-icon-only .composer-select-label,.is-icon-only .composer-select-chevron{display:none;}
@container composer (max-width: 600px) {
  .is-compact .composer-select-trigger { width: 28px; padding: 0; justify-content: center; }
  .is-compact .composer-select-label, .is-compact .composer-select-chevron { display: none; }
}
</style>

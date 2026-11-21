<script setup lang="ts">
// 块E3：触发建议浮层——按 ZCode a9fe401 mentions/components/MentionPanel.tsx 视觉逐值复刻（React→Vue）。
// 上游用 @tanstack/react-virtual 虚拟化；本面板候选规模小（命令≤内置数＋技能≤64＋单目录文件），
// 直接渲染全部行＋scrollIntoView 对齐选中项，max-h-56 滚动容器行为一致；虚拟化为声明差异。
import { ref, watch, nextTick } from 'vue';

export interface MentionPanelOption {
  id: string;
  label: string;
  description: string;
  meta?: string;
  /** 禁选态：可见但不可点击，键盘导航由上层跳过。 */
  disabled?: boolean;
  disabledReason?: string;
}
export interface MentionPanelSection {
  id: string;
  title: string;
  options: MentionPanelOption[];
  emptyText: string;
  loadingText?: string;
  loading?: boolean;
  errorText?: string | null;
  /** 项目名称在单组搜索结果中也需要可见。 */
  showHeader?: boolean;
}

const props = defineProps<{
  title: string;
  description: string;
  trigger: string;
  sections: MentionPanelSection[];
  emptyText: string;
  selectedIndex: number;
  hasActiveQuery: boolean;
  listMaxHeight?: string;
}>();
const emit = defineEmits<{ (e: 'select', index: number): void }>();

const listEl = ref<HTMLDivElement | null>(null);
const hoveredOptionIndex = ref<number | null>(null);

interface FlatRow {
  kind: 'section_header' | 'status' | 'option';
  sectionId: string;
  title?: string;
  statusText?: string;
  statusContent?: 'loading' | 'error' | 'empty';
  option?: MentionPanelOption;
  flatOptionIndex?: number;
}
function buildRows(sections: MentionPanelSection[]): FlatRow[] {
  const rows: FlatRow[] = [];
  let flatOptionIndex = 0;
  const shouldRenderSectionHeader = sections.length > 1;
  for (const section of sections) {
    if ((shouldRenderSectionHeader || section.showHeader) && section.title.trim().length > 0) {
      rows.push({ kind: 'section_header', sectionId: section.id, title: section.title });
    }
    if (section.errorText) {
      rows.push({ kind: 'status', sectionId: section.id, statusContent: 'error', statusText: section.errorText });
    } else if (section.loading) {
      rows.push({ kind: 'status', sectionId: section.id, statusContent: 'loading', statusText: section.loadingText ?? section.emptyText });
    } else if (section.options.length === 0) {
      rows.push({ kind: 'status', sectionId: section.id, statusContent: 'empty', statusText: section.emptyText });
    } else {
      for (const option of section.options) {
        rows.push({ kind: 'option', sectionId: section.id, option, flatOptionIndex });
        flatOptionIndex += 1;
      }
    }
  }
  return rows;
}

watch(() => props.selectedIndex, async () => {
  await nextTick();
  const container = listEl.value;
  const selected = container?.querySelector<HTMLElement>('[data-selected="true"]');
  if (container && selected) {
    // align:"auto" 语义：选中项在视区外时最小滚动量对齐
    const top = selected.offsetTop;
    const bottom = top + selected.offsetHeight;
    if (top < container.scrollTop) container.scrollTop = top;
    else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight;
  }
});

function onOptionMouseDown(disabled: boolean | undefined, index: number | undefined, event: MouseEvent): void {
  event.preventDefault();
  if (disabled || index === undefined) return;
  emit('select', index);
}
</script>

<template>
  <div class="mention-panel" :data-trigger="trigger">
    <div v-if="buildRows(sections).length" ref="listEl" class="mention-list" :style="listMaxHeight?{maxHeight:listMaxHeight}:undefined" role="listbox" :aria-label="title" @mouseleave="hoveredOptionIndex = null">
      <template v-for="(row, i) in buildRows(sections)" :key="`${row.kind}:${row.sectionId}:${i}`">
        <div v-if="row.kind === 'section_header'" class="mention-section-header">{{ row.title }}</div>
        <div v-else-if="row.kind === 'status'" class="mention-status" :class="`is-${row.statusContent}`" :data-status="row.statusContent">
          <template v-if="row.statusContent === 'loading'"><span class="mention-spinner" aria-hidden="true"></span><span>{{ row.statusText }}</span></template>
          <template v-else>{{ row.statusText }}</template>
        </div>
        <div v-else class="mention-option-wrap">
          <button
            type="button" role="option" class="mention-option"
            :aria-selected="row.flatOptionIndex === selectedIndex"
            :aria-disabled="row.option?.disabled === true"
            :disabled="row.option?.disabled === true"
            :data-option-id="row.option?.id" :data-option-index="row.flatOptionIndex"
            :data-selected="row.flatOptionIndex === selectedIndex ? 'true' : 'false'"
            :class="{ 'is-selected': row.flatOptionIndex === selectedIndex, 'is-hovered': row.flatOptionIndex === hoveredOptionIndex }"
            @mousedown="onOptionMouseDown(row.option?.disabled, row.flatOptionIndex, $event)"
            @mouseenter="hoveredOptionIndex = row.option?.disabled ? null : row.flatOptionIndex ?? null"
          >
            <slot name="option" :option="row.option" :index="row.flatOptionIndex"><span class="mention-option-label">{{ row.option?.label }}</span>
            <span v-if="row.option?.meta" class="mention-option-meta">{{ row.option.meta }}</span>
            <span class="mention-option-desc">{{ row.option?.disabled ? row.option?.disabledReason : row.option?.description }}</span></slot>

          </button>
        </div>
      </template>
    </div>
    <div v-else-if="hasActiveQuery && emptyText" class="mention-panel-empty">{{ emptyText }}</div>
    <slot v-if="!hasActiveQuery" name="footer" />
    <div v-if="!hasActiveQuery && description" class="mention-panel-desc">{{ description }}</div>
  </div>
</template>

<style scoped>
/* 逐值对照上游 MentionPanel.tsx：rounded-2xl/border/bg-menu/shadow-xs 容器；max-h-56 滚动区
   px-1 py-0.75；分节标题 h-8 px-3 semibold uppercase tracking-wide；选项行 h-8 rounded-xl px-3 gap-3；
   状态行 px-5 py-2。颜色走既有语义变量（--color-menu/--selected/--hover 等）。 */
.mention-panel { margin-bottom: 4px; overflow: hidden; border: 1px solid var(--border); border-radius: 16px; background: var(--color-menu); box-shadow: 0 1px 2px rgb(0 0 0 / 6%); }
.mention-list { max-height: 224px; overflow-y: auto; padding: 3px 4px; overscroll-behavior: contain; }
.mention-section-header { display: flex; height: 32px; align-items: center; padding: 0 12px; font-size: var(--text-ui-base); font-weight: 600; text-transform: uppercase; letter-spacing: .025em; color: var(--fg-subtle); }
.mention-status { display: flex; align-items: center; gap: 8px; padding: 8px 20px; font-size: var(--text-ui-base); color: var(--fg-subtle); }
.mention-status.is-error { border-radius: 12px; background: var(--danger); color: var(--color-destructive-foreground); }
.mention-status.is-empty { border-radius: 12px; color: var(--fg-subtlest); }
.mention-spinner { width: 14px; height: 14px; flex: none; border: 2px solid var(--border); border-top-color: var(--fg-subtle); border-radius: 999px; animation: mention-spin .8s linear infinite; }
@keyframes mention-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .mention-spinner { animation-duration: 0s; } }
.mention-option-wrap { padding: 1px 0; width: 100%; }
.mention-option { display: flex; height: 32px; width: 100%; align-items: center; gap: 12px; padding: 0 12px; border: 0; border-radius: 12px; background: transparent; color: var(--fg); text-align: left; font: 400 var(--text-ui-base)/20px var(--font-ui); cursor: pointer; transition: background-color .1s; min-width: 0; }
.mention-option.is-selected { background: var(--selected); }
.mention-option.is-hovered { background: var(--hover); }
.mention-option:disabled { cursor: not-allowed; opacity: .5; }
.mention-option-label { flex: 0 1 auto; min-width: 0; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-ui-base); font-weight: 500; color: var(--fg); }
.mention-option-meta { flex: none; font-size: var(--text-ui-xs); color: var(--fg-subtlest); }
/* slash 面板内容变体（上游 slashCommandPanelSections custom content）：
   label max-w-[40%] medium ＋ 描述 flex-1 truncate base subtlest。 */
.mention-option-desc { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-ui-base); color: var(--fg-subtlest); }
.mention-panel-empty { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; font-size: var(--text-ui-base); color: var(--fg-subtlest); }
.mention-panel-desc { display: flex; align-items: center; gap: 8px; padding: 12px 16px; font-size: var(--text-ui-base); color: var(--fg-subtle); }
</style>

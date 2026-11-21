<script setup lang="ts">
// ZCode TaskSearchDialog + quickpick/quickPickStyles + quickpick/HighlightedMatchText 复刻：
// 侧栏「搜索」按钮 + 命令面板弹窗；空查询=近期任务，查询=服务端标题/正文片段搜索
// （GET /api/v1/tasks/search 与上游 taskSearch 服务语义一致：片段 ≤3 折叠、结果 ≤9、⌘数字直达）。
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { v1 } from '../api';
import type { SidebarTask } from '../view-model/sidebar';
import SidebarIcon from './SidebarIcon.vue';
import UiIcon from './UiIcon.vue';
import {formatShortcut,ignoredKeyEvent,plainKey,matchesShortcut} from '../keyboardShortcuts';

const RESULT_LIMIT = 9, SNIPPET_LIMIT = 3;

interface SearchTask { id: string; runId: string; projectId: string; title: string; updatedAt: string; searchSnippets?: string[] }
interface Row { key: string; task: SearchTask; kind: 'task' | 'snippet' | 'expand'; snippet?: string; snippetIndex?: number; hiddenSnippetCount?: number; showTaskHeader: boolean }
interface Segment { text: string; mark: boolean }

const props = defineProps<{ shortcut?: string; projects: Array<{ id: string; name: string }>; recentTasks: SidebarTask[] }>();
const emit = defineEmits<{ (e: 'open-task', task: { runId: string; projectId: string }): void; (e: 'modal-change', value: boolean): void }>();

const open = ref(false), query = ref(''), loading = ref(false);
const expandedTaskKeys = ref(new Set<string>());
const remoteTasks = ref<SearchTask[]>([]);
const listEl = ref<HTMLElement>(), inputEl = ref<HTMLInputElement>();
const activeIndex = ref(0);
let requestFlight = 0, debounceTimer: ReturnType<typeof setTimeout> | undefined, previousFocus: HTMLElement | null = null;

const trimmed = computed(() => query.value.trim());
const hasQuery = computed(() => trimmed.value.length > 0);
// ZCode isAppleKeyboardPlatform：主修饰键按平台隔离（macOS=⌘，其余=Ctrl；Ctrl+⌘ 同按不算主快捷键）。
const shortcutLabel = (key: string) => formatShortcut(`Mod+${key}`);

function taskTitle(task: SearchTask) { return task.title.trim() || '新任务'; }
// normalizeSnippetForDedupe / getUniqueTaskSearchSnippets（TaskSearchDialog.tsx）。
function normalizeSnippet(snippet: string) { return snippet.replace(/^\.\.\./, '').replace(/\.\.\.$/, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase(); }
function uniqueSnippets(task: SearchTask): string[] {
	const seen = new Set<string>();
	return task.searchSnippets?.filter(s => { const n = normalizeSnippet(s); if (!n || seen.has(n))return false; seen.add(n); return true; }) ?? [];
}
const taskList = computed<SearchTask[]>(() => hasQuery.value ? remoteTasks.value : props.recentTasks.filter(t => !t.archivedAt));
const projectLabel = (projectId: string) => props.projects.find(p => p.id === projectId)?.name ?? '项目';

// visibleResults（TaskSearchDialog.tsx）：任务行 / 片段行（≤3 折叠）/ 展开行，未展开时全局截到 9 行。
const rows = computed<Row[]>(() => {
	const result: Row[] = [];
	for (const task of taskList.value) {
		const taskKey = task.id;
		const snippets = hasQuery.value ? uniqueSnippets(task) : [];
		if (snippets.length === 0) {
			result.push({ key: taskKey, task, kind: 'task', showTaskHeader: true });
		} else {
			const isExpanded = expandedTaskKeys.value.has(taskKey);
			const visible = isExpanded ? snippets : snippets.slice(0, SNIPPET_LIMIT);
			visible.forEach((snippet, snippetIndex) => result.push({ key: `${taskKey}:${snippetIndex}`, task, kind: 'snippet', snippet, snippetIndex, showTaskHeader: snippetIndex === 0 }));
			if (!isExpanded && snippets.length > SNIPPET_LIMIT)result.push({ key: `${taskKey}:expand`, task, kind: 'expand', hiddenSnippetCount: snippets.length - SNIPPET_LIMIT, showTaskHeader: false });
		}
		if (!expandedTaskKeys.value.has(taskKey) && result.length >= RESULT_LIMIT)break;
	}
	return expandedTaskKeys.value.size > 0 ? result : result.slice(0, RESULT_LIMIT);
});
const emptyLabel = computed(() => loading.value ? '正在搜索…' : hasQuery.value ? '没有找到相关任务' : '暂无近期任务');

// formatTaskRelativeTime（lib/taskListItemPresentation）。
function relative(iso: string) {
	const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60000);
	if (!Number.isFinite(minutes))return '';
	if (minutes < 1)return '刚刚';
	if (minutes < 60)return `${minutes}分`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24)return `${hours}小时`;
	return `${Math.floor(hours / 24)}天`;
}
// HighlightedMatchText：查询按空白分词去重、全部命中区间排序合并后逐段渲染 mark。
function segments(text: string, query: string): Segment[] {
	const parts = [...new Set(query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean))];
	if (!parts.length || !text.length)return [{ text, mark: false }];
	const lower = text.toLocaleLowerCase();
	const ranges: Array<{ start: number; end: number }> = [];
	for (const part of parts)for (let at = lower.indexOf(part); at >= 0; at = lower.indexOf(part, at + part.length))ranges.push({ start: at, end: at + part.length });
	ranges.sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: Array<{ start: number; end: number }> = [];
	for (const range of ranges) {
		const last = merged.at(-1);
		if (!last || range.start > last.end)merged.push({ ...range });
		else last.end = Math.max(last.end, range.end);
	}
	const result: Segment[] = [];
	let cursor = 0;
	for (const range of merged) {
		if (cursor < range.start)result.push({ text: text.slice(cursor, range.start), mark: false });
		result.push({ text: text.slice(range.start, range.end), mark: true });
		cursor = range.end;
	}
	if (cursor < text.length)result.push({ text: text.slice(cursor), mark: false });
	return result;
}
function selectRow(row: Row | undefined) {
	if (!row)return;
	if (row.kind === 'expand') { expandedTaskKeys.value = new Set(expandedTaskKeys.value).add(row.task.id); return; }
	selectTask(row.task);
}
function selectTask(task: SearchTask) {
	close();
	emit('open-task', { runId: task.runId, projectId: task.projectId });
}
function onDialogKeydown(event: KeyboardEvent) {
	if (ignoredKeyEvent(event) || !plainKey(event))return;
	if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
		event.preventDefault();
		const total = rows.value.length;
		if (!total)return;
		activeIndex.value = (activeIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + total) % total;
		void nextTick(() => listEl.value?.querySelector('[data-selected=true]')?.scrollIntoView({ block: 'nearest' }));
	} else if (event.key === 'Enter' && (event.target as HTMLElement)?.classList.contains('tsq-input')) {
		event.preventDefault();
		selectRow(rows.value[activeIndex.value]);
	} else if (event.key === 'Escape') {
		event.preventDefault();
		if (query.value) { query.value = ''; void nextTick(() => inputEl.value?.focus()); }
		else close();
	}
}
// ⌘1..9 直达结果行（matchesPrimaryShortcut：平台主修饰键、无 Shift/Alt、key 或 Digit code 命中）。
function onWindowKeydown(event: KeyboardEvent) {
	if (!open.value || ignoredKeyEvent(event))return;
	const index = rows.value.findIndex((_, i) => i < 9 && matchesShortcut(event, `Mod+${i + 1}`));
	if (index >= 0) { event.preventDefault(); selectRow(rows.value[index]); }
}
function close() {
	open.value = false;
	if (previousFocus?.isConnected)previousFocus.focus();
	previousFocus = null;
}
function openDialog() {
	previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	query.value = ''; expandedTaskKeys.value = new Set(); activeIndex.value = 0;
	open.value = true;
	void nextTick(() => inputEl.value?.focus());
}
watch(open, value => emit('modal-change', value));
// 查询防抖后走服务端搜索；查询变化时清空展开态（TaskSearchDialog.tsx 同款）。
watch(trimmed, value => {
	expandedTaskKeys.value = new Set();
	activeIndex.value = 0;
	if (debounceTimer)clearTimeout(debounceTimer);
	if (!value) { remoteTasks.value = []; loading.value = false; requestFlight++; return; }
	loading.value = true;
	debounceTimer = setTimeout(async () => {
		const flight = ++requestFlight;
		try {
			const data = await v1<{ items: SearchTask[] }>(`/api/v1/tasks/search?q=${encodeURIComponent(value)}&limit=${RESULT_LIMIT}`);
			if (flight === requestFlight) { remoteTasks.value = data.items; loading.value = false; }
		} catch { if (flight === requestFlight) { remoteTasks.value = []; loading.value = false; } }
	}, 250);
});
watch(rows, () => { if (activeIndex.value >= rows.value.length)activeIndex.value = Math.max(0, rows.value.length - 1); });
onMounted(() => window.addEventListener('keydown', onWindowKeydown));
onUnmounted(() => { window.removeEventListener('keydown', onWindowKeydown); if (debounceTimer)clearTimeout(debounceTimer); emit('modal-change', false); });
defineExpose({ openDialog });
</script>

<template>
<button class="sb-search" type="button" aria-haspopup="dialog" @click="openDialog">
	<SidebarIcon name="search" :size="16"/><span class="sb-search-label">搜索</span><kbd v-if="shortcut">{{formatShortcut(shortcut)}}</kbd>
</button>
<Teleport to="body">
	<div v-if="open" class="tsq-overlay" @pointerdown.self="close">
		<section class="tsq-panel" role="dialog" aria-modal="true" aria-labelledby="tsq-title" @keydown="onDialogKeydown">
			<h2 id="tsq-title" class="tsq-sr-only">搜索任务</h2>
			<p class="tsq-sr-only">按标题或内容搜索近期任务。</p>
			<div class="tsq-command">
				<div class="tsq-input-row">
					<SidebarIcon class="tsq-input-icon" name="search" :size="16"/>
					<input ref="inputEl" v-model="query" class="tsq-input" type="text" aria-label="搜索任务" placeholder="搜索任务" autocomplete="off" spellcheck="false">
				</div>
				<div ref="listEl" class="tsq-list" role="listbox" aria-label="近期任务">
					<div class="tsq-heading" role="presentation">近期任务</div>
					<template v-if="rows.length===0">
						<p class="tsq-empty" role="status">{{emptyLabel}}</p>
					</template>
					<template v-else v-for="(row,i) in rows" :key="row.key">
						<button v-if="row.showTaskHeader&&row.snippet!==undefined" type="button" class="tsq-task-header" @click="selectTask(row.task)">
							<span class="tsq-task-title"><template v-for="(seg,si) in segments(taskTitle(row.task),trimmed)" :key="si"><mark v-if="seg.mark" class="tsq-mark">{{seg.text}}</mark><template v-else>{{seg.text}}</template></template></span>
							<span class="tsq-meta">{{projectLabel(row.task.projectId)}}</span>
							<span class="tsq-time">{{relative(row.task.updatedAt)}}</span>
						</button>
						<button type="button" role="option" class="tsq-item" :class="{'tsq-item-expand':row.kind==='expand'}" :aria-selected="i===activeIndex" :data-selected="i===activeIndex||undefined" @mousemove="activeIndex=i" @click="selectRow(row)">
							<template v-if="row.kind==='expand'">
								<UiIcon class="tsq-expand-chevron" name="chevron-down" :size="14"/><span class="tsq-expand-label">展开另外 {{row.hiddenSnippetCount}} 个片段</span>
							</template>
							<template v-else-if="row.snippet!==undefined">
								<span class="tsq-snippet"><template v-for="(seg,si) in segments(row.snippet,trimmed)" :key="si"><mark v-if="seg.mark" class="tsq-mark">{{seg.text}}</mark><template v-else>{{seg.text}}</template></template></span>
							</template>
							<template v-else>
								<span class="tsq-task-title"><template v-for="(seg,si) in segments(taskTitle(row.task),trimmed)" :key="si"><mark v-if="seg.mark" class="tsq-mark">{{seg.text}}</mark><template v-else>{{seg.text}}</template></template></span>
								<span class="tsq-meta">{{projectLabel(row.task.projectId)}}</span>
								<span class="tsq-time">{{relative(row.task.updatedAt)}}</span>
								<span class="tsq-pill">{{shortcutLabel(String(i+1))}}</span>
							</template>
						</button>
					</template>
				</div>
			</div>
		</section>
	</div>
</Teleport>
</template>

<style scoped>
/* quickPickDialogClassName / quickPickCommandClassName / quickPickInputClassName / quickPickListClassName /
   quickPickItemClassName / quickPickShortcutPillClassName / quickPickMetadataClassName（quickPickStyles.ts）。 */
.sb-search{display:flex;align-items:center;width:100%;height:32px;min-height:32px;padding:0 10px;margin:0;gap:8px;text-align:left;background:transparent;color:var(--fg);border:0;border-radius:8px;font-size:var(--text-ui-base);font-weight:400;cursor:pointer;}
.sb-search:hover{background:var(--color-surface-hover,var(--hover));color:var(--fg);}
.sb-search .sb-search-label{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;}
.sb-search kbd{flex:none;font-size:var(--text-ui-xs);font-weight:400;color:var(--color-foreground-subtlest,var(--fg-subtlest));}
.tsq-overlay{position:fixed;inset:0;z-index:1200;background:rgb(0 0 0/60%);backdrop-filter:blur(2px);}
.tsq-panel{position:fixed;top:50%;left:50%;z-index:1200;display:grid;transform:translate(-50%,-50%);width:100%;max-width:min(32rem,calc(100vw - 2rem));overflow:hidden;border:1px solid var(--color-popover-border,var(--border));border-radius:16px;background:var(--color-popover,var(--bg-panel));color:var(--fg);box-shadow:0 4px 6px -1px rgb(0 0 0/.1),0 2px 4px -2px rgb(0 0 0/.1);outline:none;}
.tsq-sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;}
.tsq-command{display:flex;flex-direction:column;width:100%;overflow:hidden;border-radius:16px;background:var(--color-popover,var(--bg-panel));padding:2px;}
.tsq-input-row{display:flex;align-items:center;height:40px;flex:none;padding:4px;gap:8px;border-bottom:1px solid var(--border);}
.tsq-input-row .tsq-input-icon{margin-left:4px;}
.tsq-input{flex:1;min-width:0;height:32px;border:0;background:transparent;color:var(--fg);font-size:var(--text-ui-base);line-height:1.625;outline:none;}
.tsq-input::placeholder{color:var(--color-foreground-subtlest,var(--fg-subtlest));}
.tsq-input-icon{flex:none;color:var(--color-foreground-subtlest,var(--fg-subtlest));pointer-events:none;}
.tsq-list{max-height:min(460px,64vh);overflow-x:hidden;overflow-y:auto;outline:none;padding:2px 0;}
.tsq-heading{padding:6px 10px;font-size:var(--text-ui-base);font-weight:500;color:var(--fg-subtle);}
.tsq-empty{padding:20px 16px;text-align:center;font-size:var(--text-ui-base);line-height:1.625;color:var(--fg-subtle);}
.tsq-item{display:flex;position:relative;align-items:center;min-height:32px;width:100%;padding:6px 10px;gap:8px;border:0;border-radius:12px;background:transparent;color:var(--fg);cursor:default;font-size:var(--text-ui-base);line-height:1.625;text-align:left;outline:none;user-select:none;-webkit-user-select:none;}
.tsq-item[data-selected=true],.tsq-item:hover{background:var(--color-menu-hover,var(--hover));}
.tsq-item-expand{min-height:28px;}
.tsq-task-header{display:flex;align-items:center;width:100%;min-width:0;margin-top:4px;padding:4px 10px 2px;gap:8px;border:0;border-radius:8px;background:transparent;color:var(--fg);cursor:default;font-size:var(--text-ui-base);line-height:1.5;text-align:left;outline:none;}
.tsq-task-header:first-child{margin-top:0;}
.tsq-task-header:hover,.tsq-task-header:focus-visible{background:var(--color-menu-hover,var(--hover));}
.tsq-task-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400;}
.tsq-snippet{flex:1;min-width:0;padding:2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400;line-height:1rem;color:var(--fg-subtle);}
.tsq-expand-chevron{flex:none;color:var(--fg-subtle);}
.tsq-expand-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400;color:var(--fg-subtle);}
.tsq-meta{max-width:45%;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-ui-base);line-height:1;color:var(--fg-subtle);}
.tsq-time{max-width:3rem;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-ui-xs);line-height:1;color:var(--color-foreground-subtlest,var(--fg-subtlest));}
.tsq-pill{display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:1.75rem;height:1rem;padding:0 4px;border-radius:4px;background:var(--color-surface,var(--hover));font-size:var(--text-ui-base);line-height:1;color:var(--color-foreground-subtlest,var(--fg-subtlest));}
.tsq-mark{border-radius:4px;background:var(--accent);color:var(--fg);font-weight:600;}
@media (max-width:639.98px){.tsq-panel{max-width:calc(100vw - 2rem);}}
</style>

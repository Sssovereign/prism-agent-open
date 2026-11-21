<script setup lang="ts">
// /help 命令帮助浮层：列出当前可用的 App 斜杠命令（名称、别名、用法、说明）。
// 交互对齐 CreateProjectDialog：Teleport 弹层、Esc/遮罩关闭、焦点归还；filter 支持命令名/别名/说明模糊搜索。
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { scoreFuzzyMatch } from '../conversation/promptTriggers';

export interface SlashHelpEntry {
  value: string;
  description: string;
  aliases?: readonly string[];
  usage?: string;
}

const props = defineProps<{ commands: readonly SlashHelpEntry[]; initialQuery?: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();
const filter = ref(props.initialQuery?.trim() ?? '');
const filterInput = ref<HTMLInputElement>();
const dialog = ref<HTMLElement>();
const previousFocus = document.activeElement as HTMLElement | null;

const entries = computed(() => props.commands.map(command => ({
  value: command.value,
  usage: command.usage?.trim() || `/${command.value}`,
  description: command.description,
  aliases: command.aliases ?? [],
  keywords: [command.value, command.description, ...(command.aliases ?? [])],
})));
const filtered = computed(() => {
  const query = filter.value.trim().toLowerCase().replace(/^\//, '');
  if (!query) return entries.value;
  return entries.value.filter(entry => entry.keywords.some(keyword => scoreFuzzyMatch(keyword.toLowerCase(), query) !== null));
});
function close(): void { emit('close'); }
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); close(); }
  if (event.key !== 'Tab') return;
  const items = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') ?? [])];
  if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
  else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
}
onMounted(async () => { await nextTick(); (filterInput.value ?? dialog.value)?.focus(); });
onUnmounted(() => { previousFocus?.focus(); });
</script>

<template>
<Teleport to="body"><div class="slash-help-overlay" @click.self="close"><section ref="dialog" class="slash-help-dialog" role="dialog" aria-modal="true" aria-labelledby="slash-help-title" @keydown="onKey">
  <header>
    <h2 id="slash-help-title">斜杠命令</h2>
    <button class="icon-btn" type="button" aria-label="关闭命令帮助" @click="close">×</button>
  </header>
  <input ref="filterInput" v-model="filter" class="slash-help-filter" type="search" placeholder="搜索命令…" aria-label="搜索命令">
  <ul v-if="filtered.length" class="slash-help-list">
    <li v-for="entry in filtered" :key="entry.value">
      <code>{{ entry.usage }}</code>
      <small v-if="entry.aliases.length">（别名 /{{ entry.aliases.join('、/') }}）</small>
      <p>{{ entry.description }}</p>
    </li>
  </ul>
  <p v-else class="slash-help-empty">没有匹配的命令</p>
  <footer><p class="slash-help-hint">在输入框键入 <code>/</code> 呼出命令面板；部分命令仅在任务运行时可用。技能用 <code>$</code> 或 <code>/</code> 面板的技能分节引用。</p></footer>
</section></div></Teleport>
</template>

<style scoped>
.slash-help-overlay { position: fixed; inset: 0; z-index: 1300; background: rgb(0 0 0 / .32); display: grid; place-items: center; padding: 24px; backdrop-filter: blur(2px); }
.slash-help-dialog { width: min(560px, 100%); max-height: calc(100dvh - 48px); overflow: auto; background: var(--bg-panel); color: var(--fg); border: 1px solid var(--border); border-radius: 16px; padding: 20px 24px 16px; box-shadow: 0 18px 70px rgb(0 0 0 / .18); }
.slash-help-dialog header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.slash-help-dialog h2 { font-size: 18px; font-weight: 600; margin: 0; }
.slash-help-filter { width: 100%; min-height: 36px; margin-bottom: 12px; padding: 7px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-input); color: var(--fg); font: inherit; font-size: 13px; }
.slash-help-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.slash-help-list li { padding: 10px 0; border-bottom: 1px solid var(--border); }
.slash-help-list li:last-child { border-bottom: 0; }
.slash-help-list code { font: 12px/1.5 var(--font-mono); color: var(--fg); overflow-wrap: anywhere; }
.slash-help-list small { font-size: 12px; color: var(--fg-subtle); }
.slash-help-list p { margin: 4px 0 0; font-size: 13px; color: var(--fg-subtle); line-height: 1.5; }
.slash-help-empty { margin: 16px 0; font-size: 13px; color: var(--fg-subtle); text-align: center; }
.slash-help-hint { margin: 12px 0 0; font-size: 12px; color: var(--fg-subtle); line-height: 1.6; }
.slash-help-hint code { font-family: var(--font-mono); }
</style>

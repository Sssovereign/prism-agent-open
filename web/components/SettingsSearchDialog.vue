<script setup lang="ts">
import {ignoredKeyEvent,plainKey} from '../keyboardShortcuts';
// ZCode 安装版设置搜索复刻（asar styles-*.js 内 SettingsSearch 组件 + gPt/PB 跳转高亮机制）：
// 「设置分类 + 已登记设置项」两级索引；匹配=NFKC 归一 + 中文全拼/首字母子序列（Knr/qnr），
// 描述文本纯 includes 兜底；键命中排在描述命中前。选中分类→切区；选中设置项→切区+滚动高亮 2 秒。
import { ref, computed, nextTick, watch } from 'vue';
import { pinyin } from 'pinyin-pro';
import UiIcon from './UiIcon.vue';
import { t } from '../ui/i18n/index';

// Gnr 注册表等价物：仅登记简单 checkbox/选择行（与上游 modelProvider/skills 等复杂区不登记一致）。
// 标签/描述走 i18n 字典（computed：语言切换即重算检索索引，中文行自动补全拼检索键）。
const SETTINGS_ITEMS = computed<Array<{ id: string; section: string; label: string; description: string }>>(() => [
	{ id: 'settings.general.language', section: 'general', label: t('settings.general.language'), description: t('settings.general.languageDesc') },
	{ id: 'settings.general.sendShortcut', section: 'general', label: t('settings.general.sendShortcut'), description: t('settings.general.sendShortcutDesc') },
	{ id: 'settings.general.followOutput', section: 'general', label: t('settings.general.followOutput'), description: t('settings.general.followOutputDesc') },
	{ id: 'settings.appearance.themeMode', section: 'appearance', label: t('settings.appearance.theme'), description: t('settings.appearance.themeDesc') },
	{ id: 'settings.appearance.eyeCare', section: 'appearance', label: t('settings.appearance.eyeCare'), description: t('settings.appearance.eyeCareDesc') },
	{ id: 'settings.appearance.textSize', section: 'appearance', label: t('settings.appearance.textSize'), description: t('settings.appearance.textSizeDesc') },
	{ id: 'settings.appearance.reduceMotion', section: 'appearance', label: t('settings.appearance.reduceMotion'), description: t('settings.appearance.reduceMotionDesc') },
]);

interface SettingsSection { id: string; label: string }
interface SearchItem { section: string; setting: string | null; label: string; sectionLabel: string; keys: string[]; descriptionKeys: string[] }

const props = defineProps<{ sections: SettingsSection[] }>();
const emit = defineEmits<{ (e: 'navigate', target: { section: string; setting: string | null }): void }>();

const open = ref(false), query = ref('');
const listEl = ref<HTMLElement>(), inputEl = ref<HTMLInputElement>();
const activeIndex = ref(0);
let pending: SearchItem | null = null, previousFocus: HTMLElement | null = null;

// O9：NFKC→小写→去空白；Knr：中文文本追加全拼与首字母两条检索键（toneType none，type array）。
function normalize(text: string) { return text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ''); }
function searchKeys(texts: string[]): string[] {
	const keys = texts.map(normalize);
	for (const text of texts) {
		if (/\p{Script=Han}/u.test(text)) {
			const letters = pinyin(text, { toneType: 'none', type: 'array' }) as string[];
			keys.push(normalize(letters.join('')), normalize(letters.map(l => l[0] ?? '').join('')));
		}
	}
	return keys.filter(Boolean);
}
// qnr：查询归一后的每个字符须按顺序出现在任一检索键中（子序列，不要求连续）。
function matchKeys(query: string, keys: string[]): boolean {
	const needle = normalize(query);
	if (!needle)return true;
	return keys.some(key => { let at = 0; for (const char of needle) { at = key.indexOf(char, at); if (at < 0)return false; at += 1; } return true; });
}
const index = computed<SearchItem[]>(() => props.sections.flatMap(section => {
	const sectionLabel = section.label;
	const items = SETTINGS_ITEMS.value.filter(item => item.section === section.id).map(item => ({
		section: section.id, setting: item.id, label: item.label, sectionLabel,
		keys: searchKeys([item.label]), descriptionKeys: [item.description],
	}));
	return [{ section: section.id, setting: null, label: sectionLabel, sectionLabel, keys: searchKeys([sectionLabel]), descriptionKeys: [] }, ...items];
}));
const results = computed<SearchItem[]>(() => index.value.flatMap(item => {
	const keyMatch = matchKeys(query.value, item.keys);
	const descMatch = !!query.value.trim() && item.descriptionKeys.some(text => text.normalize('NFKC').toLowerCase().includes(query.value.normalize('NFKC').trim().toLowerCase()));
	return keyMatch || descMatch ? [{ ...item, rank: keyMatch ? 0 : 1 }] : [];
}).sort((a, b) => a.rank - b.rank));

function subtitle(item: SearchItem) { return item.setting ? item.sectionLabel : t('settings.search.category'); }
function choose(item: SearchItem) {
	pending = item;
	close();
	emit('navigate', { section: item.section, setting: item.setting });
}
function onDialogKeydown(event: KeyboardEvent) {
	if (ignoredKeyEvent(event) || !plainKey(event))return;
	if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
		event.preventDefault();
		const total = results.value.length;
		if (!total)return;
		activeIndex.value = (activeIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + total) % total;
		void nextTick(() => listEl.value?.querySelector('[data-selected=true]')?.scrollIntoView({ block: 'nearest' }));
	} else if (event.key === 'Enter' && (event.target as HTMLElement)?.classList.contains('ssq-input')) {
		event.preventDefault();
		const item=results.value[activeIndex.value] ?? results.value[0];
		if(item)choose(item);
	} else if (event.key === 'Escape') {
		event.preventDefault();
		if (query.value) { query.value = ''; void nextTick(() => inputEl.value?.focus()); }
		else close();
	}
}
function close() {
	open.value = false;
	if (previousFocus?.isConnected)previousFocus.focus();
	previousFocus = null;
}
function openDialog() {
	previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	query.value = ''; activeIndex.value = 0;
	open.value = true;
	void nextTick(() => inputEl.value?.focus());
}
function clearQuery() { query.value = ''; void nextTick(() => inputEl.value?.focus()); }
watch(() => query.value, () => { activeIndex.value = 0; });
watch(results, () => { if (activeIndex.value >= results.value.length)activeIndex.value = Math.max(0, results.value.length - 1); });
defineExpose({ openDialog });
</script>

<template>
<Teleport to="body">
	<div v-if="open" class="ssq-overlay" @pointerdown.self="close">
		<section class="ssq-panel" role="dialog" aria-modal="true" aria-labelledby="ssq-title" @keydown="onDialogKeydown">
			<h2 id="ssq-title" class="ssq-sr-only">{{t('settings.search.srTitle')}}</h2>
			<p class="ssq-sr-only">{{t('settings.search.srDescription')}}</p>
			<div class="ssq-command">
				<div class="ssq-input-row">
					<UiIcon class="ssq-input-icon" name="search" :size="16"/>
					<input ref="inputEl" v-model="query" class="ssq-input" type="text" :aria-label="t('settings.searchSettings')" :placeholder="t('settings.searchSettings')" autocomplete="off" spellcheck="false">
					<button v-if="query" class="ssq-clear" type="button" :aria-label="t('settings.search.clear')" @click="clearQuery"><UiIcon name="x" :size="16"/></button>
				</div>
				<div ref="listEl" class="ssq-list" role="listbox" :aria-label="t('settings.search.results')">
					<template v-if="results.length===0">
						<p class="ssq-empty" role="status">{{t('settings.search.noResults')}}</p>
					</template>
					<button v-else v-for="(item,i) in results" :key="item.setting??item.section" type="button" role="option" class="ssq-item" :aria-selected="i===activeIndex" :data-selected="i===activeIndex||undefined" @mousemove="activeIndex=i" @click="choose(item)">
						<span class="ssq-item-text">
							<span class="ssq-label">{{item.label}}</span>
							<span class="ssq-sub">{{subtitle(item)}}</span>
						</span>
					</button>
				</div>
			</div>
		</section>
	</div>
</Teleport>
</template>

<style scoped>
/* settings-search-dialog：top-[15%] sm:max-w-xl p-0；Command rounded-xl p-2；List max-h-[55vh]；Item py-2 两行。 */
.ssq-overlay{position:fixed;inset:0;z-index:1300;background:rgb(0 0 0/60%);backdrop-filter:blur(2px);}
.ssq-panel{position:fixed;top:15%;left:50%;z-index:1300;display:grid;transform:translateX(-50%);width:100%;max-width:min(36rem,calc(100vw - 2rem));overflow:hidden;border:1px solid var(--color-popover-border,var(--border));border-radius:16px;background:var(--color-popover,var(--bg-panel));color:var(--fg);box-shadow:0 4px 6px -1px rgb(0 0 0/.1),0 2px 4px -2px rgb(0 0 0/.1);outline:none;}
.ssq-sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;}
.ssq-command{display:flex;flex-direction:column;width:100%;overflow:hidden;border-radius:12px;padding:8px;}
.ssq-input-row{position:relative;display:flex;align-items:center;height:40px;flex:none;padding:4px;gap:8px;border-bottom:1px solid var(--border);}
.ssq-input{flex:1;min-width:0;height:32px;padding-right:32px;border:0;background:transparent;color:var(--fg);font-size:var(--text-ui-base);line-height:1.625;outline:none;}
.ssq-input::placeholder{color:var(--color-foreground-subtlest,var(--fg-subtlest));}
.ssq-input-icon{margin-left:4px;flex:none;color:var(--color-foreground-subtlest,var(--fg-subtlest));pointer-events:none;}
.ssq-clear{position:absolute;right:8px;top:50%;transform:translateY(-50%);display:inline-grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--fg-subtle);cursor:pointer;}
.ssq-clear:hover{background:var(--hover);color:var(--fg);}
.ssq-list{max-height:55vh;overflow-x:hidden;overflow-y:auto;outline:none;}
.ssq-empty{padding:32px 16px;text-align:center;font-size:var(--text-ui-base);color:var(--fg-subtle);}
.ssq-item{display:flex;align-items:flex-start;width:100%;padding:8px 10px;gap:8px;border:0;border-radius:8px;background:transparent;color:var(--fg);cursor:default;text-align:left;outline:none;user-select:none;-webkit-user-select:none;}
.ssq-item[data-selected=true],.ssq-item:hover{background:var(--color-menu-hover,var(--hover));}
.ssq-item-text{min-width:0;flex:1;}
.ssq-label{display:block;overflow-wrap:break-word;font-size:var(--text-ui-base);}
.ssq-sub{display:block;font-size:var(--text-ui-sm);color:var(--fg-subtle);}
</style>

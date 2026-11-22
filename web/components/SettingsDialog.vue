<script setup lang="ts">
import UiSelect from './UiSelect.vue';
import UiIcon from './UiIcon.vue';
// SettingsPage/SettingsPageParts and ProviderCardSections: Vue adaptation (Apache-2.0).
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import ShortcutSettings from './ShortcutSettings.vue';
import PasswordChangeSection from './PasswordChangeSection.vue';
import {formatShortcut,defaultBindings,ignoredKeyEvent,type ShortcutBindings} from '../keyboardShortcuts';
import UsageStatsSection from './UsageStatsSection.vue';
import SubagentSettings from './SubagentSettings.vue';
import SettingsIcon from './SettingsIcon.vue';
import PrismMeaning from './PrismMeaning.vue';
import { PRISM_PROMISE } from '../brand';
import MemorySettingsSection from './MemorySettingsSection.vue';
import AgentRuntimeSettingsSection from './AgentRuntimeSettingsSection.vue';
import WebSearchSection from './WebSearchSection.vue';
import McpSection from './McpSection.vue';
import ResearchSettingsSection from './ResearchSettingsSection.vue';
import UpdateCenterSection from './UpdateCenterSection.vue';
import PluginsSection from './PluginsSection.vue';
import SkillsSection from './SkillsSection.vue';
import ModelProvidersSection from './ModelProvidersSection.vue';
import SettingsArchiveManagement from './SettingsArchiveManagement.vue';
import SettingsProjectManagement from './SettingsProjectManagement.vue';
import SettingsSearchDialog from './SettingsSearchDialog.vue';
import PermissionModeMenu from './PermissionModeMenu.vue';
import type {ApprovalMode} from '../../contracts/permissions';
import type {SidebarTree} from '../view-model/sidebar';
import { v1 } from '../api';
import type { ThemePref } from '../theme';
import type { LanguagePref } from '../ui/i18n/index';
import { t } from '../ui/i18n/index';
import type { Preferences } from '../preferences';
import { type ModelConfigView } from '../../contracts/models';
import type { ModelConfigInput } from '../../contracts/v1';
type Section = 'shortcuts' | 'usage' | 'subagents' | 'memory' | 'agent' | 'websearch' | 'mcp' | 'research' | 'plugins' | 'skills' | 'general' | 'appearance' | 'models' | 'permissions' | 'account' | 'projects' | 'archives' | 'advanced';
const props = defineProps<{
    shortcuts?: ShortcutBindings;
    username: string;
    projectId?: string;
    themePref: ThemePref;
    languagePref: LanguagePref;
    preferences: Preferences;
    configs: ModelConfigView[];
    initialSection?: Section;
    initialConfigId?: string;
    binding: string;
    roleBindings: Record<'pro' | 'con' | 'host', string>;
}>();
const emit = defineEmits<{
    (e: 'close'): void;
    (e: 'shortcuts-changed'): void;
    (e: 'update:themePref', v: ThemePref): void;
    (e: 'update:languagePref', v: LanguagePref): void;
    (e: 'update:preferences', v: Preferences): void;
    (e: 'models-changed', v: ModelConfigView[]): void;
    (e: 'open-files'): void;
    (e:'management-changed'):void;
    (e:'open-project',id:string):void;
    (e:'create-project'):void;
    (e: 'logout'): void;
    (e: 'password-changed'): void;
    (e: 'update:binding', v: string): void;
    (e: 'update:roleBindings', v: Record<'pro' | 'con' | 'host', string>): void;
    (e: 'reset-preferences'): void;
    (e: 'permissions-changed'): void;
}>();
// 分区标签走 i18n 字典（computed：语言切换即重算，SettingsSearchDialog 同步生效）。
const groups = computed<Array<{id:string;label:string;sections:Array<{id:Section;label:string}>}>>(() => [
 {id:'basics',label:t('settings.nav.basics'),sections:[{id:'general',label:t('settings.section.general')},{id:'shortcuts',label:t('settings.section.shortcuts')},{id:'appearance',label:t('settings.section.appearance')},{id:'models',label:t('settings.section.models')}]},
 {id:'capabilities',label:t('settings.nav.capabilities'),sections:[{id:'agent',label:t('settings.section.agent')},{id:'memory',label:t('settings.section.memory')},{id:'subagents',label:t('settings.section.subagents')},{id:'websearch',label:t('settings.section.websearch')},{id:'mcp',label:t('settings.section.mcp')},{id:'research',label:t('settings.section.research')},{id:'plugins',label:t('settings.section.plugins')},{id:'skills',label:t('settings.section.skills')},{id:'permissions',label:t('settings.section.permissions')}]},
 {id:'data',label:t('settings.nav.data'),sections:[{id:'usage',label:t('settings.section.usage')},{id:'projects',label:t('settings.section.projects')},{id:'archives',label:t('settings.section.archives')},{id:'account',label:t('settings.section.account')},{id:'advanced',label:t('settings.section.advanced')}]},
]);
const sections = computed(()=>groups.value.flatMap(group=>group.sections));
function initialSection():Section {
 if(props.initialSection)return props.initialSection;
 try {const saved=localStorage.getItem(`prism-settings-section:${props.username}`);if(sections.value.some(s=>s.id===saved))return saved as Section;}catch{}
 return 'general';
}
const section = ref<Section>(initialSection()), dialog = ref<HTMLElement>(), managementModalOpen=ref(false);
// 设置搜索（ZCode 安装版 SettingsSearch 复刻）：分类跳转 + 设置行滚动高亮 2 秒（gPt 机制）。
const settingsSearch=ref<InstanceType<typeof SettingsSearchDialog>>(),highlightedId=ref('');
let highlightTimer:ReturnType<typeof setTimeout>|undefined;
async function navigateToSearch(target:{section:string;setting:string|null}){
 await changeSection(target.section as Section);
 if(!target.setting)return;
 await nextTick();
 const row=dialog.value?.querySelector<HTMLElement>(`[data-settings-search-id="${target.setting}"]`);
 if(!row)return;
 row.scrollIntoView({block:'center',behavior:'instant'});
 row.focus({preventScroll:true});
 highlightedId.value=target.setting;
 if(highlightTimer)clearTimeout(highlightTimer);
 highlightTimer=setTimeout(()=>highlightedId.value='',2000);
}
watch(section,value=>{try{localStorage.setItem(`prism-settings-section:${props.username}`,value);}catch{}});
watch(()=>props.initialSection,value=>{if(value)void changeSection(value);});
const title = computed(() => sections.value.find(s => s.id === section.value)?.label);
const configs = ref<ModelConfigView[]>([...props.configs]);
const busy = ref(false), error = ref(''), notice = ref('');
const permissions = ref<Array<{
    projectId: string;
    projectName: string;
    id: string;
    displayName: string;
    access: string;
    revision:number;
}>>([]), loadingPermissions = ref(false);
const permissionProjects=ref<Array<{id:string;name:string;approvalMode:ApprovalMode}>>([]);
const health = ref<{
    version: string;
    hostVersion?: string | null;
    businessVersion?: string | null;
    productVersion?: string | null;
    runtime: {
        node: string;
        pi: string;
    };
}>(), healthError = ref('');
let disposed = false, previousFocus: HTMLElement | null = null;
const controller = new AbortController();
const request = <T,>(url: string, init: RequestInit = {}) => v1<T>(url, { ...init, signal: controller.signal });
watch(() => props.configs, value => { configs.value = [...value]; });
function payload(config: ModelConfigInput): ModelConfigInput {
 return { protocol: config.protocol ?? 'openai-completions', preset: config.preset, name: config.name, baseUrl: config.baseUrl, models: config.models.map(m => ({ ...m, parameters: { ...m.parameters } })) };
}
function modelsChanged(list: ModelConfigView[]) { configs.value = list; emit('models-changed', list); }
async function refresh() {
 const list = await request<ModelConfigView[]>('/api/v1/model-configs');
 if (!disposed) modelsChanged(list);
 return list;
}
function preference<K extends keyof Preferences>(field: K, value: Preferences[K]) { emit('update:preferences', { ...props.preferences, [field]: value }); }
async function loadPermissions(){
 loadingPermissions.value=true;error.value='';
 try{const data=await request<SidebarTree>('/api/v1/sidebar');const projects=data.projects;
 const lists=await Promise.all(projects.map(async p=>({project:p,grants:await request<Array<{id:string;displayName:string;access:string;revision:number;revoked:boolean}>>(`/api/v1/projects/${p.id}/grants`)})));
 if(!disposed){permissionProjects.value=projects.map(p=>({id:p.id,name:p.name,approvalMode:p.approvalMode??'auto'}));permissions.value=lists.flatMap(({project,grants})=>grants.filter(g=>!g.revoked).map(g=>({...g,projectId:project.id,projectName:project.name})));}
 }catch(e){if(!disposed)error.value=describe(e);}finally{loadingPermissions.value=false;}
}
async function setProjectApproval(id:string,approvalMode:ApprovalMode){
 if(busy.value)return;busy.value=true;error.value='';try{await request(`/api/v1/projects/${id}`,{method:'PATCH',body:JSON.stringify({approvalMode})});await loadPermissions();emit('management-changed');notice.value=t('settings.permissions.approvalUpdated');}catch(e){error.value=describe(e);}finally{busy.value=false;}
}
async function closeFolder(item: typeof permissions.value[number]) { if (busy.value)
    return; busy.value = true; try {
    await request(`/api/v1/projects/${item.projectId}/grants/${item.id}`, { method: 'DELETE' });
    await loadPermissions();
    emit('permissions-changed');
    notice.value = t('settings.permissions.folderClosed');
}
catch (e) {
    error.value = describe(e);
}
finally {
    busy.value = false;
} }
async function clearAllKeys() { if (busy.value)
    return; busy.value = true; error.value = ''; try {
    await request('/api/v1/model-credentials', { method: 'DELETE' });
    await refresh();
    notice.value = t('settings.account.keysCleared');
}
catch (e) {
    error.value = describe(e);
}
finally {
    busy.value = false;
} }
function exportConfig() { const data = { product: 'Prism', version: 1, theme: props.themePref, language: props.languagePref, preferences: props.preferences, modelConfigs: configs.value.map(payload) }; const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = t('settings.exportFileName'); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
async function changeSection(id: Section) { section.value = id; error.value = ''; notice.value = ''; await nextTick(); dialog.value?.querySelector<HTMLElement>('.settings-content')?.scrollTo({top:0}); if (id === 'permissions')
    await loadPermissions(); if (id === 'advanced' && !health.value) {
    healthError.value='';
    try {
        health.value = await request('/api/v1/health');
    }
    catch (e) {
        healthError.value = describe(e);
    }
} }
function describe(e: unknown) { return e instanceof Error ? e.message : t('settings.feedback.failed'); }
function onKey(event: KeyboardEvent) { if(ignoredKeyEvent(event)||event.ctrlKey||event.metaKey||event.altKey)return; if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    emit('close');
    return;
} if (event.key !== 'Tab')
    return; const items = [...dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary') || []].filter(el => el.getClientRects().length && el.tabIndex >= 0); const first = items[0], last = items[items.length - 1]; if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
}
else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
} }
onMounted(async () => { previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; await nextTick(); dialog.value?.querySelector<HTMLElement>('.settings-back')?.focus(); await changeSection(section.value); await refresh().catch(e => error.value = describe(e)); });
onUnmounted(() => { disposed = true; controller.abort(); nextTick(() => { if (previousFocus?.isConnected && !previousFocus.closest('[inert]'))
    previousFocus.focus(); }); });
</script>

<template>
  <Teleport to="body"><div class="settings-overlay" @click.self="emit('close')"><section ref="dialog" class="settings-window" :inert="managementModalOpen" role="dialog" aria-modal="true" aria-labelledby="settings-title" @keydown="onKey">
    <aside class="settings-nav"><div class="settings-nav-spacer"></div><button class="settings-back" type="button" :aria-label="t('settings.backToWorkspace')" :title="t('settings.backToWorkspace')" @click="emit('close')"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7M5 12h14"/></svg><span class="settings-nav-label">{{t('settings.backToWorkspace')}}</span></button><div class="settings-search-row"><button class="btn settings-search-open" type="button" aria-haspopup="dialog" :aria-label="t('settings.searchSettings')" @click="settingsSearch?.openDialog()"><UiIcon name="search" :size="16"/><span class="settings-search-label">{{t('settings.searchSettings')}}</span></button></div><nav :aria-label="t('settings.nav.categories')"><div v-for="group in groups" :key="group.id" class="settings-nav-group" role="group" :aria-label="group.label"><h3>{{group.label}}</h3><button v-for="item in group.sections" :key="item.id" type="button" :title="item.label" :aria-label="item.label" :aria-current="section===item.id?'page':undefined" @click="changeSection(item.id)"><SettingsIcon :kind="item.id"/><span class="settings-nav-label">{{item.label}}</span></button></div></nav><span class="settings-product">棱镜 Prism</span></aside>
    <SettingsSearchDialog ref="settingsSearch" :sections="sections" @navigate="navigateToSearch"/>
    <div class="settings-main"><header class="settings-header"><nav aria-label="设置面包屑"><span>{{title}}</span></nav><button class="icon-btn settings-close" type="button" :aria-label="t('settings.close')" :title="t('settings.closeTitle')" @click="emit('close')"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></header>
      <div class="settings-content"><h1 id="settings-title">{{title}}</h1>
      <p v-if="error" class="settings-feedback error-text" role="alert">{{error}}</p><p v-else-if="notice" class="settings-feedback" role="status">{{notice}}</p>
      <template v-if="section==='general'">
        <p class="settings-description">{{t('settings.general.description')}}</p>
        <h2>{{t('settings.general.conversationHeading')}}</h2><div class="settings-group"><div class="setting-row" tabindex="-1" :data-settings-search-id="'settings.general.language'" :class="{'settings-row-highlighted':highlightedId==='settings.general.language'}"><div><strong>{{t('settings.general.language')}}</strong><p>{{t('settings.general.languageDesc')}}</p></div><UiSelect :model-value="languagePref" :label="t('settings.general.language')" @change="emit('update:languagePref',$event as LanguagePref)" :options="[{value:'system',label:t('settings.general.languageSystem')},{value:'zh',label:'中文'},{value:'en',label:'English'}]"/></div><div class="setting-row" tabindex="-1" :data-settings-search-id="'settings.general.sendShortcut'" :class="{'settings-row-highlighted':highlightedId==='settings.general.sendShortcut'}"><div><strong>{{t('settings.general.sendShortcut')}}</strong><p>{{t('settings.general.sendShortcutDesc')}}</p></div><UiSelect :model-value="preferences.sendShortcut" :label="t('settings.general.sendShortcut')" @change="preference('sendShortcut',$event as Preferences['sendShortcut'])" :options="[{value:'enter',label:t('settings.general.sendOptionEnter')},{value:'modifier-enter',label:t('settings.general.sendOptionModifier',{shortcut:formatShortcut('Mod+Enter')})}]"/></div><div class="setting-row" tabindex="-1" :data-settings-search-id="'settings.general.followOutput'" :class="{'settings-row-highlighted':highlightedId==='settings.general.followOutput'}"><div><strong>{{t('settings.general.followOutput')}}</strong><p>{{t('settings.general.followOutputDesc')}}</p></div><input type="checkbox" :checked="preferences.followOutput" :aria-label="t('settings.general.followOutput')" @change="preference('followOutput',($event.target as HTMLInputElement).checked)"></div></div>
        <h2>{{t('settings.general.shortcutsHeading')}}</h2><div class="settings-group"><div class="setting-row"><span>{{t('settings.general.newTask')}}</span><kbd>{{formatShortcut((shortcuts ?? defaultBindings()).newTask)||t('settings.general.unassigned')}}</kbd></div><div class="setting-row"><span>{{t('settings.general.openSettings')}}</span><kbd>{{formatShortcut((shortcuts ?? defaultBindings()).settings)||t('settings.general.unassigned')}}</kbd></div><div class="setting-row"><span>{{t('settings.general.closePanel')}}</span><kbd>Esc</kbd></div></div>
      </template>
      <template v-else-if="section==='appearance'"><p class="settings-description">{{t('settings.appearance.description')}}</p>        <h2>{{t('settings.appearance.heading')}}</h2><div class="settings-group"><div class="setting-row" tabindex="-1" :data-settings-search-id="'settings.appearance.themeMode'" :class="{'settings-row-highlighted':highlightedId==='settings.appearance.themeMode'}"><div><strong>{{t('settings.appearance.theme')}}</strong><p>{{t('settings.appearance.themeDesc')}}</p></div><UiSelect :model-value="themePref" :label="t('settings.appearance.theme')" @change="emit('update:themePref',$event as ThemePref)" :options="[{value:'system',label:t('settings.appearance.themeSystem')},{value:'light',label:t('settings.appearance.themeLight')},{value:'dark',label:t('settings.appearance.themeDark')}]"/></div><div class="setting-row" tabindex="-1" :data-settings-search-id="'settings.appearance.eyeCare'" :class="{'settings-row-highlighted':highlightedId==='settings.appearance.eyeCare'}"><div><strong>{{t('settings.appearance.eyeCare')}}</strong><p>{{t('settings.appearance.eyeCareDesc')}}</p></div><input type="checkbox" :checked="preferences.eyeCare" :aria-label="t('settings.appearance.eyeCare')" @change="preference('eyeCare',($event.target as HTMLInputElement).checked)"></div><div class="setting-row" tabindex="-1" :data-settings-search-id="'settings.appearance.textSize'" :class="{'settings-row-highlighted':highlightedId==='settings.appearance.textSize'}"><div><strong>{{t('settings.appearance.textSize')}}</strong><p>{{t('settings.appearance.textSizeDesc')}}</p></div><UiSelect :model-value="preferences.textSize" :label="t('settings.appearance.textSize')" @change="preference('textSize',$event as Preferences['textSize'])" :options="[{value:'small',label:t('settings.appearance.textSmall')},{value:'standard',label:t('settings.appearance.textStandard')},{value:'large',label:t('settings.appearance.textLarge')}]"/></div><div class="setting-row" tabindex="-1" :data-settings-search-id="'settings.appearance.reduceMotion'" :class="{'settings-row-highlighted':highlightedId==='settings.appearance.reduceMotion'}"><div><strong>{{t('settings.appearance.reduceMotion')}}</strong><p>{{t('settings.appearance.reduceMotionDesc')}}</p></div><input type="checkbox" :checked="preferences.reduceMotion" :aria-label="t('settings.appearance.reduceMotion')" @change="preference('reduceMotion',($event.target as HTMLInputElement).checked)"></div></div>
</template>
      <ModelProvidersSection @modal-change="managementModalOpen=$event" v-else-if="section==='models'" :configs="configs" :initial-config-id="initialConfigId" :binding="binding" :role-bindings="roleBindings" @models-changed="modelsChanged" @update:binding="emit('update:binding',$event)" @update:role-bindings="emit('update:roleBindings',$event)" />
      <template v-else-if="section==='projects'"><SettingsProjectManagement @modal-change="managementModalOpen=$event" @changed="emit('management-changed')" @open-project="emit('open-project',$event)" @create-project="emit('create-project')"/></template>
      <template v-else-if="section==='archives'"><SettingsArchiveManagement @modal-change="managementModalOpen=$event" @changed="emit('management-changed')"/></template>
      <ShortcutSettings v-else-if="section==='shortcuts'" :username="username" @changed="emit('shortcuts-changed')"/>
      <UsageStatsSection v-else-if="section==='usage'"/>
      <SubagentSettings v-else-if="section==='subagents'"/>
      <MemorySettingsSection v-else-if="section==='memory'" />
      <AgentRuntimeSettingsSection v-else-if="section==='agent'" />
      <WebSearchSection v-else-if="section==='websearch'" />
      <McpSection v-else-if="section==='mcp'" />
      <ResearchSettingsSection v-else-if="section==='research'" />
      <PluginsSection v-else-if="section==='plugins'" />
      <SkillsSection v-else-if="section==='skills'" :project-id="projectId" @open-plugins="changeSection('plugins')" />
      <template v-else-if="section==='permissions'">
        <p class="settings-description">{{t('settings.permissions.description')}}</p><h2>{{t('settings.permissions.approvalHeading')}}</h2><div class="settings-group"><div v-for="p in permissionProjects" :key="p.id" class="setting-row"><div><strong>{{p.name}}</strong><p>{{t('settings.permissions.approvalRowDesc')}}</p></div><PermissionModeMenu :value="p.approvalMode" :busy="busy" @change="setProjectApproval(p.id,$event)" @modal-change="managementModalOpen=$event"/></div></div><p class="settings-footnote">{{t('settings.permissions.footnote')}}</p><h2>{{t('settings.permissions.fileHeading')}}</h2><div class="settings-group"><div class="setting-row"><div><strong>{{t('settings.permissions.fileAccess')}}</strong><p>{{t('settings.permissions.fileAccessDesc')}}</p></div><button class="btn" type="button" @click="emit('open-files')">{{t('settings.permissions.manageFiles')}}</button></div><div class="setting-row"><div><strong>{{t('settings.permissions.highImpact')}}</strong><p>{{t('settings.permissions.highImpactDesc')}}</p></div><span class="settings-badge">{{t('settings.permissions.highImpactBadge')}}</span></div></div><h2>{{t('settings.permissions.foldersHeading')}}</h2><p v-if="loadingPermissions" class="settings-footnote" role="status">{{t('common.loading')}}</p><p v-else-if="!permissions.length" class="settings-footnote">{{t('settings.permissions.foldersEmpty')}}</p><div v-else class="settings-group"><div v-for="item in permissions" :key="item.id" class="setting-row"><div><strong>{{ item.displayName }}</strong><p>{{t('settings.permissions.projectFolder',{project:item.projectName})}}</p></div><button class="text-btn" type="button" :disabled="busy" @click="closeFolder(item)">{{t('settings.permissions.closeFolder')}}</button></div></div>
      </template>
      <template v-else-if="section==='account'">
        <PasswordChangeSection @changed="emit('password-changed')"/>
        <p class="settings-description">{{t('settings.account.description')}}</p><div class="settings-group"><div class="setting-row"><div><strong>{{ username }}</strong><p>{{t('settings.account.localAccount')}}</p></div><button class="btn" type="button" @click="emit('logout')">{{t('settings.account.logout')}}</button></div><div class="setting-row"><div><strong>{{t('settings.account.apiKeys')}}</strong><p>{{t('settings.account.apiKeysDesc')}}</p></div><button class="text-btn" type="button" :disabled="busy" @click="clearAllKeys">{{t('settings.account.clearKeys')}}</button></div></div><h2>{{t('settings.account.dataHeading')}}</h2><div class="settings-group"><div class="setting-row"><div><strong>{{t('settings.account.exportSettings')}}</strong><p>{{t('settings.account.exportDesc')}}</p></div><button class="btn" type="button" @click="exportConfig">{{t('settings.account.exportJson')}}</button></div><div class="setting-row"><div><strong>{{t('settings.account.resetPrefs')}}</strong><p>{{t('settings.account.resetDesc')}}</p></div><button class="text-btn" type="button" @click="emit('reset-preferences');notice=t('settings.account.resetDone')">{{t('settings.account.reset')}}</button></div></div>
      </template>
      <template v-else>
        <p class="settings-description">{{t('settings.advanced.description')}}</p><h2>棱镜 Prism</h2><p class="settings-description">{{ PRISM_PROMISE }}</p><PrismMeaning /><h2>{{t('settings.advanced.updatesHeading')}}</h2><UpdateCenterSection @close="emit('close')" /><h2>{{t('settings.advanced.openSourceHeading')}}</h2><p class="settings-description">{{t('settings.advanced.openSourceDesc')}}</p><h2>{{t('settings.advanced.runInfoHeading')}}</h2><p v-if="healthError" class="error-text">{{ healthError }}</p><div class="settings-group"><div class="setting-row"><span>{{t('settings.advanced.product')}}</span><span>棱镜 Prism</span></div><div class="setting-row"><span>{{t('settings.advanced.hostVersion')}}</span><span>{{ health?.hostVersion || '—' }}</span></div><div class="setting-row"><span>{{t('settings.advanced.businessVersion')}}</span><span>{{ health?.businessVersion || health?.productVersion || t('settings.advanced.reading') }}</span></div><div class="setting-row"><span>{{t('settings.advanced.apiVersion')}}</span><span>{{ health?.version || t('settings.advanced.reading') }}</span></div><div class="setting-row"><span>Pi SDK</span><span>{{ health?.runtime.pi || t('settings.advanced.reading') }}</span></div><div class="setting-row"><span>Node.js</span><span>{{ health?.runtime.node || t('settings.advanced.reading') }}</span></div></div><p class="settings-footnote">{{t('settings.advanced.footnote')}}</p>
      </template>
      </div>
    </div>
  </section></div></Teleport>
</template>

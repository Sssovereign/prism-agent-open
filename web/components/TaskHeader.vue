<script setup lang="ts">
// 轻量顶栏：菜单（窄屏）、任务标题、状态徽标、详情开关、护眼快捷开关。
import type { StatusKind } from '../status';
import ModeSwitcher from './ModeSwitcher.vue';
import type { WorkMode } from '../modes';
import UpdateDownloadIndicator from './UpdateDownloadIndicator.vue';

defineProps<{
  title: string;
  projectName?:string;
  status: { kind: StatusKind; label: string } | null;
  detailOpen: boolean;
  detailTab?: 'files' | 'browser' | 'delivery';
  sidebarExpanded: boolean;
  mode: WorkMode;
  eyeCare: boolean;
}>();
const emit = defineEmits<{ (e: 'toggle-detail'): void; (e: 'toggle-sidebar'): void; (e: 'open-outputs'): void; (e: 'open-updates'): void; (e: 'change-mode', mode: WorkMode): void; (e: 'toggle-eye-care'): void }>();
</script>

<template>
  <header class="topbar" :class="{'is-draft': !title}">
    <button class="icon-btn tb-menu" type="button" :title="sidebarExpanded?'收起任务列表':'打开任务列表'" :aria-label="sidebarExpanded?'收起任务列表':'打开任务列表'" :aria-expanded="sidebarExpanded" aria-controls="workspace-sidebar" @click="emit('toggle-sidebar')">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
    </button>
    <ModeSwitcher :mode="mode" @change="emit('change-mode', $event)" />
    <div class="tb-title"><span v-if="projectName" class="tb-project-context">{{projectName}}<span v-if="title" aria-hidden="true"> / </span></span>
      <h1 v-if="title" :title="title">{{ title }}</h1>
      <span v-if="status" class="chip" :class="status.kind"><span class="dot"></span>{{ status.label }}</span>
    </div>
    <div class="tb-side">
      <UpdateDownloadIndicator @open="emit('open-updates')" />
      <button class="icon-btn eye-toggle" type="button" :aria-pressed="eyeCare" :title="eyeCare ? '护眼模式 · 已开启' : '护眼模式'" aria-label="护眼模式" @click="emit('toggle-eye-care')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.06 12.35s3.44-7.1 9.94-7.1 9.94 7.1 9.94 7.1-3.44 7.1-9.94 7.1-9.94-7.1-9.94-7.1Z"/><circle cx="12" cy="12.35" r="3"/></svg>
      </button>
      <button v-if="title" type="button" class="outputs-trigger" :aria-pressed="detailOpen && detailTab==='delivery'" :aria-expanded="detailOpen && detailTab==='delivery'" title="输出内容与来源" aria-label="输出内容与来源" @click="emit('open-outputs')"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="4" cy="6" r="2"/><circle cx="4" cy="18" r="2"/><path d="M10 6h11M10 18h11M3 12h18"/></svg></button>
      <button class="icon-btn" type="button" :title="detailOpen && detailTab==='files' ? '关闭文件面板' : '打开文件面板'" :aria-label="detailOpen && detailTab==='files' ? '关闭文件面板' : '打开文件面板'" :aria-pressed="detailOpen && detailTab==='files'" @click="emit('toggle-detail')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg>
      </button>
    </div>
  </header>
</template>
<style scoped>
.outputs-trigger{display:inline-flex;align-items:center;gap:7px;flex:none;white-space:nowrap;min-height:30px;padding:5px 9px;border:0;border-radius:8px;background:transparent;color:var(--fg-subtle);font:inherit;font-size:var(--text-ui-sm);cursor:pointer}
.outputs-trigger:hover,.outputs-trigger[aria-pressed=true]{background:var(--hover);color:var(--fg)}
.eye-toggle[aria-pressed=true]{background:var(--hover);color:var(--fg)}
@media(max-width:600px){.outputs-trigger{padding:6px;gap:4px;font-size:12px}}
</style>

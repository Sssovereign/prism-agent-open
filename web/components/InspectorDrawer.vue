<script setup lang="ts">
// 按需详情面板：资料（真实目录授权/快照/上传/联网）、内嵌浏览器（R2 面板化）与交付（证据、产物、错误）。
import FilesPanel from '../FilesPanel.vue';
import RunChangesPanel from './RunChangesPanel.vue';
import BrowserPanel from './BrowserPanel.vue';
import DrawerResizeHandle from './DrawerResizeHandle.vue';
import { DEFAULT_OUTPUT_WIDTH, DEFAULT_DRAWER_WIDTH } from '../layout/drawerWidth';

export type InspectorTab = 'files' | 'browser' | 'delivery';

const props = defineProps<{ open: boolean; tab: InspectorTab; activeProjectId?: string; realRunId?: string; refreshKey?: string; width: number; minWidth: number; maxWidth: number; suppressed?: boolean }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'create-project'): void; (e: 'update:tab', t: InspectorTab): void; (e: 'project-change', payload: { id: string; name: string; grantId: string }): void; (e: 'update:width', width: number): void; (e: 'resizing', active: boolean): void }>();

function onTabKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tab = event.key === 'Home' ? 'files' : event.key === 'End' ? 'delivery' : props.tab === 'files' ? 'browser' : 'files';
  emit('update:tab', tab);
  const target = event.currentTarget as HTMLElement;
  target.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)?.focus();
}
</script>

<template>
  <aside class="drawer" :class="{'output-card': tab === 'delivery'}" :aria-hidden="!props.open" :inert="!props.open"  :aria-label="tab === 'delivery' ? '输出内容卡片' : '详情面板'">
    <DrawerResizeHandle v-if="open" :width="width" :min="minWidth" :max="maxWidth" :default-width="tab === 'delivery' ? DEFAULT_OUTPUT_WIDTH : DEFAULT_DRAWER_WIDTH" @update:width="emit('update:width',$event)" @resizing="emit('resizing',$event)" />
    <div class="drawer-head">
      <h2 v-if="tab === 'delivery'" class="output-card-title">输出内容</h2>
      <div v-else class="drawer-tabs" role="tablist" aria-label="详情内容" @keydown="onTabKey">
        <button role="tab" type="button" data-tab="files" :tabindex="props.tab === 'files' ? 0 : -1" :aria-selected="props.tab === 'files'" @click="emit('update:tab', 'files')">文件</button>
        <button role="tab" type="button" data-tab="browser" :tabindex="props.tab === 'browser' ? 0 : -1" :aria-selected="props.tab === 'browser'" @click="emit('update:tab', 'browser')">浏览器</button>
        <button role="tab" type="button" data-tab="delivery" :tabindex="props.tab === 'delivery' ? 0 : -1" :aria-selected="props.tab === 'delivery'" @click="emit('update:tab', 'delivery')">输出内容</button>
      </div>
      <button class="icon-btn" type="button" title="关闭详情" aria-label="关闭详情面板" @click="emit('close')">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>
    <div class="drawer-body">
      <FilesPanel :active-project-id="props.activeProjectId" v-show="props.tab === 'files'" @project-change="emit('project-change', $event)" @create-project="emit('create-project')" />
      <BrowserPanel v-show="props.tab === 'browser'" :active="props.open && props.tab === 'browser'" :suppressed="props.suppressed" />
      <div v-if="props.tab === 'delivery'">
        <RunChangesPanel v-if="props.realRunId" :run-id="props.realRunId" :refresh-key="refreshKey" compact />
        <p v-else class="drawer-empty">选择任务后，在这里查看结果与来源。</p>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.output-card-title{flex:1;font-size:var(--text-ui-base);font-weight:500;color:var(--fg-subtle);margin:0}
</style>

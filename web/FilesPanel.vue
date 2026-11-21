<script setup lang="ts">
import UiSelect from './components/UiSelect.vue';
import ComposerSelect from './components/ComposerSelect.vue';
// File tree interaction adapted from ZCode WorkspaceFileTreeRowView (Apache-2.0).
// Native picker and immutable resources remain behind the existing broker.
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { v1, ApiError, currentCsrfToken } from './api';
import FileIcon from './components/FileIcon.vue';
import MarkdownText from './components/MarkdownText.vue';

interface Project { id: string; name: string }
interface Grant { id: string; access: string; revision: number; displayName: string; revoked: boolean; isPrimary: boolean }
interface Entry { name: string; type: 'file' | 'directory'; sizeBytes: number | null }
interface Resource { id: string; kind: string; displayName: string; currentVersion: number; versions: Array<{ version: number; sizeBytes: number; sourceUrl: string | null }> }
interface Snapshot { resourceId: string; version: number; displayName?: string }
interface Row extends Entry { path: string; depth: number }
interface Preview { name: string; resourceId: string; version: number; kind: string; content?: string; truncated?: boolean; sourcePath?: string }
const props = defineProps<{ activeProjectId?: string }>();
const emit = defineEmits<{ (e: 'project-change', payload: { id: string; name: string; grantId: string }): void; (e:'create-project'):void }>();
const projects = ref<Project[]>([]), projectId = ref(''), grants = ref<Grant[]>([]), grantId = ref('');
const resources = ref<Resource[]>([]), children = ref<Record<string, Entry[]>>({}), expanded = ref<Set<string>>(new Set());
const selectedPath = ref(''), preview = ref<Preview>(), tab = ref<'folder' | 'added'>('folder');
const error = ref(''), notice = ref(''), busy = ref(false), loading = ref(false), picking = ref(false);
const addMenu=ref<InstanceType<typeof ComposerSelect>>();
const addChoices=[{value:'upload',label:'上传文件',description:'最多50MB',icon:'paperclip' as const},{value:'url',label:'添加网页',icon:'arrow-right' as const},{value:'folder',label:'打开文件夹',icon:'folder-plus' as const}];
function addChoice(value:string){if(value==='upload')void chooseUpload();else if(value==='url')urlOpen.value=true;else if(value==='folder')void pickDirectory();}
const addOpen = ref(false), urlOpen = ref(false), webUrl = ref('');
const snapshots = new Map<string, Snapshot>();
let returnResourceId = '';
const uploadInput = ref<HTMLInputElement>(), tree = ref<HTMLElement>();
const activeGrants = computed(() => grants.value.filter(g => !g.revoked));
const currentGrant = computed(() => activeGrants.value.find(g => g.id === grantId.value));
const projectName = computed(() => projects.value.find(p => p.id === projectId.value)?.name ?? '');
const rows = computed(() => {
  const result: Row[] = [];
  function walk(parent: string, depth: number) {
    for (const e of [...(children.value[parent] ?? [])].sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : a.type === 'directory' ? -1 : 1)) {
      const path = parent ? `${parent}/${e.name}` : e.name;
      result.push({ ...e, path, depth });
      if (e.type === 'directory' && expanded.value.has(path)) walk(path, depth + 1);
    }
  }
  walk('', 0); return result;
});
let epoch = 0, previewEpoch = 0, disposed = false, poll: ReturnType<typeof setTimeout> | undefined;
const describe = (e: unknown) => e instanceof Error ? e.message : '操作失败，请重试';
const base = (id = projectId.value) => `/api/v1/projects/${encodeURIComponent(id)}`;
function clearPicker() { if (poll) clearTimeout(poll); poll = undefined; picking.value = false; }
function resetView() {
  addMenu.value?.close(false);
  epoch++; previewEpoch++; snapshots.clear(); clearPicker(); preview.value = undefined; children.value = {}; expanded.value = new Set();
  grants.value = []; grantId.value = ''; resources.value = []; selectedPath.value = ''; error.value = ''; notice.value = '';
  addOpen.value = urlOpen.value = false; busy.value = false;
}
async function selectProject() {
  resetView(); emit('project-change', { id: projectId.value, name: projectName.value, grantId: '' });
  if (!projectId.value) return;
  const version = epoch, id = projectId.value; loading.value = true;
  try {
    const [g, r] = await Promise.all([v1<Grant[]>(`${base(id)}/grants`), v1<Resource[]>(`${base(id)}/resources`)]);
    if (version !== epoch || disposed) return;
    grants.value = g; resources.value = r; grantId.value = g.find(x => !x.revoked && x.isPrimary)?.id ?? g.find(x => !x.revoked)?.id ?? '';
    emit('project-change', { id, name: projectName.value, grantId: grantId.value });
    if (grantId.value) await loadDirectory('');
    else if (r.length) tab.value = 'added';
  } catch (e) { if (version === epoch) error.value = describe(e); }
  finally { if (version === epoch) loading.value = false; }
}
function ensureProject(): boolean { if (projectId.value) return true; emit('create-project'); return false; }
async function loadDirectory(path: string) {
  const version = epoch, grant = grantId.value;
  const data = await v1<{ entries: Entry[] }>(`${base()}/files?grantId=${encodeURIComponent(grant)}&relativePath=${encodeURIComponent(path || '.')}`);
  if (version === epoch && grant === grantId.value && !disposed) children.value = { ...children.value, [path]: data.entries };
}
async function changeFolder() {
  previewEpoch++; snapshots.clear(); preview.value = undefined; children.value = {}; expanded.value = new Set(); selectedPath.value = ''; error.value = '';
  try { await loadDirectory(''); } catch (e) { error.value = describe(e); }
}
async function toggle(row: Row, open = !expanded.value.has(row.path)) {
  selectedPath.value = row.path;
  if (row.type !== 'directory') { await openFile(row); return; }
  const version = epoch, grant = grantId.value;
  try {
    if (open && !children.value[row.path]) await loadDirectory(row.path);
    if (version !== epoch || grant !== grantId.value) return;
    const set = new Set(expanded.value); if (open) set.add(row.path); else set.delete(row.path); expanded.value = set;
  } catch (e) { if (version === epoch) error.value = describe(e); }
}
async function treeKey(event: KeyboardEvent, row: Row, index: number) {
  const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'Enter', ' '];
  if (!keys.includes(event.key)) return; event.preventDefault();
  let target = index;
  if (event.key === 'ArrowDown') target++;
  else if (event.key === 'ArrowUp') target--;
  else if (event.key === 'Home') target = 0;
  else if (event.key === 'End') target = rows.value.length - 1;
  else if (event.key === 'ArrowRight') { if (row.type === 'directory') { if (!expanded.value.has(row.path)) await toggle(row, true); else target++; } }
  else if (event.key === 'ArrowLeft') {
    if (expanded.value.has(row.path)) await toggle(row, false);
    else { const parent = row.path.split('/').slice(0, -1).join('/'); const found = rows.value.findIndex(r => r.path === parent); if (found >= 0) target = found; }
  } else { await toggle(row); return; }
  target = Math.max(0, Math.min(target, rows.value.length - 1));
  selectedPath.value = rows.value[target]?.path ?? ''; await nextTick(); tree.value?.querySelectorAll<HTMLElement>('[role="treeitem"]')[target]?.focus();
}
async function openPreview(resourceId: string, version: number, name: string, versionAtStart = epoch, request = ++previewEpoch) {
  const data = await v1<{ kind: string; content?: string; truncated?: boolean }>(`${base()}/resources/${resourceId}/versions/${version}?view=preview`);
  if (versionAtStart === epoch && request === previewEpoch && !disposed) { preview.value = { ...data, name, resourceId, version }; await nextTick(); document.querySelector<HTMLButtonElement>('.preview-head button')?.focus(); }
}
async function openFile(row: Row) {
  if (busy.value) return;
  busy.value = true; error.value = ''; const version = epoch, request = ++previewEpoch;
  try {
    const snap = snapshots.get(row.path) ?? await v1<Snapshot>(`${base()}/file-snapshots`, { method: 'POST', body: JSON.stringify({ grantId: grantId.value, relativePath: row.path }) });
    if (version !== epoch || disposed) return;
    snapshots.set(row.path, snap);
    await openPreview(snap.resourceId, snap.version, row.name, version, request);
    if (preview.value && version === epoch && request === previewEpoch) preview.value.sourcePath = row.path;
    await refreshResources(version);
  } catch (e) { if (version === epoch) error.value = describe(e); }
  finally { if (version === epoch) busy.value = false; }
}
async function openResource(r: Resource) {
  const version = epoch; returnResourceId = r.id; error.value = ''; busy.value = true;
  try { await openPreview(r.id, r.currentVersion, r.displayName); }
  catch (e) { if (version === epoch) error.value = describe(e); }
  finally { if (version === epoch) busy.value = false; }
}
async function refreshResources(version = epoch) {
  const list = await v1<Resource[]>(`${base()}/resources`);
  if (version === epoch && !disposed) resources.value = list;
}
async function pickDirectory() {
  if (picking.value || busy.value) return;
  error.value = ''; addOpen.value = false;
  try { if (!ensureProject()) return; } catch (e) { error.value = describe(e); return; }
  const version = epoch, id = projectId.value; picking.value = true;
  try {
    const start = await v1<{ pickerTicket: { id: string; expiresAt: string }; nonce: string }>(`${base(id)}/directory-picker`, { method: 'POST', body: JSON.stringify({ access: 'write' }) });
    if (version !== epoch || disposed) return;
    notice.value = '请在系统窗口中选择文件夹';
    const deadline = Date.parse(start.pickerTicket.expiresAt);
    async function check() {
      if (version !== epoch || disposed) return;
      try {
        const status = await v1<{ state: string; directoryName: string | null }>(`/api/v1/directory-pickers/${start.pickerTicket.id}`);
        if (version !== epoch || disposed) return;
        if (status.state === 'selected') {
          const grant = await v1<Grant>(`${base(id)}/grants`, { method: 'POST', body: JSON.stringify({ pickerTicket: start.pickerTicket.id, nonce: start.nonce, access: 'write' }) });
          if (version !== epoch || disposed) return;
          clearPicker(); grants.value = [...grants.value, grant]; grantId.value = grant.id; tab.value = 'folder'; notice.value = ''; await changeFolder(); return;
        }
        if (['cancelled', 'failed', 'expired'].includes(status.state) || Date.now() >= deadline) {
          clearPicker(); notice.value = status.state === 'cancelled' ? '' : '未能打开文件夹，请重试'; return;
        }
      } catch (e) {
        if (version !== epoch || disposed) return;
        if (Date.now() >= deadline || e instanceof ApiError && e.status < 500) { clearPicker(); notice.value = ''; error.value = describe(e); return; }
      }
      if (version === epoch && !disposed) poll = setTimeout(check, 1200);
    }
    poll = setTimeout(check, 500);
  } catch (e) { if (version === epoch) { clearPicker(); error.value = describe(e); } }
}
async function disconnect() {
  const version = epoch, grant = grantId.value; error.value = '';
  try {
    await v1(`${base()}/grants/${grant}`, { method: 'DELETE' });
    if (version !== epoch) return;
    const g = grants.value.find(g => g.id === grant); if (g) g.revoked = true;
    // 关闭主要文件夹时后端会提升最早的剩余授权，重拉一次同步isPrimary。
    const list = await v1<Grant[]>(`${base()}/grants`);
    if (version !== epoch || disposed) return;
    grants.value = list;
    grantId.value = list.find(x => !x.revoked && x.isPrimary)?.id ?? list.find(x => !x.revoked)?.id ?? '';
    preview.value = undefined; children.value = {}; expanded.value = new Set();
    if (grantId.value) await loadDirectory(''); notice.value = '已关闭文件夹，Agent的本机文件访问能力不受影响';
  } catch (e) { if (version === epoch) error.value = describe(e); }
}
// 设为主要工作目录：后端清掉项目内其他主要标记；任务的工作目录绑定随之切换。
async function setPrimary() {
  const grant = currentGrant.value;
  if (!grant || grant.isPrimary || busy.value || picking.value) return;
  const version = epoch; error.value = '';
  try {
    const updated = await v1<Grant>(`${base()}/grants/${grant.id}/primary`, { method: 'POST' });
    if (version !== epoch || disposed) return;
    grants.value = grants.value.map(g => g.id === updated.id ? updated : { ...g, isPrimary: false });
    notice.value = `已将「${updated.displayName}」设为主要工作目录`;
  } catch (e) { if (version === epoch) error.value = describe(e); }
}
async function chooseUpload() {
  addOpen.value = false;
  try { if (!ensureProject()) return; await nextTick(); uploadInput.value?.click(); } catch (e) { error.value = describe(e); }
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; if (!file) return;
  const version = epoch, id = projectId.value; busy.value = true; error.value = '';
  try {
    const form = new FormData(); form.append('file', file);
    const headers = new Headers(); const csrf = currentCsrfToken(); if (csrf) headers.set('X-CSRF-Token', csrf);
    const response = await fetch(`${base(id)}/uploads`, { method: 'POST', headers, body: form });
    const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? '上传失败');
    if (version !== epoch || disposed) return;
    tab.value = 'added'; returnResourceId = body.data.resourceId; await refreshResources(version);
    await openPreview(body.data.resourceId, body.data.version, file.name, version);
  } catch (e) { if (version === epoch) error.value = describe(e); }
  finally { input.value = ''; if (version === epoch) busy.value = false; }
}
async function fetchWeb() {
  if (!webUrl.value.trim() || busy.value) return;
  try { if (!ensureProject()) return; } catch (e) { error.value = describe(e); return; }
  const version = epoch; busy.value = true; error.value = '';
  try {
    const result = await v1<Snapshot>(`${base()}/web-resources`, { method: 'POST', body: JSON.stringify({ url: webUrl.value.trim() }) });
    if (version !== epoch || disposed) return;
    webUrl.value = ''; urlOpen.value = false; tab.value = 'added'; await refreshResources(version);
    const r = resources.value.find(r => r.id === result.resourceId); await openPreview(result.resourceId, result.version, r?.displayName ?? '网页', version);
  } catch (e) { if (version === epoch) error.value = describe(e); }
  finally { if (version === epoch) busy.value = false; }
}
async function closePreview() { previewEpoch++; preview.value = undefined; await nextTick(); const root = document.querySelector('.explorer'); const target = tab.value === 'folder' ? root?.querySelector<HTMLElement>('[role=treeitem][aria-selected=true]') : root?.querySelector<HTMLElement>(`[data-resource-id="${returnResourceId}"]`); (target ?? root?.querySelector<HTMLElement>('.resource-row, .explorer-toolbar select'))?.focus(); }
async function updatePreview() { const path = preview.value?.sourcePath; const row = rows.value.find(r => r.path === path); if (row) { snapshots.delete(row.path); await openFile(row); } }
watch(addOpen,value=>{if(!value)addMenu.value?.close(false);});
function onKey(event: KeyboardEvent) { if (event.key === 'Escape' && (preview.value || addOpen.value || urlOpen.value)) { event.stopPropagation(); event.preventDefault(); if (preview.value) void closePreview(); else { addOpen.value = urlOpen.value = false; } } }

function sizeLabel(n?: number | null) { return n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; }
watch(() => props.activeProjectId, async id => {
  if (!id || id === projectId.value || disposed) return;
  const requested = id;
  try {
    const list = await v1<Project[]>('/api/v1/projects?limit=100');
    if (disposed || requested !== props.activeProjectId) return;
    projects.value = list; projectId.value = id; await selectProject();
  } catch(e) { if (!disposed) error.value = describe(e); }
});
onMounted(async () => {

  try { projects.value = await v1<Project[]>('/api/v1/projects'); if (!disposed && props.activeProjectId && projects.value.some(p => p.id === props.activeProjectId)) { projectId.value = props.activeProjectId; await selectProject(); } }
  catch (e) { if (!disposed) error.value = describe(e); }
});
function filesReverted() { if(grantId.value)void changeFolder(); }
window.addEventListener('prism:files-reverted',filesReverted);
onUnmounted(() => { window.removeEventListener('prism:files-reverted',filesReverted); disposed = true; epoch++; previewEpoch++; clearPicker(); });
</script>

<template>
  <section class="explorer" aria-label="项目文件" @keydown="onKey">
    <div class="explorer-toolbar">
      <UiSelect v-if="projects.length" v-model="projectId" label="当前项目" :disabled="busy || picking" @change="selectProject" :options="projects.map(p=>({value:p.id,label:p.name}))"/>
      <span v-else class="muted">项目文件</span>
      <button class="icon-btn" type="button" aria-label="新建项目" title="新建项目" :disabled="busy || picking" @click="emit('create-project')"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 7V5h7l2 2h9v12H3Z"/><path d="M12 10v6M9 13h6"/></svg></button>
      <ComposerSelect ref="addMenu" class="explorer-add" value="" :options="addChoices" label="添加文件或网页" icon="plus" icon-only action-mode :disabled="busy||picking" @open-change="addOpen=$event" @change="addChoice"/>

    </div>
    <form v-if="urlOpen" class="explorer-form" @submit.prevent="fetchWeb"><input v-model="webUrl" type="url" aria-label="网页地址" placeholder="粘贴网页链接" required><button class="btn" :disabled="busy" type="submit">添加</button><button class="icon-btn" type="button" aria-label="取消添加网页" @click="urlOpen = false">×</button></form>
    <input ref="uploadInput" type="file" hidden aria-label="上传文件" @change="upload">
    <p v-if="error" class="explorer-notice error-text" role="alert">{{ error }} <button class="text-btn" type="button" @click="error = ''">收起</button></p>
    <p v-if="notice" class="explorer-notice" role="status">{{ notice }}</p>
    <p v-if="busy" class="explorer-notice" role="status">正在打开文件…</p>
    <template v-if="preview">
      <div class="preview-head"><button class="icon-btn" type="button" aria-label="返回文件列表" @click="closePreview">←</button><FileIcon :name="preview.name"/><strong :title="preview.name">{{ preview.name }}</strong><button v-if="preview.sourcePath" class="icon-btn" type="button" aria-label="更新文件预览" title="重新读取原文件" :disabled="busy" @click="updatePreview">↻</button><a class="icon-btn" aria-label="下载当前文件" title="下载当前文件" :href="`${base()}/resources/${preview.resourceId}/versions/${preview.version}?view=download`">↓</a></div>
      <p v-if="preview.kind !== 'text'" class="explorer-empty">此文件暂不支持在线预览。<br>可通过右上角下载查看。</p>
      <MarkdownText v-else-if="/\.md$/i.test(preview.name)" class="file-rich-preview" :text="preview.content || ''" /><pre v-else class="file-preview">{{ preview.content }}</pre>
      <p v-if="preview.truncated" class="explorer-notice">仅显示部分内容，下载可查看完整文件。</p>
    </template>
    <template v-else>
      <div class="folder-access-actions"><button class="text-btn" type="button" :disabled="busy || picking" @click="pickDirectory()">打开文件夹</button><span class="muted">Agent可访问本机文件</span></div>
      <div class="explorer-tabs" role="group" aria-label="文件来源"><button type="button" :aria-pressed="tab === 'folder'" @click="tab = 'folder'">文件夹</button><button type="button" :aria-pressed="tab === 'added'" @click="tab = 'added'">已添加 <span v-if="resources.length">{{ resources.length }}</span></button></div>
      <template v-if="tab === 'folder'">
        <div v-if="currentGrant" class="folder-heading"><FileIcon folder /><UiSelect v-model="grantId" label="当前文件夹" :disabled="busy || picking" @change="changeFolder" :options="activeGrants.map(g=>({value:g.id,label:g.isPrimary?`${g.displayName}（主要）`:g.displayName}))"/><button v-if="!currentGrant.isPrimary" class="text-btn" type="button" title="将当前文件夹设为Agent的主要工作目录" :disabled="busy || picking" @click="setPrimary">设为主要</button><button class="icon-btn" type="button" title="关闭文件夹" aria-label="关闭文件夹" :disabled="busy || picking" @click="disconnect">×</button></div>
        <div v-if="currentGrant" ref="tree" class="file-tree" role="tree" :aria-label="currentGrant.displayName">
          <button v-for="(row, index) in rows" :key="row.path" type="button" role="treeitem" :tabindex="selectedPath === row.path || !selectedPath && index === 0 ? 0 : -1" :aria-level="row.depth + 1" :aria-expanded="row.type === 'directory' ? expanded.has(row.path) : undefined" :aria-selected="selectedPath === row.path" :disabled="busy" class="tree-row" :style="{ paddingLeft: `${row.depth * 12 + 8}px` }" :title="row.path" @click="toggle(row)" @keydown="treeKey($event, row, index)">
            <span class="tree-chevron" :class="{ expanded: expanded.has(row.path), invisible: row.type !== 'directory' }">›</span><FileIcon :folder="row.type === 'directory'" :name="row.name" /><span class="tree-name">{{ row.name }}</span><small>{{ sizeLabel(row.sizeBytes) }}</small>
          </button>
          <p v-if="!rows.length && !loading" class="explorer-empty">文件夹为空</p>
        </div>
        <div v-else-if="!loading" class="explorer-empty"><FileIcon folder class="empty-folder" /><h3>从文件夹开始</h3><p>浏览本机文件，点击即可预览。<br>Agent直接操作真实文件，操作是否确认取决于授权模式。</p><button class="btn" type="button" :disabled="picking" @click="pickDirectory()">{{ picking ? '等待选择…' : '打开文件夹' }}</button></div>
      </template>
      <template v-else>
        <div v-if="resources.length" class="resource-list"><button v-for="r in resources" :key="r.id" type="button" class="resource-row" :data-resource-id="r.id" :disabled="busy" @click="openResource(r)"><FileIcon :name="r.displayName"/><span><strong>{{ r.displayName }}</strong><small>{{ r.kind === 'local' ? '来自文件夹' : r.kind === 'upload' ? '上传的文件' : '网页' }} · {{ sizeLabel(r.versions.find(v => v.version === r.currentVersion)?.sizeBytes) }}</small></span><span aria-hidden="true">›</span></button></div>
        <div v-else class="explorer-empty"><FileIcon class="empty-folder" /><h3>把资料放在一起</h3><p>添加文档或网页，随时预览和下载。</p><button class="btn" type="button" @click="chooseUpload">上传文件</button><button class="text-btn" type="button" @click="urlOpen = true">添加网页</button></div>
        <p class="explorer-footnote">当前模拟任务使用内置示例资料，尚未接入项目文件。</p>
      </template>
      <p v-if="loading" class="explorer-empty" role="status">正在读取文件…</p>
    </template>
  </section>
</template>

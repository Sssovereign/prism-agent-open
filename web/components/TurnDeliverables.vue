<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, nextTick } from 'vue';
import { v1 } from '../api';
import type { RunArtifact, FileRewindPreview } from '../../contracts/deliverables';
import UiIcon from './UiIcon.vue';
import FileIcon from './FileIcon.vue';
import HighlightedDiffLines from './HighlightedDiffLines.vue';
import type { RunChange } from '../../contracts/changes';
import { totalChangeLines } from '../conversation/changeStats';
import ChangeLineStats from './ChangeLineStats.vue';

const props = defineProps<{ runId: string; status: string; revision?: number; disabled?: boolean }>();
const artifacts = ref<RunArtifact[]>([]), changes = ref<RunChange[]>([]), error = ref(''), changeTotal = ref(0);
const lineTotals = computed(() => totalChangeLines(changes.value));
const dialog = ref<HTMLDialogElement>(), preview = ref<FileRewindPreview>(), previewLoading = ref(false), applying = ref(false), rewindError = ref('');
const patches = ref<Record<string,string>>({}), patchErrors = ref<Record<string,string>>({}), downloading = ref('');
const terminal = computed(() => ['succeeded','failed','cancelled'].includes(props.status));
const paths = computed(() => new Set(changes.value.map(c => c.relative_path)).size);
const reverted = computed(() => changes.value.length > 0 && changes.value.every(c => c.reverted_at));
let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined, generation = 0, disposed = false;
async function load() {
  const version = ++generation, c = new AbortController(); controller?.abort(); controller = c;
  try {
    const [a,b] = await Promise.all([
      v1<{artifacts:RunArtifact[]}>(`/api/v1/runs/${props.runId}/artifacts`,{signal:c.signal}),
      v1<{changes:RunChange[];total:number}>(`/api/v1/runs/${props.runId}/changes`,{signal:c.signal}),
    ]);
    if (version !== generation || disposed) return;
    artifacts.value=a.artifacts;changes.value=b.changes;changeTotal.value=b.total;error.value='';
  } catch(e) { if (!c.signal.aborted && !disposed) error.value=e instanceof Error?e.message:'读取产物与变更失败'; }
}
watch(() => [props.runId,props.status,props.revision], () => { clearTimeout(timer);timer=setTimeout(load,120); }, {immediate:true});
onBeforeUnmount(() => {disposed=true;generation++;clearTimeout(timer);controller?.abort();dialog.value?.close();});
const size = (bytes:number) => bytes<1024?`${bytes} B`:bytes<1024*1024?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;
async function download(artifact:RunArtifact) {
  downloading.value=artifact.id;error.value='';
  try {
    const response=await fetch(`/api/v1/artifacts/${encodeURIComponent(artifact.id)}/download`);
    if(!response.ok){const body=await response.json();throw new Error(body.error?.message??'产物下载失败');}
    const blob=await response.blob(), url=URL.createObjectURL(blob), a=document.createElement('a');
    a.href=url;a.download=artifact.display_name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
  } catch(e) {error.value=e instanceof Error?e.message:'产物下载失败';}
  finally {downloading.value='';}
}
async function inspectRewind() {
  previewLoading.value=true;preview.value=undefined;rewindError.value='';
  await nextTick();
  // showModal须在try内且仅对未打开的dialog调用：已打开时再调用会抛InvalidStateError，previewLoading将永远无法复位。
  try { if(!dialog.value?.open)dialog.value?.showModal();const value=await v1<FileRewindPreview>(`/api/v1/runs/${props.runId}/file-rewind`);if(!disposed)preview.value=value; }
  catch(e) {if(!disposed)rewindError.value=e instanceof Error?e.message:'撤销预检失败';}
  finally {previewLoading.value=false;}
}
async function applyRewind() {
  if(!preview.value?.canApply||props.disabled||!terminal.value)return;
  applying.value=true;rewindError.value='';
  try {
    preview.value=await v1<FileRewindPreview>(`/api/v1/runs/${props.runId}/file-rewind`,{method:'POST',body:JSON.stringify({previewToken:preview.value.previewToken})});
    window.dispatchEvent(new CustomEvent('prism:files-reverted',{detail:{runId:props.runId}}));
    await load();dialog.value?.close();
  } catch(e) {rewindError.value=e instanceof Error?e.message:'撤销文件失败';preview.value=undefined;}
  finally {applying.value=false;}
}
async function loadPatch(change:RunChange) {
  if(!change.hasDiff||change.id in patches.value)return;
  try {const data=await v1<{patch:string}>(`/api/v1/runs/${props.runId}/changes/${change.id}/diff`);if(!disposed){patches.value[change.id]=data.patch;delete patchErrors.value[change.id];}}
  catch(e){if(!disposed)patchErrors.value[change.id]=e instanceof Error?e.message:'读取差异失败';}
}
const reason = (code?:string) => ({bash_ignored:'命令修改未纳入回退',checkpoint_missing:'缺少原始备份',checkpoint_unreadable:'备份缺失或校验失败',external_modified:'当前文件已被其他操作修改',file_read_failed:'无法读取当前文件',grant_revoked:'文件授权已撤销，无法还原',unsupported_checkpoint:'无法安全还原此文件'}[code??'']??code);
</script>
<template>
 <div v-if="artifacts.length||changes.length||error" class="turn-deliverables">
  <div v-if="artifacts.length" class="artifact-cards" aria-label="生成产物">
   <button v-for="artifact in artifacts" :key="artifact.id" type="button" class="artifact-card" :disabled="!!downloading||artifact.state!=='verified'" :aria-label="`下载产物：${artifact.display_name}`" @click="download(artifact)">
    <FileIcon :name="artifact.display_name" :size="24"/><span class="artifact-info"><strong>{{artifact.display_name}}</strong><small>{{artifact.state==='verified'?size(artifact.size_bytes):'产物不可用'}}</small></span><UiIcon name="download" :size="16"/>
   </button>
  </div>
  <div v-if="changes.length" class="file-summary">
   <div class="file-summary-heading"><span>{{paths}} 个文件已更改</span><ChangeLineStats :stats="lineTotals" cumulative /><span v-if="reverted" class="reverted">已撤销</span><button v-else type="button" class="rewind-button" :disabled="disabled||!terminal" @click="inspectRewind"><UiIcon name="undo" :size="14"/>撤销</button></div>
   <p class="change-count-note">按变更记录累计（含已撤销）<template v-if="changeTotal>changes.length"> · 仅显示最近 {{changes.length}} / {{changeTotal}} 条</template></p><details><summary>查看文件变更</summary><details v-for="change in changes" :key="change.id" class="file-change" @toggle="($event.target as HTMLDetailsElement).open && loadPatch(change)"><summary><FileIcon :name="change.relative_path"/><span class="file-change-path" :title="change.relative_path">{{change.relative_path}}</span><ChangeLineStats :stats="change.lineStats"/><small>{{{create:'新建',modify:'修改',delete:'删除'}[change.operation]??change.operation}}{{change.reverted_at?' · 已撤销':''}}</small></summary><p v-if="patchErrors[change.id]" role="alert">{{patchErrors[change.id]}} <button class="text-btn" @click="loadPatch(change)">重试</button></p><HighlightedDiffLines v-else-if="patches[change.id]" :patch="patches[change.id]!" :path="change.relative_path"/><p v-else>{{change.hasDiff?'正在读取差异…':'没有可显示的文本差异'}}</p></details></details>
  </div>
  <p v-if="error" role="alert" class="deliverable-error">{{error}} <button type="button" class="text-btn" @click="load">重新读取</button></p>
 </div>
 <Teleport to="body"><dialog ref="dialog" class="rewind-dialog" aria-label="撤销文件改动" @cancel="applying && $event.preventDefault()" @click="$event.target===dialog && !applying && dialog?.close()">
  <header><h2>撤销文件改动</h2><button type="button" class="icon-btn" aria-label="关闭撤销预览" :disabled="applying" @click="dialog?.close()"><UiIcon name="x" :size="16"/></button></header>
  <p>恢复本轮文件工具修改前的内容。撤销前会重新检查文件；存在冲突时整批拒绝。对话与下载产物保留。</p>
  <p v-if="previewLoading" role="status">正在检查可撤销文件…</p>
  <div v-if="preview" class="rewind-preview">
   <section v-for="group in [{title:'可安全撤销',files:preview.safeFiles},{title:'不能安全撤销',files:preview.unsafeFiles},{title:'已忽略',files:preview.ignoredFiles}]" :key="group.title"><h3>{{group.title}} {{group.files.length}}</h3><div v-for="file in group.files" :key="file.path" class="preview-file"><span>{{file.path}}</span><small>{{file.reason?reason(file.reason):`${file.operationCount} 次修改`}}</small></div></section>
   <p v-if="!preview.canApply">{{preview.reverted?'本轮文件已撤销。':preview.unsafeFiles.length?'存在不能安全撤销的文件，未写入任何文件。':'没有可安全撤销的文件。'}}</p>
  </div>
  <p v-if="rewindError" role="alert" class="deliverable-error">{{rewindError}}</p>
  <footer><button type="button" class="btn" :disabled="applying" @click="dialog?.close()">取消</button><button v-if="rewindError" type="button" class="btn" :disabled="previewLoading||applying" @click="inspectRewind">重新检查</button><button type="button" class="btn rewind-confirm" :disabled="!preview?.canApply||previewLoading||applying||disabled||!terminal" @click="applyRewind">{{applying?'正在撤销…':'撤销文件'}}</button></footer>
 </dialog></Teleport>
</template>
<style scoped>
.turn-deliverables{margin:12px 0 24px;font-size:var(--text-ui-sm)}.artifact-cards{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}.artifact-card{display:flex;align-items:center;gap:12px;text-align:left;max-width:100%;width:280px;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--bg-panel);color:var(--fg);cursor:pointer}.artifact-card:hover{background:var(--hover)}.artifact-card:disabled{opacity:.6;cursor:default}.artifact-info{flex:1;min-width:0}.artifact-info strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}.artifact-info small{display:block;color:var(--fg-subtlest);margin-top:4px}.file-summary{border:1px solid var(--border);border-radius:10px;overflow:hidden}.change-count-note{margin:0;padding:5px 12px;font-size:var(--text-ui-caption);color:var(--fg-subtlest)}.file-summary-heading{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-height:40px;padding:0 12px;background:var(--bg-panel)}.rewind-button{display:inline-flex;gap:6px;align-items:center;margin-left:auto;padding:5px 8px;border:0;border-radius:6px;background:transparent;color:var(--fg-subtle);font:inherit;cursor:pointer}.rewind-button:hover{background:var(--hover);color:var(--fg)}.rewind-button:disabled{opacity:.4;cursor:default}.reverted{margin-left:auto;color:var(--fg-subtlest)}details>summary{cursor:pointer;padding:9px 12px;color:var(--fg-subtle)}.file-change{border-top:1px solid var(--border)}.file-change>summary{display:flex;gap:8px;align-items:center}.file-change-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-change>summary>small{white-space:nowrap;color:var(--fg-subtlest)}.file-change>p{padding:0 12px}.deliverable-error{color:var(--danger);overflow-wrap:anywhere}.rewind-dialog{box-sizing:border-box;width:min(560px,calc(100% - 32px));max-height:80dvh;overflow:auto;padding:22px;border:1px solid var(--border);border-radius:14px;background:var(--bg-panel);color:var(--fg);box-shadow:0 18px 70px #0003}.rewind-dialog::backdrop{background:#0006}.rewind-dialog header{display:flex;align-items:center;justify-content:space-between}.rewind-dialog h2{margin:0;font-size:18px}.rewind-dialog>p{font-size:var(--text-ui-sm);color:var(--fg-subtle);line-height:1.7}.rewind-preview h3{font-size:var(--text-ui-sm);margin:16px 0 8px}.preview-file{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px;background:var(--bg-input);border-radius:6px;margin-top:4px;font-size:var(--text-ui-sm)}.preview-file>span{overflow-wrap:anywhere;min-width:0}.preview-file small{flex-shrink:0;color:var(--fg-subtlest)}.rewind-dialog footer{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}.rewind-confirm{background:var(--danger);color:white}.rewind-dialog button:disabled{opacity:.45;cursor:default}@media(max-width:480px){.preview-file{align-items:flex-start;flex-direction:column;gap:4px}}
</style>

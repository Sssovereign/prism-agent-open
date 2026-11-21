<script setup lang="ts">
/** 真实 run 结果面板（块F1）：InspectorDrawer 结果 tab 的新增路径——变更（diff 视图）、
 *  产物、证据三区，仅在选中真实任务时挂载。 */
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import type { ConversationWindow, MessageAttachmentMeta } from '../../contracts/conversation';
import type { RunChange } from '../../contracts/changes';
import { totalChangeLines } from '../conversation/changeStats';
import ChangeLineStats from './ChangeLineStats.vue';
import { v1 } from '../api';
import HighlightedDiffLines from './HighlightedDiffLines.vue';
import FileIcon from './FileIcon.vue';
import ArtifactTextPreview from './ArtifactTextPreview.vue';
interface ArtifactRow { id: string; display_name: string; size_bytes: number; created_at: string; state: string }
interface EvidenceRow { invocationId: string; tool: string; summary: string }
const props = defineProps<{ runId: string; compact?: boolean; refreshKey?: string }>();
const changes = ref<RunChange[]>([]), changeTotal = ref(0);
const lineTotals = computed(() => totalChangeLines(changes.value));
const artifacts = ref<ArtifactRow[]>([]);
const previewArtifact = ref<ArtifactRow>();
function canPreview(artifact:ArtifactRow) { return artifact.state==='verified' && artifact.size_bytes<=1024*1024 && /\.(md|markdown|txt|json|log)$/i.test(artifact.display_name); }
const evidence = ref<EvidenceRow[]>([]);
const sourceAttachments = ref<MessageAttachmentMeta[]>([]);
const showAllSources = ref(false), showChanges = ref(false);
const sourceCount = computed(() => sourceAttachments.value.length + evidence.value.length);
const visibleAttachments = computed(() => showAllSources.value ? sourceAttachments.value : sourceAttachments.value.slice(0, 3));
const visibleEvidence = computed(() => showAllSources.value ? evidence.value : evidence.value.slice(0, Math.max(0, 3 - visibleAttachments.value.length)));
const expanded = ref<string | null>(null);
const patches = ref<Record<string, string>>({});
const patchLoading=ref<Record<string,boolean>>({}),patchErrors=ref<Record<string,string>>({});
let generation=0,controller:AbortController|undefined;
const loading = ref(false);
const error = ref('');
const OPERATIONS: Record<string, string> = { create: '新建', modify: '修改', delete: '删除' };
const EVIDENCE_TOOLS = new Set(['read_file', 'read_image', 'list_dir', 'grep_files', 'web_fetch', 'web_search']);
function summarizeEvidence(tool: string, args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  const pick = (key: string): string => typeof a[key] === 'string' ? String(a[key]) : '';
  return tool === 'web_fetch' ? pick('url') : tool === 'web_search' ? pick('query') : tool === 'grep_files' ? pick('pattern') || pick('query') : pick('path') || pick('dirPath') || '—';
}
async function load(): Promise<void> {
  const runId=props.runId,version=++generation,c=new AbortController();controller?.abort();controller=c;
  loading.value=true;error.value='';changes.value=[];artifacts.value=[];evidence.value=[];sourceAttachments.value=[];showAllSources.value=false;showChanges.value=false;expanded.value=null;patches.value={};patchLoading.value={};patchErrors.value={};
  previewArtifact.value=undefined;
  try {
    const [changeData,artifactData,conversation]=await Promise.all([
      v1<{changes:RunChange[];total:number}>(`/api/v1/runs/${runId}/changes`,{signal:c.signal}),
      v1<{artifacts:ArtifactRow[]}>(`/api/v1/runs/${runId}/artifacts`,{signal:c.signal}),
      v1<ConversationWindow>(`/api/v1/runs/${runId}/conversation?limit=10`,{signal:c.signal}),
    ]);
    if(version!==generation||c.signal.aborted)return;
    changes.value=changeData.changes;changeTotal.value=changeData.total;artifacts.value=artifactData.artifacts;
    sourceAttachments.value=[...new Map(conversation.runs.filter(r=>r.id===runId).flatMap(r=>r.messages).flatMap(m=>m.content.attachments??[]).map(a=>[a.id,a])).values()];
    evidence.value=conversation.runs.filter(r=>r.id===runId).flatMap(r=>r.tools).filter(t=>t.state==='succeeded'&&EVIDENCE_TOOLS.has(t.tool)).slice(0,50).map(t=>({invocationId:t.invocationId,tool:t.tool,summary:summarizeEvidence(t.tool,t.args)}));
  }catch(e){if(version===generation&&!c.signal.aborted)error.value=e instanceof Error?e.message:'结果面板加载失败';}
  finally{if(version===generation&&!c.signal.aborted)loading.value=false;}
}
async function loadPatch(id:string):Promise<void>{
  if(patchLoading.value[id])return;
  const version=generation,runId=props.runId,signal=controller?.signal;patchLoading.value[id]=true;delete patchErrors.value[id];
  try{const result=await v1<{patch:string}>(`/api/v1/runs/${runId}/changes/${encodeURIComponent(id)}/diff`,{signal});if(version===generation&&!signal?.aborted)patches.value[id]=result.patch;}
  catch(e){if(version===generation&&!signal?.aborted)patchErrors.value[id]=e instanceof Error?e.message:'读取差异失败';}
  finally{if(version===generation)patchLoading.value[id]=false;}
}
async function toggleChange(id:string):Promise<void>{
 if(expanded.value===id){expanded.value=null;return;}expanded.value=id;
 if(!(id in patches.value))await loadPatch(id);
}
watch(()=>[props.runId,props.refreshKey],()=>{void load();},{immediate:true});
function filesReverted(event:Event){if((event as CustomEvent<{runId:string}>).detail.runId===props.runId)void load();}
window.addEventListener('prism:files-reverted',filesReverted);
onBeforeUnmount(()=>{window.removeEventListener('prism:files-reverted',filesReverted);generation++;controller?.abort();});
</script>
<template>
  <div class="run-panel" :class="{'is-preview':previewArtifact,'is-compact':compact}" data-testid="run-changes-panel">
    <p v-if="loading&&!previewArtifact" role="status" class="panel-hint">正在读取任务结果…</p>
    <div v-else-if="error&&!previewArtifact"><p role="alert" class="panel-error">{{error}}</p><button class="text-btn" @click="load">重试读取结果</button></div>
    <ArtifactTextPreview v-else-if="previewArtifact" :artifact="previewArtifact" @close="previewArtifact=undefined" />
    <template v-else>
      <section class="panel-section output-section">
        <h3 v-if="!compact" class="panel-title">生成文件 <span v-if="artifacts.length" class="panel-count">{{ artifacts.length }}</span></h3>
        <p v-if="!artifacts.length" class="panel-hint output-empty">生成的文件会显示在这里。</p>
        <ul v-else class="artifact-list">
          <li v-for="artifact in artifacts" :key="artifact.id" class="artifact-item">
            <FileIcon :name="artifact.display_name" :size="22"/>
            <div class="artifact-info"><button v-if="canPreview(artifact)" type="button" class="artifact-name" @click="previewArtifact=artifact">{{artifact.display_name}}</button><span v-else class="artifact-name">{{artifact.display_name}}</span><span class="artifact-size">{{(artifact.size_bytes/1024).toFixed(1)}} KB</span></div>
            <div class="artifact-actions"><button v-if="canPreview(artifact)" type="button" @click="previewArtifact=artifact">预览</button><a :href="`/api/v1/artifacts/${artifact.id}/download`" :aria-label="`下载：${artifact.display_name}`">下载</a></div>
          </li>
        </ul>
      </section>
      <section v-if="compact" class="panel-section sources-section">
        <h3 class="panel-title">来源 <span v-if="sourceCount" class="panel-count">{{sourceCount}}</span></h3>
        <p v-if="!sourceCount" class="panel-hint">上传的附件与读取的来源会显示在这里。</p>
        <ul v-else class="evidence-list">
          <li v-for="attachment in visibleAttachments" :key="attachment.id"><a class="attachment-source" :href="`/api/v1/attachments/${attachment.id}/raw`" target="_blank" rel="noopener" :title="attachment.name"><img v-if="attachment.mime.startsWith('image/')" :src="`/api/v1/attachments/${attachment.id}/raw`" alt=""/><FileIcon v-else :name="attachment.name" :size="22"/><span>{{attachment.name}}</span></a></li>
          <li v-for="row in visibleEvidence" :key="row.invocationId" class="evidence-item" :title="row.summary"><FileIcon :name="row.summary"/><span class="evidence-summary">{{row.summary}}</span></li>
        </ul>
        <button v-if="sourceCount>3" type="button" class="source-toggle" :aria-expanded="showAllSources" @click="showAllSources=!showAllSources">{{showAllSources?'收起来源':'查看全部来源'}}</button>
      </section>
      <button v-if="compact && changeTotal" type="button" class="changes-toggle" :aria-expanded="showChanges" @click="showChanges=!showChanges"><span>文件变更 <span class="panel-count">{{changeTotal}}</span></span><ChangeLineStats :stats="lineTotals" cumulative/><span aria-hidden="true">{{showChanges?'⌃':'⌄'}}</span></button>
      <section v-if="!compact || showChanges" class="panel-section">
        <h3 class="panel-title">文件变更 <span v-if="changes.length" class="panel-count">{{ changes.length }}</span></h3>
        <p v-if="changes.length" class="change-totals"><span>记录累计</span><ChangeLineStats :stats="lineTotals" cumulative /></p>
        <p v-if="changeTotal>changes.length" class="panel-hint">仅显示最近 {{changes.length}} 条，共 {{changeTotal}} 条；行数仅累计当前列表。</p>
        <p v-if="!changes.length" class="panel-hint">本任务没有文件变更。</p>
        <ul v-else class="change-list">
          <li v-for="change in changes" :key="change.id" class="change-item">
            <button type="button" class="change-row" :aria-expanded="expanded === change.id" @click="change.hasDiff ? toggleChange(change.id) : null" :disabled="!change.hasDiff">
              <FileIcon :name="change.relative_path" />
              <span class="change-path" :title="change.relative_path">{{ change.relative_path }}</span>
              <ChangeLineStats :stats="change.lineStats" />
              <span class="change-op" :data-op="change.operation">{{ change.reverted_at ? '已撤销' : OPERATIONS[change.operation] ?? change.operation }}</span>
              <svg v-if="change.hasDiff" class="change-chevron" :class="{ 'is-open': expanded === change.id }" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
            </button>
            <div v-if="expanded === change.id && change.hasDiff" class="change-diff">
              <div v-if="patchErrors[change.id]"><p role="alert" class="panel-error">{{patchErrors[change.id]}}</p><button class="text-btn" @click="loadPatch(change.id)">重试读取差异</button></div>
              <p v-else-if="patchLoading[change.id]" role="status" class="panel-hint">正在读取 diff…</p>
              <HighlightedDiffLines v-else-if="patches[change.id]" :patch="patches[change.id]!" :path="change.relative_path" :show-line-numbers="true" />
              <p v-else class="panel-hint">此记录没有可显示的文本差异。</p>
            </div>
          </li>
        </ul>
      </section>
      <section v-if="!compact && evidence.length" class="panel-section">
        <h3 class="panel-title">引用与来源 <span v-if="evidence.length" class="panel-count">{{ evidence.length }}</span></h3>
        <p v-if="!evidence.length" class="panel-hint">任务执行后，读取与检索的来源会显示在这里。</p>
        <ul v-else class="evidence-list">
          <li v-for="row in evidence" :key="row.invocationId" class="evidence-item">
            <span class="evidence-tool">{{ row.tool }}</span>
            <span class="evidence-summary">{{ row.summary }}</span>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
<style scoped>
.run-panel{display:flex;flex-direction:column;gap:24px;padding:20px 18px 28px;min-width:0;line-height:1.6}.run-panel.is-preview{padding:0;gap:0}
.panel-section{display:flex;flex-direction:column;gap:10px;min-width:0}
.panel-title{margin:0;padding-bottom:8px;border-bottom:1px solid var(--border);font-size:var(--text-ui-base);font-weight:600;color:var(--fg);display:flex;align-items:center;gap:6px}
.panel-count{font:var(--text-ui-sm) var(--font-mono);color:var(--fg-subtlest)}
.panel-hint{margin:0;font-size:var(--text-ui-sm);color:var(--fg-subtle)}
.panel-error{margin:0;font-size:var(--text-ui-sm);color:var(--danger)}
.change-list,.artifact-list,.evidence-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.change-item{min-width:0}
.change-totals{display:flex;align-items:center;gap:8px;margin:0;font-size:var(--text-ui-caption);color:var(--fg-subtlest)}
.change-row{display:flex;width:100%;align-items:center;gap:8px;min-width:0;border:0;background:none;padding:6px 8px;border-radius:8px;cursor:pointer;text-align:left;color:var(--fg);font-size:var(--text-ui-base);min-height:44px}
.change-row:hover{background:var(--color-surface-hover)}
.change-row:disabled{cursor:default}
.change-row:disabled:hover{background:none}
.change-path{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-ui)}
.change-op{flex-shrink:0;font-size:var(--text-ui-caption);color:var(--fg-subtle)}
.change-op[data-op=create]{color:var(--color-diff-added)}
.change-op[data-op=delete]{color:var(--color-diff-removed)}
.change-chevron{flex-shrink:0;color:var(--fg-subtlest);opacity:0;transition:transform 200ms cubic-bezier(0,0,.2,1),opacity 200ms cubic-bezier(0,0,.2,1)}
.change-row:hover .change-chevron{opacity:1}
.change-chevron.is-open{transform:rotate(90deg);opacity:1}
.change-diff{margin:4px 0 8px;max-height:min(60dvh,560px);overflow:auto;border-radius:12px;border:1px solid var(--border);background:var(--bg-card)}
.artifact-item{display:flex;align-items:center;gap:12px;min-width:0;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--bg-card)}
.artifact-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.artifact-name{margin:0;padding:0;border:0;background:transparent;text-align:left;font:inherit;font-size:var(--text-ui-base);font-weight:500;color:var(--fg);overflow-wrap:anywhere}
button.artifact-name{cursor:pointer}
.artifact-size{font-size:var(--text-ui-sm);color:var(--fg-subtlest)}
.artifact-actions{display:flex;gap:6px;flex-shrink:0}
.artifact-actions button,.artifact-actions a{border:1px solid var(--border);background:transparent;border-radius:6px;padding:4px 8px;font:inherit;font-size:var(--text-ui-sm);color:var(--fg-subtle);text-decoration:none;cursor:pointer;white-space:nowrap}
.artifact-actions button:hover,.artifact-actions a:hover{background:var(--hover);color:var(--fg)}
.output-empty{padding:16px 12px;border:1px dashed var(--border);border-radius:8px}
.evidence-item{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:var(--text-ui-sm);padding:4px 8px;border-radius:8px}
.evidence-tool{flex-shrink:0;font-family:var(--font-mono);font-size:var(--text-ui-caption);color:var(--fg-subtlest)}
.evidence-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg-subtle);font-family:var(--font-mono)}
</style>

<style scoped>
.is-compact{gap:12px;padding:0 16px 14px}
.is-compact .panel-title{font-weight:500;color:var(--fg-subtle);border:0;padding:0}
.is-compact .output-empty{padding:8px 0 0;border:0;color:var(--fg-subtlest)}
.is-compact .artifact-item{border:0;border-radius:8px;background:transparent;padding:4px 0;gap:8px}
.is-compact .artifact-name{font-size:var(--text-ui-sm)}
.is-compact .artifact-actions{gap:4px}
.is-compact .artifact-actions button,.is-compact .artifact-actions a{border:0;padding:5px;font-size:var(--text-ui-caption)}
.sources-section{border-top:1px solid var(--border);padding-top:12px;gap:6px}
.is-compact .evidence-item{border:0;background:transparent;box-shadow:none;border-radius:0;padding:4px 0;gap:8px;align-items:center}
.is-compact .evidence-summary{font-family:var(--font-ui);font-size:var(--text-ui-sm)}
.attachment-source{display:flex;align-items:center;gap:8px;padding:4px 0;text-decoration:none;color:var(--fg-subtle);font-size:var(--text-ui-sm);min-width:0}
.attachment-source img{width:24px;height:24px;border-radius:4px;object-fit:cover;flex:none;border:1px solid var(--border)}
.attachment-source span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.source-toggle,.changes-toggle{border:0;background:transparent;color:var(--fg-subtle);font:inherit;font-size:var(--text-ui-sm);text-align:left;cursor:pointer;border-radius:6px}
.source-toggle{align-self:flex-start;padding:4px 0}
.changes-toggle{display:flex;align-items:center;gap:10px;border-top:1px solid var(--border);border-radius:0;padding:10px 0 0}
.changes-toggle>span:first-child{flex:1}
.source-toggle:hover,.attachment-source:hover,.changes-toggle:hover{color:var(--fg)}
</style>

<script setup lang="ts">
// 编辑项目：交互复刻 ZCode ProjectEditor 编辑态（名称+roots 行列表+主要标记+移除+删除，Apache-2.0）。
// 保存=PATCH {name, folders} 整表提交；现有授权以 grantId 保留，新选文件夹走 picker 票据；首项为主要目录。
// 删除=复用归档语义（PATCH {archived:true}），运行中任务由后端 RESOURCE_BUSY 拦截。
import { ref, onMounted, onUnmounted, nextTick } from 'vue';
import ConfirmationDialog from './ConfirmationDialog.vue';
import ErrorBanner from './ErrorBanner.vue';
import { ApiError, startProjectDirectoryPicker, v1 } from '../api';
import { describeApiError, type ErrorPresentation } from '../ui/errorPresentation';
interface GrantView { id:string; displayName:string; access:string; isPrimary:boolean }
interface Selection { id:string; nonce:string; expiresAt:string }
type RootRow = { key:string; kind:'grant'; grantId:string; name:string } | { key:string; kind:'ticket'; ticket:Selection; name:string };
type Recovery = { label:string; run:()=>void|Promise<void> };
const props = defineProps<{ project:{ id:string; name:string } }>();
const emit = defineEmits<{(e:'close'):void;(e:'saved'):void;(e:'deleted'):void}>();
const name=ref(props.project.name), rows=ref<RootRow[]>([]), loading=ref(true), loaded=ref(false);
const pickingTicket=ref<Selection>(), picking=ref(false), busy=ref(false), notice=ref('');
const error=ref<ErrorPresentation & { recovery?:Recovery; hint?:string }>();
const confirmDelete=ref(false);
const dialog=ref<HTMLElement>(), nameInput=ref<HTMLInputElement>();
let timer:ReturnType<typeof setTimeout>|undefined, disposed=false, generation=0, saved=false, seq=0;
const previousFocus=document.activeElement as HTMLElement|null;

function showFailure(cause:unknown, fallback:string, recovery?:Recovery, hint?:string){
  const failure=describeApiError(cause instanceof ApiError ? cause : undefined,fallback);
  if(failure.action?.kind==='login'){
    hint=[hint,'请重新登录后再操作。'].filter(Boolean).join(' ');
    recovery=undefined;
  }
  error.value={...failure,recovery,hint};
}
function mayRetry(cause:unknown){
  return !(cause instanceof ApiError)||cause.retryable===true||cause.status>=500;
}
async function discard(ticket?:Selection) {
  if(!ticket)return;
  try {await v1(`/api/v1/project-directory-pickers/${ticket.id}`,{method:'DELETE',body:JSON.stringify({nonce:ticket.nonce})});}catch{/* 过期票据不保存。 */}
}
function close(){if(!busy.value)emit('close');}
async function load(){
  loading.value=true;
  error.value=undefined;
  try{
    const project=await v1<{id:string;name:string;grants:GrantView[]}>(`/api/v1/projects/${props.project.id}`);
    if(disposed)return;
    // 主要目录在前（与后端 is_primary DESC 排序一致），行顺序即保存后的目录顺序。
    rows.value=project.grants.map(grant=>({key:`grant-${grant.id}`,kind:'grant',grantId:grant.id,name:grant.displayName}));
    name.value=project.name;
    loaded.value=true;
  }catch(e){
    if(!disposed)showFailure(e,'无法读取项目详情。',mayRetry(e)?{label:'重新读取',run:load}:undefined);
  }
  finally{loading.value=false;}
  if(loaded.value&&!disposed){await nextTick();nameInput.value?.focus();}
}
function finishPicking(message=''){
  pickingTicket.value=undefined;
  picking.value=false;
  notice.value=message;
}
async function pickFolder(){
  if(!loaded.value||picking.value||busy.value||rows.value.length>=10)return;
  const current=++generation;
  error.value=undefined;notice.value='';picking.value=true;
  const pickAgain={label:'重新选择文件夹',run:pickFolder};
  try{
    const ticket=await startProjectDirectoryPicker();
    if(disposed||current!==generation){void discard(ticket);return;}
    pickingTicket.value=ticket;notice.value='请在系统窗口中选择文件夹';
    async function poll(){
      if(disposed||current!==generation)return;
      try{
        const status=await v1<{state:string;directoryName:string|null}>(`/api/v1/project-directory-pickers/${ticket.id}`);
        if(disposed||current!==generation)return;
        if(status.state==='selected'){
          const dirName=status.directoryName||'本地文件夹';
          rows.value=[...rows.value,{key:`ticket-${ticket.id}-${++seq}`,kind:'ticket',ticket,name:dirName}];
          finishPicking();
          return;
        }
        if(status.state==='cancelled'){
          finishPicking('已取消选择');
          return;
        }
        if(status.state!=='pending'){
          finishPicking();
          showFailure(undefined,status.state==='expired'?'文件夹选择已过期。':'文件夹选择未完成。',pickAgain);
          return;
        }
        timer=setTimeout(()=>void poll(),400);
      }catch(e){
        if(disposed||current!==generation)return;
        await discard(ticket);
        if(disposed||current!==generation)return;
        finishPicking();
        showFailure(e,'无法确认文件夹选择结果。',pickAgain);
      }
    }
    void poll();
  }catch(e){
    if(disposed||current!==generation)return;
    finishPicking();
    showFailure(e,'无法打开文件夹选择器。',mayRetry(e)?pickAgain:undefined);
  }
}
function makePrimary(index:number){
  if(index<=0)return;
  const list=[...rows.value];const [item]=list.splice(index,1);
  if(item)rows.value=[item,...list];
}
async function removeRoot(index:number){
  const [item]=rows.value.splice(index,1);
  if(item&&item.kind==='ticket')void discard(item.ticket);
}
async function submit(){
  if(!loaded.value||!name.value.trim()||!rows.value.length||picking.value||busy.value)return;
  busy.value=true;error.value=undefined;notice.value='';
  try{
    await v1(`/api/v1/projects/${props.project.id}`,{method:'PATCH',body:JSON.stringify({
      name:name.value.trim(),
      folders:rows.value.map(row=>row.kind==='grant'?{grantId:row.grantId}:{pickerTicket:row.ticket.id,nonce:row.ticket.nonce,access:'write'}),
    })});
    saved=true;emit('saved');
  }catch(e){
    const rejected=e instanceof ApiError&&e.status>=400&&e.status<500;
    showFailure(e,'无法确认项目是否保存。',
      rejected&&e.retryable?{label:'再次保存',run:submit}:undefined,
      rejected?'本次编辑内容仍在弹窗中。':'本次编辑内容仍在弹窗中。请先核对项目当前配置，再决定是否重试。');
  }finally{busy.value=false;}
}
async function removeProject(){
  if(!loaded.value||busy.value||picking.value)return;
  busy.value=true;error.value=undefined;notice.value='';
  try{
    await v1(`/api/v1/projects/${props.project.id}`,{method:'PATCH',body:JSON.stringify({archived:true})});
    confirmDelete.value=false;emit('deleted');
  }catch(e){
    confirmDelete.value=false;
    showFailure(e,'无法确认项目是否已归档。',mayRetry(e)?{label:'再次确认归档',run:()=>{confirmDelete.value=true;}}:undefined);
  }finally{busy.value=false;}
}
function onKey(event:KeyboardEvent){
  if(event.key==='Escape'){event.stopPropagation();event.preventDefault();close();}
  if(event.key!=='Tab')return;
  const items=[...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]:not([style*="display: none"])')??[])];
  if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items.at(-1)?.focus();}
  else if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0]?.focus();}
}
onMounted(()=>{dialog.value?.focus();void load();});
onUnmounted(()=>{
  disposed=true;generation++;clearTimeout(timer);
  if(!saved){
    void discard(pickingTicket.value);
    for(const row of rows.value)if(row.kind==='ticket')void discard(row.ticket);
  }
  previousFocus?.focus();
});
</script>

<template>
<Teleport to="body"><div class="project-overlay" @click.self="close"><section ref="dialog" class="project-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-project-title" tabindex="-1" @keydown="onKey">
  <header><h2 id="edit-project-title">编辑项目</h2><button class="icon-btn" type="button" aria-label="关闭编辑项目" :disabled="busy" @click="close">×</button></header>
  <form @submit.prevent="submit">
    <label class="project-field">项目名称<input ref="nameInput" v-model="name" maxlength="120" :disabled="busy||!loaded" required></label>
    <div class="project-field"><span>源文件夹</span>
      <p v-if="loading" class="project-notice" role="status">正在读取项目文件夹…</p>
      <div v-else-if="loaded" class="project-roots">
        <div v-for="(row,index) in rows" :key="row.key" class="project-root-row">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/></svg>
          <strong class="project-root-name">{{row.name}}</strong>
          <span v-if="index===0" class="project-root-badge">主要</span>
          <button v-else class="text-btn project-root-primary" type="button" :disabled="busy||picking" @click="makePrimary(index)">设为主要</button>
          <button class="icon-btn project-root-remove" type="button" :aria-label="`移除 ${row.name}`" :disabled="busy||picking" @click="removeRoot(index)">×</button>
        </div>
        <button class="project-root-add" type="button" :disabled="busy||picking||rows.length>=10" :title="rows.length>=10?'最多10个文件夹':''" @click="pickFolder">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M12 10v6m-3-3h6"/></svg>
          {{picking?'等待选择文件夹…':rows.length>=10?'已达文件夹上限':'添加文件夹'}}
        </button>
      </div>
    </div>
    <p v-if="loaded" class="project-access-hint">首个文件夹为主要工作目录，其余文件夹Agent可直接读写；移除文件夹不影响任务与原始文件。</p>
    <p v-if="notice" class="project-notice" role="status">{{notice}}</p>
    <ErrorBanner v-if="error" :message="[error.message,error.hint].filter(Boolean).join(' ')" :detail="error.detail" :code="error.code" :request-id="error.requestId" :action-label="error.recovery?.label" @action="error.recovery?.run()"/>
    <footer><button class="btn btn-ghost-danger" type="button" style="margin-right:auto" :disabled="busy||picking||!loaded" @click="confirmDelete=true">删除项目</button><button class="text-btn" type="button" :disabled="busy" @click="close">取消</button><button class="btn project-submit" type="submit" :disabled="busy||picking||!loaded||!name.trim()||!rows.length">{{busy?'正在保存…':'保存'}}</button></footer>
  </form>
  <ConfirmationDialog v-if="confirmDelete" :title="`删除项目「${props.project.name}」？`" description="项目会从侧栏移除，任务与原始文件都会保留，可在设置·项目管理中恢复。" confirm-label="删除项目" danger :busy="busy" @close="confirmDelete=false" @confirm="removeProject"/>
</section></div></Teleport>
</template>

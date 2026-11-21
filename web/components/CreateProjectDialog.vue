<script setup lang="ts">
// 多文件夹创建：交互复刻 ZCode ProjectEditor（roots 列表+主要标记+重复添加行，Apache-2.0）。
// 契约：folders[0] 为主要工作目录；后端按 canonical 路径去重并折叠同请求重复文件夹。
import { ref, onMounted, onUnmounted, nextTick } from 'vue';
import { startProjectDirectoryPicker, v1 } from '../api';
interface LocalProject { id:string; name:string; archived:boolean; grant:{id:string;displayName:string;access:string} }
interface Selection { id:string; nonce:string; expiresAt:string }
const emit = defineEmits<{(e:'close'):void;(e:'created',project:LocalProject):void}>();
const name=ref(''), roots=ref<Array<{ticket:Selection;name:string}>>([]);
const pickingTicket=ref<Selection>(), picking=ref(false), busy=ref(false), error=ref(''), notice=ref('');
const dialog=ref<HTMLElement>(), nameInput=ref<HTMLInputElement>();
let timer:ReturnType<typeof setTimeout>|undefined, disposed=false, generation=0, created=false;
const previousFocus=document.activeElement as HTMLElement|null;
async function discard(ticket?:Selection) {
  if(!ticket)return;
  try {await v1(`/api/v1/project-directory-pickers/${ticket.id}`,{method:'DELETE',body:JSON.stringify({nonce:ticket.nonce})});}catch{/* 过期票据不创建项目。 */}
}
function close(){if(!busy.value)emit('close');}
async function pickFolder(){
  if(picking.value||busy.value||roots.value.length>=10)return;
  const current=++generation; error.value='';notice.value='';picking.value=true;
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
          roots.value=[...roots.value,{ticket,name:dirName}];pickingTicket.value=undefined;picking.value=false;notice.value='';
          if(roots.value.length===1&&!name.value.trim())name.value=dirName.slice(0,120);
          return;
        }
        if(status.state!=='pending'||Date.now()>=Date.parse(ticket.expiresAt)){
          picking.value=false;pickingTicket.value=undefined;notice.value=status.state==='cancelled'?'已取消选择，尚未创建项目':'文件夹选择未完成，请重试';return;
        }
        timer=setTimeout(()=>void poll(),400);
      }catch(e){if(!disposed&&current===generation){picking.value=false;pickingTicket.value=undefined;error.value=e instanceof Error?e.message:'文件夹选择失败';}}
    }
    void poll();
  }catch(e){if(!disposed&&current===generation){picking.value=false;error.value=e instanceof Error?e.message:'无法打开文件夹选择器';}}
}
function makePrimary(index:number){
  if(index<=0)return;
  const list=[...roots.value];const [item]=list.splice(index,1);
  if(item)roots.value=[item,...list];
}
async function removeRoot(index:number){
  const [item]=roots.value.splice(index,1);
  if(item)void discard(item.ticket);
}
async function submit(){
  if(!name.value.trim()||!roots.value.length||picking.value||busy.value)return;
  busy.value=true;error.value='';
  try{
    const project=await v1<LocalProject>('/api/v1/projects/local',{method:'POST',body:JSON.stringify({name:name.value.trim(),folders:roots.value.map(root=>({pickerTicket:root.ticket.id,nonce:root.ticket.nonce,access:'write'}))})});
    created=true;emit('created',project);
  }catch(e){error.value=e instanceof Error?e.message:'项目创建失败，请重试';}finally{busy.value=false;}
}
function onKey(event:KeyboardEvent){
  if(event.key==='Escape'){event.stopPropagation();event.preventDefault();close();}
  if(event.key!=='Tab')return;
  const items=[...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')??[])];
  if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items.at(-1)?.focus();}
  else if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0]?.focus();}
}
onMounted(async()=>{await nextTick();nameInput.value?.focus();});
onUnmounted(()=>{disposed=true;generation++;if(timer)clearTimeout(timer);if(!created)void discard(pickingTicket.value);previousFocus?.focus();});
</script>

<template>
<Teleport to="body"><div class="project-overlay" @click.self="close"><section ref="dialog" class="project-dialog" role="dialog" aria-modal="true" aria-labelledby="create-project-title" @keydown="onKey">
  <header><h2 id="create-project-title">创建项目</h2><button class="icon-btn" type="button" aria-label="关闭创建项目" :disabled="busy" @click="close">×</button></header>
  <form @submit.prevent="submit">
    <label class="project-field">项目名称<input ref="nameInput" v-model="name" placeholder="新项目" maxlength="120" :disabled="busy" required></label>
    <div class="project-field"><span>设备</span><div class="project-device"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>此电脑</div></div>
    <div class="project-field"><span>源文件夹</span>
      <button v-if="!roots.length" class="project-folder-choice" type="button" :disabled="busy||picking" @click="pickFolder"><span class="project-folder-icon"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M12 10v7m-3-3.5h6"/></svg></span><strong>{{picking?'等待选择文件夹…':'选择文件夹'}}</strong><small>选择Agent的主要工作目录</small></button>
      <div v-else class="project-roots">
        <div v-for="(root,index) in roots" :key="root.ticket.id" class="project-root-row">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/></svg>
          <strong class="project-root-name">{{root.name}}</strong>
          <span v-if="index===0" class="project-root-badge">主要</span>
          <button v-else class="text-btn project-root-primary" type="button" :disabled="busy||picking" @click="makePrimary(index)">设为主要</button>
          <button class="icon-btn project-root-remove" type="button" :aria-label="`移除 ${root.name}`" :disabled="busy||picking" @click="removeRoot(index)">×</button>
        </div>
        <button class="project-root-add" type="button" :disabled="busy||picking||roots.length>=10" :title="roots.length>=10?'最多10个文件夹':''" @click="pickFolder">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M12 10v6m-3-3h6"/></svg>
          {{picking?'等待选择文件夹…':roots.length>=10?'已达文件夹上限':'添加文件夹'}}
        </button>
      </div>
    </div>
    <p class="project-access-hint">首个文件夹为主要工作目录，其余文件夹Agent可直接读写；也可访问本机账户有权限的其他文件夹。</p>
    <p v-if="notice" class="project-notice" role="status">{{notice}}</p><p v-if="error" class="project-error" role="alert">{{error}}</p>
    <footer><button class="text-btn" type="button" :disabled="busy" @click="close">取消</button><button class="btn project-submit" type="submit" :disabled="busy||picking||!name.trim()||!roots.length">{{busy?'正在创建…':'创建项目'}}</button></footer>
  </form>
</section></div></Teleport>
</template>

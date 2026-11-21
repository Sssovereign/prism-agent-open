<script setup lang="ts">
import UiSelect from './UiSelect.vue';
import UiIcon from './UiIcon.vue';
// ZCode ArchiveManagement + ArchiveGroupCard + useArchiveManagement, native Vue commands.
import {ref,computed,onMounted,onUnmounted,watch} from 'vue';
import ConfirmationDialog from './ConfirmationDialog.vue';
import {v1} from '../api';
import type {SidebarTree,SidebarTask} from '../view-model/sidebar';
const emit=defineEmits<{(e:'changed'):void;(e:'modal-change',active:boolean):void}>();
const tree=ref<SidebarTree>({projects:[],tasks:[],groups:[]}),query=ref(''),project=ref('all'),sort=ref<'updatedAt'|'createdAt'>('updatedAt');
const loading=ref(true),busy=ref(false),error=ref(''),result=ref(''),open=ref<string[]>([]),limits=ref<Record<string,number>>({}),pending=ref<SidebarTask[]>([]);
let disposed=false;
watch(pending,value=>emit('modal-change',!!value.length));
async function load(){loading.value=true;error.value='';try{const data=await v1<SidebarTree>('/api/v1/sidebar');if(!disposed)tree.value=data;}catch(e){if(!disposed)error.value=e instanceof Error?e.message:'归档读取失败';}finally{loading.value=false;}}
const rows=computed(()=>tree.value.tasks.filter(t=>t.archivedAt&&(!query.value||t.title.toLocaleLowerCase().includes(query.value.toLocaleLowerCase()))&&(project.value==='all'||t.projectId===project.value)).sort((a,b)=>b[sort.value].localeCompare(a[sort.value])||a.id.localeCompare(b.id)));
const groups=computed(()=>tree.value.projects.map(p=>({...p,tasks:rows.value.filter(t=>t.projectId===p.id)})).filter(p=>p.tasks.length));
function toggle(id:string){open.value=open.value.includes(id)?open.value.filter(x=>x!==id):[...open.value,id];}
async function run(candidates:SidebarTask[],operation:'restore'|'delete'){
 if(busy.value||!candidates.length)return;
 const fixed=[...new Map(candidates.filter(t=>t.archivedAt).map(t=>[t.id,t])).values()];
 if(operation==='delete'){pending.value=fixed;return;}
 await apply(fixed,operation);
}
async function apply(candidates:SidebarTask[],operation:'restore'|'delete'){
 if(busy.value)return;busy.value=true;error.value='';result.value='';pending.value=[];
 let succeeded=0,failed=0;
 for(const t of candidates){
  try{await v1(`/api/v1/conversations/${t.id}`,{method:operation==='delete'?'DELETE':'PATCH',body:JSON.stringify(operation==='delete'?{confirmed:true}:{archived:false})});succeeded++;}
  catch{failed++;}
 }
 await load();busy.value=false;emit('changed');result.value=`${operation==='delete'?'已删除':'已恢复'} ${succeeded} 个任务${failed?`，${failed} 个未完成，请刷新核对后重试`:''}`;
}
function format(iso:string){return new Date(iso).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}
onMounted(load);onUnmounted(()=>{disposed=true;emit('modal-change',false);});
</script>
<template>
<section class="archive-management" aria-label="归档管理">
 <div class="management-heading"><p>管理已归档的任务，或将它们恢复到任务列表。</p><button class="btn danger-quiet" :disabled="busy||loading||!!error||!rows.length" @click="run([...rows],'delete')">删除筛选结果</button></div>
 <div class="management-filters"><input v-model="query" aria-label="搜索归档任务" placeholder="搜索归档任务…"><label>排序<UiSelect v-model="sort" label="归档排序" :options="[{value:'updatedAt',label:'最近更新'},{value:'createdAt',label:'创建时间'}]"/></label><UiSelect v-model="project" label="筛选归档项目" :options="[{value:'all',label:'全部项目'},...tree.projects.map(p=>({value:p.id,label:p.name}))]"/></div>
 <p v-if="loading" role="status" class="settings-footnote">正在读取归档…</p><p v-if="error" role="alert" class="error-text">{{error}} <button class="text-btn" @click="load">重试</button></p><p v-if="result" role="status" class="settings-feedback">{{result}}</p>
 <div v-if="!loading&&!error&&!rows.length" class="settings-empty"><h2>没有已归档任务</h2><p>从任务菜单归档后，可在这里找到它们。</p></div>
 <section v-for="group in groups" :key="group.id" class="archive-project-group"><div class="archive-project-heading"><button class="archive-collapse" :aria-expanded="open.includes(group.id)" @click="toggle(group.id)"><UiIcon :name="open.includes(group.id)?'chevron-down':'chevron-right'"/><strong>{{group.name}}</strong><small>{{group.tasks.length}} 个任务</small></button><button class="text-btn" :disabled="busy" @click="run([...group.tasks],'restore')">全部恢复</button><button class="icon-btn" :aria-label="`删除项目${group.name}的归档`" :disabled="busy" @click="run([...group.tasks],'delete')"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v7M14 10v7"/></svg></button></div>
 <div v-if="open.includes(group.id)" class="archive-task-list"><div v-for="task in group.tasks.slice(0,limits[group.id]||50)" :key="task.id" class="archive-task-row"><div><strong>{{task.title}}</strong><time :datetime="task[sort]">{{format(task[sort])}}</time></div><button class="icon-btn" :aria-label="`删除归档任务：${task.title}`" :disabled="busy" @click="run([task],'delete')"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v7M14 10v7"/></svg></button><button class="btn" :disabled="busy" :aria-label="`恢复任务：${task.title}`" @click="run([task],'restore')">恢复</button></div><button v-if="group.tasks.length>(limits[group.id]||50)" class="text-btn management-more" @click="limits[group.id]=(limits[group.id]||50)+50">显示更多</button></div></section>
 <ConfirmationDialog v-if="pending.length" :title="`删除 ${pending.length} 个归档任务？`" description="这会永久删除所选任务的会话记录，无法恢复。项目中的原始文件不会删除。" confirm-label="永久删除" danger @close="pending=[]" @confirm="apply([...pending],'delete')"/>

</section>
</template>

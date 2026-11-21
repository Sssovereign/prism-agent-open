<script setup lang="ts">
import UiSelect from './UiSelect.vue';
// ZCode ProjectManagement list/search/sort/removal/recovery, using existing local project commands.
import {ref,computed,onMounted,onUnmounted,watch} from 'vue';
import ConfirmationDialog from './ConfirmationDialog.vue';
import EditProjectDialog from './EditProjectDialog.vue';
import {v1} from '../api';
import type {SidebarTree,SidebarProject} from '../view-model/sidebar';
const emit=defineEmits<{(e:'changed'):void;(e:'modal-change',active:boolean):void;(e:'open-project',id:string):void;(e:'create-project'):void}>();
const tree=ref<SidebarTree>({projects:[],tasks:[],groups:[]}),query=ref(''),sort=ref('lastActive'),filter=ref('all'),loading=ref(true),busy=ref(false),error=ref(''),notice=ref('');
const selected=ref<string[]>([]),pending=ref<SidebarProject[]>([]),editing=ref<{id:string;name:string}>();
const editingProject=ref<{id:string;name:string}>();
let disposed=false;
watch([pending,editing,editingProject],()=>emit('modal-change',!!pending.value.length||!!editing.value||!!editingProject.value));
async function load(){loading.value=true;try{const data=await v1<SidebarTree>('/api/v1/sidebar');if(!disposed)tree.value=data;}catch(e){error.value=e instanceof Error?e.message:'项目读取失败';}finally{loading.value=false;}}
const projects=computed(()=>tree.value.projects.map(p=>({...p,count:tree.value.tasks.filter(t=>t.projectId===p.id).length,lastActive:tree.value.tasks.filter(t=>t.projectId===p.id).map(t=>t.updatedAt).sort().at(-1)||''})).filter(p=>!p.archivedAt&&p.name.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())&&(filter.value!=='empty'||p.count===0)).sort((a,b)=>sort.value==='name'?a.name.localeCompare(b.name,'zh-CN'):sort.value==='sessions'?b.count-a.count:b.lastActive.localeCompare(a.lastActive)));
const removed=computed(()=>tree.value.projects.filter(p=>p.archivedAt));
const chosen=computed(()=>projects.value.filter(p=>selected.value.includes(p.id)));
function check(id:string,event:Event){selected.value=(event.target as HTMLInputElement).checked?[...selected.value,id]:selected.value.filter(x=>x!==id);}
async function mutate(id:string,body:Record<string,unknown>){await v1(`/api/v1/projects/${id}`,{method:'PATCH',body:JSON.stringify(body)});}
async function batch(rows:SidebarProject[],restore=false){if(busy.value)return;busy.value=true;error.value='';pending.value=[];let done=0,failed=0;for(const row of [...rows]){try{await mutate(row.id,{archived:!restore});done++;}catch{failed++;}}await load();busy.value=false;selected.value=[];notice.value=`已${restore?'恢复':'移除'} ${done} 个项目${failed?`，${failed} 个未完成（请先停止项目内的任务）`:''}`;emit('changed');}
async function rename(){if(!editing.value?.name.trim()||busy.value)return;busy.value=true;try{await mutate(editing.value.id,{name:editing.value.name.trim()});editing.value=undefined;await load();emit('changed');}catch(e){error.value=e instanceof Error?e.message:'改名失败';}finally{busy.value=false;}}
async function onEdited(message:string){editingProject.value=undefined;notice.value=message;await load();emit('changed');}
onMounted(load);onUnmounted(()=>{disposed=true;emit('modal-change',false);});
</script>
<template>
<section aria-label="项目管理" class="project-management">
 <div class="management-heading"><p>管理本机项目及任务。移除项目不会删除原始文件。</p><button class="btn" @click="emit('create-project')">创建项目</button></div>
 <div class="management-filters"><input v-model="query" aria-label="搜索项目" placeholder="搜索项目…"><UiSelect v-model="filter" label="筛选项目" :options="[{value:'all',label:'全部项目'},{value:'empty',label:'没有任务的项目'}]"/><UiSelect v-model="sort" label="项目排序" :options="[{value:'lastActive',label:'最近活动'},{value:'name',label:'项目名称'},{value:'sessions',label:'任务数量'}]"/></div>
 <div v-if="chosen.length" class="management-selection"><span>已选择 {{chosen.length}} 个项目</span><button class="text-btn" :disabled="busy" @click="pending=[...chosen]">移除所选</button><button class="text-btn" @click="selected=[]">取消选择</button></div>
 <p v-if="loading" class="settings-footnote" role="status">正在读取项目…</p><p v-if="error" class="error-text" role="alert">{{error}}</p><p v-if="notice" class="settings-feedback" role="status">{{notice}}</p>
 <div class="management-table" v-if="projects.length"><div v-for="p in projects" :key="p.id" class="management-project-row"><input type="checkbox" :aria-label="`选择项目：${p.name}`" :checked="selected.includes(p.id)" @change="check(p.id,$event)"><div class="management-project-title"><button class="text-btn" @click="emit('open-project',p.id)">{{p.name}}</button><small>{{p.folderName||'尚未绑定本地文件夹'}} · {{p.count}} 个任务</small></div><button class="text-btn" :aria-label="`编辑项目：${p.name}`" @click="editingProject={id:p.id,name:p.name}">编辑</button><button class="text-btn" :aria-label="`重命名项目：${p.name}`" @click="editing={id:p.id,name:p.name}">改名</button><button class="text-btn" :disabled="busy" :aria-label="`移除项目：${p.name}`" @click="pending=[p]">移除</button></div></div>
 <p v-else-if="!loading" class="settings-footnote">没有符合条件的项目。</p>
 <details v-if="removed.length" class="management-removed"><summary>已移除项目（{{removed.length}}）</summary><div v-for="p in removed" :key="p.id" class="management-project-row"><span class="grow">{{p.name}}</span><button class="btn" :disabled="busy" :aria-label="`恢复项目：${p.name}`" @click="batch([p],true)">恢复</button></div></details>
 <ConfirmationDialog v-if="pending.length" :title="`移除 ${pending.length} 个项目？`" description="项目会从侧栏隐藏，任务与原始文件都会保留。可以在此页的‘已移除项目’中恢复。" confirm-label="移除项目" danger @close="pending=[]" @confirm="batch([...pending])"/>
 <ConfirmationDialog v-if="editing" title="重命名项目" confirm-label="保存" focus-input :busy="busy" :confirm-disabled="!editing.name.trim()" @close="editing=undefined" @confirm="rename"><label class="project-field">项目名称<input v-model="editing.name" maxlength="120" required @keydown.enter.prevent="rename"></label></ConfirmationDialog>
 <EditProjectDialog v-if="editingProject" :project="editingProject" @close="editingProject=undefined" @saved="onEdited('项目已保存')" @deleted="onEdited('项目已移除')"/>

</section>
</template>

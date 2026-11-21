<script setup lang="ts">
import UiSelect from './UiSelect.vue';
import ComposerSelect from './ComposerSelect.vue';
import {popupLayout} from '../ui/popupLayout';
// Vue migration of ZCode ProjectNodeContent, ProjectTaskRows, useProjectTaskActions and archive views.
import {ref,computed,onMounted,onUnmounted,watch,nextTick} from 'vue';
import {v1} from '../api';
import type {SidebarTree,SidebarTask,SidebarProject} from '../view-model/sidebar';
import SidebarTaskRow from './PrismSidebarTaskRow.vue';
import SidebarIcon from './SidebarIcon.vue';
import PrismLogo from './PrismLogo.vue';
import TaskSearchDialog from './TaskSearchDialog.vue';
import {formatShortcut,defaultBindings,ignoredKeyEvent,type ShortcutBindings} from '../keyboardShortcuts';
import {t} from '../ui/i18n/index';
const props=defineProps<{shortcuts?:ShortcutBindings;selectedId?:string;refreshKey?:string;conversationId?:string|null;username:string;projectName?:string;projectId:string;projects:Array<{id:string;name:string}>}>();
const emit=defineEmits<{
(e:'select-project',id:string):void;(e:'create-project'):void;(e:'new-task'):void;(e:'logout'):void;(e:'open-files'):void;(e:'open-settings',section?:'projects'|'archives'):void;
(e:'open-task',task:{runId:string;projectId:string}):void;(e:'project-task',id:string):void;(e:'project-files',id:string):void;(e:'projects-updated',projects:SidebarProject[]):void;(e:'task-archived',task:{runId:string;conversationId:string}):void;(e:'modal-change',value:boolean):void;(e:'edit-project',project:{id:string;name:string}):void;
(e:'close-sidebar'):void;
}>();
const tree=ref<SidebarTree>({projects:[],tasks:[],groups:[]}),error=ref(''),view=ref('projects');
const expanded=ref<string[]>([]),limits=ref<Record<string,number>>({}),busy=ref(false);
const menu=ref<{kind:'project'|'task'|'group';id:string;x:number;y:number}>();
const menuRoot=ref<HTMLElement>(),renameInput=ref<HTMLInputElement>();
const taskSearch=ref<InstanceType<typeof TaskSearchDialog>>();
const viewOptions=[{id:'projects',icon:'folder'},{id:'grouped',icon:'hash'},{id:'timeline',icon:'clock'},{id:'unread',icon:'bell'}] as const;
const viewPicker=ref<InstanceType<typeof ComposerSelect>>();
// 视图标签走 i18n（computed：语言切换即重算），图标等结构字段保持静态。
const viewChoices=computed(()=>viewOptions.map(view=>({value:view.id,label:t(`sidebar.view.${view.id}`)})));
const editing=ref<{kind:'project'|'task'|'group'|'new-group';id:string;name:string}>();
let timer:ReturnType<typeof setInterval>|undefined,disposed=false,loadFlight:Promise<void>|undefined;
let menuTrigger:HTMLElement|null=null;
let menuAnchor={x:0,y:0};
function placeActions(){if(!menu.value||!menuRoot.value)return;const fitted=popupLayout({left:menuAnchor.x,right:menuAnchor.x,top:menuAnchor.y,bottom:menuAnchor.y},{left:0,top:0,width:window.innerWidth,height:window.innerHeight},{width:220,height:menuRoot.value.scrollHeight+2,maxHeight:window.innerHeight-16,gap:0});menu.value={...menu.value,x:fitted.left,y:fitted.top};}
function closeActionsOnScroll(event:Event){if(event.target instanceof Element&&(menuRoot.value?.contains(event.target)||event.target.closest('.composer-select-panel')))return;closeMenu(false);}
const manualUnread=new Set<string>(),reading=new Set<string>();
const prefKey=computed(()=>`prism-sidebar:${props.username}`);
try{const p=JSON.parse(localStorage.getItem(prefKey.value)||'{}');view.value=['projects','grouped','timeline','unread'].includes(p.view)?p.view:'projects';expanded.value=Array.isArray(p.expanded)?p.expanded:[];}catch{/* defaults */}
watch([view,expanded],()=>{try{localStorage.setItem(prefKey.value,JSON.stringify({view:view.value,expanded:expanded.value}));}catch{}},{deep:true});
watch(editing,value=>emit('modal-change',!!value));
watch(()=>props.projectId,id=>{if(id&&!expanded.value.includes(id))expanded.value=[...expanded.value,id];},{immediate:true});
async function load(force=false){
 if(disposed)return;
 if(force){while(loadFlight)await loadFlight;}else if(loadFlight)return loadFlight;
 const flight=(async()=>{
  try{const data=await v1<SidebarTree>('/api/v1/sidebar');if(disposed)return;tree.value=data;emit('projects-updated',data.projects);void readActiveTask();}catch(e){if(!disposed)error.value=e instanceof Error?e.message:t('sidebar.loadFailed');}
 })();
 loadFlight=flight;try{await flight;}finally{if(loadFlight===flight)loadFlight=undefined;}
}
watch(()=>props.refreshKey,()=>{void load(true);});
watch(()=>props.conversationId||props.selectedId,(id,previous)=>{if(previous&&previous!==id)manualUnread.clear();void readActiveTask();});
async function readActiveTask(){
 if(disposed||busy.value||document.visibilityState!=='visible')return;
 const task=tree.value.tasks.find(t=>props.conversationId?t.id===props.conversationId:t.runId===props.selectedId);
 if(!task?.unreadAt||manualUnread.has(task.id)||reading.has(task.id))return;
 const marker=task.unreadAt;reading.add(task.id);
 try{
  await v1(`/api/v1/conversations/${task.id}`,{method:'PATCH',body:JSON.stringify({unread:false,readThrough:marker})});
  const current=tree.value.tasks.find(t=>t.id===task.id);
  if(!disposed&&current?.unreadAt===marker)current.unreadAt=null;
 }catch(e){if(!disposed)error.value=e instanceof Error?e.message:t('sidebar.readFailed');}finally{reading.delete(task.id);}
}
function onVisibility(){if(document.visibilityState==='visible')void load(true);}
const available=computed(()=>tree.value.projects.filter(p=>!p.archivedAt));
// 侧栏接口把置顶行排最前（ORDER BY pinned_at IS NULL）；显示层统一按更新时间排序——
// 置顶只新增「置顶区」入口，不改变任务在项目/分组/时间线里的原位置。
const tasks=computed(()=>tree.value.tasks.filter(t=>!t.archivedAt&&available.value.some(p=>p.id===t.projectId)).sort((a,b)=>a.updatedAt<b.updatedAt?1:a.updatedAt>b.updatedAt?-1:0));
const pinned=computed(()=>tasks.value.filter(t=>t.pinnedAt&&(view.value!=='unread'||t.unreadAt)));
// 置顶任务保留原位置：置顶区只是额外入口（对齐 ZCode「pinnedTasks 只负责标识样式」），
// 置顶区与项目/分组/时间线渲染同一任务对象，两个窗口指向同一任务。
const regular=computed(()=>tasks.value);
const visibleProjects=computed(()=>available.value);
// 置顶项目进入置顶专属位置：项目视图先渲染置顶组，再渲染常规「项目」分区（对齐 ZCode pinned 组在先）。
const pinnedProjects=computed(()=>visibleProjects.value.filter(p=>p.pinnedAt));
const unpinnedProjects=computed(()=>visibleProjects.value.filter(p=>!p.pinnedAt));
const selectedProject=computed(()=>tree.value.projects.find(p=>p.id===props.projectId));
const menuTask=computed(()=>tree.value.tasks.find(t=>t.id===menu.value?.id));
const menuProject=computed(()=>tree.value.projects.find(p=>p.id===menu.value?.id));
const grouped=computed(()=>[...tree.value.groups,{id:'',name:t('sidebar.ungrouped')}]);
const otherRows=computed(()=>view.value==='unread'?regular.value.filter(t=>t.unreadAt):regular.value);
function projectTasks(id:string){return regular.value.filter(t=>t.projectId===id);}
function projectLabel(task:SidebarTask){return tree.value.projects.find(p=>p.id===task.projectId)?.name||t('sidebar.defaultProject');}
function isExpanded(id:string){return expanded.value.includes(id);}
function projectHasUnread(id:string){return tasks.value.some(t=>t.projectId===id&&t.unreadAt);}
function toggleProject(id:string){if(expanded.value.includes(id))expanded.value=expanded.value.filter(x=>x!==id);else expanded.value=[...expanded.value,id];emit('select-project',id);}
function projectKey(event:KeyboardEvent,id:string){
 if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();if(event.key==='ArrowRight'&&!expanded.value.includes(id))expanded.value=[...expanded.value,id];if(event.key==='ArrowLeft')expanded.value=expanded.value.filter(x=>x!==id);}
 if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){event.preventDefault();openMenu('project',event,id);}
}
// 搜索绑定由 App 统一分派，避免独立全局监听绕过自定义配置与模态作用域。
function openSearch(){if(document.querySelector('[role=dialog][aria-modal=true]'))return;taskSearch.value?.openDialog();}
function closeMenu(restore=true){menu.value=undefined;if(restore&&menuTrigger?.isConnected)menuTrigger.focus();}
function navigateMenu(event:KeyboardEvent,root:HTMLElement|undefined,selector:string){if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const nodes=[...(root?.querySelectorAll<HTMLElement>(selector)??[])];const i=nodes.indexOf(document.activeElement as HTMLElement);nodes[event.key==='Home'?0:event.key==='End'?nodes.length-1:(i+(event.key==='ArrowDown'?1:-1)+nodes.length)%nodes.length]?.focus();}
function choose(task:SidebarTask){manualUnread.delete(task.id);emit('open-task',{runId:task.runId,projectId:task.projectId});void readActiveTask();}
function openFromSearch(task:{runId:string;projectId:string}){const t=tree.value.tasks.find(t=>t.runId===task.runId);if(t)manualUnread.delete(t.id);emit('open-task',task);void readActiveTask();}
function openMenu(kind:'project'|'task'|'group',event:MouseEvent|KeyboardEvent,id:string){
 event.stopPropagation();viewPicker.value?.close(false);document.dispatchEvent(new CustomEvent('composer-picker-open',{detail:'sidebar-actions'}));menuTrigger=event.currentTarget as HTMLElement;
 const rect=menuTrigger.getBoundingClientRect();
 const pointer=event instanceof MouseEvent&&event.type==='contextmenu'&&(event.clientX!==0||event.clientY!==0);
 const x=pointer?event.clientX:rect.right,y=pointer?event.clientY:rect.bottom;
 menuAnchor={x,y};menu.value={kind,id,x,y};
 void nextTick(()=>{placeActions();menuRoot.value?.querySelector<HTMLElement>('[role=menuitem]')?.focus();});
}
async function mutate(kind:'project'|'task'|'group',id:string,body:Record<string,unknown>){
 if(busy.value)return;busy.value=true;error.value='';menu.value=undefined;
 try{
  if(kind==='task'&&body.unread===true)manualUnread.add(id);
  await v1(`/api/v1/${kind==='project'?'projects':kind==='task'?'conversations':'sidebar-groups'}/${id}`,{method:'PATCH',body:JSON.stringify(body)});
  if(kind==='task'&&body.unread===false)manualUnread.delete(id);
  if(kind==='task'&&body.archived){const t=tree.value.tasks.find(t=>t.id===id);if(t)emit('task-archived',{runId:t.runId,conversationId:t.id});}
  await load(true);
 }catch(e){if(kind==='task'&&body.unread===true)manualUnread.delete(id);error.value=e instanceof Error?e.message:t('sidebar.actionFailed');}finally{busy.value=false;}
}
function rename(kind:'project'|'task'|'group'|'new-group',id='',name=''){menu.value=undefined;editing.value={kind,id,name};void nextTick(()=>{renameInput.value?.focus();renameInput.value?.select();});}
async function saveName(){
 const e=editing.value;if(!e||!e.name.trim()||busy.value)return;
 if(e.kind==='new-group'){
  busy.value=true;try{await v1('/api/v1/sidebar-groups',{method:'POST',body:JSON.stringify({name:e.name.trim()})});await load(true);editing.value=undefined;}catch(err){error.value=err instanceof Error?err.message:t('sidebar.createFailed');}finally{busy.value=false;}
 }else{await mutate(e.kind,e.id,{[e.kind==='task'?'title':'name']:e.name.trim()});if(!error.value)editing.value=undefined;}
}
async function removeGroup(id:string){if(busy.value)return;busy.value=true;menu.value=undefined;try{await v1(`/api/v1/sidebar-groups/${id}`,{method:'DELETE'});await load(true);}catch(e){error.value=e instanceof Error?e.message:t('sidebar.removeFailed');}finally{busy.value=false;}}
function dialogKey(event:KeyboardEvent){
 if(ignoredKeyEvent(event)||event.ctrlKey||event.metaKey||event.altKey)return;
 if(event.key==='Escape'&&!busy.value){event.stopPropagation();event.preventDefault();editing.value=undefined;return;}
 if(event.key!=='Tab')return;
 const nodes=[...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)')];
 if(event.shiftKey&&document.activeElement===nodes[0]){event.preventDefault();nodes.at(-1)?.focus();}
 else if(!event.shiftKey&&document.activeElement===nodes.at(-1)){event.preventDefault();nodes[0]?.focus();}
}
function projectDrag(event:DragEvent,id:string){event.dataTransfer?.setData('application/x-prism-project',id);}
async function reorder(event:DragEvent,target:SidebarProject){
 event.preventDefault();const id=event.dataTransfer?.getData('application/x-prism-project');if(!id||id===target.id||busy.value)return;
 const source=tree.value.projects.find(p=>p.id===id);if(!source||!!source.pinnedAt!==!!target.pinnedAt)return;
 const ids=available.value.map(p=>p.id);ids.splice(ids.indexOf(id),1);ids.splice(ids.indexOf(target.id),0,id);
 busy.value=true;try{await v1('/api/v1/sidebar/project-order',{method:'PATCH',body:JSON.stringify({projectIds:ids})});await load(true);}catch(e){error.value=e instanceof Error?e.message:t('sidebar.reorderFailed');}finally{busy.value=false;}
}
function dropGroup(event:DragEvent,id:string){event.preventDefault();const task=event.dataTransfer?.getData('application/x-prism-task');if(task)void mutate('task',task,{groupId:id||null});}
function menuKey(event:KeyboardEvent){
 if(event.key==='Escape'){event.preventDefault();closeMenu();return;}
 if(event.key==='Tab'){closeMenu();return;}
 // A native select owns its arrow keys; do not steal them for menu navigation.

 navigateMenu(event,menuRoot.value,'[role=menuitem]:not(:disabled),.ui-select button:not(:disabled)');
}
defineExpose({openSearch,load});
const bindings=computed(()=>props.shortcuts??defaultBindings());
onMounted(()=>{void load();timer=setInterval(()=>void load(),3000);document.addEventListener('visibilitychange',onVisibility);window.addEventListener('resize',placeActions);window.addEventListener('scroll',closeActionsOnScroll,true);});
onUnmounted(()=>{disposed=true;if(timer)clearInterval(timer);document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('resize',placeActions);window.removeEventListener('scroll',closeActionsOnScroll,true);emit('modal-change',false);});
</script>

<template>
<aside id="workspace-sidebar" class="sidebar" :aria-label="t('sidebar.navAria')">
 <div class="sb-brand"><PrismLogo class="logo"/><span>棱镜<small>Prism</small></span><button class="icon-btn sb-close" type="button" :aria-label="t('sidebar.closeList')" :title="t('sidebar.closeList')" @click="emit('close-sidebar')"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></div>
 <nav class="sb-navigation" aria-label="工作区操作"><button class="sb-new" type="button" @click="emit('new-task')"><SidebarIcon name="plus"/><span>{{t('sidebar.newTask')}}</span><kbd v-if="bindings.newTask">{{formatShortcut(bindings.newTask)}}</kbd></button><TaskSearchDialog :shortcut="bindings.search || bindings.searchAlternate" ref="taskSearch" :projects="tree.projects" :recent-tasks="tree.tasks" @open-task="openFromSearch" @modal-change="emit('modal-change',$event)"/></nav>
 <div class="sidebar-list-header"><span>{{t('sidebar.listTitle')}}</span><ComposerSelect ref="viewPicker" :value="view" :options="viewChoices" :label="t('sidebar.viewPickerAria')" :width="184" icon-only @change="view=$event" @open-change="$event&&(menu=undefined)"><template #leading><SidebarIcon name="filter" :size="14"/></template><template #option-leading="{option}"><SidebarIcon :name="viewOptions.find(v=>v.id===option.value)?.icon||'folder'"/></template></ComposerSelect>
 </div>
 <p v-if="error" class="sidebar-error" role="alert">{{error}} <button class="text-btn" @click="error='';load()">{{t('common.retry')}}</button></p>
 <div class="sb-list" :aria-label="t('sidebar.listAria')">
  <template v-if="pinned.length||(view==='projects'&&pinnedProjects.length)"><div class="sb-section"><span>{{t('sidebar.pinned')}}</span></div><SidebarTaskRow v-for="task in pinned" :key="task.id" :task="task" :menu-open="menu?.kind==='task'&&menu.id===task.id" :selected="task.id===conversationId || task.runId===selectedId" :show-project="true" :project-name="projectLabel(task)" :busy="busy" @pin="t=>mutate('task',t.id,{pinned:!t.pinnedAt})" @choose="choose" @rename="t=>rename('task',t.id,t.title)" @menu="(e,t)=>openMenu('task',e,t.id)"/><template v-if="view==='projects'"><section v-for="project in pinnedProjects" :key="project.id" class="sb-project-group" @dragover.prevent @drop="reorder($event,project)">
    <div class="sidebar-project-line" :class="{'menu-open':menu?.kind==='project'&&menu.id===project.id,pinned:!!project.pinnedAt}" :data-project-current="project.id===projectId" draggable="true" @dragstart="projectDrag($event,project.id)" @contextmenu.prevent="openMenu('project',$event,project.id)">
     <button class="sb-project-row" type="button" :aria-label="`${t('sidebar.openProject',{name:project.name})}${project.pinnedAt?t('sidebar.pinnedSuffix'):''}`" :aria-expanded="isExpanded(project.id)" @keydown="projectKey($event,project.id)" @click="toggleProject(project.id)"><span class="project-leading"><SidebarIcon class="project-folder" :name="isExpanded(project.id)?'folder-open':'folder'"/><SidebarIcon v-if="project.pinnedAt" class="project-pin" name="pin"/></span><span class="t">{{project.name}}</span><span v-if="!isExpanded(project.id)&&projectHasUnread(project.id)" class="project-unread" role="img" :aria-label="t('sidebar.projectUnreadAria')"></span></button>
     <div class="project-row-actions"><button class="icon-btn" type="button" aria-haspopup="menu" :aria-expanded="menu?.kind==='project'&&menu.id===project.id" :aria-label="t('sidebar.projectActionsAria',{name:project.name})" :title="t('sidebar.projectActions')" @click="openMenu('project',$event,project.id)"><SidebarIcon name="ellipsis" :size="14"/></button><button class="icon-btn" type="button" :aria-label="t('sidebar.projectFilesAria',{name:project.name})" :title="t('sidebar.viewFiles')" @click="emit('project-files',project.id)"><SidebarIcon name="list-tree" :size="14"/></button><button class="icon-btn" type="button" :aria-label="t('sidebar.projectNewTaskAria',{name:project.name})" :title="t('sidebar.newTaskForProject')" @click="emit('project-task',project.id)"><SidebarIcon name="message-plus" :size="14"/></button></div>
    </div>
    <div v-if="isExpanded(project.id)" class="sb-project-tasks">
     <SidebarTaskRow v-for="task in projectTasks(project.id).slice(0,limits[project.id]||5)" :key="task.id" :task="task" :menu-open="menu?.kind==='task'&&menu.id===task.id" :selected="task.id===conversationId || task.runId===selectedId" :busy="busy" @pin="t=>mutate('task',t.id,{pinned:!t.pinnedAt})" @choose="choose" @rename="t=>rename('task',t.id,t.title)" @menu="(e,t)=>openMenu('task',e,t.id)"/>
     <button v-if="projectTasks(project.id).length>(limits[project.id]||5)" class="sidebar-show-more" type="button" @click="limits[project.id]=(limits[project.id]||5)+5">{{t('sidebar.showMore')}}</button>
     <p v-if="!projectTasks(project.id).length" class="sb-empty">{{t('sidebar.noTasks')}}</p>
    </div>
   </section></template></template>
  <template v-if="view==='projects'">
   <div class="sb-section"><span>{{t('sidebar.projects')}}</span><button class="icon-btn" type="button" :aria-label="t('sidebar.newProjectAria')" @click="emit('create-project')"><SidebarIcon name="plus"/></button></div>
   <section v-for="project in unpinnedProjects" :key="project.id" class="sb-project-group" @dragover.prevent @drop="reorder($event,project)">
    <div class="sidebar-project-line" :class="{'menu-open':menu?.kind==='project'&&menu.id===project.id,pinned:!!project.pinnedAt}" :data-project-current="project.id===projectId" draggable="true" @dragstart="projectDrag($event,project.id)" @contextmenu.prevent="openMenu('project',$event,project.id)">
     <button class="sb-project-row" type="button" :aria-label="`${t('sidebar.openProject',{name:project.name})}${project.pinnedAt?t('sidebar.pinnedSuffix'):''}`" :aria-expanded="isExpanded(project.id)" @keydown="projectKey($event,project.id)" @click="toggleProject(project.id)"><span class="project-leading"><SidebarIcon class="project-folder" :name="isExpanded(project.id)?'folder-open':'folder'"/><SidebarIcon v-if="project.pinnedAt" class="project-pin" name="pin"/></span><span class="t">{{project.name}}</span><span v-if="!isExpanded(project.id)&&projectHasUnread(project.id)" class="project-unread" role="img" :aria-label="t('sidebar.projectUnreadAria')"></span></button>
     <div class="project-row-actions"><button class="icon-btn" type="button" aria-haspopup="menu" :aria-expanded="menu?.kind==='project'&&menu.id===project.id" :aria-label="t('sidebar.projectActionsAria',{name:project.name})" :title="t('sidebar.projectActions')" @click="openMenu('project',$event,project.id)"><SidebarIcon name="ellipsis" :size="14"/></button><button class="icon-btn" type="button" :aria-label="t('sidebar.projectFilesAria',{name:project.name})" :title="t('sidebar.viewFiles')" @click="emit('project-files',project.id)"><SidebarIcon name="list-tree" :size="14"/></button><button class="icon-btn" type="button" :aria-label="t('sidebar.projectNewTaskAria',{name:project.name})" :title="t('sidebar.newTaskForProject')" @click="emit('project-task',project.id)"><SidebarIcon name="message-plus" :size="14"/></button></div>
    </div>
    <div v-if="isExpanded(project.id)" class="sb-project-tasks">
     <SidebarTaskRow v-for="task in projectTasks(project.id).slice(0,limits[project.id]||5)" :key="task.id" :task="task" :menu-open="menu?.kind==='task'&&menu.id===task.id" :selected="task.id===conversationId || task.runId===selectedId" :busy="busy" @pin="t=>mutate('task',t.id,{pinned:!t.pinnedAt})" @choose="choose" @rename="t=>rename('task',t.id,t.title)" @menu="(e,t)=>openMenu('task',e,t.id)"/>
     <button v-if="projectTasks(project.id).length>(limits[project.id]||5)" class="sidebar-show-more" type="button" @click="limits[project.id]=(limits[project.id]||5)+5">{{t('sidebar.showMore')}}</button>
     <p v-if="!projectTasks(project.id).length" class="sb-empty">{{t('sidebar.noTasks')}}</p>
    </div>
   </section>
   <button v-if="!available.length" type="button" class="sb-new" @click="emit('create-project')"><SidebarIcon name="plus"/><span>{{t('sidebar.createProjectCta')}}</span></button>
  </template>
  <template v-else-if="view==='grouped'">
   <div class="sb-section"><span>{{t('sidebar.groups')}}</span><button class="icon-btn" type="button" :aria-label="t('sidebar.newGroupAria')" @click="rename('new-group')"><SidebarIcon name="plus"/></button></div>
   <section v-for="group in grouped" :key="group.id" class="sidebar-task-group" @dragover.prevent @drop="dropGroup($event,group.id)"><div class="sidebar-group-heading"><span class="group-name"><SidebarIcon name="hash"/>{{group.name}}</span><button v-if="group.id" class="icon-btn" type="button" :aria-label="`分组操作：${group.name}`" @click="openMenu('group',$event,group.id)"><SidebarIcon name="ellipsis" :size="14"/></button></div><SidebarTaskRow v-for="task in regular.filter(t=>(t.groupId||'')===group.id)" :key="task.id" :task="task" :menu-open="menu?.kind==='task'&&menu.id===task.id" :selected="task.id===conversationId || task.runId===selectedId" :show-project="true" :project-name="projectLabel(task)" :busy="busy" @pin="t=>mutate('task',t.id,{pinned:!t.pinnedAt})" @choose="choose" @rename="t=>rename('task',t.id,t.title)" @menu="(e,t)=>openMenu('task',e,t.id)"/></section>
  </template>
  <template v-else>
   <div class="sb-section"><span>{{view==='unread'?t('sidebar.view.unread'):t('sidebar.view.timeline')}}</span></div>

   <SidebarTaskRow v-for="task in otherRows.slice(0,limits[view]||20)" :key="task.id" :task="task" :menu-open="menu?.kind==='task'&&menu.id===task.id" :selected="task.id===conversationId || task.runId===selectedId" :show-project="true" :project-name="projectLabel(task)" :busy="busy" @pin="t=>mutate('task',t.id,{pinned:!t.pinnedAt})" @choose="choose" @rename="t=>rename('task',t.id,t.title)" @menu="(e,t)=>openMenu('task',e,t.id)"/>
   <button v-if="otherRows.length>(limits[view]||20)" class="sidebar-show-more" @click="limits[view]=(limits[view]||20)+20">{{t('sidebar.showMore')}}</button><p v-if="!otherRows.length&&!pinned.length" class="sb-empty">{{view==='unread'?t('sidebar.noUnread'):t('sidebar.noTasksAll')}}</p>
  </template>
 </div>
 <div class="sb-footer"><button class="sb-settings" type="button" :aria-label="t('sidebar.openSettingsAria')" @click="emit('open-settings')"><SidebarIcon name="settings"/><span>{{t('sidebar.settings')}}</span><kbd v-if="bindings.settings">{{formatShortcut(bindings.settings)}}</kbd></button><div class="sb-account"><span class="name">{{username}}</span><button class="icon-btn" :aria-label="t('sidebar.logout')" @click="emit('logout')"><SidebarIcon name="logout"/></button></div></div>
 <Teleport to="body"><div v-if="menu" class="sidebar-menu-dismiss" @pointerdown.self="menu=undefined"><div ref="menuRoot" class="sidebar-action-menu" role="menu" :style="{left:menu.x+'px',top:menu.y+'px'}" @keydown="menuKey">
  <template v-if="menu.kind==='project'&&menuProject"><button role="menuitem" @click="emit('project-task',menu.id);menu=undefined">{{t('sidebar.menu.newTask')}}</button><button role="menuitem" @click="emit('project-files',menu.id);menu=undefined">{{t('sidebar.menu.viewFiles')}}</button><hr><button role="menuitem" @click="emit('edit-project',{id:menu.id,name:menuProject.name});menu=undefined">{{t('sidebar.menu.editProject')}}</button><button role="menuitem" :disabled="busy" @click="rename('project',menu.id,menuProject.name)">{{t('sidebar.menu.renameProject')}}</button><button role="menuitem" :disabled="busy" @click="mutate('project',menu.id,{pinned:!menuProject.pinnedAt})">{{menuProject.pinnedAt?t('sidebar.menu.unpinProject'):t('sidebar.menu.pinProject')}}</button><button role="menuitem" @click="emit('open-settings','projects');menu=undefined">{{t('sidebar.menu.manageProjects')}}</button></template>
  <template v-else-if="menu.kind==='task'&&menuTask"><button role="menuitem" :disabled="busy" @click="mutate('task',menu.id,{pinned:!menuTask.pinnedAt})">{{menuTask.pinnedAt?t('sidebar.menu.unpin'):t('sidebar.menu.pinTask')}}</button><button role="menuitem" :disabled="busy" @click="rename('task',menu.id,menuTask.title)">{{t('sidebar.menu.renameTask')}}</button><button role="menuitem" :disabled="busy" @click="mutate('task',menu.id,{archived:!menuTask.archivedAt})">{{menuTask.archivedAt?t('sidebar.menu.restore'):t('sidebar.menu.archive')}}</button><button role="menuitem" :disabled="busy" @click="mutate('task',menu.id,{unread:!menuTask.unreadAt})">{{menuTask.unreadAt?t('sidebar.menu.markRead'):t('sidebar.menu.markUnread')}}</button><hr><label>{{t('sidebar.menu.moveGroup')}}<UiSelect :label="t('sidebar.menu.moveGroupLabel')" :model-value="menuTask.groupId||''" :disabled="busy" @change="mutate('task',menu!.id,{groupId:$event||null})" :options="[{value:'',label:t('sidebar.ungrouped')},...tree.groups.map(g=>({value:g.id,label:g.name}))]"/></label><button role="menuitem" @click="emit('project-files',menuTask.projectId);menu=undefined">{{t('sidebar.menu.viewFiles')}}</button></template>
  <template v-else-if="menu.kind==='group'"><button role="menuitem" @click="rename('group',menu.id,tree.groups.find(g=>g.id===menu!.id)?.name||'')">{{t('sidebar.menu.renameGroup')}}</button><button role="menuitem" @click="removeGroup(menu.id)">{{t('sidebar.menu.removeGroup')}}</button></template>
 </div></div></Teleport>
 <Teleport to="body"><div v-if="editing" class="project-overlay" @click.self="!busy&&(editing=undefined)"><section class="project-dialog sidebar-name-dialog" role="dialog" aria-modal="true" aria-labelledby="sidebar-name-title" @keydown="dialogKey"><header><h2 id="sidebar-name-title">{{editing.kind==='new-group'?t('sidebar.dialog.newGroup'):t('sidebar.dialog.rename')}}</h2></header><form @submit.prevent="saveName"><label class="project-field">{{t('sidebar.dialog.name')}}<input ref="renameInput" v-model="editing.name" :maxlength="editing.kind==='task'?200:120" required :disabled="busy"></label><p v-if="error" class="project-error" role="alert">{{error}}</p><footer><button type="button" class="text-btn" :disabled="busy" @click="editing=undefined">{{t('common.cancel')}}</button><button class="btn project-submit" :disabled="busy||!editing.name.trim()">{{t('common.save')}}</button></footer></form></section></div></Teleport>
</aside>
</template>

<style scoped>
/* ZCode ProjectNodeContent / ProjectTaskRows / button: 32px rows, 16px leading slot,
   8px text gap, 24px actions. The project row owns its single hover surface. */
.sidebar{font:400 var(--ui-font-size,14px)/1.5 var(--font-ui);}
.sb-navigation{padding:12px 8px;gap:4px;}
.sb-new{height:32px;min-height:32px;padding:0 10px;gap:8px;font:inherit;}
.sb-new kbd,.sb-settings kbd{font:400 calc(var(--ui-font-size,14px) - 4px)/1.5 var(--font-ui);}
.sidebar-list-header{position:relative;flex:none;gap:4px;padding:0 10px 8px 8px;font:inherit;color:var(--fg-subtle);}
.sidebar-list-header>span:first-child{min-width:0;padding:0 10px;font-weight:500;}
.sidebar .icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;min-height:24px;padding:0;flex:none;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--fg-subtle);box-shadow:none;}
.sidebar .icon-btn:hover,.sidebar .icon-btn[aria-expanded=true]{background:var(--hover);color:var(--fg);}
.sidebar .sb-close{display:none;margin-left:auto;}
@media(max-width:1023.98px){.sidebar .sb-close{display:inline-flex;width:40px;height:40px;min-height:40px;margin-right:-8px;}}
/* Project actions share the row surface, including while their menu is open. */
.sidebar .project-row-actions .icon-btn:hover,.sidebar .project-row-actions .icon-btn[aria-expanded=true]{background:transparent;color:var(--fg);}
.sidebar-view-menu{display:flex;flex-direction:column;position:fixed;z-index:60;width:184px;max-width:calc(100vw - 16px);font:400 var(--ui-font-size,14px)/1.625 var(--font-ui);color:var(--fg);gap:2px;margin:0;padding:4px;border:1px solid var(--color-popover-border,var(--border));border-radius:8px;background:var(--color-menu,var(--bg-panel));box-shadow:0 4px 6px -1px rgb(0 0 0 / .1),0 2px 4px -2px rgb(0 0 0 / .1);}
.sidebar-view-menu button{appearance:none;width:100%;border:0;background:transparent;color:var(--fg);text-align:left;cursor:pointer;outline:none;display:flex;align-items:center;gap:8px;position:relative;min-height:28px;padding:6px 32px 6px 8px;border-radius:6px;font:inherit;}
.sidebar-view-menu button:hover,.sidebar-view-menu button:focus{background:var(--color-menu-hover,var(--hover));}
.view-check{position:absolute;right:8px;}
.sb-list{padding:0 8px 8px 0;min-width:0;}
.sb-section{height:32px;padding:4px 4px 4px 18px;font:500 var(--ui-font-size,14px)/1.5 var(--font-ui);color:var(--fg-subtle);}
.sb-project-group{min-width:0;margin:0 0 8px;border-radius:12px;}
.sidebar-project-line{display:flex;align-items:center;position:relative;height:32px;min-width:0;margin-left:8px;gap:4px;padding-right:4px;border-radius:8px;background:transparent;}
.sidebar-project-line:hover,.sidebar-project-line:focus-within,.sidebar-project-line.menu-open{background:var(--color-surface-hover,var(--hover));}
.sidebar-project-line>.sb-project-row{display:flex;align-items:center;flex:1;min-width:0;width:auto;height:32px;padding:0 4px 0 10px;gap:8px;border:0;border-radius:8px;background:transparent;color:var(--fg-subtle);font:inherit;text-align:left;}
.sidebar-project-line>.sb-project-row:hover,.sidebar-project-line>.sb-project-row[aria-expanded=true]{background:transparent;color:var(--fg-subtle);}
.sb-project-row .t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.project-leading{display:flex;align-items:center;justify-content:center;width:16px;height:16px;flex:0 0 16px;}
.project-pin{display:none;}
.pinned:hover .project-folder{display:none;}.pinned:hover .project-pin{display:block;}
.project-unread{flex:none;width:6px;height:6px;border-radius:50%;background:var(--color-icon-blue,#508de0);}
.project-row-actions{display:flex;align-items:center;flex:none;gap:4px;opacity:0;pointer-events:none;transition:opacity .15s;}
.sidebar-project-line:hover .project-row-actions,.sidebar-project-line:focus-within .project-row-actions,.sidebar-project-line.menu-open .project-row-actions{opacity:1;pointer-events:auto;}
.sb-project-tasks{padding:4px 0 0 8px;}
.sb-list>:deep(.ps-task){margin-left:8px;}
.sidebar-task-group{padding-left:8px;}
.sidebar-group-heading{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:4px 4px 4px 10px;min-height:32px;font:inherit;}
.group-name{display:flex;align-items:center;gap:8px;min-width:0;}
.sidebar-show-more{margin:0 0 0 34px;padding:0;min-height:24px;background:transparent;border:0;font:inherit;color:var(--fg-subtlest);}
.sb-list>.sidebar-show-more{margin-left:42px;}
.sidebar-show-more:hover{color:var(--fg);background:transparent;}
.sb-empty{padding:8px 34px;color:var(--fg-subtlest);font:inherit;}
.sb-list>.sb-empty{padding-left:42px;}
.sb-footer{padding:8px;gap:8px;}
.sb-settings{height:32px;padding:0 10px;gap:8px;font:inherit;}
.sb-account{padding:0 10px;}.sb-account .name{font:inherit;}
.sidebar-action-menu{padding:4px;gap:2px;border-radius:8px;border-color:var(--color-popover-border,var(--border));background:var(--color-menu,var(--bg-panel));font:400 var(--ui-font-size,14px)/1.625 var(--font-ui);}
.sidebar-action-menu button{display:flex;align-items:center;gap:8px;min-height:28px;padding:4px 8px;border-radius:6px;font:inherit;}
.sidebar-action-menu button:hover,.sidebar-action-menu button:focus-visible{background:var(--color-menu-hover,var(--hover));}
.sidebar-action-menu button:disabled{cursor:default;color:var(--fg-subtlest);}
.sidebar-action-menu label{font-size:var(--ui-font-size,14px);padding:4px 8px;}
.sidebar button:focus-visible{outline:2px solid var(--fg-subtle);outline-offset:1px;}
@media(hover:none){.project-row-actions{opacity:1;pointer-events:auto;}}
@media(prefers-reduced-motion:reduce){.project-row-actions{transition:none;}}
</style>

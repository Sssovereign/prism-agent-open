<script setup lang="ts">
// ZCode TaskListItem + ProjectTaskRows: 16px leading slot, 8px gap,
// 32px row, 1px vertical breathing room, shared transparent action surface.
import {computed,onUnmounted} from 'vue';
import {statusLabel} from '../status';
import {modeInfo} from '../modes';
import {t} from '../ui/i18n/index';
import type {SidebarTask} from '../view-model/sidebar';
import SidebarIcon from './SidebarIcon.vue';
import ModeIcon from './ModeIcon.vue';
const props=defineProps<{task:SidebarTask;selected?:boolean;showProject?:boolean;projectName?:string;menuOpen?:boolean;busy?:boolean}>();
const emit=defineEmits<{(e:'choose',task:SidebarTask):void;(e:'rename',task:SidebarTask):void;(e:'pin',task:SidebarTask):void;(e:'menu',event:MouseEvent,task:SidebarTask):void}>();
const running=computed(()=>props.task.status==='running'&&!props.task.awaitingAnswer);
const status=computed(()=>props.task.awaitingAnswer?t('app.awaitingAnswer'):statusLabel(props.task.status));
// Older sidebar responses omit mode; ordinary is the existing task default.
const mode=computed(()=>modeInfo(props.task.mode??'ordinary'));
const projectContext=computed(()=>props.showProject&&props.projectName?` · ${props.projectName}`:'');
function relative(iso:string){const ms=Date.now()-Date.parse(iso);if(!Number.isFinite(ms))return '';const m=Math.floor(Math.max(0,ms)/60000);return m<1?t('time.justNow'):m<60?t('time.minutesAgo',{n:m}):m<1440?t('time.hoursAgo',{n:Math.floor(m/60)}):t('time.daysAgo',{n:Math.floor(m/1440)});}
let chooseTimer:ReturnType<typeof setTimeout>|undefined;
function cancelChoose(){if(chooseTimer!==undefined)clearTimeout(chooseTimer);chooseTimer=undefined;}
function choose(event:MouseEvent){
 cancelChoose();
 if(event.detail===0){emit('choose',props.task);return;}
 // Let a double click rename an unread row before opening would filter it out.
 if(event.detail===1)chooseTimer=setTimeout(()=>{chooseTimer=undefined;emit('choose',props.task);},300);
}
function rename(){cancelChoose();emit('rename',props.task);}
function pin(){cancelChoose();if(!props.busy)emit('pin',props.task);}
onUnmounted(cancelChoose);
function drag(event:DragEvent){cancelChoose();event.dataTransfer?.setData('application/x-prism-task',props.task.id);}
function contextKey(event:KeyboardEvent){if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){event.preventDefault();(event.currentTarget as HTMLElement).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));}}
</script>
<template>
 <div class="ps-task" :class="{active:selected,'menu-open':menuOpen}" draggable="true" @dragstart="drag" @contextmenu.prevent="cancelChoose();emit('menu',$event,task)" @keydown="contextKey">
  <button type="button" class="ps-task-select" :aria-current="selected?'page':undefined" :aria-label="`${task.title}${t('sidebar.ariaSeparator')}${mode.label}${t('sidebar.ariaSeparator')}${status}${projectContext}${task.unreadAt?t('sidebar.unreadSuffix'):''}${task.pinnedAt?t('sidebar.pinnedSuffix'):''}`" :title="`${task.title} · ${mode.label} · ${status}${projectContext} · ${t('time.updatedAtPrefix',{time:relative(task.updatedAt)})} · ${t('sidebar.dblclickRename')}`" @click="choose" @dblclick.prevent="rename" @keydown.f2.prevent.stop="rename">
   <span class="ps-task-leading" :title="mode.label" aria-hidden="true"><ModeIcon :mode="mode.id"/></span>
   <span class="ps-task-copy"><span class="ps-task-title">{{task.title}}</span></span>
  </button>
  <span v-if="task.awaitingAnswer||running||task.status==='failed'||task.unreadAt" class="ps-task-state" aria-hidden="true"><span v-if="task.awaitingAnswer" class="ps-task-question" :title="t('app.awaitingAnswer')">?</span><span v-else-if="running" class="ps-task-dot running" :title="t('status.running')"></span><span v-else-if="task.status==='failed'" class="ps-task-dot failed" :title="status"></span><span v-else-if="task.unreadAt" class="ps-task-dot unread" :title="t('sidebar.unread')"></span></span>
  <span class="ps-task-actions">
   <button type="button" class="ps-task-action ps-task-pin-toggle" :class="{pinned:!!task.pinnedAt}" :disabled="busy" :aria-pressed="!!task.pinnedAt" :aria-label="`${task.pinnedAt?t('sidebar.menu.unpin'):t('sidebar.menu.pinTask')}${t('sidebar.ariaColon')}${task.title}`" :title="task.pinnedAt?t('sidebar.menu.unpin'):t('sidebar.menu.pinTask')" @click.stop="pin" @dblclick.stop><SidebarIcon name="pin" :size="16"/></button>
   <button type="button" class="ps-task-action ps-task-more" aria-haspopup="menu" :aria-expanded="!!menuOpen" :aria-label="t('sidebar.taskActionsAria',{name:task.title})" :title="t('sidebar.taskActions')" @click.stop="cancelChoose();emit('menu',$event,task)"><SidebarIcon name="ellipsis" :size="14"/></button>
  </span>
 </div>
</template>
<style scoped>
.ps-task{position:relative;display:flex;align-items:center;min-width:0;min-height:32px;margin:1px 0;border-radius:8px;padding:4px 4px 4px 10px;gap:4px;color:var(--fg);transition:background-color .15s;font:400 var(--ui-font-size,14px)/1.5 var(--font-ui);}
.ps-task:hover,.ps-task:focus-within,.ps-task.menu-open{background:var(--color-surface-hover,var(--hover));}
.ps-task.active,.ps-task.active:hover,.ps-task.active:focus-within{background:var(--selected);}
.ps-task-select{display:flex;align-items:center;gap:8px;flex:1;min-width:0;min-height:24px;padding:0;border:0;background:transparent;color:inherit;text-align:left;font:inherit;border-radius:4px;cursor:pointer;}
.ps-task-leading{display:flex;align-items:center;justify-content:center;flex:0 0 16px;width:16px;height:16px;color:var(--fg-subtle);}
.ps-task-leading :deep(.mode-icon){width:16px;height:16px;flex:none;}
.ps-task-state{display:flex;align-items:center;justify-content:center;flex:0 0 12px;width:12px;height:16px;margin-right:6px;color:var(--fg-subtle);}
.ps-task-dot{width:7px;height:7px;border-radius:50%;}.ps-task-dot.unread{background:var(--color-icon-blue,#508de0);}.ps-task-dot.failed{background:var(--danger);}
.ps-task-question{font-size:12px;color:var(--fg-subtle);font-weight:600}.ps-task-dot.running{background:var(--success);animation:ps-task-breathe 1.8s ease-in-out infinite;}
.ps-task-copy{display:flex;flex-direction:column;min-width:0;flex:1;gap:2px;}
.ps-task-title{display:block;white-space:nowrap;overflow:hidden;mask-image:linear-gradient(to right,#000 calc(100% - 12px),transparent);}
.ps-task-actions{position:absolute;right:4px;top:50%;transform:translateY(-50%);display:flex;gap:2px;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .15s;}
@media(hover:hover){
.ps-task:hover .ps-task-actions{opacity:1;visibility:visible;pointer-events:auto;}
.ps-task:hover .ps-task-title{mask-image:linear-gradient(to right,#000 calc(100% - 52px),transparent calc(100% - 42px));}
.ps-task:hover .ps-task-state{opacity:0;}
}
.ps-task-action{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:1px solid transparent;border-radius:6px;color:var(--fg-subtle);background:transparent;cursor:pointer;}
.ps-task-action:hover,.ps-task-more[aria-expanded=true]{color:var(--fg);background:var(--hover);}
.ps-task-action:disabled{opacity:.45;cursor:default;}
.ps-task-pin-toggle :deep(.sidebar-icon){transform:rotate(40deg);}
.ps-task-pin-toggle.pinned :deep(path:first-child){fill:currentColor;}
.ps-task button:focus-visible{outline:2px solid var(--fg-subtle);outline-offset:1px;}
@keyframes ps-task-breathe{0%,100%{opacity:.45;box-shadow:0 0 0 0 transparent;}50%{opacity:1;box-shadow:0 0 0 3px color-mix(in srgb,var(--success) 15%,transparent);}}
@media(prefers-reduced-motion:reduce){.ps-task,.ps-task-actions{transition:none;}.ps-task-dot.running{animation:none;}}
</style>

<script setup lang="ts">
/** ChatPromptActionMenu.tsx + MentionPanel.tsx (ZCode a9fe401), adapted to Prism's existing image/file-reference capabilities. */
import {computed,nextTick,onBeforeUnmount,onMounted,ref,useId,watch} from 'vue';
import type {CSSProperties} from 'vue';
import ControlHintTooltip from './ControlHintTooltip.vue';
import MentionPanel, {type MentionPanelOption,type MentionPanelSection} from './MentionPanel.vue';
import UiIcon from './UiIcon.vue';
import FileIcon from './FileIcon.vue';
import {buildFileMentionMarkdown,buildSessionMentionMarkdown,buildSkillMentionMarkdown,type SkillSuggestionSource} from '../conversation/promptTriggers';
const props=defineProps<{
 skills?:SkillSuggestionSource[];draft:string;newTask?:boolean;projectId:string;disabled?:boolean;imageDisabledReason:string;offerGoal:boolean;
	/** 资料引用模式（研究共同资料）：菜单结构与任务助手一致，仅两点差异——文件分区保留目录导航；技能分区为勾选式（skillSelectable） */
	filesOnly?:boolean;
	/** 技能分区勾选模式：点击技能=切换选中并 emit toggle-skill，而非插入 $mention */
	skillSelectable?:boolean;
	/** 勾选模式下的已选技能名单（渲染勾选态） */
	selectedSkills?:string[];
	/** 有 label 时触发器渲染为带边框的显性按钮（如共同资料「添加」），无 label 保持 28×28 图标 */
	label?:string;
	anchor:()=>HTMLElement|undefined;
 fileProvider?: (path:string)=>Promise<{path:string;entries:Array<{name:string;type:'file'|'directory'}>}>;
 /** 近期会话（上游 sessionsMentionProvider 的 Prism 子集：当前项目 Runs，调用方已排序/去当前） */
 sessions?:Array<{id:string;title:string;description?:string}>;
}>();
const emit=defineEmits<{
 (e:'open-change',open:boolean):void;(e:'attach'):void;(e:'insert',payload:{text:string;kind:'file'|'command'|'skill'|'session';path?:string}):void;(e:'toggle-skill',name:string):void;
}>();
type Choice={id:string;label:string;kind:'image'|'command'|'file'|'skill'|'session';description?:string;icon?:string;value?:string;fileKind?:'file'|'directory';disabled?:boolean;disabledReason?:string;path?:string;selected?:boolean};
const id=useId(),trigger=ref<HTMLButtonElement>(),panel=ref<HTMLElement>(),open=ref(false),positioned=ref(false),position=ref<CSSProperties>({}),selected=ref(-1),quick=ref<Choice[]>([]),files=ref<Choice[]>([]),loading=ref(false),error=ref(''),fileDir=ref('');
const skillChoices=computed<Choice[]>(()=> (props.skills??[]).map(skill=>({id:`skill:${skill.name}`,label:skill.displayName??skill.name,kind:'skill',description:skill.description,icon:skill.icon??'SKILL.md',value:buildSkillMentionMarkdown(skill.name,skill.path),selected:props.skillSelectable?props.selectedSkills?.includes(skill.name)===true:undefined})));
const sessionChoices=computed<Choice[]>(()=> (props.sessions??[]).map(row=>({id:`session:${row.id}`,label:row.title,kind:'session',description:row.description,value:buildSessionMentionMarkdown(row.id,row.title)})));
// choices 顺序必须与面板分节顺序一致（add→skills→files→sessions，资料区同构）：键盘/点击按扁平索引反查。
const choices=computed(()=>[...quick.value,...skillChoices.value,...files.value,...sessionChoices.value]);
const sections=computed<MentionPanelSection[]>(()=>[
 {id:'add',title:'添加',emptyText:'',options:quick.value.map(row=>({...row,description:''}))},
 ...(skillChoices.value.length?[{id:'skills',title:'技能',emptyText:'',options:skillChoices.value.map(row=>({...row,description:row.description??''}))}]:[]),
 ...(props.projectId?[{id:'files',title:'文件',emptyText:'没有可引用的项目文件',loading:loading.value,loadingText:'正在读取项目文件…',errorText:error.value,options:files.value.map(row=>({...row,description:''}))}]:[]),
 ...(props.sessions?[{id:'sessions',title:'会话',emptyText:'没有匹配的近期会话',options:sessionChoices.value.map(row=>({...row,description:row.description??''}))}]:[]),
]);
let ticket=0,observer:ResizeObserver|undefined,frame=0;
function close(restore=true){if(!open.value)return;open.value=false;ticket++;observer?.disconnect();cancelAnimationFrame(frame);emit('open-change',false);if(restore)trigger.value?.focus({preventScroll:true});}
function place(){
 const anchor=props.anchor(),content=panel.value;if(!anchor||!content||!open.value)return;
 const rect=anchor.getBoundingClientRect(),viewport=window.visualViewport,zoom=parseFloat(getComputedStyle(document.body).zoom||'1')||1;
 const left=(viewport?.offsetLeft??0)+8,top=(viewport?.offsetTop??0)+8,right=(viewport?.offsetLeft??0)+(viewport?.width??innerWidth)-8,bottom=(viewport?.offsetTop??0)+(viewport?.height??innerHeight)-8;
 const gap=6, width=Math.min(480*zoom,Math.max(rect.width,320*zoom),Math.max(0,right-left));
 const above=Math.max(0,Math.min(rect.top-gap,bottom)-top),below=Math.max(0,bottom-Math.max(rect.bottom+gap,top)),useTop=above>=Math.min(320*zoom,content.offsetHeight*zoom)||above>=below,available=useTop?above:below;
 // Measure after applying the width/height constraints: scrollHeight uses unzoomed
 // content coordinates and includes overflowing rows. offsetHeight also excludes
 // the entrance animation's scale so positioning stays stable once it finishes.
 content.style.width=`${width/zoom}px`;content.style.maxHeight=`${available/zoom}px`;
 const height=content.offsetHeight*zoom;
 position.value={width:`${width/zoom}px`,left:`${Math.max(left,Math.min(rect.left,right-width))/zoom}px`,top:`${Math.max(top,Math.min(useTop?rect.top-gap-height:rect.bottom+gap,bottom-height))/zoom}px`,maxHeight:`${available/zoom}px`};positioned.value=true;
}
function schedule(event?:Event){if(!open.value||(event?.target instanceof Node&&panel.value?.contains(event.target)))return;cancelAnimationFrame(frame);frame=requestAnimationFrame(place);}
async function loadFiles(){
 const current=++ticket,pid=props.projectId,provider=props.fileProvider;files.value=[];error.value='';loading.value=!!pid;
 if(!pid)return;
 try{
  if(!provider)throw new Error('请先为项目绑定本地文件夹');
  const data=await provider(fileDir.value);if(!open.value||current!==ticket||pid!==props.projectId)return;
  const rows:Choice[]=[];
  if(props.filesOnly&&fileDir.value)rows.push({id:'file:..',label:'..',kind:'file',fileKind:'directory',description:'返回上一级目录',value:'..',path:'..'});
  rows.push(...data.entries.slice(0,10).map(entry=>{
   // listFiles只回叶名，引用与导航都要拼出相对当前目录的完整相对路径
   const full=data.path?`${data.path}/${entry.name}`:entry.name;
   return {id:`file:${full}`,label:entry.name,kind:'file' as const,fileKind:entry.type,value:buildFileMentionMarkdown(full,entry.name,entry.type),path:full};
  }));
  files.value=rows;
 }catch(e){if(open.value&&current===ticket)error.value=e instanceof Error?e.message:'无法读取项目文件';}
 finally{if(open.value&&current===ticket){loading.value=false;if(selected.value<0)selected.value=choices.value.findIndex(choice=>!choice.disabled);await nextTick();place();}}
}
async function show(){
 if(props.disabled||open.value)return;
 document.dispatchEvent(new CustomEvent('composer-picker-open',{detail:id}));
 fileDir.value='';
 // Snapshot quick commands on open; never offer a start-only command in the middle of an existing draft.
 // 资料区与任务助手同构：图片恒在（disabled 由 imageDisabledReason 决定），goal 只在空草稿的新任务出现。
 quick.value=[{id:'attach-images',label:'添加图片',kind:'image',disabled:!!props.imageDisabledReason,disabledReason:props.imageDisabledReason},...(props.newTask&&props.draft===''&&props.offerGoal?[{id:'add-goal',label:'目标',kind:'command' as const,value:'/goal '}]:[])];
 files.value=[];error.value='';selected.value=choices.value.findIndex(choice=>!choice.disabled);positioned.value=false;open.value=true;emit('open-change',true);
 void loadFiles();await nextTick();if(!open.value)return;place();await nextTick();if(!open.value)return;panel.value?.focus({preventScroll:true});
 observer=new ResizeObserver(()=>schedule());if(props.anchor())observer.observe(props.anchor()!);if(panel.value)observer.observe(panel.value);
}
// MentionPanelOption 是封闭类型；勾选态等扩展信息从 choices 反查（沿用 option slot 的既有模式）
function choiceOf(option?:MentionPanelOption|null){return option?choices.value.find(choice=>choice.id===option.id):undefined;}
function choose(index:number){
 const choice=choices.value[index];if(!choice||choice.disabled||props.disabled)return;
 if(choice.kind==='image'){close();emit('attach');return;}
 // filesOnly：文件夹即进入子目录继续列文件（'..'回上级），文件才产出引用
 if(props.filesOnly&&choice.kind==='file'&&choice.fileKind==='directory'){
  if(choice.path==='..')fileDir.value=fileDir.value.includes('/')?fileDir.value.slice(0,fileDir.value.lastIndexOf('/')):'';
  else fileDir.value=choice.path??'';
  void loadFiles();return;
 }
 // 勾选模式（研究共同资料）：技能点击=切换分析方法选中态，不插入 $mention
 if(props.skillSelectable&&choice.kind==='skill'){close(props.filesOnly);emit('toggle-skill',choice.id.slice('skill:'.length));return;}
 // filesOnly（共同资料）选择后焦点归还触发按钮；普通菜单保持原状由 composer 接管焦点
 close(props.filesOnly);emit('insert',{text:choice.value!,kind:choice.kind,path:choice.path});
}
function key(event:KeyboardEvent){
 if(event.isComposing)return;
 if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
 if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
  event.preventDefault();event.stopPropagation();const options=choices.value;if(!options.length)return;
  const direction=event.key==='ArrowUp'||event.key==='End'?-1:1;let start=event.key==='Home'?-1:event.key==='End'?options.length:selected.value;
  for(let step=1;step<=options.length;step++){const index=(start+direction*step+options.length)%options.length;if(!options[index]?.disabled){selected.value=index;break;}}
 }else if(event.key==='Tab'){close();}
 else if(['Enter',' '].includes(event.key)){event.preventDefault();event.stopPropagation();choose(selected.value);}
}
function outside(event:PointerEvent){if(open.value&&event.target instanceof Node&&!panel.value?.contains(event.target)&&!trigger.value?.contains(event.target))close(false);}
function peer(event:Event){if((event as CustomEvent<string>).detail!==id)close(false);}
watch(()=>props.imageDisabledReason,reason=>{
 const image=quick.value[0];if(image?.kind==='image')quick.value[0]={...image,disabled:!!reason,disabledReason:reason};
 if(choices.value[selected.value]?.disabled)selected.value=choices.value.findIndex(choice=>!choice.disabled);
});
watch(()=>[props.projectId,props.newTask,props.draft,props.disabled],()=>close(false));
onMounted(()=>{document.addEventListener('pointerdown',outside,true);document.addEventListener('composer-picker-open',peer);window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true);window.visualViewport?.addEventListener('resize',schedule);window.visualViewport?.addEventListener('scroll',schedule);});
onBeforeUnmount(()=>{close(false);document.removeEventListener('pointerdown',outside,true);document.removeEventListener('composer-picker-open',peer);window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule,true);window.visualViewport?.removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('scroll',schedule);});
</script>
<template>
 <ControlHintTooltip :text="disabled?'正在提交，请稍候':'添加上下文'" :focusable="disabled" v-slot="{describedby}"><button ref="trigger" type="button" class="composer-add-trigger" :class="{'composer-add-trigger--label':!!label}" :aria-label="filesOnly?'添加资料与方法':'添加上下文'" aria-haspopup="dialog" :aria-expanded="open" :aria-controls="open?id:undefined" :aria-describedby="describedby" :disabled="disabled" @mousedown.prevent @click="open?close():show()" @keydown.down.prevent="show" @keydown.up.prevent="show"><UiIcon name="plus" :size="label?14:16"/><span v-if="label" class="composer-add-trigger-text">{{label}}</span></button></ControlHintTooltip>
 <Teleport to="body"><div v-if="open" :id="id" ref="panel" class="composer-add-panel" role="dialog" :aria-label="filesOnly?'添加资料与方法':'添加上下文'" tabindex="-1" :style="[position,{visibility:positioned?'visible':'hidden'}]" @keydown="key">
  <MentionPanel :title="filesOnly?'添加资料与方法':'添加上下文'" description="" trigger="+" :sections="sections" empty-text="" :selected-index="selected" :has-active-query="false" list-max-height="20rem" @select="choose">
   <template #option="{option}">
    <UiIcon v-if="option?.id==='attach-images'" name="paperclip" :size="16"/>
    <UiIcon v-else-if="option?.id==='add-goal'" name="target" :size="16"/>
    <UiIcon v-else-if="option?.id?.startsWith('session:')" name="messages" :size="16"/>
    <UiIcon v-else-if="choiceOf(option)?.kind==='skill'&&skillSelectable" name="check" :size="16" :class="choiceOf(option)?.selected?'add-skill-check on':'add-skill-check'"/>
    <FileIcon v-else :name="choices.find(choice=>choice.id===option?.id)?.icon??option?.label" :folder="choices.find(choice=>choice.id===option?.id)?.fileKind==='directory'"/>
    <span class="add-option-copy"><span class="add-option-label" :title="option?.label">{{option?.label}}</span><span v-if="option?.description" class="add-option-description" :title="option.description">{{option.description}}</span><span v-if="option?.disabled" class="add-option-reason" :title="option.disabledReason">{{option.disabledReason}}</span></span>
   </template>
   <template #footer><div class="add-footer"><template v-if="filesOnly"><div class="add-shortcut"><code>@</code><span>添加上下文</span></div><div class="add-shortcut"><code>$</code><span>选择技能</span></div><div class="add-search-hint"><UiIcon name="info" :size="16"/><span>选择文件加入共同资料，选择文件夹进入子目录；勾选技能随研究提示词下发正文（最多3项，不是证据）</span></div></template><template v-else><div class="add-shortcut"><code>@</code><span>添加上下文</span></div><div class="add-shortcut"><code>/</code><span>选择能力</span></div><div class="add-shortcut"><code>$</code><span>选择技能</span></div><div class="add-search-hint"><UiIcon name="info" :size="16"/><span>输入 @ 搜索文件，输入 $ 搜索技能</span></div></template></div></template>
  </MentionPanel>
 </div></Teleport>
</template>
<style scoped>
.composer-add-trigger{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--fg-subtle);cursor:pointer}
/* label 变体：带边框/浅底的显性按钮（共同资料「引用文件」），锚点与翻转机制不变。 */
.composer-add-trigger--label{width:auto;height:28px;gap:5px;padding:0 10px;border:1px solid var(--border);border-radius:999px;background:var(--bg-card);color:var(--fg);font-size:var(--text-ui-sm);font-weight:500}
.composer-add-trigger--label:hover,.composer-add-trigger--label[aria-expanded=true]{background:var(--hover);border-color:var(--border-hover);color:var(--fg)}
.composer-add-trigger-text{white-space:nowrap}
.composer-add-trigger:hover,.composer-add-trigger[aria-expanded=true]{background:var(--hover);color:var(--fg)}
.composer-add-trigger:focus-visible{outline:2px solid var(--fg-subtle);outline-offset:2px}.composer-add-trigger:disabled{cursor:not-allowed;opacity:.5}
.composer-add-panel{position:fixed;z-index:1600;display:flex;min-width:0;outline:none;overflow:hidden;overscroll-behavior:contain;border-radius:16px;box-shadow:0 8px 24px rgb(0 0 0 / .16);animation:add-menu-in .12s ease-out;transform-origin:bottom left}
.composer-add-panel :deep(.mention-panel){display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;max-height:inherit;margin:0;box-sizing:border-box}
.composer-add-panel :deep(.mention-list){position:relative;flex:1 1 auto;min-height:0;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.composer-add-panel :deep(.mention-list::-webkit-scrollbar){width:6px}.composer-add-panel :deep(.mention-list::-webkit-scrollbar-thumb){border-radius:6px;background:var(--border)}
.composer-add-panel :deep(.mention-option){height:auto;min-height:36px;gap:10px;padding:7px 10px}.composer-add-panel :deep(.mention-option>svg),.composer-add-panel :deep(.mention-option>img){flex:none}
.composer-add-panel :deep(.mention-option:disabled){opacity:.55;cursor:not-allowed}
.add-option-copy{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}.add-option-label,.add-option-description,.add-option-reason{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.add-option-label{font-weight:500}.add-option-description,.add-option-reason{color:var(--fg-subtle);font-size:12px;line-height:18px}
.add-footer{display:flex;flex:none;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 12px;border-top:1px solid var(--border);font:400 12px/20px var(--font-ui);color:var(--fg-subtle)}
.add-shortcut,.add-search-hint{display:inline-flex;align-items:center;gap:6px;flex:none}.add-search-hint{flex-basis:100%}.add-shortcut code{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:4px;background:var(--bg-card);color:var(--fg);font-family:var(--font-mono)}
.add-skill-check{color:var(--fg-subtle);opacity:.45}.add-skill-check.on{color:var(--color-icon-blue,#508de0);opacity:1}
@keyframes add-menu-in{from{opacity:0;transform:translateY(4px) scale(.98)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.composer-add-panel{animation:none}}
</style>

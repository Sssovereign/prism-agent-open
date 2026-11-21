<script setup lang="ts">
import { computed,ref,watch,nextTick,onMounted,onUnmounted,onBeforeUnmount } from 'vue';
import type { RealRunSession } from '../view-model/realRun';
import { failureOfRun, formatTurnDuration } from '../view-model/realRun';
import type { ConversationRow, ConversationTextRow, WorkSegment } from '../../contracts/conversation';
import MarkdownText from './MarkdownText.vue';
import UiIcon from './UiIcon.vue';
import ControlHintTooltip from './ControlHintTooltip.vue';
import MessageTime from '../conversation/MessageTime.vue';
import CopyMessageButton from '../conversation/CopyMessageButton.vue';
import ToolCallItem from './ToolCallItem.vue';
import UserInput from '../conversation/UserInput.vue';
import MotionDisclosure from '../conversation/MotionDisclosure.vue';
import ReasoningBlock from '../conversation/ReasoningBlock.vue';
import TurnDeliverables from './TurnDeliverables.vue';
import ErrorBanner from './ErrorBanner.vue';
import { stopReasonText, ERROR_CODE_PRESETS, actionLabel } from '../ui/errorPresentation';
import { resolveHistoryOpen, readDisclosureChoice, saveDisclosureChoice } from '../conversation/motion';
import VirtualTurnList from '../conversation/VirtualTurnList.vue';
import {readReadingAnchor,saveReadingAnchor,type TurnAnchor} from '../conversation/virtualHistory';
import { atBottom, prependTop } from '../conversation/scroll';
const props=withDefaults(defineProps<{session:RealRunSession;objective:string;followOutput?:boolean;busy?:boolean;retrying?:boolean}>(),{followOutput:true});
const emit=defineEmits<{(e:'content-ready'):void;(e:'open-artifact',artifactId:string):void;(e:'open-settings'):void;(e:'resume'):void;(e:'retry',runId:string):void;(e:'fork-edit',payload:{messageId:string;text:string;onSuccess?:()=>void}):void;(e:'fork',messageId:string):void}>();
const virtualList=ref<InstanceType<typeof VirtualTurnList>>();
let pendingAnchor:TurnAnchor|undefined=readReadingAnchor(props.session.runId);
const root=ref<HTMLElement>(),actionError=ref(''),copied=ref(''),following=ref(pendingAnchor?.following??true),awayFromBottom=ref(false),open=ref<Record<string,boolean>>({});
const turns=computed(()=>props.session.turns.value);let region:HTMLElement|null=null,observer:ResizeObserver|undefined,timer:ReturnType<typeof setTimeout>|undefined,intentTimer:ReturnType<typeof setTimeout>|undefined,raf=0,userIntent=false,draggingScrollbar=false,lastTouchY=0,prepending=false,disposed=false;
function remember(scope=props.session.runId){const anchor=virtualList.value?.capture(following.value);if(anchor)saveReadingAnchor(scope,anchor);}
function abandonRestore(){pendingAnchor=undefined;virtualList.value?.releaseRestore();}
async function restoreRemembered(){if(!pendingAnchor||!turns.value.length)return;const target=pendingAnchor;if(target.following){abandonRestore();scrollToBottom();return;}following.value=false;
 if(await virtualList.value?.restore(target)){pendingAnchor=undefined;return;}
 if(props.session.hasOlderMessages.value&&!props.session.loadingEarlier.value){await props.session.loadEarlier();if(!props.session.loadError.value&&!disposed)await restoreRemembered();}
}
onBeforeUnmount(()=>remember());
function scrollToBottom(){clearTimeout(intentTimer);userIntent=false;abandonRestore();following.value=true;if(region)region.scrollTop=region.scrollHeight;remember();}
async function revealMessage(id:string,runId:string){
 for(let i=0;i<50&&!turns.value.some(t=>t.id===runId)&&props.session.hasOlderMessages.value;i++)await props.session.loadEarlier();
 await nextTick();following.value=false;await virtualList.value?.restore({id:runId,offset:0,following:false});await nextTick();
 const element=[...(root.value?.querySelectorAll<HTMLElement>('[data-message-id]')??[])].find(e=>e.dataset.messageId===id);if(element){element.scrollIntoView({block:'center'});const target=element.querySelector<HTMLElement>('.user-bubble')??element;target.animate([{backgroundColor:'var(--selected)',boxShadow:'0 0 0 6px var(--selected)'},{backgroundColor:getComputedStyle(target).backgroundColor,boxShadow:'0 0 0 0 transparent'}],{duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:1200,easing:'ease-out'});}
}
defineExpose({scrollToBottom,revealMessage});
function syncScrollPosition(){
 if(!region)return;
 const bottom=atBottom(region);awayFromBottom.value=!bottom;
 if(userIntent||draggingScrollbar||(bottom&&!pendingAnchor)){
  following.value=bottom;remember();
 }
}
function schedule(){cancelAnimationFrame(raf);raf=requestAnimationFrame(()=>{
 if(disposed||!region)return;
 // Measure after the browser applies user scrolling; an upward gesture alone does not leave the bottom.
 if(userIntent||draggingScrollbar){awayFromBottom.value=!atBottom(region);return;}
 if(!pendingAnchor&&region.scrollHeight<=region.clientHeight)syncScrollPosition();
 if(!prepending&&following.value&&props.followOutput)region.scrollTop=region.scrollHeight;
 awayFromBottom.value=!atBottom(region);
});}
function settleUserIntent(){
 clearTimeout(intentTimer);intentTimer=setTimeout(()=>{
  userIntent=false;schedule();
 },140);
}
function onScroll(){syncScrollPosition();if(userIntent)settleUserIntent();}
function markUserIntent(){
 if(!region||region.scrollHeight-region.clientHeight<=48)return;
 abandonRestore();userIntent=true;cancelAnimationFrame(raf);settleUserIntent();
}
function nestedScrollConsumes(target:EventTarget|null,direction:number){
 for(let element=target instanceof Element?target:null;element&&element!==region;element=element.parentElement){
  if(!(element instanceof HTMLElement))continue;
  const style=getComputedStyle(element);
  if(!/(auto|scroll|overlay)/.test(style.overflowY))continue;
  const maxTop=element.scrollHeight-element.clientHeight;
  if(maxTop>1&&((direction<0&&element.scrollTop>0)||(direction>0&&element.scrollTop<maxTop-1)))return true;
  if(style.overscrollBehaviorY==='contain'||style.overscrollBehaviorY==='none')return true;
 }
 return false;
}
function wheel(event:WheelEvent){if(event.deltaY!==0&&!event.ctrlKey&&!event.defaultPrevented&&!nestedScrollConsumes(event.target,event.deltaY))markUserIntent();}
function key(event:KeyboardEvent){const target=event.target as HTMLElement;if(target.closest('input,textarea,[contenteditable="true"]')||event.defaultPrevented)return;if(['ArrowUp','PageUp','Home','ArrowDown','PageDown','End',' '].includes(event.key)){
 const direction=['ArrowUp','PageUp','Home'].includes(event.key)||(event.key===' '&&event.shiftKey)?-1:1;
 if(!nestedScrollConsumes(event.target,direction))markUserIntent();
}}
function touchStart(event:TouchEvent){lastTouchY=event.touches[0]?.clientY??0;}
function touchMove(event:TouchEvent){const y=event.touches[0]?.clientY??lastTouchY;if(y!==lastTouchY&&!nestedScrollConsumes(event.target,lastTouchY-y))markUserIntent();lastTouchY=y;}
function pointer(event:PointerEvent){if(event.target===region){draggingScrollbar=true;markUserIntent();}}
function pointerEnd(){if(draggingScrollbar){syncScrollPosition();draggingScrollbar=false;}}
onMounted(()=>{region=root.value?.closest('.timeline-scroll') as HTMLElement|null;if(!region)return;region.addEventListener('scroll',onScroll,{passive:true});region.addEventListener('wheel',wheel,{passive:true});region.addEventListener('keydown',key);region.addEventListener('touchstart',touchStart,{passive:true});region.addEventListener('touchmove',touchMove,{passive:true});region.addEventListener('pointerdown',pointer);window.addEventListener('pointerup',pointerEnd);window.addEventListener('pointercancel',pointerEnd);observer=new ResizeObserver(schedule);if(root.value)observer.observe(root.value);void nextTick(restoreRemembered);schedule();});
onUnmounted(()=>{disposed=true;clearTimeout(timer);clearTimeout(intentTimer);cancelAnimationFrame(raf);observer?.disconnect();region?.removeEventListener('scroll',onScroll);region?.removeEventListener('wheel',wheel);region?.removeEventListener('keydown',key);region?.removeEventListener('touchstart',touchStart);region?.removeEventListener('touchmove',touchMove);region?.removeEventListener('pointerdown',pointer);window.removeEventListener('pointerup',pointerEnd);window.removeEventListener('pointercancel',pointerEnd);});
watch(turns,async()=>{await nextTick();await restoreRemembered();schedule();emit('content-ready');},{deep:true});
watch(()=>props.session.runId,(id,previous)=>{clearTimeout(intentTimer);userIntent=false;draggingScrollbar=false;awayFromBottom.value=false;remember(previous);open.value={};pendingAnchor=readReadingAnchor(id);following.value=pendingAnchor?.following??true;void nextTick(restoreRemembered);schedule();});
watch(()=>props.followOutput,enabled=>{if(enabled)schedule();});
function isOpen(segment:WorkSegment){return resolveHistoryOpen(segment.defaultOpen,open.value[segment.id]??readDisclosureChoice(props.session,segment.id));}
function toggle(value:boolean,id:string){open.value[id]=value;saveDisclosureChoice(props.session,id,value);}
async function copy(row:ConversationTextRow){try{await navigator.clipboard.writeText(row.text);copied.value=row.id;clearTimeout(timer);timer=setTimeout(()=>copied.value='',1800);}catch{actionError.value='复制失败，请选择文本后复制';}}
async function loadOlder(){const anchor=virtualList.value?.capture(following.value);if(!region){await props.session.loadEarlier();return;}const old={scrollTop:region.scrollTop,scrollHeight:region.scrollHeight,clientHeight:region.clientHeight};prepending=true;try{await props.session.loadEarlier();await nextTick();if(anchor)await virtualList.value?.restore(anchor);else region.scrollTop=prependTop(old,region.scrollHeight);}finally{prepending=false;}}
async function approve(decision:'approved'|'rejected'){try{await props.session.decideApproval(decision);}catch(e){actionError.value=e instanceof Error?e.message:'审批提交失败';}}
const users=(rows:ConversationRow[])=>rows.filter((r):r is ConversationTextRow=>r.kind==='user');
const outcome=(status:string)=>({succeeded:'已完成',failed:'执行失败',cancelled:'已停止',needs_reconciliation:'结果待核对',waiting_input:'等待连接设置',waiting_approval:'等待审批',cancelling:'正在停止'}[status]??'工作中');
function failureDetail(runId:string){return failureOfRun(props.session.runs.value.find(run=>run.id===runId))?.message??(runId===props.session.runId?props.session.failure.value?.message:undefined);}
function modelErrorAction(reason:string|null|undefined){return reason&&ERROR_CODE_PRESETS[reason]?.action==='open-model-settings'?actionLabel('open-model-settings'):undefined;}
// —— 块E5：消息编辑（独立分支重发）＋轮尾分叉；运行中不可用（上游“任务结束后可分叉”）——
const canForkEdit=computed(()=>!props.busy&&['succeeded','failed','cancelled'].includes(props.session.status.value));
const editingId=ref(''),editDraft=ref('');
const editBox=ref<HTMLTextAreaElement>();
function openEdit(row:ConversationTextRow){editingId.value=row.id;editDraft.value=row.text;void nextTick(()=>{const box=Array.isArray(editBox.value)?editBox.value[0]:editBox.value;box?.focus();box?.setSelectionRange(box.value.length,box.value.length);});}
function cancelEdit(){editingId.value='';editDraft.value='';}
function submitEdit(){const messageId=editingId.value,text=editDraft.value.trim();if(!messageId||!text)return;emit('fork-edit',{messageId,text,onSuccess:cancelEdit});}
function forkTurn(messageId:string|undefined){if(messageId)emit('fork',messageId);}
function canRetryTurn(turn:typeof turns.value[number]){return !props.busy&&!props.session.isActive.value&&turn.id===props.session.runId&&['failed','cancelled'].includes(turn.status);}
// —— 阶段④执行交接：最终消息中的【助手回报】逐项验收清单（已通过/未通过/待人工确认）结构化呈现 ——
import {parseAssistantReceipts, type AssistantReceipts} from '../conversation/receipts.js';
const receiptCache=new Map<string, AssistantReceipts|null>();
function receiptsOf(row:ConversationTextRow){const key=`${row.id}:${row.text.length}`;if(receiptCache.has(key))return receiptCache.get(key)!;
 const parsed=parseAssistantReceipts(row.text);receiptCache.set(key,parsed);return parsed;}
function canRegenerateTurn(turn:typeof turns.value[number]){return !props.busy&&!props.session.isActive.value&&turn.id===props.session.runId&&turn.status==='succeeded';}
function retryTurn(turn:typeof turns.value[number]){if(canRetryTurn(turn)||canRegenerateTurn(turn))emit('retry',turn.id);}

</script>
<template>
 <article ref="root" class="timeline real-timeline" aria-label="任务对话">
  <button v-if="session.hasOlderMessages.value" class="history-load-more text-btn" type="button" :disabled="session.loadingEarlier.value" @click="loadOlder">{{session.loadingEarlier.value?'正在加载完整工作轮次…':'加载更早对话'}}</button>
  <p v-if="retrying" role="status" class="notice-line">正在当前任务中重试…</p>
  <p v-else-if="session.retryNotice.value" role="status" class="notice-line">网络波动，模型请求正在自动重试（第 {{session.retryNotice.value.retry}}/{{session.retryNotice.value.maxRetries}} 次{{session.retryNotice.value.delayMs>0?`，约 ${Math.max(1,Math.round(session.retryNotice.value.delayMs/1000))} 秒后`:''}}）…</p>
  <p v-if="actionError" role="alert" class="action-error">{{actionError}}</p>
  <UserInput v-if="!turns.some(t=>t.segments.some(s=>users(s.rows).length))&&objective" :text="objective"/>
  <VirtualTurnList ref="virtualList" :turns="turns" :scope-key="session.runId" :following="following && followOutput" v-slot="{turn}">
  <section class="conversation-turn" :data-turn-id="turn.id">
   <section v-for="segment in turn.segments" :key="segment.id" class="work-segment" :data-segment-id="segment.id">
    <template v-for="user in users(segment.rows).filter(u=>u.delivery!=='accepted')" :key="user.id">
     <UserInput :text="user.text" :delivery="user.delivery" :attachments="user.attachments" :message-id="user.id" :created-at="user.createdAt" :editable="canForkEdit && editingId!==user.id" @edit="openEdit(user)"/>
     <div v-if="editingId===user.id" class="user-edit" role="form" aria-label="编辑消息">
      <textarea ref="editBox" v-model="editDraft" rows="3" maxlength="20000" aria-label="编辑后的消息" @keydown.esc.prevent="cancelEdit" @keydown.enter.exact.prevent="submitEdit"></textarea>
      <div class="user-edit-actions">
       <button type="button" class="btn btn-solid" :disabled="busy||!editDraft.trim()" title="从这条消息重新开始：保留原对话，在新分支中发送编辑后的内容" @click="submitEdit">发送到新分支</button>
       <button type="button" class="btn" @click="cancelEdit">取消</button>
      </div>
      <small>原对话保持不变，编辑内容将发送到新分支；文件不会自动回退。</small>
     </div>
    </template>
    <MotionDisclosure v-if="segment.history.length" class="work-history" :open="isOpen(segment)" label="展开或收起执行过程" @update:open="toggle($event,segment.id)">
     <template #summary><span>{{outcome(turn.status)}}<template v-if="segment.history.some(r=>r.kind==='tool')"> · {{segment.history.filter(r=>r.kind==='tool').length}} 项操作</template></span><small v-if="turn.durationMs!==undefined">{{formatTurnDuration(turn.durationMs)}}</small><svg class="history-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9 5 7 7-7 7"/></svg></template>
     <div class="work-content">
      <template v-for="row in segment.history" :key="row.id">
       <ToolCallItem v-if="row.kind==='tool'" :item="row" :session="session"/>
       <div v-else-if="row.kind==='assistant'" class="assistant-text"><MarkdownText :text="row.text"/><small v-if="row.streaming && session.isActive.value && turn.id===session.runId" role="status">正在生成…</small></div>
       <ReasoningBlock v-else-if="row.kind==='reasoning'" :row="row"/>
       <p v-else-if="row.kind==='notice'" class="notice-line">{{row.text}}</p>
      </template>
     </div>
    </MotionDisclosure>
    <ControlHintTooltip v-if="canRetryTurn(turn) && !segment.final && segment===turn.segments.at(-1)" text="重试本轮" side="bottom" v-slot="{describedby}"><button class="answer-action" type="button" aria-label="重试本轮" :aria-describedby="describedby" @click="retryTurn(turn)"><UiIcon name="refresh" :size="14" /></button></ControlHintTooltip>
    <div v-if="segment.final" class="final-answer" :data-message-id="segment.final.id"><template v-if="receiptsOf(segment.final)"><MarkdownText :text="receiptsOf(segment.final)!.body"/><section class="assistant-receipts" role="region" aria-label="助手回报"><header>助手回报</header><ul><li v-for="(receipt,index) in receiptsOf(segment.final)!.items" :key="index"><span class="receipt-status" :data-state="receipt.status==='已通过'?'pass':receipt.status==='未通过'?'fail':'manual'">{{receipt.status}}</span><span class="receipt-item">{{receipt.item}}</span><small v-if="receipt.detail">{{receipt.detail}}</small></li></ul></section></template><MarkdownText v-else :text="segment.final.text"/><div class="answer-actions"><CopyMessageButton :copied="copied===segment.final.id" label="复制答复" @copy="copy(segment.final)"/><ControlHintTooltip v-if="canForkEdit" text="从此处分叉新会话" side="bottom" v-slot="{describedby}"><button type="button" class="answer-action" aria-label="从这条答复分叉新会话" :aria-describedby="describedby" @click="forkTurn(segment.final.id)"><UiIcon name="fork" :size="14" /></button></ControlHintTooltip><ControlHintTooltip v-if="(canRetryTurn(turn)||canRegenerateTurn(turn)) && segment===turn.segments.at(-1)" :text="canRegenerateTurn(turn)?'重新回答：丢弃上一版答复并重新生成':'重试本轮'" side="bottom" v-slot="{describedby}"><button class="answer-action" type="button" :aria-label="canRegenerateTurn(turn)?'重新回答':'重试本轮'" :aria-describedby="describedby" @click="retryTurn(turn)"><UiIcon name="refresh" :size="14" /></button></ControlHintTooltip><MessageTime :value="segment.final.createdAt" /></div></div>
   </section>
   <TurnDeliverables :run-id="turn.id" :status="turn.status" :disabled="busy||session.isActive.value" :revision="session.runs.value.find(r=>r.id===turn.id)?.tools.filter(t=>['succeeded','failed'].includes(t.state)).length"/>
   <template v-for="user in turn.segments.flatMap(s=>users(s.rows)).filter(u=>u.delivery==='accepted')" :key="user.id">
    <UserInput :text="user.text" :delivery="user.delivery" :attachments="user.attachments" :message-id="user.id" :created-at="user.createdAt" :editable="canForkEdit && editingId!==user.id" @edit="openEdit(user)"/>
    <div v-if="editingId===user.id" class="user-edit" role="form" aria-label="编辑消息">
     <textarea ref="editBox" v-model="editDraft" rows="3" maxlength="20000" aria-label="编辑后的消息" @keydown.esc.prevent="cancelEdit" @keydown.enter.exact.prevent="submitEdit"></textarea>
     <div class="user-edit-actions">
      <button type="button" class="btn btn-solid" :disabled="busy||!editDraft.trim()" title="从这条消息重新开始：保留原对话，在新分支中发送编辑后的内容" @click="submitEdit">发送到新分支</button>
      <button type="button" class="btn" @click="cancelEdit">取消</button>
     </div>
     <small>原对话保持不变，编辑内容将发送到新分支；文件不会自动回退。</small>
    </div>
   </template>
   <p v-if="['cancelled','needs_reconciliation'].includes(turn.status)" class="turn-message" role="status">{{outcome(turn.status)}}。已有正文和工作记录已保留。<span v-if="turn.stopReason"> {{stopReasonText(turn.stopReason)}}</span></p>
   <ErrorBanner v-else-if="turn.status==='failed'" class="turn-error" :message="`${outcome(turn.status)}。已有正文和工作记录已保留。${turn.stopReason?`（${stopReasonText(turn.stopReason)}）`:''}`" :detail="failureDetail(turn.id)" :code="turn.stopReason??undefined" :run-id="turn.id" :action-label="modelErrorAction(turn.stopReason)" @action="emit('open-settings')"/>
  </section>
  </VirtualTurnList>
  <section v-if="session.approval.value" class="approval-card" role="region" aria-label="工具执行审批" :data-invocation-id="session.approval.value.invocationId">
   <strong>需要批准 · {{session.approval.value.tool}}</strong><small>关联操作 {{session.approval.value.invocationId}}</small><pre v-if="session.approval.value.review">{{session.approval.value.review.text}}</pre><pre v-else>{{JSON.stringify(session.approval.value.args,null,2)}}</pre><a v-if="session.approval.value.review?.truncated" :href="`/api/v1/runs/${session.runId}/approvals/${session.approval.value.approvalId}/review`" target="_blank" rel="noopener noreferrer">查看完整拟执行内容</a><div class="approval-actions"><button type="button" class="btn btn-solid" :disabled="session.busy.value" @click="approve('approved')">允许执行</button><button type="button" class="btn" :disabled="session.busy.value" @click="approve('rejected')">拒绝</button></div>
  </section>
  <p v-if="session.status.value==='loading'" role="status">正在加载完整对话…</p><p v-else-if="session.pendingQuestion.value" role="status">Agent 正在等待你的回答</p><p v-else-if="session.isActive.value&&!session.streamingText.value&&!session.approval.value" role="status">{{session.status.value==='cancelling'?'正在停止任务…':'正在处理任务…'}}</p>
  <div v-if="session.status.value==='waiting_input'" class="waiting-input-card"><strong>需要更新模型连接</strong><button type="button" :disabled="session.busy.value" @click="emit('open-settings')">设置模型连接</button><button type="button" :disabled="session.busy.value" @click="emit('resume')">继续任务</button></div>
  <p v-if="!session.connected.value&&session.isActive.value" class="notice-line">事件连接中断，正在重连…</p><p v-if="session.loadError.value" role="alert">{{session.loadError.value}} <button type="button" @click="session.retryHistory()">重试加载</button></p>
  <button v-if="awayFromBottom" type="button" class="back-to-bottom" @click="scrollToBottom">返回最新内容</button>
 </article>
</template>
<style scoped>
.real-timeline{position:relative;overflow-anchor:none}.conversation-turn{margin-bottom:24px}.work-segment{min-width:0}
.work-history{border:0;border-radius:0;background:transparent;box-shadow:none;margin:4px 0 16px;padding:0;color:var(--fg-subtle)}
.work-history :deep(>.disclosure-trigger){font-size:var(--text-ui-caption);line-height:20px;flex-wrap:nowrap}
.work-history :deep(>.disclosure-trigger)>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.work-history small{color:var(--fg-subtlest);font-size:var(--text-ui-sm);white-space:nowrap}.history-chevron{flex:none;color:var(--fg-subtlest);transition:transform 200ms cubic-bezier(0,0,.2,1)}.work-history[data-state=open] .history-chevron{transform:rotate(90deg)}
.work-content{margin:6px 0 0 6px;padding:0 0 2px 16px;min-width:0;border-left:1px solid var(--border);color:var(--fg)}.assistant-text{margin:8px 0 14px}.assistant-text small{font-size:var(--text-ui-sm);color:var(--fg-subtlest)}.final-answer{margin:16px 0 24px}.answer-actions{display:flex;align-items:center;gap:4px;min-height:28px;font-size:var(--text-ui-sm)}
/* 阶段④助手回报：逐项验收清单（状态chip+条目+依据） */
.assistant-receipts{border:1px solid var(--border);border-radius:var(--radius-m);background:var(--bg-panel);padding:12px 14px;margin:12px 0}
.assistant-receipts header{font-size:var(--text-ui-caption);color:var(--fg-subtle);margin-bottom:8px}
.assistant-receipts ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.assistant-receipts li{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;font-size:var(--text-ui-sm)}
.assistant-receipts .receipt-status{flex:none;padding:1px 8px;border-radius:10px;font-size:var(--text-ui-xs);border:1px solid var(--border)}
.assistant-receipts .receipt-status[data-state=pass]{color:var(--success,var(--fg));border-color:var(--success,var(--border))}
.assistant-receipts .receipt-status[data-state=fail]{color:var(--danger);border-color:var(--danger)}
.assistant-receipts .receipt-status[data-state=manual]{color:var(--warning);border-color:var(--warning)}
.assistant-receipts .receipt-item{min-width:0;overflow-wrap:anywhere}
.assistant-receipts small{min-width:0;overflow-wrap:anywhere;color:var(--fg-subtlest);flex-basis:100%}
.answer-action{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--fg-subtlest)}
.answer-action:hover{color:var(--fg);background:var(--hover)}
.answer-action:focus-visible{outline:2px solid var(--fg-subtle);outline-offset:2px}
.answer-actions :deep(.message-time){margin-left:8px}
/* 块E5：编辑框与分叉按钮（上游编辑为轮内 ChatPromptEditor；此处为 textarea 内联编辑器） */
.user-edit{display:flex;flex-direction:column;align-items:flex-end;gap:6px;margin:8px 0 12px;max-width:min(100%,576px);margin-left:auto}
.user-edit textarea{box-sizing:border-box;width:100%;min-height:72px;padding:10px 12px;border:1px solid var(--border);border-radius:12px 2px 12px 12px;background:var(--bg-input);color:var(--fg);font:inherit;font-size:var(--text-ui-base);line-height:1.6;resize:vertical}
.user-edit textarea:focus-visible{outline:2px solid var(--primary);outline-offset:1px}
.user-edit-actions{display:flex;gap:8px}
.user-edit small{color:var(--fg-subtlest);font-size:var(--text-ui-xs)}
.fork-action{display:inline-flex;align-items:center;gap:4px;padding:0;margin:0;border:none;background:transparent;color:var(--fg-subtle);font:inherit;font-size:var(--text-ui-sm);cursor:pointer;border-radius:6px}
.fork-action:hover{color:var(--fg);background:var(--hover)}
.fork-action:focus-visible{outline:2px solid var(--fg-subtle);outline-offset:1px}
.approval-card{border:1px solid var(--border);border-radius:var(--radius-m);background:var(--bg-panel);padding:16px;margin:16px 0;color:var(--fg)}.approval-card small{display:block;overflow-wrap:anywhere;color:var(--fg-subtlest);margin-top:6px}.approval-card pre{max-height:360px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}.approval-actions{display:flex;gap:10px}.turn-message{border-left:2px solid var(--warning);padding-left:12px;font-size:var(--text-ui-caption)}.turn-error{margin:8px 0 16px}.action-error{margin:4px 0;color:var(--danger);font-size:var(--text-ui-caption)}.waiting-input-card{display:flex;gap:10px;flex-wrap:wrap}.back-to-bottom{position:sticky;bottom:16px;display:block;margin:0 auto;background:var(--bg-panel);color:var(--fg);border:1px solid var(--border);border-radius:20px;padding:9px 18px;z-index:2;cursor:pointer}.back-to-bottom:hover{background:linear-gradient(var(--hover),var(--hover)),var(--bg-panel)}.notice-line{font-size:var(--text-ui-sm);color:var(--fg-subtle);background:transparent;border-radius:0;padding:4px 0}button{cursor:pointer}
@media(prefers-reduced-motion:reduce){.history-chevron{transition:none}}
</style>

import { computed, ref } from 'vue';
import { v1 } from '../api.js';
import type { UsageSnapshot } from '../../contracts/usage.js';
import type { ConversationRun, ConversationWindow, ConversationEvent, ConversationApproval, ConversationTextRow, ToolState } from '../../contracts/conversation.js';
import { activeStatus, mergeEvents, projectTurn } from '../conversation/project.js';
import type { UserQuestionRequest, UserQuestionResponse } from '../../contracts/userQuestions.js';
export type RealUsage = UsageSnapshot;
export interface RealToolItem { invocationId:string;tool:string;state:ToolState;orderAt?:number;durationMs?:number;error?:string;args?:Record<string,unknown>;resultPreview?:string;resultTruncated?:boolean;resultLoaded?:boolean }
export interface RealMessageItem {id:string;kind:'user'|'agent';text:string;artifactIds:string[];seq:number;orderAt?:number}
export interface RealNotice {seq:number;kind:string;text:string;orderAt?:number}
/** run失败的结构化详情（run.failed事件payload/frame.run.stopReason双路写入），驱动失败横幅 */
export interface RealRunFailure {code?:string;message?:string;retryable?:boolean}
/** 从持久会话恢复错误，避免依赖SSE重放；历史轮次也沿用同一来源。 */
export function failureOfRun(run: Pick<ConversationRun,'status'|'stopReason'|'events'> | undefined): RealRunFailure|null {
 if(!run||!['failed','needs_reconciliation'].includes(run.status))return null;
 const payload=run.events.slice().reverse().find(event=>event.type==='run.failed')?.payload;
 if(payload&&(!run.stopReason||payload.error===run.stopReason))return {
  code:typeof payload.error==='string'?payload.error:run.stopReason??undefined,
  message:typeof payload.message==='string'?payload.message.slice(0,500):undefined,
  retryable:typeof payload.retryable==='boolean'?payload.retryable:undefined,
 };
 return run.stopReason?{code:run.stopReason}:null;
}
const labels:Record<string,string>={read_file:'读取文件',list_dir:'列出目录',grep_files:'搜索文件',bash:'执行命令',write_file:'写入文件',delete_file:'删除文件',write_artifact:'保存产物',read_artifact:'读取产物'};
export const toolLabel=(name:string)=>labels[name]??name;
/** 轮次耗时：<60秒保留一位小数「42.5 秒」，更长进位为「4 分 13 秒」「1 小时 2 分 3 秒」。 */
export function formatTurnDuration(durationMs: number): string {
 if(!Number.isFinite(durationMs)||durationMs<=0)return '0.0 秒';
 if(durationMs<60_000)return `${(durationMs/1000).toFixed(1)} 秒`;
 const total=Math.round(durationMs/1000), hours=Math.floor(total/3600), minutes=Math.floor((total%3600)/60), seconds=total%60;
 if(hours>0)return `${hours} 小时 ${minutes} 分 ${seconds} 秒`;
 return `${minutes} 分 ${seconds} 秒`;
}
interface Frame {type:string;run?:{id:string;status:string;stopReason?:string|null};event?:ConversationEvent}
export class RealRunSession {
 readonly runId:string;
 readonly status=ref('loading');readonly stopReason=ref<string|null>(null);
 readonly runs=ref<ConversationRun[]>([]);
 /** 阶段④续聊：会话内研究run不投影成普通轮次（面板负责呈现），时间线只保留普通run */
 readonly ordinaryRuns=computed(()=>this.runs.value.filter(r=>r.mode!=='debate'&&r.mode!=='jury'));
 readonly turns=computed(()=>this.ordinaryRuns.value.map(projectTurn));
 readonly messages=computed<RealMessageItem[]>(()=>this.ordinaryRuns.value.flatMap(r=>r.messages.filter(m=>['user','agent'].includes(m.authorType)).map(m=>({id:m.id,kind:m.authorType==='user'?'user' as const:'agent' as const,text:m.content.text??'',artifactIds:m.content.artifactIds??[],seq:m.seq}))));
 /** 阶段④续聊：会话研究锚点（独立于分页）——普通run打开时据此重建研究面板 */
 readonly researchAnchor=ref<import('../../contracts/conversation.js').ConversationResearchAnchor|null>(null);
 readonly tools=computed<RealToolItem[]>(()=>this.turns.value.flatMap(t=>t.segments.flatMap(s=>s.rows.filter(r=>r.kind==='tool').map(r=>({...r,...this.details.value[r.invocationId]})))));
 readonly notices=ref<RealNotice[]>([]);
 /** 块D任务清单：todo.updated事件触发刷新；初载与快照合并时亦读取 */
 readonly todos=ref<Array<{id:string;position:number;content:string;status:string}>>([]);
 /** 子代理活动区刷新信号（subagent.message事件递增） */
 readonly subagentRevision=ref(0);
 private todosGeneration=0;
 readonly streamingText=computed(()=>this.turns.value.find(t=>t.id===this.runId)?.segments.flatMap(s=>s.rows).slice().reverse().find((r):r is ConversationTextRow=>r.kind==='assistant'&&!!r.streaming)?.text??'');
 readonly charRate=ref<number|null>(null);readonly usage=ref<RealUsage|null>(null);
 readonly approval=ref<(ConversationApproval&{tool:string;args:Record<string,unknown>;expiresAt:string})|null>(null);
 readonly userQuestions=computed(()=>this.runs.value.flatMap(r=>r.userQuestions??[]));
 readonly pendingQuestion=computed(()=>this.userQuestions.value.find(q=>q.runId===this.runId&&q.state==='pending')??null);
 private questionGeneration=0;
 readonly hasOlderMessages=ref(false);readonly loadingEarlier=ref(false);readonly connected=ref(false);readonly loadError=ref('');readonly busy=ref(false);
 readonly failure=ref<RealRunFailure|null>(null);
 /** 弱网自愈进度：pi会话内自动重试进行中（run.retry_scheduled/retry_finished驱动；终态清空） */
 readonly retryNotice=ref<{retry:number;maxRetries:number;delayMs:number;message:string}|null>(null);
 readonly isActive=computed(()=>activeStatus(this.status.value));
 readonly details=ref<Record<string,{resultPreview:string;resultTruncated:boolean;resultLoaded:boolean;diff?:{changeRecordId:string;path:string;operation:string;addedLines:number;removedLines:number}}>>({});
 private lastSeq=0;private before:string|null=null;private disposed=false;private abort?:AbortController;private lastByteAt=0;
 private usageTimer?:ReturnType<typeof setInterval>;private retryTimer?:ReturnType<typeof setTimeout>;private wakeRetry?:()=>void;
 private liveRevision=0;private snapshotGeneration=0;private approvalGeneration=0;private usageGeneration=0;
 private pendingDetails=new Map<string,Promise<void>>();private started=false;
 private generationSamples:Array<{at:number;length:number}>=[];private generationMessage='';private rateTimer?:ReturnType<typeof setInterval>;
 constructor(runId:string){this.runId=runId;}
 async start():Promise<void>{
  if(this.started||this.disposed)return;this.started=true;
  // Live is subscribed concurrently. Complete snapshots union with all received seqs, never replace the tail.
 void this.reconnectLoop();await this.refreshConversation();if(this.disposed)return;
  // node测试无DOM：网络感知监听仅在浏览器环境挂载
  if(typeof window!=='undefined'){window.addEventListener('online',this.onOnline);window.addEventListener('offline',this.onOffline);}
 void this.refreshUsage();void this.refreshApproval();void this.refreshTodos();void this.refreshQuestions();
  this.usageTimer=setInterval(()=>{if(this.isActive.value)void this.refreshUsage();},2500);
  this.rateTimer=setInterval(()=>this.updateCharRate(),500);
 }
 dispose():void{this.disposed=true;this.abort?.abort();clearInterval(this.usageTimer);clearInterval(this.rateTimer);clearTimeout(this.retryTimer);this.wakeRetry?.();if(typeof window!=='undefined'){window.removeEventListener('online',this.onOnline);window.removeEventListener('offline',this.onOffline);}}
 // 弱网感知：断网立即掐断当前流避免半开连接挂死到TCP超时；恢复联网唤醒退避等待立即重连——
 // 含8次耗尽后的手动等待态（网络恢复自动续上，不必再点“重试加载对话”）
 private onOffline=():void=>{if(!this.disposed)this.abort?.abort();};
 private onOnline=():void=>{if(!this.disposed)this.wakeRetry?.();};
 private ensureRun():ConversationRun{
  let run=this.runs.value.find(r=>r.id===this.runId);
  if(!run){run={id:this.runId,mode:'ordinary',status:this.status.value,createdAt:'',throughSeq:0,messages:[],events:[],tools:[],approvals:[]};this.runs.value.push(run);run=this.runs.value.find(r=>r.id===this.runId)!;}return run;
 }
 private async refreshConversation(before?:string):Promise<void>{
  const generation=before?0:++this.snapshotGeneration,revision=this.liveRevision;
  try{const data=await v1<ConversationWindow>(`/api/v1/runs/${this.runId}/conversation?limit=10${before?`&before=${encodeURIComponent(before)}`:''}`);
   if(this.disposed||(!before&&generation!==this.snapshotGeneration))return;
   const map=new Map(this.runs.value.map(r=>[r.id,r]));
   if(!before)this.researchAnchor.value=data.research??null;
   for(const incoming of data.runs){const existing=map.get(incoming.id);const merged={...incoming,events:mergeEvents(existing?.events??[],incoming.events)};
    if(existing){merged.messages=[...new Map([...existing.messages,...incoming.messages].map(m=>[m.id,m])).values()].sort((a,b)=>a.seq-b.seq);if(incoming.id===this.runId&&revision!==this.liveRevision){merged.status=existing.status;merged.stopReason=existing.stopReason;merged.userQuestions=existing.userQuestions??incoming.userQuestions;}}
    map.set(incoming.id,merged);
    if(incoming.id===this.runId){this.lastSeq=Math.max(this.lastSeq,incoming.throughSeq);if(revision===this.liveRevision){this.status.value=merged.status;this.stopReason.value=merged.stopReason??null;this.failure.value=failureOfRun(merged);}}
   }
   this.runs.value=[...map.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
   if(before||this.before===null){this.before=data.before;this.hasOlderMessages.value=data.hasOlder;}
   this.loadError.value='';
  }catch(error){if(!this.disposed)this.loadError.value=error instanceof Error?error.message:'完整对话加载失败';}
 }
 private async reconnectLoop():Promise<void>{let retries=0;
  while(!this.disposed){this.abort=new AbortController();try{await this.pump(this.abort.signal);if(!this.isActive.value&&this.status.value!=='loading')return;throw new Error('事件连接中断');}
   catch(error){this.connected.value=false;if(this.disposed)return;if(error instanceof Error&&error.message==='SSE 401'){this.loadError.value='登录已过期，请刷新页面';return;}
    retries++;
    if(retries>=8){
     // 8次自动重试后停止自动重连，但循环保持可唤醒：用户点“重试加载对话”（retryHistory）
     // 即重置计数并恢复事件流，而不是永久断流只能刷新页面
     this.loadError.value='事件连接失败，请点击“重试加载对话”恢复';
     await new Promise<void>(resolve=>{this.wakeRetry=resolve;});
     if(this.disposed)return;retries=0;this.loadError.value='';
    }else{
     // 指数退避500ms→8s封顶，等半抖动：弱网下多页面/多run的重连不再同步惊群
     const cap=Math.min(8000,500*2**retries);
     await new Promise<void>(resolve=>{this.wakeRetry=resolve;this.retryTimer=setTimeout(resolve,Math.round(cap/2+Math.random()*cap/2));});
     if(this.disposed)return;
    }
    if(!this.disposed)await this.refreshConversation();
   }
  }
 }
 private async pump(signal:AbortSignal):Promise<void>{
  const response=await fetch(`/api/v1/runs/${this.runId}/events/stream?after=${this.lastSeq}`,{signal,headers:{Accept:'text/event-stream'}});
  if(!response.ok||!response.body)throw new Error(`SSE ${response.status}`);
  if(this.disposed)return;this.connected.value=true;const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  // 弱网watchdog：高丢包下TCP可能静默死亡（半开连接），reader.read()会挂到分钟级内核超时。
  // 服务端空闲15s发注释帧心跳；30s无任何字节即视为断流，主动abort交给reconnectLoop游标续传。
  this.lastByteAt=Date.now();
  const watchdog=setInterval(()=>{if(Date.now()-this.lastByteAt>30000)this.abort?.abort();},5000);
  try{for(;;){const {done,value}=await reader.read();if(done)break;this.lastByteAt=Date.now();buffer+=decoder.decode(value,{stream:true});let match:RegExpExecArray|null;
   while((match=/\r?\n\r?\n/.exec(buffer))){const frame=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);const data=frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data)continue;let parsed:Frame;try{parsed=JSON.parse(data);}catch{continue;}this.handleFrame(parsed);}
  }}finally{clearInterval(watchdog);reader.releaseLock();this.connected.value=false;}
 }
 private handleFrame(frame:Frame):void{
  if(this.disposed)return;
  if(frame.run){this.liveRevision++;this.status.value=frame.run.status;this.stopReason.value=frame.run.stopReason??null;const run=this.ensureRun();run.status=frame.run.status;run.stopReason=this.stopReason.value;if(frame.run.status==='running')this.failure.value=null;}
  if(frame.event){const event=frame.event;const run=this.ensureRun();if(run.events.some(e=>e.seq===event.seq))return;
   this.liveRevision++;run.events=mergeEvents(run.events,[{...event,runId:this.runId}]);this.lastSeq=Math.max(this.lastSeq,event.seq);
   if(event.type==='message.delta'){
    const id=String(event.payload.messageId??'legacy');if(id!==this.generationMessage){this.generationSamples=[];this.generationMessage=id;}
    this.generationSamples.push({at:Date.now(),length:typeof event.payload.content==='string'?event.payload.content.length:0});this.updateCharRate();
   }
   if(event.type==='message.completed'){this.generationSamples=[];this.charRate.value=null;if(event.payload.role==='agent')void this.refreshConversation();}
   if(event.type==='run.failed'){const p=event.payload as {error?:string;message?:string;retryable?:boolean};this.failure.value={code:typeof p.error==='string'?p.error:undefined,message:typeof p.message==='string'?p.message.slice(0,500):undefined,retryable:p.retryable===true};this.retryNotice.value=null;}
   if(event.type==='run.retry_scheduled'){
    const p=event.payload as {retry?:number;maxRetries?:number;delayMs?:number;message?:string};
    this.retryNotice.value={retry:typeof p.retry==='number'?p.retry:0,maxRetries:typeof p.maxRetries==='number'?p.maxRetries:0,delayMs:typeof p.delayMs==='number'?p.delayMs:0,message:typeof p.message==='string'?p.message:''};
   }
   if(event.type==='run.retry_finished'||event.type==='run.retried')this.retryNotice.value=null;
   if(['run.created','run.started','run.resumed'].includes(event.type))this.failure.value=null;
   if(['message.accepted','message.accepted_applied','message.applied','steer.applied','message.consumed'].includes(event.type))void this.refreshConversation();
   if(event.type==='tool.completed'){delete this.details.value[String(event.payload.invocationId)];void this.refreshConversation();}
   if(event.type==='todo.updated')void this.refreshTodos();
   if(event.type==='subagent.message')this.subagentRevision.value++;
   if(event.type.startsWith('question.'))void this.refreshQuestions();
   if(['tool.awaiting_approval','approval.decided'].includes(event.type))void this.refreshApproval();
  }
  if(frame.type==='end'){void this.refreshConversation();void this.refreshUsage();void this.refreshApproval();void this.refreshQuestions();}
 }
 private updateCharRate():void{
  this.generationSamples=this.generationSamples.filter(s=>Date.now()-s.at<=2000);const first=this.generationSamples[0],last=this.generationSamples.at(-1);
  this.charRate.value=first&&last&&last.at-first.at>200&&last.length>=first.length?Math.round((last.length-first.length)*1000/(last.at-first.at)):null;
 }
 private async refreshApproval():Promise<void>{const generation=++this.approvalGeneration;
  try{const data=await v1<{approvals:ConversationApproval[]}>(`/api/v1/runs/${this.runId}/approvals`);if(this.disposed||generation!==this.approvalGeneration)return;
   const run=this.ensureRun();run.approvals=data.approvals;const p=data.approvals.find(a=>a.state==='pending');this.approval.value=p?{...p,tool:p.tool??'',args:p.args??{},expiresAt:p.expiresAt??''}:null;
  }catch{/* preserve known pending approval on transient transport failure */}
 }
 async refreshUsage():Promise<void>{const generation=++this.usageGeneration;try{const data=await v1<RealUsage>(`/api/v1/runs/${this.runId}/usage`);if(!this.disposed&&generation===this.usageGeneration)this.usage.value=data;}catch{}}
 async refreshQuestions():Promise<void>{const generation=++this.questionGeneration;try{const data=await v1<{questions:UserQuestionRequest[]}>(`/api/v1/runs/${this.runId}/questions`);if(!this.disposed&&generation===this.questionGeneration)this.ensureRun().userQuestions=data.questions;}catch{/* retain pending form on transient transport errors */}}
 async answerQuestion(id:string,response:UserQuestionResponse):Promise<void>{this.busy.value=true;try{await v1(`/api/v1/runs/${this.runId}/questions/${encodeURIComponent(id)}/answer`,{method:'POST',body:JSON.stringify(response)});}finally{await this.refreshQuestions();this.busy.value=false;}}
 async pauseQuestion(id:string):Promise<void>{await v1(`/api/v1/runs/${this.runId}/questions/${encodeURIComponent(id)}/snooze`,{method:'POST'});await this.refreshQuestions();}
 async refreshTodos():Promise<void>{const generation=++this.todosGeneration;try{const data=await v1<{todos:Array<{id:string;position:number;content:string;status:string}>}>(`/api/v1/runs/${this.runId}/todos`);if(!this.disposed&&generation===this.todosGeneration)this.todos.value=data.todos;}catch{}}
 async refreshTools():Promise<void>{await this.refreshConversation();}
 async loadToolResult(invocationId:string):Promise<void>{
  if(this.details.value[invocationId]?.resultLoaded)return;
  const pending=this.pendingDetails.get(invocationId);if(pending)return pending;
  const work=(async()=>{const result=await v1<{preview:string;truncated:boolean;diff?:{changeRecordId:string;path:string;operation:string;addedLines:number;removedLines:number}}>(`/api/v1/runs/${this.runId}/tools/${encodeURIComponent(invocationId)}`);if(this.disposed)return;const item=this.tools.value.find(t=>t.invocationId===invocationId);this.details.value[invocationId]={resultPreview:result.preview,resultTruncated:result.truncated,resultLoaded:!!item&&!['running','awaiting_approval'].includes(item.state),diff:result.diff};})();
  this.pendingDetails.set(invocationId,work);try{await work;}finally{this.pendingDetails.delete(invocationId);}
 }
 async loadEarlier():Promise<void>{if(!this.before||!this.hasOlderMessages.value||this.loadingEarlier.value)return;this.loadingEarlier.value=true;try{await this.refreshConversation(this.before);}finally{this.loadingEarlier.value=false;}}
 async retryHistory():Promise<void>{this.wakeRetry?.();await this.refreshConversation();}
 async steer(text:string,clientMessageId:string=crypto.randomUUID(),attachmentIds:string[]=[]):Promise<{accepted:boolean;messageId?:string;clientMessageId?:string}>{this.busy.value=true;try{
  const result=await v1<{messageId:string;duplicate?:boolean}>(`/api/v1/runs/${this.runId}/steer`,{method:'POST',body:JSON.stringify({text,clientMessageId,attachmentIds:attachmentIds.length?attachmentIds:undefined})});await this.refreshConversation();return {accepted:true,messageId:result.messageId,clientMessageId};
 }finally{this.busy.value=false;}}
 async cancel():Promise<void>{this.busy.value=true;try{await v1(`/api/v1/runs/${this.runId}/cancel`,{method:'POST'});}finally{this.busy.value=false;}}
 async decideApproval(decision:'approved'|'rejected'):Promise<void>{const approval=this.approval.value;if(!approval)return;this.busy.value=true;try{await v1(`/api/v1/runs/${this.runId}/approvals/decision`,{method:'POST',body:JSON.stringify({approvalId:approval.approvalId,decision})});await this.refreshApproval();}finally{this.busy.value=false;}}
}

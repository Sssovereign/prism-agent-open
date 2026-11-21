import { reasoningSnapshot } from '../../contracts/reasoning.js';
import type { ConversationRun, ConversationTurn, ConversationRow, ConversationTextRow, ConversationToolRow, ToolState, ConversationEvent } from '../../contracts/conversation.js';
export const activeStatus = (s: string) => ['created','queued','running','waiting_approval','recovering','summarizing','cancelling'].includes(s);
export function toolState(state: string, error?: string | null, runStatus = ''): ToolState {
  if (state === 'succeeded' || state === 'done') return 'done';
  if (state === 'cancelled') return error === 'DEFERRED_BY_USER_INPUT' ? 'deferred' : 'cancelled';
  if (state === 'failed' || state === 'denied') return 'failed';
  if (state === 'awaiting_approval' || state === 'deferred' || state === 'unknown') return state;
  return activeStatus(runStatus) ? 'running' : 'unknown';
}
/** A seq is scoped to a run. HTTP replay may arrive behind the live high-water mark. */
export function mergeEvents(previous: ConversationEvent[], incoming: ConversationEvent[]): ConversationEvent[] {
  const map = new Map(previous.map(e => [e.seq, e]));
  for (const event of incoming) if (!map.has(event.seq)) map.set(event.seq, event);
  return [...map.values()].sort((a,b) => a.seq-b.seq);
}
const str = (v: unknown) => typeof v === 'string' ? v : '';
const noticeTypes: Record<string,string> = { 'context.compaction.started':'正在压缩上下文', 'context.compaction.completed':'上下文已压缩并确认', 'context.compaction.failed':'上下文压缩失败', 'run.inherited_artifacts':'已继承此前任务产物', 'run.complete_rejected':'完成提议未通过', 'run.needs_reconciliation':'执行结果需要核对' };
export function projectTurn(run: ConversationRun): ConversationTurn {
  const rows = new Map<string,ConversationRow>();
  const abandonedIds=new Set(run.abandonedMessageIds??[]);
  const messages = [...run.messages].sort((a,b)=>a.seq-b.seq);
  for (const m of messages) {
    if (!['user','agent'].includes(m.authorType)) continue;
    rows.set(m.id,{id:m.id,createdAt:m.createdAt,kind:m.authorType==='user'?'user':'assistant',text:m.content.text??'',seq:m.authorType==='user'?0:Number.MAX_SAFE_INTEGER,artifactIds:m.content.artifactIds??[],attachments:m.authorType==='user'?(m.content.attachments??[]):undefined,final:m.authorType==='agent',clientMessageId:m.clientMessageId,delivery:m.authorType==='user'&&m.clientMessageId?(m.applied?'applied':'accepted'):undefined});
  }
  let legacyId = `${run.id}:assistant:0`;
  const boundaries: Array<{id:string;seq:number;triggers:string[]}> = [];
  let lastAssistantId = '';
  const completedMessages=new Set<string>();
  const finalSources=new Set<string>(messages.filter(m=>m.authorType==='agent'&&m.content.sourceAssistantMessageId&&m.content.sourceAssistantMessageId!==m.id).map(m=>m.content.sourceAssistantMessageId!));
  for (const e of mergeEvents([],run.events)) {
    const p=e.payload;
    if(e.type==='reasoning.updated'||e.type==='reasoning.completed') {
      const snapshot=reasoningSnapshot(p);
      if(!snapshot||snapshot.runId!==run.id||(e.attemptId&&snapshot.attemptId!==e.attemptId)
        ||(e.type==='reasoning.updated'&&snapshot.state!=='streaming')
        ||(e.type==='reasoning.completed'&&snapshot.state==='streaming'))continue;
      const id=`reasoning:${snapshot.blockId}`, old=rows.get(id);
      if(old?.kind==='reasoning'&&(old.state!=='streaming'||old.revision>=snapshot.revision))continue;
      rows.set(id,{...snapshot,kind:'reasoning',id,seq:old?.seq??e.seq});
    }
    if(e.type==='message.accepted') {
      const row=rows.get(str(p.messageId));
      if(row?.kind==='user') {row.seq=e.seq;row.createdAt??=e.occurredAt;row.delivery=row.delivery==='applied'?'applied':'accepted';}
    }
    if (['message.accepted_applied','message.applied','steer.applied','message.consumed'].includes(e.type)) {
      const ids=Array.isArray(p.messageIds)?p.messageIds.filter((id):id is string=>typeof id==='string'):[str(p.messageId)].filter(Boolean);
      for(const id of ids){const row=rows.get(id);if(row?.kind==='user')row.delivery='applied';}
      if(ids.length){
        const id=str(p.workSegmentId)||`${run.id}:segment:${ids[0]}`;
        const existing=boundaries.find(b=>b.id===id||b.triggers.some(trigger=>ids.includes(trigger)));
        if(existing)existing.triggers=[...new Set([...existing.triggers,...ids])];
        else boundaries.push({id,seq:e.seq,triggers:ids});
      }
    }
    if(e.type==='message.delta'||e.type==='message.completed') {
      // D86分叉式重答：被墓碑化的旧答复（存储行已非published）其事件行不再上屏——
      // 否则事件流会把它重新投成final（插入序晚于新答复的存储行，finalRows.at(-1)取错）。
      if(abandonedIds.has(str(p.messageId)))continue;
      if(p.role==='agent') {
        const id=str(p.messageId)||messages.slice().reverse().find(m=>m.authorType==='agent')?.id||`${run.id}:final`;
        const old=rows.get(id);
        const content=str(p.content)||(old?.kind==='assistant'?old.text:'');
        if(content)rows.set(id,{kind:'assistant',id,createdAt:(old?.kind==='assistant'?old.createdAt:undefined)??e.occurredAt,text:content,seq:e.seq,artifactIds:Array.isArray(p.artifactIds)?p.artifactIds.filter((x):x is string=>typeof x==='string'):[],final:true});
        const source=str(p.sourceAssistantMessageId);
        if(source && source!==id){rows.delete(source);finalSources.add(source);}
        // Legacy events lack a source ID: collapse only the immediately preceding identical final text.
        else if(!source && lastAssistantId!==id) {const previous=rows.get(lastAssistantId);if(previous?.kind==='assistant'&&!previous.final&&previous.text===content)rows.delete(lastAssistantId);}
      } else if(p.role===undefined||p.role==='assistant') {
        const id=str(p.messageId)||legacyId;
        if(finalSources.has(id)||(e.type==='message.delta'&&completedMessages.has(id)))continue;
        if(e.type==='message.completed')completedMessages.add(id);
        // pi会话内自动重试：失败attempt的完结事件（error/aborted且无正文）不入时间线，
        // 否则重试成功后残留空助手行；completedMessages仍登记以抑制该id的迟到增量。
        if(e.type==='message.completed'&&!str(p.content)&&['error','aborted'].includes(str(p.stopReason))){lastAssistantId=id;legacyId=`${run.id}:assistant:after:${e.seq}`;continue;}
        rows.set(id,{kind:'assistant',id,createdAt:(rows.get(id) as ConversationTextRow|undefined)?.createdAt??e.occurredAt,text:str(p.content),seq:rows.get(id)?.seq??e.seq,artifactIds:[],streaming:e.type==='message.delta'});
        lastAssistantId=id;
        if(e.type==='message.completed')legacyId=`${run.id}:assistant:after:${e.seq}`;
      }
    }
    if(['tool.started','tool.awaiting_approval','tool.completed','tool.deferred','tool.cancelled'].includes(e.type)) {
      const id=str(p.invocationId);if(!id)continue;
      const old=rows.get(id) as ConversationToolRow|undefined;
      const state:ToolState=e.type==='tool.cancelled'?'cancelled':e.type==='tool.completed'?(p.ok===true?'done':'failed'):e.type==='tool.deferred'?'deferred':e.type==='tool.awaiting_approval'?'awaiting_approval':'running';
      rows.set(id,{...old,kind:'tool',id,invocationId:id,seq:old?.seq??e.seq,tool:str(p.tool)||old?.tool||'tool',state,args:(p.args as Record<string,unknown>|undefined)??old?.args,error:str(p.error)||old?.error,durationMs:typeof p.durationMs==='number'?p.durationMs:old?.durationMs});
    }
    if(noticeTypes[e.type])rows.set(`event:${run.id}:${e.seq}`,{kind:'notice',id:`event:${run.id}:${e.seq}`,seq:e.seq,text:noticeTypes[e.type]+(str(p.message)?`：${str(p.message)}`:'')});
  }
  for(const t of run.tools){const old=rows.get(t.invocationId) as ConversationToolRow|undefined;
    const state=toolState(t.state,t.error,run.status);
    rows.set(t.invocationId,{...old,kind:'tool',id:t.invocationId,invocationId:t.invocationId,seq:old?.seq??Number.MAX_SAFE_INTEGER-1,tool:t.tool,state:old&&['done','failed','cancelled','deferred'].includes(old.state)&&['running','awaiting_approval'].includes(state)?old.state:state,args:t.args??old?.args,error:t.error??old?.error,durationMs:t.durationMs??old?.durationMs,approval:run.approvals.find(a=>a.invocationId===t.invocationId)});
  }
  for(const row of rows.values())if(row.kind==='tool'){
    row.approval=run.approvals.slice().reverse().find(a=>a.invocationId===row.invocationId);
    if(!activeStatus(run.status)&&['running','awaiting_approval'].includes(row.state))row.state=run.status==='cancelled'?'cancelled':'unknown';
  }
  for(const row of rows.values())if(row.kind==='reasoning'&&!activeStatus(run.status)&&row.state==='streaming')row.state='interrupted';
  // Authoritative stored finals supersede their source even when HTTP precedes SSE.
  const finalRows=[...rows.values()].filter((r):r is ConversationTextRow=>r.kind==='assistant'&&!!r.final);
  const final=finalRows.at(-1);
  if(final){const preceding=rows.get(lastAssistantId);if(preceding?.kind==='assistant'&&!preceding.final&&preceding.text===final.text)rows.delete(lastAssistantId);}
  const segments=[{id:`${run.id}:segment:initial`,seq:-1,triggers:[] as string[]},...boundaries].map(b=>({...b,rows:[] as ConversationRow[]}));
  for(const row of [...rows.values()].sort((a,b)=>a.seq-b.seq)){
    const trigger=segments.find(s=>s.triggers.includes(row.id));
    const segment=trigger??segments.slice().reverse().find(s=>s.seq<=row.seq)??segments[0]!;
    segment.rows.push(row);
  }
  const elapsed=run.endedAt?Date.parse(run.endedAt)-Date.parse(run.createdAt):NaN;
  return {id:run.id,status:run.status,stopReason:run.stopReason,durationMs:Number.isFinite(elapsed)?Math.max(0,elapsed):undefined,segments:segments.map(s=>{
    const answer=finalRows.slice().reverse().find(r=>s.rows.includes(r));
    const history=s.rows.filter(r=>r!==answer&&r.kind!=='user'&&!(r.kind==='assistant'&&r.final));
    return {id:s.id,triggerMessageIds:s.triggers,rows:s.rows,history,final:answer,defaultOpen:run.status!=='succeeded'||history.some(r=>r.kind==='tool'&&['failed','cancelled','unknown','awaiting_approval'].includes(r.state))};
  })};
}

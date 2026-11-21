import type { Db } from '../storage/db.js';
import type { UsageBuckets, UsageEvidence, UsageRequest, UsageRequestPage, UsageSnapshot, UsageSource } from '../../contracts/usage.js';
import { contextMeasurement, count } from './contextMeasurement.js';

interface Row {
  request_id: string; run_id: string; provider: string; model: string; request_kind: string; status: string;
  normalized_usage_json: string | null; usage_evidence_json: string | null; usage_source: UsageSource;
  ttft_ms: number | null; first_text_ms: number | null; latency_ms: number | null;
  started_at: string | null; completed_at: string | null; created_at: string;
  speed_valid: number; decode_tokens: number | null; decode_ms: number | null;
  context_window: number | null; reserve_output_tokens: number | null;
}
const empty = (): UsageBuckets => ({input:null,output:null,cacheRead:null,cacheWrite:null,reasoning:null,totalInput:null});
function buckets(row: Row): UsageBuckets {
  // Pre-provenance SDK values cannot distinguish absent usage from an actual zero.
  if (!row.normalized_usage_json) return empty();
  const data = JSON.parse(row.normalized_usage_json) as UsageBuckets;
  return Object.fromEntries(Object.keys(empty()).map(key => [key,count(data[key as keyof UsageBuckets])])) as unknown as UsageBuckets;
}
function request(row: Row): UsageRequest {
  const u = buckets(row);
  return {requestId:row.request_id,runId:row.run_id,provider:row.provider,model:row.model,kind:row.request_kind,status:row.status,
    inputTokens:u.input,outputTokens:u.output,cacheRead:u.cacheRead,cacheWrite:u.cacheWrite,reasoning:u.reasoning,totalInputTokens:u.totalInput,
    usageSource:row.normalized_usage_json ? row.usage_source : 'unknown',
    evidence:row.usage_evidence_json ? JSON.parse(row.usage_evidence_json) as UsageEvidence : null,
    ttftMs:row.ttft_ms,firstTextMs:row.first_text_ms,latencyMs:row.latency_ms,startedAt:row.started_at,completedAt:row.completed_at,
    tokPerMs:row.normalized_usage_json && row.speed_valid === 1 && row.decode_tokens !== null && row.decode_ms && row.decode_ms > 0 ? row.decode_tokens/row.decode_ms : null};
}
const SELECT = `SELECT u.*,mr.context_window,mr.reserve_output_tokens FROM usage_entries u
  JOIN runs r ON r.id=u.run_id LEFT JOIN model_requests mr ON mr.id=u.request_id WHERE r.conversation_id=?`;
export function encodeUsageCursor(createdAt:string,id:string):string { return Buffer.from(JSON.stringify([createdAt,id])).toString('base64url'); }
export function decodeUsageCursor(value:string):[string,string] {
  const parsed:unknown=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
  if(!Array.isArray(parsed)||parsed.length!==2||parsed.some(v=>typeof v!=='string'||!v.length))throw new Error('Invalid cursor');
  return parsed as [string,string];
}
export function usageRequests(db:Db,conversationId:string,limit=100,before?:string):{requests:UsageRequest[];requestPage:UsageRequestPage} {
  const cursor=before ? decodeUsageCursor(before) : null;
  const rows=db.db.prepare(`${SELECT} ${cursor?'AND (u.created_at,u.request_id)<(?,?)':''} ORDER BY u.created_at DESC,u.request_id DESC LIMIT ?`)
    .all(conversationId,...(cursor??[]),limit+1) as unknown as Row[];
  const page=rows.slice(0,limit),last=page.at(-1);
  return {requests:page.map(request),requestPage:{hasMore:rows.length>limit,nextBefore:rows.length>limit&&last?encodeUsageCursor(last.created_at,last.request_id):null}};
}
export function projectUsage(db:Db,conversationId:string,runWindow:number|null,reserve:number):UsageSnapshot {
  const totals=empty(), coverage={} as UsageSnapshot['totals']['coverage'];
  for(const key of Object.keys(totals) as Array<keyof UsageBuckets>)coverage[key]={knownRequests:0,unknownRequests:0};
  let n=0,unknown=0,decodeTokens=0,decodeMs=0,samples=0,last:Row|null=null;
  let pairedTotal:number|null=null;
  const byKind:UsageSnapshot['byKind']=['main','compaction','repair','memory_recall','memory_extraction'].map(kind=>({kind:kind as UsageSnapshot['byKind'][number]['kind'],requests:0,unknownCount:0,totalInputTokens:null,outputTokens:null,totalTokens:null}));
  const byModel=new Map<string,UsageSnapshot['byModel'][number]>();
  // No LIMIT: the ledger fold covers the whole conversation, independently of detail pagination.
  for(const raw of db.db.prepare(`${SELECT} ORDER BY u.created_at ASC,u.request_id ASC`).iterate(conversationId)) {
    const row=raw as unknown as Row,u=buckets(row); n++;last=row;
    const missing=u.totalInput===null||u.output===null;
    if(missing)unknown++;
    const kind=byKind.find(k=>k.kind===row.request_kind)!;
    kind.requests++;if(missing)kind.unknownCount++;
    if(u.totalInput!==null)kind.totalInputTokens=(kind.totalInputTokens??0)+u.totalInput;
    if(u.output!==null)kind.outputTokens=(kind.outputTokens??0)+u.output;
    if(!missing){pairedTotal=(pairedTotal??0)+u.totalInput!+u.output!;kind.totalTokens=(kind.totalTokens??0)+u.totalInput!+u.output!;}

    for(const key of Object.keys(totals) as Array<keyof UsageBuckets>){
      if(u[key]===null)coverage[key].unknownRequests++;
      else {coverage[key].knownRequests++;totals[key]=(totals[key]??0)+u[key]!;}
    }
    const key=JSON.stringify([row.provider,row.model]);
    const model=byModel.get(key)??{provider:row.provider,model:row.model,requests:0,unknownCount:0,inputTokens:null,outputTokens:null};
    model.requests++;if(missing)model.unknownCount++;
    if(u.input!==null)model.inputTokens=(model.inputTokens??0)+u.input;
    if(u.output!==null)model.outputTokens=(model.outputTokens??0)+u.output;
    byModel.set(key,model);
    if(request(row).tokPerMs!==null){decodeTokens+=row.decode_tokens!;decodeMs+=row.decode_ms!;samples++;}
  }
  const lastRequest=last?request(last):null;
  const context=last?{requestId:last.request_id,runId:last.run_id,tokens:buckets(last).totalInput,at:last.completed_at,window:last.context_window,reserve:last.reserve_output_tokens}:null;
  return {scope:'conversation',conversationId,activity:projectActivity(db,conversationId),byKind,
    totals:{requests:n,unknownCount:unknown,inputTokens:totals.input,uncachedInputTokens:totals.input,outputTokens:totals.output,
      cacheReadTokens:totals.cacheRead,cacheWriteTokens:totals.cacheWrite,reasoningTokens:totals.reasoning,
      totalInputTokens:totals.totalInput,totalTokens:pairedTotal,
      coverage,complete:unknown===0},context:contextMeasurement(context,runWindow,reserve),
    speed:{sessionTokPerMs:decodeMs>0?decodeTokens/decodeMs:null,lastRequestTokPerMs:lastRequest?.tokPerMs??null,
      lastTurnTokPerMs:lastRequest?.tokPerMs??null,samples,decodeTokens,decodeMs},lastRequest,byModel:[...byModel.values()],
    ...usageRequests(db,conversationId)};
}

/** Full lifecycle fold, independent of paginated requests/events. No inferred zero durations. */
export function projectActivity(db:Db,conversationId:string):UsageSnapshot['activity'] {
  const turns=(db.db.prepare('SELECT COUNT(*) n FROM runs WHERE conversation_id=?').get(conversationId) as {n:number}).n;
  const activity:UsageSnapshot['activity']={turns,turnsBasis:'conversation_runs',steps:0,llmMs:null,toolMs:null,averageTtftMs:null,
    ttftSamples:0,llmSamples:0,toolSamples:0,unknownLlmCount:0,unknownToolCount:0};
  let ttftTotal=0;
  for(const raw of db.db.prepare(`SELECT mr.started_at,mr.completed_at,u.latency_ms,u.ttft_ms,u.normalized_usage_json
      FROM model_requests mr JOIN runs r ON r.id=mr.run_id LEFT JOIN usage_entries u ON u.request_id=mr.id
      WHERE r.conversation_id=? AND mr.started_at IS NOT NULL`).iterate(conversationId)) {
    const row=raw as {started_at:string;completed_at:string|null;latency_ms:number|null;ttft_ms:number|null;normalized_usage_json:string|null};
    activity.steps++;
    const duration=row.completed_at ? Date.parse(row.completed_at)-Date.parse(row.started_at):NaN;
    if(Number.isFinite(duration)&&duration>=0){activity.llmMs=(activity.llmMs??0)+duration;activity.llmSamples++;}
    else activity.unknownLlmCount++;
    // Old ttft_ms measured headers. Only provenance-era rows have the new generation semantics.
    if(row.normalized_usage_json&&count(row.ttft_ms)!==null){ttftTotal+=row.ttft_ms!;activity.ttftSamples++;}
  }
  activity.averageTtftMs=activity.ttftSamples?ttftTotal/activity.ttftSamples:null;
  const starts=new Map<string,number>(),durations=new Map<string,number>();
  for(const raw of db.db.prepare(`SELECT e.type,e.occurred_at,e.payload_json FROM run_events e JOIN runs r ON r.id=e.run_id
    WHERE r.conversation_id=? AND e.type IN ('tool.started','tool.completed') ORDER BY e.run_id,e.seq`).iterate(conversationId)) {
    const row=raw as {type:string;occurred_at:string;payload_json:string};
    const payload=JSON.parse(row.payload_json) as {invocationId?:string;durationMs?:number};
    if(!payload.invocationId)continue;
    if(row.type==='tool.started')starts.set(payload.invocationId,Date.parse(row.occurred_at));
    else {
      const start=starts.get(payload.invocationId),duration=count(payload.durationMs)??(start!==undefined?Date.parse(row.occurred_at)-start:NaN);
      if(Number.isFinite(duration)&&duration>=0)durations.set(payload.invocationId,duration);
    }
  }
  for(const raw of db.db.prepare(`SELECT ti.id FROM tool_invocations ti JOIN runs r ON r.id=ti.run_id WHERE r.conversation_id=?`).iterate(conversationId)) {
    const duration=durations.get(String(raw.id));
    if(duration===undefined)activity.unknownToolCount++;
    else{activity.toolMs=(activity.toolMs??0)+duration;activity.toolSamples++;}
  }
  return activity;
}

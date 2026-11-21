import { randomUUID } from 'node:crypto';
import type { Db } from '../storage/db.js';
import type { ModelProtocol } from '../../contracts/v1.js';
import type { ReasoningSnapshot, ReasoningSource } from '../../contracts/reasoning.js';

export const REASONING_FLUSH_MS = 120;
const MAX_TEXT = 256 * 1024;
const MAX_BLOCKS = 64;
const obj = (v: unknown): Record<string, unknown> => v!==null && typeof v==='object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
const index = (v: unknown): v is number => typeof v==='number' && Number.isSafeInteger(v) && v>=0;
export interface ReasoningIdentity {runId:string;attemptId:string;requestId:string;kind:string}
interface Block {snapshot:ReasoningSnapshot;dirty:boolean}

/** Trusted gateway side-channel over Pi's existing onProviderStreamEvent (single raw stream).
 * Sources: pi-ai 1.5.1 openai-completions plaintext delta fields; Anthropic thinking start/delta.
 * Deliberately never traverse reasoning_details, signatures, redacted blocks or SDK ThinkingContent.
 * Persistence matches Supervisor.emit's Agent API transaction/seq rule, NOT the legacy v1 emitter.
 */
export class ReasoningProjection {
  private readonly blocks = new Map<string,Block>();
  private readonly thinkingIndices = new Set<number>();
  private timer?: ReturnType<typeof setTimeout>;
  private lastFlush = -Infinity;
  private ended = false;
  private failure: unknown;
  constructor(private readonly db:Db, private readonly identity:ReasoningIdentity,
    private readonly protocol:ModelProtocol='openai-completions', private readonly onError:()=>void=()=>{}) {}

  observe(raw:unknown):void {
    if(this.ended || this.failure || this.identity.kind!=='main')return;
    const event=obj(raw);
    if(this.protocol==='anthropic-messages') {
      if(!index(event.index))return;
      if(event.type==='content_block_start') {
        const block=obj(event.content_block);
        if(block.type!=='thinking'){this.thinkingIndices.delete(event.index);return;}
        this.thinkingIndices.add(event.index);
        this.add(`anthropic:${event.index}`,block.thinking,'anthropic.thinking');
      } else if(event.type==='content_block_delta' && this.thinkingIndices.has(event.index)) {
        const delta=obj(event.delta);
        if(delta.type==='thinking_delta')this.add(`anthropic:${event.index}`,delta.thinking,'anthropic.thinking');
      } else if(event.type==='content_block_stop')this.thinkingIndices.delete(event.index);
      return;
    }
    if(!Array.isArray(event.choices))return;
    // The worker/Pi consumes one answer; do not mix alternative choices into that answer.
    const choice=event.choices.find(c=>obj(c).index===0) ?? (event.choices.length===1 && obj(event.choices[0]).index===undefined ? event.choices[0] : undefined);
    const delta=obj(obj(choice).delta);
    for(const field of ['reasoning_content','reasoning','reasoning_text'] as const) {
      if(typeof delta[field]==='string' && delta[field]) {
        this.add('openai:0',delta[field],`openai.${field}`);break;
      }
    }
  }

  private add(key:string,value:unknown,source:ReasoningSource):void {
    if(typeof value!=='string'||!value)return;
    let block=this.blocks.get(key);
    if(!block){
      if(this.blocks.size>=MAX_BLOCKS)return;
      const {runId,attemptId,requestId}=this.identity;
      block={snapshot:{runId,attemptId,requestId,blockId:`${runId}:${attemptId}:${requestId}:${key}`,revision:0,text:'',state:'streaming',source,truncated:false},dirty:false};
      this.blocks.set(key,block);
    }
    const remaining=MAX_TEXT-block.snapshot.text.length;
    if(remaining<=0&&block.snapshot.truncated)return;
    block.snapshot.text+=value.slice(0,Math.max(0,remaining));
    block.snapshot.truncated ||= value.length>remaining;
    block.dirty=true;
    if(Date.now()-this.lastFlush>=REASONING_FLUSH_MS)this.flush(false);
    else if(!this.timer){
      this.timer=setTimeout(()=>{
        this.timer=undefined;
        try {this.flush(false);}catch(error){this.failure=error;this.onError();}
      },Math.max(1,REASONING_FLUSH_MS-(Date.now()-this.lastFlush)));
      this.timer.unref();
    }
  }

  /** Flush even on disconnect/abort: retain partial plaintext, never label it complete. */
  finish(completed:boolean):void {
    if(this.timer){clearTimeout(this.timer);this.timer=undefined;}
    if(this.ended)return;
    this.ended=true;
    if(this.failure)throw this.failure;
    for(const block of this.blocks.values()) {block.snapshot.state=completed?'completed':'interrupted';block.dirty=true;}
    this.flush(true);
  }

  private flush(final:boolean):void {
    const dirty=[...this.blocks.values()].filter(b=>b.dirty&&b.snapshot.text.trim());
    if(!dirty.length)return;
    this.db.tx(tx=>{
      const {runId,attemptId}=this.identity;
      let seq=(tx.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM run_events WHERE run_id=?').get(runId) as {seq:number}).seq;
      const now=new Date().toISOString();
      for(const block of dirty){
        // Fresh scalar-only object: no raw provider objects, signatures or private replay handles.
        const s=block.snapshot;
        const payload:ReasoningSnapshot={runId:s.runId,attemptId:s.attemptId,requestId:s.requestId,blockId:s.blockId,
          revision:s.revision+1,text:s.text,state:s.state,source:s.source,truncated:s.truncated};
        tx.prepare(`INSERT INTO run_events(run_id,seq,event_id,attempt_id,producer_seq,visibility,type,occurred_at,payload_json) VALUES (?,?,?,?,NULL,'owner',?,?,?)`)
          .run(runId,++seq,randomUUID(),attemptId,final?'reasoning.completed':'reasoning.updated',now,JSON.stringify(payload));
      }
      tx.prepare('UPDATE runs SET updated_at=? WHERE id=?').run(now,runId);
    });
    for(const block of dirty){block.snapshot.revision++;block.dirty=false;}
    this.lastFlush=Date.now();
  }
}

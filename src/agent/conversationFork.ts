import { randomUUID } from 'node:crypto';
import type { Db } from '../storage/db.js';
import { ApiError } from '../../contracts/errors.js';

/** A branch owns its copied messages/runs. No source foreign keys, tool effects or checkpoints are copied. */
export function cloneConversation(db: Db, userId: string, conversationId: string, cutMessageId: string, mode: 'before' | 'through') {
 return db.tx(tx=>{
  const source=tx.prepare(`SELECT c.*,p.owner_user_id,p.archived_at AS project_archived FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=? AND p.owner_user_id=?`).get(conversationId,userId) as {id:string;project_id:string;mode:string;title:string;archived_at:string|null;project_archived:string|null}|undefined;
  if(!source)throw new ApiError('NOT_FOUND','会话不存在或无权访问');
  if(source.archived_at||source.project_archived)throw new ApiError('PROJECT_ARCHIVED','请先恢复已归档项目和会话');
  if(source.mode!=='ordinary')throw new ApiError('VALIDATION_FAILED','仅普通任务支持分叉');
  if(tx.prepare("SELECT id FROM runs WHERE conversation_id=? AND status IN ('created','queued','running','waiting_approval','cancelling') LIMIT 1").get(conversationId))throw new ApiError('CONVERSATION_BUSY','请先停止正在执行的任务，再编辑或分叉');
  const cut=tx.prepare("SELECT seq FROM messages WHERE id=? AND conversation_id=? AND state='published' AND visibility='public' AND author_type IN ('user','agent')").get(cutMessageId,conversationId) as {seq:number}|undefined;
  if(!cut)throw new ApiError('NOT_FOUND','分叉位置的消息不存在');
  const rows=tx.prepare(`SELECT m.run_id,m.author_type,m.role_id,m.content_json,m.created_at,r.config_snapshot_json FROM messages m LEFT JOIN runs r ON r.id=m.run_id WHERE m.conversation_id=? AND m.seq<=? AND m.state='published' AND m.visibility='public' AND m.author_type IN ('user','agent') ORDER BY m.seq`).all(conversationId,cut.seq-(mode==='before'?1:0)) as Array<{run_id:string|null;author_type:string;role_id:string|null;content_json:string;created_at:string;config_snapshot_json:string|null}>;
  const branchId=randomUUID(),now=new Date().toISOString();
  tx.prepare('INSERT INTO conversations(id,project_id,mode,title,last_message_seq,created_at,updated_at) VALUES (?,?,?,?,0,?,?)').run(branchId,source.project_id,'ordinary',`${source.title.slice(0,190)} · 分支`,now,now);
  const groups=new Map<string,typeof rows>();
  for(const row of rows){const key=row.run_id??'inherited';const group=groups.get(key)??[];group.push(row);groups.set(key,group);}
  let seq=0,lastRunId:string|undefined,index=0;
  for(const [sourceRunId,messages] of groups){
   const runId=randomUUID(),versionId=randomUUID();index++;
   const at=new Date(Date.parse(now)-(groups.size-index+1)).toISOString();
   const objective=messages.find(m=>m.author_type==='user');
   tx.prepare("INSERT INTO problem_versions(id,conversation_id,version,objective,constraints_json,confirmed_at,created_at,updated_at) VALUES (?,?,?,?,'[]',?,?,?)").run(versionId,branchId,index,objective?String(JSON.parse(objective.content_json).text??'继承的历史'):'继承的历史',at,at,at);
   const snapshot=JSON.parse(messages[0]?.config_snapshot_json??'{}');delete snapshot.sessionRef;
   snapshot.forkedFrom={conversationId,runId:sourceRunId,cutMessageId};
   tx.prepare("INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,phase,round_count,config_snapshot_json,next_event_seq,created_at,updated_at,ended_at,stop_reason) VALUES (?,?,?,?,'ordinary','succeeded','ordinary',0,?,0,?,?,?,'FORK_HISTORY')").run(runId,source.project_id,branchId,versionId,JSON.stringify(snapshot),at,at,at);
   for(const m of messages){seq++;tx.prepare("INSERT INTO messages(id,conversation_id,run_id,author_type,role_id,seq,visibility,state,content_json,consumed_cursor_json,created_at,updated_at) VALUES (?,?,?,?,?,?,'public','published',?,'{\"inherited\":true}',?,?)").run(randomUUID(),branchId,runId,m.author_type,m.role_id,seq,m.content_json,m.created_at,now);}
   lastRunId=runId;
  }
  tx.prepare('UPDATE conversations SET last_message_seq=? WHERE id=?').run(seq,branchId);
  return{conversationId:branchId,projectId:source.project_id,runId:lastRunId};
 });
}

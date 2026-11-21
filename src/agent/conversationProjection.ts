import type { Db } from '../storage/db.js';
import type { ConversationWindow, ConversationRun, ConversationMessage, ConversationEvent, ConversationTool, ConversationApproval } from '../../contracts/conversation.js';
import { ApiError } from '../../contracts/errors.js';
import { readUserQuestions } from './userQuestions.js';
/** Complete run windows, read in one SQLite snapshot. Never silently cut a turn at an event limit. */
export function readConversationWindow(db: Db, runId: string, userId: string, before?: string, limit=10): ConversationWindow {
 return db.tx(tx=>{
  const selected=tx.prepare('SELECT r.id,r.conversation_id,r.created_at FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.id=? AND p.owner_user_id=?').get(runId,userId) as {id:string;conversation_id:string;created_at:string}|undefined;
  if(!selected)throw new ApiError('NOT_FOUND','任务不存在或无权访问');
  let anchor=selected;
  if(before){const found=tx.prepare('SELECT id,conversation_id,created_at FROM runs WHERE id=? AND conversation_id=? AND (created_at<? OR (created_at=? AND id<=?))').get(before,selected.conversation_id,selected.created_at,selected.created_at,selected.id) as typeof selected;if(!found)throw new ApiError('VALIDATION_FAILED','历史窗口游标无效');anchor=found;}
  const rows=tx.prepare(`SELECT id,mode,status,created_at AS createdAt,ended_at AS endedAt,stop_reason AS stopReason FROM runs WHERE conversation_id=? AND (created_at<? OR (created_at=? AND id${before?'<':'<='}?)) ORDER BY created_at DESC,id DESC LIMIT ?`).all(selected.conversation_id,anchor.created_at,anchor.created_at,anchor.id,limit+1) as unknown as ConversationRun[];
  const runs=rows.slice(0,limit).reverse().map(r=>{
   const messages=tx.prepare("SELECT id,run_id AS runId,author_type AS authorType,seq,created_at AS createdAt,client_message_id AS clientMessageId,content_json,consumed_cursor_json FROM messages WHERE run_id=? AND state='published' AND visibility='public' ORDER BY seq").all(r.id) as unknown as Array<ConversationMessage&{content_json:string;consumed_cursor_json:string|null}>;
   const events=tx.prepare("SELECT seq,event_id AS eventId,attempt_id AS attemptId,occurred_at AS occurredAt,type,payload_json FROM run_events WHERE run_id=? AND visibility IN ('public','owner') ORDER BY seq").all(r.id) as unknown as Array<ConversationEvent&{payload_json:string}>;
   const tools=tx.prepare('SELECT id AS invocationId,run_id AS runId,tool_name AS tool,state,error_code AS error,created_at AS createdAt,redacted_args_json FROM tool_invocations WHERE run_id=? ORDER BY created_at,id').all(r.id) as unknown as Array<ConversationTool&{redacted_args_json:string}>;
   const approvals=tx.prepare('SELECT ap.id AS approvalId,ap.invocation_id AS invocationId,ap.state,ap.expires_at AS expiresAt FROM approvals ap JOIN tool_invocations ti ON ti.id=ap.invocation_id WHERE ti.run_id=? ORDER BY ap.created_at').all(r.id) as unknown as ConversationApproval[];
   const abandoned=tx.prepare("SELECT id FROM messages WHERE run_id=? AND state='abandoned'").all(r.id) as unknown as Array<{id:string}>;
   return {...r,throughSeq:events.at(-1)?.seq??0,abandonedMessageIds:abandoned.map(a=>a.id),messages:messages.map(({content_json,consumed_cursor_json,...m})=>({...m,content:JSON.parse(content_json),applied:consumed_cursor_json!==null})),events:events.map(({payload_json,...e})=>({...e,runId:r.id,payload:JSON.parse(payload_json)})),tools:tools.map(({redacted_args_json,...t})=>({...t,args:JSON.parse(redacted_args_json||'{}')})),approvals,userQuestions:readUserQuestions(db,r.id)};
  });
  // 阶段④续聊：研究锚点不随窗口分页截断——会话内最近一次研究run（任意窗口位置）都可供面板重建
  const research=tx.prepare(`SELECT r.id AS runId,r.mode,r.status,pv.objective FROM runs r JOIN problem_versions pv ON pv.id=r.problem_version_id WHERE r.conversation_id=? AND r.mode IN ('debate','jury') ORDER BY r.created_at DESC,r.id DESC LIMIT 1`).get(selected.conversation_id) as {runId:string;mode:string;status:string;objective:string}|undefined;
  return {conversationId:selected.conversation_id,runs,hasOlder:rows.length>limit,before:runs[0]?.id??null,...(research?{research:{runId:research.runId,mode:research.mode,status:research.status,objective:research.objective}}:{})};
 });
}

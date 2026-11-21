import {randomUUID} from 'node:crypto';
import type {Db} from '../storage/db.js';
import {ApiError} from '../../contracts/errors.js';
import {normalizeAttachmentIds,loadAttachmentImages} from './attachments.js';
export interface QueueItem{id:string;text:string;attachmentIds:string[];position:number;createdAt:string}
export function ownedQueueRun(db:Db,runId:string,userId:string){
 const row=db.db.prepare(`SELECT r.id,r.status,r.conversation_id,r.project_id,r.config_snapshot_json,c.queue_paused FROM runs r JOIN conversations c ON c.id=r.conversation_id JOIN projects p ON p.id=r.project_id WHERE r.id=? AND p.owner_user_id=?`).get(runId,userId) as {id:string;status:string;conversation_id:string;project_id:string;config_snapshot_json:string;queue_paused:number}|undefined;
 if(!row)throw new ApiError('NOT_FOUND','任务不存在或无权访问');return row;
}
export function queueView(db:Db,conversationId:string){
 const items=(db.db.prepare("SELECT id,text,attachment_ids_json,position,created_at AS createdAt FROM conversation_queue WHERE conversation_id=? AND state='queued' ORDER BY position,id").all(conversationId) as Array<{id:string;text:string;attachment_ids_json:string;position:number;createdAt:string}>).map(({attachment_ids_json,...i})=>({...i,attachmentIds:JSON.parse(attachment_ids_json) as string[]}));
 const c=db.db.prepare('SELECT queue_paused FROM conversations WHERE id=?').get(conversationId) as {queue_paused:number};
 return{items,paused:!!c.queue_paused};
}
export function enqueueMessage(db:Db,runId:string,userId:string,input:unknown){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new ApiError('VALIDATION_FAILED','排队请求须为对象');
 const body=input as {text?:unknown;attachmentIds?:unknown;clientKey?:unknown};
 const run=ownedQueueRun(db,runId,userId),text=typeof body.text==='string'?body.text.trim():'',key=typeof body.clientKey==='string'?body.clientKey:'';
 if(!text||text.length>20000||!key||key.length>100)throw new ApiError('VALIDATION_FAILED','排队消息须为1至20000字符，并提供提交标识');
 const existing=db.db.prepare('SELECT id FROM conversation_queue WHERE conversation_id=? AND client_key=?').get(run.conversation_id,key) as {id:string}|undefined;if(existing)return existing;
 if(!['running','waiting_approval'].includes(run.status))throw new ApiError('RUN_NOT_ACTIVE','任务未运行，请直接发送新目标');
 const ids=normalizeAttachmentIds(body.attachmentIds);loadAttachmentImages(db,userId,ids);
 return db.tx(tx=>{const current=queueView(db,run.conversation_id);if(current.items.length>=20)throw new ApiError('INPUT_TOO_LARGE','最多排队20条消息');const id=randomUUID();tx.prepare("INSERT INTO conversation_queue(id,conversation_id,owner_user_id,client_key,text,attachment_ids_json,position,created_at) VALUES (?,?,?,?,?,?,?,?)").run(id,run.conversation_id,userId,key,text,JSON.stringify(ids),(current.items.at(-1)?.position??0)+1,new Date().toISOString());return{id};});
}
export function changeQueueItem(db:Db,conversationId:string,id:string,action:'delete'|'edit'|'up'|'down',text?:string){
 return db.tx(tx=>{const view=queueView(db,conversationId),i=view.items.findIndex(item=>item.id===id);if(i<0)throw new ApiError('NOT_FOUND','排队消息已发送或不存在');
 const item=view.items[i]!;
 if(action==='delete')tx.prepare("UPDATE conversation_queue SET state='cancelled' WHERE id=? AND state='queued'").run(id);
 else if(action==='edit'){if(typeof text!=='string'||!text.trim()||text.length>20000)throw new ApiError('VALIDATION_FAILED','消息须为1至20000字符');tx.prepare('UPDATE conversation_queue SET text=? WHERE id=?').run(text.trim(),id);}
 else{const j=i+(action==='up'?-1:1);if(view.items[j]){[view.items[i],view.items[j]]=[view.items[j]!,item];view.items.forEach((m,k)=>tx.prepare('UPDATE conversation_queue SET position=? WHERE id=?').run(k,m.id));}}
 return queueView(db,conversationId);
 });
}

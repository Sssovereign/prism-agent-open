import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Db} from '../storage/db.js';
import type {Supervisor} from './supervisor.js';
import {ok} from '../http.js';
import {ApiError} from '../../contracts/errors.js';
import {ownedQueueRun,queueView,enqueueMessage,changeQueueItem} from './conversationQueue.js';
import {appUsageSnapshot} from './appUsage.js';

export function registerWorkspaceFeatures(app:FastifyInstance,db:Db,supervisor:Supervisor,auth:(req:FastifyRequest)=>{userId:string},updates:{assertEntryOpen():void}|null=null){
 app.get<{Querystring:{range?:string;timeZone?:string}}>('/api/v1/usage-stats',async(req,reply)=>ok(req,reply,appUsageSnapshot(db,auth(req).userId,req.query.range??'7d',req.query.timeZone??'Asia/Shanghai')));
 app.get<{Params:{id:string};Querystring:{q?:string}}>('/api/v1/runs/:id/find',async(req,reply)=>{
  const run=ownedQueueRun(db,req.params.id,auth(req).userId),q=req.query.q?.trim()??'';if(!q||q.length>200)throw new ApiError('VALIDATION_FAILED','查找内容须为1至200字符');
  const messages=db.db.prepare(`SELECT id,run_id AS runId,author_type AS authorType,json_extract(content_json,'$.text') AS text FROM messages WHERE conversation_id=? AND state='published' AND visibility='public' AND run_id IS NOT NULL AND instr(lower(json_extract(content_json,'$.text')),lower(?))>0 ORDER BY seq LIMIT 101`).all(run.conversation_id,q) as Array<{id:string;runId:string;authorType:string;text:string}>;
  // 阶段④：研究发言与记录一并可查（authorType=research），phaseTaskId驱动研究面板data-phase-id锚点定位
  const research=db.db.prepare(`SELECT rr.id,rr.run_id AS runId,rr.phase_task_id AS phaseTaskId,rr.title,rr.content FROM research_records rr JOIN runs r ON r.id=rr.run_id WHERE r.conversation_id=? AND rr.published=1 AND rr.kind IN ('statement','host','opinion','verdict','supplement','objection') AND (instr(lower(rr.title),lower(?))>0 OR instr(lower(rr.content),lower(?))>0) ORDER BY rr.rowid LIMIT 101`).all(run.conversation_id,q,q) as Array<{id:string;runId:string;phaseTaskId:string|null;title:string;content:string}>;
  const messageMatches=messages.slice(0,100).map(m=>{const i=m.text.toLocaleLowerCase().indexOf(q.toLocaleLowerCase());return{...m,text:m.text.slice(Math.max(0,i-60),i+q.length+160)};});
  const researchMatches=research.slice(0,Math.max(0,100-messageMatches.length)).map(r=>{const i=r.content.toLocaleLowerCase().indexOf(q.toLocaleLowerCase());return{id:r.id,runId:r.runId,authorType:'research',phaseTaskId:r.phaseTaskId??undefined,text:`${r.title}：${r.content.slice(Math.max(0,i-40),i+q.length+140)}`};});
  const matches=[...messageMatches,...researchMatches].slice(0,100);
  return ok(req,reply,{matches,truncated:messages.length+research.length>100});
 });
 app.get<{Params:{id:string}}>('/api/v1/runs/:id/context-history',async(req,reply)=>{
  const run=ownedQueueRun(db,req.params.id,auth(req).userId);
  const checkpoints=db.db.prepare('SELECT id,state,summary_text AS summary,tokens_before AS tokensBefore,tokens_after AS tokensAfter,created_at AS createdAt FROM context_checkpoints WHERE conversation_id=? ORDER BY created_at DESC LIMIT 50').all(run.conversation_id);
  return ok(req,reply,{checkpoints});
 });
 app.get<{Params:{id:string}}>('/api/v1/runs/:id/queue',async(req,reply)=>{const r=ownedQueueRun(db,req.params.id,auth(req).userId);return ok(req,reply,queueView(db,r.conversation_id));});
 app.post<{Params:{id:string};Body:{text?:unknown;attachmentIds?:unknown;clientKey?:unknown}}>('/api/v1/runs/:id/queue',async(req,reply)=>{updates?.assertEntryOpen();return ok(req,reply,enqueueMessage(db,req.params.id,auth(req).userId,req.body),201);});
 app.patch<{Params:{id:string};Body:{paused?:unknown;itemId?:string;action?:string;text?:string}}>('/api/v1/runs/:id/queue',async(req,reply)=>{
  const r=ownedQueueRun(db,req.params.id,auth(req).userId),b=req.body;
  if(!b||typeof b!=='object'||Array.isArray(b))throw new ApiError('VALIDATION_FAILED','队列操作须为对象');
  if(typeof b.paused==='boolean')db.db.prepare('UPDATE conversations SET queue_paused=? WHERE id=?').run(Number(b.paused),r.conversation_id);
  else if(typeof b.itemId==='string'&&typeof b.action==='string'&&['delete','edit','up','down'].includes(b.action??''))changeQueueItem(db,r.conversation_id,b.itemId,b.action as 'delete'|'edit'|'up'|'down',b.text);
  else throw new ApiError('VALIDATION_FAILED','无效的队列操作');
  return ok(req,reply,queueView(db,r.conversation_id));
 });
 app.post<{Params:{id:string};Body:{itemId?:string}}>('/api/v1/runs/:id/queue/send',async(req,reply)=>{updates?.assertEntryOpen();
  const uid=auth(req).userId,r=ownedQueueRun(db,req.params.id,uid),item=queueView(db,r.conversation_id).items.find(i=>i.id===req.body?.itemId);
  if(!item)throw new ApiError('NOT_FOUND','排队消息已发送或不存在');
  let messageId:string|undefined,runId=r.id;
  if(supervisor.active.has(r.id)&&['running','waiting_approval'].includes(r.status))messageId=supervisor.steer(r.id,uid,item.text,`queue:${item.id}`,item.attachmentIds).messageId;
  else{if(!['succeeded','failed','cancelled'].includes(r.status))throw new ApiError('RUN_NOT_ACTIVE','请先等待任务停止或恢复当前任务');const snapshot=JSON.parse(r.config_snapshot_json),session=(req as unknown as {session:{sessionId:string}}).session;const created=supervisor.createOrdinaryRun({userId:uid,sessionId:session.sessionId,projectId:r.project_id,conversationId:r.conversation_id,objective:item.text,modelConfigId:snapshot.modelConfigId,modelId:snapshot.modelId,attachmentIds:item.attachmentIds});runId=created.runId;}
  db.db.prepare("UPDATE conversation_queue SET state='dispatched',message_id=? WHERE id=?").run(messageId??null,item.id);
  return ok(req,reply,{runId});
 });
}

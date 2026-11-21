import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../storage/db.js';
import { ApiError } from '../../contracts/errors.js';
import { ok } from '../http.js';
import { readConversationWindow } from './conversationProjection.js';
import { toolResultPage, toolResultDownload } from './conversationToolResult.js';
export function registerConversationRoutes(app: FastifyInstance, deps: {db:Db}, auth:(req:FastifyRequest)=>{userId:string}):void {
 app.get<{Params:{runId:string;invocationId:string};Querystring:{offset?:string;limit?:string}}>('/api/v1/runs/:runId/conversation/tools/:invocationId/result',async(req,reply)=>{
  const {userId}=auth(req);
  reply.header('cache-control','no-store').header('x-content-type-options','nosniff');
  return ok(req,reply,toolResultPage(deps.db,req.params.runId,req.params.invocationId,userId,Number(req.query.offset??0),Number(req.query.limit??16384)));
 });
 app.get<{Params:{runId:string;invocationId:string}}>('/api/v1/runs/:runId/conversation/tools/:invocationId/result/download',async(req,reply)=>{
  const {userId}=auth(req);const {meta,stream}=toolResultDownload(deps.db,req.params.runId,req.params.invocationId,userId);
  if(!meta.available)throw new ApiError('NOT_FOUND','尚无持久化工具结果');
  return reply.header('content-type','application/octet-stream').header('content-disposition','attachment; filename="tool-result.json"').header('cache-control','no-store').header('x-content-type-options','nosniff').header('x-source-truncated',String(meta.sourceTruncated)).send(stream);
 });
 app.get<{Params:{runId:string};Querystring:{before?:string;limit?:string}}>('/api/v1/runs/:runId/conversation',async(req,reply)=>{
  const {userId}=auth(req);const limit=req.query.limit===undefined?10:Number(req.query.limit);
  if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw new ApiError('VALIDATION_FAILED','窗口大小须为1至20');
  return ok(req,reply,readConversationWindow(deps.db,req.params.runId,userId,req.query.before,limit) as unknown as Record<string,unknown>);
 });
}

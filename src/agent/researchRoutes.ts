import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Supervisor } from './supervisor.js';
import { ApiError } from '../../contracts/errors.js';
import { ok } from '../http.js';
import type { ResearchMode, ResearchModelChoice, ResearchSourceFileInput, ResearchSourceInput, ResearchSubject, ResearchCriterionInput } from '../../contracts/research.js';

export function registerResearchRoutes(app: FastifyInstance, supervisor: Supervisor, auth: (req: FastifyRequest) => {userId:string}, deps:{updates?:{assertEntryOpen():void}}={}): void {
  const research=supervisor.research;
  app.post<{Params:{projectId:string};Body:{mode:ResearchMode;objective:string;rounds?:number;models:Record<string,ResearchModelChoice>;sources?:ResearchSourceInput[];sourceFiles?:ResearchSourceFileInput[];sourceRunId?:string;decision?:{proposition:string;candidates:Array<{id?:string;text:string}>};subject?:ResearchSubject;criteria?:ResearchCriterionInput[];objections?:Array<{target?:unknown;text:string}>}}>('/api/v1/projects/:projectId/research',async(req,reply)=>{
    deps.updates?.assertEntryOpen();
    const {userId}=auth(req),session=(req as unknown as {session:{sessionId:string}}).session;
    if(!req.body||typeof req.body.objective!=='string')throw new ApiError('VALIDATION_FAILED','请填写研究议题');
    const {sourceFiles,...body}=req.body;
    // 文件引用在run创建前由服务端受控读取并切段成普通资料；协议层对来源无感知
    const imported=await research.expandSourceFiles(req.params.projectId,userId,sourceFiles);
    const result=research.create({...body,userId,sessionId:session.sessionId,projectId:req.params.projectId,sources:[...(body.sources??[]),...imported]});
    return ok(req,reply,result,201);
  });
  app.get<{Params:{runId:string}}>('/api/v1/runs/:runId/research',async(req,reply)=>{
    research.owned(req.params.runId,auth(req).userId);
    return ok(req,reply,research.inspect(req.params.runId) as Record<string,unknown>);
  });
  app.post<{Params:{runId:string}}>('/api/v1/runs/:runId/research/summarize',async(req,reply)=>{
    deps.updates?.assertEntryOpen();
    research.owned(req.params.runId,auth(req).userId);research.requestSummary(req.params.runId);
    return ok(req,reply,{accepted:true});
  });
  app.get<{Params:{runId:string}}>('/api/v1/runs/:runId/research/export',async(req,reply)=>{
    research.owned(req.params.runId,auth(req).userId);
    return reply.header('Content-Type','application/json; charset=utf-8').header('Content-Disposition',`attachment; filename="research-${req.params.runId}.json"`).send(JSON.stringify(research.inspect(req.params.runId),null,2));
  });
}

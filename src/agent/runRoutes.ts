import type { FastifyInstance, FastifyRequest } from 'fastify';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Db } from '../storage/db.js';
import { ApiError } from '../../contracts/errors.js';
import { ok } from '../http.js';
import type { Supervisor } from './supervisor.js';
import { LIMITS } from './modelRequests.js';
import { projectUsage, usageRequests, decodeUsageCursor, encodeUsageCursor } from './usageProjection.js';
import { waitStateVersion } from './waitStateVersion.js';
import {isApprovalMode} from '../../contracts/permissions.js';
import {isThinkingLevel} from '../../contracts/models.js';
import { getRunTodos } from './runTodos.js';
import { readUserQuestions } from './userQuestions.js';
import type { UserQuestionResponse } from '../../contracts/userQuestions.js';
import { normalizeAttachmentIds } from './attachments.js';
import { prepareFileRewind, applyFileRewind } from './fileRewind.js';
import { changeLineStats } from './changeLineStats.js';

const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/**
 * Runs API（计划v1.6 §8）：会话/Run创建、补充、取消、恢复、审批决定、事件分页与SSE、
 * 用量聚合（DSH底栏数据源）、产物下载。所有端点仅限本机+登录会话+属主校验。
 * SSE为本机轻量实现：初拍快照+400ms轮询增量，Run终态后推终态帧并结束。
 */

interface RunSession { userId: string; sessionId: string; expiresAt: string }

export interface RunRoutesDeps {
    db: Db;
    dataDir: string;
    supervisor: Supervisor;
    /** 更新应用屏障：关闭期间拒绝新建执行工作（桌面宿主切换业务包前的空闲屏障）。 */
    updates?: { assertEntryOpen(): void };
}

interface RunRow {
    id: string; project_id: string; conversation_id: string; mode: string; status: string;
    phase: string | null; stop_reason: string | null; cancel_requested_at: string | null;
    ended_at: string | null; created_at: string; updated_at: string; config_snapshot_json: string;
}

const reasonVersionOf = waitStateVersion;

export function registerRunRoutes(app: FastifyInstance, deps: RunRoutesDeps, auth: (req: FastifyRequest) => { userId: string }): void {
    const { db, supervisor } = deps;

    function session(req: FastifyRequest): RunSession {
        const s = (req as unknown as { session?: RunSession }).session;
        if (!s) throw new ApiError('AUTH_REQUIRED', '请先登录');
        return s;
    }

    function runOwned(runId: string, userId: string): RunRow {
        const row = db.db.prepare(`SELECT r.* FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.id=? AND p.owner_user_id=?`)
            .get(runId, userId) as unknown as RunRow | undefined;
        if (!row) throw new ApiError('NOT_FOUND', '任务不存在或无权访问');
        return row;
    }

    function runView(run: RunRow): Record<string, unknown> {
        const snapshot = JSON.parse(run.config_snapshot_json) as { modelDisplayName?: string; modelId: string; modelConfigId: string;approvalMode?:import('../../contracts/permissions.js').ApprovalMode };
        return {
            conversationTitle: (db.db.prepare('SELECT title FROM conversations WHERE id=?').get(run.conversation_id) as {title:string}|undefined)?.title ?? '',
            objective: (db.db.prepare('SELECT pv.objective FROM problem_versions pv JOIN runs r ON r.problem_version_id=pv.id WHERE r.id=?').get(run.id) as {objective:string} | undefined)?.objective ?? '',
            id: run.id, projectId: run.project_id, conversationId: run.conversation_id, mode: run.mode,
            approvalMode:snapshot.approvalMode??'auto',
            status: run.status, phase: run.phase, stopReason: run.stop_reason,
            cancelRequestedAt: run.cancel_requested_at, createdAt: run.created_at, endedAt: run.ended_at,
            model: { configId: snapshot.modelConfigId, configModelId: snapshot.modelId, displayName: snapshot.modelDisplayName ?? snapshot.modelId },
            waiting: run.status === 'waiting_input' ? { reason: run.stop_reason, reasonVersion: reasonVersionOf(run) } : null,
        };
    }

    function approvalReview(tool:string,canonical:string):{text:string;truncated:boolean;label:string}|null{
        try{
            const args=JSON.parse(canonical) as Record<string,unknown>;
            const text=tool==='bash'?String(args.command??''):(tool==='write_file'||tool==='write_artifact')?String(args.content??''):tool==='delete_file'?`删除文件：${String(args.path??'')}`:JSON.stringify(args,null,2);
            return {text:text.slice(0,16000),truncated:text.length>16000,label:tool==='bash'?'将执行的命令':tool==='delete_file'?'将删除的文件':'拟写入的内容'};
        }catch{return null;}
    }

    const PUBLIC_EVENT_VISIBILITIES = "('public','owner')";

    // —— 会话与Run创建 ——

    app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/conversations', async (req, reply) => {
        const { userId } = auth(req);
        const project = db.db.prepare('SELECT id FROM projects WHERE id=? AND owner_user_id=?').get(req.params.projectId, userId);
        if (!project) throw new ApiError('NOT_FOUND', '项目不存在或无权访问');
        const rows = db.db.prepare('SELECT id, mode, title, last_message_seq, created_at, updated_at, archived_at, pinned_at FROM conversations WHERE project_id=? ORDER BY updated_at DESC LIMIT 100')
            .all(req.params.projectId) as unknown as Array<Record<string, unknown>>;
        return ok(req, reply, { conversations: rows });
    });

    // 项目内任务列表（侧栏数据源；页面刷新后恢复真实Run清单，目标取自问题版本快照）
    app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/runs', async (req, reply) => {
        const { userId } = auth(req);
        const project = db.db.prepare('SELECT id FROM projects WHERE id=? AND owner_user_id=?').get(req.params.projectId, userId);
        if (!project) throw new ApiError('NOT_FOUND', '项目不存在或无权访问');
        const rows = db.db.prepare(`SELECT r.id, r.conversation_id, r.status, r.stop_reason, r.created_at, pv.objective,c.title,r.config_snapshot_json
            FROM runs r JOIN conversations c ON c.id=r.conversation_id JOIN problem_versions pv ON pv.id=r.problem_version_id
            WHERE r.project_id=? ORDER BY r.created_at DESC LIMIT 50`).all(req.params.projectId) as unknown as
            Array<{ id: string; conversation_id: string; status: string; stop_reason: string | null; created_at: string; objective: string; title: string; config_snapshot_json:string }>;
        return ok(req, reply, {
            runs: rows.map(row => ({
                id: row.id, title:row.title, approvalMode:(JSON.parse(row.config_snapshot_json) as {approvalMode?:string}).approvalMode??'auto', conversationId: row.conversation_id, status: row.status,
                stopReason: row.stop_reason, createdAt: row.created_at, objective: String(row.objective ?? '').slice(0, 500),
            })),
        });
    });

    // 块E5：会话分叉/消息编辑（上游 conversation.history.branch）。
    // objective 提供＝编辑重发（同会话回退新Run）；缺省＝轮尾分叉（新分支会话，不启动Run）。
    app.post<{ Params: { id: string }, Body: { cutMessageId?: string; cutMode?: string; objective?: string; modelConfigId?: string; modelId?: string; approvalMode?: unknown; attachmentIds?: unknown; thinkingLevel?: unknown } }>('/api/v1/conversations/:id/fork', { schema: {
        params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: uuidPattern } } },
        body: { type: 'object', required: ['cutMessageId'], additionalProperties: false, properties: {
            cutMessageId: { type: 'string', pattern: uuidPattern },
            cutMode: { type: 'string', enum: ['before', 'through'] },
            objective: { type: 'string', maxLength: 20000 },
            modelConfigId: { type: 'string' }, modelId: { type: 'string' },
            approvalMode: {}, attachmentIds: { type: 'array', maxItems: 10 },
            thinkingLevel: { type: 'string', enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
        } },
    } }, async (req, reply) => {
        deps.updates?.assertEntryOpen();
        const s = session(req);
        const { userId } = auth(req);
        const body = req.body as { cutMessageId: string; cutMode?: string; objective?: string; modelConfigId?: string; modelId?: string; approvalMode?: unknown; attachmentIds?: unknown; thinkingLevel?: unknown };
        const result = supervisor.forkRun({
            userId, sessionId: s.sessionId, conversationId: req.params.id,
            cutMessageId: body.cutMessageId,
            cutMode: body.cutMode === 'before' ? 'before' : 'through',
            ...(body.objective !== undefined ? { objective: String(body.objective) } : {}),
            ...(body.modelConfigId ? { modelConfigId: String(body.modelConfigId) } : {}),
            ...(body.modelId ? { modelId: String(body.modelId) } : {}),
            ...(isApprovalMode(body.approvalMode) ? { approvalMode: body.approvalMode } : {}),
            ...(body.attachmentIds !== undefined ? { attachmentIds: normalizeAttachmentIds(body.attachmentIds) } : {}),
            ...(isThinkingLevel(body.thinkingLevel) ? { thinkingLevel: body.thinkingLevel } : {}),
        });
        return ok(req, reply, result as unknown as Record<string, unknown>, result.runId ? 201 : 200);
    });

    app.post<{ Params: { projectId: string }, Body: { conversationId?: string; objective?: string; modelConfigId?: string; modelId?: string; clientMessageId?: string; approvalMode?:unknown; attachmentIds?:unknown; thinkingLevel?:unknown; researchHandoff?:unknown } }>('/api/v1/projects/:projectId/runs', async (req, reply) => {
        deps.updates?.assertEntryOpen();
        const s = session(req);
        const { userId } = auth(req);
        const objective = String(req.body?.objective ?? '').trim();
        if (!objective) throw new ApiError('VALIDATION_FAILED', '任务目标不能为空');
        if (objective.length > 20_000) throw new ApiError('INPUT_TOO_LARGE', '任务目标过长（>20000字符）');
        const modelConfigId = String(req.body?.modelConfigId ?? '');
        const modelId = String(req.body?.modelId ?? '');
        if (!modelConfigId || !modelId) throw new ApiError('VALIDATION_FAILED', '请选择模型接口与模型');
        if(req.body?.approvalMode!==undefined&&!isApprovalMode(req.body.approvalMode))throw new ApiError('VALIDATION_FAILED','授权模式无效');
        if(req.body?.thinkingLevel!==undefined&&!isThinkingLevel(req.body.thinkingLevel))throw new ApiError('VALIDATION_FAILED','思考级别无效');
        const created = supervisor.createOrdinaryRun({
            userId, sessionId: s.sessionId, projectId: req.params.projectId,
            conversationId: req.body?.conversationId ?? null,
            objective, modelConfigId, modelId,approvalMode:isApprovalMode(req.body?.approvalMode)?req.body.approvalMode:undefined,
            attachmentIds: normalizeAttachmentIds(req.body?.attachmentIds),
            ...(isThinkingLevel(req.body?.thinkingLevel) ? { thinkingLevel: req.body.thinkingLevel } : {}),
            ...(req.body?.researchHandoff ? { researchHandoff: req.body.researchHandoff as { sourceRunId?: unknown; items?: unknown } } : {}),
        });
        return ok(req, reply, created as unknown as Record<string, unknown>, 201);
    });

    // —— Run读取与操作 ——

    app.get<{ Params: { runId: string } }>('/api/v1/runs/:runId', async (req, reply) => {
        const { userId } = auth(req);
        const run = runOwned(req.params.runId, userId);
        const attempts = db.db.prepare(`SELECT a.id, a.number, a.status, a.error_code, a.created_at, a.updated_at FROM attempts a
            JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=? ORDER BY a.created_at DESC,a.rowid DESC LIMIT 20`).all(run.id) as unknown as Array<Record<string, unknown>>;
        const pendingApproval = db.db.prepare(`SELECT ap.id AS approvalId, ap.expires_at AS expiresAt, ti.tool_name AS tool, ti.redacted_args_json AS argsJson
            FROM approvals ap JOIN tool_invocations ti ON ti.id=ap.invocation_id
            JOIN phase_tasks pt ON pt.id=ti.phase_task_id
            WHERE pt.run_id=? AND ap.state='pending' ORDER BY ap.created_at DESC LIMIT 1`).get(run.id) as
            { approvalId: string; expiresAt: string; tool: string; argsJson: string } | undefined;
        return ok(req, reply, {
            run: runView(run),
            attempts,
            pendingApproval: pendingApproval ? {
                approvalId: pendingApproval.approvalId, expiresAt: pendingApproval.expiresAt,
                tool: pendingApproval.tool, args: JSON.parse(pendingApproval.argsJson ?? '{}'),
            } : null,
        });
    });

    app.post<{ Params: { runId: string }, Body: { text?: string; clientMessageId?: string; attachmentIds?:unknown; target?:unknown } }>('/api/v1/runs/:runId/steer', async (req, reply) => {
        deps.updates?.assertEntryOpen();
        const { userId } = auth(req);
        const text = String(req.body?.text ?? '').trim();
        if (!text) throw new ApiError('VALIDATION_FAILED', '补充内容不能为空');
        if (text.length > 20_000) throw new ApiError('INPUT_TOO_LARGE', '补充内容过长');
        const run = runOwned(req.params.runId, userId);
        if (run.status !== 'running' && run.status !== 'waiting_approval' && !(supervisor.research.isResearch(run.id) && run.status==='created')) {
            throw new ApiError('RUN_NOT_ACTIVE', '任务不在运行，无法补充');
        }
        const clientMessageId = req.body?.clientMessageId ? String(req.body.clientMessageId) : null;
        // target：异议目标（具体主张/整份结论）。缺省走原有普通补充流程；研究run透传给协议层。
        const result = supervisor.steer(run.id, userId, text, clientMessageId, normalizeAttachmentIds(req.body?.attachmentIds), supervisor.research.isResearch(run.id)?req.body?.target:undefined);
        return ok(req, reply, result as unknown as Record<string, unknown>);
    });

    app.post<{ Params: { runId: string } }>('/api/v1/runs/:runId/cancel', async (req, reply) => {
        const { userId } = auth(req);
        const run = runOwned(req.params.runId, userId);
        const result = await supervisor.cancelRun(run.id, 'user_requested');
        return ok(req, reply, { accepted: result });
    });

    app.post<{Params:{runId:string};Body:{attemptId:string;regenerate?:boolean}}>('/api/v1/runs/:runId/retry',{schema:{body:{type:'object',required:['attemptId'],additionalProperties:false,properties:{attemptId:{type:'string',pattern:uuidPattern},regenerate:{type:'boolean'}}}}},async(req,reply)=>{
        deps.updates?.assertEntryOpen();
        const s=session(req),{userId}=auth(req),run=runOwned(req.params.runId,userId);
        return ok(req,reply,await supervisor.retryFailedRun(run.id,userId,s.sessionId,req.body.attemptId,req.body.regenerate===true));
    });

    app.post<{ Params: { runId: string }, Body: { reasonVersion?: string } }>('/api/v1/runs/:runId/resume', async (req, reply) => {
        deps.updates?.assertEntryOpen();
        const s = session(req);
        const { userId } = auth(req);
        const run = runOwned(req.params.runId, userId);
        const result = await supervisor.resumeWaitingRun(run.id, userId, s.sessionId, String(req.body?.reasonVersion ?? ''));
        return ok(req, reply, result as unknown as Record<string, unknown>);
    });

    app.post<{Params:{runId:string}}>('/api/v1/runs/:runId/compact',async(req,reply)=>{
        deps.updates?.assertEntryOpen();
        const {userId}=auth(req),run=runOwned(req.params.runId,userId);
        const result=supervisor.compactRun(run.id,userId);
        return ok(req,reply,{...result},202);
    });

    // —— 用户提问（与操作审批分离） ——
    app.get<{ Params: { runId: string } }>('/api/v1/runs/:runId/questions', async (req, reply) => {
        const run = runOwned(req.params.runId, auth(req).userId);
        return ok(req, reply, { questions: readUserQuestions(db, run.id) });
    });
    app.post<{ Params: { runId: string; questionId: string }; Body: UserQuestionResponse }>('/api/v1/runs/:runId/questions/:questionId/answer', async (req, reply) => {
        const { userId } = auth(req), run = runOwned(req.params.runId, userId);
        return ok(req, reply, supervisor.userQuestions.respond(run.id, req.params.questionId, userId, req.body));
    });
    app.post<{ Params: { runId: string; questionId: string } }>('/api/v1/runs/:runId/questions/:questionId/snooze', async (req, reply) => {
        const { userId } = auth(req), run = runOwned(req.params.runId, userId);
        return ok(req, reply, supervisor.userQuestions.snooze(run.id, req.params.questionId, userId));
    });

    // —— 审批 ——

    app.post<{ Params: { runId: string }, Body: { approvalId?: string; decision?: string; reason?: string } }>('/api/v1/runs/:runId/approvals/decision', async (req, reply) => {
        const { userId } = auth(req);
        const run = runOwned(req.params.runId, userId);
        const approvalId = String(req.body?.approvalId ?? '');
        const decision = String(req.body?.decision ?? '');
        if (!approvalId || !['approved', 'rejected'].includes(decision)) {
            throw new ApiError('VALIDATION_FAILED', 'decision须为approved或rejected');
        }
        // 执行载体已失联时approve不可能真正执行：作废并明确报错，而不是返回200后静默失效
        if (decision === 'approved' && !supervisor.approvalWorkerAlive(run.id, approvalId)) {
            supervisor.voidStaleApproval(run.id, approvalId);
            throw new ApiError('RUN_NOT_ACTIVE', '任务已中断，该审批无法执行；任务已按失败终结，可原地重试');
        }
        const outcome = supervisor.decideApproval(approvalId, decision as 'approved' | 'rejected', userId);
        if (outcome.decided) {
            if (decision === 'approved') await supervisor.executeApproved(run.id, approvalId);
            else await supervisor.rejectApproved(run.id, approvalId, String(req.body?.reason ?? ''));
        }
        supervisor.emit(run.id, 'approval.decided', { approvalId, invocationId: outcome.invocationId ?? null, decision, effective: outcome.decided }, 'public');
        return ok(req, reply, { decided: outcome.decided, invocationId: outcome.invocationId ?? null });
    });

    app.get<{ Params: { runId: string } }>('/api/v1/runs/:runId/approvals', async (req, reply) => {
        const { userId } = auth(req);
        const run = runOwned(req.params.runId, userId);
        const rows = db.db.prepare(`SELECT ap.id AS approvalId, ap.state, ap.expires_at AS expiresAt, ap.decided_at AS decidedAt,
            ti.id AS invocationId, ti.tool_name AS tool, ti.redacted_args_json AS argsJson, ti.canonical_exec_args_json AS canonicalArgsJson, ti.state AS invocationState
            FROM approvals ap JOIN tool_invocations ti ON ti.id=ap.invocation_id
            JOIN phase_tasks pt ON pt.id=ti.phase_task_id
            WHERE pt.run_id=? ORDER BY ap.created_at DESC LIMIT 50`).all(run.id) as unknown as Array<Record<string, unknown>>;
        return ok(req, reply, {
            approvals: rows.map(row => ({ ...row, args: JSON.parse(String(row.argsJson ?? '{}')), review:row.state==='pending'?approvalReview(String(row.tool),String(row.canonicalArgsJson??'{}')):null,argsJson: undefined,canonicalArgsJson:undefined })),
        });
    });

    app.get<{Params:{runId:string;approvalId:string}}>('/api/v1/runs/:runId/approvals/:approvalId/review',async(req,reply)=>{
        const {userId}=auth(req);const run=runOwned(req.params.runId,userId);
        const row=db.db.prepare(`SELECT ti.canonical_exec_args_json AS argsJson,ti.tool_name AS tool FROM approvals ap
            JOIN tool_invocations ti ON ti.id=ap.invocation_id JOIN phase_tasks pt ON pt.id=ti.phase_task_id
            WHERE ap.id=? AND ap.owner_user_id=? AND pt.run_id=? AND ap.state='pending'`).get(req.params.approvalId,userId,run.id) as {argsJson:string;tool:string}|undefined;
        if(!row)throw new ApiError('NOT_FOUND','审批不存在或已处理');
        const args=JSON.parse(row.argsJson) as Record<string,unknown>;
        const text=row.tool==='bash'?String(args.command??''):(row.tool==='write_file'||row.tool==='write_artifact')?String(args.content??''):JSON.stringify(args,null,2);
        return reply.header('content-type','text/plain; charset=utf-8').header('x-content-type-options','nosniff').header('cache-control','no-store').send(text);
    });

    // 工具详情按会话及属主读取；较大结果仅在用户展开时读取，不放入公开事件。
    app.get<{Params:{runId:string};Querystring:{before?:string;limit?:string}}>('/api/v1/runs/:runId/tools',async(req,reply)=>{
        const {userId}=auth(req),run=runOwned(req.params.runId,userId);
        const limit=Math.min(500,Math.max(1,Math.floor(Number(req.query.limit)||100)));
        let before:[string,string]|null=null;
        try { before=req.query.before?decodeUsageCursor(req.query.before):null; } catch {throw new ApiError('VALIDATION_FAILED','工具分页游标无效');}
        const rows=db.db.prepare(`SELECT ti.id AS invocationId,ti.tool_name AS tool,ti.state,ti.error_code AS error,ti.redacted_args_json AS argsJson,
            ti.created_at AS createdAt,ti.run_id AS runId,r.status AS runStatus,ti.result_json IS NOT NULL AS hasResult
            FROM tool_invocations ti JOIN runs r ON r.id=ti.run_id JOIN projects p ON p.id=r.project_id
            WHERE r.conversation_id=? AND p.owner_user_id=? ${before?'AND (ti.created_at,ti.id)<(?,?)':''}
            ORDER BY ti.created_at DESC,ti.id DESC LIMIT ?`).all(run.conversation_id,userId,...(before??[]),limit+1) as unknown as Array<Record<string,unknown>>;
        const page=rows.slice(0,limit),oldest=page.at(-1);
        return ok(req,reply,{tools:page.reverse().map(row=>({...row,args:JSON.parse(String(row.argsJson??'{}')),argsJson:undefined})),
            hasMore:rows.length>limit,hasOlder:rows.length>limit,nextBefore:rows.length>limit&&oldest?encodeUsageCursor(String(oldest.createdAt),String(oldest.invocationId)):null});
    });
    app.get<{Params:{runId:string;invocationId:string}}>('/api/v1/runs/:runId/tools/:invocationId',async(req,reply)=>{
        const {userId}=auth(req),run=runOwned(req.params.runId,userId);
        const row=db.db.prepare(`SELECT ti.tool_name AS tool,ti.result_json AS resultJson FROM tool_invocations ti
            JOIN runs r ON r.id=ti.run_id JOIN projects p ON p.id=r.project_id WHERE ti.id=? AND r.conversation_id=? AND p.owner_user_id=?`)
            .get(req.params.invocationId,run.conversation_id,userId) as {tool:string;resultJson:string|null}|undefined;
        if(!row)throw new ApiError('NOT_FOUND','工具记录不存在或无权访问');
        let text='';let diff: {changeRecordId:string;path:string;operation:string;addedLines:number;removedLines:number}|undefined;
        if(row.resultJson){const result=JSON.parse(row.resultJson) as Record<string,unknown>;
            text=row.tool==='read_file'&&typeof result.content==='string'?result.content:row.tool==='bash'?`退出码：${String(result.exitCode??'—')}\n${String(result.stdout??'')}${result.stderr?'\n'+String(result.stderr):''}`:JSON.stringify(result,null,2);
            // 块F1：写入类工具结果带 diff 元信息（补丁正文经 changes/:id/diff 按需拉取）。
            // change须按invocation所属run匹配：同会话旧run的记录用URL当前run.id过滤会永远落空
            if(typeof result.changeRecordId==='string'){
                const change=db.db.prepare(`SELECT cr.relative_path AS path, cr.operation, cr.diff_patch IS NOT NULL AS hasDiff
                    FROM change_records cr JOIN tool_invocations ti ON ti.run_id=cr.run_id
                    WHERE cr.id=? AND ti.id=?`).get(result.changeRecordId,req.params.invocationId) as {path:string;operation:string;hasDiff:number}|undefined;
                if(change?.hasDiff){const summary=(result.diffSummary&&typeof result.diffSummary==='object'?result.diffSummary:{}) as {addedLines?:unknown;removedLines?:unknown};
                diff={changeRecordId:result.changeRecordId,path:change.path,operation:change.operation,addedLines:Number(summary.addedLines??0),removedLines:Number(summary.removedLines??0)};}
            }}
        return ok(req,reply,{preview:text.slice(0,16000),truncated:text.length>16000,...(diff?{diff}:{})});
    });

    // 任务清单（块D）：run级todo，todo_write全量覆写；终态保留供回看
    app.get<{Params:{runId:string}}>('/api/v1/runs/:runId/todos',async(req,reply)=>{
        const {userId}=auth(req),run=runOwned(req.params.runId,userId);
        const rows=db.db.prepare('SELECT id,position,content,status FROM run_todos WHERE run_id=? ORDER BY position').all(run.id) as unknown as Array<{id:string;position:number;content:string;status:string}>;
        return ok(req,reply,{todos:rows});
    });

    // —— 消息与事件 ——

    app.get<{ Params: { runId: string }, Querystring: { after?: string; before?: string; limit?: string } }>('/api/v1/runs/:runId/messages', async (req, reply) => {
        const { userId } = auth(req);
        const run = runOwned(req.params.runId, userId);
        const limit = Math.min(200, Math.max(1, Number(req.query?.limit ?? 100) || 100));
        const after = req.query.after !== undefined ? Number(req.query.after) : null;
        const before = req.query.before !== undefined ? Number(req.query.before) : null;
        if ((after !== null && (!Number.isSafeInteger(after) || after < 0)) || (before !== null && (!Number.isSafeInteger(before) || before < 1)) || (after !== null && before !== null))
            throw new ApiError('VALIDATION_FAILED', '消息分页游标无效');
        const forward = after !== null;
        const condition = forward ? 'AND seq>?' : before !== null ? 'AND seq<?' : '';
        const params: Array<string|number> = [run.conversation_id];
        if (forward) params.push(after!); else if (before !== null) params.push(before);
        params.push(limit+1);
        const rows = db.db.prepare(`SELECT id,run_id,author_type,role_id,seq,content_json,created_at FROM messages
            WHERE conversation_id=? AND state='published' ${condition} ORDER BY seq ${forward?'ASC':'DESC'} LIMIT ?`)
            .all(...params) as unknown as Array<Record<string,unknown>>;
        const page=rows.slice(0,limit);if(!forward)page.reverse();
        return ok(req,reply,{
            messages:page.map(row=>({id:row.id,runId:row.run_id,authorType:row.author_type,roleId:row.role_id,seq:row.seq,content:JSON.parse(String(row.content_json??'{}')),createdAt:row.created_at})),
            hasMore:rows.length>limit,hasOlder:!forward&&rows.length>limit,oldestSeq:page[0]?.seq??null,
        });
    });

    app.get<{ Params: { runId: string }, Querystring: { after?: string; limit?: string } }>('/api/v1/runs/:runId/events', async (req, reply) => {
        const { userId } = auth(req);
        const run = runOwned(req.params.runId, userId);
        const after = Math.max(0, Number(req.query?.after ?? 0) || 0);
        const limit = Math.min(500, Math.max(1, Number(req.query?.limit ?? 200) || 200));
        const rows = db.db.prepare(`SELECT seq, event_id, attempt_id, visibility, type, occurred_at, payload_json FROM run_events
            WHERE run_id=? AND seq > ? AND visibility IN ${PUBLIC_EVENT_VISIBILITIES} ORDER BY seq ASC LIMIT ?`)
            .all(run.id, after, limit + 1) as unknown as Array<Record<string, unknown>>;
        return ok(req, reply, {
            events: rows.slice(0, limit).map(row => ({
                runId:run.id, seq: row.seq, eventId: row.event_id, attemptId: row.attempt_id, type: row.type,
                occurredAt: row.occurred_at, payload: JSON.parse(String(row.payload_json ?? '{}')),
            })),
            hasMore: rows.length > limit,
            nextAfter: rows.slice(0,limit).at(-1)?.seq ?? after,
        });
    });

    // SSE：初拍快照+轮询增量；Run终态推送终态帧后结束（本机轻量实现）
    app.get<{ Params: { runId: string }, Querystring: { after?: string } }>('/api/v1/runs/:runId/events/stream', async (req, reply) => {
        const { userId } = auth(req);
        const run = runOwned(req.params.runId, userId);
        let cursor = Math.max(0, Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('after') ?? 0) || 0);
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            'x-accel-buffering': 'no',
            connection: 'keep-alive',
        });
        let open = true;
        let lastWriteAt = Date.now();
        req.raw.on('close', () => { open = false; });
        const send = (payload: Record<string, unknown>): void => {
            if (!open) return;
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); lastWriteAt = Date.now(); }
            catch { open = false; }
        };
        // 弱网心跳：空闲时写SSE注释帧（前端按data帧解析，注释行不产生事件）。
        // 高丢包下半开连接不再静默挂死——客户端watchdog在30s无字节时主动重连，游标续传不丢事件。
        // 间隔可经PRISM_SSE_HEARTBEAT_IDLE_MS覆盖（运维/测试用）。
        const HEARTBEAT_IDLE_MS = Number(process.env.PRISM_SSE_HEARTBEAT_IDLE_MS) || 15_000;
        const latestRun = (): RunRow => runOwned(run.id, userId);
        const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'needs_reconciliation']);
        // 快照
        send({ type: 'snapshot', run: runView(latestRun()) });
        let lastStatus = '';
        const timer = setInterval(() => {
            if (!open) { clearInterval(timer); try { res.end(); } catch { /* closed */ } return; }
            if (Date.now() - lastWriteAt >= HEARTBEAT_IDLE_MS) {
                try { res.write(': ping\n\n'); lastWriteAt = Date.now(); }
                catch { open = false; }
            }
            try {
                const rows = db.db.prepare(`SELECT seq, event_id, attempt_id, type, occurred_at, payload_json FROM run_events
                    WHERE run_id=? AND seq > ? AND visibility IN ${PUBLIC_EVENT_VISIBILITIES} ORDER BY seq ASC LIMIT 200`)
                    .all(run.id, cursor) as unknown as Array<Record<string, unknown>>;
                for (const row of rows) {
                    cursor = Number(row.seq);
                    send({
                        type: 'event',
                        event: {
                            runId:run.id, seq: row.seq, eventId: row.event_id, attemptId: row.attempt_id, type: row.type,
                            occurredAt: row.occurred_at, payload: JSON.parse(String(row.payload_json ?? '{}')),
                        },
                    });
                }
                const current = latestRun();
                if (current.status !== lastStatus) {
                    lastStatus = current.status;
                    send({ type: 'run', run: runView(current) });
                }
                const pending = db.db.prepare(`SELECT 1 FROM run_events WHERE run_id=? AND seq>? AND visibility IN ${PUBLIC_EVENT_VISIBILITIES} LIMIT 1`).get(run.id,cursor);
                if (TERMINAL.has(current.status) && !pending) {
                    send({ type: 'end', run: runView(current) });
                    clearInterval(timer);
                    open = false;
                    res.end();
                }
            }
            catch {
                clearInterval(timer);
                open = false;
                try { res.end(); } catch { /* closed */ }
            }
        }, 400);
        timer.unref?.();
    });

    // —— 用量聚合（DSH底栏数据源；未知值不冒充0） ——

    app.get<{ Params: { runId: string } }>('/api/v1/runs/:runId/usage', async (req, reply) => {
        const { userId } = auth(req);
        const run = runOwned(req.params.runId, userId);
        const snapshot=JSON.parse(run.config_snapshot_json) as {contextWindow?:number};
        return ok(req,reply,{...projectUsage(db,run.conversation_id,snapshot.contextWindow??null,LIMITS.reserveOutputTokens)});
    });
    app.get<{Params:{runId:string};Querystring:{before?:string;limit?:string}}>('/api/v1/runs/:runId/usage/requests',async(req,reply)=>{
        const {userId}=auth(req),run=runOwned(req.params.runId,userId);
        const limit=Math.min(200,Math.max(1,Math.floor(Number(req.query.limit)||100)));
        if(req.query.before){try{decodeUsageCursor(req.query.before);}catch{throw new ApiError('VALIDATION_FAILED','请求分页游标无效');}}
        return ok(req,reply,{...usageRequests(db,run.conversation_id,limit,req.query.before)});
    });

    // —— 变更记录（diff数据源） ——

    app.get<{ Params: { runId: string } }>('/api/v1/runs/:runId/changes', async (req, reply) => {
        const { userId } = auth(req);
        const run = runOwned(req.params.runId, userId);
        const rows = db.db.prepare(`SELECT cr.id, cr.relative_path, cr.operation, cr.before_hash, cr.after_hash, cr.state AS recordState,
            cr.applied_at, cr.reverted_at, cr.diff_patch, cr.diff_patch IS NOT NULL AS hasDiff, ti.tool_name AS tool, ti.state AS invocationState
            FROM change_records cr JOIN tool_invocations ti ON ti.id=cr.invocation_id
            WHERE cr.run_id=? ORDER BY cr.created_at DESC LIMIT 200`).all(run.id) as unknown as Array<Record<string, unknown>>;
        const total = (db.db.prepare('SELECT COUNT(*) AS count FROM change_records WHERE run_id=?').get(run.id) as { count: number }).count;
        return ok(req, reply, { changes: rows.map(({ diff_patch, ...row }) => ({
            ...row, lineStats: changeLineStats(diff_patch as string | null, row.before_hash as string | null, row.after_hash as string | null),
        })), total });
    });

    // 块F1：单条变更的 diff 补丁（列表不带正文，按需拉取）
    app.get<{ Params: { runId: string; recordId: string } }>('/api/v1/runs/:runId/changes/:recordId/diff', async (req, reply) => {
        const { userId } = auth(req);
        const run = runOwned(req.params.runId, userId);
        const row = db.db.prepare(`SELECT cr.diff_patch AS patch, cr.relative_path AS path, cr.operation
            FROM change_records cr WHERE cr.id=? AND cr.run_id=?`)
            .get(req.params.recordId, run.id) as { patch: string | null; path: string; operation: string } | undefined;
        if (!row) throw new ApiError('NOT_FOUND', '变更记录不存在或无权访问');
        return ok(req, reply, { path: row.path, operation: row.operation, patch: row.patch ?? '' });
    });

    // —— 产物 ——

    app.get<{Params:{runId:string}}>('/api/v1/runs/:runId/file-rewind', async(req,reply)=>{
        const run=runOwned(req.params.runId,auth(req).userId);
        return ok(req,reply,prepareFileRewind(db,deps.dataDir,run.id).preview);
    });
    app.post<{Params:{runId:string};Body:{previewToken:string}}>('/api/v1/runs/:runId/file-rewind',{schema:{body:{type:'object',required:['previewToken'],additionalProperties:false,properties:{previewToken:{type:'string',pattern:'^[0-9a-f]{64}$'}}}}},async(req,reply)=>{
        deps.updates?.assertEntryOpen();
        const run=runOwned(req.params.runId,auth(req).userId);
        if(supervisor.active.size)throw new ApiError('CONVERSATION_BUSY','请先停止正在执行的任务，再撤销文件');
        const result=applyFileRewind(db,deps.dataDir,run.id,req.body.previewToken);
        return ok(req,reply,result);
    });

    app.get<{ Params: { runId: string } }>('/api/v1/runs/:runId/artifacts', async (req, reply) => {
        const { userId } = auth(req);
        const run = runOwned(req.params.runId, userId);
        const rows = db.db.prepare(`SELECT id, display_name, mime_type, size_bytes, hash, state, version, created_at
            FROM artifacts WHERE run_id=? ORDER BY created_at DESC LIMIT 100`).all(run.id) as unknown as Array<Record<string, unknown>>;
        return ok(req, reply, { artifacts: rows });
    });

    app.get<{ Params: { artifactId: string } }>('/api/v1/artifacts/:artifactId/download', async (req, reply) => {
        const { userId } = auth(req);
        const row = db.db.prepare(`SELECT a.id, a.display_name, a.mime_type, a.internal_path, a.hash, a.state, a.size_bytes
            FROM artifacts a JOIN runs r ON r.id=a.run_id JOIN projects p ON p.id=r.project_id
            WHERE a.id=? AND p.owner_user_id=?`).get(req.params.artifactId, userId) as
            { id: string; display_name: string; mime_type: string; internal_path: string; hash: string; state: string; size_bytes: number } | undefined;
        if (!row) throw new ApiError('NOT_FOUND', '产物不存在或无权访问');
        if (row.state !== 'verified') throw new ApiError('ARTIFACT_MISSING', '产物未通过完整性核验，拒绝提供下载');
        if (!existsSync(row.internal_path)) throw new ApiError('ARTIFACT_MISSING', '产物文件缺失');
        if (statSync(row.internal_path).size > 50 * 1024 * 1024) throw new ApiError('INPUT_TOO_LARGE', '产物超过50MiB上限');
        const bytes=readFileSync(row.internal_path);
        if(bytes.byteLength!==row.size_bytes||createHash('sha256').update(bytes).digest('hex')!==row.hash)throw new ApiError('ARTIFACT_HASH_MISMATCH','产物内容与记录不一致，请重新生成');
        const safeName = row.display_name.replace(/[\r\n\0/\\]/g, '_');
        reply.header('Content-Disposition', `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(safeName)}`);
        reply.header('X-Content-Type-Options','nosniff');
        return reply.type(row.mime_type || 'application/octet-stream').send(bytes);
    });
}

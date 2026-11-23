import { runnerEnvironment } from './platformShell.js';
import { terminateProcessTree, detachedProcessGroup } from './processTree.js';
import { ResearchCoordinator } from './research.js';
import {queueView} from './conversationQueue.js';
import { cloneConversation } from './conversationFork.js';
import {resizeImage} from '@earendil-works/pi-coding-agent';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Db } from '../storage/db.js';
import { ApiError } from '../../contracts/errors.js';
import { resolveModelParameters } from '../models/parameterResolver.js';
import type { FrozenModelParameters, AgentRuntimeSettings, ThinkingLevel } from '../../contracts/models.js';
import { DEFAULT_AGENT_SETTINGS, DEFAULT_SUBAGENT_SETTINGS, normalizeAgentSettings } from '../../contracts/models.js';
import { resolveVisionSupport } from './modelCatalog.js';
import { TicketRegistry } from './tickets.js';
import { ModelRequestRegistry, LIMITS, type RequestKind } from './modelRequests.js';
import type { ModelGatewayServer, FrozenModelBinding } from './gatewayServer.js';
import { ChannelEndpoint, encodeFrame, type Frame, type FrameError } from './protocol.js';
import { TOOL_SPECS, toolSpec, toolReadFile, toolReadImage, toolListDir, toolGrep, brokerWrite, toolWriteArtifact, toolReadArtifact, type ToolSpec } from './toolExec.js';
import { fetchUrlText } from './webTools.js';
import { executeBrowserTool, type DesktopBrowserHost } from './desktopBrowser.js';
import { wasFileChangeReverted } from './fileRewind.js';
import { searchWebForUser, webSearchAvailableForBinding } from './searchSettings.js';
import { collectCachedMcpTools, callQualifiedMcpTool, type QualifiedMcpTool } from './mcpManager.js';
import { collectEnabledSkillPaths } from './skillCatalog.js';
import { replaceRunTodos, type TodoItem } from './runTodos.js';
import { buildRunnerSeatbeltProfile, runnerSandboxSpawnArgs } from './seatbelt.js';
import { loadAttachmentImages, loadFrozenAttachmentImages, normalizeAttachmentIds, attachmentView, type SteerImage } from './attachments.js';
import { buildContextManifest, readProjectRules, resolveRequestInput, type ProjectRulesDenied } from './contextManifest.js';
import { waitStateVersion } from './waitStateVersion.js';
import {requiresApproval} from './approvalPolicy.js';
import { MemoryLifecycle } from './memoryLifecycle.js';
import type { HandoffSaveInput } from '../../contracts/memory.js';
import { UserQuestionService } from './userQuestions.js';
import { ASK_USER_QUESTION } from '../../contracts/userQuestions.js';
import { buildMemoryBootstrap, memoryRootOf, toolMemoryRead, toolMemoryWrite, toolMemoryDelete, updateMemoryIndex, recoverMemoryLocks } from './memoryStore.js';
import {isApprovalMode,type ApprovalMode} from '../../contracts/permissions.js';
import type { CredentialVault } from '../models/vault.js';
import type { GrantRow } from '../files/picker.js';

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

function hashOfJson(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/**
 * 监督器（计划v1.6 §3/§7）：Run/Attempt生命周期、runner进程编排、工具门禁与审批领取、
 * 补充注入、取消/恢复、checkpoint确认。可信侧；不持有worker内的沙箱策略决定权。
 */

export interface RunConfigSnapshot {
    parameters?: FrozenModelParameters;
    runtimeSettings?: AgentRuntimeSettings;
    regenerateAnswer?: boolean;
    approvalMode?:ApprovalMode;
    protocol?: import('../../contracts/v1.js').ModelProtocol;
    modelConfigId: string;
    modelId: string;
    modelDisplayName: string;
    baseUrl: string;
    providerPreset: string;
    configRevision: number;
    contextWindow: number | null;   // null＝窗口未知（目录未收录且未手填，D55 不猜）
    maxOutputTokens: number;
    promptVersion: string;
    policyVersion: string;
    sessionRef: string;
    /** 阶段④续聊：研究会话中的普通run在创建时冻结的预算受控研究上下文（重试不漂移）。 */
    researchContext?: string;
    /** 阶段④执行交接：来源研究与用户确认的验收项（正文已注入验收清单）。 */
    researchHandoff?: { sourceRunId: string; items: string[] };
}

export interface SupervisorOptions {
    db: Db;
    dataDir: string;
    tickets: TicketRegistry;
    registry: ModelRequestRegistry;
    vault: CredentialVault;
    gateway: ModelGatewayServer;
    runnerEntry: string;   // 编译后的runner入口绝对路径
    nodePath?: string;
    now?: () => Date;
    /** 仅测试受控上游注入：注入binding的CA证书（生产不设置）。 */
    bindingCaCertPem?: string;
    /** 内嵌浏览器宿主（桌面版由backend经IPC注入；纯Web/验证环境缺省=浏览器工具不下发） */
    desktopBrowser?: DesktopBrowserHost;
}

const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_STALE_MS = 15_000;
const TICKET_TTL_MS = 30 * 60_000;
const APPROVAL_TTL_MS = 10 * 60_000;
const RUN_BUDGET_MS = 30 * 60_000;
const TOOL_TIMEOUT_MS = 120_000;
/** 政策版本（审批策略等）：恢复时与快照核对，政策升级后旧任务不得带旧政策恢复（F04）。 */
const CURRENT_POLICY_VERSION = 'policy-v2-host-filesystem';

interface ActiveRun {
    cleanupFailed?: boolean;
    compactQueued?: boolean;
    compactionPreflight?: {id:string;manifest:Record<string,unknown>;sourceSeq:number};
    approvalMode:ApprovalMode;
    runId: string;
    attemptId: string;
    projectId: string;
    conversationId: string;
    userId: string;
    sessionId: string;
    workspace: GrantRow;
    /** 本次attempt的session目录（runtime/<attemptId>/session）：runner命令组登记文件的清扫依据 */
    sessionDir: string;
    subagentConfig: import('../../contracts/models.js').SubagentSettings;
    binding: FrozenModelBinding;
    proc: ChildProcess | null;
    execChannel: ChannelEndpoint | null;
    abort: AbortController;
    startedAtMs: number;
    cancelTimer: ReturnType<typeof setTimeout> | null;
    nonce: string;
    nonceConfirmed: boolean;
    pendingApproval: { invocationId: string; approvalId: string; respond: (ok: boolean, payload: unknown, error?: { code: string; message: string }) => void } | null;
    status: 'running' | 'cancelling' | 'finalizing';
    /** 目标消息seq：请求输入绑定校验基线（F05） */
    objectiveSeq: number;
    /** 本attempt可用的MCP快照工具（bootstrap下发的同一份引用） */
    mcpTools: QualifiedMcpTool[];
    /** 持久记忆库本attempt是否可用（普通任务且账号未关闭；研究/子代理不可用），监督器侧兜底门禁 */
    memoryEnabled: boolean;
    memoryScope?: {kind:'recall'|'extraction';operationId?:string};
}

export interface CreatedRun {
    runId: string;
    conversationId: string;
    status: string;
    waitingInput: boolean;
}

export class Supervisor {
    readonly memoryLifecycle: MemoryLifecycle;
    readonly userQuestions: UserQuestionService;
    readonly active = new Map<string, ActiveRun>();
    readonly research: ResearchCoordinator;
    private readonly bindingByAttempt = new Map<string, FrozenModelBinding>();
    /** 块E5：编辑分叉Run的checkpoint门禁（runId → 截断点前最大source_seq）；startAttempt取用即删，内存态足够（startAttempt紧随create） */
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private stopping = false;
    /** 弱网自愈L2：可重试模型错误失败后的监督器级attempt自动重建。白名单刻意排除限流/凭据/配额
     * （ Coding Plan配额性质与陪审团CREDENTIAL卡死教训：错误归因不可自愈类不自动重试）；任何用户交互单主让位。 */
    private static readonly AUTO_RETRY_CODES = new Set(['MODEL_TIMEOUT', 'PROVIDER_ERROR']);
    private static readonly AUTO_RETRY_MAX = 2;
    private readonly autoRetryTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; fromAttemptId: string }>();

    constructor(readonly opts: SupervisorOptions) {
        this.memoryLifecycle = new MemoryLifecycle(opts.db, opts.dataDir);
        this.userQuestions = new UserQuestionService(opts.db, (runId, type, payload) => this.emit(runId, type, payload));
        this.research = new ResearchCoordinator(opts.db, {
            freeze: (sessionId, configId, modelId) => this.freezeModelConfig(sessionId,configId,modelId),
            launch: (runId,attemptId,sessionId,model) => this.startAttempt(runId,attemptId,sessionId,model,this.activeGrantOf((this.db.db.prepare('SELECT project_id FROM runs WHERE id=?').get(runId) as {project_id:string}).project_id)),
            // 研究记忆注入：只取索引摘要（正文永不进入研究）；损坏由 readMemoryIndex 抛错→create 显式省略。
            memoryIndex: (projectId) => { try { return buildMemoryBootstrap(this.dataDir, projectId).index; } catch { return null; } },
        });
        this.heartbeatTimer = setInterval(() => this.watchdog(), HEARTBEAT_INTERVAL_MS);
        this.heartbeatTimer.unref?.();
    }

    private get db(): Db { return this.opts.db; }
    private get dataDir(): string { return this.opts.dataDir; }

    /** 网关依赖：attempt冻结绑定（只读内存索引）。 */
    bindingFor(attemptId: string): FrozenModelBinding | undefined {
        return this.bindingByAttempt.get(attemptId);
    }

    /** 网关依赖：attempt取消信号（撤票/取消Run时中止上游流）。 */
    abortSignalFor(attemptId: string): AbortSignal | undefined {
        for (const active of this.active.values()) {
            if (active.attemptId === attemptId) return active.abort.signal;
        }
        return undefined;
    }

    dispose(): void {
        this.beginShutdown();
        for (const run of this.active.values()) {
            this.userQuestions.cancelRun(run.runId, 'SHUTDOWN');
            if (run.cancelTimer) clearTimeout(run.cancelTimer);
            this.cleanupProcessGroup(run, 'SIGKILL');
        }
    }

    // —— 事件写入（seq分配+producer去重） ——

    emit(runId: string, type: string, payload: Record<string, unknown>, visibility: 'public' | 'owner' | 'role_private' | 'audit' = 'public', attemptId?: string, producerSeq?: number): { seq: number; deduped: boolean } {
        const now = new Date().toISOString();
        try {
            return this.db.tx(tx => {
                const seqRow = tx.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM run_events WHERE run_id=?').get(runId) as { seq: number };
                const seq = seqRow.seq;
                const eventId = randomUUID();
                tx.prepare(`INSERT INTO run_events(run_id,seq,event_id,attempt_id,producer_seq,visibility,type,occurred_at,payload_json)
                    VALUES (?,?,?,?,?,?,?,?,?)`)
                    .run(runId, seq, eventId, attemptId ?? null, producerSeq ?? null, visibility, type, now, JSON.stringify(payload));
                this.db.db.prepare('UPDATE runs SET updated_at=? WHERE id=?').run(now, runId);
                return { seq, deduped: false };
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : '';
            if (message.includes('UNIQUE')) return { seq: 0, deduped: true }; // producerSeq重复：忽略（幂等）
            throw error;
        }
    }

    // —— Run创建（事务持久化，提交后启动runner；spawn失败持久化失败，不留假running） ——

    createOrdinaryRun(input: { userId: string; sessionId: string; projectId: string; conversationId: string | null; objective: string; modelConfigId: string; modelId: string; approvalMode?:ApprovalMode; attachmentIds?: string[]; thinkingLevel?: ThinkingLevel; researchHandoff?: { sourceRunId?: unknown; items?: unknown } }): CreatedRun {
        const now = new Date().toISOString();
        const config = this.freezeModelConfig(input.sessionId, input.modelConfigId, input.modelId, input.thinkingLevel);
        const grant = this.activeGrantOf(input.projectId);
        // 块E2：目标消息可携带图片附件；装载失败（缺失/非本人）整体拒绝，不留半创建Run
        const attachmentIds = normalizeAttachmentIds(input.attachmentIds);
        if(attachmentIds.length&&!resolveVisionSupport(config.protocol??'openai-completions',config.baseUrl,config.modelId,config.parameters?.advanced))throw new ApiError('VALIDATION_FAILED','当前模型不支持图片输入，请更换模型或移除图片');
        const objectiveAttachments = attachmentIds.length ? loadAttachmentImages(this.db, input.userId, attachmentIds).rows.map(attachmentView) : undefined;

        // 阶段④执行交接：来源研究归属校验+验收项规范化；正文注入在objectiveText统一完成
        const handoff = input.researchHandoff ? (() => {
            const sourceRunId = String((input.researchHandoff as {sourceRunId?:unknown}).sourceRunId ?? '');
            const rawItems = Array.isArray((input.researchHandoff as {items?:unknown}).items) ? (input.researchHandoff as {items:unknown[]}).items : [];
            const items = rawItems.map(item => String(item ?? '').trim()).filter(item => item);
            if (!/^[0-9a-fA-F-]{10,64}$/.test(sourceRunId)) throw new ApiError('VALIDATION_FAILED', '交接来源研究无效');
            if (!items.length || items.length > 20 || items.some(item => item.length > 2000)) throw new ApiError('VALIDATION_FAILED', '验收项须为1—20条，每条1—2000字符');
            const source = this.db.db.prepare('SELECT r.id,p.owner_user_id,r.status FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.id=?').get(sourceRunId) as { id: string; owner_user_id: string; status: string } | undefined;
            if (!source || source.owner_user_id !== input.userId) throw new ApiError('NOT_FOUND', '来源研究不存在或无权访问');
            if (source.status !== 'succeeded' || !this.research.isResearch(source.id)) throw new ApiError('VALIDATION_FAILED', '只能交接已成功出报告的研究结论');
            return { sourceRunId, items };
        })() : null;
        const created = this.db.tx(tx => {
            const project = tx.prepare('SELECT * FROM projects WHERE id=? AND owner_user_id=?').get(input.projectId, input.userId) as { id: string; archived_at: string | null; approval_mode?:ApprovalMode } | undefined;
            if (!project) throw new ApiError('NOT_FOUND', '项目不存在或无权访问');
            if (project.archived_at) throw new ApiError('PROJECT_ARCHIVED', '请先恢复已归档项目，再创建任务');

            let conversationId = input.conversationId;
            let isResearchConversation = false;
            if (conversationId) {
                const conv = tx.prepare('SELECT * FROM conversations WHERE id=? AND project_id=?').get(conversationId, input.projectId) as { id: string; mode:string; last_message_seq: number; archived_at: string | null } | undefined;
                if (!conv) throw new ApiError('NOT_FOUND', '会话不存在或无权访问');
                // 阶段④续聊：研究会话允许创建普通run（结论续聊与执行交接）；活动互斥仍由部分唯一索引统一裁决（CONVERSATION_BUSY）
                isResearchConversation = conv.mode !== 'ordinary';
                if (conv.archived_at) throw new ApiError('RUN_NOT_ACTIVE', '请先在归档中恢复任务，再继续对话');
            }
            else {
                conversationId = randomUUID();
                const title = input.objective.replace(/\s+/g, ' ').slice(0, 50);
                tx.prepare('INSERT INTO conversations(id,project_id,mode,title,last_message_seq,created_at,updated_at) VALUES (?,?,?,?,0,?,?)')
                    .run(conversationId, input.projectId, 'ordinary', title, now, now);
            }

            const versionRow = tx.prepare('SELECT COALESCE(MAX(version),0)+1 AS v FROM problem_versions WHERE conversation_id=?').get(conversationId) as { v: number };
            const problemVersionId = randomUUID();
            // 阶段④执行交接：验收项同时进入任务正文（目标消息/清单/正文一致）；研究上下文在创建时冻结（重试不漂移）
            const objectiveText = handoff ? `${input.objective}\n\n【执行交接·验收项】\n${handoff.items.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : input.objective;
            const researchContext = isResearchConversation ? this.researchConversationDigest(conversationId) : undefined;
            tx.prepare(`INSERT INTO problem_versions(id,conversation_id,version,objective,constraints_json,confirmed_at,created_at,updated_at) VALUES (?,?,?,?,'[]',?,?,?)`)
                .run(problemVersionId, conversationId, versionRow.v, objectiveText, now, now, now);

            const runId = randomUUID();
            const snapshot: RunConfigSnapshot = {
                approvalMode: input.approvalMode ?? project.approval_mode ?? 'auto',
                protocol: config.protocol, modelConfigId: config.configId, modelId: config.modelId, modelDisplayName: config.displayName,
                baseUrl: config.baseUrl, providerPreset: config.preset, configRevision: config.revision,
                contextWindow: config.contextWindow, maxOutputTokens: config.maxOutputTokens, parameters: config.parameters, runtimeSettings: this.runtimeSettings(input.userId),
                promptVersion: 'ordinary-v1', policyVersion: CURRENT_POLICY_VERSION, sessionRef: input.sessionId,
                ...(researchContext ? { researchContext } : {}),
                ...(handoff ? { researchHandoff: handoff } : {}),
            };
            // 同会话互斥由部分唯一索引保证；违规抛CONVERSATION_BUSY
            try {
                tx.prepare(`INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,phase,round_count,config_snapshot_json,next_event_seq,created_at,updated_at)
                    VALUES (?,?,?,?, 'ordinary','created','ordinary',0,?,0,?,?)`)
                    .run(runId, input.projectId, conversationId, problemVersionId, JSON.stringify(snapshot), now, now);
            }
            catch (error) {
                if (error instanceof Error && error.message.includes('UNIQUE')) throw new ApiError('CONVERSATION_BUSY', '该会话已有进行中的任务');
                throw error;
            }
            const bindingId = randomUUID();
            tx.prepare(`INSERT INTO agent_bindings(id,run_id,role_id,model_config_id,model_id,model_snapshot_json,prompt_version,policy_version,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
                .run(bindingId, runId, 'ordinary', config.configId, config.modelId, JSON.stringify({ contextWindow: config.contextWindow, maxOutputTokens: config.maxOutputTokens, parameters: config.parameters, baseUrl: config.baseUrl }), snapshot.promptVersion, snapshot.policyVersion, now, now);
            const phaseTaskId = randomUUID();
            tx.prepare(`INSERT INTO phase_tasks(id,run_id,agent_binding_id,phase_key,round_no,status,input_manifest_json,created_at,updated_at)
                VALUES (?,?,?,'ordinary',0,'pending',?,?,?)`)
                .run(phaseTaskId, runId, bindingId, JSON.stringify({ grantId: grant.id, grantRevision: grant.revision, objective: objectiveText }), now, now);
            const attemptId = randomUUID();
            tx.prepare(`INSERT INTO attempts(id,phase_task_id,number,status,created_at,updated_at) VALUES (?,?,1,'pending',?,?)`)
                .run(attemptId, phaseTaskId, now, now);

            // 用户目标消息（公开正文）
            const conv = tx.prepare('SELECT last_message_seq FROM conversations WHERE id=?').get(conversationId) as { last_message_seq: number };
            const seq = conv.last_message_seq + 1;
            tx.prepare(`INSERT INTO messages(id,conversation_id,run_id,author_type,role_id,seq,visibility,state,content_json,created_at,updated_at)
                VALUES (?,?,?, 'user','ordinary',?, 'public','published', ?, ?, ?)`)
                .run(randomUUID(), conversationId, runId, seq, JSON.stringify(objectiveAttachments ? { text: objectiveText, attachments: objectiveAttachments } : { text: objectiveText }), now, now);
            tx.prepare('UPDATE conversations SET last_message_seq=?, updated_at=? WHERE id=?').run(seq, now, conversationId);
            return { runId, conversationId, attemptId };
        });

        const hasCredential = !!this.opts.vault.get(input.sessionId, config.configId);
        if (!hasCredential) {
            // 缺Key：保留created/waiting_input且不启动worker（§7 waiting_input恢复）
            this.db.db.prepare(`UPDATE runs SET status='waiting_input', stop_reason='CREDENTIAL_REQUIRED', updated_at=? WHERE id=?`).run(now, created.runId);
            this.emit(created.runId, 'run.waiting_input', { reason: 'CREDENTIAL_REQUIRED' }, 'public');
            return { runId: created.runId, conversationId: created.conversationId, status: 'waiting_input', waitingInput: true };
        }
        this.emit(created.runId, 'run.created', { conversationId: created.conversationId }, 'audit');
        try {
            this.startAttempt(created.runId, created.attemptId, input.sessionId, config, grant);
            return { runId: created.runId, conversationId: created.conversationId, status: 'running', waitingInput: false };
        }
        catch (error) {
            // spawn失败持久化失败，不留假running
            const message = error instanceof Error ? error.message : 'SPAWN_FAILED';
            this.db.db.prepare(`UPDATE runs SET status='failed', stop_reason=?, ended_at=?, updated_at=? WHERE id=?`).run('RUNNER_SPAWN_FAILED', now, now, created.runId);
            this.db.db.prepare(`UPDATE attempts SET status='failed', error_code=?, updated_at=? WHERE id=?`).run('RUNNER_SPAWN_FAILED', now, created.attemptId);
            this.emit(created.runId, 'run.failed', { error: 'RUNNER_SPAWN_FAILED', detail: message.slice(0, 200) }, 'public');
            throw new ApiError('SANDBOX_UNAVAILABLE', `运行器启动失败：${message.slice(0, 100)}`);
        }
    }

    /** Explicit editing/forking starts a new conversation branch; original history and filesystem stay intact. */
    forkRun(input: { userId: string; sessionId: string; conversationId: string; cutMessageId: string; cutMode: 'before' | 'through'; objective?: string; modelConfigId?: string; modelId?: string; approvalMode?: ApprovalMode; attachmentIds?: string[]; thinkingLevel?: ThinkingLevel }): { runId?: string; conversationId: string; status?: string; waitingInput?: boolean } {
        let editAttachmentIds=input.attachmentIds;
        if(input.objective!==undefined){
            if(!input.objective.trim()||input.objective.length>20000)throw new ApiError('VALIDATION_FAILED','编辑后的消息须为1至20000字符');
            const owned=this.db.db.prepare(`SELECT c.project_id FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=? AND p.owner_user_id=?`).get(input.conversationId,input.userId) as {project_id:string}|undefined;
            if(!owned)throw new ApiError('NOT_FOUND','会话不存在或无权访问');
            const message=this.db.db.prepare("SELECT id,content_json FROM messages WHERE id=? AND conversation_id=? AND author_type='user' AND visibility='public' AND state='published'").get(input.cutMessageId,input.conversationId) as {id:string;content_json:string}|undefined;
            if(!message)throw new ApiError('NOT_FOUND','只能编辑用户消息');
            if(editAttachmentIds===undefined)editAttachmentIds=(JSON.parse(message.content_json).attachments??[]).map((a:{id:string})=>a.id);
            const config=this.db.db.prepare('SELECT owner_user_id FROM model_configs WHERE id=?').get(input.modelConfigId??'') as {owner_user_id:string}|undefined;
            if(!config||config.owner_user_id!==input.userId)throw new ApiError('NOT_FOUND','模型接口不存在或无权访问');
            const frozen=this.freezeModelConfig(input.sessionId,input.modelConfigId!,input.modelId??'');
            if(normalizeAttachmentIds(editAttachmentIds).length&&!resolveVisionSupport(frozen.protocol??'openai-completions',frozen.baseUrl,frozen.modelId,frozen.parameters?.advanced))throw new ApiError('VALIDATION_FAILED','当前模型不支持图片输入，请更换模型或移除图片');
            this.activeGrantOf(owned.project_id);
            loadAttachmentImages(this.db,input.userId,normalizeAttachmentIds(editAttachmentIds));
        }
        const branch=cloneConversation(this.db,input.userId,input.conversationId,input.cutMessageId,input.objective!==undefined?'before':input.cutMode);
        if(input.objective===undefined)return branch;
        return this.createOrdinaryRun({userId:input.userId,sessionId:input.sessionId,projectId:branch.projectId,conversationId:branch.conversationId,objective:input.objective.trim(),modelConfigId:input.modelConfigId!,modelId:input.modelId!,approvalMode:input.approvalMode,attachmentIds:editAttachmentIds,thinkingLevel:input.thinkingLevel});
    }

    private freezeModelConfig(sessionId: string, configId: string, modelId: string, overrideThinkingLevel?: ThinkingLevel): { configId: string; modelId: string; displayName: string; baseUrl: string; preset: string; protocol?: import('../../contracts/v1.js').ModelProtocol; revision: number; contextWindow: number | null; maxOutputTokens: number; parameters?: FrozenModelParameters } {
        const config = this.db.db.prepare('SELECT * FROM model_configs WHERE id=? AND enabled=1').get(configId) as { id: string; owner_user_id: string; base_url: string; preset: string; api_protocol: import('../../contracts/v1.js').ModelProtocol; revision: number } | undefined;
        if (!config) throw new ApiError('MODEL_UNAVAILABLE', '模型接口不存在或已停用');
        const entry = this.db.db.prepare('SELECT * FROM model_entries WHERE config_id=? AND model_id=? AND enabled=1').get(configId, modelId) as { display_name: string; parameters_json: string } | undefined;
        if (!entry) throw new ApiError('MODEL_UNAVAILABLE', '模型不存在或已停用');
        if (!this.opts.vault.get(sessionId, configId)) throw new ApiError('CREDENTIAL_REQUIRED', '请先在设置中提供该接口的API Key');
        // 任务窗口覆盖 > 模型条目设置默认；覆盖值同样经 resolver 目录校验（fail-closed）
        const rawParameters = JSON.parse(entry.parameters_json) as Record<string, unknown>;
        if (overrideThinkingLevel !== undefined) rawParameters.thinkingLevel = overrideThinkingLevel;
        const parameters = resolveModelParameters(config.api_protocol ?? 'openai-completions', config.base_url, modelId, rawParameters);
        return { configId, modelId, displayName: entry.display_name, baseUrl: config.base_url, preset: config.preset, protocol: config.api_protocol ?? 'openai-completions', revision: config.revision, ...parameters.effective, parameters };
    }

    runtimeSettings(userId: string): AgentRuntimeSettings {
        const row=this.db.db.prepare('SELECT settings_json FROM agent_runtime_settings WHERE user_id=?').get(userId) as {settings_json:string}|undefined;
        return normalizeAgentSettings(row?JSON.parse(row.settings_json):{});
    }

    private activeGrantOf(projectId: string): GrantRow {
        // 主要目录优先（多文件夹项目，migration 027 回填）；无标记存量按创建时间取最新。
        const row = this.db.db.prepare(`SELECT * FROM workspace_grants WHERE project_id=? AND revoked_at IS NULL ORDER BY is_primary DESC, created_at DESC, id DESC LIMIT 1`).get(projectId) as GrantRow | undefined;
        // 文件夹仅确定默认工作目录；旧read/excludes字段不再限制Agent的本机访问。
        if (!row) throw new ApiError('VALIDATION_FAILED', '请先选择项目的默认工作目录');
        return row;
    }

    private attemptDirs(attemptId: string): { base: string; home: string; scratch: string; tmp: string; session: string } {
        const base = join(this.dataDir, 'runtime', attemptId);
        return { base, home: join(base, 'home'), scratch: join(base, 'scratch'), tmp: join(base, 'tmp'), session: join(base, 'session') };
    }

    startAttempt(runId: string, attemptId: string, sessionId: string, config: { configId: string; modelId: string; displayName: string; baseUrl: string; preset: string; protocol?: import('../../contracts/v1.js').ModelProtocol; revision: number; contextWindow: number | null; maxOutputTokens: number; parameters?: FrozenModelParameters }, grant: GrantRow, mode: 'start' | 'resume' | 'regenerate' = 'start'): void {
        const run = this.db.db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as { id: string; conversation_id: string; project_id: string; config_snapshot_json: string; status: string } | undefined;
        if (!run) throw new ApiError('NOT_FOUND', 'Run不存在');
        if (!['created', 'waiting_input'].includes(run.status)) throw new ApiError('RUN_NOT_RESUMABLE', 'Run当前状态不可启动');
        const snapshot = JSON.parse(run.config_snapshot_json) as RunConfigSnapshot;
        const research = this.research.context(attemptId);
        // 研究复用普通Agent能力：规则/技能/附加根/显式附件同属ordinaryTools能力束——仅ordinaryTools run装载。
        // 每个phase启动时按发起时冻结的元数据重载并核验（存在/归属/hash/魔数/大小），任一不符明确失败。
        // 模型不支持视觉→可重试失败（创建前已全角色预检，此处是retry时点的复核）。不静默降级为纯文本。
        // 旧run/固定v1 run（无ordinaryTools快照键）一律维持旧受限视图：不装载附件、不注入项目规则、
        // 不下发技能清单与附加工作目录（修"v1任务执行输入变化"：这些本属v2能力束，装进v1偏离旧版行为）。
        const researchOrdinaryTools = research ? this.research.ordinaryToolsForRun(runId) : [];
        const researchAttachments = research && researchOrdinaryTools.length ? this.research.attachmentsForRun(runId) : [];
        if (research && researchAttachments.length && !resolveVisionSupport(config.protocol ?? 'openai-completions', config.baseUrl, config.modelId, config.parameters?.advanced)) {
            // 角色模型在创建时冻结（retry不重读模型目录）：失败须引导重新发起，而非暗示重试可换模型
            throw new ApiError('VALIDATION_FAILED', `角色${research.phase.label}的模型不支持图片输入；请移除附件重新发起，或为该角色选择支持图片输入的模型后新建研究`);
        }
        const researchImages = researchAttachments.length
            ? loadFrozenAttachmentImages(this.db, this.ownerOfRun(runId), researchAttachments)
            : [];

        const dirs = this.attemptDirs(attemptId);
        for (const dir of [dirs.base, dirs.home, dirs.scratch, dirs.tmp, dirs.session]) mkdirSync(dir, { recursive: true, mode: 0o700 });

        this.emit(runId, 'workspace.ready', { filesystem: 'host', direct: true }, 'audit', attemptId);

        const now = new Date().toISOString();
        const nonce = randomBytes(16).toString('hex');
        this.db.db.prepare(`UPDATE attempts SET status='running', updated_at=? WHERE id=? AND status IN ('pending','failed')`).run(now, attemptId);
        this.db.db.prepare(`UPDATE phase_tasks SET status='running', active_attempt_id=?, updated_at=? WHERE id=(SELECT phase_task_id FROM attempts WHERE id=?)`).run(attemptId, now, attemptId);
        this.db.db.prepare(`UPDATE runs SET status='running', updated_at=? WHERE id=?`).run(now, runId);

        const binding: FrozenModelBinding = {
            configId: config.configId, sessionRef: sessionId, baseUrl: config.baseUrl,
            protocol: config.protocol, providerPreset: config.preset, modelId: config.modelId, contextWindow: config.contextWindow,
            maxOutputTokens: config.maxOutputTokens, configRevision: config.revision,
            parameters: snapshot.parameters ?? config.parameters,
            caCertPem: this.opts.bindingCaCertPem,
        };
        this.bindingByAttempt.set(attemptId, binding);

        const ticket = this.opts.tickets.mint({
            attemptId, runId, roleId: research?.view.participantId ?? 'ordinary', participantId: research?.view.participantId, phaseTaskId: research?.view.phaseTaskId, viewId: research?.view.id, modelConfigId: config.configId, modelId: config.modelId, policyVersion: snapshot.policyVersion,
        }, TICKET_TTL_MS);

        const objectiveRow = this.db.db.prepare('SELECT objective FROM problem_versions WHERE id=(SELECT problem_version_id FROM runs WHERE id=?)').get(runId) as { objective: string };

        // 可信上下文清单（F01/F02/F04）：正式历史+已确认checkpoint+项目规则+跨Run产物元数据+
        // 副作用账本。start模式继承同会话其他Run的checkpoint（F01跨Run追问）；resume模式继承
        // 本Run更早attempt的checkpoint（F04恢复）。清单内容与hash记入审计。
        const manifest = research ? {
            // 研究attempt：不继承普通对话历史/跨Run checkpoint/其他角色私稿；项目规则（AGENTS.md）
            // 与显式附件图片按普通任务同一链路下发，但仅限ordinaryTools快照run；v1 run维持旧最小清单（projectRules=null）。
            objective:research.prompt, objectiveMessageId:'', objectiveSeq:0,
            objectiveImages: researchImages,
            historyMessages:[], historyTruncated:false, isResume:false, restoredInputThroughSeq:0,
            inheritedCheckpoint:null, inheritedArtifacts:[], revertedFiles:[], toolLedger:[],
            projectRules: researchOrdinaryTools.length ? readProjectRules(grant) : null,
        } : buildContextManifest(this.db, {
            runId, conversationId: run.conversation_id, grant,
            checkpointFrom: mode === 'start' ? 'conversation' : 'run',
        });
        this.emit(runId, 'run.context_manifest', {
            mode,
            historyCount: manifest.historyMessages.length,
            historyTruncated: manifest.historyTruncated,
            checkpointId: manifest.inheritedCheckpoint?.checkpointId ?? null,
            rulesHash: manifest.projectRules?.hash ?? null,
            rulesDenied: (manifest.projectRules as ProjectRulesDenied | null)?.deniedReason ?? null,
            objectiveMessageId: manifest.objectiveMessageId,
            ledgerCount: manifest.toolLedger.length,
        }, 'audit', attemptId);

        // 研究run：MCP只下发创建时冻结的manifest（mcpToolsForRun 与 research.tool() dispatch 共用同一份快照）；
        // 旧run无快照键=空清单。普通任务维持原发现清单。
        const mcpTools = research ? this.research.mcpToolsForRun(runId) : collectCachedMcpTools(this.db, this.ownerOfRun(runId));
        // 块C技能装配：约定目录扫描+启停入库后仅下发显式路径；激活记录进审计。
        // 研究复用普通Agent能力：ordinaryTools快照run与普通任务共用同一份已启用技能清单；v1 run固定为空。
        const enabledSkills = research
            ? (researchOrdinaryTools.length ? collectEnabledSkillPaths(this.db, this.ownerOfRun(runId), grant.canonical_root) : [])
            : collectEnabledSkillPaths(this.db, this.ownerOfRun(runId), grant.canonical_root);
        this.emit(runId, 'run.skills', { count: enabledSkills.length, names: enabledSkills.map(s => s.name).slice(0, 20) }, 'audit', attemptId);
        // 持久记忆（最小闭环）：索引与清单随bootstrap下发；工具读写经tool_proposed门禁，
        // 路径由监督器钉死 dataDir/memory/<projectId>（research视图与关闭记忆的账号不下发）
        const memory = research || snapshot.runtimeSettings?.memoryEnabled === false
            ? null
            : buildMemoryBootstrap(this.dataDir, run.project_id);
        this.emit(runId, 'run.memory', { enabled: memory !== null, files: memory?.files.length ?? 0 }, 'audit', attemptId);
        const bootstrap = {
            v: 1, attemptId, runId, nonce,
            research: research ? {view:research.view} : undefined,
            // 研究普通工具策略（创建时冻结的能力快照）：runner据此下发普通只读工具；旧run缺省=旧受限视图
            researchToolPolicy: research ? { ordinaryTools: this.research.ordinaryToolsForRun(runId) } : undefined,
            gatewayBaseUrl: this.opts.gateway.baseUrl,
            ticket: ticket.token,
            ticketExpiresAtMs: ticket.expiresAtMs,
            dirs: { home: dirs.home, scratch: dirs.scratch, tmp: dirs.tmp, session: dirs.session },
            grant: { id: grant.id, canonicalRoot: grant.canonical_root, access: grant.access, excludes: JSON.parse(grant.excludes_json) as string[] },
            // 多文件夹项目：主要目录之外的附加工作目录随bootstrap下发，runner注入system prompt；
            // 研究v1 run不下发（旧受限视图不带workspace_roots块），ordinaryTools run与普通任务一致。
            additionalRoots: research && !researchOrdinaryTools.length ? [] : (this.db.db.prepare('SELECT canonical_root FROM workspace_grants WHERE project_id=? AND revoked_at IS NULL AND is_primary=0 AND id<>? ORDER BY created_at ASC, id ASC').all(run.project_id, grant.id) as unknown as Array<{ canonical_root: string }>).map(row => row.canonical_root),
            approvalMode:isApprovalMode(snapshot.approvalMode)?snapshot.approvalMode:'auto',
            // 阶段④续聊：普通run在研究会话中携带研究上下文与执行交接验收项（runner渲染为平台注入块）
            researchContext: snapshot.researchContext,
            researchHandoff: snapshot.researchHandoff,
            objective: manifest.objective,
            objectiveMessageId: manifest.objectiveMessageId,
            objectiveSeq: manifest.objectiveSeq,
            // 块E2：目标消息图片随bootstrap下发（session目录0600，正文不落库）
            objectiveImages: manifest.objectiveImages,
            historyMessages: manifest.historyMessages,
            historyTruncated: manifest.historyTruncated,
            isResume: manifest.isResume,
            regenerateAnswer: snapshot.regenerateAnswer === true,
            restoredInputThroughSeq: manifest.restoredInputThroughSeq,
            inheritedCheckpoint: manifest.inheritedCheckpoint,
            inheritedArtifacts: manifest.inheritedArtifacts,
            revertedFiles: manifest.revertedFiles,
            toolLedger: manifest.toolLedger,
            projectRules: manifest.projectRules,
            model: { id: config.modelId, supportsImages:resolveVisionSupport(config.protocol??'openai-completions',config.baseUrl,config.modelId,config.parameters?.advanced), contextWindow: config.contextWindow, maxOutputTokens: config.maxOutputTokens },
            // 联网搜索可见性（学 ZCode shouldExposeWebSearch）：接口已勾选或全局已配置才向模型下发 web_search 工具
            webSearchAvailable: webSearchAvailableForBinding(this.db, this.ownerOfRun(runId), { configId: binding.configId, baseUrl: binding.baseUrl }),
            // 内嵌浏览器可见性：桌面宿主公告能力才下发 browser_* 工具（纯Web/受控验证不下发）
            browserAvailable: this.opts.desktopBrowser?.available === true,
            parameters: snapshot.parameters ?? config.parameters,
            runtimeSettings: snapshot.runtimeSettings ?? DEFAULT_AGENT_SETTINGS,
            promptVersion: snapshot.promptVersion,
            policyVersion: snapshot.policyVersion,
            sandbox: { network: 'deny-all' },
            limits: { toolTimeoutMs: TOOL_TIMEOUT_MS, modelSteps: LIMITS.modelStepsPerAttempt, toolSteps: LIMITS.toolStepsPerAttempt },
            // MCP工具attempt快照：仅已启用+已信任server的最近一次探针清单；副作用工具按D49逐次审批
            mcpTools,
            // 技能显式装配路径（已启用）；runner 侧 additionalSkillPaths 注入，不做宿主自动发现
            skills: enabledSkills,
            // 持久记忆索引与清单（普通任务且账号未关闭时下发；工具仍走tool_proposed门禁）
            memory: memory ?? undefined,
        };
        const bootstrapPath = join(dirs.session, 'bootstrap.json');
        writeFileSync(bootstrapPath, JSON.stringify(bootstrap), { mode: 0o600 });

        const active: ActiveRun = {
            runId, attemptId, projectId: run.project_id, conversationId: run.conversation_id,
            userId: '', sessionId, workspace: grant, sessionDir: dirs.session, subagentConfig:{...DEFAULT_SUBAGENT_SETTINGS,...snapshot.runtimeSettings?.subagent}, binding, proc: null, execChannel: null,
            abort: new AbortController(), startedAtMs: Date.now(), cancelTimer: null, nonce, nonceConfirmed: false,
            pendingApproval: null, status: 'running',
            objectiveSeq: manifest.objectiveSeq,
            approvalMode:isApprovalMode(snapshot.approvalMode)?snapshot.approvalMode:'auto',
            mcpTools,
            memoryEnabled: memory !== null,
        };
        const workerId = randomUUID();
        this.db.db.prepare(`INSERT INTO worker_instances(id,attempt_id,host_id,pid,process_start_stamp,instance_nonce,state,heartbeat_at,created_at,updated_at)
            VALUES (?,?,?,?,?,?,'starting',?,?,?)`).run(workerId, attemptId, 'local', 0, '', nonce, now, now, now);

        const nodePath = this.opts.nodePath ?? process.execPath;
        // 本机完整文件访问；macOS策略仅限制网络，不再隔离文件系统。
        const gatewayPort = Number(new URL(this.opts.gateway.baseUrl).port);
        const sandboxProfilePath = join(dirs.session, 'runner.sb');
        writeFileSync(sandboxProfilePath, buildRunnerSeatbeltProfile({
            attemptBase: dirs.base,
            gatewayPort,
        }), { mode: 0o600 });
        const sandboxSpawn = runnerSandboxSpawnArgs(sandboxProfilePath, nodePath, resolve(this.opts.runnerEntry), bootstrapPath);
        this.emit(runId, 'runner.sandbox', { policy: sandboxSpawn ? 'seatbelt-network-only' : process.platform === 'win32' ? 'windows-account-guard' : 'none', filesystem: 'host', platform: process.platform }, 'audit', attemptId);
        const proc = spawn(sandboxSpawn?.command ?? nodePath, sandboxSpawn?.args ?? [resolve(this.opts.runnerEntry), bootstrapPath], {
            cwd: dirs.scratch,
            env: {
                ...runnerEnvironment(process.env, dirs.tmp),
                // bash继承外层网络策略，不嵌套sandbox-exec。
                ...(sandboxSpawn ? { PI_OUTER_SANDBOX: '1' } : {}),
            },
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: detachedProcessGroup(),
            windowsHide: true,
        });
        proc.stdin?.on('error', error => {
            if (this.active.get(runId) === active && active.status === 'running') {
                this.emit(runId, 'runner.channel_error', { message: error.message.slice(0, 200) }, 'audit', attemptId);
                void this.failRun(runId, 'WORKER_CHANNEL_CLOSED');
            }
        });
        active.proc = proc;
        this.active.set(runId, active);
        this.db.db.prepare('UPDATE worker_instances SET pid=?, process_start_stamp=?, state=?, heartbeat_at=?, updated_at=? WHERE id=?')
            .run(proc.pid ?? 0, this.processStartStamp(proc.pid ?? 0), 'starting', now, now, workerId);
        this.db.db.prepare('UPDATE attempts SET worker_id=?, updated_at=? WHERE id=?').run(workerId, now, attemptId);

        // 双通道复用同一对stdio：agent通道（runner→监督器请求+事件）与exec通道（监督器→runner命令）
        // 的出站都写proc.stdin，入站都从proc.stdout按frame.channel分发。
        const writeToStdin = (data: string) => { proc.stdin?.write(data); };
        const execEndpoint = new ChannelEndpoint('exec', writeToStdin, () => { /* exec通道无入站请求 */ }, undefined, undefined);
        active.execChannel = execEndpoint;

        const stderrTail: string[] = [];
        proc.stderr?.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8');
            stderrTail.push(...text.split('\n').slice(0, 20));
            if (stderrTail.length > 40) stderrTail.splice(0, stderrTail.length - 40);
            // 运行器stderr转发为审计事件（定位挂起/崩溃；不进公开时间线）
            if (text.trim()) this.emit(runId, 'runner.stderr', { text: text.slice(0, 1000) }, 'audit', attemptId);
        });

        proc.on('exit', (code, signal) => {
            execEndpoint.close();
            agentEndpoint.close();
            this.onRunnerExit(active, code, signal, stderrTail.join('\n').slice(-1000));
        });
        proc.on('error', error => {
            this.emit(runId, 'runner.error', { message: error.message.slice(0, 200) }, 'audit');
        });

        // agent通道（runner→监督器）
        const agentEndpoint = new ChannelEndpoint('agent',
            writeToStdin,
            (frame, respond) => { void this.handleAgentFrame(active, frame, respond); },
            (seq, frame) => { void this.handleAgentFrame(active, frame, () => { /* 事件帧无响应 */ }); },
            () => { /* 通道关闭由exit处理 */ },
        );
        // 协议违规须可见：进入审计事件（帧本身丢弃），不给静默降级留空间
        agentEndpoint.onProtocolViolation = error => {
            this.emit(runId, 'runner.protocol_violation', { message: error.message.slice(0, 300) }, 'audit', active.attemptId);
        };
        (active as unknown as { agentChannel?: ChannelEndpoint }).agentChannel = agentEndpoint;
        // 分帧缓冲须经StringDecoder解码：>64KB帧的chunk边界可能切进多字节UTF-8字符，
        // 直接chunk.toString会把残字节变成U+FFFD并静默损坏write_file内容/超长消息/完成摘要
        const stdoutDecoder = new StringDecoder('utf8');
        let acc = '';
        proc.stdout?.on('data', (chunk: Buffer) => {
            acc += stdoutDecoder.write(chunk);
            for (;;) {
                const idx = acc.indexOf('\n');
                if (idx === -1) break;
                const line = acc.slice(0, idx);
                acc = acc.slice(idx + 1);
                // 按帧头channel分发到对应端点；各端点自行校验方法allowlist与协议合法性
                let channel: string | undefined;
                try { channel = (JSON.parse(line) as { channel?: string }).channel; }
                catch { channel = undefined; }
                if (channel === 'exec') execEndpoint.feed(line + '\n');
                else agentEndpoint.feed(line + '\n');
            }
        });
        // 用户答题不消耗运行预算；按attempt核对，旧定时器不能取消新一轮重试。
        const checkBudget = () => {
            const still = this.active.get(runId);
            if (!still || still.attemptId !== attemptId) return;
            if (this.userQuestions.hasPending(runId)) { setTimeout(checkBudget, 30_000).unref?.(); return; }
            const remaining = RUN_BUDGET_MS - (Date.now() - still.startedAtMs);
            if (remaining <= 0) void this.cancelRun(runId, 'budget_exceeded');
            else setTimeout(checkBudget, remaining).unref?.();
        };
        setTimeout(checkBudget, RUN_BUDGET_MS).unref?.();
    }

    private processStartStamp(pid: number): string {
        // Windows以nonce核对；不调用不存在的/bin/ps，也不为可选时间戳启动PowerShell。
        if (process.platform === 'win32') return '';
        // 同步ps查询进程启动时间（best effort；失败返回空串，身份核对以nonce为主）
        try {
            const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 });
            return result.status === 0 ? String(result.stdout ?? '').trim() : '';
        }
        catch { return ''; }
    }

    /** 读取runner登记的命令进程组（runtime/<attemptId>/session/runner-groups.json）。
     * runner被SIGKILL时其退出钩子不会执行，该文件是外部清扫bash孙进程组的唯一依据。 */
    private readRunnerGroups(attemptId: string): Array<{ pid: number; stamp: string }> {
        try {
            const parsed = JSON.parse(readFileSync(join(this.dataDir, 'runtime', attemptId, 'session', 'runner-groups.json'), 'utf8')) as unknown;
            if (!Array.isArray(parsed)) return [];
            return parsed.filter((entry): entry is { pid: number; stamp: string } =>
                !!entry && typeof entry === 'object'
                && Number.isSafeInteger((entry as { pid?: unknown }).pid) && Number((entry as { pid: number }).pid) > 0
                && typeof (entry as { stamp?: unknown }).stamp === 'string')
                .map(entry => ({ pid: Number(entry.pid), stamp: entry.stamp }));
        }
        catch { return []; }
    }

    /** 清扫runner登记的命令进程组：仅对身份戳一致（/bin/ps启动时间匹配）的组整组SIGKILL，防PID复用误杀；
     * win32与无戳记录跳过（audit留痕，依赖taskkill /T树杀与runner自败兜底）。 */
    private sweepRunnerGroups(attemptId: string, runId: string, reason: string): void {
        const killed: number[] = [];
        let skipped = 0;
        for (const { pid, stamp } of this.readRunnerGroups(attemptId)) {
            const liveStamp = this.processStartStamp(pid);
            if (process.platform !== 'win32' && stamp && liveStamp && liveStamp === stamp && terminateProcessTree(pid, 'SIGKILL')) killed.push(pid);
            else skipped += 1;
        }
        if (killed.length) this.emit(runId, 'runner.groups_swept', { attemptId, reason, killed, skipped }, 'audit', attemptId);
    }

    /** 启动对账时击杀上一世遗留的runner进程：本进程刚启动、active必为空，worker_instances仍标
     * running/starting且run未终态的worker即遗留。按登记的pid+process_start_stamp身份核对后才击杀
     * （防PID复用误杀）；win32与无戳记录跳过击杀（runner侧STDIN_EOF/心跳失败自败兜底），audit留痕。
     * SIGTERM先行让runner退出钩子自清bash子进程组，5s后核尸仍在再SIGKILL并按登记文件清扫残留组。 */
    private killStaleWorkersAtStartup(now: string): void {
        const rows = this.db.db.prepare(`SELECT wi.id, wi.attempt_id, wi.pid, wi.process_start_stamp, pt.run_id
            FROM worker_instances wi JOIN attempts a ON a.id=wi.attempt_id JOIN phase_tasks pt ON pt.id=a.phase_task_id JOIN runs r ON r.id=pt.run_id
            WHERE wi.state IN ('running','starting') AND r.status NOT IN ('succeeded','failed','cancelled')`).all() as unknown as Array<{ id: string; attempt_id: string; pid: number; process_start_stamp: string; run_id: string }>;
        for (const row of rows) {
            const pid = Number(row.pid);
            this.db.db.prepare(`UPDATE worker_instances SET state='lost', updated_at=? WHERE id=?`).run(now, row.id);
            if (!Number.isSafeInteger(pid) || pid <= 0) continue;
            const stamp = this.processStartStamp(pid);
            if (process.platform === 'win32' || !stamp || stamp !== row.process_start_stamp) {
                if (stamp && row.process_start_stamp) this.emit(row.run_id, 'runner.stale_leftover', { pid, attemptId: row.attempt_id, message: '启动对账：遗留runner身份戳不符，跳过击杀请人工核对残留进程与副作用' }, 'audit', row.attempt_id);
                continue;
            }
            this.emit(row.run_id, 'runner.stale_kill', { pid, attemptId: row.attempt_id, message: '启动对账发现上一世遗留runner，SIGTERM后核尸SIGKILL并清扫其命令进程组' }, 'audit', row.attempt_id);
            terminateProcessTree(pid, 'SIGTERM');
            const attemptId = row.attempt_id, runId = row.run_id;
            setTimeout(() => {
                if (this.processStartStamp(pid) === row.process_start_stamp) {
                    terminateProcessTree(pid, 'SIGKILL');
                    this.sweepRunnerGroups(attemptId, runId, 'stale_runner_sigkill');
                }
            }, 5_000).unref?.();
        }
    }

    // —— agent通道帧处理 ——

    private async handleAgentFrame(active: ActiveRun, frame: Frame, respond: (ok: boolean, payload?: unknown, error?: FrameError) => void): Promise<void> {
        try {
            if(this.research.isResearch(active.runId) && !['ready','heartbeat','log','emit_event','complete_proposed','tool_proposed','model_request_proposed','run_failed'].includes(frame.method)) throw new ApiError('POLICY_DENIED','研究模式不继承其他视图的压缩或控制状态');
            switch (frame.method) {
                case 'ready': {
                    const payload = frame.payload as { nonce?: string } | undefined;
                    if (payload?.nonce !== active.nonce) {
                        respond(false, undefined, { code: 'NONCE_MISMATCH', message: 'runner启动标识不符' });
                        this.emit(active.runId, 'runner.rejected', { reason: 'nonce_mismatch' }, 'audit');
                        return;
                    }
                    active.nonceConfirmed = true;
                    const now = new Date().toISOString();
                    this.db.db.prepare(`UPDATE worker_instances SET state='running', heartbeat_at=?, updated_at=? WHERE attempt_id=? AND instance_nonce=?`).run(now, now, active.attemptId, active.nonce);
                    this.emit(active.runId, 'run.started', { attemptId: active.attemptId, model: active.binding.modelId }, 'public');
                    respond(true, { ok: true });
                    return;
                }
                case 'heartbeat': {
                    const renewed = this.opts.tickets.renew(active.attemptId, TICKET_TTL_MS);
                    const now = new Date().toISOString();
                    this.db.db.prepare('UPDATE worker_instances SET heartbeat_at=?, updated_at=? WHERE attempt_id=?').run(now, now, active.attemptId);
                    respond(renewed, renewed ? { ok: true } : undefined, renewed ? undefined : { code: 'TICKET_INVALID', message: '租约已失效' });
                    return;
                }
                case 'log': {
                    const payload = frame.payload as { level?: string; message?: string } | undefined;
                    this.emit(active.runId, 'runner.log', { level: String(payload?.level ?? 'info').slice(0, 10), message: String(payload?.message ?? '').slice(0, 2000) }, 'audit', active.attemptId);
                    respond(true, {});
                    return;
                }
                case 'model_request_proposed': {
                    respond(true, await this.handleModelRequestProposed(active, frame.payload));
                    return;
                }
                case 'memory_control': {
                    if (!active.memoryEnabled || this.research.isResearch(active.runId) || active.abort.signal.aborted || active.status !== 'running') throw new ApiError('POLICY_DENIED','当前任务不可运行记忆辅助流程');
                    const p=frame.payload as {action?:string;selected?:unknown;operationId?:string;state?:'completed'|'failed'|'cancelled';error?:string};
                    if(p.action==='recall_begin') { if(active.memoryScope)throw new ApiError('REQUEST_IN_PROGRESS','记忆辅助流程正在运行');active.memoryScope={kind:'recall'};respond(true,buildMemoryBootstrap(this.dataDir,active.projectId));return; }
                    if(p.action==='recall_read') { if(active.memoryScope?.kind!=='recall')throw new ApiError('POLICY_DENIED','召回尚未登记');const memories=await this.memoryLifecycle.recall(active.projectId,p.selected);active.memoryScope=undefined;this.emit(active.runId,'memory.recalled',{files:memories.map(m=>m.path)},'owner',active.attemptId);respond(true,{memories});return; }
                    if(p.action==='extraction_begin') {
                        if(active.memoryScope)throw new ApiError('REQUEST_IN_PROGRESS','记忆辅助流程正在运行');
                        if(active.approvalMode==='ask'){respond(true,{skipped:'manual-approval-mode'});return;}
                        if(this.hasPendingUserInput(active.conversationId)) {respond(true,{skipped:'pending-user-input'});return;}
                        const latest=this.db.db.prepare("SELECT state FROM model_requests WHERE attempt_id=? AND request_kind NOT IN ('memory_recall','memory_extraction') ORDER BY rowid DESC LIMIT 1").get(active.attemptId) as {state:string}|undefined;
                        if(latest?.state!=='completed')throw new ApiError('REQUEST_IN_PROGRESS','主模型尚未完成，暂不提炼记忆');
                        const context=this.memoryLifecycle.prepare(active.runId,active.attemptId,active.projectId,active.conversationId);
                        if(context.operationId)active.memoryScope={kind:'extraction',operationId:context.operationId};
                        this.emit(active.runId,context.operationId?'memory.extraction.started':'memory.extraction.skipped',{operationId:context.operationId??null,reason:context.skipped??null},'owner',active.attemptId);respond(true,context);return;
                    }
                    if(p.action==='finish') { const scope=active.memoryScope;if(scope?.kind==='extraction'&&scope.operationId!==p.operationId)throw new ApiError('POLICY_DENIED','记忆提炼编号不匹配');if(scope?.operationId&&scope.operationId===p.operationId){this.memoryLifecycle.finish(scope.operationId,active.attemptId,p.state==='completed'?'completed':p.state==='cancelled'?'cancelled':'failed',p.error);this.emit(active.runId,'memory.extraction.ended',{operationId:scope.operationId,state:p.state??'failed',message:p.error?.slice(0,200)},'owner',active.attemptId);}active.memoryScope=undefined;respond(true,{ok:true});return; }
                    throw new ApiError('VALIDATION_FAILED','未知记忆辅助操作');
                }
                case 'tool_proposed': {
                    await this.handleToolProposed(active, frame.payload, respond);
                    return;
                }
                case 'compaction_preflight': {
                    if(active.status!=='running'||active.abort.signal.aborted||this.hasPendingUserInput(active.conversationId)) throw new ApiError('REQUEST_IN_PROGRESS','有待处理用户输入或任务已停止；不压缩');
                    const p=frame.payload as {sourceManifest?:Record<string,unknown>;inputThroughSeq?:number};
                    if(!p?.sourceManifest||typeof p.sourceManifest!=='object') throw new ApiError('VALIDATION_FAILED','压缩来源清单缺失');
                    const m=p.sourceManifest;
                    if(!Array.isArray(m.summarizedIds)||!m.summarizedIds.length||!Array.isArray(m.keptIds)||!m.keptIds.length||m.firstKeptEntryId!==m.keptIds[0]||[...m.summarizedIds,...m.keptIds].some(x=>typeof x!=='string'||!x)||new Set([...m.summarizedIds,...m.keptIds]).size!==m.summarizedIds.length+m.keptIds.length) throw new ApiError('VALIDATION_FAILED','压缩来源集合无效');
                    const sourceSeq=Number(p.inputThroughSeq);
                    const last=this.db.db.prepare('SELECT last_message_seq FROM conversations WHERE id=?').get(active.conversationId) as {last_message_seq:number};
                    if(!Number.isInteger(sourceSeq)||sourceSeq<0||sourceSeq>last.last_message_seq) throw new ApiError('VALIDATION_FAILED','压缩来源游标无效');
                    const preflightId=randomUUID();
                    active.compactionPreflight={id:preflightId,manifest:structuredClone(m),sourceSeq};
                    respond(true,{preflightId});return;
                }
                case 'compact_finished': {
                    active.compactQueued=false;
                    active.compactionPreflight=undefined;
                    respond(true,{ok:true});return;
                }
                case 'context_checkpoint_applied': {
                    const checkpointId=String((frame.payload as {checkpointId?:unknown})?.checkpointId??'');
                    if(active.abort.signal.aborted||active.status!=='running') throw new ApiError('ATTEMPT_NOT_ACTIVE','任务已停止，不确认压缩');
                    const now=new Date().toISOString();
                    this.db.tx(tx=>{
                        const changed=tx.prepare("UPDATE context_checkpoints SET state='confirmed',confirmed_at=?,updated_at=? WHERE id=? AND attempt_id=? AND state='proposed'").run(now,now,checkpointId,active.attemptId);
                        if(changed.changes!==1) throw new ApiError('VALIDATION_FAILED','压缩checkpoint不存在或已失效');
                        tx.prepare("UPDATE context_checkpoints SET state='superseded',updated_at=? WHERE run_id=? AND id<>? AND state='confirmed'").run(now,active.runId,checkpointId);
                    });
                    this.emit(active.runId,'context.compaction.completed',{checkpointId},'public',active.attemptId);
                    respond(true,{checkpointId});return;
                }
                case 'context_checkpoint_proposed': {
                    respond(true, await this.handleCheckpointProposed(active, frame.payload));
                    return;
                }
                case 'emit_event': {
                    const payload = frame.payload as { type?: string; data?: Record<string, unknown>; visibility?: 'public' | 'owner' | 'role_private' | 'audit' } | undefined;
                    if (payload?.type) {
                        if(this.research.isResearch(active.runId)) {
                            if(!['run.error','run.complete_rejected'].includes(payload.type)) {respond(true,{});return;}
                        }
                        const visibility = (['public', 'owner', 'role_private', 'audit'] as const).includes(payload.visibility as never) ? payload.visibility! : 'public';
                        this.emit(active.runId, String(payload.type).slice(0, 60), payload.data ?? {}, visibility, active.attemptId, frame.producerSeq);
                    }
                    respond(true, {});
                    return;
                }
                case 'complete_proposed': {
                    await this.handleCompleteProposed(active, frame.payload, respond);
                    return;
                }
                case 'run_failed': {
                    // runner结构化失败（模型错误经pi分类器归因，request回执后才退出）：采信code写入
                    // runs.stop_reason/attempts.error_code；code格式不符或run已非running时安全降级。
                    const payload = frame.payload as { code?: string; message?: string; retryable?: boolean; details?:Record<string,unknown> } | undefined;
                    const code = typeof payload?.code === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(payload.code) ? payload.code : 'RUNNER_EXITED';
                    const message = typeof payload?.message === 'string' && payload.message.trim() ? payload.message.slice(0, 400) : undefined;
                    this.failRunningRun(active.runId, active.attemptId, code, {
                        ...(message ? { message } : {}),
                        ...(code==='DELIVERY_INVALID'&&payload?.details?{delivery:payload.details}:{}),
                        retryable: payload?.retryable === true,
                    });
                    respond(true, {});
                    return;
                }
                default:
                    respond(false, undefined, { code: 'POLICY_DENIED', message: '未知方法' });
            }
        }
        catch (error) {
            if (error instanceof ApiError) respond(false, undefined, { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
            else respond(false, undefined, { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message.slice(0, 200) : '内部错误' });
        }
    }

    private async handleModelRequestProposed(active: ActiveRun, raw: unknown): Promise<unknown> {
        const research = this.research.context(active.attemptId);
        if(research)this.research.checkBudget(active.attemptId,'model');
        const payload = raw as {
            bodyHash?: string; kind?: string; estimatedInputTokens?: number; maxOutputTokens?: number;
            sourceSeq?: number; checkpointId?: string | null; turnId?: string | null; clientMessageId?: string | null;
            inputThroughSeq?: number;
        };
        if (!payload?.bodyHash || !/^[0-9a-f]{64}$/.test(payload.bodyHash)) throw new ApiError('VALIDATION_FAILED', 'bodyHash无效');
        const kind: RequestKind = ['main','compaction','repair','memory_recall','memory_extraction'].includes(String(payload.kind)) ? payload.kind as RequestKind : 'main';
        if(kind.startsWith('memory_') && (!active.memoryEnabled || research || active.memoryScope?.kind !== (kind==='memory_recall'?'recall':'extraction')))throw new ApiError('POLICY_DENIED','记忆辅助调用未登记或未启用');
        // 消息游标绑定（F05）：runner报告其请求体包含到的seq上界；可信层只绑定"≤上界的未消费
        // 公开用户消息"。body构造后才到达的补充不在绑定集合内，消费门禁保持关闭直到真正进入
        // 后续请求。压缩/修复请求不消费主输入。绑定与校验逻辑见contextManifest.resolveRequestInput。
        let binding: { ids: string[]; sourceSeq: number | null };
        try {
            binding = research ? {ids:[],sourceSeq:null} : resolveRequestInput(this.db, active.conversationId, kind, payload.inputThroughSeq, active.objectiveSeq);
        }
        catch (error) {
            const code = error instanceof Error && error.message.startsWith('REQUEST_INPUT_SEQ') ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR';
            throw new ApiError(code, `模型请求输入绑定被拒绝：${error instanceof Error ? error.message : '未知'}`);
        }
        const reservation = this.opts.registry.propose({
            attemptId: active.attemptId,
            runId: active.runId,
            roleId: research?.view.participantId ?? 'ordinary',
            kind,
            bodyHash: payload.bodyHash,
            estimatedInputTokens: Math.max(0, Math.round(Number(payload.estimatedInputTokens ?? 0))),
            maxOutputTokens: Math.max(1, Math.round(Number(payload.maxOutputTokens ?? active.binding.maxOutputTokens))),
            inputMessageIds: binding.ids,
            sourceSeq: binding.sourceSeq,
            checkpointId: typeof payload.checkpointId === 'string' ? payload.checkpointId : null,
            turnId: typeof payload.turnId === 'string' ? payload.turnId : null,
            clientMessageId: typeof payload.clientMessageId === 'string' ? payload.clientMessageId : null,
            provider: 'prism-gateway',
            model: active.binding.modelId,
            contextWindow: active.binding.contextWindow,
            frozenMaxOutput: active.binding.maxOutputTokens,
            reserveOutputTokens: LIMITS.reserveOutputTokens,
        });
        this.emit(active.runId, 'model.request.started', { requestId: reservation.requestId, viewId:research?.view.id, participantId:research?.view.participantId, phaseTaskId:research?.view.phaseTaskId, kind, inputCount: binding.ids.length, inputThroughSeq: binding.sourceSeq }, 'audit', active.attemptId);
        return { ok: true, requestId: reservation.requestId, reservation: reservation.reservation, maxOutputTokens: reservation.maxOutputTokens, expiresAtMs: reservation.expiresAtMs };
    }

    /** 补充门禁：存在未消费的公开用户补充时，未领取调用一律DEFERRED_BY_USER_INPUT。 */
    private hasPendingUserInput(conversationId: string): boolean {
        const row = this.db.db.prepare(`SELECT COUNT(*) AS n FROM messages
            WHERE conversation_id=? AND author_type='user' AND state='published' AND consumed_cursor_json IS NULL`).get(conversationId) as { n: number };
        return row.n > 0;
    }

    private async handleToolProposed(active: ActiveRun, raw: unknown, respond: (ok: boolean, payload?: unknown, error?: FrameError) => void): Promise<void> {
        const payload = raw as { toolName?: string; args?: Record<string, unknown>; parentInvocationId?: string; memoryOperationId?:string };
        if(this.research.isResearch(active.runId)){
            const requestedResearchTool = String(payload?.toolName ?? '');
            // 研究普通工具策略（创建时冻结）：ordinaryTools清单内的只读工具走下方普通执行器门禁
            // （同一toolSpec/账本/取消语义），研究预算先扣；写入/命令/记忆/产物发布不在清单，仍被拒。
            if (this.research.ordinaryToolsForRun(active.runId).includes(requestedResearchTool)) {
                this.research.checkBudget(active.attemptId,'tool');
            }
            else {
                // 研究专用通道：research_read/research_search/web_*/verify_source/MCP冻结清单
                this.research.checkBudget(active.attemptId,'tool');
                const name=String(payload?.toolName??''),args=payload?.args??{},invocationId=randomUUID(),time=new Date().toISOString();
                this.db.db.prepare("INSERT INTO tool_invocations(id,run_id,phase_task_id,attempt_id,call_key,tool_name,tool_version,args_hash,redacted_args_json,state,effect_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,'v1',?,?,'claimed','read',?,?)").run(invocationId,active.runId,this.phaseTaskIdOf(active.attemptId),active.attemptId,invocationId,name,hashOfJson(args),JSON.stringify(args),time,time);
                try{
                    const result=await this.research.tool(active.attemptId,name,args,this.ownerOfRun(active.runId));
                    this.db.db.prepare("UPDATE tool_invocations SET state='succeeded',result_json=?,updated_at=? WHERE id=?").run(JSON.stringify(result),new Date().toISOString(),invocationId);
                    this.emit(active.runId,'tool.completed',{invocationId,tool:name,ok:true,durationMs:Math.max(0,Date.now()-Date.parse(time)),summary:summarizeResult(result,true)},'public',active.attemptId);
                    respond(true,{result});
                }catch(error){
                    this.db.db.prepare("UPDATE tool_invocations SET state='failed',error_code=?,updated_at=? WHERE id=?").run(error instanceof ApiError?error.code:'INTERNAL_ERROR',new Date().toISOString(),invocationId);
                    this.emit(active.runId,'tool.completed',{invocationId,tool:name,ok:false,durationMs:Math.max(0,Date.now()-Date.parse(time)),error:error instanceof ApiError?error.code:'INTERNAL_ERROR'},'public',active.attemptId);
                    throw error;
                }
                return;
            }
        }
        // 子代理子调用（块D）：parent须为本run在途的agent工具行，子调用与父并行登记，不受父行的busy阻塞；
        // 其余子调用声明一律视为普通提议（parent校验失败按无parent处理，走顺序门禁）
        const parentInvocationId = typeof payload?.parentInvocationId === 'string' ? payload.parentInvocationId : null;
        let parentRow: { id: string; state: string } | undefined;
        if (parentInvocationId) {
            parentRow = this.db.db.prepare("SELECT id, state FROM tool_invocations WHERE id=? AND run_id=? AND tool_name='agent' AND state='claimed'")
                .get(parentInvocationId, active.runId) as { id: string; state: string } | undefined;
        }
        if (!parentRow) {
            const busy = this.db.db.prepare("SELECT id FROM tool_invocations WHERE run_id=? AND state IN ('claimed','awaiting_approval') LIMIT 1").get(active.runId);
            if (busy) { respond(false,undefined,{code:'REQUEST_IN_PROGRESS',message:'本任务已有工具执行或审批中，工具须顺序领取'}); return; }
        }
        const requestedName = String(payload?.toolName ?? '');
        if(payload.memoryOperationId && (active.memoryScope?.kind!=='extraction'||active.memoryScope.operationId!==payload.memoryOperationId))throw new ApiError('POLICY_DENIED','记忆提炼已结束');
        if(active.memoryScope?.kind==='extraction'&&requestedName==='memory_write'&&(payload.args?.path==='MEMORY.md'||String(payload.args?.path??'').startsWith('handoff/')))throw new ApiError('POLICY_DENIED','自动提炼不能改写索引或交接快照');
        if(active.memoryScope?.kind==='extraction' && (payload.memoryOperationId!==active.memoryScope.operationId || !['memory_read','memory_write'].includes(requestedName)))throw new ApiError('POLICY_DENIED','记忆提炼只允许读写记忆库，不能执行其他工具');
        if(parentRow&&requestedName.startsWith('memory_'))throw new ApiError('POLICY_DENIED','只读子代理不能访问项目记忆');
        // 内置8工具 + 本attempt的MCP快照工具（mcp__<server>__<tool>）；其余一律拒绝
        const spec: ToolSpec | undefined = toolSpec(requestedName) ?? this.mcpSpecFor(active, requestedName);
        if (!spec || (!TOOL_SPECS.some(t => t.name === spec.name) && !requestedName.startsWith('mcp__'))) {
            // 未知工具默认拒绝（不开放自由扩展旁路）
            this.emit(active.runId, 'tool.rejected', { tool: requestedName }, 'audit', active.attemptId);
            respond(false, undefined, { code: 'POLICY_DENIED', message: '工具不在本轮允许清单中' });
            return;
        }
        // 持久记忆工具仅普通任务且账号未关闭记忆时可用（runner侧不下发；监督器兜底拒绝）
        if (spec.name.startsWith('memory_') && !active.memoryEnabled) {
            this.emit(active.runId, 'tool.rejected', { tool: requestedName }, 'audit', active.attemptId);
            respond(false, undefined, { code: 'POLICY_DENIED', message: '记忆功能未启用' });
            return;
        }
        // 门禁1：取消/状态
        const run = this.db.db.prepare('SELECT status, cancel_requested_at FROM runs WHERE id=?').get(active.runId) as { status: string; cancel_requested_at: string | null };
        if (active.status !== 'running' || !['running','waiting_approval'].includes(run.status) || run.cancel_requested_at) {
            respond(false, undefined, { code: 'ATTEMPT_NOT_ACTIVE', message: '任务正在取消' });
            return;
        }
        const args = (payload.args ?? {}) as Record<string, unknown>;
        if (spec.name === ASK_USER_QUESTION && parentRow) throw new ApiError('POLICY_DENIED', '子代理须向主代理汇报，由主代理向用户提问');
        const invocationId = randomUUID();
        const now = new Date().toISOString();
        const argsHash = hashOfJson(args);
        const canonicalArgsJson = JSON.stringify(args);

        // 门禁2：未消费补充 → 批次剩余未领取调用DEFERRED
        if (this.hasPendingUserInput(active.conversationId)) {
            this.db.db.prepare(`INSERT INTO tool_invocations(id,run_id,phase_task_id,attempt_id,call_key,tool_name,tool_version,args_hash,redacted_args_json,state,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,'cancelled',?,?)`)
                .run(invocationId, active.runId, this.phaseTaskIdOf(active.attemptId), active.attemptId, `${active.attemptId}:${invocationId}`, spec.name, 'v1', argsHash, JSON.stringify(redactArgs(spec.name, args)), now, now);
            this.emit(active.runId, 'tool.deferred', { invocationId, tool: spec.name, reason: 'DEFERRED_BY_USER_INPUT' }, 'public', active.attemptId);
            respond(false, undefined, { code: 'DEFERRED_BY_USER_INPUT', message: '有新的用户补充等待处理，本工具未执行' });
            return;
        }

        // 门禁2.5（F04跨attempt幂等）：同Run此前attempt已成功执行的相同(工具,args)调用——恢复后
        // 重发不重复执行副作用，登记replayed调用并回放既有结果；副作用计数保持为1。
        // 取最新一次成功结果：同一命令多次执行时应回放最近的世界状态，而非最陈旧的首次结果。
        const prior = this.db.db.prepare(`SELECT id, result_json, effect_kind FROM tool_invocations
            WHERE run_id=? AND tool_name=? AND args_hash=? AND state='succeeded' AND attempt_id<>?
            ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(active.runId, spec.name, argsHash, active.attemptId) as { id: string; result_json: string | null; effect_kind: string | null } | undefined;
        if (prior && !wasFileChangeReverted(this.db,prior.result_json) && (spec.effect === 'fs_write' || spec.effect === 'bash' || spec.name === 'write_artifact')) {
            this.db.db.prepare(`INSERT INTO tool_invocations(id,run_id,phase_task_id,attempt_id,call_key,tool_name,tool_version,args_hash,redacted_args_json,state,effect_kind,replayed_from_invocation_id,created_at,updated_at)
                VALUES (?,?,?,?,?,?, 'v1', ?,?,?,?,?,?,?)`)
                .run(invocationId, active.runId, this.phaseTaskIdOf(active.attemptId), active.attemptId, `${active.attemptId}:${invocationId}`, spec.name, argsHash, JSON.stringify(redactArgs(spec.name, args)), 'succeeded', prior.effect_kind ?? spec.effect, prior.id, now, now);
            this.db.db.prepare('UPDATE tool_invocations SET result_json=? WHERE id=?').run(prior.result_json, invocationId);
            this.emit(active.runId, 'tool.replayed', { invocationId, tool: spec.name, replayedFromInvocationId: prior.id }, 'public', active.attemptId);
            let priorResult: unknown = {};
            try { priorResult = prior.result_json ? JSON.parse(prior.result_json) : {}; }
            catch { priorResult = {}; }
            respond(true, { ok: true, result: priorResult, replayed: true });
            return;
        }

        // 门禁3：按任务模式审批；文件访问范围始终为本机账户可访问的路径
        const needsApproval = requiresApproval(active.approvalMode,spec,args);
        this.db.db.prepare(`INSERT INTO tool_invocations(id,run_id,phase_task_id,attempt_id,call_key,tool_name,tool_version,args_hash,canonical_exec_args_json,redacted_args_json,state,effect_kind,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(invocationId, active.runId, this.phaseTaskIdOf(active.attemptId), active.attemptId, `${active.attemptId}:${invocationId}`, spec.name, 'v1', argsHash, canonicalArgsJson, JSON.stringify(redactArgs(spec.name, args)), needsApproval ? 'awaiting_approval' : 'claimed', spec.effect, now, now);
        this.emit(active.runId, needsApproval ? 'tool.awaiting_approval' : 'tool.started', needsApproval
            ? { invocationId, tool: spec.name, args: redactArgs(spec.name, args) }
            : { invocationId, tool: spec.name }, 'public', active.attemptId);

        if (needsApproval) {
            const approvalId = randomUUID();
            const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
            this.db.db.prepare(`INSERT INTO approvals(id,invocation_id,owner_user_id,policy_version,state,expires_at,created_at,updated_at)
                VALUES (?,?,?,?, 'pending', ?,?,?)`)
                .run(approvalId, invocationId, active.userId || this.ownerOfRun(active.runId), CURRENT_POLICY_VERSION, expiresAt, now, now);
            // 挂起响应：审批决定后由decideApproval完成执行并回包
            active.pendingApproval = { invocationId, approvalId, respond };
            this.db.db.prepare("UPDATE runs SET status='waiting_approval',updated_at=? WHERE id=? AND status='running'").run(now,active.runId);
            return;
        }
        await this.executeClaimed(active, invocationId, spec, args, respond);
    }

    /** 审批的执行载体（runner+挂起响应）是否仍在：不在时approve无法真正执行，路由层须拒绝而非假成功。 */
    approvalWorkerAlive(runId: string, approvalId: string): boolean {
        const active = this.active.get(runId);
        return !!active && active.pendingApproval?.approvalId === approvalId;
    }

    /** runner已失联时作废pending审批：调用与审批置失效，run若仍停在waiting_approval则终结（可原地重试）。 */
    voidStaleApproval(runId: string, approvalId: string): void {
        const now = new Date().toISOString();
        const approval = this.db.db.prepare('SELECT invocation_id FROM approvals WHERE id=? AND state=\'pending\'').get(approvalId) as { invocation_id: string } | undefined;
        if (!approval) return;
        this.db.db.prepare(`UPDATE approvals SET state='cancelled', cancellation_reason='RUNNER_EXITED', updated_at=? WHERE id=? AND state='pending'`).run(now, approvalId);
        this.db.db.prepare(`UPDATE tool_invocations SET state='cancelled', error_code='RUNNER_EXITED', updated_at=? WHERE id=? AND state='awaiting_approval'`).run(now, approval.invocation_id);
        this.db.db.prepare(`UPDATE runs SET status='failed', ended_at=?, stop_reason='RUNNER_EXITED', updated_at=? WHERE id=? AND status='waiting_approval'`).run(now, now, runId);
        this.emit(runId, 'run.failed', { error: 'RUNNER_EXITED' }, 'public');
    }

    /** 审批决定（API端点调用）。approve→执行并回包；reject/expire→回错误包。幂等：仅pending可决定。 */
    decideApproval(approvalId: string, decision: 'approved' | 'rejected', userId: string): { decided: boolean; invocationId?: string } {
        const now = new Date().toISOString();
        return this.db.tx(tx => {
            const approval = tx.prepare(`SELECT * FROM approvals WHERE id=?`).get(approvalId) as { id: string; invocation_id: string; owner_user_id: string; state: string; expires_at: string } | undefined;
            if (!approval || approval.owner_user_id !== userId) throw new ApiError('NOT_FOUND', '审批不存在或无权访问');
            if (approval.state !== 'pending') return { decided: false, invocationId: approval.invocation_id };
            if (new Date(approval.expires_at).getTime() < Date.now()) {
                tx.prepare(`UPDATE approvals SET state='expired', decided_at=?, updated_at=? WHERE id=?`).run(now, now, approvalId);
                return { decided: false, invocationId: approval.invocation_id };
            }
            tx.prepare(`UPDATE approvals SET state=?, decided_at=?, updated_at=? WHERE id=?`).run(decision, now, now, approvalId);
            return { decided: true, invocationId: approval.invocation_id };
        });
    }

    /** API审批通过后调用：领取执行并回包runner。 */
    async executeApproved(activeRunId: string, approvalId: string): Promise<void> {
        const active = this.active.get(activeRunId);
        const pending = active?.pendingApproval;
        if (!active || !pending || pending.approvalId !== approvalId) return;
        active.pendingApproval = null;
        const now = new Date().toISOString();
        const invocation = this.db.db.prepare('SELECT * FROM tool_invocations WHERE id=?').get(pending.invocationId) as { id: string; tool_name: string; state: string; canonical_exec_args_json: string | null } | undefined;
        if (!invocation || invocation.state !== 'awaiting_approval') {
            pending.respond(false, undefined, { code: 'ATTEMPT_NOT_ACTIVE', message: '审批对应的工具已失效' });
            return;
        }
        const resumed=this.db.db.prepare("UPDATE runs SET status='running',updated_at=? WHERE id=? AND status='waiting_approval' AND cancel_requested_at IS NULL").run(now,activeRunId);
        if(resumed.changes!==1){pending.respond(false,undefined,{code:'ATTEMPT_NOT_ACTIVE',message:'审批对应的任务已不在等待状态'});return;}
        // 新补充仍需先进入模型请求，不能因点击旧审批而绕过工具批次门禁。
        if(this.hasPendingUserInput(active.conversationId)){
            this.db.db.prepare("UPDATE tool_invocations SET state='cancelled',error_code='DEFERRED_BY_USER_INPUT',updated_at=? WHERE id=? AND state='awaiting_approval'").run(now,invocation.id);
            this.emit(activeRunId,'tool.deferred',{invocationId:invocation.id,tool:invocation.tool_name,reason:'DEFERRED_BY_USER_INPUT'},'public',active.attemptId);
            pending.respond(false,undefined,{code:'DEFERRED_BY_USER_INPUT',message:'请先处理新的用户补充，本操作未执行'});return;
        }
        const result = this.db.db.prepare(`UPDATE tool_invocations SET state='claimed', claimed_at=?, updated_at=? WHERE id=? AND state='awaiting_approval'`).run(now, now, invocation.id);
        if (result.changes !== 1) {
            pending.respond(false, undefined, { code: 'ATTEMPT_NOT_ACTIVE', message: '审批对应的工具已失效' });
            return;
        }
        this.emit(activeRunId, 'tool.started', { invocationId: invocation.id, tool: invocation.tool_name }, 'public', active.attemptId);
        const spec = toolSpec(invocation.tool_name) ?? this.mcpSpecFor(active, invocation.tool_name);
        if (!spec) {
            pending.respond(false, undefined, { code: 'POLICY_DENIED', message: '工具不存在' });
            return;
        }
        const args = JSON.parse(invocation.canonical_exec_args_json ?? '{}') as Record<string, unknown>;
        await this.executeClaimed(active, invocation.id, spec, args, pending.respond);
    }

    async rejectApproved(activeRunId: string, approvalId: string, reason: string): Promise<void> {
        const active = this.active.get(activeRunId);
        const pending = active?.pendingApproval;
        if (!active || !pending || pending.approvalId !== approvalId) return;
        active.pendingApproval = null;
        this.db.db.prepare("UPDATE runs SET status='running',updated_at=? WHERE id=? AND status='waiting_approval' AND cancel_requested_at IS NULL").run(new Date().toISOString(),activeRunId);
        this.db.db.prepare(`UPDATE tool_invocations SET state='denied', error_code='APPROVAL_REJECTED', updated_at=? WHERE id=? AND state='awaiting_approval'`)
            .run(new Date().toISOString(), pending.invocationId);
        this.emit(activeRunId, 'tool.rejected', { invocationId: pending.invocationId, reason: reason.slice(0, 100) }, 'public', active.attemptId);
        pending.respond(false, undefined, { code: 'POLICY_DENIED', message: `用户拒绝了该操作：${reason.slice(0, 80) || 'APPROVAL_REJECTED'}` });
    }

    private async executeClaimed(active: ActiveRun, invocationId: string, spec: { name: string; effect: string }, args: Record<string, unknown>, respond: (ok: boolean, payload?: unknown, error?: FrameError) => void): Promise<void> {
        const startedAt = Date.now();
        let result: unknown;
        try {
            switch (spec.name) {
                case ASK_USER_QUESTION:
                    try { result = await this.userQuestions.ask(active.runId, invocationId, args, active.userId || this.ownerOfRun(active.runId)); }
                    finally { active.startedAtMs += Date.now() - startedAt; }
                    break;
                case 'read_file':
                    result = await toolReadFile(this.grantOf(active), { path: String(args.path ?? ''), offset: Number(args.offset ?? 1) || undefined, limit: Number(args.limit ?? 400) || undefined });
                    break;
                case 'read_image': {
                    if(!resolveVisionSupport(active.binding.protocol??'openai-completions',active.binding.baseUrl,active.binding.modelId,active.binding.parameters?.advanced))throw new ApiError('VALIDATION_FAILED','当前模型不支持图片输入，请改用视觉模型');
                    const image=await toolReadImage(this.grantOf(active),{path:String(args.path??'')});
                    const resized=await resizeImage(Buffer.from(image.imageData,'base64'),image.mime);
                    if(!resized)throw new ApiError('VALIDATION_FAILED','图片无法解码或缩放，请提供有效的图片文件');
                    result={...image,mime:resized.mimeType,imageData:resized.data,width:resized.width,height:resized.height,originalWidth:resized.originalWidth,originalHeight:resized.originalHeight};
                    break;
                }
                case 'list_dir':
                    result = await toolListDir(this.grantOf(active), { path: String(args.path ?? '.') });
                    break;
                case 'grep_files':
                    result = await toolGrep(this.grantOf(active), { pattern: String(args.pattern ?? ''), path: args.path ? String(args.path) : undefined, glob: args.glob ? String(args.glob) : undefined });
                    break;
                case 'bash': {
                    const command = String(args.command ?? '');
                    if (!command.trim()) throw new ApiError('VALIDATION_FAILED', '命令不能为空');
                    const timeoutMs = Math.min(120_000, Math.max(1_000, Number(args.timeout_ms ?? TOOL_TIMEOUT_MS)));
                    const execChannel = active.execChannel;
                    if (!execChannel) throw new ApiError('SANDBOX_UNAVAILABLE', '执行通道未就绪');
                    const frame = await execChannel.request('execute_command', { invocationId, command, cwd: this.grantOf(active).canonical_root, timeoutMs }, timeoutMs + 5_000);
                    result = frame.payload;
                    break;
                }
                case 'write_file': {
                    const relPath = String(args.path ?? '');
                    const outcome = await brokerWrite(this.db, { runId: active.runId, invocationId, dataDir: this.dataDir }, this.grantOf(active), {
                        operation: args.expected_hash ? 'modify' : 'create',
                        relativePath: relPath,
                        content: typeof args.content === 'string' ? args.content : '',
                        expectedHash: typeof args.expected_hash === 'string' ? args.expected_hash : null,
                    });
                    result = outcome;
                    break;
                }
                case 'delete_file': {
                    const relPath = String(args.path ?? '');
                    const outcome = await brokerWrite(this.db, { runId: active.runId, invocationId, dataDir: this.dataDir }, this.grantOf(active), {
                        operation: 'delete',
                        relativePath: relPath,
                        expectedHash: typeof args.expected_hash === 'string' ? args.expected_hash : null,
                    });
                    result = outcome;
                    break;
                }
                case 'write_artifact':
                    result = await toolWriteArtifact(this.db, { runId: active.runId, dataDir: this.dataDir, producerRole: 'ordinary', workspaceRoot: this.grantOf(active).canonical_root }, { name: String(args.name ?? 'artifact'), ...(typeof args.content === 'string' ? {content: args.content} : {}), ...(typeof args.path === 'string' ? {path: args.path} : {}) });
                    break;
                case 'read_artifact':
                    // 跨Run产物：归属（同项目）+完整性在toolReadArtifact内核验；授权撤销不影响已验证产物的只读引用
                    result = await toolReadArtifact(this.db, { projectId: active.projectId }, { artifactId: String(args.artifactId ?? '') });
                    break;
                case 'web_fetch':
                    result = await fetchUrlText(String(args.url ?? ''));
                    break;
                case 'web_search':
                    result = await searchWebForUser(this.db, active.userId || this.ownerOfRun(active.runId), String(args.query ?? ''), Number(args.count ?? 5) || 5, { configId: active.binding.configId, baseUrl: active.binding.baseUrl });
                    break;
                case 'browser_navigate':
                case 'browser_snapshot':
                case 'browser_screenshot':
                case 'browser_click':
                case 'browser_fill':
                case 'browser_back': {
                    // 内嵌浏览器：执行在桌面宿主隐藏窗口（webContents），监督器只做门禁与转发；
                    // 出网纪律双层——监督器侧URL校验（含解析复核）+ 宿主侧session守卫（含子资源重查）。
                    if (!this.opts.desktopBrowser || this.opts.desktopBrowser.available !== true)
                        throw new ApiError('BROWSER_UNAVAILABLE', '浏览器宿主不可用：内嵌浏览器需要桌面版运行');
                    if (spec.name === 'browser_screenshot' && !resolveVisionSupport(active.binding.protocol ?? 'openai-completions', active.binding.baseUrl, active.binding.modelId, active.binding.parameters?.advanced))
                        throw new ApiError('VALIDATION_FAILED', '当前模型不支持图片输入，请改用视觉模型');
                    // 自动开面板公告：模型开始驱动浏览器即发事件，UI 据此切到浏览器 tab 全程可见。
                    // 事件只进当前 run 的事件流——用户没在看的 run 不经前端订阅，天然不抢屏。
                    this.emit(active.runId, 'browser.activity', { tool: spec.name }, 'public', active.attemptId);
                    result = await executeBrowserTool(this.opts.desktopBrowser, spec.name, args);
                    if (spec.name === 'browser_screenshot') {
                        const shot = result as { imageData: string; mime: string };
                        const resized = await resizeImage(Buffer.from(shot.imageData, 'base64'), shot.mime);
                        if (!resized) throw new ApiError('VALIDATION_FAILED', '截图无法解码或缩放');
                        result = { ...shot, mime: resized.mimeType, imageData: resized.data, width: resized.width, height: resized.height };
                    }
                    break;
                }
                case 'todo_write': {
                    result = await Promise.resolve(replaceRunTodos(this.db, active.runId, (Array.isArray(args.todos) ? args.todos : []) as TodoItem[]));
                    this.emit(active.runId, 'todo.updated', { todos: result }, 'public', active.attemptId);
                    break;
                }
                case 'memory_handoff_save':
                    result=await this.memoryLifecycle.saveHandoff(active.projectId,active.runId,active.workspace.canonical_root,args as unknown as HandoffSaveInput);break;
                case 'memory_handoff_restore':
                    result=await this.memoryLifecycle.restoreHandoff(active.projectId,active.workspace.canonical_root,typeof args.source_path==='string'?args.source_path:undefined);break;
                case 'memory_read':
                    result = await toolMemoryRead(memoryRootOf(this.dataDir, active.projectId), { path: String(args.path ?? ''), offset: Number(args.offset ?? 1) || undefined, limit: Number(args.limit ?? 400) || undefined });
                    break;
                case 'memory_write':
                    result = await toolMemoryWrite(memoryRootOf(this.dataDir, active.projectId), { path: String(args.path ?? ''), content: typeof args.content === 'string' ? args.content : '', expectedHash: typeof args.expected_hash === 'string' && args.expected_hash ? args.expected_hash : null });
                    await updateMemoryIndex(memoryRootOf(this.dataDir,active.projectId),String(args.path??''));
                    break;
                case 'memory_delete':
                    result = await toolMemoryDelete(memoryRootOf(this.dataDir, active.projectId), { path: String(args.path ?? ''), expectedHash: typeof args.expected_hash === 'string' ? args.expected_hash : '' });
                    await updateMemoryIndex(memoryRootOf(this.dataDir,active.projectId),String(args.path??''),true);
                    break;
                case 'agent': {
                    // 子代理会话在runner内运行（受限只读工具）；监督器经exec通道下发，子工具调用回流本门禁
                    const execChannel = active.execChannel;
                    if (!execChannel) throw new ApiError('SANDBOX_UNAVAILABLE', '执行通道未就绪');
                    if(!active.subagentConfig.enabled)throw new ApiError('POLICY_DENIED','当前任务已关闭子代理');
                    const subTimeoutMs = active.subagentConfig.timeoutSeconds * 1000;
                    const frame = await execChannel.request('run_subagent', { invocationId, prompt: String(args.prompt ?? ''), timeoutMs: subTimeoutMs }, subTimeoutMs + 15_000);
                    result = frame.payload;
                    break;
                }
                default:
                    // MCP桥接工具（mcp__<server>__<tool>）：监督器侧可信进程转发，不进沙箱
                    if (spec.name.startsWith('mcp__')) {
                        result = await callQualifiedMcpTool(this.db, active.userId || this.ownerOfRun(active.runId), spec.name, args, active.mcpTools.find(t=>t.qualifiedName===spec.name));
                        break;
                    }
                    throw new ApiError('POLICY_DENIED', '工具未实现');
            }
            const now = new Date().toISOString();
            // 落库保形（工具详情/F04回放依赖exitCode、changeRecordId、stdout等顶层字段）；事件只带轻量预览，避免SSE膨胀
            if (spec.name === ASK_USER_QUESTION && (active.abort.signal.aborted || this.active.get(active.runId) !== active)) {
                this.db.db.prepare("UPDATE tool_invocations SET state='cancelled',error_code='RUN_NOT_ACTIVE',updated_at=? WHERE id=? AND state='claimed'").run(now, invocationId);
                respond(false, undefined, { code: 'RUN_NOT_ACTIVE', message: '任务已结束' }); return;
            }
            this.db.db.prepare(`UPDATE tool_invocations SET state='succeeded', result_json=?, updated_at=? WHERE id=? AND state='claimed'`)
                .run(JSON.stringify(summarizeResult(result)).slice(0, 100_000), now, invocationId);
            this.emit(active.runId, 'tool.completed', { invocationId, tool: spec.name, ok: true, durationMs: Date.now() - startedAt, summary: summarizeResult(result, true) }, 'public', active.attemptId);
            respond(true, { ok: true, result });
        }
        catch (error) {
            const now = new Date().toISOString();
            const code = error instanceof ApiError ? error.code : 'TOOL_FAILED';
            const message = error instanceof Error ? error.message.slice(0, 300) : '工具执行失败';
            this.db.db.prepare(`UPDATE tool_invocations SET state='failed', error_code=?, result_json=?, updated_at=? WHERE id=? AND state='claimed'`)
                .run(code, JSON.stringify({ error: message }), now, invocationId);
            this.emit(active.runId, 'tool.completed', { invocationId, tool: spec.name, ok: false, error: code, message }, 'public', active.attemptId);
            respond(false, undefined, { code, message });
        }
    }

    private grantOf(active: ActiveRun): GrantRow {
        return active.workspace;
    }

    private async handleCheckpointProposed(active: ActiveRun, raw: unknown): Promise<unknown> {
        const payload = raw as { preflightId?: string; summary?: string; tokensBefore?: number; tokensAfter?: number };
        const summaryText = typeof payload?.summary === 'string' ? payload.summary : '';
        if (!summaryText || summaryText.length>64000) throw new ApiError('VALIDATION_FAILED', '压缩摘要缺失或超长');
        const preflight=active.compactionPreflight;
        if(!preflight||preflight.id!==payload.preflightId) throw new ApiError('VALIDATION_FAILED','压缩来源未经预检或预检编号已失效');
        if(active.abort.signal.aborted||active.status!=='running'||this.hasPendingUserInput(active.conversationId)) throw new ApiError('REQUEST_IN_PROGRESS','压缩期间有新输入或取消，保留旧上下文');
        const run = this.db.db.prepare('SELECT conversation_id, status FROM runs WHERE id=?').get(active.runId) as { conversation_id: string; status: string };
        if (run.status !== 'running') throw new ApiError('ATTEMPT_NOT_ACTIVE', 'Run不在运行');
        const now = new Date().toISOString();
        const checkpointId = randomUUID();
        // 确认门禁：只有监督器写入confirmed的checkpoint才可用于下一模型请求（§9）
        this.db.tx(tx => {
            tx.prepare(`INSERT INTO context_checkpoints(id,run_id,attempt_id,conversation_id,preflight_id,summary_text,first_kept_entry_id,kept_entry_ids_json,source_seq,tokens_before,tokens_after,schema_version,prompt_version,policy_version,model_id,state,created_at,updated_at,confirmed_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'proposed',?,?,?)`)
                .run(checkpointId, active.runId, active.attemptId, run.conversation_id, preflight.id, summaryText.slice(0, 64_000),
                    String(preflight.manifest.firstKeptEntryId), JSON.stringify(preflight.manifest.keptIds),
                    preflight.sourceSeq, Number(payload.tokensBefore ?? 0), Number(payload.tokensAfter ?? 0),
                    'cp-v2', 'ordinary-v1', CURRENT_POLICY_VERSION, active.binding.modelId, now, now, null);
            tx.prepare('UPDATE context_checkpoints SET source_manifest_json=? WHERE id=?').run(JSON.stringify(preflight.manifest),checkpointId);

        });
        active.compactionPreflight=undefined;
        this.emit(active.runId, 'context.compaction.prepared', { checkpointId, tokensBefore: payload.tokensBefore ?? null, tokensAfter: payload.tokensAfter ?? null }, 'audit', active.attemptId);
        return { ok: true, checkpointId };
    }

    /** Queue at the next idle turn boundary; never spawns or interrupts tools. */
    compactRun(runId:string,userId:string): {accepted:true;queued:true;duplicate:boolean} {
        if(this.research.isResearch(runId))throw new ApiError('POLICY_DENIED','研究模式使用固定输入视图，不跨角色整理上下文');
        if(this.ownerOfRun(runId)!==userId) throw new ApiError('NOT_FOUND','任务不存在或无权访问');
        const run=this.db.db.prepare('SELECT status FROM runs WHERE id=?').get(runId) as {status:string}|undefined;
        const active=this.active.get(runId);
        if(!active||active.status!=='running'||!active.execChannel||!run||!['running','waiting_approval'].includes(run.status)||active.abort.signal.aborted) throw new ApiError('RUN_NOT_ACTIVE','仅活动任务可排队整理上下文；终态不会启动计费任务');
        const duplicate=!!active.compactQueued;
        if(!duplicate) {
            active.compactQueued=true;
            active.execChannel.notify('compact_session',{});
            this.emit(runId,'context.compaction.queued',{attemptId:active.attemptId},'public',active.attemptId);
        }
        return {accepted:true,queued:true,duplicate};
    }

    private async handleCompleteProposed(active: ActiveRun, raw: unknown, respond: (ok: boolean, payload?: unknown, error?: FrameError) => void): Promise<void> {
        if(this.research.isResearch(active.runId)){
            const latest=this.db.db.prepare('SELECT state FROM model_requests WHERE attempt_id=? ORDER BY rowid DESC LIMIT 1').get(active.attemptId) as {state:string}|undefined;
            const proposal=String((raw as {summary?:unknown})?.summary??'');
            let result;
            try{
                if(latest?.state!=='completed')throw new ApiError('DELIVERY_INVALID','研究阶段必须有成功的模型请求才能提交',{researchDelivery:{category:'phase_state',path:'model_request.state',message:'研究阶段必须有成功的模型请求才能提交',expected:'completed',hint:'等待模型请求成功后再提交完整JSON。',repairable:true}});
                result=this.research.complete(active.attemptId,proposal);
            }
            catch(error){
                if(error instanceof ApiError&&error.code==='DELIVERY_INVALID'){
                    const rejectionCount=(this.db.db.prepare("SELECT COUNT(*) n FROM run_events WHERE run_id=? AND attempt_id=? AND type='research.delivery.rejected'").get(active.runId,active.attemptId) as {n:number}).n;
                    const diagnostic=(error.details?.researchDelivery&&typeof error.details.researchDelivery==='object'?error.details.researchDelivery:{category:'field_shape',message:error.message,repairable:true}) as Record<string,unknown>;
                    const details={researchDelivery:{...diagnostic,repairAttempt:Math.min(rejectionCount+1,2),maxRepairs:2}};
                    this.emit(active.runId,'research.delivery.rejected',{code:error.code,message:error.message,details,proposal:proposal.slice(0,50000),truncated:proposal.length>50000},'owner',active.attemptId);
                    respond(false,undefined,{code:error.code,message:error.message,details});
                    return;
                }
                throw error;
            }
            active.status='finalizing';
            this.opts.tickets.revoke(active.attemptId);
            respond(true,{ok:true,...result});
            active.execChannel?.notify('shutdown',{});
            setTimeout(()=>this.cleanupProcessGroup(active,'SIGTERM'),3000).unref?.();
            return;
        }
        if(active.memoryScope) {respond(false,undefined,{code:'REQUEST_IN_PROGRESS',message:'记忆辅助流程尚未结束'});return;}
        if(this.userQuestions.hasPending(active.runId)) { respond(false,undefined,{code:'REQUEST_IN_PROGRESS',message:'仍有问题等待用户回答，不能提前完成任务'});return; }
        if(active.compactQueued) { respond(false,undefined,{code:'REQUEST_IN_PROGRESS',message:'已排队整理上下文，先完成安全边界处理'});return; }
        const payload = raw as { summary?: string; artifactIds?: string[];sourceAssistantMessageId?:string };
        const summary = String(payload?.summary ?? '').trim();
        const latestRequest = this.db.db.prepare("SELECT state FROM model_requests WHERE attempt_id=? AND request_kind NOT IN ('memory_recall','memory_extraction') ORDER BY created_at DESC,rowid DESC LIMIT 1").get(active.attemptId) as {state:string}|undefined;
        if (latestRequest?.state === 'failed' || latestRequest?.state === 'cancelled') { respond(false, undefined, {code:'PROVIDER_ERROR',message:'最后一次模型请求未成功，不能将任务标为完成'}); return; }
        if (!summary) {
            respond(false, undefined, { code: 'DELIVERY_INVALID', message: '最终答复缺失' });
            return;
        }
        // 迟到完成核对：存在未消费补充→拒绝完成，继续处理补充
        if (this.hasPendingUserInput(active.conversationId)) {
            respond(false, undefined, { code: 'DEFERRED_BY_USER_INPUT', message: '有新的用户补充等待处理，不能按旧目标完成' });
            return;
        }
        const queue=queueView(this.db,active.conversationId);
        if(!queue.paused&&queue.items.length){
            const item=queue.items[0]!;
            const accepted=this.steer(active.runId,this.ownerOfRun(active.runId),item.text,`queue:${item.id}`,item.attachmentIds);
            this.db.db.prepare("UPDATE conversation_queue SET state='dispatched',message_id=? WHERE id=?").run(accepted.messageId,item.id);
            respond(false,undefined,{code:'DEFERRED_BY_USER_INPUT',message:'继续处理下一条排队消息'});return;
        }
        const now = new Date().toISOString();
        const finalMessageId=randomUUID();
        const artifactIds = Array.isArray(payload?.artifactIds) ? payload!.artifactIds!.filter(id => typeof id === 'string') : [];
        try {
            this.db.tx(tx => {
                const run = tx.prepare('SELECT status, conversation_id FROM runs WHERE id=?').get(active.runId) as { status: string; conversation_id: string };
                if (run.status !== 'running') throw new ApiError('ATTEMPT_NOT_ACTIVE', 'Run不在运行');
                // 引用归属校验：产物必须属于本Run
                for (const artifactId of artifactIds) {
                    const row = tx.prepare('SELECT id FROM artifacts WHERE id=? AND run_id=?').get(artifactId, active.runId);
                    if (!row) throw new ApiError('DELIVERY_INVALID', `产物引用无效: ${artifactId.slice(0, 8)}`);
                }
                tx.prepare(`UPDATE attempts SET status='succeeded', updated_at=? WHERE id=?`).run(now, active.attemptId);
                tx.prepare(`UPDATE phase_tasks SET status='succeeded', updated_at=? WHERE id=(SELECT phase_task_id FROM attempts WHERE id=?)`).run(now, active.attemptId);
                const conv = tx.prepare('SELECT last_message_seq FROM conversations WHERE id=?').get(run.conversation_id) as { last_message_seq: number };
                const seq = conv.last_message_seq + 1;
                tx.prepare(`INSERT INTO messages(id,conversation_id,run_id,author_type,role_id,seq,visibility,state,content_json,created_at,updated_at)
                    VALUES (?,?,?, 'agent','ordinary',?, 'public','published', ?,?,?)`)
                    .run(finalMessageId, run.conversation_id, active.runId, seq, JSON.stringify({ text: summary, artifactIds, sourceAssistantMessageId:payload.sourceAssistantMessageId }), now, now);
                tx.prepare('UPDATE conversations SET last_message_seq=?, updated_at=? WHERE id=?').run(seq, now, run.conversation_id);
                tx.prepare(`UPDATE runs SET status='succeeded', ended_at=?, stop_reason='completed', updated_at=? WHERE id=?`).run(now, now, active.runId);
            });
            this.emit(active.runId, 'message.completed', { role: 'agent', messageId:finalMessageId, content:summary, summary: summary.slice(0, 100), artifactIds, sourceAssistantMessageId:payload.sourceAssistantMessageId }, 'public', active.attemptId);
            this.emit(active.runId, 'run.succeeded', {}, 'public');
            active.status = 'finalizing';
            respond(true, { ok: true });
            // 优雅关闭runner
            active.execChannel?.notify('shutdown', {});
            setTimeout(() => this.cleanupProcessGroup(active, 'SIGTERM'), 3_000).unref?.();
        }
        catch (error) {
            if (error instanceof ApiError) respond(false, undefined, { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
            else respond(false, undefined, { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message.slice(0, 200) : '内部错误' });
        }
    }

    private phaseTaskIdOf(attemptId: string): string {
        const row = this.db.db.prepare('SELECT phase_task_id FROM attempts WHERE id=?').get(attemptId) as { phase_task_id: string } | undefined;
        return row?.phase_task_id ?? '';
    }

    private ownerOfRun(runId: string): string {
        const row = this.db.db.prepare('SELECT owner_user_id FROM projects p JOIN runs r ON r.project_id=p.id WHERE r.id=?').get(runId) as { owner_user_id: string } | undefined;
        return row?.owner_user_id ?? '';
    }

    /** 本attempt快照内的MCP工具spec：readOnlyHint→read；未声明视为外部副作用（external，D49逐次审批）。 */
    private mcpSpecFor(active: ActiveRun, qualifiedName: string): ToolSpec | undefined {
        const tool = active.mcpTools.find(t => t.qualifiedName === qualifiedName);
        if (!tool) return undefined;
        return {
            name: tool.qualifiedName,
            description: tool.description || `MCP工具 ${tool.serverName}/${tool.toolName}`,
            parameters: tool.inputSchema,
            effect: tool.readOnly ? 'read' : 'external',
            highImpact: () => true,
        };
    }

    // —— 补充（steering） ——

    /** 持久化补充消息→通知runner。consumption由后续model_request的includedInRequest游标确认。
     * F06幂等：相同clientMessageId视为同一补充——返回既有messageId，不重复入队、不二次通知。
     * 研究run：target透传为异议目标（缺省普通补充），幂等同时核对原文与规范化目标。 */
    steer(runId: string, userId: string, text: string, clientMessageId: string | null, attachmentIds: string[] = [], target?: unknown): { messageId: string; duplicate: boolean } {
        if(this.research.isResearch(runId)){this.research.owned(runId,userId);if(attachmentIds.length)throw new ApiError('VALIDATION_FAILED','研究补充目前仅支持文字');return this.research.supplement(runId,text,clientMessageId,target);}
        const active = this.active.get(runId);
        const conv = this.db.db.prepare('SELECT c.id, c.last_message_seq FROM conversations c JOIN runs r ON r.conversation_id=c.id JOIN projects p ON p.id=c.project_id WHERE r.id=? AND p.owner_user_id=?').get(runId, userId) as { id: string; last_message_seq: number } | undefined;
        if (!conv) throw new ApiError('NOT_FOUND', '任务不存在或无权访问');
        if (clientMessageId) {
            const existing = this.db.db.prepare('SELECT id FROM messages WHERE conversation_id=? AND client_message_id=?').get(conv.id, clientMessageId) as { id: string } | undefined;
            if (existing) return { messageId: existing.id, duplicate: true };
        }
        // 块E2：附件按归属装载（任一缺失/非本人整体拒绝）；库内只存元数据，base64仅随执行载荷下发
        const ids = normalizeAttachmentIds(attachmentIds);
        if(ids.length&&active&&!resolveVisionSupport(active.binding.protocol??'openai-completions',active.binding.baseUrl,active.binding.modelId,active.binding.parameters?.advanced))throw new ApiError('VALIDATION_FAILED','当前模型不支持图片输入，请更换模型或移除图片');
        const loaded=ids.length?loadAttachmentImages(this.db,userId,ids):undefined;
        const attachments=loaded?.rows.map(attachmentView),images=loaded?.images;
        const now = new Date().toISOString();
        const messageId = randomUUID();
        const seq = conv.last_message_seq + 1;
        if(active?.execChannel&&active.status==='running'){
            try{encodeFrame({v:1,channel:'exec',method:'steer',payload:{messageId,text,clientMessageId,seq,images}});}
            catch{throw new ApiError('INPUT_TOO_LARGE','本次补充和图片超过传输上限，请缩小图片或分批发送；消息尚未接收');}
        }
        this.db.tx(tx => {
            tx.prepare(`INSERT INTO messages(id,conversation_id,run_id,author_type,role_id,client_message_id,seq,visibility,state,content_json,created_at,updated_at)
                VALUES (?,?,?, 'user','ordinary',?,?, 'public','published', ?,?,?)`)
                .run(messageId, conv.id, runId, clientMessageId, seq, JSON.stringify(attachments ? { text, attachments } : { text }), now, now);
            tx.prepare('UPDATE conversations SET last_message_seq=?, updated_at=? WHERE id=?').run(seq, now, conv.id);
        });
        this.emit(runId, 'message.accepted', { messageId, clientMessageId, seq, queued: !!active }, 'public');
        if (active?.execChannel && active.status === 'running') {
            // seq随载荷下发（F06）：runner按messageId幂等去重，避免重连/重放时同一补充被二次投递
            active.execChannel.notify('steer', { messageId, text, clientMessageId, seq, images });
        }
        return { messageId, duplicate: false };
    }

    // —— 取消 ——

    async cancelRun(runId: string, reason: string): Promise<boolean> {
        this.cancelAutoRetry(runId);
        const active = this.active.get(runId);
        const run = this.db.db.prepare('SELECT status FROM runs WHERE id=?').get(runId) as { status: string } | undefined;
        if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return false;
        if (run.status === 'cancelling') return true;
        const now = new Date().toISOString();
        this.db.db.prepare(`UPDATE runs SET status='cancelling', cancel_requested_at=?, updated_at=? WHERE id=? AND status NOT IN ('succeeded','failed','cancelled')`).run(now, now, runId);
        if(active){this.memoryLifecycle.cancel(active.attemptId);active.memoryScope=undefined;}
        this.userQuestions.cancelRun(runId, reason);
        this.emit(runId, 'run.cancelling', { reason: reason.slice(0, 100) }, 'audit');
        if (!active) {
            // 无活动worker（created/waiting_input）：直接终态
            this.db.db.prepare(`UPDATE runs SET status='cancelled', ended_at=?, stop_reason=?, updated_at=? WHERE id=?`).run(now, reason.slice(0, 60), now, runId);
            this.emit(runId, 'run.cancelled', {}, 'public');
            return true;
        }
        active.status = 'cancelling';
        this.db.db.prepare("UPDATE context_checkpoints SET state='rejected',updated_at=? WHERE attempt_id=? AND state='proposed'").run(now,active.attemptId);
        active.compactQueued=false;
        // 撤票据→网关在途流终止；登记未终结模型请求取消
        this.opts.tickets.revoke(active.attemptId);
        this.opts.registry.cancelInflight(active.attemptId);
        active.abort.abort();
        active.execChannel?.notify('abort_session', { reason: reason.slice(0, 100) });
        // 分层清理：5s宽限→SIGTERM进程组→5s→SIGKILL
        active.cancelTimer = setTimeout(() => this.cleanupProcessGroup(active, 'SIGTERM'), 5_000);
        active.cancelTimer.unref?.();
        // 15s仍不确定→needs_reconciliation（由exit回调判定）。
        // 按attempt匹配：若本轮已终结又被原地重试，新attempt的active不应被旧定时器误判。
        const cancellingAttemptId = active.attemptId;
        setTimeout(() => {
            const still = this.active.get(runId);
            if (still && still.attemptId === cancellingAttemptId && still.status === 'cancelling') {
                this.db.db.prepare(`UPDATE runs SET status='needs_reconciliation', updated_at=? WHERE id=? AND status='cancelling'`).run(new Date().toISOString(), runId);
                this.emit(runId, 'run.needs_reconciliation', { reason: 'CANCEL_UNCONFIRMED' }, 'public');
            }
        }, 15_000).unref?.();
        return true;
    }

    private cleanupProcessGroup(active: ActiveRun, signal: NodeJS.Signals): void {
        const pid = active.proc?.pid;
        if (!pid) return;
        if (!terminateProcessTree(pid, signal)) {
            active.cleanupFailed = true;
            this.emit(active.runId, 'runner.cleanup_failed', { pid, signal, message: '进程树清理未确认，请核对残留进程与副作用' }, 'audit', active.attemptId);
        }
        if (signal === 'SIGTERM' && process.platform !== 'win32') {
            setTimeout(() => { terminateProcessTree(pid, 'SIGKILL'); }, 5_000).unref?.();
        }
        // SIGKILL升格时runner的退出钩子无法执行：按登记文件清扫其bash孙进程组（身份核对防误杀）。
        if (signal === 'SIGKILL') this.sweepRunnerGroups(active.attemptId, active.runId, 'runner_sigkill_escalation');
    }

    private onRunnerExit(active: ActiveRun, code: number | null, signal: string | null, stderrTail: string): void {
        const runId = active.runId;
        this.memoryLifecycle.cancel(active.attemptId);
        if (this.active.get(runId) === active) this.userQuestions.cancelRun(runId, 'RUNNER_EXITED');
        if(this.active.get(runId)===active)this.active.delete(runId);
        this.bindingByAttempt.delete(active.attemptId);
        if (active.cancelTimer) clearTimeout(active.cancelTimer);
        const now = new Date().toISOString();
        const run = this.db.db.prepare('SELECT status FROM runs WHERE id=?').get(runId) as { status: string };
        this.db.db.prepare(`UPDATE worker_instances SET state='stopped', stopped_at=?, updated_at=? WHERE attempt_id=?`).run(now, now, active.attemptId);
        if (active.status === 'cancelling' || run.status === 'cancelling') {
            if (active.cleanupFailed) {
                this.db.db.prepare(`UPDATE runs SET status='needs_reconciliation', updated_at=? WHERE id=?`).run(now, runId);
                this.emit(runId, 'run.needs_reconciliation', { reason: 'PROCESS_CLEANUP_FAILED' }, 'public');
                return;
            }
            // 确认清理后cancelled；后代未清时已由cleanupProcessGroup整组处理
            this.db.db.prepare(`UPDATE runs SET status='cancelled', ended_at=?, stop_reason='user_requested', updated_at=? WHERE id=? AND status='cancelling'`).run(now, now, runId);
            this.db.db.prepare(`UPDATE attempts SET status='cancelled', updated_at=? WHERE id=? AND status IN ('running','pending')`).run(now, active.attemptId);
            this.emit(runId, 'run.cancelled', {}, 'public');
            return;
        }
        if(this.research.isResearch(runId)&&active.status==='finalizing'&&run.status==='created'&&!this.stopping){
            this.research.launchNext(runId,active.sessionId);return;
        }
        if (run.status === 'running') {
            // runner异常退出：attempt失败；Run按失败终结（成功阶段不重放，由resume/retry走新attempt）
            this.failRunningRun(runId, active.attemptId, 'RUNNER_EXITED', { signal, exitCode: code, stderr: stderrTail.slice(0, 300) });
            return;
        }
        // waiting_approval下runner退出（含审批15分钟未处理的必然路径）：此前无分支处理，
        // run永久停留waiting_approval且后续「批准」返回200却静默失效。按未确认写入分流终结。
        if (run.status === 'waiting_approval') {
            this.finalizeInterruptedRun(runId, active.attemptId, 'RUNNER_EXITED');
            this.emit(runId, 'run.failed', { error: 'RUNNER_EXITED', signal, exitCode: code, stderr: stderrTail.slice(0, 300) }, 'public');
        }
        // waiting_input保持等待语义（resume时ensurePreviousWorkerStopped兜底）；其余残留状态不在此改写。
    }

    /** 运行中attempt的结构化失败终结：attempt/阶段失败+run按给定code终结。
     * 两个调用方：onRunnerExit（进程异常退出，RUNNER_EXITED）与run_failed帧
     * （runner经pi分类器归因的模型错误，code如PROVIDER_ERROR/CREDENTIAL_REQUIRED）。
     * SQL带status='running'守卫：run已取消/终结时no-op。 */
    private failRunningRun(runId: string, attemptId: string, code: string, extra: Record<string, unknown> = {}): void {
        const now = new Date().toISOString();
        this.db.db.prepare(`UPDATE attempts SET status='failed', error_code=?, updated_at=? WHERE id=? AND status='running'`).run(code, now, attemptId);
        this.db.db.prepare(`UPDATE phase_tasks SET status='failed', updated_at=? WHERE id=(SELECT phase_task_id FROM attempts WHERE id=?) AND status='running'`).run(now, attemptId);
        const claimed = this.db.db.prepare(`UPDATE runs SET status='failed', ended_at=?, stop_reason=?, updated_at=? WHERE id=? AND status='running'`).run(now, code, now, runId);
        this.emit(runId, 'run.failed', { error: code, ...extra }, 'public');
        // 仅真实running→failed迁移才排期：no-op调用（run已终结）不重复排期
        if (claimed.changes === 1 && extra.retryable !== false) this.scheduleAutoRetry(runId, attemptId, code);
    }

    /** 自动重试间隔（ms）：PRISM_AUTO_RETRY_DELAYS_MS逗号分隔可覆盖（测试调短）。 */
    private autoRetryDelays(): number[] {
        const raw = process.env.PRISM_AUTO_RETRY_DELAYS_MS;
        const parsed = raw ? raw.split(',').map(v => Number(v)).filter(v => Number.isFinite(v) && v >= 0) : [];
        return parsed.length ? parsed : [2_000, 8_000];
    }

    /** L2排期：次数凭run_events台账（source='supervisor'）持久计数，服务重启不丢；退避等半抖动防惊群。
     *  研究run同样纳入（2026-11-24放开）：仅白名单瞬态码（超时/传输错误）触发，fireAutoRetry经
     *  retryFailedRun已分流到research.retry（只重跑失败phase、单主让位、状态漂移静默放弃）；
     *  CREDENTIAL/quota/预算/DELIVERY等不可自愈类本就不在码白名单，陪审卡死教训不重演。 */
    private scheduleAutoRetry(runId: string, fromAttemptId: string, code: string): void {
        if (this.stopping || !Supervisor.AUTO_RETRY_CODES.has(code)) return;
        const prior = this.db.db.prepare(`SELECT COUNT(*) AS n FROM run_events WHERE run_id=? AND type='run.retry_scheduled' AND json_extract(payload_json,'$.source')='supervisor'`).get(runId) as { n: number };
        if (prior.n >= Supervisor.AUTO_RETRY_MAX) return;
        const retry = prior.n + 1;
        const delays = this.autoRetryDelays();
        const cap = delays[Math.min(prior.n, delays.length - 1)] ?? delays.at(-1) ?? 2_000;
        const delayMs = Math.round(cap / 2 + Math.random() * cap / 2);
        this.emit(runId, 'run.retry_scheduled', { source: 'supervisor', retry, maxRetries: Supervisor.AUTO_RETRY_MAX, delayMs, errorCode: code }, 'public');
        const timer = setTimeout(() => { this.autoRetryTimers.delete(runId); void this.fireAutoRetry(runId, fromAttemptId, retry, code); }, delayMs);
        timer.unref?.();
        this.autoRetryTimers.set(runId, { timer, fromAttemptId });
    }

    /** 自动重建开火：重验单主规则——run仍以同一code失败且最新attempt未变；用户已手动重试/停止/会话有后续则静默放弃。
     * 重建未成（对账/凭据/配置/worker未清）时run保持failed，手动重试仍可用，不级联事件。 */
    private async fireAutoRetry(runId: string, fromAttemptId: string, retry: number, code: string): Promise<void> {
        if (this.stopping) return;
        try {
            const run = this.db.db.prepare('SELECT status, stop_reason, config_snapshot_json FROM runs WHERE id=?').get(runId) as { status: string; stop_reason: string | null; config_snapshot_json: string } | undefined;
            if (!run || run.status !== 'failed' || run.stop_reason !== code) return;
            const attempt = this.db.db.prepare(`SELECT a.id FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=? ORDER BY a.number DESC LIMIT 1`).get(runId) as { id: string } | undefined;
            if (!attempt || attempt.id !== fromAttemptId) return;
            const ownerId = this.db.db.prepare('SELECT p.owner_user_id AS id FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.id=?').get(runId) as { id: string };
            const snapshot = JSON.parse(run.config_snapshot_json) as RunConfigSnapshot;
            await this.retryFailedRun(runId, ownerId.id, snapshot.sessionRef, fromAttemptId);
            if (!this.stopping) this.emit(runId, 'run.retry_finished', { source: 'supervisor', success: true, retry }, 'public');
        }
        catch { /* 重建未成：保持failed交给手动重试 */ }
    }

    /** 单主规则：手动重试/停止等用户交互取消排期中的自动重建。 */
    private cancelAutoRetry(runId: string): void {
        const pending = this.autoRetryTimers.get(runId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.autoRetryTimers.delete(runId);
    }

    /** 中断终终权威路径：attempt/阶段失败，未决审批与调用清理；有未确认写入→needs_reconciliation，否则failed可原地重试。 */
    private finalizeInterruptedRun(runId: string, attemptId: string, stopReason: string): void {
        const now = new Date().toISOString();
        this.db.db.prepare(`UPDATE attempts SET status='failed', error_code=?, updated_at=? WHERE id=? AND status IN ('running','pending')`).run(stopReason, now, attemptId);
        this.db.db.prepare(`UPDATE phase_tasks SET status='failed', updated_at=? WHERE id=(SELECT phase_task_id FROM attempts WHERE id=?) AND status='running'`).run(now, attemptId);
        // 先判未确认写入（claimed/unknown的非read效果）再清理：claimed调用无runner后永远不会有结果
        const unresolved = this.db.db.prepare(`SELECT id FROM tool_invocations WHERE run_id=? AND COALESCE(effect_kind,'unknown')<>'read' AND state IN ('claimed','unknown') LIMIT 1`).get(runId);
        this.db.db.prepare(`UPDATE approvals SET state='cancelled', cancellation_reason=?, updated_at=? WHERE state='pending' AND invocation_id IN (SELECT id FROM tool_invocations WHERE run_id=?)`).run(stopReason, now, runId);
        this.db.db.prepare(`UPDATE tool_invocations SET state='cancelled', error_code=?, updated_at=? WHERE run_id=? AND state IN ('awaiting_approval','claimed')`).run(stopReason, now, runId);
        if (unresolved) {
            this.db.db.prepare(`UPDATE runs SET status='needs_reconciliation', updated_at=? WHERE id=? AND status NOT IN ('succeeded','failed','cancelled')`).run(now, runId);
            this.emit(runId, 'run.needs_reconciliation', { reason: stopReason }, 'public');
        }
        else {
            this.db.db.prepare(`UPDATE runs SET status='failed', ended_at=?, stop_reason=?, updated_at=? WHERE id=? AND status NOT IN ('succeeded','failed','cancelled')`).run(now, stopReason, now, runId);
        }
    }

    private async failRun(runId: string, code: string): Promise<void> {
        const now = new Date().toISOString();
        this.db.db.prepare(`UPDATE runs SET status='failed', ended_at=?, stop_reason=?, updated_at=? WHERE id=? AND status='running'`).run(now, code, now, runId);
        this.emit(runId, 'run.failed', { error: code }, 'public');
        const active = this.active.get(runId);
        if (active) await this.cancelRun(runId, code);
    }

    /** 凭据变化（vault清除/登出/配置停用改端点）：受影响attempt的请求中断→Run等待输入（§7）。 */
    onCredentialChanged(input: { sessionId?: string; configId?: string }): void {
        for (const active of this.active.values()) {
            const match = (input.sessionId === undefined || active.sessionId === input.sessionId)
                && (input.configId === undefined || active.binding.configId === input.configId);
            if (!match) continue;
            const run = this.db.db.prepare('SELECT status FROM runs WHERE id=?').get(active.runId) as { status: string };
            if (run.status !== 'running') continue;
            this.memoryLifecycle.cancel(active.attemptId);active.memoryScope=undefined;
            this.userQuestions.cancelRun(active.runId, 'CREDENTIAL_REQUIRED');
            const now = new Date().toISOString();
            this.opts.registry.cancelInflight(active.attemptId);
            this.opts.tickets.revoke(active.attemptId);
            active.abort.abort();
            active.execChannel?.notify('abort_session', { reason: 'CREDENTIAL_REQUIRED' });
            this.cleanupProcessGroup(active, 'SIGTERM');
            this.db.db.prepare(`UPDATE attempts SET status='failed', error_code='CREDENTIAL_REQUIRED', updated_at=? WHERE id=? AND status='running'`).run(now, active.attemptId);
            this.db.db.prepare(`UPDATE runs SET status='waiting_input', stop_reason='CREDENTIAL_REQUIRED', updated_at=? WHERE id=?`).run(now, active.runId);
            this.emit(active.runId, 'run.waiting_input', { reason: 'CREDENTIAL_REQUIRED' }, 'public');
            this.active.delete(active.runId);
        }
    }

    private async ensurePreviousWorkerStopped(runId: string): Promise<void> {
        if (this.active.has(runId)) throw new ApiError('RUN_STILL_ACTIVE', '旧worker仍在运行，请稍后重试');
        const staleBefore = new Date(Date.now() - HEARTBEAT_STALE_MS).toISOString();
        for (let i = 0; i < 6; i++) {
            if (this.stopping) throw new ApiError('RUN_NOT_ACTIVE', '应用正在退出');
            const staleRows = this.db.db.prepare(`SELECT wi.id FROM worker_instances wi
                JOIN attempts a ON a.id=wi.attempt_id JOIN phase_tasks pt ON pt.id=a.phase_task_id
                WHERE pt.run_id=? AND wi.state='running' AND (wi.heartbeat_at IS NULL OR wi.heartbeat_at < ?)`).all(runId, staleBefore) as unknown as Array<{ id: string }>;
            for (const row of staleRows) {
                this.db.db.prepare(`UPDATE worker_instances SET state='lost', updated_at=? WHERE id=? AND state='running'`).run(new Date().toISOString(), row.id);
            }
            const liveRows = this.db.db.prepare(`SELECT wi.id FROM worker_instances wi
                JOIN attempts a ON a.id=wi.attempt_id JOIN phase_tasks pt ON pt.id=a.phase_task_id
                WHERE pt.run_id=? AND wi.state='running'`).all(runId) as unknown as Array<{ id: string }>;
            if (!liveRows.length) break;
            if (i === 5) throw new ApiError('WORKER_NOT_CLEANED', '旧worker尚未清理确认，请稍后重试');
            await new Promise(r => setTimeout(r, 400));
        }
    }

    /** Retry a failed latest turn in place: same Run/conversation, fresh attempt and existing effect ledger. */
    /** 阶段④续聊：研究会话的普通run携带预算受控的研究上下文——议题、最终摘要、关键决策、
     *  证据状态、限制与来源引用；正文在面板按需查阅，此处只做精简注入（≤4000字符）。 */
    private researchConversationDigest(conversationId: string): string | undefined {
        const research = this.db.db.prepare(`SELECT r.id FROM runs r JOIN research_runs rr ON rr.run_id=r.id WHERE r.conversation_id=? AND r.status='succeeded' AND rr.report_json IS NOT NULL ORDER BY r.created_at DESC,r.id DESC LIMIT 1`).get(conversationId) as { id: string } | undefined;
        if (!research) return undefined;
        const report = this.research.report(research.id);
        if (!report) return undefined;
        const objectiveRow = this.db.db.prepare('SELECT objective FROM problem_versions WHERE id=(SELECT problem_version_id FROM runs WHERE id=?)').get(research.id) as { objective: string } | undefined;
        const parts: string[] = [`研究议题：${(objectiveRow?.objective ?? '').slice(0, 500)}`];
        parts.push(report.summary ? `最终摘要：${report.summary}` : `结论摘录：${report.text.slice(0, 800)}`);
        const v2 = report as typeof report & { majority?: { key: string; count: number } | null; disposition?: Record<string, unknown>; decision?: Record<string, unknown>; blockingItems?: Array<{ criterionId: string; reason: string }>; nextSteps?: string[] };
        if (v2.disposition) parts.push(`研究处置：${JSON.stringify(v2.disposition).slice(0, 600)}`);
        if (v2.decision) parts.push(`决策依据：${JSON.stringify(v2.decision).slice(0, 400)}`);
        if (v2.majority) parts.push(`陪审多数判定：${v2.majority.key}（${v2.majority.count}票）`);
        if (v2.blockingItems?.length) parts.push(`阻断项：${v2.blockingItems.map(item => `${item.criterionId} ${item.reason}`.trim()).slice(0, 5).join('；')}`);
        if (v2.nextSteps?.length) parts.push(`下一步：${v2.nextSteps.slice(0, 5).join('；')}`);
        parts.push(`证据状态：${report.evidenceStatus === 'cited' ? '结论均带原文引证' : '证据不足，未完成事实核查'}`);
        if (report.limitations.length) parts.push(`限制：${report.limitations.slice(0, 5).join('；')}`);
        const sources = this.db.db.prepare(`SELECT title FROM research_records WHERE run_id=? AND kind='source' ORDER BY rowid LIMIT 5`).all(research.id) as Array<{ title: string }>;
        const sourceCount = (this.db.db.prepare(`SELECT COUNT(*) AS n FROM research_records WHERE run_id=? AND kind='source'`).get(research.id) as { n: number }).n;
        if (sourceCount) parts.push(`来源（${sourceCount}份）：${sources.map(source => source.title).join('、')}${sourceCount > sources.length ? '等' : ''}`);
        const text = parts.join('\n');
        return text.length > 4000 ? text.slice(0, 4000) : text;
    }

    async retryFailedRun(runId: string, userId: string, sessionId: string, fromAttemptId: string, regenerate = false): Promise<{attemptId:string}> {
        if (this.stopping) throw new ApiError('RUN_NOT_ACTIVE', '应用正在退出');
        this.cancelAutoRetry(runId);
        if(this.research.isResearch(runId)){
            if(regenerate)throw new ApiError('POLICY_DENIED','研究结果已锁定，请新建研究');
            // 阶段④：普通续聊与研究重试同一互斥口径——会话内其他活动run存在时统一CONVERSATION_BUSY
            const conversationId=(this.db.db.prepare('SELECT conversation_id FROM runs WHERE id=?').get(runId) as {conversation_id:string}|undefined)?.conversation_id;
            if(conversationId){
                const other=this.db.db.prepare(`SELECT id FROM runs WHERE conversation_id=? AND id<>? AND status NOT IN ('succeeded','failed','cancelled') LIMIT 1`).get(conversationId,runId) as {id:string}|undefined;
                if(other)throw new ApiError('CONVERSATION_BUSY','该会话已有进行中的任务');
            }
            for(let i=0;i<10&&this.active.has(runId);i++)await new Promise(r=>setTimeout(r,200));
            await this.ensurePreviousWorkerStopped(runId);
            if (this.stopping) throw new ApiError('RUN_NOT_ACTIVE', '应用正在退出');
            return this.research.retry(runId,userId,sessionId,fromAttemptId);
        }
        const run=this.db.db.prepare(`SELECT r.*,c.archived_at,p.archived_at AS project_archived,p.owner_user_id FROM runs r JOIN conversations c ON c.id=r.conversation_id JOIN projects p ON p.id=r.project_id WHERE r.id=?`).get(runId) as {id:string;status:string;conversation_id:string;project_id:string;config_snapshot_json:string;owner_user_id:string;archived_at:string|null;project_archived:string|null}|undefined;
        if(!run||run.owner_user_id!==userId)throw new ApiError('NOT_FOUND','任务不存在或无权访问');
        if(run.archived_at||run.project_archived)throw new ApiError('RUN_NOT_RESUMABLE','请先恢复已归档的任务或项目');
        const prior=this.db.db.prepare(`SELECT payload_json FROM run_events WHERE run_id=? AND type='run.retried' AND json_extract(payload_json,'$.fromAttemptId')=? ORDER BY seq DESC LIMIT 1`).get(runId,fromAttemptId) as {payload_json:string}|undefined;
        if(prior)return {attemptId:String(JSON.parse(prior.payload_json).attemptId)};
        if(!(regenerate?['succeeded']:['failed','cancelled']).includes(run.status))throw new ApiError('RUN_NOT_RESUMABLE',regenerate?'只能重新回答已完成的最新一轮':'只能重试已失败或已停止的最新一轮');
        const latestRun=this.db.db.prepare('SELECT id FROM runs WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(run.conversation_id) as {id:string};
        if(latestRun.id!==runId)throw new ApiError('RUN_NOT_RESUMABLE','会话已有后续内容，请在最新一轮继续');
        const attempt=this.db.db.prepare(`SELECT a.id,a.number,a.phase_task_id FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=? ORDER BY a.number DESC LIMIT 1`).get(runId) as {id:string;number:number;phase_task_id:string}|undefined;
        if(!attempt||attempt.id!==fromAttemptId)throw new ApiError('WAIT_STATE_CHANGED','本轮执行状态已变化，请刷新后重试');
        const snapshot=JSON.parse(run.config_snapshot_json) as RunConfigSnapshot;
        if(snapshot.policyVersion!==CURRENT_POLICY_VERSION)throw new ApiError('CONFIG_CHANGED','任务策略版本已变化，无法直接重试');
        const config=this.freezeModelConfig(sessionId,snapshot.modelConfigId,snapshot.modelId),grant=this.activeGrantOf(run.project_id);
        for(let i=0;i<6&&this.active.has(runId);i++)await new Promise(r=>setTimeout(r,200));
        await this.ensurePreviousWorkerStopped(runId);
        if (this.stopping) throw new ApiError('RUN_NOT_ACTIVE', '应用正在退出');
        const unknown=this.db.db.prepare(`SELECT id FROM tool_invocations WHERE run_id=? AND COALESCE(effect_kind,'unknown')<>'read' AND state IN ('claimed','unknown') LIMIT 1`).get(runId);
        if(unknown)throw new ApiError('RECONCILIATION_REQUIRED','上次有执行结果未确认的修改或命令，请先核对执行结果，再继续任务');
        const now=new Date().toISOString(),attemptId=randomUUID();
        const nextSnapshot:RunConfigSnapshot={...snapshot,regenerateAnswer:regenerate||snapshot.regenerateAnswer===true,sessionRef:sessionId,protocol:config.protocol,modelDisplayName:config.displayName,baseUrl:config.baseUrl,providerPreset:config.preset,configRevision:config.revision,parameters:config.parameters,contextWindow:config.contextWindow,maxOutputTokens:config.maxOutputTokens};
        this.db.tx(tx=>{
            const newest=tx.prepare('SELECT id FROM runs WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(run.conversation_id) as {id:string};
            if(newest.id!==runId)throw new ApiError('RUN_NOT_RESUMABLE','会话已有后续内容，请在最新一轮继续');
            const archived=tx.prepare('SELECT c.archived_at AS task,p.archived_at AS project FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=?').get(run.conversation_id) as {task:string|null;project:string|null};
            if(archived.task||archived.project)throw new ApiError('RUN_NOT_RESUMABLE','请先恢复已归档的任务或项目');
            const latest=tx.prepare('SELECT id FROM attempts WHERE phase_task_id=? ORDER BY number DESC LIMIT 1').get(attempt.phase_task_id) as {id:string};
            if(latest.id!==fromAttemptId)throw new ApiError('WAIT_STATE_CHANGED','本轮已被重试，请等待结果');
            const claimed=tx.prepare(`UPDATE runs SET status='created',cancel_requested_at=NULL,ended_at=NULL,stop_reason=NULL,config_snapshot_json=?,updated_at=? WHERE id=? AND status=?`).run(JSON.stringify(nextSnapshot),now,runId,run.status);
            if(claimed.changes!==1)throw new ApiError('WAIT_STATE_CHANGED','本轮状态已变化，请刷新后重试');
            tx.prepare(`UPDATE context_checkpoints SET state='rejected',updated_at=? WHERE run_id=? AND state='proposed'`).run(now,runId);
            tx.prepare(`UPDATE approvals SET state='cancelled',cancellation_reason='TASK_RETRY' WHERE invocation_id IN (SELECT id FROM tool_invocations WHERE run_id=?) AND state IN ('pending','approved')`).run(runId);
            tx.prepare(`UPDATE tool_invocations SET state='cancelled',error_code='INTERRUPTED_RETRY',updated_at=? WHERE run_id=? AND state IN ('proposed','awaiting_approval','claimed')`).run(now,runId);
            // 分叉式重答（D86）：重新回答时把本Run旧attempt的agent答复墓碑化——行保留可审计、不删行；
            // 上下文清单/消息API/时间线投影均只读published，剥离自动生效；user目标与补充消息保留。
            if(regenerate)tx.prepare(`UPDATE messages SET state='abandoned',updated_at=? WHERE run_id=? AND author_type='agent' AND state='published'`).run(now,runId);
            tx.prepare(`INSERT INTO attempts(id,phase_task_id,number,status,created_at,updated_at) VALUES (?,?,?,'pending',?,?)`).run(attemptId,attempt.phase_task_id,attempt.number+1,now,now);
        });
        this.emit(runId,'run.retried',{attemptId,fromAttemptId,regenerate},'public');
        try{this.startAttempt(runId,attemptId,sessionId,config,grant,regenerate?'regenerate':'resume');}
        catch(error){
            this.db.db.prepare(`UPDATE attempts SET status='failed',error_code='RUNNER_SPAWN_FAILED',updated_at=? WHERE id=?`).run(now,attemptId);
            this.db.db.prepare(`UPDATE runs SET status='failed',ended_at=?,stop_reason='RUNNER_SPAWN_FAILED',updated_at=? WHERE id=?`).run(now,now,runId);
            this.emit(runId,'run.failed',{error:'RUNNER_SPAWN_FAILED'},'public');
            throw new ApiError('SANDBOX_UNAVAILABLE','重试启动失败，原任务和历史已保留');
        }
        return {attemptId};
    }

    /** waiting_input恢复：新session提供Key后显式重核→等待旧worker清理确认（unknown先reconcile）
     * →新建attempt（F04：从确认历史、checkpoint与本Run副作用账本恢复，重复resume幂等）。 */
    async resumeWaitingRun(runId: string, userId: string, sessionId: string, reasonVersion: string): Promise<{ attemptId: string }> {
        if(this.research.isResearch(runId)){
            const latest=this.db.db.prepare('SELECT a.id FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=? ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1').get(runId) as {id:string}|undefined;
            if(!latest)throw new ApiError('RUN_NOT_RESUMABLE','没有可恢复的研究阶段');
            await this.ensurePreviousWorkerStopped(runId);return this.research.retry(runId,userId,sessionId,latest.id);
        }
        const run = this.db.db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as { id: string; status: string; stop_reason: string | null; config_snapshot_json: string; project_id: string; conversation_id: string; updated_at: string } | undefined;
        if (!run) throw new ApiError('NOT_FOUND', '任务不存在');
        const project = this.db.db.prepare('SELECT owner_user_id FROM projects WHERE id=?').get(run.project_id) as { owner_user_id: string };
        if (project.owner_user_id !== userId) throw new ApiError('NOT_FOUND', '任务不存在或无权访问');
        // 仅waiting_input可恢复；needs_reconciliation（unknown）必须先走reconcile，不得直接resume（F04）
        if (run.status === 'needs_reconciliation') throw new ApiError('RUN_NOT_RESUMABLE', '任务状态未定（needs_reconciliation），请先等待系统对账');
        if (run.status !== 'waiting_input') throw new ApiError('RUN_NOT_RESUMABLE', '任务当前状态不可恢复');
        const expectedVersion = waitStateVersion(run);
        if (reasonVersion !== expectedVersion) throw new ApiError('WAIT_STATE_CHANGED', '等待原因已变化，请刷新后重试');
        const snapshot = JSON.parse(run.config_snapshot_json) as RunConfigSnapshot;
        // 核验冻结模型/配置/政策（F04）：任一变化不得带旧配置/旧政策恢复
        if (snapshot.policyVersion !== CURRENT_POLICY_VERSION) {
            throw new ApiError('CONFIG_CHANGED', '策略版本已更新，请新建任务');
        }
        this.db.db.prepare("UPDATE context_checkpoints SET state='rejected',updated_at=? WHERE run_id=? AND state='proposed'").run(new Date().toISOString(),runId);
        const config = this.freezeModelConfig(sessionId, snapshot.modelConfigId, snapshot.modelId);
        if(snapshot.parameters) Object.assign(config,snapshot.parameters.effective,{parameters:snapshot.parameters});
        if (config.revision !== snapshot.configRevision || config.baseUrl !== snapshot.baseUrl) {
            throw new ApiError('CONFIG_CHANGED', '模型配置已变化，请新建任务以使用新配置');
        }
        const grant = this.activeGrantOf(run.project_id);

        await this.ensurePreviousWorkerStopped(runId);

        // 新attempt（同phase_task续编号）
        const now = new Date().toISOString();
        const phaseTask = this.db.db.prepare('SELECT id FROM phase_tasks WHERE run_id=? AND phase_key=? LIMIT 1').get(runId, 'ordinary') as { id: string } | undefined;
        if (!phaseTask) throw new ApiError('NOT_FOUND', '任务阶段缺失');
        const attemptRow = this.db.db.prepare('SELECT id, number FROM attempts WHERE phase_task_id=? ORDER BY number DESC LIMIT 1').get(phaseTask.id) as { id: string; number: number } | undefined;
        const attemptId = randomUUID();
        this.db.tx(tx => {
            const claimed = tx.prepare(`UPDATE runs SET status='created', stop_reason=NULL, updated_at=?
                WHERE id=? AND status='waiting_input' AND updated_at=? AND stop_reason IS ?`)
                .run(now, runId, run.updated_at, run.stop_reason);
            if (claimed.changes !== 1) throw new ApiError('WAIT_STATE_CHANGED', '等待原因已变化，请刷新后重试');
            tx.prepare(`INSERT INTO attempts(id,phase_task_id,number,status,created_at,updated_at) VALUES (?,?,?,'pending',?,?)`)
                .run(attemptId, phaseTask.id, (attemptRow?.number ?? 0) + 1, now, now);
        });
        this.emit(runId, 'run.resumed', { attemptId, fromAttemptId: attemptRow?.id ?? null }, 'public');
        this.startAttempt(runId, attemptId, sessionId, config, grant, 'resume');
        return { attemptId };
    }

    /** 崩溃恢复：启动时对非终态Run核对（§7恢复表简化投影：无活动worker即失联）。
     * 有未确认写入（claimed/unknown的非read效果）→needs_reconciliation（人工核对，可停止后重试）；
     * 否则→failed+INTERRUPTED_RESTART（原地重试入口直接可用）。此前一律置needs_reconciliation
     * 且无任何转出路径，重启后所有中断任务连同会话一起卡死。 */
    recoverAtStartup(): void {
        this.userQuestions.recover();
        this.memoryLifecycle.recover();
        recoverMemoryLocks(this.dataDir);
        // 状态对账前先处理上一世遗留的runner进程：按身份击杀+清扫其命令进程组（状态面随后照常对账）。
        this.killStaleWorkersAtStartup(new Date().toISOString());
        const now = new Date().toISOString();
        const rows = this.db.db.prepare(`SELECT id, status FROM runs WHERE status NOT IN ('succeeded','failed','cancelled')`).all() as unknown as Array<{ id: string; status: string }>;
        for (const row of rows) {
            this.db.db.prepare("UPDATE context_checkpoints SET state='rejected',updated_at=? WHERE run_id=? AND state='proposed'").run(now,row.id);
            if (row.status === 'waiting_input') continue;
            const unresolved = this.db.db.prepare(`SELECT id FROM tool_invocations WHERE run_id=? AND COALESCE(effect_kind,'unknown')<>'read' AND state IN ('claimed','unknown') LIMIT 1`).get(row.id);
            this.db.db.prepare(`UPDATE attempts SET status='failed', error_code='INTERRUPTED_RESTART', updated_at=? WHERE status IN ('running','pending') AND phase_task_id IN (SELECT id FROM phase_tasks WHERE run_id=?)`).run(now, row.id);
            this.db.db.prepare(`UPDATE phase_tasks SET status='failed', updated_at=? WHERE run_id=? AND status='running'`).run(now, row.id);
            this.db.db.prepare(`UPDATE approvals SET state='cancelled', cancellation_reason='INTERRUPTED_RESTART', updated_at=? WHERE state='pending' AND invocation_id IN (SELECT id FROM tool_invocations WHERE run_id=?)`).run(now, row.id);
            this.db.db.prepare(`UPDATE tool_invocations SET state='cancelled', error_code='INTERRUPTED_RESTART', updated_at=? WHERE run_id=? AND state IN ('awaiting_approval','claimed')`).run(now, row.id);
            if (unresolved) {
                this.db.db.prepare(`UPDATE runs SET status='needs_reconciliation', updated_at=? WHERE id=?`).run(now, row.id);
                this.emit(row.id, 'run.needs_reconciliation', { reason: 'INTERRUPTED_RESTART' }, 'public');
            }
            else {
                this.db.db.prepare(`UPDATE runs SET status='failed', ended_at=?, stop_reason='INTERRUPTED_RESTART', updated_at=? WHERE id=?`).run(now, now, row.id);
                this.emit(row.id, 'run.failed', { error: 'INTERRUPTED_RESTART' }, 'public');
            }
        }
    }

    private watchdog(): void {
        if (this.stopping) return;
        const staleBefore = new Date(Date.now() - HEARTBEAT_STALE_MS).toISOString();
        const stale = this.db.db.prepare(`SELECT wi.attempt_id, wi.id, pt.run_id FROM worker_instances wi JOIN attempts a ON a.id=wi.attempt_id JOIN phase_tasks pt ON pt.id=a.phase_task_id
            WHERE wi.state='running' AND (wi.heartbeat_at IS NULL OR wi.heartbeat_at < ?)`).all(staleBefore) as unknown as Array<{ attempt_id: string; id: string; run_id: string }>;
        for (const row of stale) {
            const active = this.active.get(row.run_id);
            if (active && active.nonceConfirmed) continue; // 有活动通道即正常
            this.db.db.prepare(`UPDATE worker_instances SET state='lost', updated_at=? WHERE id=? AND state='running'`).run(new Date().toISOString(), row.id);
            const run = this.db.db.prepare('SELECT status FROM runs WHERE id=?').get(row.run_id) as { status: string } | undefined;
            if (run?.status === 'running' && !active) {
                this.db.db.prepare(`UPDATE runs SET status='needs_reconciliation', updated_at=? WHERE id=?`).run(new Date().toISOString(), row.run_id);
                this.emit(row.run_id, 'run.needs_reconciliation', { reason: 'WORKER_HEARTBEAT_LOST' }, 'public');
            }
        }
    }

    private beginShutdown(): void {
        this.stopping = true;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        for (const { timer } of this.autoRetryTimers.values()) clearTimeout(timer);
        this.autoRetryTimers.clear();
    }

    /** 停机：撤票据、终止全部进程组。 */
    async stop(): Promise<void> {
        this.beginShutdown();
        for (const active of [...this.active.values()]) {
            this.memoryLifecycle.cancel(active.attemptId);
            this.userQuestions.cancelRun(active.runId, 'SHUTDOWN');
            this.opts.tickets.revoke(active.attemptId);
            this.opts.registry.cancelInflight(active.attemptId);
            active.abort.abort();
            active.execChannel?.notify('shutdown', {});
            this.cleanupProcessGroup(active, 'SIGTERM');
        }
        await new Promise(r => setTimeout(r, 1_000));
        for (const active of this.active.values()) this.cleanupProcessGroup(active, 'SIGKILL');
        this.active.clear();
    }
}

/** 参数脱敏（审计/公开事件不含完整文件内容或命令全文）。 */
function redactArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
        if (key === 'content' && typeof value === 'string') out[key] = `<${Buffer.byteLength(value, 'utf8')}字节>`;
        else if (key === 'command' && typeof value === 'string') out[key] = value.slice(0, 200);
        else out[key] = value;
    }
    out._tool = toolName;
    return out;
}

// 导出供测试断言（安全性质：图片base64不得写入result_json）
// compact=true时输出轻量预览（公开事件用）；默认保形截断——工具详情端点与F04回放依赖
// exitCode/stdout/changeRecordId/diffSummary等顶层结构字段，此前一律压成preview导致这些消费方拿不到数据。
export function summarizeResult(result: unknown, compact = false): Record<string, unknown> {
    if (result === null || result === undefined) return {};
    if (typeof result !== 'object') return { preview: String(result).slice(0, 200) };
    const r = result as Record<string, unknown>;
    if (compact) {
        if (typeof r.content === 'string') return { content: r.content.slice(0, 200), _truncated: r.content.length > 200 };
        if (typeof r.imageData === 'string') return { imageData: `<${Buffer.byteLength(r.imageData, 'utf8')}字节base64已省略>`, _imageElided: true };
        if (Array.isArray(r.matches)) return { matches: (r.matches as unknown[]).slice(0, 5), _total: (r.matches as unknown[]).length };
        return { preview: JSON.stringify(result).slice(0, 200) };
    }
    if (typeof r.imageData === 'string') {
        // read_image：只留元数据，防止base64正文写入result_json（100KB截断也挡不住语义混淆）
        return { ...r, imageData: `<${Buffer.byteLength(r.imageData, 'utf8')}字节base64已省略>`, _imageElided: true };
    }
    return truncateStructure(r, 0) as Record<string, unknown>;
}

const SUMMARY_TEXT_LIMIT = 4_000;
const SUMMARY_ARRAY_LIMIT = 10;

/** 深度受限的保形截断：长文本截断并标注，数组截尾计数；结构字段原样保留。 */
function truncateStructure(value: unknown, depth: number): unknown {
    if (typeof value === 'string') {
        return value.length > SUMMARY_TEXT_LIMIT ? `${value.slice(0, SUMMARY_TEXT_LIMIT)}…<截断${value.length - SUMMARY_TEXT_LIMIT}字符>` : value;
    }
    if (Array.isArray(value)) {
        const kept = value.slice(0, SUMMARY_ARRAY_LIMIT).map(item => truncateStructure(item, depth + 1));
        return value.length > SUMMARY_ARRAY_LIMIT ? [...kept, `<共${value.length}项，已截断>`] : kept;
    }
    if (value && typeof value === 'object') {
        if (depth >= 2) {
            const s = JSON.stringify(value) ?? '';
            return s.length > SUMMARY_TEXT_LIMIT ? `${s.slice(0, SUMMARY_TEXT_LIMIT)}…<截断>` : JSON.parse(s) as unknown;
        }
        const out: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(value)) {
            // 嵌套对象里混入的图片数据同样剥除（安全性质不因深度放宽）
            if (key === 'imageData' && typeof v === 'string' && v.length > 400) out[key] = `<${Buffer.byteLength(v, 'utf8')}字节base64已省略>`;
            else out[key] = truncateStructure(v, depth + 1);
        }
        return out;
    }
    return value;
}

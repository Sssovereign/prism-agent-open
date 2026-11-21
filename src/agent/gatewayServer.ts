import { thinkingPayloadHook } from '../models/advancedOptions.js';
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { streamSimple as streamOpenAI } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import type { FrozenModelParameters } from '../../contracts/models.js';
import type { ModelProtocol } from '../../contracts/v1.js';
import { normalizeContext, type Model, type AssistantMessage, type ThinkingContent } from '@earendil-works/pi-ai';
import { resolveVisionSupport, resolveThinkingCapability } from './modelCatalog.js';
import type { Db } from '../storage/db.js';
import { ProviderMeasurement } from './contextMeasurement.js';
import { ReasoningProjection } from './reasoningProjection.js';
import { ApiError } from '../../contracts/errors.js';
import { TicketRegistry } from './tickets.js';
import { ModelRequestRegistry, LIMITS } from './modelRequests.js';
import { parseChatRequest, encodeSseFromEvents, type ChatRequestBody } from './protocolAdapter.js';
import { streamingPinnedFetch, RUNTIME_STREAM_PROFILE, type StreamProfile } from '../models/streamNetwork.js';

/**
 * 可信模型网关（计划v1.6 §5）：POST /_runtime/v1/model/chat/completions。
 * 仅Bearer attempt票据+reservation头；不接受Cookie或上游URL。
 * 冻结模型配置（revision/端点/参数/contextWindow/maxOutput）来自Run快照；
 * Key按创建任务的session/config凭据引用查vault，不进快照、不进日志。
 * 真流式：收到供应商响应头立即向worker转发ReadableStream，逐chunk编码OpenAI SSE。
 */

export interface FrozenModelBinding {
    protocol?: ModelProtocol;
    parameters?: FrozenModelParameters;
    configId: string;
    sessionRef: string;      // 创建任务的app session id（凭据引用，不存Key）
    baseUrl: string;
    providerPreset: string;
    modelId: string;
    contextWindow: number | null;   // null＝目录未收录且未手填，窗口未知（D55 不猜）
    maxOutputTokens: number;
    configRevision: number;
    caCertPem?: string;      // 仅测试受控上游注入；生产不设置
}

export interface GatewayDeps {
    db: Db;
    tickets: TicketRegistry;
    registry: ModelRequestRegistry;
    vault: { get(sessionId: string, configId: string): string | undefined };
    /** Run冻结绑定（由监督器在创建attempt时写入内存索引；网关只读）。 */
    bindingOf(attemptId: string): FrozenModelBinding | undefined;
    /** attempt取消信号（撤票/取消Run时中止上游流）。 */
    abortOf(attemptId: string): AbortSignal | undefined;
    profile?: StreamProfile;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

interface Timing {
    startedAt: string;
    firstChunkAt: string | null;
    firstGenerationDeltaAt: string | null;
    firstTextAt: string | null;
    firstToolDeltaAt: string | null;
}

/** Opaque replay capability: raw provider signatures never cross the worker boundary. */
export class PrivateThinkingCache {
    private readonly entries = new Map<string, {scope:string;attemptId:string;blocks:ThinkingContent[];bytes:number}>();
    private bytes = 0;
    encode(attemptId:string,binding:FrozenModelBinding,final:AssistantMessage):unknown {
        const blocks=final.content.filter((block):block is ThinkingContent=>block.type==='thinking');
        if(!blocks.length)return undefined;
        const bytes=Buffer.byteLength(JSON.stringify(blocks));
        if(this.bytes+bytes>32*1024*1024)throw new ApiError('INPUT_TOO_LARGE','私有思考回放容量已满');
        const token=randomBytes(32).toString('base64url');
        this.entries.set(token,{scope:this.scope(attemptId,binding),attemptId,blocks:structuredClone(blocks),bytes});this.bytes+=bytes;
        return [{type:'reasoning.encrypted',format:'prism-private-v1',data:token}];
    }
    decode(attemptId:string,binding:FrozenModelBinding,details:unknown):ThinkingContent[] {
        if(!Array.isArray(details)||details.length!==1)throw new ApiError('PROTOCOL_INVALID','私有思考回放凭据无效');
        const item=details[0] as {type?:unknown;format?:unknown;data?:unknown}|null;
        if(!item||item.type!=='reasoning.encrypted'||item.format!=='prism-private-v1'||typeof item.data!=='string')throw new ApiError('PROTOCOL_INVALID','私有思考回放凭据无效');
        const entry=this.entries.get(item.data);
        if(!entry||entry.scope!==this.scope(attemptId,binding))throw new ApiError('PROTOCOL_INVALID','私有思考回放凭据无效或已过期');
        return structuredClone(entry.blocks);
    }
    clearAttempt(attemptId:string):void {for(const [key,value] of this.entries){if(value.attemptId===attemptId){this.bytes-=value.bytes;this.entries.delete(key);}}}
    clear():void {this.entries.clear();this.bytes=0;}
    attemptIds():string[] {return [...new Set([...this.entries.values()].map(entry=>entry.attemptId))];}
    private scope(attemptId:string,binding:FrozenModelBinding):string {return JSON.stringify([attemptId,binding.configId,binding.configRevision,binding.providerPreset,binding.baseUrl,binding.protocol??'openai-completions',binding.modelId]);}
}

export class ModelGatewayServer {
    readonly server: Server;
    port = 0;
    /** listen(0)为异步：端口就绪前调用baseUrl会抛出（生产在首个请求前早已就绪）。 */
    readonly ready: Promise<void>;
    private readonly inflight = new Map<string, () => void>(); // requestId → cleanup
    private readonly privateThinking = new PrivateThinkingCache();
    private readonly thinkingCleanup: ReturnType<typeof setInterval>;

    constructor(private readonly deps: GatewayDeps) {
        this.thinkingCleanup=setInterval(()=>{
            for(const id of this.privateThinking.attemptIds()){
                const row=this.deps.db.db.prepare('SELECT status FROM attempts WHERE id=?').get(id) as {status:string}|undefined;
                if(!row||row.status!=='running'||this.deps.abortOf(id)?.aborted)this.privateThinking.clearAttempt(id);
            }
        },1000);
        this.thinkingCleanup.unref();
        this.server = createServer((req, res) => { void this.handle(req, res); });
        this.server.on('error', () => { /* 端口关闭时静默；测试断言经请求路径 */ });
        this.ready = new Promise<void>((resolve, reject) => {
            this.server.once('listening', () => {
                this.port = (this.server.address() as { port: number }).port;
                resolve();
            });
            this.server.once('error', reject);
        });
        this.server.listen(0, '127.0.0.1');
    }

    get baseUrl(): string { return `http://127.0.0.1:${this.port}/_runtime/v1/model`; }

    close(): Promise<void> {
        clearInterval(this.thinkingCleanup);
        this.privateThinking.clear();
        for (const cleanup of this.inflight.values()) cleanup();
        this.inflight.clear();
        return new Promise(resolve => this.server.close(() => resolve()));
    }

    private writeError(res: ServerResponse, status: number, code: string, message: string): void {
        if (res.headersSent) { res.end(); return; }
        const body = JSON.stringify({ error: { message, type: code, code } });
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
    }

    private async readBody(req: IncomingMessage, signal: AbortSignal): Promise<string> {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
            const buf = chunk as Buffer;
            size += buf.length;
            if (size > MAX_BODY_BYTES) throw new ApiError('INPUT_TOO_LARGE', `模型请求体超过${MAX_BODY_BYTES / 1024 / 1024}MiB上限`);
            if (signal.aborted) throw new ApiError('MODEL_TIMEOUT', '请求已被取消');
            chunks.push(buf);
        }
        return Buffer.concat(chunks).toString('utf8');
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        let failStarted: (() => void) | undefined;
        let removeReasoningAbort: (() => void) | undefined;
        try {
            if (req.method !== 'POST' || url.pathname !== '/_runtime/v1/model/chat/completions') {
                return this.writeError(res, 404, 'NOT_FOUND', '仅支持POST /chat/completions');
            }
            const auth = req.headers.authorization ?? '';
            const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
            if (!token) return this.writeError(res, 401, 'TICKET_INVALID', '缺少Bearer运行票据');
            const ticket = this.deps.tickets.verify(token); // TICKET_INVALID → 401

            const binding = this.deps.bindingOf(ticket.attemptId);
            if (!binding) return this.writeError(res, 403, 'POLICY_DENIED', 'attempt没有冻结的模型绑定');

            const reservationHeader = String(req.headers['x-prism-reservation'] ?? '');
            const bodyHashHeader = String(req.headers['x-prism-body-hash'] ?? '');
            if (!reservationHeader || !bodyHashHeader) return this.writeError(res, 400, 'PROTOCOL_INVALID', '缺少reservation或body hash头');

            const localAbort = new AbortController();
            const parentAbort = this.deps.abortOf(ticket.attemptId);
            const abort = parentAbort ? AbortSignal.any([parentAbort, localAbort.signal]) : localAbort.signal;
            const body = await this.readBody(req, abort);

            // body hash真实校验（worker登记与实际发送一致）
            const actualHash = ModelRequestRegistry.hashBody(body);
            if (actualHash !== bodyHashHeader) return this.writeError(res, 403, 'RESERVATION_INVALID', '请求体hash校验失败');

            let parsed;
            try { parsed = parseChatRequest(JSON.parse(body) as ChatRequestBody, {decodePrivateThinking:details=>this.privateThinking.decode(ticket.attemptId,binding,details)}); }
            catch (error) {
                if (error instanceof ApiError) return this.writeError(res, error.status, error.code, error.message);
                return this.writeError(res, 400, 'PROTOCOL_INVALID', '请求体解析失败');
            }
            // 模型/端点不能由worker更换：请求model必须等于冻结绑定；max_tokens只能在冻结限额内收紧
            if (parsed.model !== binding.modelId) return this.writeError(res, 403, 'POLICY_DENIED', '请求模型与冻结绑定不一致');
            if (parsed.maxTokens !== undefined && parsed.maxTokens > binding.maxOutputTokens)
                return this.writeError(res, 403, 'POLICY_DENIED', 'max_tokens超过冻结输出限额');

            // A reservation is scoped to its verified ticket, not merely to a matching body hash.
            const reserved = this.deps.db.db.prepare('SELECT run_id,attempt_id FROM model_requests WHERE reservation_id=?')
                .get(reservationHeader) as {run_id:string;attempt_id:string}|undefined;
            if (!reserved || reserved.run_id !== ticket.runId || reserved.attempt_id !== ticket.attemptId)
                return this.writeError(res, 403, 'RESERVATION_INVALID', 'reservation与运行票据不匹配');
            // reserved→started原子领取；重复请求409，绝不二次调用供应商
            let started;
            try { started = this.deps.registry.start(reservationHeader, actualHash); }
            catch (error) {
                if (error instanceof ApiError) return this.writeError(res, error.status, error.code, error.message);
                throw error;
            }
            const requestId = started.row.id;
            this.inflight.set(requestId, () => localAbort.abort());

            const measurement = new ProviderMeasurement(binding.protocol);
            const reasoning = new ReasoningProjection(this.deps.db, {
                runId: started.row.run_id, attemptId: started.row.attempt_id,
                requestId, kind: started.row.request_kind,
            }, binding.protocol, () => localAbort.abort());
            let reasoningError: unknown;
            const finishReasoning = (done: boolean) => {
                try { reasoning.finish(done); } catch (error) { reasoningError = error; }
            };
            const interruptReasoning = () => finishReasoning(false);
            abort.addEventListener('abort', interruptReasoning, { once: true });
            removeReasoningAbort = () => abort.removeEventListener('abort', interruptReasoning);
            if (abort.aborted) interruptReasoning();
            const timing: Timing = { startedAt: new Date().toISOString(), firstChunkAt: null, firstGenerationDeltaAt: null, firstTextAt: null, firstToolDeltaAt: null };
            failStarted = () => {
                localAbort.abort();
                const completedAt = new Date().toISOString();
                this.deps.registry.finish(requestId, parentAbort?.aborted ? 'cancelled' : 'failed', 'GATEWAY_STREAM_INTERRUPTED', {
                    usageSource:measurement.source(false),usage:measurement.usage,evidence:measurement.evidence,
                    timing:{...timing,firstChunkAt:measurement.firstChunkAt,firstGenerationDeltaAt:measurement.firstGenerationDeltaAt,
                        firstTextAt:measurement.firstTextAt,firstToolDeltaAt:measurement.firstToolDeltaAt,completedAt,
                        ttftMs:measurement.firstGenerationDeltaAt?Date.parse(measurement.firstGenerationDeltaAt)-Date.parse(timing.startedAt):null,
                        firstTextMs:measurement.firstTextAt?Date.parse(measurement.firstTextAt)-Date.parse(timing.startedAt):null},
                });
                this.inflight.delete(requestId);
            };
            const apiKey = this.deps.vault.get(binding.sessionRef, binding.configId);
            if (!apiKey) {
                this.deps.registry.finish(requestId, 'failed', 'CREDENTIAL_REQUIRED', {
                    usageSource: 'unknown',
                    usage: {},
                    timing: { ...timing, completedAt: new Date().toISOString(), ttftMs: null, firstTextMs: null },
                });
                this.inflight.delete(requestId);
                return this.writeError(res, 422, 'CREDENTIAL_REQUIRED', '运行凭据不可用，请在设置中重新提供API Key');
            }

            const profile = this.deps.profile ?? RUNTIME_STREAM_PROFILE;
            const transport = streamingPinnedFetch(binding.baseUrl, { ...profile, caCertPem: binding.caCertPem ?? profile.caCertPem });
            // 思考三件套按厂商文档核实层+目录解析：级别映射随 Model 下发（非恒等映射的厂商翻译必需）；
            // compat 合并顺序 vendorFacts > 目录 > 正则推导（中转方言不猜，交给 pi-ai detectCompat），
            // supportsStore/developerRole 策略位钉死
            const thinking = resolveThinkingCapability(binding.protocol ?? 'openai-completions', binding.baseUrl, binding.modelId, binding.parameters?.advanced);
            const model = {
                id: binding.modelId,
                name: binding.modelId,
                api: binding.protocol ?? 'openai-completions',
                provider: 'prism-gateway',
                baseUrl: binding.baseUrl,
                // 块E2：视觉能力按pi模型目录解析声明（modelCatalog）；用户消息图片序列化不依赖该位，
                // 但工具结果图片路径按model.input.includes('image')放行
                input: resolveVisionSupport(binding.protocol ?? 'openai-completions', binding.baseUrl, binding.modelId, binding.parameters?.advanced) ? ['text', 'image'] : ['text'],
                reasoning: binding.parameters?.effective.thinkingLevel !== 'off' && (binding.parameters?.capability.thinkingLevels.length ?? 0) > 0,
                contextWindow: binding.parameters?.effective.contextWindow ?? binding.contextWindow,
                maxTokens: binding.parameters?.effective.maxOutputTokens ?? binding.maxOutputTokens,
                // tiers必须存在：pi-ai计费读取model.cost.tiers，缺失会让上游流在usage结算时抛错
                cost: { tiers: [], input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                ...(thinking.thinkingLevelMap ? { thinkingLevelMap: thinking.thinkingLevelMap } : {}),
                compat: { requiresThinkingAsText: false, supportsReasoningEffort: binding.parameters?.capability.id === 'openai-reasoning-v1', maxTokensField: binding.parameters?.capability.id === 'openai-reasoning-v1' ? 'max_completion_tokens' : 'max_tokens', ...(thinking.catalogCompat ?? {}), ...(thinking.vendorCompat ?? {}), supportsStore: false, supportsDeveloperRole: false },
            } as Model<'openai-completions' | 'anthropic-messages'>;
            // 上游注入可观测头（reservation贯穿本次请求；body由pi-ai按冻结绑定构建）
            const fetchWithReservation = transport.injectHeaders({
                'x-prism-request-id': requestId,
            });

            const events = (binding.protocol === 'anthropic-messages' ? streamAnthropic : streamOpenAI)(model as never, normalizeContext({ systemPrompt: parsed.systemPrompt, messages: parsed.messages.map(message => message.role === 'assistant' ? {...message,api:model.api,provider:model.provider,model:model.id} : message), tools: parsed.tools }), {
                apiKey,
                onPayload: thinkingPayloadHook(binding.parameters?.advanced,binding.parameters?.effective.thinkingLevel??'off'),
                fetch: fetchWithReservation as typeof fetch,
                signal: abort,
                maxTokens: Math.min(parsed.maxTokens ?? binding.maxOutputTokens, started.row.max_output_tokens ?? binding.maxOutputTokens, binding.parameters?.effective.maxOutputTokens ?? binding.maxOutputTokens),
                ...(binding.parameters?.effective.temperature !== undefined ? {temperature:binding.parameters.effective.temperature} : {}),
                ...(binding.parameters?.effective.reasoning ? {reasoning:binding.parameters.effective.reasoning} : {}),
                maxRetries: 0, // 默认关闭自动网络重试（§5）
                timeoutMs: profile.idleTimeoutMs > 0 ? profile.idleTimeoutMs : 120_000,
                env: {},
                onProviderStreamEvent: (data: unknown) => { measurement.observe(data); reasoning.observe(data); },
            });

            // 领取后立即向worker转发SSE流（真流式：不等待上游完成）。
            // events是单遍迭代器：计量不得另开for-await与之竞争（会瓜分事件），终局经onFinal旁路。
            let finalMessage: { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number }; stopReason?: string; errorMessage?: string } | undefined;
            let sawDone = false;
            let settled = false;
            const settle = () => {
                if (settled) return;
                settled = true;
                completedResolve({
                    stop: sawDone && finalMessage?.stopReason !== 'error' ? 'completed' : 'failed',
                    usageSource: measurement.source(sawDone),
                    usage: measurement.usage,
                    errorMessage: finalMessage?.errorMessage ?? null,
                });
            };
            let completedResolve: (value: { stop: 'completed' | 'failed'; usageSource: 'provider' | 'partial' | 'absent' | 'unknown'; usage: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; reasoning: number | null; totalInput: number | null }; errorMessage: string | null }) => void;
            const completed = new Promise<{ stop: 'completed' | 'failed'; usageSource: 'provider' | 'partial' | 'absent' | 'unknown'; usage: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; reasoning: number | null; totalInput: number | null }; errorMessage: string | null }>(resolve => { completedResolve = resolve; });

            const sse = encodeSseFromEvents(events, `chatcmpl-${requestId}`, binding.modelId, Math.floor(Date.now() / 1000), {
                encodePrivateThinking: final => abort.aborted ? undefined : this.privateThinking.encode(ticket.attemptId,binding,final),
                onFinal: (final, done) => { finalMessage = final; sawDone = done; },
            });
            res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-store',
                'x-accel-buffering': 'no',
                connection: 'keep-alive',
            });
            const reader = sse.getReader();
            let clientGone = false;
            res.on('close', () => { clientGone = true; if (!res.writableEnded) localAbort.abort(); });
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (!clientGone) await new Promise<void>((resolveWrite) => res.write(value, () => resolveWrite()));
                }
            } catch { /* 流错误已在事件层处理 */ }
            settle(); // SSE终点（done/error/上游中断）必经编码器；clientGone提前断开时也按已见终局计量
            const result = await completed;
            finishReasoning(!abort.aborted && result.stop === 'completed');
            if (reasoningError) throw reasoningError;
            const completedAt = new Date().toISOString();
            Object.assign(timing, {firstChunkAt:measurement.firstChunkAt,firstGenerationDeltaAt:measurement.firstGenerationDeltaAt,firstTextAt:measurement.firstTextAt,firstToolDeltaAt:measurement.firstToolDeltaAt});
            const ttftMs = timing.firstGenerationDeltaAt ? Math.max(0, Date.parse(timing.firstGenerationDeltaAt) - Date.parse(timing.startedAt)) : null;
            const firstTextMs = timing.firstTextAt ? Math.max(0, Date.parse(timing.firstTextAt) - Date.parse(timing.startedAt)) : null;
            this.deps.registry.finish(requestId, abort.aborted ? 'cancelled' : result.stop, result.errorMessage, {
                usageSource: result.usageSource,
                usage: result.usage,
                evidence: measurement.evidence,
                timing: { ...timing, completedAt, ttftMs, firstTextMs },
            });
            if(abort.aborted)this.privateThinking.clearAttempt(ticket.attemptId);
            this.inflight.delete(requestId);
            if (!res.writableEnded) res.end();
        }
        catch (error) {
            failStarted?.();
            if (error instanceof ApiError) return this.writeError(res, error.status, error.code, error.message);
            return this.writeError(res, 500, 'INTERNAL_ERROR', '网关内部错误');
        }
        finally { removeReasoningAbort?.(); }
    }
}

export { LIMITS };

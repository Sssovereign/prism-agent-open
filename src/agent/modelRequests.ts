import { createHash, randomBytes } from 'node:crypto';
import type { Db, Tx } from '../storage/db.js';
import type { UsageBuckets, UsageEvidence } from '../../contracts/usage.js';
import { count } from './contextMeasurement.js';
import { ApiError } from '../../contracts/errors.js';

/**
 * 模型请求登记与门禁（计划v1.6 §5“每次模型请求的登记与门禁”）。
 * HTTP发送前由worker的请求适配器提出reservation；网关领取reserved→started后才发上游。
 * 同reservation重复请求若已started/终结→409 REQUEST_ALREADY_STARTED，绝不二次调用供应商。
 * 单attempt至多一个未终结模型请求；压缩确认门禁：存在未确认checkpoint提案时禁止新main请求。
 */
export type RequestKind = 'main' | 'compaction' | 'repair' | 'memory_recall' | 'memory_extraction';

export interface ProposeInput {
    attemptId: string;
    runId: string;
    roleId: string;
    kind: RequestKind;
    bodyHash: string;
    estimatedInputTokens: number;
    maxOutputTokens: number;
    inputMessageIds: string[];
    sourceSeq: number | null;
    checkpointId: string | null;
    turnId: string | null;
    clientMessageId: string | null;
    // 冻结模型快照（run创建时确定）；contextWindow=null＝窗口未知（目录未收录且未手填）
    provider: string;
    model: string;
    contextWindow: number | null;
    frozenMaxOutput: number;
    reserveOutputTokens: number;
}

export interface Reservation {
    requestId: string;
    reservation: string;
    maxOutputTokens: number;
    expiresAtMs: number;
}

// 默认限额（执行规格：每Phase模型100步；预留输出；reservation 60s）
export const LIMITS = {
    modelStepsPerAttempt: 100,
    toolStepsPerAttempt: 200,
    reservationTtlMs: 60_000,
    reserveOutputTokens: 16_384,
    /** 输出下限：预算不足先收紧本次输出到可用量，低于下限才判真超限（对齐pi MIN_ANSWER_TOKENS=1024）。 */
    minOutputTokensFloor: 1_024,
    speedMinDurationMs: 200,
    speedMaxDurationMs: 3_600_000,
};

interface RequestRow {
    id: string;
    reservation_id: string;
    attempt_id: string;
    run_id: string;
    request_kind: RequestKind;
    body_hash: string;
    provider: string;
    model: string;
    turn_id: string | null;
    client_message_id: string | null;
    input_message_ids_json: string;
    source_seq: number | null;
    checkpoint_id: string | null;
    state: 'reserved' | 'started' | 'completed' | 'failed' | 'cancelled';
    max_output_tokens: number | null;
    created_at: string;
}

export class ModelRequestRegistry {
    constructor(private readonly db: Db, private readonly cancelled: (runId: string) => boolean) {}

    static hashBody(body: string): string {
        return createHash('sha256').update(body, 'utf8').digest('hex');
    }

    propose(input: ProposeInput): Reservation {
        const now = new Date().toISOString();
        return this.db.tx(tx => {
            // 1) attempt活性：running且run未取消
            const attemptRow = tx.prepare(`SELECT a.status AS attempt_status, a.number AS attempt_number, r.status AS run_status, r.cancel_requested_at
                FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id JOIN runs r ON r.id=pt.run_id WHERE a.id=?`).get(input.attemptId) as
                { attempt_status: string; run_status: string; cancel_requested_at: string | null } | undefined;
            if (!attemptRow) throw new ApiError('ATTEMPT_NOT_ACTIVE', 'attempt不存在');
            if (attemptRow.attempt_status !== 'running') throw new ApiError('ATTEMPT_NOT_ACTIVE', 'attempt未在运行');
            if (attemptRow.run_status !== 'running' || attemptRow.cancel_requested_at) throw new ApiError('ATTEMPT_NOT_ACTIVE', 'Run已取消或不在运行');

            // 2) 显式取消状态（run级cancelling即时拒绝新模型请求）
            if (this.cancelled(input.runId)) throw new ApiError('ATTEMPT_NOT_ACTIVE', 'Run正在取消');

            // 3) 压缩确认门禁：存在proposed未确认checkpoint → 禁止任何新模型请求（main/compaction一致）
            const pending = tx.prepare(`SELECT COUNT(*) AS n FROM context_checkpoints WHERE attempt_id=? AND state='proposed'`).get(input.attemptId) as { n: number };
            if (pending.n > 0) throw new ApiError('CONTEXT_LIMIT_EXCEEDED', '存在未确认的压缩checkpoint，等待监督器确认后再继续');

            // 4) 单attempt至多一个未终结模型请求
            const inflight = tx.prepare(`SELECT id FROM model_requests WHERE attempt_id=? AND state IN ('reserved','started')`).get(input.attemptId) as { id: string } | undefined;
            if (inflight) throw new ApiError('REQUEST_IN_PROGRESS', '该attempt已有未终结的模型请求');

            // 5) 预算：模型步数（completed+failed计入；cancelled不计失败步）
            const steps = tx.prepare(`SELECT COUNT(*) AS n FROM model_requests WHERE attempt_id=? AND state IN ('completed','failed')`).get(input.attemptId) as { n: number };
            if (steps.n >= LIMITS.modelStepsPerAttempt) throw new ApiError('MODEL_QUOTA_EXCEEDED', `模型调用步数达到上限（${LIMITS.modelStepsPerAttempt}）`);

            // 6) 上下文预算：estimated + maxOutput ≤ contextWindow − reserveOutput；上限裁剪到冻结maxOutput。
            //    预留量按窗口1/4封顶：小窗口模型若预留≥窗口会把预算压成0，任何请求都被误判超额。
            //    输出上限是"最多可生成"而非"必须生成"（对齐pi-ai clampMaxTokensToContext）：预算不足
            //    先收紧本次输出额度完成收尾，低于下限（真超限）才拒绝。窗口未知（null）时预算不可
            //    计算：跳过检查照常放行（过大由上游超限报错如实兜底），
            //    reserve/context_window 落库 0/NULL，不造默认窗口。
            const maxOutput = Math.min(input.maxOutputTokens, input.frozenMaxOutput);
            if (maxOutput <= 0) throw new ApiError('CONTEXT_LIMIT_EXCEEDED', '输出限额不可用');
            let reserve = 0;
            let effectiveMaxOutput = maxOutput;
            if (input.contextWindow !== null) {
                reserve = Math.min(input.reserveOutputTokens, Math.floor(input.contextWindow / 4));
                const available = input.contextWindow - reserve - input.estimatedInputTokens;
                if (available < LIMITS.minOutputTokensFloor)
                    throw new ApiError('CONTEXT_LIMIT_EXCEEDED', `预计输入${input.estimatedInputTokens}超过上下文预算（窗口${input.contextWindow}，预留${reserve}），收紧输出至下限${LIMITS.minOutputTokensFloor}仍不可容纳，请整理上下文或缩小输入`);
                if (effectiveMaxOutput > available) effectiveMaxOutput = available;
            }

            const requestId = randomBytes(16).toString('hex');
            const reservation = randomBytes(24).toString('hex');
            tx.prepare(`INSERT INTO model_requests(id,reservation_id,run_id,attempt_id,request_kind,body_hash,provider,model,turn_id,client_message_id,input_message_ids_json,source_seq,checkpoint_id,max_output_tokens,context_window,estimated_input_tokens,reserve_output_tokens,state,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?)`)
                .run(requestId, reservation, input.runId, input.attemptId, input.kind, input.bodyHash, input.provider, input.model,
                    input.turnId, input.clientMessageId, JSON.stringify(input.inputMessageIds), input.sourceSeq, input.checkpointId,
                    effectiveMaxOutput, input.contextWindow, input.estimatedInputTokens, reserve, now, now);
            return { requestId, reservation, maxOutputTokens: effectiveMaxOutput, expiresAtMs: Date.now() + LIMITS.reservationTtlMs };
        });
    }

    /** reserved→started原子领取（按reservation定位）；同reservation已started/终结→409并引用原请求。 */
    start(reservation: string, bodyHash: string): { row: RequestRow } {
        const now = new Date().toISOString();
        return this.db.tx(tx => {
            const row = tx.prepare('SELECT * FROM model_requests WHERE reservation_id=?').get(reservation) as unknown as RequestRow | undefined;
            if (!row) throw new ApiError('RESERVATION_INVALID', 'reservation不存在或不匹配');
            const requestId = row.id;
            if (row.state !== 'reserved') throw new ApiError('REQUEST_ALREADY_STARTED', '该reservation已领取或已终结', { requestId, state: row.state });
            if (row.body_hash !== bodyHash) throw new ApiError('RESERVATION_INVALID', '请求体hash与登记不符');
            // 领取时再核取消（与propose之间的窗口）
            if (this.cancelled(row.run_id)) throw new ApiError('ATTEMPT_NOT_ACTIVE', 'Run正在取消');
            const result = tx.prepare(`UPDATE model_requests SET state='started', started_at=?, updated_at=? WHERE id=? AND state='reserved'`).run(now, now, requestId);
            if (result.changes !== 1) throw new ApiError('REQUEST_ALREADY_STARTED', '该reservation已领取或已终结', { requestId });
            // includedInRequest游标：网关领取成功=登记的用户消息已纳入上游请求（补充门禁随之解除）
            const includedIds = JSON.parse(row.input_message_ids_json) as string[];
            if (includedIds.length) {
                const placeholders = includedIds.map(() => '?').join(',');
                tx.prepare(`UPDATE messages SET consumed_cursor_json=?, updated_at=? WHERE id IN (${placeholders}) AND consumed_cursor_json IS NULL`)
                    .run(JSON.stringify({ requestId, at: now }), now, ...(includedIds as never[]));
            }
            return { row: { ...row, state: 'started' as const } };
        });
    }

    /** 终结：completed/failed/cancelled + 用量（仅网关记账；usage不完整标unknown，缺失不冒充0）。 */
    finish(requestId: string, state: 'completed' | 'failed' | 'cancelled', error: string | null, report: {
        usageSource: 'provider' | 'partial' | 'absent' | 'unknown';
        usage: { input?: number | null; output?: number | null; cacheRead?: number | null; cacheWrite?: number | null; reasoning?: number | null; totalInput?: number | null };
        evidence?: UsageEvidence;
        timing: { startedAt: string; firstChunkAt: string | null; firstGenerationDeltaAt: string | null; firstTextAt: string | null; firstToolDeltaAt: string | null; completedAt: string; ttftMs: number | null; firstTextMs: number | null };
    }): void {
        const completedAt = report.timing.completedAt;
        const usage = report.usage;
        const usageSource = report.usageSource;
        const timing = report.timing;
        this.db.tx(tx => {
            const row = tx.prepare('SELECT * FROM model_requests WHERE id=?').get(requestId) as unknown as (RequestRow & { usage_json: string | null; started_at: string | null }) | undefined;
            if (!row) throw new ApiError('NOT_FOUND', '模型请求不存在');
            // Cancellation may win before the gateway receives final usage. Fill absent fields,
            // never add a second ledger entry, and never resurrect a cancelled request.
            const previous = tx.prepare('SELECT normalized_usage_json, usage_evidence_json FROM usage_entries WHERE request_id=?').get(requestId) as { normalized_usage_json: string | null; usage_evidence_json: string | null } | undefined;
            const old = previous?.normalized_usage_json ? JSON.parse(previous.normalized_usage_json) as UsageBuckets : null;
            const normalized: UsageBuckets = {
                input: old?.input ?? count(usage.input), output: old?.output ?? count(usage.output),
                cacheRead: old?.cacheRead ?? count(usage.cacheRead), cacheWrite: old?.cacheWrite ?? count(usage.cacheWrite),
                reasoning: old?.reasoning ?? count(usage.reasoning), totalInput: old?.totalInput ?? count(usage.totalInput),
            };
            if (normalized.totalInput === null && normalized.input !== null && normalized.cacheRead !== null && normalized.cacheWrite !== null)
                normalized.totalInput = normalized.input + normalized.cacheRead + normalized.cacheWrite;
            if (previous && JSON.stringify(normalized) === previous.normalized_usage_json && (!report.evidence || previous.usage_evidence_json !== null)) return;
            const effectiveState = row.state === 'cancelled' || row.state === 'completed' || row.state === 'failed' ? row.state : state;
            const effectiveSource = normalized.input !== null && normalized.output !== null && normalized.cacheRead !== null && normalized.cacheWrite !== null
                ? 'provider' : Object.values(normalized).some(v => v !== null) ? 'partial' : usageSource;

            tx.prepare(`UPDATE model_requests SET state=?, error_code=?, usage_json=?, completed_at=?, updated_at=? WHERE id=?`)
                .run(effectiveState, error, JSON.stringify({ usage: normalized, usageSource: effectiveSource }), completedAt, completedAt, requestId);
            // usage_entries：与请求一一对应（request_id UNIQUE），幂等upsert
            const known = (v: number | null | undefined): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
            const inputT = known(normalized.input), outputT = known(normalized.output), cacheReadT = known(normalized.cacheRead), cacheWriteT = known(normalized.cacheWrite), reasoningT = known(normalized.reasoning);
            // 速度配对：真实输出token与有效生成时窗（首个非空生成增量→完成），200ms≤duration<1h
            let decodeMs: number | null = null, speedValid = 0;
            if (timing.firstGenerationDeltaAt && typeof outputT === 'number' && outputT > 0) {
                const duration = Date.parse(completedAt) - Date.parse(timing.firstGenerationDeltaAt);
                if (Number.isFinite(duration) && duration >= LIMITS.speedMinDurationMs && duration < LIMITS.speedMaxDurationMs) {
                    decodeMs = duration;
                    speedValid = 1;
                }
            }
            tx.prepare(`INSERT INTO usage_entries(id,run_id,attempt_id,request_id,provider,model,input_tokens,output_tokens,cache_tokens_json,estimated,latency_ms,status,
                request_kind,turn_id,client_message_id,input_message_ids_json,source_seq,checkpoint_id,started_at,first_chunk_at,first_generation_delta_at,first_text_at,first_tool_delta_at,completed_at,
                ttft_ms,first_text_ms,reasoning_tokens,cache_read_tokens,cache_write_tokens,usage_source,speed_valid,decode_tokens,decode_ms,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(request_id) DO UPDATE SET
                    input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens, cache_tokens_json=excluded.cache_tokens_json,
                    estimated=excluded.estimated, latency_ms=excluded.latency_ms, status=excluded.status,
                    first_chunk_at=excluded.first_chunk_at,first_generation_delta_at=excluded.first_generation_delta_at,
                    first_text_at=excluded.first_text_at,first_tool_delta_at=excluded.first_tool_delta_at,
                    completed_at=excluded.completed_at, ttft_ms=excluded.ttft_ms, first_text_ms=excluded.first_text_ms,
                    reasoning_tokens=excluded.reasoning_tokens, cache_read_tokens=excluded.cache_read_tokens,
                    cache_write_tokens=excluded.cache_write_tokens, usage_source=excluded.usage_source,
                    speed_valid=excluded.speed_valid, decode_tokens=excluded.decode_tokens, decode_ms=excluded.decode_ms, updated_at=excluded.updated_at`)
                .run(
                    requestId, row.run_id, row.attempt_id, requestId, row.provider, row.model,
                    inputT ?? 0, outputT ?? 0,
                    JSON.stringify({ cacheRead: cacheReadT, cacheWrite: cacheWriteT, unknown: usageSource === 'unknown' || inputT === null }),
                    usageSource === 'unknown' || inputT === null || outputT === null ? 1 : 0,
                    timing.startedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(timing.startedAt)) : null,
                    effectiveState,
                    row.request_kind, row.turn_id, row.client_message_id, row.input_message_ids_json, row.source_seq, row.checkpoint_id,
                    timing.startedAt, timing.firstChunkAt, timing.firstGenerationDeltaAt, timing.firstTextAt, timing.firstToolDeltaAt, completedAt,
                    timing.ttftMs, timing.firstTextMs, reasoningT, cacheReadT, cacheWriteT, effectiveSource, speedValid, speedValid ? outputT : null, decodeMs,
                    row.created_at, completedAt,
                );
            tx.prepare('UPDATE usage_entries SET normalized_usage_json=?,usage_evidence_json=? WHERE request_id=?')
                .run(JSON.stringify(normalized), report.evidence ? JSON.stringify(report.evidence) : previous?.usage_evidence_json ?? null, requestId);
        });
    }

    /** attempt的未终结请求取消（取消Run时）。 */
    cancelInflight(attemptId: string): void {
        const now = new Date().toISOString();
        const rows = this.db.db.prepare(`SELECT id,started_at FROM model_requests WHERE attempt_id=? AND state IN ('reserved','started')`)
            .all(attemptId) as unknown as Array<{id:string;started_at:string|null}>;
        for (const row of rows) {
            if (!row.started_at) {
                this.db.db.prepare(`UPDATE model_requests SET state='cancelled',completed_at=?,updated_at=? WHERE id=? AND state='reserved'`).run(now,now,row.id);
                continue; // Never dispatched: not a consumed request.
            }
            this.finish(row.id, 'cancelled', null, { usageSource:'unknown', usage:{}, timing:{startedAt:row.started_at,
                firstChunkAt:null,firstGenerationDeltaAt:null,firstTextAt:null,firstToolDeltaAt:null,completedAt:now,ttftMs:null,firstTextMs:null} });
        }
    }

    row(requestId: string): (RequestRow & { usage_json: string | null }) | undefined {
        return this.db.db.prepare('SELECT * FROM model_requests WHERE id=?').get(requestId) as never;
    }
}

export type { Tx };

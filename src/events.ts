// run_events 服务：序号由 runs.next_event_seq 原子分配；先提交再发SSE（丢推送可重读）。
// 必须在 db.tx() 事务内调用（与状态更新同事务提交）。
import { randomUUID } from 'node:crypto';
import type { Db, Tx } from './storage/db.js';
import type { RunEvent, RunEventType, EventVisibility, Uuid } from '../contracts/v1.js';
import { validateRunEvent } from './contracts/schemas.js';

export interface AppendEventInput {
  runId: Uuid;
  type: RunEventType;
  payload?: Record<string, unknown>;
  visibility?: EventVisibility;
  phaseTaskId?: Uuid;
  attemptId?: Uuid;
  /** worker 重传去重：同一 attempt 内的生产者序号，UNIQUE(attempt_id, producer_seq) 兜底 */
  producerSeq?: number;
}

/** 在事务内原子分配序号并落库；返回完整事件信封。
 *  顺序：先构建并校验信封（占位seq），校验通过后才消耗 next_event_seq——失败分配不推进序号。 */
export function appendEvent(db: Db, tx: Tx, input: AppendEventInput): RunEvent {
  const at = new Date().toISOString();
  const envelope: RunEvent = {
    schemaVersion: 'v1',
    eventId: randomUUID(),
    runId: input.runId,
    seq: 1, // 校验占位；实际序号在校验后原子分配
    at,
    type: input.type,
    visibility: input.visibility ?? 'public',
    ...(input.phaseTaskId ? { phaseTaskId: input.phaseTaskId } : {}),
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    payload: input.payload ?? {},
  };
  const checked = validateRunEvent(envelope);
  if (!checked.ok) throw new Error(`EVENT_ENVELOPE_INVALID: ${checked.errors.join('; ')}`);
  const row = tx.prepare('UPDATE runs SET next_event_seq = next_event_seq + 1, updated_at = ? WHERE id = ? RETURNING next_event_seq')
    .get(at, input.runId) as { next_event_seq: number | bigint } | undefined;
  if (!row) throw new Error(`RUN_NOT_FOUND: ${input.runId}`);
  const event: RunEvent = { ...envelope, seq: Number(row.next_event_seq) };
  tx.prepare(`INSERT INTO run_events(run_id, seq, event_id, attempt_id, producer_seq, visibility, type, occurred_at, payload_json)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(event.runId, event.seq, event.eventId, event.attemptId ?? null, input.producerSeq ?? null,
      event.visibility, event.type, event.at, JSON.stringify(event.payload));
  return event;
}

/** 便捷：独立小事务写一条事件（仅用于无状态绑定要求的记录）。 */
export function appendEventStandalone(db: Db, input: AppendEventInput): RunEvent {
  return db.tx(tx => appendEvent(db, tx, input));
}

export function readEvents(db: Db, runId: Uuid, afterSeq = 0, limit = 200): RunEvent[] {
  const rows = db.db.prepare(
    'SELECT event_id, seq, attempt_id, producer_seq, visibility, type, occurred_at, payload_json FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?'
  ).all(runId, afterSeq, limit) as unknown as Array<{
    event_id: string; seq: number | bigint; attempt_id: string | null; producer_seq: number | bigint | null;
    visibility: string; type: string; occurred_at: string; payload_json: string;
  }>;
  return rows.map(r => ({
    schemaVersion: 'v1' as const,
    eventId: r.event_id,
    runId,
    seq: Number(r.seq),
    at: r.occurred_at,
    type: r.type as RunEventType,
    visibility: r.visibility as EventVisibility,
    ...(r.attempt_id ? { attemptId: r.attempt_id } : {}),
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
  }));
}

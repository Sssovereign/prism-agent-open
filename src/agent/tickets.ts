import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../storage/db.js';
import { ApiError } from '../../contracts/errors.js';

/**
 * Attempt票据（计划v1.6 §3/§5）：高熵、限时、绑定run/attempt/role/model/policy版本。
 * 仅存hash（attempts.lease_token_hash），不进命令行、公开事件、产物或日志。
 * 票据=worker租约token：监督器心跳续期，撤销即时失效。
 */
export interface TicketContext {
    participantId?: string;
    phaseTaskId?: string;
    viewId?: string;
    attemptId: string;
    runId: string;
    roleId: string;
    modelConfigId: string;
    modelId: string;
    policyVersion: string;
    expiresAtMs: number;
}

export class TicketRegistry {
    // 内存索引：hash → context；DB为持久依据（attempts行）。
    private readonly byHash = new Map<string, TicketContext>();

    constructor(private readonly db: Db) {}

    /** 生成票据：返回原文（仅经受控bootstrap通道交给runner），DB与索引仅存hash。 */
    mint(context: Omit<TicketContext, 'expiresAtMs'>, ttlMs: number): { token: string; expiresAtMs: number } {
        const token = randomBytes(32).toString('hex');
        const hash = TicketRegistry.hashOf(token);
        const expiresAtMs = Date.now() + ttlMs;
        this.byHash.set(hash, { ...context, expiresAtMs });
        this.db.db.prepare('UPDATE attempts SET lease_token_hash=?, lease_until=?, updated_at=? WHERE id=?')
            .run(hash, new Date(expiresAtMs).toISOString(), new Date().toISOString(), context.attemptId);
        return { token, expiresAtMs };
    }

    /** 校验Bearer票据；过期/未知/已撤销一律TICKET_INVALID。 */
    verify(token: string): TicketContext {
        const hash = TicketRegistry.hashOf(token);
        const context = this.byHash.get(hash);
        if (!context) throw new ApiError('TICKET_INVALID', '运行票据无效');
        if (context.expiresAtMs <= Date.now()) {
            this.byHash.delete(hash);
            throw new ApiError('TICKET_INVALID', '运行票据已过期');
        }
        return context;
    }

    /** 心跳续期；attempt不存在/已终态返回false。 */
    renew(attemptId: string, ttlMs: number): boolean {
        const row = this.db.db.prepare('SELECT status, lease_token_hash FROM attempts WHERE id=?').get(attemptId) as { status: string; lease_token_hash: string | null } | undefined;
        if (!row || !row.lease_token_hash) return false;
        if (['succeeded', 'failed', 'cancelled'].includes(row.status)) {
            this.byHash.delete(row.lease_token_hash);
            return false;
        }
        const expiresAtMs = Date.now() + ttlMs;
        this.db.db.prepare('UPDATE attempts SET lease_until=?, updated_at=? WHERE id=?')
            .run(new Date(expiresAtMs).toISOString(), new Date().toISOString(), attemptId);
        const context = this.byHash.get(row.lease_token_hash);
        if (context) context.expiresAtMs = expiresAtMs;
        return true;
    }

    /** 撤销：撤票据即时终止相关上游请求与下游流。 */
    revoke(attemptId: string): void {
        const row = this.db.db.prepare('SELECT lease_token_hash FROM attempts WHERE id=?').get(attemptId) as { lease_token_hash: string | null } | undefined;
        if (row?.lease_token_hash) this.byHash.delete(row.lease_token_hash);
        this.db.db.prepare('UPDATE attempts SET lease_token_hash=NULL, lease_until=NULL, updated_at=? WHERE id=?')
            .run(new Date().toISOString(), attemptId);
    }

    private static hashOf(token: string): string {
        return createHash('sha256').update(token, 'utf8').digest('hex');
    }
}

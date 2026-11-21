/**
 * F06补充投递登记（runner侧）：以监督器下发的持久messageId为幂等键。
 * - accept：首次登记 / duplicate幂等确认（重复通知不重复入队）/ conflict拒绝（同ID不同内容）。
 * - 投递确认：pi把补充作为user消息送入会话上下文时（message_start），按文本匹配最早的
 *   未确认条目标记applied——这是"恰好投递一次"的唯一确认点；确认前游标不推进（F05），
 *   确认后拾取循环不再重复prompt。
 * 与pi队列的关系：session.steer把文本放入pi内部steering队列（按文本出队去重）；本登记表
 * 是监督器messageId↔投递状态的真实账本，两者通过message_start的文本匹配对齐。
 */
export type SteerAccept = 'accepted' | 'duplicate' | 'conflict';

export interface SteerEntry { text: string; seq: number; applied: boolean }

export class SteerRegistry {
    private entries = new Map<string, SteerEntry>();

    accept(messageId: string, text: string, seq: number): SteerAccept {
        const known = this.entries.get(messageId);
        if (known) return known.text === text ? 'duplicate' : 'conflict';
        this.entries.set(messageId, { text, seq, applied: false });
        return 'accepted';
    }

    /** 恰好一次确认：返回true=首次（调用方推进输入游标+发投递事件）；false=重复确认。 */
    markApplied(messageId: string): boolean {
        const entry = this.entries.get(messageId);
        if (!entry || entry.applied) return false;
        entry.applied = true;
        return true;
    }

    /** 已确认条目的seq（F05输入游标用；未确认/未知返回0）。 */
    seqOf(messageId: string): number { return this.entries.get(messageId)?.seq ?? 0; }

    /** 补充作为user消息进入上下文时按文本匹配最早未确认条目（FIFO，对齐pi队列出队语义）。 */
    matchOldestUnappliedByText(text: string): string | null {
        for (const [id, entry] of this.entries) {
            if (!entry.applied && entry.text === text) return id;
        }
        return null;
    }

    isApplied(messageId: string): boolean { return this.entries.get(messageId)?.applied ?? false; }

    /** 只读条目（兜底重新入队用）；未知返回null。 */
    entryOf(messageId: string): Readonly<SteerEntry> | null { return this.entries.get(messageId) ?? null; }

    /** 已登记但尚未确认投递的messageId（含流式排队未及投递者——主循环据此兜底重新入队）。 */
    unappliedIds(): string[] {
        return [...this.entries.entries()].filter(([, e]) => !e.applied).map(([id]) => id);
    }
}

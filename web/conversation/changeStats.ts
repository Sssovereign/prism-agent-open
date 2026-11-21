import type { ChangeLineStats, RunChange } from '../../contracts/changes.js';

/** 按操作记录累计，保留已撤销历史；不冒充同一文件的最终净变化。 */
export function totalChangeLines(changes: RunChange[]): ChangeLineStats {
    return changes.reduce<ChangeLineStats>((total, change) => ({
        addedLines: total.addedLines + (change.lineStats?.addedLines ?? 0),
        removedLines: total.removedLines + (change.lineStats?.removedLines ?? 0),
        truncated: total.truncated || !change.lineStats || change.lineStats.truncated,
    }), { addedLines: 0, removedLines: 0, truncated: false });
}

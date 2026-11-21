import type { ChangeLineStats } from '../../contracts/changes.js';
import { DIFF_TRUNCATED_MARKER_PREFIX } from './lineDiff.js';

/** 统计完整持久补丁，不使用已被前端预览裁剪的内容，也不把文件头算作修改。 */
export function changeLineStats(patch: string | null, beforeHash?: string | null, afterHash?: string | null): ChangeLineStats | null {
    if (patch === null) return beforeHash && beforeHash === afterHash ? { addedLines: 0, removedLines: 0, truncated: false } : null;
    const stats = { addedLines: 0, removedLines: 0, truncated: false };
    let inHunk = false;
    for (const line of patch.split(/\r?\n/)) {
        if (line.startsWith(DIFF_TRUNCATED_MARKER_PREFIX)) { stats.truncated = true; continue; }
        if (line.startsWith('@@ ')) { inHunk = true; continue; }
        if (line.startsWith('diff --git ')) { inHunk = false; continue; }
        if (!inHunk) continue;
        if (line.startsWith('+')) stats.addedLines++;
        else if (line.startsWith('-')) stats.removedLines++;
    }
    return stats;
}

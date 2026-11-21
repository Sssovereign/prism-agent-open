/**
 * 统一 diff 生成（块F1）：change_records 持久化 diff_patch 的数据源。
 * LCS 行级 diff，单侧 4000 行/补丁 120_000 字符封顶——超出在补丁尾部追加
 * `\ __PRISM_DIFF_TRUNCATED__:<省略行数>` 协议标记（展示层渲染为截断提示，
 * 对齐上游 patchDiffPreview 的 marker token 方案，不冒充完整 diff）。
 */

const MAX_DIFF_SIDE_LINES = 4000;
const MAX_PATCH_CHARS = 120_000;
const CONTEXT_LINES = 3;
export const DIFF_TRUNCATED_MARKER_PREFIX = '\\ __PRISM_DIFF_TRUNCATED__:';

export interface LineDiffResult {
    patch: string;
    truncated: boolean;
    addedLines: number;
    removedLines: number;
}

interface DiffOp { kind: 'same' | 'add' | 'del'; line: string }

function splitLines(text: string): string[] {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop(); // 尾部换行不产生虚行；无尾换行的文件保留末行
    return lines;
}

function lcsDiff(before: string[], after: string[]): DiffOp[] {
    const n = before.length, m = after.length;
    // DP 表按 uint32 行存储，4000×4000 上限约 64MB，可接受；超限已在上游截断
    const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[i]![j] = before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
        }
    }
    const ops: DiffOp[] = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (before[i] === after[j]) { ops.push({ kind: 'same', line: before[i]! }); i++; j++; }
        else if (table[i + 1]![j]! >= table[i]![j + 1]!) { ops.push({ kind: 'del', line: before[i]! }); i++; }
        else { ops.push({ kind: 'add', line: after[j]! }); j++; }
    }
    while (i < n) { ops.push({ kind: 'del', line: before[i]! }); i++; }
    while (j < m) { ops.push({ kind: 'add', line: after[j]! }); j++; }
    return ops;
}

/** 生成统一格式补丁；oldLabel/newLabel 用 a/前缀路径或 /dev/null。无变化返回 patch=''。 */
export function buildUnifiedDiff(beforeText: string | null, afterText: string | null, oldLabel: string, newLabel: string): LineDiffResult {
    const before = splitLines(beforeText ?? '');
    const after = splitLines(afterText ?? '');
    let truncated = false;
    let beforeSide = before, afterSide = after;
    if (beforeSide.length > MAX_DIFF_SIDE_LINES) { truncated = true; beforeSide = beforeSide.slice(0, MAX_DIFF_SIDE_LINES); }
    if (afterSide.length > MAX_DIFF_SIDE_LINES) { truncated = true; afterSide = afterSide.slice(0, MAX_DIFF_SIDE_LINES); }
    const ops = lcsDiff(beforeSide, afterSide);
    const changedIdx: number[] = [];
    ops.forEach((op, idx) => { if (op.kind !== 'same') changedIdx.push(idx); });
    const header = `--- ${oldLabel}\n+++ ${newLabel}\n`;
    if (!changedIdx.length) return { patch: '', truncated, addedLines: 0, removedLines: 0 };
    // 聚组：相邻变更间隔 ≤ 2×CONTEXT 合并进同一 hunk
    const groups: Array<[number, number]> = [];
    let groupStart = changedIdx[0]!, groupEnd = changedIdx[0]!;
    for (const idx of changedIdx.slice(1)) {
        if (idx - groupEnd <= CONTEXT_LINES * 2) groupEnd = idx;
        else { groups.push([groupStart, groupEnd]); groupStart = idx; groupEnd = idx; }
    }
    groups.push([groupStart, groupEnd]);
    let addedLines = 0, removedLines = 0;
    const hunkBodies: string[] = [];
    for (const [g0, g1] of groups) {
        const start = Math.max(0, g0 - CONTEXT_LINES);
        const end = Math.min(ops.length - 1, g1 + CONTEXT_LINES);
        let oldStart = 1, newStart = 1, oldCount = 0, newCount = 0;
        for (let cursor = 0; cursor < start; cursor++) {
            const op = ops[cursor]!;
            if (op.kind === 'del') oldStart++;
            else if (op.kind === 'add') newStart++;
            else { oldStart++; newStart++; }
        }
        const body: string[] = [];
        for (let cursor = start; cursor <= end; cursor++) {
            const op = ops[cursor]!;
            if (op.kind === 'same') { body.push(` ${op.line}`); oldCount++; newCount++; }
            else if (op.kind === 'del') { body.push(`-${op.line}`); removedLines++; oldCount++; }
            else { body.push(`+${op.line}`); addedLines++; newCount++; }
        }
        hunkBodies.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body.join('\n')}`);
    }
    let patch = header + `${hunkBodies.join('\n')}\n`;
    let omitted = (before.length - beforeSide.length) + (after.length - afterSide.length);
    if (patch.length > MAX_PATCH_CHARS) {
        patch = `${patch.slice(0, MAX_PATCH_CHARS)}\n`;
        truncated = true;
        omitted = Math.max(omitted, 1);
    }
    if (truncated) patch += `${DIFF_TRUNCATED_MARKER_PREFIX}${omitted}\n`;
    return { patch, truncated, addedLines, removedLines };
}

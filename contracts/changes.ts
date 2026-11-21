/** 行数来自已保存的文本补丁；截断时只代表可统计部分。 */
export interface ChangeLineStats { addedLines: number; removedLines: number; truncated: boolean }
export interface RunChange {
    id: string;
    relative_path: string;
    operation: string;
    hasDiff: number | null;
    reverted_at?: string | null;
    lineStats: ChangeLineStats | null;
}

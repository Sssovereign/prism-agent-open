/** 完整比较等待原因和更新时间，防止旧页面恢复另一次等待。 */
export function waitStateVersion(run: { stop_reason: string | null; updated_at: string }): string {
    return JSON.stringify([run.stop_reason, run.updated_at]);
}

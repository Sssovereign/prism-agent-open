/** Local app usage snapshot, mirroring the ZCode AppUsagePanel data contract
 * (asar schema: range/generatedAt/timeZone/source/summary/heatmap/dailyModelUsage/models/tools).
 * Token sums only include requests with provenance-era usage evidence; the prism-specific
 * `unknownRequests` additive field counts the rest without inventing zeros. */
export type AppUsageRange = '7d' | '30d' | 'all';
export interface AppUsageFavoriteModel { modelId: string | null; totalTokens: number; share: number }
export interface AppUsageSummary {
  totalTokens: number; inputTokens: number; outputTokens: number; reasoningTokens: number;
  cacheCreationTokens: number; cacheReadTokens: number; cacheHitRate: number;
  totalSessions: number; totalTurns: number; toolCallCount: number;
  toolErrorRate: number; modelErrorRate: number;
  avgTimeToFirstTokenMs: number | null; avgTurnDurationMs: number | null;
  activeDays: number; currentStreakDays: number;
  longestSessionMs: number; longestStreakDays: number;
  peakDayTokens: number; favoriteModel: AppUsageFavoriteModel | null;
}
export interface AppUsageHeatmapCell {
  date: string; level: 0 | 1 | 2 | 3 | 4;
  totalTokens: number; turnCount: number; toolCallCount: number;
}
export interface AppUsageHeatmapWeek { weekIndex: number; days: Array<AppUsageHeatmapCell | null> }
export interface AppUsageHeatmap { startDate: string | null; endDate: string | null; maxTokens: number; weeks: AppUsageHeatmapWeek[] }
export interface AppUsageDailyModelEntry { modelId: string | null; totalTokens: number }
export interface AppUsageDailyModelUsage { date: string; models: AppUsageDailyModelEntry[] }
export interface AppUsageModelUsage {
  modelId: string | null; totalTokens: number; inputTokens: number; outputTokens: number;
  requestCount: number; share: number;
}
export interface AppUsageToolUsage {
  toolName: string; callCount: number; errorCount: number; errorRate: number; avgDurationMs: number | null;
}
export interface AppUsageSnapshot {
  range: AppUsageRange; generatedAt: number; timeZone: string; source: 'agent-db';
  summary: AppUsageSummary; heatmap: AppUsageHeatmap;
  dailyModelUsage: AppUsageDailyModelUsage[]; models: AppUsageModelUsage[]; tools: AppUsageToolUsage[];
  /** Requests without usage evidence (no normalized buckets); excluded from every token sum. */
  unknownRequests: number;
}

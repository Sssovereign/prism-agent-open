import type { Db } from '../storage/db.js';
import type { UsageBuckets } from '../../contracts/usage.js';
import type { AppUsageFavoriteModel, AppUsageHeatmap, AppUsageHeatmapCell, AppUsageModelUsage, AppUsageRange, AppUsageSnapshot, AppUsageToolUsage, AppUsageDailyModelUsage } from '../../contracts/appUsage.js';
import { ApiError } from '../../contracts/errors.js';
import { count } from './contextMeasurement.js';

const DAY_MS = 86_400_000;

export function resolveTimeZone(value: string | undefined): string {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : 'Asia/Shanghai';
  try { new Intl.DateTimeFormat('en-CA', { timeZone: candidate }); return candidate; }
  catch { return 'Asia/Shanghai'; }
}
function dayKeyInTz(iso: string, timeZone: string, formatter: Intl.DateTimeFormat): string | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? formatter.format(new Date(t)) : null;
}
function dayKeyToUtcDayIndex(dateKey: string): number | null {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : Math.floor(date.getTime() / DAY_MS);
}
function utcDayIndexToDateKey(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}
function shiftDayKey(dateKey: string, days: number): string {
  const index = dayKeyToUtcDayIndex(dateKey);
  return index === null ? dateKey : utcDayIndexToDateKey(index + days);
}
interface UsageBucketsRow {
  provider: string; model: string; status: string;
  normalized_usage_json: string | null; ttft_ms: number | null;
  completed_at: string | null; started_at: string | null; created_at: string;
}
interface UsageTotals {
  totalTokens: number; inputTokens: number; outputTokens: number; reasoningTokens: number;
  cacheCreationTokens: number; cacheReadTokens: number; totalInputTokens: number;
  knownRequests: number; unknownRequests: number; failedRequests: number;
  perModel: Map<string, { modelId: string; totalTokens: number; inputTokens: number; outputTokens: number; requestCount: number }>;
  perDayTokens: Map<string, number>;
  perDayModelTokens: Map<string, Map<string, number>>;
  ttftSum: number; ttftSamples: number;
}
function accumulateUsage(totals: UsageTotals, row: UsageBucketsRow, day: string | null): void {
  if (row.status === 'failed') totals.failedRequests++;
  if (!day) return;
  const modelId = `${row.provider} / ${row.model}`;
  const model = totals.perModel.get(modelId) ?? { modelId, totalTokens: 0, inputTokens: 0, outputTokens: 0, requestCount: 0 };
  model.requestCount++;
  totals.perModel.set(modelId, model);
  const u = buckets(row.normalized_usage_json);
  const input = count(u?.totalInput), output = count(u?.output);
  // Same missing rule as projectUsage: absent SDK values must never become zeros.
  if (u === null || input === null || output === null) { totals.unknownRequests++; return; }
  const uncachedInput = count(u.input) ?? Math.max(0, input - (count(u.cacheRead) ?? 0) - (count(u.cacheWrite) ?? 0));
  totals.knownRequests++;
  totals.totalTokens += input + output;
  totals.totalInputTokens += input;
  totals.inputTokens += uncachedInput;
  totals.outputTokens += output;
  totals.reasoningTokens += count(u.reasoning) ?? 0;
  totals.cacheReadTokens += count(u.cacheRead) ?? 0;
  totals.cacheCreationTokens += count(u.cacheWrite) ?? 0;
  if (count(row.ttft_ms) !== null) { totals.ttftSum += row.ttft_ms!; totals.ttftSamples++; }
  model.totalTokens += input + output;
  model.inputTokens += uncachedInput;
  model.outputTokens += output;
  totals.perDayTokens.set(day, (totals.perDayTokens.get(day) ?? 0) + input + output);
  const perModel = totals.perDayModelTokens.get(day) ?? new Map<string, number>();
  perModel.set(modelId, (perModel.get(modelId) ?? 0) + input + output);
  totals.perDayModelTokens.set(day, perModel);
}
function buckets(json: string | null): UsageBuckets | null {
  if (!json) return null;
  try { return JSON.parse(json) as UsageBuckets; } catch { return null; }
}
function buildStreaks(days: string[], today: string): { current: number; longest: number } {
  const sorted = [...days].sort();
  let longest = 0, run = 0, previous: number | null = null;
  for (const day of sorted) {
    const index = dayKeyToUtcDayIndex(day);
    if (index === null) continue;
    run = previous !== null && index - previous === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = index;
  }
  let current = 0;
  const lastIndex = sorted.length ? dayKeyToUtcDayIndex(sorted.at(-1)!) : null;
  const todayIndex = dayKeyToUtcDayIndex(today);
  if (lastIndex !== null && todayIndex !== null && lastIndex >= todayIndex - 1) {
    current = 1;
    for (let i = sorted.length - 2; i >= 0; i--) {
      const index = dayKeyToUtcDayIndex(sorted[i]!);
      if (index === null || dayKeyToUtcDayIndex(sorted[i + 1]!)! - index !== 1) break;
      current++;
    }
  }
  return { current, longest };
}
function buildHeatmap(perDayTokens: Map<string, number>, perDayTurns: Map<string, number>, perDayTools: Map<string, number>): AppUsageHeatmap {
  const days = [...new Set([...perDayTokens.keys(), ...perDayTurns.keys()])].sort();
  if (!days.length) return { startDate: null, endDate: null, maxTokens: 0, weeks: [] };
  const maxTokens = Math.max(0, ...days.map(day => perDayTokens.get(day) ?? 0));
  // Sunday-aligned UTC weeks, matching the UI's 52-week display padding.
  const startIndex = dayKeyToUtcDayIndex(days[0]!)! - new Date(`${days[0]!}T00:00:00.000Z`).getUTCDay();
  const endIndex = dayKeyToUtcDayIndex(days.at(-1)!)!;
  const weeks: AppUsageHeatmap['weeks'] = [];
  for (let weekStart = startIndex; weekStart <= endIndex; weekStart += 7) {
    const cells: Array<AppUsageHeatmapCell | null> = [];
    for (let offset = 0; offset < 7; offset++) {
      const date = utcDayIndexToDateKey(weekStart + offset);
      const tokens = perDayTokens.get(date), turns = perDayTurns.get(date);
      if (tokens === undefined && turns === undefined) { cells.push(null); continue; }
      const level = tokens !== undefined && tokens > 0 && maxTokens > 0
        ? Math.min(4, Math.max(1, Math.ceil(tokens / maxTokens * 4))) as 0 | 1 | 2 | 3 | 4 : 0;
      cells.push({ date, level, totalTokens: tokens ?? 0, turnCount: turns ?? 0, toolCallCount: perDayTools.get(date) ?? 0 });
    }
    weeks.push({ weekIndex: weeks.length, days: cells });
  }
  return { startDate: days[0]!, endDate: days.at(-1)!, maxTokens, weeks };
}
function dailyModelsForDay(totals: UsageTotals, day: string): AppUsageDailyModelUsage {
  return { date: day, models: [...(totals.perDayModelTokens.get(day)?.entries() ?? [])].filter(([, tokens]) => tokens > 0).map(([modelId, totalTokens]) => ({ modelId, totalTokens })) };
}
function buildDailyModelUsage(totals: UsageTotals, range: AppUsageRange, today: string): AppUsageDailyModelUsage[] {
  if (range === 'all') return [...totals.perDayTokens.keys()].sort().map(day => dailyModelsForDay(totals, day));
  const window = range === '7d' ? 7 : 30, out: AppUsageDailyModelUsage[] = [];
  for (let day = shiftDayKey(today, -(window - 1)); day <= today; day = shiftDayKey(day, 1)) out.push(dailyModelsForDay(totals, day));
  return out;
}
/** App usage aggregate over one account's local run history, mirroring the ZCode agent-db snapshot shape. */
export function appUsageSnapshot(db: Db, userId: string, range: string, timeZone: string): AppUsageSnapshot {
  if (!['7d', '30d', 'all'].includes(range)) throw new ApiError('VALIDATION_FAILED', '统计范围无效');
  const tz = resolveTimeZone(timeZone);
  const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = dayFormatter.format(new Date());
  const windowStart = range === 'all' ? null : shiftDayKey(today, -(range === '7d' ? 7 : 30) + 1);
  const inWindow = (day: string | null): day is string => day !== null && (windowStart === null || day >= windowStart && day <= today);

  const totals: UsageTotals = { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    totalInputTokens: 0, knownRequests: 0, unknownRequests: 0, failedRequests: 0, perModel: new Map(), perDayTokens: new Map(), perDayModelTokens: new Map(), ttftSum: 0, ttftSamples: 0 };
  let requestCount = 0;
  for (const raw of db.db.prepare(`SELECT u.provider,u.model,u.status,u.normalized_usage_json,u.ttft_ms,u.completed_at,u.started_at,u.created_at
      FROM usage_entries u JOIN runs r ON r.id=u.run_id JOIN projects p ON p.id=r.project_id WHERE p.owner_user_id=?`).iterate(userId)) {
    const row = raw as unknown as UsageBucketsRow;
    const day = dayKeyInTz(row.completed_at ?? row.started_at ?? row.created_at, tz, dayFormatter);
    if (!inWindow(day)) continue;
    requestCount++;
    accumulateUsage(totals, row, day);
  }
  const conversations = new Set<string>(), conversationSpan = new Map<string, [number, number]>();
  const perDayTurns = new Map<string, number>();
  let turns = 0, turnDurationSum = 0, turnDurationSamples = 0;
  for (const raw of db.db.prepare(`SELECT r.conversation_id,r.created_at,r.ended_at FROM runs r JOIN projects p ON p.id=r.project_id WHERE p.owner_user_id=?`).iterate(userId)) {
    const row = raw as { conversation_id: string; created_at: string; ended_at: string | null };
    const day = dayKeyInTz(row.created_at, tz, dayFormatter);
    if (!inWindow(day)) continue;
    turns++;
    conversations.add(row.conversation_id);
    perDayTurns.set(day!, (perDayTurns.get(day!) ?? 0) + 1);
    const start = Date.parse(row.created_at), end = Date.parse(row.ended_at ?? row.created_at);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      turnDurationSum += end - start; turnDurationSamples++;
      const span = conversationSpan.get(row.conversation_id);
      conversationSpan.set(row.conversation_id, span ? [Math.min(span[0], start), Math.max(span[1], end)] : [start, end]);
    }
  }
  const durations = new Map<string, number>();
  for (const raw of db.db.prepare(`SELECT e.payload_json FROM run_events e JOIN runs r ON r.id=e.run_id JOIN projects p ON p.id=r.project_id
      WHERE p.owner_user_id=? AND e.type='tool.completed'`).iterate(userId)) {
    const payload = JSON.parse((raw as { payload_json: string }).payload_json) as { invocationId?: string; durationMs?: number };
    const duration = count(payload.durationMs);
    if (payload.invocationId && duration !== null) durations.set(payload.invocationId, duration);
  }
  const perDayTools = new Map<string, number>();
  const grouped = new Map<string, { callCount: number; errorCount: number; durations: number[] }>();
  for (const raw of db.db.prepare(`SELECT ti.id,ti.tool_name,ti.state,ti.created_at FROM tool_invocations ti JOIN runs r ON r.id=ti.run_id JOIN projects p ON p.id=r.project_id WHERE p.owner_user_id=?`).iterate(userId)) {
    const row = raw as { id: string; tool_name: string; state: string; created_at: string };
    const day = dayKeyInTz(row.created_at, tz, dayFormatter);
    if (!inWindow(day)) continue;
    perDayTools.set(day!, (perDayTools.get(day!) ?? 0) + 1);
    const tool = grouped.get(row.tool_name) ?? { callCount: 0, errorCount: 0, durations: [] as number[] };
    tool.callCount++;
    if (row.state === 'failed') tool.errorCount++;
    const duration = durations.get(row.id);
    if (duration !== undefined) tool.durations.push(duration);
    grouped.set(row.tool_name, tool);
  }
  const toolUsage: AppUsageToolUsage[] = [...grouped.entries()].map(([toolName, tool]) => ({
    toolName, callCount: tool.callCount, errorCount: tool.errorCount,
    errorRate: tool.callCount ? tool.errorCount / tool.callCount : 0,
    avgDurationMs: tool.durations.length ? tool.durations.reduce((sum, value) => sum + value, 0) / tool.durations.length : null,
  })).sort((a, b) => b.callCount - a.callCount);

  const totalModelTokens = totals.totalTokens;
  const models: AppUsageModelUsage[] = [...totals.perModel.values()]
    .map(model => ({ modelId: model.modelId, totalTokens: model.totalTokens, inputTokens: model.inputTokens, outputTokens: model.outputTokens,
      requestCount: model.requestCount, share: totalModelTokens > 0 ? model.totalTokens / totalModelTokens : 0 }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
  const favorite: AppUsageFavoriteModel | null = models.length ? { modelId: models[0]!.modelId, totalTokens: models[0]!.totalTokens, share: models[0]!.share } : null;
  const activeDays = [...new Set([...totals.perDayTokens.keys(), ...perDayTurns.keys()])];
  const streaks = buildStreaks(activeDays, today);
  let longestSessionMs = 0;
  for (const [start, end] of conversationSpan.values()) longestSessionMs = Math.max(longestSessionMs, end - start);
  const toolCallCount = [...grouped.values()].reduce((sum, tool) => sum + tool.callCount, 0);
  const toolErrorCount = [...grouped.values()].reduce((sum, tool) => sum + tool.errorCount, 0);
  return {
    range: range as AppUsageRange, generatedAt: Date.now(), timeZone: tz, source: 'agent-db',
    summary: {
      totalTokens: totals.totalTokens, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens,
      reasoningTokens: totals.reasoningTokens, cacheCreationTokens: totals.cacheCreationTokens, cacheReadTokens: totals.cacheReadTokens,
      cacheHitRate: totals.totalInputTokens > 0 ? totals.cacheReadTokens / totals.totalInputTokens : 0,
      totalSessions: conversations.size, totalTurns: turns, toolCallCount,
      toolErrorRate: toolCallCount ? toolErrorCount / toolCallCount : 0,
      modelErrorRate: requestCount ? totals.failedRequests / requestCount : 0,
      avgTimeToFirstTokenMs: totals.ttftSamples ? totals.ttftSum / totals.ttftSamples : null,
      avgTurnDurationMs: turnDurationSamples ? turnDurationSum / turnDurationSamples : null,
      activeDays: activeDays.length, currentStreakDays: streaks.current,
      longestSessionMs, longestStreakDays: streaks.longest,
      peakDayTokens: Math.max(0, ...[...totals.perDayTokens.values()]), favoriteModel: favorite,
    },
    heatmap: buildHeatmap(totals.perDayTokens, perDayTurns, perDayTools),
    dailyModelUsage: buildDailyModelUsage(totals, range as AppUsageRange, today),
    models, tools: toolUsage, unknownRequests: totals.unknownRequests,
  };
}

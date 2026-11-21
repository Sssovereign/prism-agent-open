import type { BucketCoverage, UsageBuckets, UsageSnapshot } from '../../contracts/usage.js';

/** UI boundary also accepts the pre-conversation projection during an in-flight upgrade. */
export interface LegacyUsage {
  totals: { requests: number; unknownCount: number; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number };
  context: { tokens: number | null; window: number | null; reserveTokens: number };
  speed: { sessionTokPerMs: number | null; lastTurnTokPerMs: number | null; samples: number };
}
export type Availability = 'known' | 'partial' | 'unknown';
export interface Metric { value: number | null; availability: Availability; known: number; unknown: number }
export const finiteCount = (n: unknown): number | null => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
export function formatTokens(n: number | null | undefined): string {
  const v = finiteCount(n);
  if (v === null) return '—';
  if (v < 1000) return String(Math.round(v));
  const unit = v >= 999950 ? 1_000_000 : 1000;
  return `${Number((v / unit).toFixed(1))}${unit === 1000 ? 'k' : 'M'}`;
}
export function formatExact(n: number | null | undefined): string {
  const v = finiteCount(n); return v === null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(v);
}
export function formatRate(tokPerMs: number | null | undefined): string {
  const v = finiteCount(tokPerMs); return v === null ? '—' : `${Number((v * 1000).toFixed(1))} tok/s`;
}
export function formatDuration(ms: number | null | undefined): string {
  const v = finiteCount(ms); if (v === null) return '—';
  if (v < 60000) return `${Number((v / 1000).toFixed(1))}s`;
  const s = Math.round(v / 1000); return `${Math.floor(s / 60)}m${s % 60}s`;
}
export function metric(value: unknown, coverage?: BucketCoverage, requests = 0): Metric {
  const n = finiteCount(value);
  const known = coverage ? coverage.knownRequests : n === null ? 0 : requests;
  const unknown = coverage ? coverage.unknownRequests : n === null ? requests : 0;
  return { value: n === null || known === 0 ? null : n, availability: n === null || known === 0 ? 'unknown' : unknown > 0 ? 'partial' : 'known', known, unknown };
}
export function metricText(m: Metric, exact = false): string {
  return `${exact ? formatExact(m.value) : formatTokens(m.value)}${m.availability === 'partial' ? '+' : ''}`;
}
export function cachePercent(read: Metric, input: Metric): string | null {
  if (read.availability !== 'known' || input.availability !== 'known' || read.value === null || input.value === null || input.value <= 0 || read.value > input.value) return null;
  if (read.value === input.value) return '100';
  // Do not round a nearly-full hit to a false 100%.
  return String(Math.min(99.9, Math.round(read.value / input.value * 1000) / 10));
}
export function contextPercent(tokens: unknown, window: unknown): number | null {
  const n = finiteCount(tokens), w = finiteCount(window);
  return n === null || w === null || w === 0 ? null : Math.round(n / w * 100);
}
export function adaptUsage(raw: UsageSnapshot | LegacyUsage | null | undefined) {
  const modern = raw && 'scope' in raw ? raw : null;
  const t = raw?.totals;
  const requests = t?.requests ?? 0;
  const legacyCoverage: BucketCoverage = { knownRequests: Math.max(0, requests - (t?.unknownCount ?? requests)), unknownRequests: t?.unknownCount ?? requests };
  const get = (value: unknown, key: keyof UsageBuckets) => metric(value, modern?.totals.coverage[key] ?? legacyCoverage, requests);
  const input = get(modern ? modern.totals.uncachedInputTokens : t?.inputTokens, 'input');
  const output = get(t?.outputTokens, 'output');
  // Legacy cache defaults have no field evidence. Never turn them into a measured zero.
  const read = modern ? get(t?.cacheReadTokens, 'cacheRead') : metric(null, undefined, requests);
  const write = modern ? get(t?.cacheWriteTokens, 'cacheWrite') : metric(null, undefined, requests);
  const reasoning = modern ? get(t?.reasoningTokens, 'reasoning') : metric(null, undefined, requests);
  const totalInput = modern ? get(modern.totals.totalInputTokens, 'totalInput') : metric(null, undefined, requests);
  const totalValue = modern?.totals.totalTokens;
  const total = metric(totalValue, modern ? { knownRequests: requests - modern.totals.unknownCount, unknownRequests: modern.totals.unknownCount } : undefined, requests);
  const pct = contextPercent(raw?.context.tokens, raw?.context.window);
  return {
    activity: modern?.activity ?? null, byKind: modern?.byKind ?? [],
    scope: modern ? '会话累计' : '任务累计', requests: raw ? requests : null, input, output, read, write, reasoning, totalInput, total,
    cacheHit: cachePercent(read, totalInput),
    lastCacheHit: modern?.lastRequest ? cachePercent(metric(modern.lastRequest.cacheRead, undefined, 1), metric(modern.lastRequest.totalInputTokens, undefined, 1)) : null,
    incompleteRequests: modern?.totals.unknownCount ?? null,
    lastRate: modern ? modern.speed.lastRequestTokPerMs : raw?.speed.lastTurnTokPerMs ?? null,
    sessionRate: raw?.speed.sessionTokPerMs ?? null, samples: raw?.speed.samples ?? null,
    context: { tokens: raw?.context.tokens ?? null, window: raw?.context.window ?? null, percent: pct, ringPercent: pct === null ? null : Math.max(0, Math.min(100, pct)), reserve: raw?.context.reserveTokens ?? null, measuredAt: modern?.context.measuredAt ?? null, requestId: modern?.context.requestId ?? null, runId: modern?.context.runId ?? null, estimated: modern?.context.estimated ?? false },
    lastRequest: modern?.lastRequest ?? null, byModel: modern?.byModel ?? [], recentRequests: modern?.requests ?? [], requestPage: modern?.requestPage ?? null,
  };
}
export type UsageView = ReturnType<typeof adaptUsage>;

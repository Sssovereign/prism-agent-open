/** App usage view-model helpers, ported from ZCode usageStatsUiParts / UsageHeatmap /
 * appUsageModelPieChartViewModel / AppUsageDailyModelTrendChart (snapshot 2026-11-12). */
import type { AppUsageSnapshot, AppUsageHeatmapCell, AppUsageHeatmapWeek } from '../../contracts/appUsage.js';

export const APP_USAGE_MODEL_CHART_COLORS = [1, 2, 3, 4, 5, 6].map(i => `var(--color-usage-chart-${i})`);
export function getAppUsageModelChartColor(index: number): string {
  return APP_USAGE_MODEL_CHART_COLORS[index % APP_USAGE_MODEL_CHART_COLORS.length]!;
}
export const MAX_APP_USAGE_MODEL_PIE_SLICES = 6;
const DAY_MS = 86_400_000;

export function formatCompactTokenNumber(value: number, maximumFractionDigits = 1): string {
  if (!Number.isFinite(value)) return '';
  return new Intl.NumberFormat('zh-CN', { notation: Math.abs(value) >= 1000 ? 'compact' : 'standard', maximumFractionDigits, minimumFractionDigits: 0 }).format(value);
}
export const formatCompactTokenUsage = (value: number): string => formatCompactTokenNumber(value);
/** 摘要卡片与相邻的时长、天数指标统一保留中文单位与数字之间的空格。 */
export function formatSummaryCompactTokenUsage(value: number): string {
  return formatCompactTokenUsage(value).replace(/(?<=\d)(?=[万亿])/u, ' ');
}
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '--';
  return new Intl.NumberFormat('zh-CN', { notation: value >= 1000 ? 'compact' : 'standard', maximumFractionDigits: value >= 1000 ? 1 : 0 }).format(value);
}
export function formatPercent(value: number): string {
  return new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: value >= 0.1 ? 0 : 1 }).format(value);
}
function dateKeyToDate(dateKey: string | null): Date | null {
  if (!dateKey) return null;
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}
export function formatDay(dateKey: string | null): string {
  const date = dateKeyToDate(dateKey);
  return date ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(date) : dateKey ?? '--';
}
export function formatFullDay(dateKey: string | null): string {
  const date = dateKeyToDate(dateKey);
  return date ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' }).format(date) : dateKey ?? '--';
}
export function formatMonth(dateKey: string): string {
  const date = dateKeyToDate(dateKey);
  return date ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: 'short' }).format(date) : dateKey.slice(5, 7);
}
export function formatAppUsageDuration(durationMs: number): string {
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60)), hours = Math.floor((totalMinutes % (24 * 60)) / 60), minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes} 分钟`);
  return parts.join(' ');
}
export const formatAppUsageDays = (days: number): string => `${formatCompactNumber(days)} 天`;
export const resolveModelLabel = (modelId: string | null): string => modelId?.trim() || '未知模型';

/* ===== 热力图（UsageHeatmap.tsx 移植） ===== */
export type TokenActivityMode = 'daily' | 'weekly' | 'cumulative';
export const HEATMAP_DISPLAY_WEEK_COUNT = 52;
const HEATMAP_DAYS_PER_WEEK = 7;
const HEATMAP_VISIBLE_MONTH_LABEL_COUNT = 12;
export interface HeatmapDisplayCell { key: string; tooltipTitle?: string; level: number; hasUsage: boolean; columnHover: boolean }
export interface HeatmapDisplayColumn { key: string; monthDate: string; tooltipTitle: string | null; cells: HeatmapDisplayCell[] }
export interface HeatmapMonthLabel { key: string; label: string; span: number }

function dateKeyToUtcDayIndex(dateKey: string): number | null {
  const date = dateKeyToDate(dateKey);
  return date ? Math.floor(date.getTime() / DAY_MS) : null;
}
function getUtcWeekday(dayIndex: number): number { return new Date(dayIndex * DAY_MS).getUTCDay(); }
function utcDayIndexToDateKey(dayIndex: number): string { return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10); }
function createEmptyHeatmapCell(date: string): AppUsageHeatmapCell { return { date, level: 0, totalTokens: 0, turnCount: 0, toolCallCount: 0 }; }

/** agent 只返回有活动的日期；按自然周（周日起）补齐 52 周展示用 0 格。 */
export function buildDisplayHeatmapWeeks(weeks: AppUsageHeatmapWeek[]): AppUsageHeatmapWeek[] {
  const dated = weeks.flatMap(week => week.days).filter((cell): cell is AppUsageHeatmapCell => cell !== null)
    .map(cell => ({ cell, dayIndex: dateKeyToUtcDayIndex(cell.date) })).filter((e): e is { cell: AppUsageHeatmapCell; dayIndex: number } => e.dayIndex !== null);
  if (!dated.length) return weeks;
  const cellsByDate = new Map(dated.map(({ cell }) => [cell.date, cell] as const));
  const endDayIndex = Math.max(...dated.map(({ dayIndex }) => dayIndex));
  const startDayIndex = endDayIndex - getUtcWeekday(endDayIndex) - (HEATMAP_DISPLAY_WEEK_COUNT - 1) * HEATMAP_DAYS_PER_WEEK;
  return Array.from({ length: HEATMAP_DISPLAY_WEEK_COUNT }, (_, weekIndex) => ({
    weekIndex,
    days: Array.from({ length: HEATMAP_DAYS_PER_WEEK }, (_, dayOffset) => {
      const date = utcDayIndexToDateKey(startDayIndex + weekIndex * HEATMAP_DAYS_PER_WEEK + dayOffset);
      return cellsByDate.get(date) ?? createEmptyHeatmapCell(date);
    }),
  }));
}
function levelForValue(value: number, max: number): number {
  return value <= 0 || max <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(value / max * 4)));
}
function filledRowsForValue(value: number, max: number): number {
  return value <= 0 || max <= 0 ? 0 : Math.min(HEATMAP_DAYS_PER_WEEK, Math.max(1, Math.ceil(value / max * HEATMAP_DAYS_PER_WEEK)));
}
function resolveHeatmapColumnMonthDate(week: AppUsageHeatmapWeek): string {
  // 周列包含 1 日时优先归入新月份，月份文案锚定到 1 日所在列。
  return week.days.find(cell => cell?.date.endsWith('-01'))?.date ?? week.days[0]?.date ?? week.days.find(Boolean)?.date ?? '';
}
const cellTooltipTitle = (cell: AppUsageHeatmapCell): string =>
  `${formatFullDay(cell.date)}\n${formatCompactTokenUsage(cell.totalTokens)} tokens · ${formatCompactNumber(cell.turnCount)} 轮消息`;
export function buildDailyHeatmapColumns(weeks: AppUsageHeatmapWeek[]): HeatmapDisplayColumn[] {
  return weeks.map(week => ({
    key: `daily-${week.weekIndex}`,
    monthDate: resolveHeatmapColumnMonthDate(week),
    tooltipTitle: null,
    cells: week.days.map((cell, dayOffset) => {
      const displayCell = cell ?? createEmptyHeatmapCell(week.days[0]?.date ?? `empty-${week.weekIndex}-${dayOffset}`);
      return { key: `daily-${displayCell.date}`, level: displayCell.level, hasUsage: displayCell.totalTokens > 0, columnHover: false, tooltipTitle: cellTooltipTitle(displayCell) };
    }),
  }));
}
export function buildWeeklyLikeHeatmapColumns(weeks: AppUsageHeatmapWeek[], mode: 'weekly' | 'cumulative'): HeatmapDisplayColumn[] {
  const weeklyTotals = weeks.map(week => week.days.reduce((sum, cell) => sum + (cell?.totalTokens ?? 0), 0));
  const weeklyCounts = weeks.map(week => week.days.reduce((sum, cell) => sum + (cell?.turnCount ?? 0), 0));
  const values = mode === 'weekly' ? weeklyTotals : weeklyTotals.reduce<number[]>((acc, total) => { acc.push((acc.at(-1) ?? 0) + total); return acc; }, []);
  const countValues = mode === 'weekly' ? weeklyCounts : weeklyCounts.reduce<number[]>((acc, total) => { acc.push((acc.at(-1) ?? 0) + total); return acc; }, []);
  const maxValue = Math.max(0, ...values);
  return weeks.map((week, weekIndex) => {
    const value = values[weekIndex] ?? 0, count = countValues[weekIndex] ?? 0;
    const level = levelForValue(value, maxValue), filledRows = filledRowsForValue(value, maxValue);
    const weekEndDate = week.days[HEATMAP_DAYS_PER_WEEK - 1]?.date ?? [...week.days].reverse().find(cell => cell !== null)?.date ?? '';
    const prefix = mode === 'weekly' ? `${formatFullDay(weekEndDate)} 当周` : `截至 ${formatFullDay(weekEndDate)} 当周累计`;
    return {
      key: `${mode}-${week.weekIndex}`,
      monthDate: resolveHeatmapColumnMonthDate(week) || weekEndDate,
      tooltipTitle: `${prefix}\n${formatCompactTokenUsage(value)} tokens · ${formatCompactNumber(count)} 轮消息`,
      cells: week.days.map((cell, dayOffset) => {
        const isFilled = dayOffset >= HEATMAP_DAYS_PER_WEEK - filledRows;
        return { key: `${mode}-${cell?.date ?? `${week.weekIndex}-${dayOffset}`}`, level: isFilled ? level : 0, hasUsage: isFilled && value > 0, columnHover: true };
      }),
    };
  });
}
export function buildHeatmapDisplayColumns(weeks: AppUsageHeatmapWeek[], mode: TokenActivityMode): HeatmapDisplayColumn[] {
  return mode === 'daily' ? buildDailyHeatmapColumns(weeks) : buildWeeklyLikeHeatmapColumns(weeks, mode);
}
export function buildHeatmapMonthLabels(columns: HeatmapDisplayColumn[]): HeatmapMonthLabel[] {
  const labels: HeatmapMonthLabel[] = [];
  for (const column of columns) {
    const monthKey = column.monthDate.slice(0, 7);
    const last = labels.at(-1);
    if (last?.key === monthKey) last.span += 1;
    else labels.push({ key: monthKey, label: formatMonth(column.monthDate), span: 1 });
  }
  // 52 个自然周可能横跨 13 个月：保留起始月份 span 维持对齐，只隐藏文字，底部最多 12 个月。
  for (let index = 0; index < Math.max(0, labels.length - HEATMAP_VISIBLE_MONTH_LABEL_COUNT); index++) labels[index]!.label = '';
  return labels;
}

/* ===== 每日模型趋势图（AppUsageDailyModelTrendChart.tsx 移植） ===== */
export interface TrendModelKey { modelId: string | null; key: string; color: string; label: string }
export interface DailyModelChartRow { label: string; tooltipLabel: string; total: number; [modelKey: string]: number | string }
export function shouldShowDailyChartAxisLabel(index: number, total: number): boolean {
  if (total <= 14) return true;
  const step = total > 45 ? 7 : 5;
  return index === 0 || index === total - 1 || index % step === 0;
}
export function buildAppUsageDailyModelChartViewModel(snapshot: AppUsageSnapshot) {
  const topModels = snapshot.models.slice(0, 6);
  const modelKeys: TrendModelKey[] = topModels.map((model, index) => ({ modelId: model.modelId, key: `model${index}`, color: getAppUsageModelChartColor(index), label: resolveModelLabel(model.modelId) }));
  const modelKeyById = new Map(modelKeys.map(model => [model.modelId ?? '__unknown__', model.key]));
  const rows = new Map<string, DailyModelChartRow>();
  for (const day of snapshot.dailyModelUsage) {
    const label = formatDay(day.date);
    const row = rows.get(day.date) ?? { label, tooltipLabel: label, total: 0 };
    for (const model of day.models) {
      const key = modelKeyById.get(model.modelId ?? '__unknown__');
      if (key) row[key] = Number(row[key] ?? 0) + model.totalTokens;
      row.total += model.totalTokens;
    }
    rows.set(day.date, row);
  }
  const chartData = [...rows.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, row]) => row);
  // 图中是独立折线而非堆叠图：Y 轴上限只跟随可见序列的单点峰值。
  let maxTokens = 0;
  for (const row of chartData) for (const model of modelKeys) maxTokens = Math.max(maxTokens, Number(row[model.key] ?? 0));
  return { topModels, modelKeys, chartData, maxTokens };
}

/* ===== 模型用量饼图（appUsageModelPieChartViewModel.ts 移植） ===== */
export interface AppUsageModelPieSlice { key: string; label: string; color: string; totalTokens: number; share: number }
export function buildAppUsageModelPieChartViewModel(snapshot: AppUsageSnapshot) {
  const positiveModels = snapshot.models.filter(model => model.totalTokens > 0);
  const totalModelTokens = positiveModels.reduce((sum, model) => sum + model.totalTokens, 0);
  const shouldMergeOther = positiveModels.length > MAX_APP_USAGE_MODEL_PIE_SLICES;
  const modelSliceLimit = shouldMergeOther ? MAX_APP_USAGE_MODEL_PIE_SLICES - 1 : MAX_APP_USAGE_MODEL_PIE_SLICES;
  const modelSlices: AppUsageModelPieSlice[] = positiveModels.slice(0, modelSliceLimit).map((model, index) => ({
    key: `model${index}`, label: resolveModelLabel(model.modelId), color: getAppUsageModelChartColor(index),
    totalTokens: model.totalTokens, share: totalModelTokens > 0 ? model.totalTokens / totalModelTokens : 0,
  }));
  const otherTotal = positiveModels.slice(modelSliceLimit).reduce((sum, model) => sum + model.totalTokens, 0);
  const otherSlice: AppUsageModelPieSlice[] = otherTotal > 0
    ? [{ key: `model${modelSliceLimit}`, label: '其他模型', color: getAppUsageModelChartColor(modelSliceLimit), totalTokens: otherTotal, share: totalModelTokens > 0 ? otherTotal / totalModelTokens : 0 }]
    : [];
  const chartData = [...modelSlices, ...otherSlice];
  return { chartData, totalModelTokens };
}

/* ===== 趋势折线的 monotone-X 曲线（d3-shape curveMonotoneX 同款） ===== */
export function monotonePath(points: Array<{ x: number; y: number }>): string {
  const n = points.length;
  if (!n) return '';
  if (n === 1) return `M${points[0]!.x},${points[0]!.y}`;
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) slopes.push((points[i + 1]!.y - points[i]!.y) / (points[i + 1]!.x - points[i]!.x || 1e-6));
  const tangents: number[] = [slopes[0]!];
  for (let i = 1; i < n - 1; i++) {
    const before = slopes[i - 1]!, after = slopes[i]!;
    let t = (before + after) / 2;
    if (before * after <= 0) t = 0;
    else { const limit = 3 * Math.min(Math.abs(before), Math.abs(after)); t = Math.max(-limit, Math.min(limit, t)); }
    tangents.push(t);
  }
  tangents.push(slopes.at(-1)!);
  let path = `M${points[0]!.x},${points[0]!.y}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = (points[i + 1]!.x - points[i]!.x) / 3;
    path += `C${points[i]!.x + dx},${points[i]!.y + tangents[i]! * dx} ${points[i + 1]!.x - dx},${points[i + 1]!.y - tangents[i + 1]! * dx} ${points[i + 1]!.x},${points[i + 1]!.y}`;
  }
  return path;
}

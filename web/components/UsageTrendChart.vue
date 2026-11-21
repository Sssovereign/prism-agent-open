<script setup lang="ts">
/** Vue adaptation of ZCode AppUsageDailyModelTrendChart (recharts LineChart → hand-rolled SVG, monotone-X lines). */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { AppUsageSnapshot } from '../../contracts/appUsage.js';
import { buildAppUsageDailyModelChartViewModel, formatCompactTokenUsage, getAppUsageModelChartColor, monotonePath, shouldShowDailyChartAxisLabel } from '../view-model/appUsage';
const props = defineProps<{ snapshot: AppUsageSnapshot }>();
// React 版每次渲染 useMemo 重算；Vue 侧必须包 computed，区间切换时 snapshot 换对象才能重算（模板内 ref 自动解包）。
const chartVm = computed(() => buildAppUsageDailyModelChartViewModel(props.snapshot));
const topModels = computed(() => chartVm.value.topModels);
const modelKeys = computed(() => chartVm.value.modelKeys);
const chartData = computed(() => chartVm.value.chartData);
const maxTokens = computed(() => chartVm.value.maxTokens);
const container = ref<HTMLElement>(), width = ref(0);
let observer: ResizeObserver | undefined;
onMounted(() => {
  observer = new ResizeObserver(entries => { width.value = entries[0]?.contentRect.width ?? 0; });
  if (container.value) observer.observe(container.value);
});
onBeforeUnmount(() => observer?.disconnect());
// recharts XAxis 默认高度 30、tickMargin 8；左右 24px 安全区防首尾日期被裁。
const HEIGHT = 240, MARGIN = { top: 8, right: 24, left: 24 }, AXIS_HEIGHT = 30;
const plotWidth = computed(() => Math.max(0, width.value - MARGIN.left - MARGIN.right));
const plotHeight = HEIGHT - MARGIN.top - AXIS_HEIGHT;
const yTicks = computed(() => [0, 1, 2, 3, 4].map(i => Math.max(0, maxTokens.value) * i / 4));
const xAt = (index: number): number => chartData.value.length <= 1 ? MARGIN.left + plotWidth.value / 2 : MARGIN.left + index * plotWidth.value / (chartData.value.length - 1);
const yAt = (value: number): number => MARGIN.top + plotHeight - (maxTokens.value > 0 ? value / maxTokens.value * plotHeight : 0);
const hoverIndex = ref<number | null>(null);
function onMove(event: PointerEvent): void {
  if (!chartData.value.length || !plotWidth.value) return;
  const x = event.clientX - (event.currentTarget as HTMLElement).getBoundingClientRect().left;
  const index = chartData.value.length <= 1 ? 0 : Math.round((x - MARGIN.left) / (plotWidth.value / (chartData.value.length - 1)));
  hoverIndex.value = Math.max(0, Math.min(chartData.value.length - 1, index));
}
const tooltipRows = computed(() => {
  const row = hoverIndex.value === null ? null : chartData.value[hoverIndex.value];
  if (!row) return [];
  return modelKeys.value.map(model => ({ ...model, value: Number(row[model.key] ?? 0) })).filter(item => item.value > 0);
});
const tooltipLabel = computed(() => hoverIndex.value === null ? '' :
  `${chartData.value[hoverIndex.value]!.tooltipLabel} - ${formatCompactTokenUsage(chartData.value[hoverIndex.value]!.total)} tokens`);
const tooltipStyle = computed(() => {
  const boxWidth = 220, x = hoverIndex.value === null ? 0 : xAt(hoverIndex.value);
  return { left: `${Math.max(0, Math.min(x - boxWidth / 2, width.value - boxWidth))}px`, top: `${MARGIN.top + 8}px` };
});
</script>
<template>
  <section class="trend-card">
    <h3>每日 Token 趋势图</h3>
    <div v-if="maxTokens <= 0" class="empty-state">
      <div class="empty-title">还没有可展示的数据</div>
      <div class="empty-desc">当前区间暂无可展示的用量数据。</div>
    </div>
    <div v-else class="trend-body">
      <div class="legend" role="list">
        <div v-for="(model, index) in topModels" :key="model.modelId ?? '__unknown__'" class="legend-item" role="listitem">
          <span class="legend-swatch" :style="{ background: getAppUsageModelChartColor(index) }" />
          <span class="legend-label">{{ model.modelId?.trim() || '未知模型' }}</span>
        </div>
      </div>
      <div ref="container" class="chart-box">
        <svg v-if="plotWidth > 0" :width="width" :height="HEIGHT" class="chart-svg">
          <line v-for="tick in yTicks" :key="`grid-${tick}`" :x1="MARGIN.left" :x2="MARGIN.left + plotWidth" :y1="yAt(tick)" :y2="yAt(tick)" stroke="var(--border)" stroke-dasharray="3 3" />
          <text v-for="(row, index) in chartData" :key="`x-${index}`" v-show="shouldShowDailyChartAxisLabel(index, chartData.length)"
            :x="xAt(index)" :y="MARGIN.top + plotHeight + 20" class="axis-text" text-anchor="middle">{{ row.label }}</text>
          <path v-for="model in modelKeys" :key="model.key"
            :d="monotonePath(chartData.map((row, index) => ({ x: xAt(index), y: yAt(Number(row[model.key] ?? 0)) })))"
            fill="none" :stroke="model.color" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          <template v-if="hoverIndex !== null">
            <circle v-for="model in modelKeys" :key="`dot-${model.key}`" :cx="xAt(hoverIndex)" :cy="yAt(Number(chartData[hoverIndex]![model.key] ?? 0))" r="4" :fill="model.color" />
          </template>
          <rect :x="MARGIN.left" :y="MARGIN.top" :width="plotWidth" :height="plotHeight + AXIS_HEIGHT" fill="transparent"
            @pointermove="onMove" @pointerleave="hoverIndex = null" />
        </svg>
        <div v-if="hoverIndex !== null && tooltipRows.length" class="chart-tooltip" :style="tooltipStyle">
          <div class="tooltip-label">{{ tooltipLabel }}</div>
          <div v-for="item in tooltipRows" :key="item.key" class="tooltip-row">
            <span class="tooltip-dot" :style="{ background: item.color }" />
            <span class="tooltip-name">{{ item.label }}</span>
            <span class="tooltip-value"><b>{{ formatCompactTokenUsage(item.value) }}</b><i>tokens</i></span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
<style scoped>
.trend-card{display:flex;flex-direction:column;gap:12px;border-radius:12px;background:var(--color-surface);padding:16px}
.trend-card h3{font-size:var(--text-ui-base);font-weight:500;color:var(--fg)}
.trend-body{padding:12px 12px}
.legend{display:flex;flex-wrap:wrap;align-items:center;column-gap:12px;row-gap:8px;margin-bottom:12px}
.legend-item{display:flex;min-width:0;align-items:center;gap:8px;font-size:var(--text-ui-sm)}
.legend-swatch{width:10px;height:10px;flex:none;border-radius:2px}
.legend-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg-subtle)}
.chart-box{position:relative;height:240px;width:100%}
.chart-svg{display:block}
.axis-text{font-size:var(--text-ui-sm);fill:var(--fg-subtle)}
.empty-state{border:1px dashed var(--border);border-radius:12px;padding:40px 16px;text-align:center}
.empty-title{font-size:var(--text-ui-base);font-weight:500;color:var(--fg)}
.empty-desc{margin-top:8px;font-size:var(--text-ui-base);color:var(--fg-subtle)}
.chart-tooltip{position:absolute;z-index:30;pointer-events:none;min-width:180px;max-width:min(448px,calc(100vw - 16px));padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--bg-panel);box-shadow:0 4px 16px rgb(0 0 0/.14);font-size:var(--text-ui-sm)}
.tooltip-label{margin-bottom:6px;font-weight:500;color:var(--fg)}
.tooltip-row{display:flex;align-items:center;gap:8px;padding:2px 0}
.tooltip-dot{width:8px;height:8px;flex:none;border-radius:9999px}
.tooltip-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg-subtle)}
.tooltip-value{display:flex;align-items:baseline;gap:4px;color:var(--fg)}
.tooltip-value b{font-family:var(--font-mono);font-weight:500;font-variant-numeric:tabular-nums}
.tooltip-value i{font-style:normal;color:var(--fg-subtle)}
</style>

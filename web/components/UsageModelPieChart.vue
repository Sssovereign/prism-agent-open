<script setup lang="ts">
/** Vue adaptation of ZCode AppUsageModelUsagePieChart (recharts PieChart donut → hand-rolled SVG arcs). */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { AppUsageSnapshot } from '../../contracts/appUsage.js';
import { buildAppUsageModelPieChartViewModel, formatCompactTokenUsage, formatPercent, type AppUsageModelPieSlice } from '../view-model/appUsage';
const props = defineProps<{ snapshot: AppUsageSnapshot }>();
// 同趋势图：视图模型必须随 snapshot prop 重算，包 computed（模板内 ref 自动解包）。
const pieVm = computed(() => buildAppUsageModelPieChartViewModel(props.snapshot));
const chartData = computed(() => pieVm.value.chartData);
const totalModelTokens = computed(() => pieVm.value.totalModelTokens);
const container = ref<HTMLElement>(), side = ref(0);
let observer: ResizeObserver | undefined;
onMounted(() => {
  observer = new ResizeObserver(entries => {
    const box = entries[0]?.contentRect;
    side.value = Math.min(box?.width ?? 0, box?.height ?? 0);
  });
  if (container.value) observer.observe(container.value);
});
onBeforeUnmount(() => observer?.disconnect());
const cx = computed(() => side.value / 2), cy = computed(() => side.value / 2);
const outerR = computed(() => side.value * 0.86 / 2), innerR = computed(() => side.value * 0.56 / 2);

// recharts Pie：12 点钟方向起、顺时针；相邻扇区间隔 paddingAngle 2°（单扇区不加）。
const slices = computed(() => {
  const total = chartData.value.reduce((sum, slice) => sum + slice.totalTokens, 0);
  let angle = 0;
  const padding = chartData.value.length > 1 ? 2 : 0;
  return chartData.value.map(slice => {
    const sweep = total > 0 ? slice.totalTokens / total * (360 - padding * chartData.value.length) : 0;
    const start = (angle + padding / 2 - 90) * Math.PI / 180;
    const end = (angle + sweep + padding / 2 - 90) * Math.PI / 180;
    angle += sweep + padding;
    return { ...slice, start, end };
  });
});
function arcPath(start: number, end: number): string {
  const large = end - start > Math.PI ? 1 : 0;
  const x0 = cx.value + outerR.value * Math.cos(start), y0 = cy.value + outerR.value * Math.sin(start);
  const x1 = cx.value + outerR.value * Math.cos(end), y1 = cy.value + outerR.value * Math.sin(end);
  const x2 = cx.value + innerR.value * Math.cos(end), y2 = cy.value + innerR.value * Math.sin(end);
  const x3 = cx.value + innerR.value * Math.cos(start), y3 = cy.value + innerR.value * Math.sin(start);
  return `M${x0},${y0}A${outerR.value},${outerR.value} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${innerR.value},${innerR.value} 0 ${large} 0 ${x3},${y3}Z`;
}
const hovered = ref<AppUsageModelPieSlice | null>(null), hoverPos = ref({ x: 0, y: 0 });
function onSliceMove(event: PointerEvent, slice: AppUsageModelPieSlice): void {
  hovered.value = slice;
  const svg = (event.currentTarget as unknown as { ownerSVGElement?: SVGSVGElement }).ownerSVGElement;
  const rect = svg?.getBoundingClientRect();
  hoverPos.value = { x: rect ? event.clientX - rect.left : 0, y: rect ? event.clientY - rect.top : 0 };
}
const tooltipStyle = computed(() => ({ left: `${Math.max(0, hoverPos.value.x - 110)}px`, top: `${Math.max(0, hoverPos.value.y - 76)}px` }));
</script>
<template>
  <section class="pie-card">
    <h3>模型用量</h3>
    <div v-if="totalModelTokens <= 0" class="empty-state">
      <div class="empty-title">还没有可展示的数据</div>
      <div class="empty-desc">当前区间暂无可展示的用量数据。</div>
    </div>
    <div v-else class="pie-body">
      <div class="pie-area">
        <div ref="container" class="pie-box">
          <svg v-if="side > 0" :width="side" :height="side" class="pie-svg">
            <path v-for="slice in slices" :key="slice.key" :d="arcPath(slice.start, slice.end)" :fill="slice.color"
              stroke="var(--color-surface)" stroke-width="2" @pointermove="event => onSliceMove(event, slice)" @pointerleave="hovered = null" />
          </svg>
          <div class="pie-center">
            <div class="pie-center-total">{{ formatCompactTokenUsage(totalModelTokens) }}</div>
            <div class="pie-center-unit">tokens</div>
          </div>
        </div>
      </div>
      <div class="pie-legend" role="list">
        <div v-for="slice in chartData" :key="slice.key" class="legend-row" role="listitem">
          <span class="legend-dot" :style="{ background: slice.color }" />
          <span class="legend-label">{{ slice.label }}</span>
          <span class="legend-share">{{ formatPercent(slice.share) }}</span>
          <span class="legend-tokens">{{ formatCompactTokenUsage(slice.totalTokens) }} tokens</span>
        </div>
      </div>
    </div>
    <div v-if="hovered" class="chart-tooltip" :style="tooltipStyle">
      <div class="tooltip-row">
        <span class="tooltip-dot" :style="{ background: hovered.color }" />
        <span class="tooltip-name">{{ hovered.label }}</span>
      </div>
      <div class="tooltip-metrics">
        <span class="tooltip-value"><b>{{ formatCompactTokenUsage(hovered.totalTokens) }}</b><i>tokens</i></span>
        <span class="tooltip-share">{{ formatPercent(hovered.share) }}</span>
      </div>
    </div>
  </section>
</template>
<style scoped>
.pie-card{position:relative;display:flex;flex-direction:column;gap:12px;border-radius:12px;background:var(--color-surface);padding:16px}
.pie-card h3{font-size:var(--text-ui-base);font-weight:500;color:var(--fg)}
.pie-body{display:grid;gap:16px;padding:12px 12px}
@media(min-width:768px){.pie-body{grid-template-columns:repeat(2,minmax(0,1fr))}}
.pie-area{display:flex;align-items:center;justify-content:center;min-width:0}
.pie-box{position:relative;height:224px;width:100%;max-width:256px}
@media(min-width:768px){.pie-box{height:256px;max-width:288px}}
.pie-svg{display:block}
.pie-center{pointer-events:none;position:absolute;inset:0;z-index:10;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 32px;text-align:center}
.pie-center-total{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-ui-sm);font-weight:600;color:var(--fg)}
.pie-center-unit{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-ui-sm);color:var(--fg-subtle)}
.pie-legend{min-width:0;align-self:center}
.legend-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;column-gap:8px;row-gap:4px;padding:8px 0;border-bottom:1px solid color-mix(in oklab,var(--border) 70%,transparent)}
.legend-row:last-child{border-bottom:0}
.legend-dot{width:10px;height:10px;flex:none;border-radius:2px}
.legend-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono);font-size:var(--text-ui-sm);color:var(--fg)}
.legend-share{font-family:var(--font-mono);font-size:var(--text-ui-sm);color:var(--fg-subtle);font-variant-numeric:tabular-nums}
.legend-tokens{grid-column-start:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-ui-sm);color:var(--fg-subtle)}
.empty-state{border:1px dashed var(--border);border-radius:12px;padding:40px 16px;text-align:center}
.empty-title{font-size:var(--text-ui-base);font-weight:500;color:var(--fg)}
.empty-desc{margin-top:8px;font-size:var(--text-ui-base);color:var(--fg-subtle)}
.chart-tooltip{position:absolute;z-index:30;pointer-events:none;min-width:180px;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--bg-panel);box-shadow:0 4px 16px rgb(0 0 0/.14);font-size:var(--text-ui-sm)}
.tooltip-row{display:flex;align-items:center;gap:8px}
.tooltip-dot{width:8px;height:8px;flex:none;border-radius:9999px}
.tooltip-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg-subtle)}
.tooltip-metrics{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-top:4px}
.tooltip-value{display:flex;align-items:baseline;gap:4px;color:var(--fg)}
.tooltip-value b{font-family:var(--font-mono);font-weight:500;font-variant-numeric:tabular-nums}
.tooltip-value i{font-style:normal;color:var(--fg-subtle)}
.tooltip-share{font-family:var(--font-mono);color:var(--fg-subtle);font-variant-numeric:tabular-nums}
</style>

<script setup lang="ts">
/** Vue adaptation of ZCode UsageHeatmap + UsageHeatmapCells: 52-week token activity grid with daily/weekly/cumulative modes. */
import { computed, ref } from 'vue';
import type { AppUsageHeatmapWeek } from '../../contracts/appUsage.js';
import { buildDisplayHeatmapWeeks, buildHeatmapDisplayColumns, buildHeatmapMonthLabels, type HeatmapDisplayColumn, type TokenActivityMode } from '../view-model/appUsage';
import ControlHintTooltip from './ControlHintTooltip.vue';
const props = defineProps<{ weeks: AppUsageHeatmapWeek[] }>();
const mode = ref<TokenActivityMode>('daily');
const TOKEN_ACTIVITY_MODES: Array<{ value: TokenActivityMode; label: string }> = [
  { value: 'daily', label: '每日' }, { value: 'weekly', label: '每周' }, { value: 'cumulative', label: '累计' },
];
const displayColumns = computed<HeatmapDisplayColumn[]>(() => buildHeatmapDisplayColumns(buildDisplayHeatmapWeeks(props.weeks), mode.value));
const monthLabels = computed(() => buildHeatmapMonthLabels(displayColumns.value));
const levelStyle = (level: number): string => `var(--color-usage-heatmap-${Math.max(0, Math.min(4, level))})`;
</script>
<template>
  <div class="heatmap-card">
    <div class="heatmap-head">
      <h3>Token 活动</h3>
      <div class="pill-tabs" role="tablist" aria-label="热力图统计方式">
        <button v-for="option in TOKEN_ACTIVITY_MODES" :key="option.value" role="tab" type="button"
          :aria-selected="mode === option.value" class="pill-tab" :data-active="mode === option.value || undefined"
          @click="mode = option.value">{{ option.label }}</button>
      </div>
    </div>
    <div>
      <div class="heatmap-grid">
        <template v-for="column in displayColumns" :key="column.key">
          <ControlHintTooltip v-if="column.tooltipTitle" :text="column.tooltipTitle">
            <div class="heatmap-col" :data-group="mode !== 'daily' || undefined">
              <ControlHintTooltip v-for="cell in column.cells" :key="cell.key" :text="cell.tooltipTitle ?? ''">
                <div class="heatmap-cell" :data-column-hover="cell.columnHover || undefined" :data-usage="cell.hasUsage || undefined"
                  :style="{ background: levelStyle(cell.level) }" />
              </ControlHintTooltip>
            </div>
          </ControlHintTooltip>
          <div v-else class="heatmap-col">
            <ControlHintTooltip v-for="cell in column.cells" :key="cell.key" :text="cell.tooltipTitle ?? ''">
              <div class="heatmap-cell" :data-column-hover="cell.columnHover || undefined" :data-usage="cell.hasUsage || undefined"
                :style="{ background: levelStyle(cell.level) }" />
            </ControlHintTooltip>
          </div>
        </template>
      </div>
      <div class="month-grid">
        <div v-for="label in monthLabels" :key="label.key" :style="{ gridColumn: `span ${label.span}` }" class="month-label">{{ label.label }}</div>
      </div>
    </div>
  </div>
</template>
<style scoped>
.heatmap-card{border-radius:12px;background:var(--color-surface);padding:12px 12px}
.heatmap-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.heatmap-head h3{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-ui-base);font-weight:500;color:var(--fg)}
.pill-tabs{display:flex;height:28px;flex:none;align-items:center;border-radius:9999px;background:var(--color-surface);padding:2px}
.pill-tab{height:24px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:9999px;padding:0 10px;background:transparent;font-size:var(--text-ui-sm);font-weight:500;color:var(--fg-subtle)}
.pill-tab[data-active]{background:var(--bg);color:var(--fg)}
.heatmap-grid{display:grid;width:100%;column-gap:2px;grid-template-columns:repeat(52,minmax(0,1fr))}
.heatmap-col{display:flex;min-width:0;flex-direction:column;gap:4px}
.heatmap-col>:deep(.control-hint-trigger){display:block}
.heatmap-cell{aspect-ratio:1;width:100%;min-width:0;border:1px solid transparent;border-radius:4px;transition:transform .15s ease,border-color .15s ease}
.heatmap-cell[data-usage]{border-color:var(--border)}
.heatmap-col[data-group]:hover .heatmap-cell{border-color:var(--border-hover)}
.heatmap-cell:hover{transform:scale(1.1);border-color:var(--border-hover)}
.month-grid{display:grid;width:100%;column-gap:2px;margin-top:12px;grid-template-columns:repeat(52,minmax(0,1fr))}
.month-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-ui-sm);color:var(--fg-subtle)}
</style>

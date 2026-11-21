<script setup lang="ts">
/** Vue adaptation of ZCode AppUsagePanel: lifetime summary strip + token heatmap + range trend/pie charts. */
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import {v1} from '../api';
import type {AppUsageRange,AppUsageSnapshot} from '../../contracts/appUsage.js';
import {formatAppUsageDays,formatAppUsageDuration,formatSummaryCompactTokenUsage} from '../view-model/appUsage';
import UsageHeatmap from './UsageHeatmap.vue';
import UsageTrendChart from './UsageTrendChart.vue';
import UsageModelPieChart from './UsageModelPieChart.vue';

const RANGE_OPTIONS: Array<{value:AppUsageRange;label:string}> = [{value:'7d',label:'近 7 日'},{value:'30d',label:'近 30 日'}];
const range=ref<AppUsageRange>('7d');
const lifetime=ref<AppUsageSnapshot|null>(null),snapshot=ref<AppUsageSnapshot|null>(null);
const loading=ref(false),error=ref('');let controller:AbortController|undefined;
const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
async function load(){
  controller?.abort();const next=new AbortController();controller=next;
  loading.value=true;error.value='';
  try{
    const fetchOne=async(value:AppUsageRange)=>v1<AppUsageSnapshot>(`/api/v1/usage-stats?range=${value}&timeZone=${encodeURIComponent(timeZone)}`,{signal:next.signal});
    const [ranged,all]=await Promise.all([fetchOne(range.value),fetchOne('all')]);
    if(next.signal.aborted)return;
    snapshot.value=ranged;lifetime.value=all;
  }catch(e){
    if(next.signal.aborted)return;
    error.value=e instanceof Error&&e.message?e.message:String(e);
  }finally{
    if(!next.signal.aborted)loading.value=false;
  }
}
watch(range,load,{immediate:true});onBeforeUnmount(()=>controller?.abort());
const summaryItems=computed(()=>[
  {label:'累计 Token 数',value:lifetime.value?formatSummaryCompactTokenUsage(lifetime.value.summary.totalTokens):'--'},
  {label:'峰值 Token 数',value:lifetime.value?formatSummaryCompactTokenUsage(lifetime.value.summary.peakDayTokens):'--'},
  {label:'最长聊天时长',value:lifetime.value?formatAppUsageDuration(lifetime.value.summary.longestSessionMs):'--'},
  {label:'当前连续天数',value:lifetime.value?formatAppUsageDays(lifetime.value.summary.currentStreakDays):'--'},
  {label:'最长连续天数',value:lifetime.value?formatAppUsageDays(lifetime.value.summary.longestStreakDays):'--'},
]);
</script>
<template>
  <section aria-label="用量统计">
    <div class="summary-strip">
      <template v-for="(item,index) in summaryItems" :key="item.label">
        <div v-if="index>0" aria-hidden="true" class="summary-divider" />
        <div class="summary-item">
          <div class="summary-value">{{ item.value }}</div>
          <div class="summary-label">{{ item.label }}</div>
        </div>
      </template>
    </div>
    <UsageHeatmap v-if="lifetime?.heatmap.weeks.length" :weeks="lifetime.heatmap.weeks" />
    <div class="range-row">
      <div class="range-title">时间范围</div>
      <div class="pill-tabs" role="tablist" aria-label="统计时间范围">
        <button v-for="option in RANGE_OPTIONS" :key="option.value" type="button" role="tab"
          :aria-selected="range===option.value" class="pill-tab" :data-active="range===option.value || undefined"
          @click="range=option.value">{{ option.label }}</button>
      </div>
    </div>
    <p v-if="error" class="error-notice" role="alert">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
      <span>{{ error }}</span>
    </p>
    <div v-if="!snapshot" class="empty-state">
      <div class="empty-title">{{ loading ? '正在统计中' : '还没有可展示的数据' }}</div>
      <div class="empty-desc">{{ loading ? '正在读取本地应用会话历史，可能需要一点时间。' : '当前区间暂无可展示的用量数据。' }}</div>
    </div>
    <template v-else>
      <UsageTrendChart :snapshot="snapshot" />
      <UsageModelPieChart :snapshot="snapshot" />
    </template>
    <div class="refresh-row">
      <button type="button" class="refresh-btn" :disabled="loading" @click="load">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
        刷新
      </button>
    </div>
  </section>
</template>
<style scoped>
section{display:flex;flex-direction:column;gap:20px}
.summary-strip{display:flex;flex-direction:column;overflow:hidden;border-radius:12px;background:var(--color-surface)}
@media(min-width:640px){.summary-strip{flex-direction:row;align-items:center}}
.summary-divider{display:none;width:1px;height:28px;background:var(--border)}
@media(min-width:640px){.summary-divider{display:block}}
.summary-item{min-width:0;flex:1;padding:12px 16px;text-align:center}
.summary-value{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-ui-lg);font-weight:500;color:var(--fg)}
.summary-label{margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-ui-base);color:var(--fg-subtle)}
.range-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
.range-title{font-size:var(--text-ui-base);font-weight:500;color:var(--fg)}
.pill-tabs{display:flex;height:28px;flex:none;align-items:center;border-radius:9999px;background:var(--color-surface);padding:2px}
.pill-tab{height:24px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:9999px;padding:0 10px;background:transparent;font-size:var(--text-ui-sm);font-weight:500;color:var(--fg-subtle)}
.pill-tab[data-active]{background:var(--bg);color:var(--fg)}
.error-notice{display:flex;width:fit-content;min-width:0;align-items:center;gap:6px;font-size:var(--text-ui-base);color:var(--danger)}
.error-notice svg{width:12px;height:12px;flex:none}
.empty-state{border:1px dashed var(--border);border-radius:12px;padding:40px 16px;text-align:center}
.empty-title{font-size:var(--text-ui-base);font-weight:500;color:var(--fg)}
.empty-desc{margin-top:8px;font-size:var(--text-ui-base);color:var(--fg-subtle)}
.refresh-row{display:flex;justify-content:flex-end}
.refresh-btn{display:inline-flex;height:32px;align-items:center;gap:6px;border:1px solid var(--border);border-radius:6px;padding:0 12px;background:var(--bg);font-size:var(--text-ui-sm);color:var(--fg)}
.refresh-btn:hover{background:var(--hover)}
.refresh-btn svg{width:14px;height:14px}
</style>

<script setup lang="ts">
import { computed, toRef } from 'vue';
import { useUsageRequests } from './composables/useUsageRequests';
import StatDialog from './StatDialog.vue';
import { formatExact, formatTokens, metricText, type Metric, type UsageView } from '../view-model/usage';
const props = defineProps<{ usage: UsageView; mode: 'detailed' | 'compact'; runId: string }>();
const { rows: requests, cursor, busy: loadingRequests, error: requestError, more } = useUsageRequests(toRef(props, 'runId'), toRef(props, 'usage'));
const emit = defineEmits<{ (e: 'toggle-mode'): void }>();
const summary = computed(() => {
  const cache = props.usage.cacheHit !== null ? `缓存 ${props.usage.cacheHit}%` : props.usage.lastCacheHit !== null ? `本次缓存 ${props.usage.lastCacheHit}%` : props.usage.read.value !== null ? `缓存读 ${metricText(props.usage.read)}` : '缓存未报告';
  return props.mode === 'compact' ? cache : `${metricText(props.usage.total)} tokens · ${cache}`;
});
const rows = computed(() => [
  ['输入（未缓存）', props.usage.input], ['缓存读取', props.usage.read], ['缓存写入', props.usage.write],
  ['输入合计', props.usage.totalInput], ['输出', props.usage.output], ['其中推理', props.usage.reasoning], ['消耗合计', props.usage.total],
] as Array<[string, Metric]>);
const coverage = (m: Metric) => m.availability === 'unknown' ? '未提供' : m.availability === 'partial' ? `${m.known} 次已知 / ${m.unknown} 次缺失` : `${m.known} 次已知`;
</script>
<template>
  <StatDialog stat="usage" :title="`${usage.scope}用量`" :text="summary">
    <template #icon><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/></svg></template>
    <dl>
      <dt>模型请求</dt><dd>{{ formatExact(usage.requests) }}</dd>
      <template v-for="[label, reading] in rows" :key="label"><dt>{{ label }}<span class="coverage">{{ coverage(reading) }}</span></dt><dd>{{ metricText(reading, true) }}</dd></template>
      <dt>会话缓存命中率</dt><dd>{{ usage.cacheHit === null ? '覆盖不完整' : `${usage.cacheHit}%` }}</dd>
      <dt v-if="usage.lastCacheHit !== null">最近请求缓存命中率</dt><dd v-if="usage.lastCacheHit !== null">{{usage.lastCacheHit}}%</dd>
    </dl>
    <p v-if="usage.cacheHit === null && usage.read.value !== null">缓存读取已返回，但会话包含未报告字段的旧请求，无法计算整个会话的准确命中率。上方保留已知小计；最近请求的命中率单独展示。</p>
    <p>“+”为已知部分的小计，并非完整消耗。输入合计包含未缓存、缓存读与缓存写；推理属于输出，不重复相加。命中率仅在输入和缓存读都完整时计算。</p>
    <details v-if="usage.byKind.length" class="breakdown"><summary>按请求类型查看</summary><div v-for="row in usage.byKind" :key="row.kind" class="model-row"><strong>{{ ({main:'主请求',compaction:'上下文整理',repair:'修复请求',memory_recall:'记忆召回',memory_extraction:'记忆提炼'})[row.kind] }}</strong><span>{{ row.requests }} 次 · 消耗 {{ formatTokens(row.totalTokens) }} tokens</span><span v-if="row.unknownCount">{{ row.unknownCount }} 次存在未知用量，数字为已知小计</span></div></details>
    <details v-if="usage.byModel.length" class="breakdown"><summary>按模型查看</summary><div v-for="row in usage.byModel" :key="`${row.provider}/${row.model}`" class="model-row"><strong>{{ row.model }}</strong><span>{{ row.requests }} 次 · 未缓存输入 {{ formatTokens(row.inputTokens) }} / 输出 {{ formatTokens(row.outputTokens) }}</span><span v-if="row.unknownCount">{{ row.unknownCount }} 次存在未知用量</span></div></details>
    <details v-if="requests.length" class="breakdown"><summary>请求明细（已载入 {{ requests.length }}）</summary><div v-for="row in requests" :key="row.requestId" class="model-row"><strong>{{ row.model }} · {{ row.kind }}</strong><span>{{ row.status }} · {{ row.usageSource }}</span><span>输入 {{ formatExact(row.totalInputTokens) }} / 输出 {{ formatExact(row.outputTokens) }}</span><span class="request-id">{{ row.requestId }}</span></div><button v-if="cursor?.hasMore" class="stat-action" type="button" :disabled="loadingRequests" @click="more">{{ loadingRequests ? '正在载入…' : '载入更早请求' }}</button><p v-if="requestError" role="alert">{{ requestError }}</p><p>明细按需分页；上方累计始终含完整会话。</p></details>
    <button class="stat-action" type="button" @click="emit('toggle-mode')">{{ mode === 'detailed' ? '显示偏好：切换简洁读数' : '显示偏好：切换详细读数' }}</button>
  </StatDialog>
</template>
<style scoped>
.coverage{display:block;font-size:11px;line-height:16px;opacity:.8}
.breakdown{margin-top:12px;border-top:.5px solid var(--dsw-alias-border-l2,#eee);padding-top:10px}
.breakdown summary{cursor:pointer}.model-row{display:flex;flex-direction:column;gap:2px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,#eee);font-size:12px;line-height:18px}.model-row strong{font-weight:500}.request-id{overflow-wrap:anywhere;color:var(--dsw-alias-label-tertiary,#777)}
</style>

<script setup lang="ts">
import { computed } from 'vue';
import StatDialog from './StatDialog.vue';
import { formatDuration, formatExact, formatRate, type UsageView } from '../view-model/usage';
const props = defineProps<{ usage: UsageView; mode: 'detailed' | 'compact'; status: string; charRate: number | null }>();
const summary = computed(() => {
  const speed = props.usage.sessionRate === null ? '均速 —' : formatRate(props.usage.sessionRate);
  const a = props.usage.activity;
  return props.mode === 'compact' ? speed : `${a ? `${formatExact(a.turns)} 任务轮 / ${formatExact(a.steps)} 步` : '活动 —'} · ${speed}`;
});
</script>
<template>
  <StatDialog stat="activity" title="会话活动" :text="summary">
    <template #icon><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 19a10 10 0 1 1 16 0M12 3v3M4.5 7l2 2M19.5 7l-2 2M12 15l4-5"/><circle cx="12" cy="15" r="2"/></svg></template>
    <dl>
      <dt>任务轮</dt><dd>{{ formatExact(usage.activity?.turns) }}</dd>
      <dt>模型请求步</dt><dd>{{ formatExact(usage.activity?.steps) }}</dd>
      <dt>模型请求总耗时</dt><dd>{{ formatDuration(usage.activity?.llmMs) }}{{ usage.activity?.unknownLlmCount ? '（部分已知）' : '' }}</dd>
      <dt>工具总耗时</dt><dd>{{ formatDuration(usage.activity?.toolMs) }}{{ usage.activity?.unknownToolCount ? '（部分已知）' : '' }}</dd>
      <dt>平均首 token 延迟</dt><dd>{{ formatDuration(usage.activity?.averageTtftMs) }}</dd>
      <dt>首 token 有效样本</dt><dd>{{ formatExact(usage.activity?.ttftSamples) }}</dd>
      <dt>会话解码均速</dt><dd>{{ formatRate(usage.sessionRate) }}</dd>
      <dt>速度有效样本</dt><dd>{{ formatExact(usage.samples) }}</dd>
      <dt>最近请求解码速度</dt><dd>{{ formatRate(usage.lastRate) }}</dd>
      <dt>当前状态</dt><dd>{{ status }}</dd>
      <template v-if="charRate !== null"><dt>实时文本到达</dt><dd>{{ charRate }} 字符/s</dd></template>
      <template v-if="usage.lastRequest"><dt>最近请求模型</dt><dd>{{ usage.lastRequest.model }}</dd><dt>最近请求状态</dt><dd>{{ usage.lastRequest.status }}</dd></template>
    </dl>
    <p>任务轮按本产品 Run 计数；步为实际发出的模型请求。累计活动不随历史分页变化。字符/s 不是 token/s，最近请求也不等同于完整一轮。</p>
  </StatDialog>
</template>

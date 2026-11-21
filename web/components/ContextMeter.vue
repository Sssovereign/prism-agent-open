<script setup lang="ts">
import { computed } from 'vue';
import StatDialog from './StatDialog.vue';
import { formatExact, type UsageView } from '../view-model/usage';
const props = defineProps<{ usage: UsageView; canCompact: boolean; compactBusy?: boolean; compactNotice?: string }>();
const emit = defineEmits<{ (e: 'compact'): void }>();
const summary = computed(() => `上次输入 ${props.usage.context.percent === null ? '—' : `${props.usage.context.percent}%`}`);
const circumference = 2 * Math.PI * 5.5;
const measuredTime = computed(() => {
  const value = props.usage.context.measuredAt;
  if (!value) return '—'; const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
});
</script>
<template>
  <StatDialog stat="context" title="上下文 · 上次输入" :text="summary">
    <template #icon><svg viewBox="0 0 14 14" aria-hidden="true"><circle class="context-track" cx="7" cy="7" r="5.5"/><circle v-if="usage.context.ringPercent !== null && usage.context.ringPercent > 0" class="context-fill" cx="7" cy="7" r="5.5" :stroke-dasharray="`${circumference * usage.context.ringPercent / 100} ${circumference}`" transform="rotate(-90 7 7)"/></svg></template>
    <dl>
      <dt>上次请求输入</dt><dd>{{ usage.context.estimated ? '~' : '' }}{{ formatExact(usage.context.tokens) }} tokens</dd>
      <dt>模型窗口</dt><dd>{{ formatExact(usage.context.window) }} tokens</dd>
      <dt>输入 / 窗口</dt><dd>{{ usage.context.percent === null ? '—' : `${usage.context.percent}%` }}</dd>
      <dt>输出预留</dt><dd>{{ formatExact(usage.context.reserve) }} tokens</dd>
      <dt>计量时间</dt><dd>{{ measuredTime }}</dd>
      <dt>请求来源</dt><dd>{{ usage.context.requestId ?? '—' }}</dd>
      <dt>任务来源</dt><dd>{{ usage.context.runId ?? '—' }}</dd>
    </dl>
    <p>供应商记录的是上次已提交的输入，不是当前编辑内容的实时占用；未提供本地估算拆分时，不绘制虚构的系统、工具或消息比例。</p>
    <button class="stat-action" type="button" :disabled="!canCompact || compactBusy" @click="emit('compact')">{{ compactBusy ? '正在提交…' : '整理上下文' }}</button>
    <p v-if="!canCompact">任务已结束，无法整理上下文。</p>
    <p v-if="compactNotice" role="status">{{ compactNotice }}</p>
  </StatDialog>
</template>
<style scoped>
.context-track{fill:none;stroke:var(--dsw-alias-border-l3,#d8d8d8);stroke-width:2}
.context-fill{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
</style>

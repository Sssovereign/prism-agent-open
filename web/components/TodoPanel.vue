<script setup lang="ts">
/** 任务清单面板（块D新增）：按 ZCode TodoPanel.tsx 语义复刻（React→Vue）。
 *  折叠态默认：进行中项标题（流式时扫光动画）＋mono 计数；展开：未完成项清单；
 *  全部完成或无清单时隐藏。动画走块0 tokens（animated-gradient-text）。
 *  对齐上游：右侧 ChevronsUpDown 切换按钮两态常驻（PlanAction 不随折叠消失，
 *  收起态也保留可见的展开入口），tooltip/aria 随状态切换。 */
import { ref, computed } from 'vue';
import ControlHintTooltip from './ControlHintTooltip.vue';
const props = defineProps<{ plan: Array<{ id: string; content: string; status: string }>; isStreaming: boolean }>();
const isOpen = ref(false);
const completedCount = computed(() => props.plan.filter(step => step.status === 'completed').length);
const isAllCompleted = computed(() => props.plan.length > 0 && completedCount.value === props.plan.length);
const visiblePlan = computed(() => props.plan.filter(step => step.status !== 'completed'));
const activeStep = computed(() => props.plan.find(step => step.status === 'in_progress') ?? props.plan.find(step => step.status !== 'completed') ?? props.plan.at(-1) ?? null);
const showLoadingState = computed(() => props.isStreaming && !isAllCompleted.value);
</script>
<template>
<div v-if="plan.length && !isAllCompleted" class="todo-panel" :class="{ 'is-open': isOpen }" data-testid="todo-panel">
  <div class="todo-header">
    <button type="button" class="todo-toggle" :aria-expanded="isOpen" @click="isOpen = !isOpen">
      <template v-if="isOpen">
        <svg class="todo-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h.01M3 12h.01M3 19h.01M8 5h13M8 12h13M8 19h13"/></svg>
        <span class="todo-title">任务清单</span>
        <span class="todo-count">{{ completedCount }}/{{ plan.length }}</span>
      </template>
      <template v-else-if="showLoadingState">
        <svg class="todo-icon todo-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
        <span class="todo-title animated-gradient-text">{{ activeStep?.content ?? '当前任务' }}</span>
      </template>
      <template v-else>
        <svg class="todo-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h.01M3 12h.01M3 19h.01M8 5h13M8 12h13M8 19h13"/></svg>
        <span class="todo-title">{{ activeStep?.content ?? '当前任务' }}</span>
      </template>
      <span v-if="!isOpen" class="todo-count">{{ completedCount }}/{{ plan.length }}</span>
    </button>
    <ControlHintTooltip :text="isOpen ? '收起任务清单' : '展开任务清单'" v-slot="{ describedby }">
      <button type="button" class="todo-collapse" :aria-expanded="isOpen" :aria-label="isOpen ? '收起任务清单' : '展开任务清单'" :aria-describedby="describedby" @click="isOpen = !isOpen">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 15 5 5 5-5M7 9l5-5 5 5"/></svg>
      </button>
    </ControlHintTooltip>
  </div>
  <ul v-if="isOpen" class="todo-list">
    <li v-for="step in visiblePlan" :key="step.id" class="todo-item">
      <svg v-if="step.status === 'completed'" class="todo-indicator todo-done" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
      <svg v-else-if="step.status === 'in_progress'" class="todo-indicator todo-active" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
      <svg v-else class="todo-indicator todo-pending" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/></svg>
      <span class="todo-content" :data-status="step.status" :class="{ 'animated-gradient-text': step.status === 'in_progress' && isStreaming }">{{ step.content }}</span>
    </li>
  </ul>
</div>
</template>
<style scoped>
.todo-panel{overflow:hidden;border-radius:12px;border:1px solid var(--border);background:var(--bg-card);margin:0 auto 8px;max-width:760px;width:100%}
.todo-header{display:flex;align-items:center;gap:12px;padding:12px 16px}
.todo-panel.is-open .todo-header{padding-bottom:4px}
.todo-toggle{display:inline-flex;min-width:0;max-width:100%;align-items:center;gap:12px;border:0;background:none;padding:4px;border-radius:6px;cursor:pointer;text-align:left;color:var(--fg)}
.todo-toggle:focus-visible{outline:2px solid var(--accent,#2563eb);outline-offset:2px}
.todo-icon{flex:none;color:var(--fg)}
.todo-spin{animation:todo-rotate 1s linear infinite}
@keyframes todo-rotate{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.todo-spin{animation:none}}
.todo-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-ui-base);font-weight:500}
.todo-count{flex:none;font:var(--text-ui-base) var(--font-mono);color:var(--fg-subtlest)}
.todo-panel:not(.is-open) .todo-count{color:var(--fg-subtle)}
.todo-collapse{flex:none;display:inline-flex;border:0;background:none;padding:4px;border-radius:6px;cursor:pointer;color:var(--fg-subtle)}
.todo-collapse:hover{background:var(--bg-surface-hover,var(--bg-card))}
.todo-list{list-style:none;margin:0;padding:4px;display:grid;gap:2px}
.todo-item{display:flex;min-width:0;align-items:center;gap:12px;border-radius:10px;padding:8px 12px}
.todo-item:hover{background:rgba(0,0,0,.03)}
@media (prefers-color-scheme:dark){.todo-item:hover{background:rgba(255,255,255,.04)}}
.todo-indicator{flex:none}
.todo-done{color:var(--success,#16a34a)}
.todo-active{color:var(--fg)}
.todo-pending{color:var(--fg-subtlest)}
.todo-content{min-width:0;font-size:var(--text-ui-base);overflow-wrap:anywhere}
.todo-content[data-status=pending]{color:var(--fg-subtle)}
.todo-content[data-status=in_progress]{color:var(--fg)}
.todo-content[data-status=completed]{color:var(--fg-subtlest);text-decoration:line-through}
</style>

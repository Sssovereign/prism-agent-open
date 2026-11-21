<script setup lang="ts">
// Vue adaptation of DSH composer dock (existing rc.1 reference, installed rc.2 source). See vendor/dsh/LICENSE.
import { computed } from 'vue';
import type { RealRunSession } from '../view-model/realRun';
import { toolLabel } from '../view-model/realRun';
import { adaptUsage } from '../view-model/usage';
import ActivityPill from './ActivityPill.vue';
import UsagePill from './UsagePill.vue';
import ContextMeter from './ContextMeter.vue';
const props = defineProps<{ session: RealRunSession; mode: 'detailed' | 'compact'; compactBusy?: boolean; compactNotice?: string }>();
const emit = defineEmits<{ (e: 'toggle-mode'): void; (e: 'compact'): void }>();
const usage = computed(() => adaptUsage(props.session.usage.value));
const labels: Record<string, string> = { loading: '连接中', queued: '排队中', running: '运行中', waiting_approval: '等待审批', waiting_input: '等待输入', succeeded: '已完成', failed: '已失败', cancelled: '已停止', needs_reconciliation: '待核对' };
const activity = computed(() => {
  if (props.session.approval.value) return `等待审批：${toolLabel(props.session.approval.value.tool)}`;
  const tool = props.session.tools.value.find(t => t.state === 'running' || t.state === 'awaiting_approval');
  if (tool) return toolLabel(tool.tool);
  return labels[props.session.status.value] ?? props.session.status.value;
});
const canCompact = computed(() => ['queued', 'running', 'waiting_approval', 'waiting_input'].includes(props.session.status.value));
</script>
<template>
  <div class="statistics-dock" role="group" aria-label="会话统计" :data-mode="mode">
    <ActivityPill :key="`activity-${session.runId}`" :usage="usage" :mode="mode" :status="activity" :char-rate="session.status.value === 'running' ? session.charRate.value : null" />
    <UsagePill :key="`usage-${session.runId}`" :run-id="session.runId" :usage="usage" :mode="mode" @toggle-mode="emit('toggle-mode')" />
    <ContextMeter :key="`context-${session.runId}`" :usage="usage" :can-compact="canCompact" :compact-busy="compactBusy" :compact-notice="compactNotice" @compact="emit('compact')" />
  </div>
</template>
<style scoped>
.statistics-dock{display:flex;align-items:center;justify-content:center;gap:12px;min-width:0;width:100%;max-width:100%;min-height:22px;padding:0;box-sizing:border-box;background:transparent;font-variant-numeric:tabular-nums}
.statistics-dock>:deep(.stat-anchor){flex:0 1 auto;min-width:0}
@media(max-width:640px){.statistics-dock{gap:2px}.statistics-dock>:deep(.stat-anchor){flex:1 1 0}}
</style>

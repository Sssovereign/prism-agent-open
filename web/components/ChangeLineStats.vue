<script setup lang="ts">
import type { ChangeLineStats } from '../../contracts/changes';
defineProps<{ stats: ChangeLineStats | null; cumulative?: boolean }>();
</script>
<template>
  <span v-if="stats" class="change-line-stats" :aria-label="`${cumulative?'按变更记录累计，含已撤销记录。':''}新增 ${stats.addedLines} 行，删除 ${stats.removedLines} 行${stats.truncated?'，仅统计可用差异':''}`" :title="`${cumulative?'按变更记录累计，含已撤销记录；同一文件多次修改分别计数。':''}${stats.truncated?'差异截断或部分记录缺少补丁，仅统计可用部分。':'新增和删除的文本行数。'}`">
    <span class="num-added">+{{ stats.addedLines }}</span><span class="num-removed">−{{ stats.removedLines }}</span><small v-if="stats.truncated">部分</small>
  </span>
  <small v-else class="unknown-stats" title="此记录没有可统计的文本补丁">行数不可用</small>
</template>
<style scoped>
.change-line-stats{display:inline-flex;align-items:center;gap:6px;flex-shrink:0;white-space:nowrap;font:var(--text-ui-sm) var(--font-mono);font-variant-numeric:tabular-nums}
.num-added{color:var(--color-diff-added)}.num-removed{color:var(--color-diff-removed)}
.change-line-stats small,.unknown-stats{font:var(--text-ui-caption) var(--font-sans,inherit);color:var(--fg-subtlest);white-space:nowrap;flex-shrink:0}
</style>

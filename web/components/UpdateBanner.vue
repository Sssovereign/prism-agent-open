<script setup lang="ts">
// 更新提示条：服务端已更新而前端bundle仍为旧版时提示刷新。非阻塞（absolute顶条），
// 可关闭；run进行中不强制刷新，由用户自行选择时机。
import { computed } from 'vue';
import { updateNotice, dismissUpdateNotice } from '../updateNotice';

const emit = defineEmits<{ (e: 'refresh'): void }>();
const visible = computed(() => updateNotice.refreshNeeded && !updateNotice.dismissed);
const message = computed(() =>
  updateNotice.serverVersion
    ? `棱镜已更新到 ${updateNotice.serverVersion}，刷新页面加载新版本`
    : '棱镜有新版本，刷新页面加载新版本');
</script>
<template>
  <div v-if="visible" class="update-banner" role="status">
    <svg class="update-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 12a9 9 0 1 1-9-9" /><path d="M21 3v6h-6" /></svg>
    <span class="update-message">{{ message }}</span>
    <button type="button" class="update-action" @click="emit('refresh')">立即刷新</button>
    <button type="button" class="update-dismiss" aria-label="暂不刷新" @click="dismissUpdateNotice()">×</button>
  </div>
</template>
<style scoped>
/* 反色公告条：本主题的 --accent 是背景型淡色（亮色 #ebf4ff），当文字色会不可读；
   改用前景/卡片反转——亮色主题深灰条白字，暗色主题浅灰条深字，均高对比。 */
.update-banner{position:absolute;top:0;left:0;right:0;z-index:60;display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--fg);color:var(--bg-card);font-size:var(--text-ui-sm);line-height:1.5}
.update-icon{width:14px;height:14px;flex:none}
.update-message{flex:1;min-width:0}
.update-action{flex:none;border:1px solid color-mix(in srgb,var(--bg-card) 45%,transparent);border-radius:6px;background:transparent;color:inherit;padding:2px 10px;font-size:var(--text-ui-sm);cursor:pointer}
.update-action:hover{background:color-mix(in srgb,var(--bg-card) 18%,transparent)}
.update-dismiss{flex:none;border:none;background:transparent;color:inherit;font-size:16px;line-height:1;padding:2px 6px;cursor:pointer;opacity:.7}
.update-dismiss:hover{opacity:1}
</style>

<script setup lang="ts">
import { computed } from 'vue';
import { prismUpdates, updateCenter } from '../updates';
import UiIcon from './UiIcon.vue';
import { updatePreference } from '../ui/updatePreference';

const emit = defineEmits<{ (e: 'open'): void }>();
const indicator = computed(() => {
  const status = updateCenter.status;
  if (!prismUpdates || !status) return null;
  const preference = updatePreference(status);
  // shell 静默更新优先：发现→下载中→就绪→安装中
  const shell = preference.shell;
  if (shell) {
    if (shell.phase === 'available') return { label: '新版本', title: `发现新版本${shell.version ? ` ${shell.version}` : ''}，点击下载`, ready: false };
    if (shell.phase === 'downloading') {
      const percent = shell.progress && shell.progress.totalBytes > 0
        ? ` ${Math.max(0, Math.min(100, Math.round(shell.progress.receivedBytes / shell.progress.totalBytes * 100)))}%` : '';
      return { label: `下载中${percent}`, title: `正在下载新版本${shell.version ? ` ${shell.version}` : ''}${percent}，点击查看进度`, ready: false };
    }
    if (shell.phase === 'downloaded') return { label: '更新就绪', title: `新版本${shell.version ? ` ${shell.version}` : ''}已就绪，点击确认并静默重启安装`, ready: true };
    if (shell.phase === 'installing') return { label: '更新中', title: '正在静默安装新版本，应用即将重启', ready: false };
    return null;
  }
  const installer = preference.installer;
  if (installer && installer.productVersion === status.fullUpdate?.productVersion) {
    if (installer.phase === 'ready') return { label: '安装包就绪', title: `新版本 ${installer.productVersion} 已下载，点击打开安装包`, ready: true };
    if (installer.phase === 'verifying') return { label: '校验中', title: '正在校验完整安装包，点击查看', ready: false };
    if (installer.phase === 'error') return { label: '重试下载', title: '完整安装包下载未完成，点击重试', ready: false };
    const percent = installer.totalBytes > 0 ? ` ${Math.max(0, Math.min(100, Math.round(installer.receivedBytes / installer.totalBytes * 100)))}%` : '';
    return { label: `下载中${percent}`, title: `正在下载完整安装包${percent}，点击查看`, ready: false };
  }
  const version = preference.phase === 'installer-available'
    ? status.fullUpdate?.productVersion : status.available?.productVersion;
  switch (preference.phase) {
    case 'installer-available':
    case 'available':
      return { label: '新版本', title: `发现新版本${version ? ` ${version}` : ''}，点击下载`, ready: false };
    case 'downloading': {
      const progress = status.downloadProgress;
      const percent = progress && progress.totalBytes > 0
        ? ` ${Math.max(0, Math.min(100, Math.round(progress.receivedBytes / progress.totalBytes * 100)))}%` : '';
      return { label: `下载中${percent}`, title: `正在下载更新${version ? ` ${version}` : ''}${percent}，点击查看进度`, ready: false };
    }
    case 'verifying': return { label: '校验中', title: '正在校验更新包，点击查看', ready: false };
    case 'ready': return { label: '更新就绪', title: `新版本${version ? ` ${version}` : ''}已就绪，点击查看并更新`, ready: true };
    case 'applying':
    case 'waiting-idle': return { label: '更新中', title: '正在等待空闲或应用更新，点击查看', ready: false };
    case 'error': return status.available || status.fullUpdate
      ? { label: '重试更新', title: '更新未完成，点击查看并重试', ready: false } : null;
    default: return null;
  }
});
</script>

<template>
  <button v-if="indicator" class="update-download-indicator" type="button" :title="indicator.title" :aria-label="indicator.title" @click="emit('open')">
    <UiIcon :name="indicator.ready ? 'check' : 'download'" :size="16" />
    <span>{{ indicator.label }}</span>
    <span class="update-dot" aria-hidden="true"></span>
  </button>
</template>

<style scoped>
.update-download-indicator{display:inline-flex;align-items:center;gap:6px;flex:none;min-height:30px;padding:5px 9px;border:1px solid #bedbff;border-radius:8px;background:#eff6ff;color:#1258bb;font:inherit;font-size:var(--text-ui-sm);font-weight:600;white-space:nowrap;cursor:pointer;-webkit-app-region:no-drag}
.update-download-indicator:hover{background:#dbeafe;border-color:#86b6f6}
.update-download-indicator:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.update-dot{width:5px;height:5px;border-radius:50%;background:currentColor}
:global(html[data-theme=dark] .update-download-indicator){background:#142b49;border-color:#2a5686;color:#8bc2ff}
:global(html[data-theme=dark] .update-download-indicator:hover){background:#1c3b61;border-color:#5593d0}
@media(max-width:600px){.update-download-indicator{padding:5px 6px;gap:4px}}
</style>

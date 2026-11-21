<script setup lang="ts">
// 更新中心（设置·关于棱镜）：业务资源包更新与 shell 静默更新（完整应用）的统一入口。
// 状态与真实更新器同步（updates:state 推送）；任务进行中不强制退出，可稍后或取消。
import { computed, onMounted } from 'vue';
import { checkForUpdates, downloadUpdate, downloadInstaller, openInstaller, applyUpdate, cancelUpdateApply, downloadShellUpdate, applyShellUpdate, prismUpdates, refreshUpdateStatus, updateCenter, describeUpdateError } from '../updates';
import { updatePreference } from '../ui/updatePreference';

const emit = defineEmits<{ (e: 'close'): void }>();
const hostVersionText = computed(() => status.value?.hostVersion ?? '—');

const status = computed(() => updateCenter.status);
const preference = computed(() => updatePreference(status.value));
const shell = computed(() => preference.value.shell);
const installer = computed(() => preference.value.installer);
const installerPercent = computed(() => installer.value?.totalBytes ? Math.max(0, Math.min(100, Math.round(installer.value.receivedBytes / installer.value.totalBytes * 100))) : 0);
const installerBusy = computed(() => ['downloading', 'verifying'].includes(installer.value?.phase ?? ''));
const applying = computed(() => !!status.value?.pendingApply || status.value?.phase === 'waiting-idle');
const available = computed(() => status.value?.available ?? null);
const progressPercent = computed(() => {
  const progress = status.value?.downloadProgress;
  if (!progress || !progress.totalBytes) return null;
  return Math.min(100, Math.round(progress.receivedBytes / progress.totalBytes * 100));
});
const progressText = computed(() => {
  const progress = status.value?.downloadProgress;
  if (!progress) return '';
  const received = (progress.receivedBytes / 1024 / 1024).toFixed(1);
  const total = (progress.totalBytes / 1024 / 1024).toFixed(1);
  return `${received} / ${total} MB`;
});
const shellPercent = computed(() => {
  const progress = shell.value?.progress;
  if (!progress || !progress.totalBytes) return null;
  return Math.min(100, Math.round(progress.receivedBytes / progress.totalBytes * 100));
});
const shellProgressText = computed(() => {
  const progress = shell.value?.progress;
  if (!progress || !progress.totalBytes) return '';
  return `${(progress.receivedBytes / 1024 / 1024).toFixed(1)} / ${(progress.totalBytes / 1024 / 1024).toFixed(1)} MB`;
});
// shell 错误即使让位给兜底路径也要可见（phase=error 时 shellMode=false，不会出现在 shell 卡片里）。
const shellError = computed(() => {
  const current = status.value?.shellUpdate;
  return current?.phase === 'error' ? describeUpdateError(current.error ?? 'SHELL_UPDATE_FAILED') : '';
});
const stateLine = computed(() => {
  const phase = preference.value.phase;
  if (applying.value) return updateCenter.busyAction === '' ? '正在切换业务包：等待任务空闲→快照→重启验证…' : '正在切换业务包…';
  if (phase === 'shell-installing') return '正在静默安装新版本，应用即将自动重启…';
  if (phase === 'shell-downloaded') return shell.value?.version ? `新版本 ${shell.value.version} 已就绪，确认后将在任务空闲时静默重启安装` : '新版本已就绪，确认后将静默重启安装';
  if (phase === 'shell-downloading') return shellProgressText.value ? `正在下载新版本（${shellProgressText.value}）` : '正在下载新版本…';
  if (phase === 'shell-available') return shell.value?.version ? `发现新版本 ${shell.value.version}（完整应用），下载后确认即可静默重启安装` : '发现新版本（完整应用）';
  switch (phase) {
    case 'checking': return '正在检查更新…';
    case 'up-to-date': return '已是最新版本';
    case 'installer-available': return `发现完整应用新版本 ${status.value?.fullUpdate?.productVersion}，可直接下载到本机`;
    case 'available': return available.value ? `发现新业务版本 ${available.value.productVersion}` : '发现可用更新';
    case 'downloading': return progressText.value ? `正在下载更新包（${progressText.value}）` : '正在下载更新包…';
    case 'verifying': return progressPercent.value !== null ? `正在校验更新包（${progressPercent.value}%）` : '正在校验更新包…';
    case 'ready': return '更新已就绪，应用后将重启本地服务';
    case 'error': return status.value?.lastError ? describeUpdateError(status.value.lastError.code + ':' + status.value.lastError.message) : '更新失败，可重试';
    default: return status.value?.checkedAt ? `上次检查：${new Date(status.value.checkedAt).toLocaleString()}` : '尚未检查更新';
  }
});
const canRetry = computed(() => status.value?.phase === 'error');
const lastErrorMessage = computed(() => updateCenter.notice || (status.value?.lastError ? describeUpdateError(`${status.value.lastError.code}:${status.value.lastError.message}`) : ''));

// 推送由 App 统一订阅，关闭设置后顶栏仍持续接收更新状态。
onMounted(() => { void refreshUpdateStatus(); });

async function onDownload(): Promise<void> {
  const releaseId = available.value?.releaseId;
  if (releaseId) await downloadUpdate(releaseId);
}
async function onApply(): Promise<void> {
  const releaseId = available.value?.releaseId ?? status.value?.pendingApply?.releaseId;
  if (releaseId) await applyUpdate(releaseId);
}
async function onApplyShell(): Promise<void> {
  await applyShellUpdate();
}
async function onRetry(): Promise<void> {
  // 失败重试：优先重新下载发现版本；shell 就绪时回到静默安装；无发现版本时回到检查
  if (preference.value.phase === 'shell-downloaded') return onApplyShell();
  const releaseId = available.value?.releaseId;
  if (releaseId) await onDownload();
  else await checkForUpdates();
}
</script>
<template>
  <div class="settings-group update-center" data-settings-search-id="settings.about.updates">
    <div class="setting-row">
      <div><strong>应用内更新</strong><p>兼容更新优先下载小更新包。完整应用可下载安装包，支持自动安装时可在任务空闲后重启升级。下载不会打断任务。</p></div>
    </div>
    <div class="setting-row"><span>宿主版本</span><span>{{ hostVersionText }}</span></div>
    <div class="setting-row"><span>业务版本</span><span>{{ status?.activeBusinessVersion || '读取中…' }}</span></div>
    <div class="setting-row"><span>更新通道</span><span>{{ status?.channel === 'stable' ? 'stable' : 'beta' }}</span></div>
    <div class="setting-row"><span>状态</span><span class="update-state" role="status">{{ stateLine }}</span></div>
    <p v-if="progressPercent !== null" class="update-progress" role="progressbar" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100" aria-label="下载进度"><span class="update-progress-fill" :style="{ width: `${progressPercent}%` }"></span></p>
    <p v-if="shellPercent !== null" class="update-progress" role="progressbar" :aria-valuenow="shellPercent" aria-valuemin="0" aria-valuemax="100" aria-label="完整应用下载进度"><span class="update-progress-fill" :style="{ width: `${shellPercent}%` }"></span></p>
    <p v-if="lastErrorMessage && (status?.phase === 'error' || updateCenter.notice)" class="error-text" role="alert">{{ lastErrorMessage }}</p>
    <p v-if="shellError" class="error-text" role="alert">{{ shellError }}</p>
    <div v-if="installer" class="installer-download">
      <strong>{{ installer.name }}</strong>
      <p role="status">{{ installer.phase === 'ready' ? '已下载并校验，可打开安装包手动安装' : installer.phase === 'verifying' ? '正在校验完整安装包…' : installer.phase === 'error' ? describeUpdateError(installer.error) : `正在下载到本机：${installerPercent}%（${(installer.receivedBytes/1024/1024).toFixed(1)} / ${(installer.totalBytes/1024/1024).toFixed(1)} MB）` }}</p>
      <p v-if="installerBusy" class="update-progress" role="progressbar" :aria-valuenow="installerPercent" aria-valuemin="0" aria-valuemax="100" aria-label="完整安装包下载进度"><span class="update-progress-fill" :style="{width:`${installerPercent}%`}"></span></p>
    </div>
    <div class="update-actions">
      <button v-if="preference.phase === 'shell-available'" class="btn mp-primary" type="button" :disabled="updateCenter.busyAction !== '' || applying" @click="downloadShellUpdate">{{ updateCenter.busyAction === 'download' ? '正在下载…' : '下载更新' }}</button>
      <button v-if="preference.phase === 'shell-downloaded'" class="btn mp-primary" type="button" :disabled="updateCenter.busyAction !== '' || applying" @click="onApplyShell">{{ updateCenter.busyAction === 'apply' ? '正在准备重启…' : '更新并重启' }}</button>
      <button v-if="preference.phase === 'shell-downloaded'" class="text-btn" type="button" :disabled="updateCenter.busyAction !== '' || applying" @click="emit('close')">稍后</button>
      <button v-if="preference.offerInstaller && installer?.phase !== 'ready'" class="btn mp-primary" type="button" :disabled="!prismUpdates?.downloadInstaller || updateCenter.busyAction !== '' || applying || installerBusy" @click="downloadInstaller">{{ installer?.phase === 'error' ? '重新下载安装包' : installerBusy ? '正在下载安装包…' : '下载完整安装包' }}</button>
      <button v-if="installer?.phase === 'ready'" class="btn mp-primary" type="button" :disabled="updateCenter.busyAction !== '' || applying" @click="openInstaller()">打开安装包</button>
      <button v-if="installer?.phase === 'ready'" class="btn" type="button" :disabled="updateCenter.busyAction !== ''" @click="openInstaller(true)">打开所在文件夹</button>
      <button v-if="prismUpdates" class="btn" type="button" :disabled="updateCenter.busyAction !== '' || applying || installerBusy" @click="checkForUpdates">检查更新</button>
      <button v-if="status?.phase === 'available' && available" class="btn mp-primary" type="button" :disabled="updateCenter.busyAction !== '' || applying" @click="onDownload">下载更新</button>
      <button v-if="status?.phase === 'ready' && available" class="btn mp-primary" type="button" :disabled="updateCenter.busyAction !== '' || applying" @click="onApply">更新并重启</button>
      <button v-if="status?.phase === 'ready'" class="text-btn" type="button" :disabled="applying" @click="emit('close')">稍后</button>
      <button v-if="applying" class="text-btn" type="button" @click="cancelUpdateApply">取消等待</button>
      <button v-if="canRetry" class="btn" type="button" :disabled="updateCenter.busyAction !== ''" @click="onRetry">重试</button>
    </div>
    <p v-if="preference.offerInstaller && !prismUpdates?.downloadInstaller" class="settings-footnote">当前桌面宿主尚不支持应用内下载完整安装包，需要先安装支持此功能的新版应用。</p>
    <div v-if="available?.notes" class="update-notes">
      <strong>版本说明</strong>
      <pre>{{ available.notes }}</pre>
    </div>
    <p v-if="!prismUpdates" class="settings-footnote">当前运行方式不支持应用内更新（浏览器或源码部署）；桌面版安装后可用。</p>
  </div>
</template>
<style scoped>
.update-center .setting-row{align-items:baseline}
.update-state{max-width:60%;text-align:right}
.update-actions{display:flex;gap:8px;flex-wrap:wrap}
.update-progress{height:6px;border-radius:3px;background:var(--bg-card);overflow:hidden;margin:6px 0 0}
.update-progress-fill{display:block;height:100%;background:#2563eb;transition:width .3s ease}
.installer-download{padding:10px;border-radius:8px;background:var(--bg-card);overflow-wrap:anywhere}
.installer-download p{margin:6px 0;font-size:var(--text-ui-sm)}
.update-notes{margin-top:10px;font-size:var(--text-ui-sm)}
.update-notes pre{white-space:pre-wrap;word-break:break-word;margin:6px 0 0;padding:8px 10px;background:var(--bg-card);border-radius:8px;font-size:var(--text-ui-sm);max-height:220px;overflow:auto}
</style>

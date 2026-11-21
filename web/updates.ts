// 桌面应用内更新客户端状态：桥接 preload 暴露的 window.prismUpdates。
// 浏览器／源码部署没有该桥，全部方法为空操作，界面相应隐藏。
import { reactive } from 'vue';
import { t, hasTranslation } from './ui/i18n/index.js';

export interface ShellUpdateStatus {
  phase: 'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
  version: string | null;
  progress: { receivedBytes: number; totalBytes: number } | null;
  error: string | null;
  checkedAt: string | null;
}

export interface UpdatesStatus {
  phase: 'idle' | 'checking' | 'up-to-date' | 'installer-available' | 'available' | 'downloading' | 'verifying' | 'ready' | 'applying' | 'waiting-idle' | 'error';
  supported: boolean;
  channel: string;
  hostVersion: string | null;
  businessVersion: string;
  activeReleaseId: string | null;
  activeBusinessVersion: string;
  lastGoodReleaseId: string | null;
  checkedAt: string | null;
  available: { releaseId: string; tag: string; productVersion: string; updateSequence: number; notes: string; publishedAt: string | null } | null;
  fullUpdate?: { productVersion: string; url: string; name?: string; size?: number; digest?: string; downloadUrl?: string } | null;
  installerDownload?: { phase: 'downloading' | 'verifying' | 'ready' | 'error'; productVersion: string; name: string; receivedBytes: number; totalBytes: number; error: string | null } | null;
  downloadProgress: { releaseId: string; receivedBytes: number; totalBytes: number } | null;
  lastError: { code: string; message: string; at: string } | null;
  pendingApply: { releaseId: string; startedAt: string } | null;
  shellUpdate?: ShellUpdateStatus | null;
}

interface PrismUpdatesBridge {
  getStatus(): Promise<UpdatesStatus | null>;
  check(): Promise<UpdatesStatus>;
  download(releaseId: string): Promise<UpdatesStatus>;
  downloadInstaller?(): Promise<UpdatesStatus>;
  openInstaller?(): Promise<void>;
  showInstaller?(): Promise<void>;
  apply(releaseId: string): Promise<{ started: boolean; reason?: string }>;
  cancelApply(): Promise<{ cancelled: boolean }>;
  downloadShell?(): Promise<UpdatesStatus>;
  applyShell?(): Promise<{ started: boolean; reason?: string }>;
  onState(callback: (status: UpdatesStatus) => void): () => void;
  onMenu(callback: () => void): () => void;
}

export const prismUpdates: PrismUpdatesBridge | null =
  typeof window !== 'undefined' && (window as unknown as { prismUpdates?: PrismUpdatesBridge }).prismUpdates
    ? (window as unknown as { prismUpdates: PrismUpdatesBridge }).prismUpdates
    : null;

export const updateCenter = reactive({
  status: null as UpdatesStatus | null,
  busyAction: '' as '' | 'check' | 'download' | 'installer' | 'open-installer' | 'apply',
  notice: '',
});

export function describeUpdateError(error: unknown): string {
  const text = String((error as Error | undefined)?.message ?? error);
  // 错误码 → 呈现文案登记表；翻译走 i18n 字典（updates.error.<CODE>），未登记码保留原文摘要。
  const codes = [
    'SIGNATURE_INVALID', 'KEY_ID_MISMATCH', 'INCOMPATIBLE_RUNTIME', 'SHELL_RANGE_REJECTED', 'PLATFORM_MISMATCH',
    'CHANNEL_MISMATCH', 'SEQUENCE_REJECTED', 'FEED_TIMEOUT', 'FEED_RATE_LIMITED', 'FEED_NETWORK', 'FEED_NOT_FOUND',
    'PACKAGE_DIGEST_MISMATCH', 'INSTALLER_METADATA_INVALID', 'INSTALLER_DIGEST_MISMATCH', 'INSTALLER_NOT_READY',
    'INSTALLER_OPEN_FAILED', 'TASKS_BUSY_TIMEOUT', 'ERR_UPDATER', 'SHELL_UPDATE_NOT_READY', 'SHELL_INSTALL_ABORTED',
    'SHELL_INSTALL_FAILED',
  ];
  const hit = codes.find(key => text.startsWith(key) || text.includes(key));
  if (hit && hasTranslation(`updates.error.${hit}`)) return t(`updates.error.${hit}`);
  return t('updates.error.unfinished', { detail: text.slice(0, 160) });
}

export async function refreshUpdateStatus(): Promise<void> {
  if (!prismUpdates) return;
  const previous = updateCenter.status;
  try {
    const status = await prismUpdates.getStatus();
    // 查询期间收到的推送比查询快照新，不能覆盖后台下载进度。
    if (updateCenter.status === previous) updateCenter.status = status;
  } catch (error) { updateCenter.notice = describeUpdateError(error); }
}

export async function checkForUpdates(): Promise<void> {
  if (!prismUpdates) return;
  updateCenter.busyAction = 'check';
  updateCenter.notice = '';
  try { updateCenter.status = await prismUpdates.check(); }
  catch (error) { updateCenter.notice = describeUpdateError(error); }
  finally { updateCenter.busyAction = ''; }
}

export async function downloadUpdate(releaseId: string): Promise<void> {
  if (!prismUpdates) return;
  updateCenter.busyAction = 'download';
  updateCenter.notice = '';
  try { updateCenter.status = await prismUpdates.download(releaseId); }
  catch (error) { updateCenter.notice = describeUpdateError(error); }
  finally { updateCenter.busyAction = ''; }
}

export async function downloadInstaller(): Promise<void> {
  if (!prismUpdates?.downloadInstaller) return;
  updateCenter.busyAction = 'installer'; updateCenter.notice = '';
  try { updateCenter.status = await prismUpdates.downloadInstaller(); }
  catch (error) { updateCenter.notice = describeUpdateError(error); }
  finally { updateCenter.busyAction = ''; }
}

export async function openInstaller(reveal = false): Promise<void> {
  const action = reveal ? prismUpdates?.showInstaller : prismUpdates?.openInstaller;
  if (!action) return;
  updateCenter.busyAction = 'open-installer'; updateCenter.notice = '';
  try { await action(); }
  catch (error) { updateCenter.notice = describeUpdateError(error); }
  finally { updateCenter.busyAction = ''; }
}

export async function applyUpdate(releaseId: string): Promise<void> {
  if (!prismUpdates) return;
  updateCenter.busyAction = 'apply';
  updateCenter.notice = '';
  try {
    const result = await prismUpdates.apply(releaseId);
    if (!result.started) updateCenter.notice = result.reason ?? t('updates.notStarted');
    else await refreshUpdateStatus();
  } catch (error) { updateCenter.notice = describeUpdateError(error); }
  finally { updateCenter.busyAction = ''; }
}

export async function cancelUpdateApply(): Promise<void> {
  if (!prismUpdates) return;
  try { await prismUpdates.cancelApply(); } catch { /* 主进程按状态决定 */ }
}

// —— shell 层（完整应用静默更新）：electron-updater 下载 + 空闲门禁后静默重启安装 —— //

export async function downloadShellUpdate(): Promise<void> {
  if (!prismUpdates?.downloadShell) return;
  updateCenter.busyAction = 'download';
  updateCenter.notice = '';
  try { updateCenter.status = await prismUpdates.downloadShell(); } // IPC 返回合并快照（shell 状态含其中）
  catch (error) { updateCenter.notice = describeUpdateError(error); }
  finally { updateCenter.busyAction = ''; }
}

export async function applyShellUpdate(): Promise<void> {
  if (!prismUpdates?.applyShell) return;
  updateCenter.busyAction = 'apply';
  updateCenter.notice = '';
  try {
    const result = await prismUpdates.applyShell();
    if (!result.started) updateCenter.notice = result.reason ?? t('updates.notStarted');
    else await refreshUpdateStatus();
  } catch (error) { updateCenter.notice = describeUpdateError(error); }
  finally { updateCenter.busyAction = ''; }
}

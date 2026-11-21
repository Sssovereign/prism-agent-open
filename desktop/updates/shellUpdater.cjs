// shell 层（完整应用）静默更新器：electron-updater 的受控包装（机制对齐 ZCode/DSH 实证）。
// mac：zip + blockmap 差分 → Squirrel.Mac 原地替换 /Applications 并自动重启；
// win：NSIS oneClick /S 静默覆盖原目录 + --force-run 自动重启，全程无窗口。
// autoDownload/autoInstallOnAppQuit 全关：发现→下载→重启安装均由用户确认、经主进程空闲门禁触发，
// 与业务资源包（updater.cjs）同一交互模型；不可用或失败时由 UI 回落手动安装包路径。
'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

const SHELL_CHECK_INITIAL_DELAY_MS = 4 * 60_000;
const SHELL_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

/** 开发模式用普通 require；打包后 asar 不含 node_modules，从随包生产依赖目录回退加载
 * （workspace/node_modules 为打包脚本 pnpm install --prod 的产物，是生产依赖的真实落点）。 */
function resolveElectronUpdater() {
  try { return require('electron-updater'); } catch { /* 继续按打包布局回退 */ }
  const resources = process.resourcesPath;
  if (!resources) return null;
  for (const base of [join(resources, 'workspace', 'node_modules'), join(resources, 'node_modules'), join(resources, 'runtime', 'node_modules')]) {
    try { return require(join(base, 'electron-updater')); } catch { /* 依次回退 */ }
  }
  return null;
}

function messageOf(error) {
  const code = error?.code ?? 'SHELL_UPDATE_FAILED';
  return `${code}:${error?.message ?? String(error)}`;
}

function hasMacUpdateSigningIdentity() {
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', process.execPath], {
    encoding: 'utf8', timeout: 2000,
  });
  return result.status === 0 && /^Authority=Developer ID Application: /m.test(result.stderr)
    && /^TeamIdentifier=[A-Z0-9]{10}$/m.test(result.stderr);
}

/**
 * 创建 shell 更新器。appUpdateConfigPath 缺省指向打包注入的 app-update.yml；
 * localFeedUrl 仅隔离测试（PRISM_SHELL_FEED_URL，只允许本机回环），设置时走 generic feed。
 * electronUpdaterModule 供测试注入假件；缺省运行时解析。
 */
function createShellUpdater({
  electronUpdaterModule,
  appUpdateConfigPath,
  localFeedUrl = process.env.PRISM_SHELL_FEED_URL ?? null,
  isPackaged = undefined,
  platform = process.platform,
  onLog = () => {},
} = {}) {
  const packaged = isPackaged !== undefined ? isPackaged : !!(process.versions?.electron && process.resourcesPath);
  const configPath = appUpdateConfigPath ?? (packaged && process.resourcesPath ? join(process.resourcesPath, 'app-update.yml') : null);
  if (localFeedUrl && !/^http:\/\/127\.0\.0\.1(:\d+)?\//.test(localFeedUrl)) {
    throw new Error('PRISM_SHELL_FEED_URL 仅允许 http://127.0.0.1（本地隔离测试）');
  }
  const configured = !!localFeedUrl || (!!configPath && existsSync(configPath));
  // Ad-hoc 签名绑定单个构建，Squirrel 无法用它验证下一版本。
  const canInstall = configured && (platform !== 'darwin' || hasMacUpdateSigningIdentity());
  if (configured && !canInstall) onLog('macOS 当前应用缺少 Developer ID 签名，整包升级使用手动安装');
  const engineModule = canInstall ? (electronUpdaterModule ?? resolveElectronUpdater()) : null;
  const supported = !!engineModule;

  const api = new EventEmitter();
  api.state = {
    phase: supported ? 'idle' : 'unsupported',
    version: null,
    progress: null,
    error: null,
    checkedAt: null,
  };
  api.supported = supported;

  let engine = null;
  let generation = 0;
  let downloadGeneration = 0;
  let opBusy = false;
  let disposed = false;
  let autoTimer = null;
  let autoInterval = null;
  let stagedVersion = null; // 缓存中确实存在已校验下载件的版本；决定 error 相位能否直接重试安装
  let installFailed = false;

  api.dispose = () => {
    disposed = true;
    if (autoTimer) clearTimeout(autoTimer);
    if (autoInterval) clearInterval(autoInterval);
    if (engine) engine.removeAllListeners();
  };

  if (!supported) {
    api.check = async () => api.state;
    api.download = async () => api.state;
    api.quitAndInstall = () => false;
    api.markInstallFailed = () => {};
    api.scheduleAutoCheck = () => {};
    return api;
  }

  const setState = patch => {
    api.state = { ...api.state, ...patch };
    api.emit('state', api.state);
  };

  engine = engineModule.autoUpdater;
  engine.autoDownload = false;
  engine.autoInstallOnAppQuit = false;
  engine.allowDowngrade = false;
  engine.allowPrerelease = true; // beta 通道：随版本号 prerelease 自动取预发行
  engine.logger = { info: onLog, warn: onLog, error: onLog, debug: () => {} };
  if (localFeedUrl) {
    engine.forceDevUpdateConfig = true; // 开发/隔离模式绕过 packaged 限制
    engine.setFeedURL({ provider: 'generic', url: localFeedUrl, useMultipleRangeRequest: false });
    onLog(`shell更新使用本地隔离 feed：${localFeedUrl}`);
  }

  engine.on('checking-for-update', () => setState({ phase: 'checking' }));
  engine.on('update-available', info => {
    const version = typeof info?.version === 'string' ? info.version : null;
    if (version && stagedVersion && version !== stagedVersion) stagedVersion = null; // 新目标版本，旧下载件作废
    setState({ phase: 'available', version, error: null });
  });
  engine.on('update-not-available', () => {
    stagedVersion = null;
    setState({ phase: 'idle', version: null, progress: null });
  });
  engine.on('download-progress', info => {
    if (downloadGeneration !== generation) return; // 过期下载事件不得覆盖新操作状态
    setState({ phase: 'downloading', progress: { receivedBytes: Number(info?.transferred ?? 0), totalBytes: Number(info?.total ?? 0) } });
  });
  engine.on('update-downloaded', info => {
    if (downloadGeneration !== generation) return;
    stagedVersion = typeof info?.version === 'string' ? info.version : api.state.version;
    setState({ phase: 'downloaded', version: stagedVersion, progress: null });
  });
  const failInstall = error => {
    stagedVersion = null;
    installFailed = true;
    const detail = error?.code ? messageOf(error) : error?.message ?? String(error);
    setState({ phase: 'error', progress: null, error: `SHELL_INSTALL_FAILED:${detail}` });
  };
  engine.on('error', error => {
    if (disposed || installFailed) return;
    if (api.state.phase === 'installing') failInstall(error);
    else setState({ phase: 'error', error: messageOf(error) });
  });

  api.check = async ({ manual = false } = {}) => {
    if (opBusy || installFailed || api.state.phase === 'installing' || (!manual && api.state.phase === 'downloaded')) return api.state;
    opBusy = true;
    const gen = ++generation;
    setState({ phase: 'checking', error: null, checkedAt: new Date().toISOString() });
    try {
      await engine.checkForUpdates();
      if (gen === generation && manual) onLog('shell更新检查完成');
    } catch (error) {
      if (gen === generation) setState({ phase: 'error', error: messageOf(error) });
    } finally {
      opBusy = false;
    }
    return api.state;
  };

  api.download = async () => {
    if (opBusy || api.state.phase !== 'available') return api.state;
    opBusy = true;
    const gen = ++generation;
    downloadGeneration = gen;
    setState({ phase: 'downloading', progress: { receivedBytes: 0, totalBytes: 0 }, error: null });
    try {
      await engine.downloadUpdate();
      // 成功路径由 update-downloaded 事件写入 downloaded 相位
    } catch (error) {
      if (gen === generation) setState({ phase: 'error', error: messageOf(error) });
    } finally {
      opBusy = false;
    }
    return api.state;
  };

  api.quitAndInstall = () => {
    // downloaded 直接安装；error 但缓存里确有已校验下载件（如安装被取消）也允许重试
    if (api.state.phase !== 'downloaded' && !(api.state.phase === 'error' && stagedVersion)) return false;
    setState({ phase: 'installing', error: null });
    try {
      engine.quitAndInstall(true, true); // win：/S 静默 + --force-run；mac 参数被忽略（Squirrel 自动重启）
      return api.state.phase === 'installing';
    } catch (error) {
      failInstall(error);
      return false;
    }
  };

  /** 空闲门禁失败/取消后：下载件仍在缓存，回落 error 相位，可重新确认安装（差分缓存让重装很便宜）。 */
  api.markInstallFailed = reason => {
    setState({ phase: 'error', error: messageOf({ code: 'SHELL_INSTALL_ABORTED', message: String(reason).slice(0, 300) }) });
  };

  api.scheduleAutoCheck = ({ initialDelayMs = SHELL_CHECK_INITIAL_DELAY_MS, intervalMs = SHELL_CHECK_INTERVAL_MS } = {}) => {
    if (autoTimer) clearTimeout(autoTimer);
    if (autoInterval) clearInterval(autoInterval);
    autoTimer = setTimeout(() => {
      void api.check();
      autoInterval = setInterval(() => void api.check(), intervalMs);
      if (typeof autoInterval.unref === 'function') autoInterval.unref();
    }, initialDelayMs);
    if (typeof autoTimer.unref === 'function') autoTimer.unref();
  };

  return api;
}

module.exports = { createShellUpdater, resolveElectronUpdater, SHELL_CHECK_INITIAL_DELAY_MS, SHELL_CHECK_INTERVAL_MS };

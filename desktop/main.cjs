const { app, BrowserWindow, Menu, dialog, shell, session, ipcMain, nativeTheme } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } = require('node:fs');
const path = require('node:path');
// —— 启动可观测：日志初始化与进程级异常钩子必须先于一切本地模块 require ——
// 教训：0.1.1-beta 的 app.asar 缺 context-menu.cjs，require 阶段即崩，发生在日志初始化
// 之前——desktop.log 零痕迹，用户只看到 Electron 默认英文弹窗（2026-11-18 启动崩溃）。
app.setName('Prism');
if (process.env.PRISM_DESKTOP_PROFILE) app.setPath('userData', path.resolve(process.env.PRISM_DESKTOP_PROFILE));
let currentLogPath;
try {
  currentLogPath = path.join(app.getPath('userData'), 'desktop.log');
  mkdirSync(path.dirname(currentLogPath), { recursive: true });
} catch { /* userData 不可用时退化为无日志；异常钩子按同样路径兜底 */ }
const logLine = message => { try { if (currentLogPath) appendFileSync(currentLogPath, `${new Date().toISOString()} ${message}\n`); } catch { /* 日志失败不放大故障 */ } };
logLine(`main.cjs 模块加载开始（Electron ${process.versions.electron}）`);
process.on('uncaughtException', error => {
  const stack = error?.stack ?? String(error);
  logLine(`[fatal] 未捕获异常：${stack}`);
  try { dialog.showErrorBox('棱镜遇到未处理的错误', `${stack}\n\n日志：${currentLogPath ?? '不可用'}`); } catch { /* 无GUI环境 */ }
  app.exit(1);
});
process.on('unhandledRejection', reason => logLine(`[fatal] 未处理的Promise拒绝：${reason?.stack ?? String(reason)}`));

const { isInternal, isExternal, dataDirectory, windowChromeOptions, titleBarOverlay, clipboardPermissionAllowed } = require('./policy.cjs');
const { attachDirectoryPicker } = require('./directory-picker.cjs');
const { attachBrowserHost } = require('./browser-host.cjs');
const { buildTextContextMenuTemplate } = require('./context-menu.cjs');
const { PrismUpdater } = require('./updates/updater.cjs');
const { createShellUpdater } = require('./updates/shellUpdater.cjs');
const { compareVersions } = require('./updates/manifest.cjs');

let window, backend, origin, quitting = false, shutdownStarted = false;
let currentToken = '';            // 每次后端启动更换；webRequest 注入按当前值
let updater = null;               // 业务资源包更新器（主进程独占）
let shellUpdater = null;          // shell层（完整应用）静默更新器（electron-updater 包装）
let applyFlow = null;             // { releaseId, applyId, cancelled, noCancel } 切换期间抑制退出弹窗并承载取消
let currentDataDir, currentNode, currentBundledWorkspace, currentSelection, currentBuildInfo;
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) { logLine('已有实例在运行，第二实例退出'); app.quit(); }
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('activate', () => { if (window) window.show(); else if (origin) void createWindow(); else logLine('activate 时后端尚未就绪，忽略'); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (!backend || backend.exitCode !== null || shutdownStarted) return;
    event.preventDefault(); quitting = true; shutdownStarted = true;
    const child = backend;
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.once('exit', () => { clearTimeout(timer); backend = undefined; app.quit(); });
    if (child.connected) child.send({ type: 'shutdown' }); else child.kill();
  });
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('棱镜启动失败', `${error.message}\n日志：${app.getPath('userData')}/desktop.log`);
    app.quit();
  });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// —— 外置业务包工作区选择：active 记录复核通过才启用；未确认候选按失败回退；缺失/损坏回随包 —— //
function ensureNodeModulesLink(workspaceDir, bundledWorkspace) {
  if (path.resolve(workspaceDir) === path.resolve(bundledWorkspace)) return;
  const target = path.join(bundledWorkspace, 'node_modules');
  const link = path.join(workspaceDir, 'node_modules');
  if (!existsSync(target)) throw new Error(`宿主生产依赖缺失：${target}`);
  let linked = false;
  try { linked = realpathSync(link) === realpathSync(target); } catch { linked = false; }
  if (!linked) {
    rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    logLine(`已建立受控依赖链接：${link} -> ${target}`);
  }
  if (realpathSync(link) !== realpathSync(target)) throw new Error('依赖链接目标异常');
}

function selectWorkspace({ bundledWorkspace, updater: instance }) {
  const store = instance.store;
  const state = store.readState();
  const pending = store.readPending();
  if (pending?.releaseId) {
    const record = store.readReleaseRecord(pending.releaseId);
    if (record?.manifest && !(state.activeReleaseId === pending.releaseId && record.status === 'activated')) store.writeReleaseRecord(pending.releaseId, { status: 'failed', manifest: record.manifest, failedAt: new Date().toISOString(), reason: '启动时存在未确认候选，按失败回退' });
    store.clearPending();
    logLine(`发现未确认候选 ${pending.releaseId}，已标记失败并回退；可在更新界面重新应用。`);
  }
  const bundled = () => ({
    workspace: bundledWorkspace,
    identity: {
      sourceSha: currentBuildInfo.sourceSha ?? null,
      businessVersion: currentBuildInfo.businessVersion ?? currentBuildInfo.version ?? app.getVersion(),
      runtimeCompatibilityId: currentBuildInfo.runtimeCompatibilityId ?? null,
      databaseSchemaVersion: currentBuildInfo.databaseSchemaVersion ?? null,
    },
    releaseId: null,
  });
  for (const id of [...new Set([state.activeReleaseId, state.lastGoodReleaseId].filter(Boolean))]) {
    try {
      const manifest = instance.preApplyCheck(id, { allowRollback: true });
      // 完整安装已带来更高业务基线；旧active/lastGood即使签名及运行时兼容也不能遮蔽它。
      // 保留旧包、记录及最高已接受序号，供人工恢复；同版本维护包与更新版本仍可使用。
      if (compareVersions(manifest.productVersion, bundled().identity.businessVersion) < 0) {
        logLine(`外置业务包 ${id}（${manifest.productVersion}）低于随包版本，已跳过并保留恢复材料。`);
        continue;
      }
      const workspace = store.workspaceOf(id);
      ensureNodeModulesLink(workspace, bundledWorkspace);
      if (id !== state.activeReleaseId) store.writeState({ activeReleaseId: id, lastGoodReleaseId: null });
      return { workspace, identity: { sourceSha: manifest.sourceSha, businessVersion: manifest.productVersion, runtimeCompatibilityId: manifest.runtimeCompatibilityId, databaseSchemaVersion: manifest.databaseSchemaVersion }, releaseId: id };
    } catch (error) { logLine(`外置业务包 ${id} 复核失败：${error.message}`); }
  }
  if (state.activeReleaseId || state.lastGoodReleaseId) store.writeState({ activeReleaseId: null, lastGoodReleaseId: null });
  return bundled();
}

async function startBackend({ workspace, node, dataDir, identity, candidate = false }) {
  const token = randomBytes(32).toString('hex');
  const env = { ...process.env, DEBATE_DATA_DIR: dataDir, PRISM_DESKTOP_TOKEN: token };
  env.PRISM_SOURCE_SHA = identity.sourceSha || '';
  env.PRISM_UPDATE_CANDIDATE = candidate ? '1' : '';
  env.PRISM_BUSINESS_VERSION = identity.businessVersion ?? '';
  env.PRISM_HOST_VERSION = identity.hostVersion ?? '';
  if (identity.runtimeCompatibilityId) env.PRISM_RUNTIME_COMPAT = identity.runtimeCompatibilityId;
  if (identity.databaseSchemaVersion) env.PRISM_DATABASE_SCHEMA_VERSION = String(identity.databaseSchemaVersion);
  env.PATH = `${path.dirname(node)}${path.delimiter}${process.env.PATH || ''}${process.platform === 'darwin' ? ':/opt/homebrew/bin:/usr/local/bin' : ''}`;
  const child = spawn(node, [path.join(workspace, 'desktop', 'backend.mjs')], {
    cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env,
  });
  // 子进程输出按行加时间戳入desktop.log；保留stderr尾部供启动超时诊断（定位ready前盲区卡点）。
  let stderrTail = '';
  const childLog = tag => {
    let rest = '';
    const write = line => { if (line) logLine(`${tag} ${line}`); };
    return chunk => {
      rest += chunk.replace(/\r/g, '');
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) write(line);
    };
  };
  const forwardOut = childLog('[out]'), forwardErr = childLog('[err]');
  child.stdout.on('data', data => forwardOut(data.toString()));
  child.stderr.on('data', data => { const text = data.toString(); stderrTail = `${stderrTail}${text}`.slice(-4000); forwardErr(text); });
  child.once('exit', () => { forwardOut('\n'); forwardErr('\n'); });
  attachDirectoryPicker(child, { dialog, getWindow: () => window, allowed: () => backend === child && !quitting && !applyFlow });
  logLine(`目录选择器已挂载（后端 pid=${child.pid}）`);
  attachBrowserHost(child, { onLog: logLine, allowed: () => backend === child && !quitting && !applyFlow, getParent: () => window });
  logLine(`内嵌浏览器宿主已挂载（后端 pid=${child.pid}）`);
  let ready;
  try { ready = await new Promise((resolve, reject) => {
    const waitStart = Date.now();
    // 慢盘/杀软机器首启可能显著超过30秒：进程存活即继续等待并每30秒记日志，120秒硬上限才判失败。
    const progress = setInterval(() => logLine(`后端启动缓慢：已等待${Math.round((Date.now() - waitStart) / 1000)}秒仍未就绪，继续等待（pid=${child.pid}）`), 30000);
    const timer = setTimeout(() => reject(new Error('本地服务启动超时')), 120000);
    const cleanup = () => { clearTimeout(timer); clearInterval(progress); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', code => { cleanup(); reject(new Error(`本地服务已退出（${code}），请检查日志。`)); });
    child.on('message', message => { if (message?.type === 'ready') { cleanup(); resolve(message); } });
  }); } catch (error) {
    if (error.message === '本地服务启动超时') {
      const tail = stderrTail.trim();
      error.message = tail ? `本地服务启动超时。后端最后输出：\n${tail}` : '本地服务启动超时：后端全程无输出（卡在依赖模块加载阶段）';
    }
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); }
    throw error;
  }
  child.on('exit', code => {
    if (backend === child && !applyFlow && !quitting) {
      dialog.showErrorBox('棱镜本地服务已停止', `退出代码：${code}。请重新打开应用。`); app.quit();
    }
  });
  return { child, token, port: ready.port };
}

function backendRequest(child, message, replyType, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error, result) => {
      clearTimeout(timer); child.removeListener('message', onMessage); child.removeListener('exit', onExit);
      error ? reject(error) : resolve(result);
    };
    const onExit = () => finish(new Error('后端IPC已断开'));
    const onMessage = reply => {
      if (reply?.type === replyType && (message.applyId === undefined || reply.applyId === message.applyId)) finish(null, reply);
    };
    child.on('message', onMessage); child.once('exit', onExit);
    timer = setTimeout(() => finish(new Error(`IPC超时：${message.type}`)), timeoutMs);
    if (!child.connected) return finish(new Error('后端IPC已断开'));
    child.send(message, error => { if (error) finish(error); });
  });
}

async function stopBackendGracefully(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } resolve(); }, 20000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send({ type: 'shutdown' }); else child.kill();
  });
}

/** 健康门禁：不只判断进程存在——校验业务版本/源码SHA一致与静态页可达。 */
async function healthGate({ port, token, expectedSourceSha, expectedBusinessVersion, timeoutMs = 30000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '未知';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { headers: { 'x-prism-desktop-token': token } });
      if (response.ok) {
        const body = await response.json();
        const page = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-prism-desktop-token': token } }); // 静态页也在桌面令牌之后，探测须携带
        const data = body?.data;
        const versionOk = data?.businessVersion === expectedBusinessVersion;
        const shaOk = !expectedSourceSha || (typeof data?.sourceSha === 'string' && data.sourceSha === expectedSourceSha);
        if (page.ok && versionOk && shaOk) return data;
        lastError = `身份不一致 version=${data?.businessVersion}/${expectedBusinessVersion} sha=${String(data?.sourceSha).slice(0, 12)}/${String(expectedSourceSha).slice(0, 12)} page=${page.status}`;
      } else lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error.message; }
    await sleep(500);
  }
  throw new Error(`健康门禁未通过：${lastError}`);
}

/** 合并状态：业务资源包（updater）+ shell 静默更新（shellUpdater），两引擎任一变更都整体推送。 */
function mergedStatus() {
  return { ...updater.getStatus(), shellUpdate: shellUpdater ? shellUpdater.state : null };
}
function broadcastState() {
  if (window && !window.isDestroyed() && updater) window.webContents.send('updates:state', mergedStatus());
}

/** 应用资源包更新：屏障→空闲确认→一致性快照→停旧→启候选→健康门禁→确认/回退。 */
async function applyUpdate(releaseId) {
  if (applyFlow) return { ok: false, error: 'UPDATE_ALREADY_APPLYING' };
  const applyId = randomBytes(8).toString('hex');
  applyFlow = { releaseId, applyId, cancelled: false, noCancel: false };
  const previousBackend = backend;
  const previousSelection = currentSelection;
  let oldStopped = false;
  try {
    const manifest = updater.preApplyCheck(releaseId);
    updater.setPhase('waiting-idle');
    const prepare = await backendRequest(backend, { type: 'update:prepare', applyId }, 'update:prepare-result');
    let snapshot = prepare.snapshot;
    const deadline = Date.now() + 15 * 60_000;
    while (!snapshot?.idle) {
      if (applyFlow.cancelled) throw new Error('UPDATE_CANCELLED');
      if (Date.now() > deadline) throw new Error('TASKS_BUSY_TIMEOUT：任务未空闲，本次更新已取消');
      await sleep(2000);
      snapshot = (await backendRequest(backend, { type: 'update:status', applyId }, 'update:status-result')).snapshot;
    }
    if (applyFlow.cancelled) throw new Error('UPDATE_CANCELLED');
    const snapshotDir = path.join(updater.store.snapshotsDir, `${releaseId}-${applyId}`);
    const snap = await backendRequest(backend, { type: 'update:snapshot', applyId, dir: snapshotDir }, 'update:snapshot-result', 60000);
    if (!snap.ok) throw new Error(`快照失败：${snap.error}`);
    applyFlow.noCancel = true;
    updater.store.writePending({ releaseId, applyId, snapshotDir, startedAt: new Date().toISOString() });
    oldStopped = true;
    backend = undefined;
    await stopBackendGracefully(previousBackend);
    const candidateWorkspace = updater.store.workspaceOf(releaseId);
    ensureNodeModulesLink(candidateWorkspace, currentBundledWorkspace);
    const identity = { sourceSha: manifest.sourceSha, businessVersion: manifest.productVersion, runtimeCompatibilityId: manifest.runtimeCompatibilityId, databaseSchemaVersion: manifest.databaseSchemaVersion };
    const started = await startBackend({ workspace: candidateWorkspace, node: currentNode, dataDir: currentDataDir, identity: { ...identity, hostVersion: app.getVersion() }, candidate: true });
    backend = started.child; currentToken = started.token;
    await healthGate({ port: started.port, token: started.token, expectedSourceSha: manifest.sourceSha, expectedBusinessVersion: manifest.productVersion });
    await backendRequest(backend, { type: 'update:commit', applyId }, 'update:commit-result');
    updater.confirmApply(releaseId);
    updater.host.businessVersion = manifest.productVersion;
    origin = `http://127.0.0.1:${started.port}`;
    currentSelection = { workspace: candidateWorkspace, identity, releaseId };
    applyFlow = null; broadcastState();
    logLine(`业务包已切换：${releaseId}（业务版本 ${manifest.productVersion}）`);
    if (window && !window.isDestroyed()) {
      try { await window.loadURL(origin); } catch (error) { logLine(`业务已升级，窗口刷新失败：${error.message}`); }
    }
    return { ok: true, version: manifest.productVersion };
  } catch (error) {
    updater.failApply(releaseId, error.message, { markFailed: oldStopped });
    logLine(`更新应用失败：${error.message}`);
    if (!oldStopped) {
      // 等待／快照失败时旧任务仍可能运行，绝不停止或重启旧服务。
      if (previousBackend?.connected) {
        try { await backendRequest(previousBackend, { type: 'update:abort', applyId }, 'update:abort-result'); }
        catch (abortError) { logLine(`解除更新屏障失败：${abortError.message}`); }
      }
      applyFlow = null; broadcastState();
      return { ok: false, cancelled: error.message === 'UPDATE_CANCELLED', error: error.message };
    }
    try {
      if (backend) await stopBackendGracefully(backend);
      backend = undefined;
      let fallback = previousSelection;
      if (fallback.releaseId) {
        try { updater.preApplyCheck(fallback.releaseId, { allowRollback: true }); }
        catch { fallback = { workspace: currentBundledWorkspace, identity: { sourceSha: currentBuildInfo.sourceSha, businessVersion: currentBuildInfo.businessVersion ?? currentBuildInfo.version, runtimeCompatibilityId: currentBuildInfo.runtimeCompatibilityId, databaseSchemaVersion: currentBuildInfo.databaseSchemaVersion }, releaseId: null }; }
      }
      ensureNodeModulesLink(fallback.workspace, currentBundledWorkspace);
      const started = await startBackend({ workspace: fallback.workspace, node: currentNode, dataDir: currentDataDir, identity: { ...fallback.identity, hostVersion: app.getVersion() } });
      backend = started.child; currentToken = started.token;
      await healthGate({ port: started.port, token: started.token, expectedSourceSha: fallback.identity.sourceSha ?? '', expectedBusinessVersion: fallback.identity.businessVersion });
      currentSelection = fallback; updater.host.businessVersion = fallback.identity.businessVersion;
      updater.store.writeState({ activeReleaseId: fallback.releaseId });
      origin = `http://127.0.0.1:${started.port}`;
      applyFlow = null; broadcastState();
      if (window && !window.isDestroyed()) await window.loadURL(origin);
    } catch (fallbackError) {
      applyFlow = null;
      logLine(`回退启动失败：${fallbackError.message}`);
      dialog.showErrorBox('棱镜本地服务已停止', `更新回退失败：${fallbackError.message}\n日志：${currentLogPath}`); app.quit();
    }
    return { ok: false, error: error.message };
  }
}

function waitForShellInstall() {
  return new Promise((resolve, reject) => {
    const onState = state => {
      if (state.phase === 'error') finish(new Error(state.error));
    };
    const onQuit = () => finish();
    const finish = error => {
      shellUpdater.off('state', onState);
      app.off('before-quit', onQuit);
      if (error) reject(error);
      else resolve();
    };
    shellUpdater.on('state', onState);
    app.once('before-quit', onQuit);
    if (!shellUpdater.quitAndInstall()) finish(new Error(shellUpdater.state.error ?? 'SHELL_UPDATE_NOT_READY'));
  });
}

/** shell层（完整应用）安装：空闲门禁后 quitAndInstall。before-quit 负责排空后端，
 * 安装器静默覆盖并自动重启；不写 pending、不换工作区、不做健康门禁（整包由 electron-updater 校验）。 */
async function applyShellUpdate() {
  if (applyFlow) return { ok: false, error: 'UPDATE_ALREADY_APPLYING' };
  if (!shellUpdater || shellUpdater.state.phase !== 'downloaded') { broadcastState(); return { ok: false, error: 'SHELL_UPDATE_NOT_READY' }; }
  const applyId = randomBytes(8).toString('hex');
  const releaseId = `shell-${shellUpdater.state.version ?? 'unknown'}`;
  applyFlow = { releaseId, applyId, cancelled: false, noCancel: false };
  try {
    const prepare = await backendRequest(backend, { type: 'update:prepare', applyId }, 'update:prepare-result');
    let snapshot = prepare.snapshot;
    const deadline = Date.now() + 15 * 60_000;
    while (!snapshot?.idle) {
      if (applyFlow.cancelled) throw new Error('UPDATE_CANCELLED');
      if (Date.now() > deadline) throw new Error('TASKS_BUSY_TIMEOUT：任务未空闲，本次更新已取消');
      await sleep(2000);
      snapshot = (await backendRequest(backend, { type: 'update:status', applyId }, 'update:status-result')).snapshot;
    }
    if (applyFlow.cancelled) throw new Error('UPDATE_CANCELLED');
    // 重启前同样留一致性快照：万一重启后异常，回退排查有据可依。
    const snapshotDir = path.join(updater.store.snapshotsDir, `shell-${applyId}`);
    const snap = await backendRequest(backend, { type: 'update:snapshot', applyId, dir: snapshotDir }, 'update:snapshot-result', 60000);
    if (!snap.ok) logLine(`shell更新快照失败（不阻断安装）：${snap.error}`);
    applyFlow.noCancel = true;
    logLine(`shell更新开始静默安装：${shellUpdater.state.version}`);
    await waitForShellInstall();
    return { ok: true };
  } catch (error) {
    logLine(`shell更新应用失败：${error.message}`);
    if (backend?.connected) {
      try { await backendRequest(backend, { type: 'update:abort', applyId }, 'update:abort-result'); }
      catch (abortError) { logLine(`解除更新屏障失败：${abortError.message}`); }
    }
    applyFlow = null;
    if (shellUpdater.state.phase !== 'error') shellUpdater.markInstallFailed(error.message);
    broadcastState();
    return { ok: false, cancelled: error.message === 'UPDATE_CANCELLED', error: error.message };
  }
}

function registerUpdateIpc() {
  const trusted = event => {
    try {
      return !!window && !window.isDestroyed() && event.sender === window.webContents
        && event.senderFrame === window.webContents.mainFrame
        && typeof event.senderFrame?.url === 'string' && isInternal(event.senderFrame.url, origin);
    } catch { return false; }
  };
  const releaseIdArg = value => {
    const id = String(value ?? '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error('RELEASE_ID_INVALID');
    return id;
  };
  ipcMain.on('window:theme', (event, theme) => {
    if (!trusted(event) || event.senderFrame !== window.webContents.mainFrame || process.platform !== 'win32' || !['dark', 'light'].includes(theme)) return;
    window.setTitleBarOverlay(titleBarOverlay(theme));
  });
  ipcMain.handle('updates:get-status', event => trusted(event) ? mergedStatus() : null);
  ipcMain.handle('updates:check', async event => {
    if (!trusted(event)) throw new Error('UNTRUSTED_SENDER');
    if (applyFlow) return mergedStatus();
    if (shellUpdater?.supported) void shellUpdater.check({ manual: true }); // 结果经 updates:state 推送
    return updater.checkNow({ manual: true });
  });
  ipcMain.handle('updates:download', async (event, releaseId) => {
    if (!trusted(event)) throw new Error('UNTRUSTED_SENDER');
    if (applyFlow) throw new Error('UPDATE_ALREADY_APPLYING');
    return updater.download(releaseIdArg(releaseId));
  });
  ipcMain.handle('updates:download-installer', async event => {
    if (!trusted(event) || event.senderFrame !== window.webContents.mainFrame) throw new Error('UNTRUSTED_SENDER');
    if (applyFlow) throw new Error('UPDATE_ALREADY_APPLYING');
    return updater.downloadInstaller();
  });
  ipcMain.handle('updates:open-installer', async (event, reveal) => {
    if (!trusted(event) || event.senderFrame !== window.webContents.mainFrame) throw new Error('UNTRUSTED_SENDER');
    const file = reveal === true ? updater.installer.readyPath() : await updater.installer.verifiedPath();
    if (reveal === true) shell.showItemInFolder(file);
    else { const error = await shell.openPath(file); if (error) throw new Error('INSTALLER_OPEN_FAILED'); }
  });
  ipcMain.handle('updates:apply', (event, releaseId) => {
    if (!trusted(event)) throw new Error('UNTRUSTED_SENDER');
    const id = releaseIdArg(releaseId);
    if (applyFlow) return { started: false, reason: '已有更新在进行' };
    void applyUpdate(id); // 异步执行：立即应答，进度与结果经 updates:state 事件推送
    return { started: true };
  });
  ipcMain.handle('updates:download-shell', async event => {
    if (!trusted(event) || event.senderFrame !== window.webContents.mainFrame) throw new Error('UNTRUSTED_SENDER');
    if (applyFlow) throw new Error('UPDATE_ALREADY_APPLYING');
    await shellUpdater.download();
    return mergedStatus();
  });
  ipcMain.handle('updates:apply-shell', event => {
    if (!trusted(event)) throw new Error('UNTRUSTED_SENDER');
    if (applyFlow) return { started: false, reason: '已有更新在进行' };
    if (shellUpdater?.state.phase !== 'downloaded') return { started: false, reason: '新版本尚未下载完成' };
    void applyShellUpdate(); // 空闲门禁在后台执行，进度经 updates:state 推送
    return { started: true };
  });
  ipcMain.handle('updates:cancel-apply', event => {
    if (!trusted(event)) throw new Error('UNTRUSTED_SENDER');
    if (applyFlow && !applyFlow.noCancel) applyFlow.cancelled = true;
    return { cancelled: !!applyFlow && !applyFlow.noCancel };
  });
}

async function start() {
  const workspace = app.isPackaged ? path.join(process.resourcesPath, 'workspace') : app.getAppPath();
  const node = app.isPackaged ? path.join(process.resourcesPath, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node') : process.env.PRISM_NODE_PATH;
  if (!node || !existsSync(node)) throw new Error('缺少 Node 24 运行环境；开发模式请设置 PRISM_NODE_PATH。');
  const dataDir = dataDirectory(process.env, app.getPath('userData'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  currentDataDir = dataDir; currentNode = node; currentBundledWorkspace = workspace;
  currentLogPath = path.join(app.getPath('userData'), 'desktop.log');
  mkdirSync(path.dirname(currentLogPath), { recursive: true });
  logLine(`Prism ${app.getVersion()} starting`);
  // build-info 由打包脚本写入主进程同目录（app.asar 内 desktop/，asar 读取透明）；开发模式没有该文件，更新身份退化为受限默认
  try { currentBuildInfo = JSON.parse(readFileSync(path.join(__dirname, 'build-info.json'), 'utf8')); } catch { currentBuildInfo = {}; }
  // 更新源：默认 GitHub 发行仓；仅显式隔离模式允许本地 HTTP feed（供验收演示）
  const feed = process.env.PRISM_UPDATES_ALLOW_LOCAL_FEED === '1' && (process.env.PRISM_UPDATES_FEED ?? '').startsWith('http://127.0.0.1')
    ? { localFeedUrl: process.env.PRISM_UPDATES_FEED, localFeedAssetBase: process.env.PRISM_UPDATES_FEED_ASSET_BASE ?? '' }
    : { githubRepo: 'Sssovereign/prism-agent-releases' };
  updater = new PrismUpdater({
    userDataDir: dataDir,
    hostIdentity: {
      platform: process.platform, arch: process.arch, channel: 'beta',
      hostVersion: app.getVersion(),
      businessVersion: currentBuildInfo.businessVersion ?? currentBuildInfo.version ?? app.getVersion(),
      runtimeCompatibilityId: currentBuildInfo.runtimeCompatibilityId ?? null,
      updatesPublicKey: currentBuildInfo.updatesPublicKey ?? null,
      updatesKeyId: currentBuildInfo.updatesKeyId ?? null,
    },
    feed,
    onLog: logLine,
  });
  updater.on('state', broadcastState);
  // shell层静默更新：electron-updater；app-update.yml 由打包注入（github provider=发行仓）。
  // 不可用（缺 yml/electron-updater）时 phase=unsupported，UI 回落手动安装包路径。
  shellUpdater = createShellUpdater({ isPackaged: app.isPackaged, onLog: logLine });
  shellUpdater.on('state', broadcastState);
  logLine(shellUpdater.supported ? 'shell静默更新已启用（electron-updater）' : 'shell静默更新不可用，保留手动安装包更新路径');
  currentSelection = selectWorkspace({ bundledWorkspace: workspace, updater });
  updater.host.businessVersion = currentSelection.identity.businessVersion;
  logLine(`业务工作区：${currentSelection.workspace}${currentSelection.releaseId ? `（外置包 ${currentSelection.releaseId}）` : '（随包）'}`);
  const started = await startBackend({ workspace: currentSelection.workspace, node, dataDir, identity: { ...currentSelection.identity, hostVersion: app.getVersion() } });
  backend = started.child;
  currentToken = started.token;
  origin = `http://127.0.0.1:${started.port}`;
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    if (isInternal(details.url, origin)) headers['x-prism-desktop-token'] = currentToken;
    else delete headers['x-prism-desktop-token'];
    callback({ requestHeaders: headers });
  });
  // 权限默认全拒，仅放行本地业务页的剪贴板读写（clipboardPermissionAllowed）。
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(clipboardPermissionAllowed(permission, details?.requestingUrl, origin));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return clipboardPermissionAllowed(permission, requestingOrigin, origin);
  });
  session.defaultSession.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
  });

  registerUpdateIpc();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: '棱镜', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: '文件', submenu: [{ role: 'close' }, ...(process.platform === 'darwin' ? [] : [{ role: 'quit' }])] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(process.platform === 'darwin' ? [{ role: 'front' }] : [])] },
    { label: '帮助', submenu: [
      { label: '检查更新…', click: () => { if (window && !window.isDestroyed()) window.webContents.send('updates:menu'); else void updater?.checkNow({ manual: true }); } },
      { label: '版本与安装', click: () => dialog.showMessageBox({ type: 'info', title: '棱镜 Prism',
        message: `棱镜 ${app.getVersion()}`,
        detail: `宿主版本 ${app.getVersion()}（Electron ${process.versions.electron}）\n业务版本 ${currentSelection?.identity?.businessVersion ?? app.getVersion()}\n数据保存在本机：${dataDir}\n完整升级可在应用内下载安装包。支持自动安装时，可在任务空闲后重启升级。` }) },
    ] },
  ]));
  await createWindow();
  if (process.env.PRISM_UPDATES_ACCEPTANCE) {
    try { await require('./updates/acceptance.cjs')({ app, window, updater, selection: () => currentSelection, isApplying: () => !!applyFlow }); }
    catch (error) {
      writeFileSync(process.env.PRISM_UPDATES_ACCEPTANCE, JSON.stringify({pass:false,error:error.stack})+'\n');
      console.error(error); app.exit(1);
    }
    return;
  }
  updater.scheduleAutoCheck(); // 启动延迟3分钟首查，此后每6小时；失败指数退避，不影响产品使用
  shellUpdater.scheduleAutoCheck(); // shell层：4分钟首查、6小时间隔（unref 不阻止退出）
  // 明确启用的隔离验收入口；正式启动不写诊断或执行页面脚本。
  if (process.env.PRISM_DESKTOP_SMOKE) {
    const waitForPage = () => window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const check = () => {
        const text = document.body.innerText;
        if (text.length > 20 && !text.includes('正在读取本机账号') && !text.includes('正在检查本机登录状态')) return resolve(true);
        if (Date.now() > deadline) return reject(new Error('页面初始化超时'));
        setTimeout(check, 100);
      }; check();
    })`);
    await waitForPage();
    let accountCheck;
    if (process.env.PRISM_DESKTOP_SMOKE_REGISTER === '1') {
      if (!dataDir.includes('.cache/verification/')) throw new Error('注册验收只允许隔离数据目录');
      accountCheck = await window.webContents.executeJavaScript(`fetch('/api/v1/auth/register', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'desktop_smoke',password:'SyntheticDesktop2026!',confirmation:'SyntheticDesktop2026!',remember:true})}).then(async r=>({status:r.status,user:(await r.json()).data?.user?.username}))`);
      if (accountCheck.status !== 201) throw new Error('桌面注册验收失败');
      await window.loadURL(origin);
      await waitForPage();
    }
    const signedIn = await window.webContents.executeJavaScript(`fetch('/api/v1/auth/me').then(async r=>({status:r.status,user:(await r.json()).data?.user?.username}))`);
    const result = await window.webContents.executeJavaScript(`({title:document.title,hasRoot:!!document.querySelector('#app'),text:document.body.innerText.slice(0,250),node:typeof process!=='undefined',url:location.href})`);
    const health = await window.webContents.executeJavaScript(`fetch('/api/v1/health').then(r=>r.json())`);
    const blocked = await fetch(`${origin}/api/v1/health`).then(r => r.status);
    writeFileSync(process.env.PRISM_DESKTOP_SMOKE, JSON.stringify({ ...result, health, blocked, appVersion: app.getVersion(), businessVersion: currentSelection?.identity?.businessVersion ?? null, activeReleaseId: currentSelection?.releaseId ?? null, executable: process.execPath, backendPid: backend.pid, accountCheck, signedIn }, null, 2));
    if (process.env.PRISM_DESKTOP_SCREENSHOT) writeFileSync(process.env.PRISM_DESKTOP_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    setTimeout(() => app.quit(), 500);
  }
}
async function createWindow() {
  window = new BrowserWindow({ width: 1320, height: 880, minWidth: 780, minHeight: 560, title: '棱镜 Prism', show: false,
    ...windowChromeOptions(process.platform, nativeTheme?.shouldUseDarkColors),
    backgroundColor: '#171719', autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, preload: path.join(__dirname, 'preload.cjs') },
  });
  window.on('closed', () => { window = undefined; });
  window.webContents.setWindowOpenHandler(({ url }) => { if (isExternal(url) && !isInternal(url, origin)) void shell.openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (!isInternal(url, origin)) { event.preventDefault(); if (isExternal(url)) void shell.openExternal(url); } });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  // 渲染层可观测：进程崩溃与 error 级控制台落盘（toast 是瞬时的，事后排查需要留痕）
  window.webContents.on('render-process-gone', (_event, details) => {
    logLine(`渲染进程异常退出：reason=${details.reason} exitCode=${details.exitCode}`);
    if (details.reason !== 'clean-exit') dialog.showErrorBox('棱镜页面进程已退出', `原因：${details.reason}（退出代码 ${details.exitCode}）。\n请重新打开应用；详情见日志：${currentLogPath}`);
  });
  window.webContents.on('preload-error', (_event, preloadPath, error) => logLine(`preload 加载失败：${preloadPath}：${error?.message ?? error}`));
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => { if (level >= 2) logLine(`[renderer:${level}] ${message}（${sourceId}:${line}）`); });
  window.webContents.on('context-menu', (_event, params) => {
    const devTools = app.isPackaged ? null : (x, y) => { if (window && !window.isDestroyed()) window.webContents.inspectElement(x, y); };
    const items = buildTextContextMenuTemplate(params, { devTools });
    if (items.length !== 0) Menu.buildFromTemplate(items).popup({ window });
  });
  await window.loadURL(origin);
  window.show();
}

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createShellUpdater: createPlatformShellUpdater } = require('./shellUpdater.cjs');
const createShellUpdater = options => createPlatformShellUpdater({ platform: 'win32', ...options });

/** 假 electron-updater：可控触发事件流，记录关键调用与配置写入；错误经 engine 属性动态注入。 */
function fakeEngine() {
  const engine = new EventEmitter();
  engine.checkError = null;
  engine.downloadError = null;
  engine.settings = {};
  engine.feedOptions = null;
  engine.checkForUpdates = async () => {
    if (engine.checkError) throw engine.checkError;
    engine.emit('checking-for-update');
    engine.emit('update-available', { version: '9.9.9-beta' });
  };
  engine.downloadUpdate = async () => {
    if (engine.downloadError) throw engine.downloadError;
    engine.emit('download-progress', { transferred: 40, total: 100 });
    engine.emit('download-progress', { transferred: 100, total: 100 });
    engine.emit('update-downloaded', { version: '9.9.9-beta' });
  };
  engine.quitAndInstall = (silent, forceRun) => { engine.settings.quitArgs = [silent, forceRun]; };
  engine.setFeedURL = options => { engine.feedOptions = options; };
  return engine;
}

function tmpConfig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'prism-shell-'));
  const file = join(dir, 'app-update.yml');
  writeFileSync(file, 'provider: generic\nurl: http://localhost:8081\n');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return file;
}

test('shell更新器：不可用时降级 unsupported，动作全部空转', async () => {
  const shell = createShellUpdater({ electronUpdaterModule: null, appUpdateConfigPath: '/nonexistent/app-update.yml', isPackaged: true });
  assert.equal(shell.supported, false);
  assert.equal(shell.state.phase, 'unsupported');
  assert.deepEqual(await shell.check(), shell.state);
  assert.deepEqual(await shell.download(), shell.state);
  assert.equal(shell.quitAndInstall(), false);
});

test('shell更新器：发现→差分下载→就绪→静默安装参数正确，配置全关', async t => {
  const engine = fakeEngine();
  const shell = createShellUpdater({ electronUpdaterModule: { autoUpdater: engine }, appUpdateConfigPath: tmpConfig(t), isPackaged: true });
  assert.equal(shell.supported, true);
  assert.equal(engine.autoDownload, false, 'autoDownload 必须关闭：下载由用户确认');
  assert.equal(engine.autoInstallOnAppQuit, false, '退出时静默安装必须关闭：重启时机由空闲门禁决定');
  assert.equal(engine.allowDowngrade, false);
  assert.equal(engine.allowPrerelease, true, 'beta 通道接受预发行');

  const states = [];
  shell.on('state', value => states.push(value.phase));
  const afterCheck = await shell.check({ manual: true });
  assert.equal(afterCheck.phase, 'available');
  assert.equal(afterCheck.version, '9.9.9-beta');
  assert.ok(states.includes('checking'));

  const afterDownload = await shell.download();
  assert.equal(afterDownload.phase, 'downloaded');
  assert.equal(afterDownload.progress, null, '下载完成清空进度');
  assert.equal(afterDownload.version, '9.9.9-beta');

  assert.equal(shell.quitAndInstall(), true);
  assert.deepEqual(engine.settings.quitArgs, [true, true], 'win：/S 静默 + --force-run 自动重启；mac 忽略参数');
  assert.equal(shell.state.phase, 'installing');
});

test('shell更新器：检查失败与下载失败进入 error 并携带错误码，可再次检查恢复', async t => {
  const engine = fakeEngine();
  engine.checkError = Object.assign(new Error('boom'), { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' });
  const shell = createShellUpdater({ electronUpdaterModule: { autoUpdater: engine }, appUpdateConfigPath: tmpConfig(t), isPackaged: true });
  const failed = await shell.check();
  assert.equal(failed.phase, 'error');
  assert.equal(failed.error, 'ERR_UPDATER_INVALID_RELEASE_FEED:boom');

  engine.checkError = null;
  const recovered = await shell.check();
  assert.equal(recovered.phase, 'available');
  assert.equal(recovered.error, null);

  engine.downloadError = new Error('net down');
  const downloadFailed = await shell.download();
  assert.equal(downloadFailed.phase, 'error');
  assert.ok(downloadFailed.error.startsWith('SHELL_UPDATE_FAILED:'), downloadFailed.error);
  assert.equal(shell.quitAndInstall(), false, 'error 相位（非下载件就绪路径）不安装');
});

test('shell更新器：安装失败后缓存下载件仍可重试安装，未下载过则不行', async t => {
  const engine = fakeEngine();
  const shell = createShellUpdater({ electronUpdaterModule: { autoUpdater: engine }, appUpdateConfigPath: tmpConfig(t), isPackaged: true });
  await shell.check();
  await shell.download();
  shell.markInstallFailed('空闲门禁失败，本次取消');
  assert.equal(shell.state.phase, 'error');
  assert.equal(shell.quitAndInstall(), true, '缓存里确有已校验下载件：error 相位允许直接重试');
  assert.equal(shell.state.phase, 'installing');
});

test('shell更新器：过期事件不得覆盖新操作状态（generation 守卫）', async t => {
  const engine = fakeEngine();
  const shell = createShellUpdater({ electronUpdaterModule: { autoUpdater: engine }, appUpdateConfigPath: tmpConfig(t), isPackaged: true });
  await shell.check();
  await shell.download();
  assert.equal(shell.state.phase, 'downloaded');
  assert.equal((await shell.check()).phase, 'downloaded', '自动检查保留已准备完成的安装');
  await shell.check({ manual: true }); // 手动检查开启新操作
  // 模拟上一轮下载的迟到事件：downloadGeneration 落后 generation，事件必须被丢弃
  engine.emit('download-progress', { transferred: 1, total: 100 });
  engine.emit('update-downloaded', { version: '9.9.9-beta' });
  assert.notEqual(shell.state.phase, 'downloading');
  assert.equal(shell.state.progress, null, '迟到进度不得写入');
});

test('shell更新器：拒绝重入，安装异步失败后保持错误状态并回退手动安装', async t => {
  let releaseCheck;
  const engine = fakeEngine();
  engine.checkForUpdates = () => new Promise(resolve => {
    releaseCheck = () => { engine.emit('checking-for-update'); engine.emit('update-available', { version: '9.9.9-beta' }); resolve(); };
  });
  const shell = createShellUpdater({ electronUpdaterModule: { autoUpdater: engine }, appUpdateConfigPath: tmpConfig(t), isPackaged: true });
  const first = shell.check();
  const second = await shell.check();
  assert.equal(second.phase, 'checking', '重入直接返回当前状态');
  releaseCheck();
  const done = await first;
  assert.equal(done.phase, 'available');

  await shell.download();
  assert.equal(shell.state.phase, 'downloaded');
  shell.quitAndInstall();
  engine.checkForUpdates = async () => engine.emit('update-available', { version: '9.9.9-beta' });
  assert.equal((await shell.check()).phase, 'installing');
  engine.emit('error', new Error('代码签名无效'));
  assert.equal(shell.state.phase, 'error');
  assert.equal(shell.state.error, 'SHELL_INSTALL_FAILED:代码签名无效');
  assert.equal(shell.quitAndInstall(), false);
  assert.equal((await shell.check({ manual: true })).phase, 'error');
});

test('shell更新器：安装器同步报告失败时不返回成功', async t => {
  const engine = fakeEngine();
  engine.quitAndInstall = () => engine.emit('error', new Error('安装包已丢失'));
  const shell = createShellUpdater({ electronUpdaterModule: { autoUpdater: engine }, appUpdateConfigPath: tmpConfig(t), isPackaged: true });
  await shell.check();
  await shell.download();
  assert.equal(shell.quitAndInstall(), false);
  assert.equal(shell.state.error, 'SHELL_INSTALL_FAILED:安装包已丢失');
});

test('shell更新器：本地隔离 feed 只允许 127.0.0.1，设置走 setFeedURL + forceDevUpdateConfig', async t => {
  assert.throws(() => createShellUpdater({ electronUpdaterModule: { autoUpdater: fakeEngine() }, appUpdateConfigPath: tmpConfig(t), localFeedUrl: 'http://evil.example/feed', isPackaged: true }), /仅允许 http:\/\/127\.0\.0\.1/);
  const engine = fakeEngine();
  const shell = createShellUpdater({ electronUpdaterModule: { autoUpdater: engine }, appUpdateConfigPath: tmpConfig(t), localFeedUrl: 'http://127.0.0.1:8099/latest.yml', isPackaged: true });
  assert.deepEqual(engine.feedOptions, { provider: 'generic', url: 'http://127.0.0.1:8099/latest.yml', useMultipleRangeRequest: false });
  assert.equal(engine.forceDevUpdateConfig, true);
  assert.equal(shell.supported, true);
});

test('shell更新器：自动检查调度可取消（dispose 后不再触发）', async t => {
  const engine = fakeEngine();
  let checks = 0;
  engine.checkForUpdates = async () => { checks++; engine.emit('update-not-available'); };
  const shell = createShellUpdater({ electronUpdaterModule: { autoUpdater: engine }, appUpdateConfigPath: tmpConfig(t), isPackaged: true });
  shell.scheduleAutoCheck({ initialDelayMs: 10, intervalMs: 10 });
  await new Promise(resolve => setTimeout(resolve, 80));
  const before = checks;
  assert.ok(before >= 1, '初始延迟后至少检查一次');
  shell.dispose();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(checks, before, 'dispose 后定时检查停止');
});

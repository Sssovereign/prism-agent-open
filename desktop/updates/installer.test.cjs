const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, readFileSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { InstallerDownload } = require('./installer.cjs');
const { PrismUpdater } = require('./updater.cjs');
const { downloadGuardFor, listReleases, FeedError } = require('./feed.cjs');

test('完整安装包：按平台发现→流式本地下载→校验→重新核验打开，拒绝损坏及任意路径', async t => {
  const root = mkdtempSync(join(tmpdir(), 'prism-installer-'));
  const bytes = Buffer.alloc(256 * 1024, 'synthetic installer');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  let requests = 0, corrupt = false;
  const names = ['Prism-0.0.7-beta-mac-arm64.dmg', 'Prism-Setup-0.0.7-beta-win-x64.exe'];
  const server = createServer((req, res) => {
    if (req.url === '/feed') return res.end(JSON.stringify([{ tag_name: 'v0.0.7-beta', prerelease: true, assets: names.map(name => ({ name, size: bytes.length, digest, state: 'uploaded' })) }]));
    requests++; res.writeHead(200, { 'content-length': bytes.length });
    const body = corrupt ? Buffer.alloc(bytes.length, 'x') : bytes;
    res.write(body.subarray(0, 8192)); setTimeout(() => res.end(body.subarray(8192)), 20);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(root, { recursive: true, force: true }); });
  const feed = { localFeedUrl: `${base}/feed`, localFeedAssetBase: `${base}/files/` };
  const releases = await listReleases(feed);
  assert.equal(releases[0].assets[0].digest, digest);
  for (const [platform, arch, name] of [['darwin', 'arm64', names[0]], ['win32', 'x64', names[1]]]) {
    const updater = new PrismUpdater({ userDataDir: join(root, platform), hostIdentity: { platform, arch, channel: 'beta', hostVersion: '0.0.6-beta', businessVersion: '0.0.6-beta' }, feed });
    t.after(() => updater.dispose());
    updater.fetchManifestPair = async () => { throw new FeedError('FEED_NOT_FOUND'); };
    assert.equal((await updater.checkNow()).fullUpdate.name, name);
    const phases = []; updater.on('state', value => { if (value.installerDownload) phases.push(value.installerDownload.phase); });
    const status = await updater.downloadInstaller();
    assert.equal(status.phase, 'installer-available'); assert.equal(status.installerDownload.phase, 'ready');
    assert.ok(phases.includes('downloading')); assert.ok(phases.includes('verifying'));
    const file = await updater.installer.verifiedPath(); assert.deepEqual(readFileSync(file), bytes);
    const before = requests; await updater.downloadInstaller(); assert.equal(requests, before, '重复点击复用已校验文件');
    writeFileSync(file, Buffer.alloc(bytes.length, 'z'));
    assert.equal(updater.installer.readyPath(), file, '定位不读取或验证整包内容');
    await assert.rejects(updater.installer.verifiedPath(), /INSTALLER_DIGEST_MISMATCH/);
    corrupt = true;
    assert.equal((await updater.downloadInstaller()).installerDownload.phase, 'error');
    assert.equal(readdirSync(join(root, platform, 'updates/installers')).length, 0, '失败下载与损坏旧文件均清理');
    corrupt = false;
    assert.equal((await updater.downloadInstaller()).installerDownload.phase, 'ready', '失败可重试');
    const target = updater.fullUpdate;
    await assert.rejects(updater.installer.download({ ...target, name: '../../escape.exe' }), /INSTALLER_METADATA_INVALID/);
    await assert.rejects(updater.installer.download({ ...target, size: 5 * 1024 ** 3 }), /INSTALLER_METADATA_INVALID/);
    await assert.rejects(updater.installer.download({ ...target, digest: null }), /INSTALLER_METADATA_INVALID/);
    await assert.rejects(updater.installer.download({ ...target, downloadUrl: 'https://evil.invalid/setup.exe' }), /FEED_REDIRECT_DENIED/);
  }
  const unused = new InstallerDownload(join(root, 'unused'), downloadGuardFor(feed));
  await assert.rejects(unused.verifiedPath(), /INSTALLER_NOT_READY/);
});

test('完整安装包 IPC：仅本窗口主 frame，拒绝相似来源和任意路径参数', async () => {
  const main = join(__dirname, '..', 'main.cjs'), actual = createRequire(main), handlers = new Map(), calls = [];
  const context = vm.createContext({ require: name => name === 'electron' ? {
    app: { setName() {}, requestSingleInstanceLock: () => false, quit() {} },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    shell: { openPath: async file => { calls.push(['open', file]); return ''; }, showItemInFolder: file => calls.push(['reveal', file]) },
  } : actual(name), process: { env: {}, platform: 'darwin', versions: { electron: 'test' }, on: () => {} }, setTimeout, clearTimeout });
  vm.runInContext(readFileSync(main, 'utf8'), context);
  vm.runInContext(`origin='http://127.0.0.1:45678'; window={isDestroyed:()=>false,webContents:{mainFrame:{url:origin+'/'}}};
    updater={downloadInstaller:async()=>({downloaded:true}),installer:{verifiedPath:async()=>{throw new Error('VERIFY_FOR_OPEN');},readyPath:()=>'/owned/Prism-0.0.7-beta-mac-arm64.dmg'}};registerUpdateIpc();`, context);
  const event = vm.runInContext('({sender:window.webContents,senderFrame:window.webContents.mainFrame})', context);
  assert.equal((await handlers.get('updates:download-installer')(event)).downloaded, true);
  await assert.rejects(handlers.get('updates:open-installer')(event, '/arbitrary/evil.exe'), /VERIFY_FOR_OPEN/);
  assert.equal(calls.length, 0, '打开安装包必须经过完整校验');
  vm.runInContext(`updater.installer.verifiedPath=async()=>'/owned/Prism-0.0.7-beta-mac-arm64.dmg';`, context);
  await handlers.get('updates:open-installer')(event, false);
  assert.deepEqual(calls.pop(), ['open', '/owned/Prism-0.0.7-beta-mac-arm64.dmg']);
  await handlers.get('updates:open-installer')(event, true); assert.equal(calls.pop()[0], 'reveal');
  for (const invalid of [{ ...event, sender: {} }, { ...event, senderFrame: { url: 'http://127.0.0.1:45678/child' } }]) {
    await assert.rejects(handlers.get('updates:download-installer')(invalid), /UNTRUSTED_SENDER/);
    await assert.rejects(handlers.get('updates:open-installer')(invalid, true), /UNTRUSTED_SENDER/);
  }
  event.senderFrame.url='http://127.0.0.1:456780/';
  await assert.rejects(handlers.get('updates:download-installer')(event), /UNTRUSTED_SENDER/);
});

test('完整应用更新 IPC：安装异步失败后解除任务屏障并可下载完整安装包', async () => {
  const main = join(__dirname, '..', 'main.cjs'), actual = createRequire(main), handlers = new Map(), shellCalls = [];
  const { EventEmitter } = require('node:events');
  const app = Object.assign(new EventEmitter(), { setName() {}, requestSingleInstanceLock: () => false, quit() {} });
  const shellUpdater = Object.assign(new EventEmitter(), {
    state: { phase: 'downloaded', version: '9.9.9-beta' },
    quitAndInstall: () => { shellCalls.push('install'); return true; },
    markInstallFailed() {},
  });
  const backendRequests = [];
  const backend = new EventEmitter();
  backend.connected = true;
  backend.send = message => {
    backendRequests.push(message);
    setImmediate(() => {
      if (message.type === 'update:prepare') backend.emit('message', { type: 'update:prepare-result', applyId: message.applyId, snapshot: { idle: true } });
      else if (message.type === 'update:snapshot') backend.emit('message', { type: 'update:snapshot-result', applyId: message.applyId, ok: true });
      else if (message.type === 'update:abort') backend.emit('message', { type: 'update:abort-result', applyId: message.applyId, closed: false });
    });
  };
  const context = vm.createContext({ require: name => name === 'electron' ? {
    app,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    shell: { openPath: async() => '', showItemInFolder() {} },
  } : actual(name), process: { env: {}, platform: 'darwin', versions: { electron: 'test' }, on: () => {} }, setTimeout, clearTimeout, fakeBackend: backend, fakeShellUpdater: shellUpdater });
  vm.runInContext(readFileSync(main, 'utf8'), context);
  vm.runInContext(`origin='http://127.0.0.1:45678';
    backend=fakeBackend;
    window={isDestroyed:()=>false,webContents:{send(){},mainFrame:{url:origin+'/'}}};
    updater={getStatus:()=>({phase:'idle'}),store:{snapshotsDir:'/tmp/prism-test-snapshots'},downloadInstaller:async()=>({phase:'ready'})};
    shellUpdater=fakeShellUpdater;
    registerUpdateIpc();`, context);
  const event = vm.runInContext('({sender:window.webContents,senderFrame:window.webContents.mainFrame})', context);

  const started = await handlers.get('updates:apply-shell')(event);
  assert.equal(started.started, true);
  for (let i = 0; i < 50 && shellCalls.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(shellCalls.length, 1, '空闲门禁通过后触发静默安装');
  await assert.rejects(handlers.get('updates:download-installer')(event), /UPDATE_ALREADY_APPLYING/);

  shellUpdater.state = { ...shellUpdater.state, phase: 'error', error: 'SHELL_INSTALL_FAILED:代码签名无效' };
  shellUpdater.emit('state', shellUpdater.state);
  await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  assert.deepEqual(backendRequests.map(request => request.type), ['update:prepare', 'update:snapshot', 'update:abort']);
  assert.equal(backendRequests[2].applyId, backendRequests[0].applyId);
  assert.equal(await vm.runInContext('applyFlow', context), null);
  assert.equal(shellUpdater.listenerCount('state'), 0);
  assert.equal(app.listenerCount('before-quit'), 0);
  assert.equal((await handlers.get('updates:download-installer')(event)).phase, 'ready');
  assert.equal((await handlers.get('updates:apply-shell')(event)).started, false, '错误状态不可重复触发静默安装');
  assert.equal(backendRequests.length, 3);
});


test('残留安装包清理：≤当前版本删除、中断与孤儿删除、待装新版本保留且同版本留最新', t => {
  const root = mkdtempSync(join(tmpdir(), 'installer-prune-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dl = new InstallerDownload(join(root, 'installers'), downloadGuardFor({ githubRepo: 'x/y' }));
  const mk = (name, files, mtime) => {
    const dir = join(dl.root, name); mkdirSync(dir, { recursive: true });
    for (const file of files) writeFileSync(join(dir, file), 'x');
    if (mtime) utimesSync(dir, mtime, mtime);
    return dir;
  };
  mk('installer-a', ['Prism-Setup-0.1.0-beta-win-x64.exe']);
  mk('installer-b', ['Prism-0.1.1-beta-mac-arm64.dmg']);
  mk('installer-c', ['Prism-Setup-0.1.2-beta-win-x64.exe.part']);
  mk('installer-d', ['notes.txt']);
  mk('installer-e', ['Prism-0.1.4-beta-mac-arm64.dmg'], new Date(Date.now() - 60_000));
  const keep = mk('installer-f', ['Prism-0.1.4-beta-mac-arm64.dmg']);
  const removed = dl.pruneInstalled('0.1.3-beta');
  assert.deepEqual(removed.sort(), ['installer-a', 'installer-b', 'installer-c', 'installer-d', 'installer-e']);
  assert.equal(readdirSync(dl.root).join(','), 'installer-f');
  assert.ok(existsSync(keep), '待装新版本目录保留');
  assert.throws(() => dl.pruneInstalled('not-a-version'), /VERSION_UNPARSEABLE/, '当前版本不可解析直接抛出（调用方兜底跳过）');
  assert.deepEqual(dl.pruneInstalled('0.1.4-beta').sort(), ['installer-f'], '升级到该版本后下次启动清掉');
  assert.deepEqual(dl.pruneInstalled('0.1.4-beta'), [], '目录已空再清为无操作');
});

// 更新器端到端回归（模块级，不经Electron）：真实构建脚本→本地feed→发现→验签→下载→解包→逐文件校验→应用前复核；
// 另覆盖：篡改清单拒绝、依赖变化拒绝打包、损坏包摘要拒绝、工作区篡改复核拒绝。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const { join } = require('node:path');

const { generateKeyPair, publicKeyId } = require('./keys.cjs');
const { PrismUpdater } = require('./updater.cjs');
const { computeWorkspaceCompat } = require('./compat.cjs');
const { createHostBaseline } = require('../../scripts/release/host-gate.cjs');

const ROOT = join(__dirname, '..', '..');

function makeFakeWorkspace(dir, { backendThrows = false } = {}) {
  mkdirSync(join(dir, 'dist/src/storage/migrations'), { recursive: true });
  mkdirSync(join(dir, 'dist/contracts'), { recursive: true });
  mkdirSync(join(dir, 'web-dist'), { recursive: true });
  mkdirSync(join(dir, 'resources'), { recursive: true });
  mkdirSync(join(dir, 'desktop/updates'), { recursive: true });
  for (const name of ['main.cjs', 'preload.cjs', 'policy.cjs']) writeFileSync(join(dir, 'desktop', name), '// synthetic host\n');
  mkdirSync(join(dir, 'node_modules/fastify'), { recursive: true }); // hoisted 布局顶层实体目录（compat 指纹来源）
  mkdirSync(join(dir, 'node_modules/@earendil-works/pi-coding-agent'), { recursive: true });
  writeFileSync(join(dir, 'dist/src/app.js'), 'export const marker = "v1";\n');
  writeFileSync(join(dir, 'dist/src/storage/migrations/023_ui.sql'), 'SELECT 1;\n');
  writeFileSync(join(dir, 'dist/contracts/v1.js'), 'export {};\n');
  writeFileSync(join(dir, 'web-dist/index.html'), '<!doctype html><title>prism</title>\n');
  writeFileSync(join(dir, 'resources/note.txt'), 'resource\n');
  writeFileSync(join(dir, 'desktop/backend.mjs'), backendThrows ? 'throw new Error("boom");\n' : 'import { buildWorkbench } from "../dist/src/workbench.js";\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'prism-agent', version: '0.0.6-beta' }) + '\n');
}

async function startFeed(rootDir) {
  return new Promise(resolveFeed => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', 'release', 'demo-feed.mjs'), '--dir', rootDir, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\/feed\.json/);
      if (match) resolveFeed({ child, baseUrl: `http://127.0.0.1:${match[1]}`, assetBase: `http://127.0.0.1:${match[1]}/files/` });
    });
  });
}

async function publishToFeed(feedRoot, tag, packDir, notes = '演示版本') {
  const target = join(feedRoot, tag);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const manifestName = `manifest-darwin-arm64.json`; // 与客户端探测名一致
  for (const name of [manifestName, `${manifestName}.sig`]) cpSync(join(packDir, name), join(target, name));
  const packName = readFileSync(join(packDir, manifestName), 'utf8').match(/"file":\s*"([^"]+)"/)?.[1];
  cpSync(join(packDir, packName), join(target, packName));
  writeFileSync(join(target, 'notes.md'), notes + '\n');
}

test('更新器端到端：构建→发现→下载→校验→应用前复核', async () => {
  const root = mkdtempSync(join(os.tmpdir(), 'prism-upd-e2e-'));
  const workspace = join(root, 'workspace');
  const hostInfoDir = join(root, 'host');
  const outDir = join(root, 'out');
  const feedRoot = join(root, 'feed');
  mkdirSync(hostInfoDir, { recursive: true });
  try {
    makeFakeWorkspace(workspace);
    cpSync(join(workspace, 'desktop'), hostInfoDir, { recursive: true });
    const compat = computeWorkspaceCompat({ workspaceDir: workspace, nodeMajor: 24 });
    const hostBuildInfo = { sourceSha: '1'.repeat(40), version: '0.0.5-beta', runtimeCompatibilityId: compat.runtimeCompatibilityId, productionDependenciesHash: compat.productionDependenciesHash, databaseSchemaVersion: compat.databaseSchemaVersion };
    writeFileSync(join(hostInfoDir, 'build-info.json'), JSON.stringify(hostBuildInfo));
    const baseline = join(root, 'baseline.json');
    writeFileSync(baseline, JSON.stringify(createHostBaseline(join(hostInfoDir, 'build-info.json'))));
    const { publicKeyPem, privateKeyPem } = generateKeyPair();
    const keyId = publicKeyId(publicKeyPem); // 约定：keyId = 公钥指纹
    const keyFile = join(root, 'updates-private.pem');
    writeFileSync(keyFile, privateKeyPem);

    execFileSync(process.execPath, [join(ROOT, 'scripts', 'release', 'build-update-pack.mjs'),
      '--workspace', workspace, '--business-version', '0.0.6-beta', '--update-sequence', '2',
      '--release-id', 'r-0.0.6-2', '--source-sha', '1'.repeat(40), '--platform', 'darwin', '--arch', 'arm64', '--node-major', '24',
      '--host-baseline', baseline, '--host-build-info', join(hostInfoDir, 'build-info.json'), '--key', keyFile, '--key-id', keyId, '--out', outDir], { stdio: 'pipe' });
    assert.ok(existsSync(join(outDir, 'manifest-darwin-arm64.json')));
    assert.ok(existsSync(join(outDir, 'manifest-darwin-arm64.json.sig')));

    mkdirSync(feedRoot, { recursive: true }); // feed根目录须先于feed服务就绪
    await publishToFeed(feedRoot, 'v0.0.6-beta', outDir, '业务版本B：界面标记更新'); // feed启动时扫描目录，发布须先行
    const feed = await startFeed(feedRoot);
    try {
      const userData = join(root, 'userdata');
      const updater = new PrismUpdater({
        userDataDir: userData,
        hostIdentity: { platform: 'darwin', arch: 'arm64', channel: 'beta', hostVersion: '0.0.5-beta', businessVersion: '0.0.5-beta', runtimeCompatibilityId: compat.runtimeCompatibilityId, updatesPublicKey: publicKeyPem, updatesKeyId: keyId },
        feed: { localFeedUrl: `${feed.baseUrl}/feed.json`, localFeedAssetBase: feed.assetBase },
      });
      const afterCheck = await updater.checkNow({ manual: true });
      assert.equal(afterCheck.phase, 'available');
      assert.equal(afterCheck.available.productVersion, '0.0.6-beta');
      assert.equal(afterCheck.available.notes, '业务版本B：界面标记更新\n');
      const afterDownload = await updater.download('r-0.0.6-2');
      assert.equal(afterDownload.phase, 'ready');
      assert.ok(existsSync(join(userData, 'updates/releases/r-0.0.6-2/workspace/dist/src/app.js')));
      const manifest = updater.preApplyCheck('r-0.0.6-2');
      assert.equal(manifest.productVersion, '0.0.6-beta');
      assert.equal(manifest.updateSequence, 2);
      // 应用前复核：篡改工作区任一文件即拒绝（等长篡改命中哈希校验）
      writeFileSync(join(userData, 'updates/releases/r-0.0.6-2/workspace/dist/src/app.js'), 'export const marker = "vx";\n');
      assert.throws(() => updater.preApplyCheck('r-0.0.6-2'), /VERIFY_HASH_MISMATCH/);
      assert.ok(updater.autoTimer, '成功检查后继续安排周期检查');
      updater.dispose();
    } finally {
      feed.child.kill();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('更新器：签名被篡改的清单在发现阶段拒绝', async () => {
  const root = mkdtempSync(join(os.tmpdir(), 'prism-upd-tamper-'));
  const workspace = join(root, 'workspace');
  const hostInfoDir = join(root, 'host');
  const outDir = join(root, 'out');
  const feedRoot = join(root, 'feed');
  mkdirSync(hostInfoDir, { recursive: true });
  try {
    makeFakeWorkspace(workspace);
    cpSync(join(workspace, 'desktop'), hostInfoDir, { recursive: true });
    const compat = computeWorkspaceCompat({ workspaceDir: workspace, nodeMajor: 24 });
    writeFileSync(join(hostInfoDir, 'build-info.json'), JSON.stringify({ version: '0.0.5-beta', ...compat }));
    const baseline = join(root, 'baseline.json');
    writeFileSync(baseline, JSON.stringify(createHostBaseline(join(hostInfoDir, 'build-info.json'))));
    const { publicKeyPem, privateKeyPem } = generateKeyPair();
    const keyId = publicKeyId(publicKeyPem);
    const keyFile = join(root, 'k.pem');
    writeFileSync(keyFile, privateKeyPem);
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'release', 'build-update-pack.mjs'),
      '--workspace', workspace, '--business-version', '0.0.6-beta', '--update-sequence', '2', '--release-id', 'r-0.0.6-2', '--source-sha', '1'.repeat(40),
      '--platform', 'darwin', '--arch', 'arm64', '--node-major', '24',
      '--host-baseline', baseline, '--host-build-info', join(hostInfoDir, 'build-info.json'), '--key', keyFile, '--key-id', keyId, '--out', outDir], { stdio: 'pipe' });
    // 伪造更高版本的发行：清单字节被改，签名沿用旧签 → 验签必须失败
    const target = join(feedRoot, 'v0.0.9-beta');
    mkdirSync(target, { recursive: true });
    const manifestName = `manifest-darwin-arm64.json`;
    for (const name of [manifestName, `${manifestName}.sig`]) cpSync(join(outDir, name), join(target, name));
    const tampered = readFileSync(join(outDir, manifestName), 'utf8').replace('"updateSequence": 2', '"updateSequence": 99');
    writeFileSync(join(target, manifestName), tampered);
    const packName = readFileSync(join(outDir, manifestName), 'utf8').match(/"file":\s*"([^"]+)"/)?.[1];
    cpSync(join(outDir, packName), join(target, packName));
    const feed = await startFeed(feedRoot);
    try {
      const updater = new PrismUpdater({
        userDataDir: join(root, 'userdata'),
        hostIdentity: { platform: 'darwin', arch: 'arm64', channel: 'beta', hostVersion: '0.0.5-beta', businessVersion: '0.0.5-beta', runtimeCompatibilityId: compat.runtimeCompatibilityId, updatesPublicKey: publicKeyPem, updatesKeyId: keyId },
        feed: { localFeedUrl: `${feed.baseUrl}/feed.json`, localFeedAssetBase: feed.assetBase },
      });
      const status = await updater.checkNow({ manual: true });
      assert.equal(status.phase, 'error');
      assert.match(status.lastError.message, /SIGNATURE_INVALID/);
      updater.dispose();
    } finally {
      feed.child.kill();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('资源包构建：依赖图与宿主不一致时拒绝', async () => {
  const root = mkdtempSync(join(os.tmpdir(), 'prism-upd-deps-'));
  try {
    const workspace = join(root, 'workspace');
    makeFakeWorkspace(workspace);
    // 宿主记录的是另一份依赖图
    const otherDeps = 'b'.repeat(64);
    const hostInfo = join(root, 'host', 'build-info.json');
    cpSync(join(workspace, 'desktop'), join(root, 'host'), { recursive: true });
    writeFileSync(hostInfo, JSON.stringify({ version: '0.0.5-beta', runtimeCompatibilityId: `node24.${otherDeps.slice(0, 12)}.m00000000`, productionDependenciesHash: otherDeps, databaseSchemaVersion: 23 }));
    const { privateKeyPem } = generateKeyPair();
    const keyFile = join(root, 'k.pem');
    writeFileSync(keyFile, privateKeyPem);
    let failed = false;
    try {
      execFileSync(process.execPath, [join(ROOT, 'scripts', 'release', 'build-update-pack.mjs'),
        '--workspace', workspace, '--business-version', '0.0.6-beta', '--update-sequence', '2', '--release-id', 'r-x', '--source-sha', '1'.repeat(40),
        '--platform', 'darwin', '--arch', 'arm64', '--node-major', '24',
        '--minimum-host-version', '0.0.5-beta', '--host-build-info', hostInfo, '--key', keyFile, '--out', join(root, 'out')], { stdio: 'pipe' });
    } catch (error) {
      failed = true;
      assert.match(String(error.stderr), /不兼容，拒绝打包/);
    }
    assert.equal(failed, true, '依赖不一致时必须拒绝打包');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('兼容指纹识别同名依赖升级与同名迁移内容变化',()=>{
 const root=mkdtempSync(join(os.tmpdir(),'updater-compat-'));
 try {
  makeFakeWorkspace(root);
  writeFileSync(join(root,'node_modules/fastify/package.json'),JSON.stringify({version:'1.0.0'}));
  const a=computeWorkspaceCompat({workspaceDir:root,nodeMajor:24});
  writeFileSync(join(root,'node_modules/fastify/package.json'),JSON.stringify({version:'2.0.0'}));
  const b=computeWorkspaceCompat({workspaceDir:root,nodeMajor:24});assert.notEqual(a.productionDependenciesHash,b.productionDependenciesHash);
  writeFileSync(join(root,'dist/src/storage/migrations/023_ui.sql'),'SELECT 2;\n');
  const c=computeWorkspaceCompat({workspaceDir:root,nodeMajor:24});assert.notEqual(b.runtimeCompatibilityId,c.runtimeCompatibilityId);
 }finally{rmSync(root,{recursive:true,force:true})}
});

test('仅完整安装包的新发行提示覆盖升级，不误报已是最新版本', async () => {
  const root = mkdtempSync(join(os.tmpdir(), 'prism-full-update-'));
  const updater = new PrismUpdater({ userDataDir: root,
    hostIdentity: { platform: 'darwin', arch: 'arm64', channel: 'beta', hostVersion: '0.0.5-beta', businessVersion: '0.0.5-beta' },
    feed: { githubRepo: 'example/releases' } });
  updater.fetchCandidates = async () => [{ tag: 'v0.0.8-beta', assetNames: ['Prism-0.0.8-beta-mac-arm64.dmg'] }];
  const { FeedError } = require('./feed.cjs');
  updater.fetchManifestPair = async () => { throw new FeedError('FEED_NOT_FOUND'); };
  try {
    let result = await updater.checkNow({ manual: true });
    assert.equal(result.phase, 'installer-available');
    assert.equal(result.fullUpdate.url, 'https://github.com/example/releases/releases/tag/v0.0.8-beta');
    updater.fetchManifestPair = async () => { const error = new Error('不同依赖'); error.code = 'INCOMPATIBLE_RUNTIME'; throw error; };
    result = await updater.checkNow({ manual: true });
    assert.equal(result.phase, 'installer-available');
    assert.equal(result.available, null);
  } finally { updater.dispose(); rmSync(root, { recursive: true, force: true }); }
});

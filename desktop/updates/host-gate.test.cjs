const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } = require('node:fs');
const { join, posix, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { generateKeyPairSync, sign } = require('node:crypto');
const { createServer } = require('node:http');
const { checkHostRange, compareHostFiles, createHostBaseline, checkHostBaseline } = require('../../scripts/release/host-gate.cjs');
const ROOT = join(__dirname, '../..');

// 从不可变发布标签加载全部旧模块，绝不拿本轮 updater 冒充旧宿主。
function oldUpdater(tag = 'v0.0.5-beta') {
  // verify 快照位于仓库 .cache 下但不复制 .git；只读向上寻找原仓库标签。
  let repository = process.env.PRISM_LEGACY_SOURCE_ROOT || ROOT;
  while (!existsSync(join(repository, '.git')) && dirname(repository) !== repository) repository = dirname(repository);
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const source = execFileSync('git', ['-C', repository, 'show', `${tag}:${file}`], { encoding: 'utf8' });
    const module = { exports: {} }; cache.set(file, module);
    const native = createRequire(join(ROOT, file));
    vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename: `${tag}/${file}`, importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })(
      name => name.startsWith('.') ? load(posix.normalize(posix.join(posix.dirname(file), name))) : native(name), module, module.exports);
    return module.exports;
  }
  return load('desktop/updates/updater.cjs').PrismUpdater;
}

test('发布范围不能放宽最低宿主，未知版本和排除构建宿主均拒绝', () => {
  const args = { minimumHostVersion: '0.0.6-beta', hostVersion: '0.0.6-beta', businessVersion: '0.0.6-beta' };
  assert.equal(checkHostRange(args), '>=0.0.6-beta');
  assert.throws(() => checkHostRange({ ...args, shellRange: '>=0.0.5-beta <0.1.0' }), /TOO_BROAD/);
  assert.throws(() => checkHostRange({ ...args, shellRange: '>=0.0.6-beta <0.0.6-beta' }), /EXCLUDED/);
  assert.throws(() => checkHostRange({ ...args, minimumHostVersion: undefined }), /REQUIRED/);
  assert.throws(() => checkHostRange({ ...args, hostVersion: '0.0.5-beta' }), /MUST_MATCH/);
});

test('真实0.1.0更新器：新业务版本默认继承基线，两平台仅下载小包并通过应用前复核', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prism-010-small-update-'));
  const workspace = join(root, 'workspace'), host = join(root, 'host');
  const { computeWorkspaceCompat } = require('./compat.cjs');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const key = join(root, 'test-key.pem');
  writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  try {
    for (const path of ['dist/src/storage/migrations', 'dist/contracts', 'web-dist', 'resources', 'node_modules/synthetic']) mkdirSync(join(workspace, path), { recursive: true });
    cpSync(join(ROOT, 'desktop'), join(workspace, 'desktop'), { recursive: true });
    writeFileSync(join(workspace, 'dist/src/storage/migrations/001_initial.sql'), 'SELECT 1;');
    writeFileSync(join(workspace, 'web-dist/index.html'), '<title>new business</title>');
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ version: '0.1.1-beta' }));
    cpSync(join(workspace, 'desktop'), host, { recursive: true });
    const compat = computeWorkspaceCompat({ workspaceDir: workspace, nodeMajor: 24 });
    writeFileSync(join(host, 'build-info.json'), JSON.stringify({ version: '0.1.0-beta', ...compat, updatesPublicKey: publicKeyPem, updatesKeyId: 'test' }));
    const baseline = join(root, 'baseline.json');
    writeFileSync(baseline, JSON.stringify(createHostBaseline(join(host, 'build-info.json'))));
    const LegacyUpdater = oldUpdater('v0.1.0-beta');
    for (const [platform, arch, installer] of [['darwin', 'arm64', 'Prism-0.1.1-beta-mac-arm64.dmg'], ['win32', 'x64', 'Prism-Setup-0.1.1-beta-win-x64.exe']]) {
      const out = join(root, platform);
      execFileSync(process.execPath, [join(ROOT, 'scripts/release/build-update-pack.mjs'), '--workspace', workspace, '--business-version', '0.1.1-beta', '--update-sequence', '6', '--release-id', 'next-business', '--source-sha', 'a'.repeat(40), '--platform', platform, '--arch', arch, '--host-build-info', join(host, 'build-info.json'), '--host-baseline', baseline, '--key', key, '--key-id', 'test', '--out', out], { stdio: 'pipe' });
      const manifestName = `manifest-${platform}-${arch}.json`;
      const manifest = JSON.parse(readFileSync(join(out, manifestName), 'utf8'));
      assert.equal(manifest.shellVersionRange, '>=0.1.0-beta');
      const names = [manifestName, `${manifestName}.sig`, manifest.package.file, installer];
      const requested = [];
      const server = createServer((req, res) => {
        if (req.url === '/feed') return res.end(JSON.stringify([{ tag_name: 'v0.1.1-beta', prerelease: true, assets: names.map(name => ({ name, state: 'uploaded' })) }]));
        const name = req.url.split('/').at(-1); requested.push(name);
        if (!names.includes(name) || name === installer) { res.statusCode = 404; return res.end(); }
        res.end(readFileSync(join(out, name)));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const updater = new LegacyUpdater({ userDataDir: join(root, `data-${platform}`), hostIdentity: { platform, arch, channel: 'beta', hostVersion: '0.1.0-beta', businessVersion: '0.1.0-beta', ...compat, updatesPublicKey: publicKeyPem, updatesKeyId: 'test' }, feed: { localFeedUrl: `${base}/feed`, localFeedAssetBase: `${base}/files/` } });
      try {
        const status = await updater.checkNow({ manual: true });
        assert.equal(status.phase, 'available');
        assert.equal(status.available.productVersion, '0.1.1-beta');
        assert.ok(status.fullUpdate, '旧宿主仍返回完整包候选，前端需优先展示业务包');
        assert.equal((await updater.download('next-business')).phase, 'ready');
        assert.equal(updater.preApplyCheck('next-business').productVersion, '0.1.1-beta');
        assert.ok(requested.includes(manifest.package.file));
        assert.ok(!requested.includes(installer));
      } finally { updater.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('宿主源码逐文件比较包含新增目录桥和updates，排除backend及生成身份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prism-host-gate-'));
  try {
    const source = join(dir, 'source'), built = join(dir, 'built');
    mkdirSync(join(source, 'updates'), { recursive: true });
    for (const file of ['main.cjs', 'preload.cjs', 'policy.cjs', 'directory-picker.cjs', 'updates/updater.cjs']) writeFileSync(join(source, file), '// original');
    cpSync(source, built, { recursive: true });
    assert.doesNotThrow(() => compareHostFiles(source, built));
    for (const file of ['directory-picker.cjs', 'updates/updater.cjs', 'preload.cjs']) {
      writeFileSync(join(source, file), '// changed');
      assert.throws(() => compareHostFiles(source, built), /HOST_FILES_CHANGED/);
      writeFileSync(join(source, file), '// original');
    }
    writeFileSync(join(source, 'new-bridge.cjs'), '// new');
    assert.throws(() => compareHostFiles(source, built), /new-bridge/);
    rmSync(join(source, 'new-bridge.cjs'));
    writeFileSync(join(source, 'backend.mjs'), '// business');
    writeFileSync(join(source, 'build-info.json'), '{}');
    assert.doesNotThrow(() => compareHostFiles(source, built));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('构建check-only默认沿用已验证基线，产品升版不抬高最低宿主', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prism-check-only-'));
  try {
    for (const path of ['dist/src/storage/migrations', 'dist/contracts', 'web-dist', 'resources', 'desktop/updates', 'node_modules/fake']) mkdirSync(join(dir, path), { recursive: true });
    for (const file of ['desktop/main.cjs', 'desktop/preload.cjs', 'desktop/policy.cjs', 'desktop/backend.mjs']) writeFileSync(join(dir, file), '// synthetic');
    writeFileSync(join(dir, 'dist/src/storage/migrations/001_initial.sql'), 'SELECT 1;');
    writeFileSync(join(dir, 'package.json'), '{"version":"0.0.6-beta"}');
    const { computeWorkspaceCompat } = require('./compat.cjs');
    writeFileSync(join(dir, 'desktop/build-info.json'), JSON.stringify({ version: '0.0.6-beta', ...computeWorkspaceCompat({ workspaceDir: dir, nodeMajor: 24 }) }));
    const baseline = join(dir, 'baseline.json');
    writeFileSync(baseline, JSON.stringify(createHostBaseline(join(dir, 'desktop/build-info.json'))));
    // 新安装包升版，宿主代码和运行时未变，仍应兼容旧宿主。
    writeFileSync(join(dir, 'desktop/build-info.json'), JSON.stringify({ version: '0.0.7-beta', ...computeWorkspaceCompat({ workspaceDir: dir, nodeMajor: 24 }) }));
    const args = [join(ROOT, 'scripts/release/build-update-pack.mjs'), '--workspace', dir, '--business-version', '0.0.7-beta', '--release-id', 'test', '--update-sequence', '6', '--source-sha', 'a'.repeat(40), '--host-build-info', join(dir, 'desktop/build-info.json'), '--host-baseline', baseline, '--check-only'];
    const output = execFileSync(process.execPath, args, { encoding: 'utf8' });
    assert.match(output, /未打包、未读取私钥/);
    assert.match(output, /shell >=0.0.6-beta/);
    assert.throws(() => execFileSync(process.execPath, [...args, '--minimum-host-version', '0.0.7-beta'], { stdio: 'pipe' }), error => String(error.stderr).includes('MUST_MATCH'));
    assert.throws(() => execFileSync(process.execPath, [...args, '--shell-range', '>=0.0.5-beta'], { stdio: 'pipe' }), error => String(error.stderr).includes('SHELL_RANGE_TOO_BROAD'));
    writeFileSync(join(dir, 'desktop/preload.cjs'), '// changed host');
    assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }), error => String(error.stderr).includes('HOST_FILES_CHANGED'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('兼容基线拒绝运行时、依赖、迁移和公钥变化，不能借产品版本绕过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prism-baseline-'));
  try {
    for (const name of ['main.cjs', 'preload.cjs', 'policy.cjs']) writeFileSync(join(dir, name), '// host');
    const compat = { runtimeCompatibilityId: 'node24.synthetic', productionDependenciesHash: 'a'.repeat(64), databaseSchemaVersion: 25 };
    const buildInfo = { version: '0.1.0-beta', ...compat, updatesPublicKey: 'synthetic public key', updatesKeyId: 'test' };
    const file = join(dir, 'build-info.json'); writeFileSync(file, JSON.stringify(buildInfo));
    const baseline = createHostBaseline(file);
    const args = { desktopDir: dir, compat, buildInfo: { ...buildInfo, version: '0.1.1-beta' } };
    assert.equal(checkHostBaseline(baseline, args), '0.1.0-beta');
    assert.throws(() => checkHostBaseline({ ...baseline, electronVersion: '46.0.0' }, args), /ELECTRON_CHANGED/);
    for (const patch of [{ runtimeCompatibilityId: 'node25.changed' }, { productionDependenciesHash: 'b'.repeat(64) }, { databaseSchemaVersion: 26 }]) {
      assert.throws(() => checkHostBaseline(baseline, { ...args, compat: { ...compat, ...patch } }), /INCOMPATIBLE/);
    }
    assert.throws(() => checkHostBaseline(baseline, { ...args, buildInfo: { ...args.buildInfo, updatesPublicKey: 'changed' } }), /TRUST_ROOT_CHANGED/);
    assert.throws(() => checkHostBaseline(baseline, { ...args, buildInfo: { ...args.buildInfo, version: '0.0.9-beta' } }), /BELOW_HOST_BASELINE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('真实v0.0.5 updater：006旧字段门禁→完整安装入口，未知capability反而error', async t => {
  let PrismUpdater;
  try { PrismUpdater = oldUpdater(); } catch (error) {
    if (String(error.stderr).match(/not a git repository|invalid object name|unknown revision|bad object|does not exist/i)) {
      t.skip('缺少 v0.0.5-beta 历史源码；设置 PRISM_LEGACY_SOURCE_ROOT 后重新验证旧宿主协议'); return;
    }
    throw error;
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  for (const [platform, arch, installer] of [['darwin', 'arm64', 'Prism-0.0.6-beta-mac-arm64.dmg'], ['win32', 'x64', 'Prism-Setup-0.0.6-beta-win-x64.exe']]) {
    const dir = mkdtempSync(join(tmpdir(), 'prism-old-host-'));
    const updater = new PrismUpdater({ userDataDir: dir, hostIdentity: { platform, arch, channel: 'beta', hostVersion: '0.0.5-beta', businessVersion: '0.0.5-beta', runtimeCompatibilityId: 'node24.same', updatesPublicKey: publicKey.export({ type: 'spki', format: 'pem' }), updatesKeyId: 'test' }, feed: { githubRepo: 'example/releases' } });
    const manifest = { manifestVersion: 1, releaseId: '006', productVersion: '0.0.6-beta', updateSequence: 6, sourceSha: 'a'.repeat(40), channel: 'beta', platform, arch, runtimeCompatibilityId: 'node24.same', shellVersionRange: '>=0.0.6-beta <0.1.0', productionDependenciesHash: 'a'.repeat(64), databaseSchemaVersion: 24, keyId: 'test', package: { file: 'test.tar.gz', size: 1, sha256: 'a'.repeat(64) }, files: ['package.json', 'desktop/backend.mjs'].map(path => ({ path, size: 1, sha256: 'a'.repeat(64) })) };
    function pair() { const manifestBytes = Buffer.from(JSON.stringify(manifest)); return { manifestBytes, signatureBytes: Buffer.from(sign(null, manifestBytes, privateKey).toString('base64')) }; }
    updater.fetchCandidates = async () => [{ tag: 'v0.0.6-beta', assetNames: [installer, 'test.tar.gz', `manifest-${platform}-${arch}.json`, `manifest-${platform}-${arch}.json.sig`] }];
    updater.fetchManifestPair = async () => pair();
    try {
      const status = await updater.checkNow({ manual: true });
      assert.equal(status.phase, 'installer-available'); assert.equal(status.available, null);
      assert.equal(status.fullUpdate.url, 'https://github.com/example/releases/releases/tag/v0.0.6-beta');
      assert.equal(updater.store.readState().activeReleaseId, null);
      await assert.rejects(updater.download('006'), /DOWNLOAD_TARGET_UNKNOWN/);
      await assert.rejects(updater.download('v0.0.6-beta'), /SHELL_RANGE_REJECTED/);
      // 同版本新宿主可接受同一份清单；旧宿主即使业务版本已经变高也不得绕过。
      updater.host.hostVersion = '0.0.6-beta'; assert.equal(updater.verifyManifestBytes(pair()).productVersion, '0.0.6-beta');
      updater.host.hostVersion = '0.0.5-beta'; updater.host.businessVersion = '0.0.6-beta';
      assert.throws(() => updater.verifyManifestBytes(pair()), /SHELL_RANGE_REJECTED/);
      manifest.minimumHostVersion = '0.0.6-beta';
      assert.throws(() => updater.verifyManifestBytes(pair()), /MANIFEST_UNKNOWN_FIELD/);
      delete manifest.minimumHostVersion;
      updater.fetchCandidates = async () => [{ tag: 'v0.0.6-beta', assetNames: [] }];
      assert.equal((await updater.checkNow()).phase, 'up-to-date'); // 旧协议限制：缺安装附件不会引导。
    } finally { updater.dispose(); rmSync(dir, { recursive: true, force: true }); }
  }
});

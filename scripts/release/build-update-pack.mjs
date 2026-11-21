// 业务资源包构建：从已构建的工作区（dist/web-dist 齐备）产出签名更新包。
// 允许项限定 dist/src、dist/contracts、web-dist、resources、desktop/backend.mjs 与 package.json；
// 不含桌面主进程、更新器、可信公钥、Node、依赖、源码历史或运行数据。
// 依赖图/Node ABI/迁移集合任一与宿主不一致即拒绝（要求完整应用升级）。
// 用法示例见 scripts/release/README 段（docs）。
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createTarGz, DEFAULT_CAPS } = require('../../desktop/updates/tar.cjs');
const { validateManifest, parseVersion } = require('../../desktop/updates/manifest.cjs');
const { computeWorkspaceCompat } = require('../../desktop/updates/compat.cjs');
const { signBytes } = require('../../desktop/updates/keys.cjs');
const { checkHostRange, compareHostFiles, validateHostBaseline, checkHostBaseline } = require('./host-gate.cjs');

function argOf(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const workspace = resolve(argOf('--workspace', process.cwd()));
const out = resolve(argOf('--out', join(workspace, 'releases', 'update-pack')));
const businessVersion = argOf('--business-version');
const updateSequence = Number(argOf('--update-sequence'));
const releaseId = argOf('--release-id');
const channel = argOf('--channel', 'beta');
const platform = argOf('--platform', process.platform);
const arch = argOf('--arch', process.arch);
const nodeMajor = Number(argOf('--node-major', '24'));
const hostBuildInfoPath = argOf('--host-build-info');
const baselinePath = resolve(argOf('--host-baseline', fileURLToPath(new URL('./host-baseline.json', import.meta.url))));
const keyFile = argOf('--key');
const keyId = argOf('--key-id', 'prism-updates-beta');
const shellRange = argOf('--shell-range');
const sourceShaArg = argOf('--source-sha', process.env.PRISM_SOURCE_SHA);

for (const [label, value] of [['--business-version', businessVersion], ['--release-id', releaseId]]) {
  if (!value) { console.error(`缺少 ${label}`); process.exit(2); }
}
if (!parseVersion(businessVersion)) { console.error(`业务版本不合法：${businessVersion}`); process.exit(2); }
if (!Number.isInteger(updateSequence) || updateSequence < 1) { console.error('--update-sequence 须为正整数'); process.exit(2); }
const checkOnly = process.argv.includes('--check-only');
if (!checkOnly && (!keyFile || !existsSync(keyFile))) { console.error('缺少 --key <Ed25519 私钥PEM路径>'); process.exit(2); }

// 1) 源码SHA：优先参数/环境；否则取工作区 git HEAD
let sourceSha = sourceShaArg ?? null;
if (sourceShaArg !== undefined && !/^[0-9a-f]{40}$/.test(sourceShaArg)) { console.error('--source-sha / PRISM_SOURCE_SHA 须为40位提交SHA'); process.exit(2); }
if (!sourceSha) {
  try { sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(); } catch { sourceSha = null; }
}
if (!sourceSha || !/^[0-9a-f]{40}$/.test(sourceSha)) { console.error('无法确定 40 位 sourceSha（传 --source-sha 或在工作区运行 git）'); process.exit(2); }

// 2) 允许项收集与校验
const allowedRoots = ['dist/src', 'dist/contracts', 'web-dist', 'resources'];
for (const item of [...allowedRoots, 'desktop/backend.mjs', 'package.json']) {
  if (!existsSync(join(workspace, item))) { console.error(`工作区缺少允许项：${item}（先完成完整构建）`); process.exit(2); }
}
const entries = [];
const files = [];
let totalBytes = 0;
const walk = dir => {
  for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, item.name);
    const rel = relative(workspace, full).replaceAll('\\', '/');
    if (item.isDirectory()) {
      entries.push({ path: rel, type: 'dir' });
      walk(full);
    } else if (item.isFile()) {
      if (item.name === 'node_modules') continue;
      const data = readFileSync(full);
      const size = data.length;
      if (size > DEFAULT_CAPS.maxFileBytes) { console.error(`单文件超限：${rel}`); process.exit(2); }
      totalBytes += size;
      if (totalBytes > DEFAULT_CAPS.maxTotalBytes) { console.error('资源包总量超过256MiB上限，拒绝打包'); process.exit(2); }
      entries.push({ path: rel, type: 'file', data });
      files.push({ path: rel, size, sha256: createHash('sha256').update(data).digest('hex') });
      if (files.length > DEFAULT_CAPS.maxFiles) { console.error('文件数超过上限'); process.exit(2); }
    } else {
      console.error(`不允许的条目类型（链接等）：${rel}`); process.exit(2);
    }
  }
};
for (const root of allowedRoots) { entries.push({ path: root, type: 'dir' }); walk(join(workspace, root)); }
entries.push({ path: 'desktop', type: 'dir' });
{
  const data = readFileSync(join(workspace, 'desktop', 'backend.mjs'));
  entries.push({ path: 'desktop/backend.mjs', type: 'file', data });
  files.push({ path: 'desktop/backend.mjs', size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}
{
  const data = readFileSync(join(workspace, 'package.json'));
  entries.push({ path: 'package.json', type: 'file', data });
  files.push({ path: 'package.json', size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}
files.sort((a, b) => a.path.localeCompare(b.path));

// 3) 兼容条件：与宿主 build-info 逐一核对（T01.4：任一变化即拒绝）
// 注意：依赖指纹取 node_modules 顶层实体目录全集，--workspace 必须是「pnpm install --prod + hoisted」
// 安装后的工作区（与打包引导版 build-desktop.mjs 的 staging 同法），隔离布局的开发仓会得到不同集合。
if (!hostBuildInfoPath || !existsSync(hostBuildInfoPath)) { console.error('缺少 --host-build-info <引导版应用 desktop/build-info.json>'); process.exit(2); }
const hostBuildInfo = JSON.parse(readFileSync(hostBuildInfoPath, 'utf8'));
if (!hostBuildInfo.runtimeCompatibilityId) { console.error('宿主 build-info 缺少 runtimeCompatibilityId（须为带更新能力的引导版）'); process.exit(2); }
// 生产 staging 不含宿主源码；必须另指向同轮通过验证的源码快照。
const hostSourceWorkspace = argOf('--host-source-workspace', workspace);
let finalShellRange;
try {
  compareHostFiles(join(hostSourceWorkspace, 'desktop'), join(hostBuildInfoPath, '..'));
} catch (error) { console.error(error.message); process.exit(2); }
const compat = computeWorkspaceCompat({ workspaceDir: workspace, nodeMajor });
const mismatch = compat.runtimeCompatibilityId !== hostBuildInfo.runtimeCompatibilityId
  || (hostBuildInfo.productionDependenciesHash && compat.productionDependenciesHash !== hostBuildInfo.productionDependenciesHash)
  || (hostBuildInfo.databaseSchemaVersion && compat.databaseSchemaVersion !== hostBuildInfo.databaseSchemaVersion);
if (mismatch) {
  console.error(`资源包与宿主不兼容，拒绝打包（须发布完整应用升级）：\n包 ${compat.runtimeCompatibilityId}\n宿主 ${hostBuildInfo.runtimeCompatibilityId}`);
  process.exit(2);
}
try {
  const baseline = validateHostBaseline(JSON.parse(readFileSync(baselinePath, 'utf8')));
  const hostVersion = checkHostBaseline(baseline, { desktopDir: join(hostSourceWorkspace, 'desktop'), compat, buildInfo: hostBuildInfo });
  const minimumHostVersion = argOf('--minimum-host-version', hostVersion);
  finalShellRange = checkHostRange({ minimumHostVersion, hostVersion, shellRange, businessVersion });
} catch (error) { console.error(error.message); process.exit(2); }
if (checkOnly) {
  console.log(`兼容预检通过（未打包、未读取私钥）：${compat.runtimeCompatibilityId}；shell ${finalShellRange}`);
  process.exit(0);
}

// 4) 打包与清单签名
const packName = `prism-update-${businessVersion}-${platform}-${arch}.tar.gz`;
const packBuffer = createTarGz(entries, DEFAULT_CAPS);
const manifest = {
  manifestVersion: 1,
  releaseId,
  productVersion: businessVersion,
  updateSequence,
  sourceSha,
  channel,
  platform,
  arch,
  runtimeCompatibilityId: compat.runtimeCompatibilityId,
  shellVersionRange: finalShellRange,
  productionDependenciesHash: compat.productionDependenciesHash,
  databaseSchemaVersion: compat.databaseSchemaVersion,
  keyId,
  package: { file: packName, size: packBuffer.length, sha256: createHash('sha256').update(packBuffer).digest('hex') },
  files,
};
try { validateManifest(manifest, DEFAULT_CAPS); } catch (error) { console.error(`清单自校验失败：${error.message}`); process.exit(2); }
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'); // 签名覆盖写盘的原始字节
const signature = Buffer.from(signBytes(readFileSync(keyFile, 'utf8'), manifestBytes), 'utf8');

mkdirSync(out, { recursive: true });
// 发行附件命名：清单按平台/架构命名（客户端按此探测），包名随版本与平台
const manifestName = `manifest-${platform}-${arch}.json`;
writeFileSync(join(out, packName), packBuffer, { mode: 0o644 });
writeFileSync(join(out, manifestName), manifestBytes, { mode: 0o644 });
writeFileSync(join(out, `${manifestName}.sig`), signature, { mode: 0o644 });
console.log(`资源包已生成：${out}`);
console.log(`  包：${packName}（${(packBuffer.length / 1024 / 1024).toFixed(1)} MiB，sha256 ${manifest.package.sha256.slice(0, 16)}…）`);
console.log(`  清单：${manifestName} + ${manifestName}.sig（keyId ${keyId}）`);
console.log(`  兼容：${compat.runtimeCompatibilityId}；shell ${finalShellRange}；迁移 v${compat.databaseSchemaVersion}`);
console.log(`  sourceSha：${sourceSha}`);

// 从隔离验证快照生成自包含桌面安装包，不读取正式数据，也不从旧 Git HEAD 打包。
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { createRequire } from 'node:module';
import { build, Platform, Arch } from 'electron-builder';
const root = fileURLToPath(new URL('../../', import.meta.url));
const targets = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const outputIndex = process.argv.indexOf('--out');
const out = outputIndex >= 0 ? resolve(process.argv[outputIndex + 1]) : join(root, 'releases');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const stage = outputIndex >= 0 ? join(out, '.stage', `desktop-${pkg.version}`) : join(root, '.cache', 'packaging', `desktop-${pkg.version}`);
const workspaceIndex = process.argv.indexOf('--workspace');
let workspace;
if (workspaceIndex >= 0) workspace = resolve(process.argv[workspaceIndex + 1]);
else {
  const output = execFileSync('pnpm', ['run', 'verify'], { cwd: root, encoding: 'utf8', env: { ...process.env, PRISM_KEEP_VERIFICATION_WORKSPACE: '1' } });
  process.stdout.write(output);
  const run = output.match(/隔离验证记录：([^\n]+)/)?.[1];
  if (!run) throw new Error('未找到隔离验证回执');
  workspace = join(root, run.trim(), 'workspace');
}
const receipt = JSON.parse(readFileSync(join(workspace, '..', 'receipt.json'), 'utf8'));
if (!receipt.success) throw new Error('禁止打包未通过验证的快照');
const snapshotPkg = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'));
if (snapshotPkg.version !== pkg.version) throw new Error('验证版本与当前版本不一致');
// 回读验证输入，防止在完成验证后修改快照而未重新验收。
for (const [file, hash] of Object.entries(receipt.sourceSha256)) {
  if (createHash('sha256').update(readFileSync(join(workspace, file))).digest('hex') !== hash) throw new Error(`验证后输入发生变化：${file}`);
}
rmSync(stage, { recursive: true, force: true });
const appDir = join(stage, 'app');
const runtimeWorkspace = join(stage, 'workspace');
mkdirSync(appDir, { recursive: true }); mkdirSync(runtimeWorkspace, { recursive: true }); mkdirSync(out, { recursive: true });
// 桌面发行物保留界面参考来源及其许可；依赖包许可随生产依赖一并复制。
const licenses = join(stage, 'licenses');
mkdirSync(licenses);
copyFileSync(join(root, 'NOTICE.md'), join(licenses, 'NOTICE.md'));
for (const source of ['web/vendor/zcode', 'web/vendor/dsh', 'web/vendor/claude-cage', 'web/public/material-icons']) {
  const destination = join(licenses, source); mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(join(workspace, source)).filter(name => /^(LICENSE|NOTICE|provenance)/i.test(name))) {
    if (name === 'provenance.json') {
      const provenance = JSON.parse(readFileSync(join(workspace, source, name), 'utf8'));
      for (const [key, value] of Object.entries(provenance)) {
        if (typeof value === 'string' && value.startsWith('/Users/')) provenance[key] = 'Local reference archive (not distributed)';
      }
      writeFileSync(join(destination, name), JSON.stringify(provenance, null, 2) + '\n');
    } else copyFileSync(join(workspace, source, name), join(destination, name));
  }
}
const sourceSha = receipt.gitHead;
mkdirSync(join(appDir, 'node_modules'));
writeFileSync(join(appDir, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': { name: pkg.name, version: pkg.version } } }));
cpSync(join(workspace, 'desktop'), join(appDir, 'desktop'), { recursive: true, filter: path => !path.endsWith('.test.cjs') && !path.endsWith('backend.mjs') });
// —— 更新能力身份：运行时兼容标识在依赖安装后计算；可信公钥经显式参数植入（T01） ——
const requireWorkspace = createRequire(join(workspace, 'desktop', 'updates', 'updater.cjs'));
const { computeWorkspaceCompat } = requireWorkspace('./compat.cjs');
const updatesPublicKeyPath = process.argv[process.argv.indexOf('--updates-public-key') + 1] && process.argv.includes('--updates-public-key')
  ? resolve(process.argv[process.argv.indexOf('--updates-public-key') + 1]) : null;
const noPublicKey = process.argv.includes('--no-updates-publickey');
let updatesPublicKey = null;
let updatesKeyId = null;
if (updatesPublicKeyPath) {
  const pem = readFileSync(updatesPublicKeyPath, 'utf8');
  createPublicKey(pem); // 非法PEM直接失败
  updatesPublicKey = pem;
  const keyMetaPath = join(updatesPublicKeyPath, '..', 'updates-key.json');
  updatesKeyId = existsSync(keyMetaPath) ? JSON.parse(readFileSync(keyMetaPath, 'utf8')).keyId ?? null : 'prism-updates-beta';
} else if (!noPublicKey) {
  throw new Error('缺少 --updates-public-key <pem路径>（植入可信更新公钥）；隔离测试构建可显式传 --no-updates-publickey，此时应用内更新不可用');
}
const buildInfo = { sourceSha, version: pkg.version, businessVersion: pkg.version, hostVersion: pkg.version };
writeFileSync(join(appDir, 'desktop', 'build-info.json'), JSON.stringify(buildInfo) + '\n');
writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.main, description: pkg.description, author: pkg.author, packageManager: 'npm@11.11.0' }, null, 2));
for (const item of ['dist/src', 'dist/contracts', 'web-dist', 'resources']) cpSync(join(workspace, item), join(runtimeWorkspace, item), { recursive: true });
mkdirSync(join(runtimeWorkspace, 'desktop')); cpSync(join(workspace, 'desktop', 'backend.mjs'), join(runtimeWorkspace, 'desktop', 'backend.mjs'));
for (const item of ['package.json', 'pnpm-lock.yaml']) cpSync(join(workspace, item), join(runtimeWorkspace, item));
writeFileSync(join(runtimeWorkspace, 'pnpm-workspace.yaml'), readFileSync(join(workspace, 'pnpm-workspace.yaml'), 'utf8') + '\nnodeLinker: hoisted\nsupportedArchitectures:\n  os: [darwin, win32]\n  cpu: [arm64, x64]\n');
execFileSync('pnpm', ['install', '--prod', '--frozen-lockfile', '--ignore-scripts'], { cwd: runtimeWorkspace, stdio: 'inherit' });
// 依赖安装完成后计算运行时兼容标识，并连同可信公钥写入最终 build-info（引导版的更新身份源）
const compat = computeWorkspaceCompat({ workspaceDir: runtimeWorkspace, nodeMajor: 24 });
writeFileSync(join(appDir, 'desktop', 'build-info.json'), JSON.stringify({
  ...buildInfo,
  runtimeCompatibilityId: compat.runtimeCompatibilityId,
  productionDependenciesHash: compat.productionDependenciesHash,
  databaseSchemaVersion: compat.databaseSchemaVersion,
  updatesPublicKey,
  updatesKeyId,
}) + '\n');
const runtime = join(stage, 'runtime'); mkdirSync(runtime);
const nodeVersion = '24.21.0';
const nodeCache = join(root, '.cache', 'packaging', `node-v${nodeVersion}`);
mkdirSync(nodeCache, { recursive: true });
const sums = execFileSync('curl', ['-fsSL', '--retry', '3', `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`], { encoding: 'utf8' });
function download(name) {
  const target = join(nodeCache, name.replaceAll('/', '-'));
  const expected = sums.split('\n').map(line => line.trim().split(/\s+/)).find(([, file]) => file === name)?.[0];
  if (!expected) throw new Error(`官方校验清单缺少 ${name}`);
  const matches = () => existsSync(target) && createHash('sha256').update(readFileSync(target)).digest('hex') === expected;
  if (!matches()) execFileSync('curl', ['-fsSL', '--retry', '3', `https://nodejs.org/dist/v${nodeVersion}/${name}`, '-o', target], { stdio: 'inherit' });
  if (!matches()) throw new Error(`Node 校验失败：${name}`);
  return target;
}
const macTar = download(`node-v${nodeVersion}-darwin-arm64.tar.gz`);
execFileSync('tar', ['-xzf', macTar, '-C', nodeCache]);
copyFileSync(join(nodeCache, `node-v${nodeVersion}-darwin-arm64/LICENSE`), join(licenses, 'Node-LICENSE.txt'));
copyFileSync(join(nodeCache, `node-v${nodeVersion}-darwin-arm64/bin/node`), join(runtime, 'node'));
copyFileSync(download('win-x64/node.exe'), join(runtime, 'node.exe'));
cpSync(join(nodeCache, `node-v${nodeVersion}-darwin-arm64/lib/node_modules/npm`), join(runtime, 'node_modules', 'npm'), { recursive: true, verbatimSymlinks: true });
for (const name of ['npm', 'npx']) {
  const cli = name === 'npm' ? 'npm-cli.js' : 'npx-cli.js';
  writeFileSync(join(runtime, name), '#!/bin/sh\nPRISM_RUNTIME=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$PRISM_RUNTIME/node" "$PRISM_RUNTIME/node_modules/npm/bin/' + cli + '" "$@"\n', { mode: 0o755 });
  writeFileSync(join(runtime, `${name}.cmd`), '@echo off\r\n"%~dp0node.exe" "%~dp0node_modules\\npm\\bin\\' + cli + '" %*\r\n');
}
execFileSync(join(runtime, 'node'), [join(runtime, 'node_modules/npm/bin/npm-cli.js'), '--version'], { stdio: 'inherit' });
const icon = join(root, 'resources', 'desktop', 'icon.png');
const config = {
  appId: 'com.ssovereign.prism', productName: 'Prism', electronVersion: pkg.devDependencies.electron,
  directories: { app: appDir, output: out, buildResources: join(root, 'resources', 'desktop') },
  asar: true, npmRebuild: false,
  // publish 配置只为生成 app-update.yml 与 latest*.yml（electron-updater 静默更新元数据）；
  // 发行目标为公开一体仓（源码+Release，2026-11-23 自 prism-agent-releases 迁入）；
  // 打包禁用自动上传，发行统一经 scripts/release/publish-release.mjs 核对。
  publish: { provider: 'github', owner: 'Sssovereign', repo: 'prism-agent-open' },
  toolsets: { nsis: '1.2.1', winCodeSign: '1.1.0' },
  // desktop/*.cjs 整体进包并排除 *.test.cjs：逐个白名单漏过 context-menu.cjs，导致 0.1.1-beta 启动即炸。
  files: ['desktop/*.cjs', '!desktop/*.test.cjs', 'desktop/build-info.json', 'desktop/updates/**', 'package.json'],
  extraResources: [{ from: runtimeWorkspace, to: 'workspace' }, { from: licenses, to: 'licenses' }],
  // extraResources 默认跳过 node_modules；显式复制完整生产依赖目录；hoisted 布局不依赖跨平台符号链接。
  afterPack: async context => {
    const resources = context.electronPlatformName === 'darwin'
      ? join(context.appOutDir, 'Prism.app', 'Contents', 'Resources') : join(context.appOutDir, 'resources');
    cpSync(join(runtime, 'node_modules'), join(resources, 'runtime', 'node_modules'), { recursive: true, verbatimSymlinks: true });
    cpSync(join(runtimeWorkspace, 'node_modules'), join(resources, 'workspace', 'node_modules'), { recursive: true, verbatimSymlinks: true });
  },
  mac: { target: ['dmg', 'zip'], category: 'public.app-category.developer-tools', icon, identity: '-', hardenedRuntime: false,
    extraResources: ['node', 'node_modules', 'npm', 'npx'].map(file => ({ from: join(runtime, file), to: `runtime/${file}` })),
    artifactName: 'Prism-${version}-mac-${arch}.${ext}' },
  dmg: { title: '棱镜 Prism ${version}', sign: false, contents: [{ x: 150, y: 170 }, { x: 450, y: 170, type: 'link', path: '/Applications' }] },
  win: { target: ['nsis'], icon, signExecutable: false,
    extraResources: ['node.exe', 'node_modules', 'npm.cmd', 'npx.cmd'].map(file => ({ from: join(runtime, file), to: `runtime/${file}` })),
    artifactName: 'Prism-Setup-${version}-win-${arch}.${ext}' },
  // assisted 安装向导（对齐 ZCode/主流 Windows 安装器）：语言选择页 + 可选安装目录。
  // 更新静默路径不受影响：electron-updater quitAndInstall(true,true) 以 /S 调起 NSIS
  // （assisted 包同样支持 /S），沿注册表 InstallLocation 覆盖原目录并自动重启；
  // 0.0.4–0.1.0-beta 即 assisted 向导与静默更新并存。此配置由
  // desktop/installer-config.test.cjs 与下方发行门禁双重钉死，防止再次被静默移除。
  nsis: { oneClick: false, perMachine: false, allowElevation: true, allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: '棱镜 Prism', deleteAppDataOnUninstall: false,
    installerLanguages: ['zh_CN', 'en_US'], language: '2052', runAfterFinish: true },
};
// 发行门禁（前置）：Windows 安装器必须保持 assisted 向导。99d4e0c 曾在 R81 把
// oneClick:false 静默改成 true，0.1.1-beta 起用户失去自定义安装目录——此断言让
// 回归在打包当场报错并指回钉死测试。
for (const [key, expected] of Object.entries({ oneClick: false, perMachine: false, allowElevation: true, allowToChangeInstallationDirectory: true })) {
  if (config.nsis[key] !== expected) throw new Error(`nsis.${key} 必须为 ${expected}——assisted 安装向导已钉死（见 desktop/installer-config.test.cjs）`);
}
const buildTargets = new Map();
const requested = targets.filter(t => t === 'mac' || t === 'win');
if (!requested.length || requested.includes('mac')) buildTargets.set(Platform.MAC, new Map([[Arch.arm64, ['dmg', 'zip']]]));
if (!requested.length || requested.includes('win')) buildTargets.set(Platform.WINDOWS, new Map([[Arch.x64, ['nsis']]]));
const artifacts = await build({ projectDir: appDir, targets: buildTargets, config, publish: 'never' });
// —— 发行门禁：打包产物完整性。0.1.1-beta 曾因 files 白名单缺 context-menu.cjs 而全平台启动
// 即崩，且常规测试不可能发现（测的是源码树不是包）。两道闸：①asar 内 desktop/**/*.cjs 的
// 相对 require 逐一存在（跨平台静态）；②mac 用打包产物真启动冒烟（PRISM_DESKTOP_SMOKE）。 ——
const pnpmRoot = join(root, 'node_modules', '.pnpm');
const asarEntry = readdirSync(pnpmRoot).find(name => name.startsWith('@electron+asar@'));
if (!asarEntry) throw new Error('未找到 @electron/asar（打包门禁依赖）');
const asarPackage = JSON.parse(readFileSync(join(pnpmRoot, asarEntry, 'node_modules', '@electron/asar', 'package.json'), 'utf8'));
const asarModule = join(pnpmRoot, asarEntry, 'node_modules', '@electron/asar', asarPackage.main ?? 'lib/asar.js');
const asar = (await import(pathToFileURL(asarModule).href)).default;
function checkAsarRequires(asarPath) {
  const files = new Set(asar.listPackage(asarPath).map(file => file.replaceAll('\\', '/').replace(/^\//, '')));
  const modules = [...files].filter(file => /^desktop\/.*\.cjs$/.test(file));
  const missing = [];
  for (const name of modules) {
    const source = String(asar.extractFile(asarPath, name));
    for (const match of source.matchAll(/require\((['"])(\.\.?\/[^'"]+)\1\)/g)) {
      const base = join('desktop', name.slice('desktop/'.length), '..', match[2]).replaceAll('\\', '/');
      const candidates = [base, `${base}.cjs`, `${base}.js`, `${base}.json`, `${base}/index.js`, `${base}/index.cjs`];
      if (!candidates.some(candidate => files.has(candidate))) missing.push(`${name} → ${match[2]}`);
    }
  }
  if (missing.length) throw new Error(`asar 缺少被 require 的模块（0.1.1-beta 同类缺陷）：\n${missing.join('\n')}`);
}
const gate = { asarIntegrity: [], smoke: null,
  installer: { windowsNsis: { oneClick: config.nsis.oneClick, allowToChangeInstallationDirectory: config.nsis.allowToChangeInstallationDirectory } } };
for (const [platform, asarPath] of [
  ['mac', join(out, 'mac-arm64', 'Prism.app', 'Contents', 'Resources', 'app.asar')],
  ['win', join(out, 'win-unpacked', 'resources', 'app.asar')],
]) {
  if (!existsSync(asarPath)) continue;
  checkAsarRequires(asarPath);
  gate.asarIntegrity.push({ platform, asar: asarPath, desktopModulesChecked: true });
  console.log(`打包门禁：${platform} asar 相对 require 完整性通过`);
}
const macBinary = join(out, 'mac-arm64', 'Prism.app', 'Contents', 'MacOS', 'Prism');
if (existsSync(macBinary)) {
  const smokeProfile = join(root, '.cache', 'packaging', `smoke-profile-${pkg.version}`);
  const smokeResult = join(out, 'smoke-result.json');
  rmSync(smokeProfile, { recursive: true, force: true }); rmSync(smokeResult, { force: true });
  execFileSync(macBinary, [], { timeout: 180_000, stdio: 'inherit',
    env: { ...process.env, PRISM_DESKTOP_PROFILE: smokeProfile, PRISM_DESKTOP_SMOKE: smokeResult } });
  const smoke = JSON.parse(readFileSync(smokeResult, 'utf8'));
  if (!smoke.hasRoot || !smoke.health?.data || smoke.health.data.businessVersion !== pkg.version) {
    throw new Error(`打包冒烟未通过：${JSON.stringify(smoke).slice(0, 400)}`);
  }
  gate.smoke = { appVersion: smoke.appVersion, businessVersion: smoke.health.data.businessVersion, backendPid: smoke.backendPid, title: smoke.title };
  console.log(`打包门禁：mac 冒烟通过（${smoke.appVersion}，health 正常）`);
}
const files = readdirSync(out).filter(name => name.includes(pkg.version) && /\.(dmg|exe|zip)$/.test(name));
writeFileSync(join(out, 'SHA256SUMS.txt'), files.map(name => `${createHash('sha256').update(readFileSync(join(out, name))).digest('hex')}  ${name}`).join('\n') + '\n');
writeFileSync(join(out, 'build-receipt.json'), JSON.stringify({ version: pkg.version, sourceSha, packagerSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'), verification: resolve(workspace, '..', 'receipt.json'), artifacts, packagingGate: gate, builtAt: new Date().toISOString() }, null, 2) + '\n');
console.log(`安装包：${out}`);

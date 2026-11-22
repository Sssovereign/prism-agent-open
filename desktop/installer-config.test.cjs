// R96 Windows 自定义安装向导固定进打包流程。99d4e0c 曾在 R81 把 assisted 向导
// 静默改成 oneClick 一键安装，0.1.1-beta 起用户失去安装目录选择；本测试把 NSIS
// 配置与静默更新旗标一起钉死——任何改回 oneClick 的改动都会在 verify（打包前置
// 步骤）当场失败。
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const root = join(__dirname, '..');
const packagingSource = readFileSync(join(root, 'scripts/installer/build-desktop.mjs'), 'utf8');
const nsisBlock = (packagingSource.match(/nsis:\s*\{[^}]*\}/) ?? [''])[0];
test('Windows 安装包保持 assisted 向导：可选目录、按用户安装、无需提权', () => {
  assert.match(nsisBlock, /oneClick:\s*false/, 'oneClick 不得改回 true（R81 回归即本测试失败）');
  assert.match(nsisBlock, /allowToChangeInstallationDirectory:\s*true/, '用户必须能自定义安装目录');
  assert.match(nsisBlock, /allowElevation:\s*true/);
  assert.match(nsisBlock, /perMachine:\s*false/, '按用户安装无需提权，保证静默更新不打 UAC');
});
test('安装器行为旗标：完成即运行、卸载保留用户数据、双语向导与快捷方式', () => {
  assert.match(nsisBlock, /runAfterFinish:\s*true/);
  assert.match(nsisBlock, /deleteAppDataOnUninstall:\s*false/);
  assert.match(nsisBlock, /createDesktopShortcut:\s*true/);
  assert.match(nsisBlock, /createStartMenuShortcut:\s*true/);
  assert.match(nsisBlock, /shortcutName:\s*'棱镜 Prism'/);
  assert.match(nsisBlock, /installerLanguages:\s*\['zh_CN',\s*'en_US'\]/);
  assert.match(nsisBlock, /language:\s*'2052'/);
});
test('打包脚本前置断言在位：assisted 旗标被发行门禁二次钉死', () => {
  assert.match(packagingSource, /assisted 安装向导已钉死/, 'build-desktop.mjs 的发行门禁断言不得移除');
});
test('静默更新路径与 assisted 向导兼容：更新器仍以静默+自动运行调起安装器', () => {
  const shellUpdater = readFileSync(join(root, 'desktop/updates/shellUpdater.cjs'), 'utf8');
  assert.match(shellUpdater, /quitAndInstall\(true,\s*true\)/, 'isSilent+isForceRun 必须保持：/S 沿原目录覆盖并自动重启');
});
test('更新检查链路三处 feed 仓一致指向公开一体仓 prism-agent-open', () => {
  // 2026-11-23 迁移：发行/feed 自 prism-agent-releases 迁入 prism-agent-open。
  // 三处=运行时业务更新源（main.cjs）、shell 更新元数据（build-desktop publish）、维护校验工具。
  for (const [file, pattern] of [
    ['desktop/main.cjs', /githubRepo:\s*'Sssovereign\/prism-agent-open'/],
    ['scripts/installer/build-desktop.mjs', /repo:\s*'prism-agent-open'/],
    ['scripts/release/apply-staged-update.cjs', /githubRepo:\s*'Sssovereign\/prism-agent-open'/],
  ]) {
    assert.match(readFileSync(join(root, file), 'utf8'), pattern, `${file} 的 feed 仓必须指向 prism-agent-open`);
  }
  assert.doesNotMatch(readFileSync(join(root, 'desktop/main.cjs'), 'utf8'), /githubRepo:\s*'Sssovereign\/prism-agent-releases'/, '运行时 feed 不得回指旧发行仓');
});

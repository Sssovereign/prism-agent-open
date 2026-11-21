// 在独立源码副本构建和回归，避免覆盖运行实例正在使用的 dist/web-dist。
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
if (!existsSync(join(root, 'node_modules'))) throw new Error('请先安装锁定依赖：pnpm install --frozen-lockfile');
const cache = join(root, '.cache', 'verification');
mkdirSync(cache, { recursive: true });
const run = mkdtempSync(join(cache, 'run-'));
const workspace = join(run, 'workspace');
mkdirSync(workspace);
const receipt = {
  startedAt: new Date().toISOString(),
  gitHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim() || null,
  node: process.version,
  sourceSha256: {},
  steps: [],
  success: false,
};
const inputs = ['desktop', 'src', 'resources', 'web', 'contracts', 'tests', 'scripts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.server.json', 'tsconfig.web.json', 'vite.config.ts'];
function recordFiles(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) recordFiles(file);
    else if (entry.isFile()) receipt.sourceSha256[relative(workspace, file)] = createHash('sha256').update(readFileSync(file)).digest('hex');
  }
}
console.log(`隔离验证记录：${relative(root, run)}`);
try {
  for (const input of inputs) cpSync(join(root, input), join(workspace, input), { recursive: true });
  recordFiles(workspace);
  // 复用已安装的锁定依赖，不复制运行数据、账号或密钥。
  symlinkSync(join(root, 'node_modules'), join(workspace, 'node_modules'), 'junction');
  for (const script of ['build', 'test', 'test:desktop']) {
    const log = join(run, `${script}.log`);
    const fd = openSync(log, 'w');
    console.log(`正在执行 ${script}，日志：${relative(root, log)}`);
    let result;
    try {
      result = spawnSync('pnpm', ['run', script], {
        cwd: workspace, stdio: ['ignore', fd, fd],
        env: { ...process.env, DEBATE_DATA_DIR: join(workspace, '.data') },
      });
    } finally { closeSync(fd); }
    receipt.steps.push({ script, exitCode: result.status, signal: result.signal, error: result.error?.message ?? null });
    if (result.status !== 0) throw new Error(`${script} 未通过，请查看 ${relative(root, log)}`);
  }
  receipt.success = true;
  console.log('隔离构建与全量回归通过。');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  receipt.completedAt = new Date().toISOString();
  writeFileSync(join(run, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  // 成功后只留日志与源码摘要；失败副本保留，便于定位。
  if (receipt.success && process.env.PRISM_KEEP_VERIFICATION_WORKSPACE !== '1') rmSync(workspace, { recursive: true, force: true });
}

// 开源快照同步：从私有仓指定提交导出可构建源码，按 R94 首发同款筛选规则写入开源镜像仓。
// 排除内部文档与状态文件；三份公开文档做机械链接剥离（指向被排除文件的链接保留文字）；
// 私密扫描（个人路径白名单外即失败）。默认 dry-run 打印计划，--apply 才写入 open 仓工作树。
// 用法：node scripts/release/sync-open-source.mjs --ref <git-ref> [--open <open仓路径>] [--apply]
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const argOf = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const flag = name => process.argv.includes(name);
const ref = argOf('--ref') ?? `v${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}`;
const openDir = resolve(argOf('--open') ?? join(root, '.cache', 'open-repo'));
if (!existsSync(join(openDir, '.git'))) { console.error(`open 仓不存在：${openDir}（先 git clone git@github.com:Sssovereign/prism-agent-open.git）`); process.exit(2); }

// —— 1. 导出快照（git archive 只含已提交内容，工作树未提交改动不进入） ——
const commit = execFileSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
if (!commit) { console.error(`ref 不存在：${ref}`); process.exit(2); }
const snap = join(root, '.cache', 'packaging', `open-snap-${commit.slice(0, 12)}`);
rmSync(snap, { recursive: true, force: true }); mkdirSync(snap, { recursive: true });
spawnSync('tar', ['-x', '-C', snap], { input: execFileSync('git', ['-C', root, 'archive', commit], { maxBuffer: 512 * 1024 * 1024 }) });
if (!existsSync(join(snap, 'package.json'))) throw new Error('快照导出失败');

// —— 2. 筛选：docs 只保留三份公开文档；排除内部状态与手记（R94 口径） ——
const KEEP_DOCS = new Set(['architecture.md', 'data-and-access.md', 'research-protocol.md']);
const docsDir = join(snap, 'docs');
for (const name of readdirSync(docsDir)) {
  if (KEEP_DOCS.has(name)) continue;
  rmSync(join(docsDir, name), { recursive: true, force: true });
}
rmSync(join(snap, 'AGENTS.md'), { force: true });
rmSync(join(snap, 'PROJECT_STATE.md'), { force: true });

// —— 3. 链接剥离：保留文档里指向已排除文件的相对链接降级为纯文字 ——
const keptFiles = new Set();
(function walk(dir, prefix = '') {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name), rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(p).isDirectory()) walk(p, rel); else keptFiles.add(rel);
  }
})(snap);
let strippedLinks = 0;
for (const doc of KEEP_DOCS) {
  const file = join(docsDir, doc);
  const text = readFileSync(file, 'utf8').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, target) => {
    if (/^(https?:|mailto:|#)/.test(target)) return whole;
    const path = target.split('#')[0];
    if (!path) return whole;
    const resolved = posix.normalize(posix.join(posix.dirname(doc), path));
    return keptFiles.has(resolved) ? whole : label;
  });
  writeFileSync(file, text);
  strippedLinks += 1;
}

// —— 4. 私密扫描：/Users/ 个人路径与 PEM 私钥块（白名单=防泄漏代码自身的模式字面量，逐条实证） ——
const PATH_WHITELIST = new Set([
  'tests/platform-execution.test.ts',        // 合成测试值 /Users/example
  'web/vendor/dsh/provenance.json',          // R94：历史追溯路径，仅文档性质
  'scripts/installer/build-desktop.mjs',     // provenance 脱敏逻辑的 /Users/ 字面量
  'src/agent/memoryLifecycle.ts',            // 记忆私钥清洗正则
  'scripts/release/sync-open-source.mjs',    // 本脚本自身的匹配模式
]);
const offenders = [];
for (const rel of keptFiles) {
  if (!/\.(ts|cjs|mjs|js|vue|md|json|sql|css|html|yml|yaml|command|sh|ps1)$/.test(rel)) continue;
  if (PATH_WHITELIST.has(rel)) continue;
  const lines = readFileSync(join(snap, rel), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.includes('/Users/')) offenders.push(`个人路径 ${rel}:${i + 1}`);
    if (/PRIVATE KEY-----/.test(line)) offenders.push(`PEM私钥 ${rel}:${i + 1}`);
  });
}
if (offenders.length) { console.error(`私密扫描未通过：\n${offenders.join('\n')}`); process.exit(1); }

// —— 5. 计划与写入：open 自维护文件（README/NOTICE/LICENSE/.gitignore）永不被快照覆盖或删除 ——
const OPEN_MAINTAINED = new Set(['README.md', 'NOTICE.md', 'LICENSE', '.gitignore']);
const openFiles = new Set();
(function walkOpen(dir, prefix = '') {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === '.git') continue;
    const rel = prefix ? `${prefix}/${name.name}` : name.name;
    if (name.isDirectory()) walkOpen(join(dir, name.name), rel); else openFiles.add(rel);
  }
})(openDir);
const updates = [], adds = [], deletes = [];
for (const rel of keptFiles) {
  if (OPEN_MAINTAINED.has(rel)) continue;
  const target = join(openDir, rel);
  if (!existsSync(target)) adds.push(rel);
  else if (readFileSync(target, 'utf8') !== readFileSync(join(snap, rel), 'utf8')) updates.push(rel);
}
for (const rel of openFiles) {
  if (!OPEN_MAINTAINED.has(rel) && !keptFiles.has(rel)) deletes.push(rel);
}
console.log(`快照：${commit.slice(0, 12)}（${ref}）  筛选后 ${keptFiles.size} 文件（docs 剥离链接 ${strippedLinks} 份）`);
for (const [label, list] of [['新增', adds], ['更新', updates], ['删除', deletes]]) {
  for (const rel of list) console.log(`  ${label}：${rel}`);
  if (!list.length) console.log(`  ${label}：无`);
}
if (!flag('--apply')) { console.log('dry-run结束：未写入 open 仓；确认后加 --apply。'); process.exit(0); }
for (const rel of [...adds, ...updates]) {
  mkdirSync(dirname(join(openDir, rel)), { recursive: true });
  cpSync(join(snap, rel), join(openDir, rel));
}
for (const rel of deletes) rmSync(join(openDir, rel), { force: true });
console.log(`已写入 ${openDir}。提交建议（open 仓内）：`);
console.log(`  git add -A && git commit -m "chore: 同步源码快照 ${commit.slice(0, 12)}" && git push`);

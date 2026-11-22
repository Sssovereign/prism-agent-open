// GitHub 发行发布工具：本机构建产物 → 发行仓 draft → 校验远端大小/摘要 → （显式）发布。
// 默认 dry-run 只打印计划；--publish 才把 draft 转正式。已发布版本与标签不可覆盖：tag 已存在即失败。
// 依赖 gh CLI（已认证）。不使用 PAT 内置，不修改源码仓可见性。
// 用法：node scripts/release/publish-release.mjs --repo <owner>/<name> [--tag <tag> --title <标题>] \
//        --notes-file <说明.md> --assets <文件...> [--prerelease] [--publish]
// 标题缺省自 tag 派生为「棱镜 Prism <版本>」；显式传入也必须以「棱镜」开头（品牌兜底）。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { validateManifest, compareVersions } = require('../../desktop/updates/manifest.cjs');
const { checkHostRange, validateHostBaseline } = require('./host-gate.cjs');

function argOf(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const flag = name => process.argv.includes(name);
const repo = argOf('--repo');
const tag = argOf('--tag');
const title = argOf('--title');
// 品牌兜底：公开版本列表曾因手传标题丢掉「棱镜」前缀而断层（0.2.0/0.2.1）。
// 标题缺省自 tag 派生为「棱镜 Prism <版本>」；显式传入必须以「棱镜」开头，否则拒绝发行。
const resolvedTitle = title ?? (tag && /^v?[0-9]/.test(tag) ? `棱镜 Prism ${tag.replace(/^v/, '')}` : undefined);
const notesFile = argOf('--notes-file');
// --assets 后跟随待上传文件列表，至下一个 -- 开头参数为止
const assets = [];
{
  const start = process.argv.indexOf('--assets');
  if (start >= 0) {
    for (let i = start + 1; i < process.argv.length && !process.argv[i].startsWith('--'); i++) {
      const file = process.argv[i];
      if (!existsSync(file)) { console.error(`附件不存在：${file}`); process.exit(2); }
      assets.push(file);
    }
  }
}
const publish = flag('--publish');
const prerelease = !flag('--no-prerelease');
if (!repo || !tag || !resolvedTitle || !notesFile || !assets.length) {
  console.error('用法：publish-release.mjs --repo <owner>/<name> [--tag <tag> --title <以「棱镜」开头的标题>] --notes-file <md> --assets <文件...> [--publish]');
  process.exit(2);
}
if (!/^棱镜/.test(resolvedTitle)) {
  console.error(`发行标题必须以「棱镜」开头（品牌兜底；0.2.0/0.2.1 曾因丢前缀在公开版本列表断层）：${resolvedTitle}`);
  process.exit(2);
}
if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('REPO_INVALID');
if (!/^[A-Za-z0-9][\w.-]*$/.test(tag)) { console.error(`tag 不合法：${tag}`); process.exit(2); }
for (const asset of assets) {
  const name = asset.split('/').pop();
  if (!/^(Prism-[A-Za-z0-9_.-]+\.(dmg|exe|zip)(\.blockmap)?|prism-update-[A-Za-z0-9_.-]+\.tar\.gz|manifest-(darwin|win32)-(arm64|x64)\.json(\.sig)?|(latest|beta)(-mac|-linux)?\.yml|SHA256SUMS\.txt)$/.test(name)) throw new Error(`ASSET_NOT_ALLOWED:${name}`);
  const size = statSync(asset).size;
  if (size >= 2 * 1024 * 1024 * 1024) { console.error(`超过GitHub单文件2GiB上限：${asset}`); process.exit(2); }
}
// 在任何远端操作前核对资源包门禁和完整安装入口；最低宿主是发布操作的显式声明。
const assetByName = new Map(assets.map(file => [file.split('/').pop(), file]));
if (assetByName.size !== assets.length) throw new Error('DUPLICATE_ASSET_NAME');
for (const [name, file] of assetByName) {
  if (!/^manifest-.*\.json$/.test(name)) continue;
  const manifest = validateManifest(JSON.parse(readFileSync(file, 'utf8')));
  if (compareVersions(manifest.productVersion, tag) !== 0) throw new Error('RELEASE_VERSION_MISMATCH');
  const baselinePath = argOf('--host-baseline') ?? fileURLToPath(new URL('./host-baseline.json', import.meta.url));
  const baseline = validateHostBaseline(JSON.parse(readFileSync(baselinePath, 'utf8')));
  const minimumHostVersion = argOf('--minimum-host-version') ?? baseline.hostVersion;
  checkHostRange({ minimumHostVersion, hostVersion: baseline.hostVersion, shellRange: manifest.shellVersionRange, businessVersion: manifest.productVersion });
  if (['runtimeCompatibilityId', 'productionDependenciesHash', 'databaseSchemaVersion'].some(key => manifest[key] !== baseline[key])) throw new Error('HOST_BASELINE_INCOMPATIBLE');
  const installer = manifest.platform === 'darwin' ? `Prism-${manifest.productVersion}-mac-${manifest.arch}.dmg`
    : `Prism-Setup-${manifest.productVersion}-win-${manifest.arch}.exe`;
  for (const required of [installer, `${name}.sig`, manifest.package.file]) {
    if (!assetByName.has(required)) throw new Error(`RELEASE_ASSET_MISSING:${required}`);
  }
  const pack = readFileSync(assetByName.get(manifest.package.file));
  if (pack.length !== manifest.package.size || createHash('sha256').update(pack).digest('hex') !== manifest.package.sha256) throw new Error('PACKAGE_DIGEST_MISMATCH');
}
const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', input });

const local = new Map(assets.map(file => [file, { size: statSync(file).size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }]));
console.log(`发布计划 → ${repo}`);
console.log(`  tag：${tag}（${publish ? '创建后立即发布' : '保持 draft 待确认'}）  prerelease：${prerelease}`);
console.log(`  标题：${resolvedTitle}`);
for (const [file, meta] of local) console.log(`  附件：${file}（${meta.size} 字节，sha256 ${meta.sha256.slice(0, 16)}…）`);
if (flag('--dry-run') || (!publish && !flag('--draft'))) {
  console.log('dry-run结束：未创建远端内容；--draft准备草稿，--publish核对后发布。');
  process.exit(0);
}
// 草稿尚未创建 Git 标签时，/releases/tags/:tag 可能404；从发行列表定位，再用数字ID读取。
function findRelease() {
  const ids = gh(['api', `repos/${repo}/releases?per_page=100`, '--paginate', '--jq',
    `.[] | select(.tag_name == ${JSON.stringify(tag)}) | .id`]).trim().split(/\s+/).filter(Boolean);
  if (ids.length > 1) throw new Error('DUPLICATE_RELEASE_TAG');
  if (!ids.length) return null;
  if (!/^\d+$/.test(ids[0])) throw new Error('RELEASE_ID_INVALID');
  return JSON.parse(gh(['api', `repos/${repo}/releases/${ids[0]}`]));
}
const notes = readFileSync(notesFile, 'utf8');
const existing = findRelease();
if (existing && (!existing.draft || !flag('--resume-draft'))) throw new Error('RELEASE_ALREADY_EXISTS: 已有发行不可覆盖；仅 --resume-draft 可继续未发布草稿');
if (flag('--resume-draft') && !existing) throw new Error('DRAFT_NOT_FOUND');
if (existing && (existing.name !== resolvedTitle || existing.body !== notes || existing.prerelease !== prerelease)) throw new Error('DRAFT_METADATA_MISMATCH');
const allowedNames = new Set(assets.map(file => file.split('/').pop()));
if (allowedNames.size !== assets.length) throw new Error('DUPLICATE_ASSET_NAME');
if (existing?.assets?.some(asset => !allowedNames.has(asset.name))) throw new Error('DRAFT_UNEXPECTED_ASSET');
if (!existing) {
  let tagExists = false;
  try { gh(['api', `repos/${repo}/git/ref/tags/${tag}`]); tagExists = true; } catch (error) { if (!String(error.stderr).includes('404')) throw error; }
  if (tagExists) throw new Error('TAG_ALREADY_EXISTS');
  const createArgs = ['release', 'create', tag, '--repo', repo, '--title', resolvedTitle, '--notes-file', notesFile, '--draft'];
  if (prerelease) createArgs.push('--prerelease');
  gh(createArgs);
}
// 重试只上传尚未存在的附件；已上传附件稍后仍逐项核对，绝不覆盖不同内容。
const uploadedNames = new Set((existing?.assets ?? []).filter(asset => asset.state === 'uploaded').map(asset => asset.name));
for (const file of assets) {
  if (!uploadedNames.has(file.split('/').pop())) gh(['release', 'upload', tag, file, '--repo', repo, '--clobber']);
}
console.log('draft 已就绪，开始远端核对…');
const releaseJson = findRelease();
if (!releaseJson?.draft) throw new Error('RELEASE_NOT_DRAFT');
if (releaseJson.assets?.some(asset => !allowedNames.has(asset.name))) throw new Error('DRAFT_UNEXPECTED_ASSET');
const remote = new Map((releaseJson.assets ?? []).map(asset => [asset.name, asset]));
let verified = 0;
for (const [file, meta] of local) {
  const name = file.split('/').pop();
  const asset = remote.get(name);
  if (!asset || asset.state !== 'uploaded') { console.error(`远端缺附件：${name}`); process.exit(1); }
  if (asset.size !== meta.size) { console.error(`远端大小不一致：${name}（${asset.size}≠${meta.size}）`); process.exit(1); }
  const remoteSha = /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '') ? asset.digest.slice(7) : null;
  const downloaded = remoteSha ? null : execFileSync('gh', ['api', `repos/${repo}/releases/assets/${asset.id}`, '--header', 'Accept: application/octet-stream'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 * 1024 });
  const digest = remoteSha ?? createHash('sha256').update(downloaded).digest('hex');
  if (digest !== meta.sha256) { console.error(`远端摘要不一致：${name}`); process.exit(1); }
  verified += 1;
  console.log(`  已核对：${name}（${asset.size} 字节，摘要一致）`);
}
if (verified !== local.size) { console.error('核对数量不一致'); process.exit(1); }
console.log('远端核对全部通过。');

// 3) 发布（显式）
if (publish) {
  gh(['release', 'edit', tag, '--repo', repo, '--draft=false']);
  console.log(`发行 ${tag} 已发布。`);
} else {
  console.log(`发行 ${tag} 保持 draft；核对无误后可执行 --resume-draft --publish 或在 GitHub 网页发布。`);
}

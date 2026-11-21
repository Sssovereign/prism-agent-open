// 本地演示 feed：仅在明确隔离的验收模式使用（PRISM_UPDATES_ALLOW_LOCAL_FEED=1 + 127.0.0.1）。
// 目录结构：<root>/<tag>/<附件>；<root>/<tag>/notes.md 为发行说明（可选）。
// 服务 /feed.json（GitHub Releases 兼容形状）与 /files/<tag>/<附件>；只绑定 127.0.0.1。
// 用法：node scripts/release/demo-feed.mjs --dir <feedroot> --port <port>
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const dirIndex = process.argv.indexOf('--dir');
const portIndex = process.argv.indexOf('--port');
const root = resolve(process.argv[dirIndex + 1] ?? '');
const port = Number(process.argv[portIndex + 1] ?? 18787);
if (!root || !statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('用法：demo-feed.mjs --dir <feedroot> [--port 18787]');
  process.exit(2);
}
const MIME = { '.json': 'application/json', '.sig': 'application/octet-stream', '.md': 'text/markdown', '.tar.gz': 'application/gzip' };
const tags = readdirSync(root).filter(name => statSync(join(root, name), { throwIfNoEntry: false })?.isDirectory()).sort();
const feed = {
  assetBase: '', // listen 成功后按实际端口回填（供环境变量 PRISM_UPDATES_FEED_ASSET_BASE 使用）
  releases: tags.map(tag => {
    let body = '';
    try { body = readFileSync(join(root, tag, 'notes.md'), 'utf8'); } catch { /* 无说明留空 */ }
    return { assets: readdirSync(join(root, tag)).filter(name => statSync(join(root, tag, name)).isFile()).map(name => ({ name, state: 'uploaded', size: statSync(join(root, tag, name)).size, digest: `sha256:${createHash('sha256').update(readFileSync(join(root, tag, name))).digest('hex')}` })), tag_name: tag, draft: false, prerelease: true, body, published_at: new Date().toISOString() };
  }),
};
createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  const deny = () => { response.writeHead(404).end(); };
  if (url.pathname === '/feed.json') {
    // 与 GitHub Releases 相同的数组形状，客户端 listReleases 本地模式直接复用
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(feed.releases, null, 2));
    return;
  }
  if (!url.pathname.startsWith('/files/')) return deny();
  const parts = url.pathname.slice('/files/'.length).split('/').filter(Boolean);
  if (parts.length !== 2 || parts.some(part => part.includes('..') || part.includes('\\'))) return deny();
  const [tag, asset] = parts;
  const file = join(root, tag, asset);
  if (!existsSync(file) || !statSync(file).isFile()) return deny();
  response.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  response.end(readFileSync(file));
}).listen(port, '127.0.0.1', function listening() {
  const actualPort = this.address().port;
  feed.assetBase = `http://127.0.0.1:${actualPort}/files/`;
  console.log(`演示 feed 已就绪（仅127.0.0.1）：http://127.0.0.1:${actualPort}/feed.json`);
  console.log(`assetBase：${feed.assetBase}`);
  console.log(`发行：${feed.releases.map(release => release.tag_name).join(', ') || '（空）'}`);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkbench } from '../src/workbench.js';

// productVersion 默认取业务工作区 package.json 的版本，从包文件读取而非硬编码（升版本不应改测试）
const pkgVersion = (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version;

test('桌面宿主令牌阻止其他浏览器，合法宿主仍保留Origin和账号校验', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prism-desktop-access-'));
  const previous = process.env.PRISM_DESKTOP_TOKEN;
  process.env.PRISM_DESKTOP_TOKEN = 'synthetic-desktop-token';
  const workbench = await buildWorkbench(dir);
  try {
    const app = workbench.product.app;
    assert.equal((await app.inject({ url: '/api/v1/health', headers: { host: '127.0.0.1:49152' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/v1/health', headers: { host: '127.0.0.1:49152', 'x-prism-desktop-token': 'wrong-token' } })).statusCode, 403);
    const headers = { host: '127.0.0.1:49152', 'x-prism-desktop-token': 'synthetic-desktop-token' };
    const health = await app.inject({ url: '/api/v1/health', headers });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().data.productVersion, pkgVersion);
    assert.equal((await app.inject({ url: '/api/v1/health', headers: { ...headers, origin: 'https://evil.example' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/v1/projects', headers })).statusCode, 401);
  } finally {
    await workbench.close(); rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PRISM_DESKTOP_TOKEN; else process.env.PRISM_DESKTOP_TOKEN = previous;
  }
});

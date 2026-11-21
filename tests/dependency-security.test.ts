import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';

const require = createRequire(import.meta.url);
const sandboxRequire = createRequire(require.resolve('@anthropic-ai/sandbox-runtime'));

test('依赖安全：超长数组／Map／Set在逐元素校验前拒绝，避免错误数量放大', () => {
  const { z } = sandboxRequire('zod/v4');
  let visited = 0;
  const element = () => z.unknown().refine(() => { visited++; return false; });
  const cases = [
    [z.array(element()).max(1), Array.from({ length: 1024 }, () => null)],
    [z.map(element(), z.unknown()).max(1), new Map(Array.from({ length: 1024 }, (_, i) => [i, null]))],
    [z.set(element()).max(1), new Set(Array.from({ length: 1024 }, (_, i) => i))],
  ];
  for (const [schema, input] of cases) {
    visited = 0;
    const result = schema.safeParse(input);
    assert.equal(result.success, false);
    assert.equal(visited, 0, '容器超限后不应继续解析元素');
    assert.equal(result.error.issues.length, 1);
    assert.equal(result.error.issues[0].code, 'too_big');
  }
});

test('依赖兼容：Zod升级后沙箱旧接口保留拒绝外网与文件配置语义', async () => {
  const sandbox = await import(pathToFileURL(require.resolve('@anthropic-ai/sandbox-runtime')).href);
  const config = {
    filesystem: { denyRead: [], allowWrite: ['/'], denyWrite: [] },
    network: { allowedDomains: [], deniedDomains: [], httpProxyPort: 1, socksProxyPort: 1 },
  };
  const parsed = sandbox.SandboxRuntimeConfigSchema.safeParse(config);
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data.network.allowedDomains, []);
  assert.deepEqual(parsed.data.filesystem.allowWrite, ['/']);
  assert.equal(sandbox.SandboxRuntimeConfigSchema.safeParse({ ...config, network: { ...config.network, allowedDomains: [42] } }).success, false);
});

test('依赖兼容：静态服务通配与glob预扫描均保留GET／HEAD／Range及目录边界', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prism-dependency-static-'));
  mkdirSync(join(root, 'public/nested'), { recursive: true });
  writeFileSync(join(root, 'outside.txt'), 'private outside marker');
  writeFileSync(join(root, 'public/nested/probe.txt'), '0123456789');
  try {
    for (const wildcard of [true, false]) {
      const app = Fastify();
      try {
        await app.register(staticFiles, { root: join(root, 'public'), prefix: '/assets/', wildcard });
        const get = await app.inject('/assets/nested/probe.txt');
        assert.equal(get.statusCode, 200); assert.equal(get.body, '0123456789');
        const head = await app.inject({ method: 'HEAD', url: '/assets/nested/probe.txt' });
        assert.equal(head.statusCode, 200); assert.equal(head.headers['content-length'], '10'); assert.equal(head.body, '');
        const range = await app.inject({ url: '/assets/nested/probe.txt', headers: { range: 'bytes=2-5' } });
        assert.equal(range.statusCode, 206); assert.equal(range.body, '2345');
        const traversal = await app.inject('/assets/../outside.txt');
        assert.equal(traversal.statusCode, 404); assert.ok(!traversal.body.includes('private outside marker'));
      } finally { await app.close(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { buildWorkbench } from '../src/workbench.js';

test('统一宿主仅提供产品服务，示例接口已退役，关闭后可重新占用端口', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'prism-host-'));
  const workbench = await buildWorkbench(dataDir, { serveWeb: false });
  try {
    await new Promise<void>(resolve => workbench.server.listen(0, '127.0.0.1', resolve));
    const { port } = workbench.server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/api/v1/health?probe=1`).then(r => r.json()) as { data: { runtime: { pi: string } } };
    assert.ok(health.data.runtime.pi);
    assert.equal((await fetch(`${base}/api/v1/projects`)).status, 401);
    for (const path of ['/api/health', '/api/documents', '/api/runs', '/api/v10/health']) {
      assert.equal((await fetch(`${base}${path}`)).status, 404, path);
    }
    assert.equal((await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objective: 'retired', scenario: 'normal' }),
    })).status, 404);
    assert.equal(existsSync(join(dataDir, 'mock-workbench.sqlite')), false);
    await Promise.all([workbench.close(), workbench.close()]);
    assert.equal(workbench.server.listening, false);
    assert.throws(() => workbench.product.db.db.prepare('SELECT 1'));
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
    await new Promise<void>(resolve => probe.close(() => resolve()));
  } finally {
    await workbench.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('非法端口在打开数据库前拒绝，避免错误启动留下数据', () => {
  const root = mkdtempSync(join(tmpdir(), 'prism-invalid-port-'));
  const dataDir = join(root, 'data');
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url))], {
      env: { ...process.env, DEBATE_PORT: 'invalid', DEBATE_DATA_DIR: dataDir }, encoding: 'utf8', timeout: 10_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /INVALID_PORT/);
    assert.equal(existsSync(dataDir), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

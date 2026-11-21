// 更新检测回归：checkForUpdate 的三条路径（无更新/有更新/非git工作区）用临时仓库覆盖，
// 不触真实GitHub；路由仅验鉴权边界（401），避免单测依赖外网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildProductApp } from '../src/app.js';
import { checkForUpdate, clearUpdateCheckCache } from '../src/updateCheck.js';

// 非交互环境的 PATH 可能缺 /usr/bin（实测 git ENOENT）；补齐保证 execFile('git') 可用
process.env.PATH = [process.env.PATH, '/usr/bin', '/bin', '/usr/local/bin'].filter(Boolean).join(':');

function run(cwd: string, args: string[]): void {
    execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initOriginRepo(root: string, dir: string): void {
    // git init 以父目录为 cwd 传入目标路径：目标目录尚不存在，cwd 指向它会导致 spawn ENOENT
    run(root, ['init', '--initial-branch=main', dir]);
    run(dir, ['config', 'user.email', 'test@prism.invalid']);
    run(dir, ['config', 'user.name', 'Prism Test']);
    run(dir, ['commit', '--allow-empty', '-m', 'init']);
}

test('更新检测：远端无新提交时不提示', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prism-update-'));
    const origin = join(root, 'origin');
    const workspace = join(root, 'workspace');
    try {
        initOriginRepo(root, origin);
        execFileSync('git', ['clone', origin, workspace]);
        clearUpdateCheckCache();
        const result = await checkForUpdate(workspace, { timeoutMs: 0 });
        assert.equal(result.updateAvailable, false);
        assert.equal(result.error, undefined);
        assert.ok(result.currentSha && result.remoteSha);
        assert.equal(result.currentSha, result.remoteSha);
    } finally {
        clearUpdateCheckCache();
        rmSync(root, { recursive: true, force: true });
    }
});

test('更新检测：远端新提交时提示可更新', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prism-update-'));
    const origin = join(root, 'origin');
    const workspace = join(root, 'workspace');
    try {
        initOriginRepo(root, origin);
        execFileSync('git', ['clone', origin, workspace]);
        run(origin, ['commit', '--allow-empty', '-m', 'release 0.0.4-beta']);
        clearUpdateCheckCache();
        const result = await checkForUpdate(workspace, { timeoutMs: 0 });
        assert.equal(result.updateAvailable, true);
        assert.equal(result.error, undefined);
        assert.notEqual(result.currentSha, result.remoteSha);
    } finally {
        clearUpdateCheckCache();
        rmSync(root, { recursive: true, force: true });
    }
});

test('更新检测：非git工作区降级为不可用并带原因', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'prism-update-plain-'));
    try {
        clearUpdateCheckCache();
        const result = await checkForUpdate(plain, { timeoutMs: 0 });
        assert.equal(result.currentSha, null);
        assert.equal(result.updateAvailable, false);
        assert.equal(result.error, 'NOT_A_GIT_WORKSPACE');
    } finally {
        clearUpdateCheckCache();
        rmSync(plain, { recursive: true, force: true });
    }
});

test('更新检测端点：未登录401，不触远端', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-update-route-'));
    const fx = buildProductApp(dir, { serveWeb: false });
    try {
        const anon = await fx.app.inject({ method: 'GET', url: '/api/v1/update-check' });
        assert.equal(anon.statusCode, 401);
    } finally {
        // 不关 app 会留下 gateway listen(0) 句柄，隔离子进程永不退出（全量套件挂死根因）
        await fx.app.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

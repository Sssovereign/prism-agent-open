import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';

// —— F08定向回归：SIGINT/SIGTERM必须真正退出并释放端口（含连接打开时），同数据目录可再次启动 ——

const serverEntry = fileURLToPath(new URL('../src/server.js', import.meta.url));

interface StartedServer { proc: ChildProcess; port: number; stop(sig: 'SIGINT' | 'SIGTERM'): Promise<void> }

function startServer(dataDir: string, port: number): Promise<StartedServer> {
    return new Promise((resolveStart, reject) => {
        const proc = spawn(process.execPath, [serverEntry], {
            env: { ...process.env, DEBATE_DATA_DIR: dataDir, DEBATE_PORT: String(port), NODE_OPTIONS: '' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let err = '';
        proc.stderr?.on('data', (c: Buffer) => { err += c.toString('utf8'); });
        const timer = setTimeout(() => reject(new Error(`启动超时：${err.slice(0, 300)}`)), 15_000);
        const poll = setInterval(() => {
            fetch(`http://127.0.0.1:${port}/api/v1/health`).then(r => {
                if (!r.ok) throw new Error('HEALTH_NOT_READY');
                return r.json();
            }).then(() => {
                clearTimeout(timer);
                clearInterval(poll);
                resolveStart({
                    proc,
                    port,
                    stop: sig => new Promise<void>((resolveStop, rejectStop) => {
                        const exitTimer = setTimeout(() => rejectStop(new Error('进程未退出')), 6_000);
                        proc.once('exit', () => { clearTimeout(exitTimer); resolveStop(); });
                        proc.kill(sig);
                    }),
                });
            }).catch(() => { /* 尚未就绪 */ });
        }, 200);
        proc.once('exit', (code) => { if (code !== undefined && code !== 0 && code !== null) { clearTimeout(timer); clearInterval(poll); reject(new Error(`提前退出 code=${code}：${err.slice(0, 300)}`)); } });
        proc.unref?.();
    });
}

async function portFree(port: number): Promise<boolean> {
    for (let i = 0; i < 20; i++) {
        const busy = await new Promise<boolean>(resolve => {
            const socket = createConnection({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
            socket.on('error', () => resolve(false));
        });
        if (!busy) return true;
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

test('F08：SIGTERM退出释放端口并可用同数据目录重启；SIGINT同样生效；连接打开时也能退出', async t => {
    const dataDir = mkdtempSync(join(tmpdir(), 'f08-data-'));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const port = 4493 + Math.floor(Math.random() * 40);

    const first = await startServer(dataDir, port);
    // 打开一条keep-alive连接（模拟浏览器/SSE在途连接）
    const socket = createConnection({ host: '127.0.0.1', port }, () => { /* 保持打开 */ });
    await new Promise(r => socket.once('connect', r).once('error', r));

    const stopErr = await first.stop('SIGTERM');
    socket.destroy();
    assert.equal(stopErr ?? null, null, `SIGTERM后进程应退出：${String(stopErr)}`);
    assert.equal(await portFree(port), true, '端口应被释放');

    // 同数据目录重启成功（DB句柄已正常关闭）
    const second = await startServer(dataDir, port);
    const health = await fetch(`http://127.0.0.1:${port}/api/v1/health`).then(r => r.json() as Promise<{ data: { runtime: { pi: string } } }>);
    assert.ok(health.data.runtime.pi);
    const stopErr2 = await second.stop('SIGINT');
    assert.equal(stopErr2 ?? null, null, `SIGINT后进程应退出：${String(stopErr2)}`);
    assert.equal(await portFree(port), true, 'SIGINT后端口应被释放');
});

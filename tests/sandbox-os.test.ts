import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { buildRunnerSeatbeltProfile } from '../src/agent/seatbelt.js';
import { realpathSync } from 'node:fs';

// 本机文件可直接访问，网络仍只允许模型网关；仅操作本测试创建的合成文件。

interface ProbeResult { checks: Array<{ name: string; result: string }> }

function probeScript(base: string, probeTarget: { dbFile: string; otherGrantFile: string; sshFile: string; externalNetPort: number; gatewayPort: number }): string {
    return `
const fs = await import('node:fs');
const checks = [];
const attempt = async (name, fn) => { try { checks.push({ name, result: await fn() }); } catch (e) { checks.push({ name, result: 'DENIED:' + (e.code ?? e.cause?.code ?? e.message) }); } };
await attempt('read-db-file', async () => { fs.readFileSync(${JSON.stringify(probeTarget.dbFile)}); return 'READ_OK'; });
await attempt('read-other-grant', async () => { fs.readFileSync(${JSON.stringify(probeTarget.otherGrantFile)}); return 'READ_OK'; });
await attempt('read-ssh', async () => { fs.readFileSync(${JSON.stringify(probeTarget.sshFile)}); return 'READ_OK'; });
await attempt('write-attempt-dir', async () => { fs.writeFileSync(${JSON.stringify(join(base, 'scratch', 'probe-ok.txt'))}, 'x'); return 'OK'; });
await attempt('write-outside', async () => { fs.writeFileSync(${JSON.stringify(probeTarget.otherGrantFile + '.written')}, 'x'); return 'WRITE_OK'; });
await attempt('net-external-service', async () => { const r = await fetch('http://127.0.0.1:${probeTarget.externalNetPort}/'); return 'STATUS-' + r.status; });
await attempt('net-gateway-port', async () => { const r = await fetch('http://127.0.0.1:${probeTarget.gatewayPort}/'); return 'STATUS-' + r.status; });
console.log(JSON.stringify(checks));
`;
}

// 异步执行探针（同步spawn会阻塞本进程事件循环，HTTP探针服务将无法应答造成假死）
function runProbe(profilePath: string, scriptPath: string, attemptBase: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/sandbox-exec', ['-f', profilePath, process.execPath, scriptPath], {
            env: { PATH: '/usr/bin:/bin', HOME: join(attemptBase, 'home'), TMPDIR: join(attemptBase, 'tmp'), NODE_OPTIONS: '' },
        });
        let out = '', err = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`探针超时：stderr=${err.slice(0, 300)}`)); }, 30_000);
        child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8'); });
        child.stderr?.on('data', (c: Buffer) => { err += c.toString('utf8'); });
        child.on('error', e => { clearTimeout(timer); reject(e); });
        child.on('exit', code => {
            clearTimeout(timer);
            if (code === 0 && out.trim()) resolve(out);
            else reject(new Error(`探针退出码${code}：stderr=${err.slice(0, 300)}`));
        });
    });
}

test('本机文件策略：项目外与主目录合成文件可读写，原网络限制继续生效', { skip: process.platform !== 'darwin' }, async t => {
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'f03-data-')));
    const grantRoot = realpathSync(mkdtempSync(join(homedir(), '.agent-fs-probe-')));
    const otherGrantRoot = realpathSync(mkdtempSync(join(tmpdir(), 'f03-other-')));
    const attemptBase = join(dataDir, 'runtime', 'att-f03');
    for (const d of ['home', 'scratch', 'tmp', 'session']) mkdirSync(join(attemptBase, d), { recursive: true });

    const dbFile = join(dataDir, 'workbench.sqlite');
    const otherGrantFile = join(otherGrantRoot, 'secret.txt');
    const sshFile = join(grantRoot, 'synthetic-account-file.txt');
    writeFileSync(dbFile, 'db-secret');
    writeFileSync(otherGrantFile, 'other-secret');
    writeFileSync(sshFile, 'ssh-probe');
    t.after(() => {
        rmSync(dataDir, { recursive: true, force: true });
        rmSync(grantRoot, { recursive: true, force: true });
        rmSync(otherGrantRoot, { recursive: true, force: true });
    });

    // 本机网络拒绝验证：外部HTTP服务（非网关端口）应被拒；网关端口应可达（收到HTTP响应）
    const externalServer = createHttpServer((_req,res) => res.end('external-probe'));
    const gatewayServer = createHttpServer((_req, res) => { res.end('gateway-probe'); });
    await new Promise<void>(r => externalServer.listen(0, '127.0.0.1', () => r()));
    await new Promise<void>(r => gatewayServer.listen(0, '127.0.0.1', () => r()));
    const externalNetPort = (externalServer.address() as { port: number }).port;
    const gatewayPort = (gatewayServer.address() as { port: number }).port;
    t.after(() => { externalServer.closeAllConnections(); externalServer.close(); gatewayServer.closeAllConnections(); gatewayServer.close(); });

    writeFileSync(join(grantRoot, 'authorized.txt'), '授权内容');

    const profilePath = join(attemptBase, 'session', 'runner.sb');
    writeFileSync(profilePath, buildRunnerSeatbeltProfile({
        attemptBase, gatewayPort,
    }));

    const scriptPath = join(attemptBase, 'scratch', 'probe.mjs');
    writeFileSync(scriptPath, probeScript(attemptBase, { dbFile, otherGrantFile, sshFile, externalNetPort, gatewayPort }));
    const raw = await runProbe(profilePath, scriptPath, attemptBase);
    const parsed = JSON.parse(raw.trim()) as ProbeResult['checks'];
    const byName = new Map(parsed.map(c => [c.name, c.result]));

    assert.equal(byName.get('read-db-file'), 'READ_OK', `合成数据文件可读取，实际=${byName.get('read-db-file')}`);
    assert.equal(byName.get('read-other-grant'), 'READ_OK', `其他目录的合成文件可读取，实际=${byName.get('read-other-grant')}`);
    assert.equal(byName.get('read-ssh'), 'READ_OK', '主目录中的合成文件可读取');
    assert.equal(byName.get('write-attempt-dir'), 'OK', '本attempt目录可写（工具与日志需要）');
    assert.equal(byName.get('write-outside'), 'WRITE_OK', '项目外合成文件可写入');
    assert.equal(byName.get('net-external-service')?.startsWith('DENIED:'), true, `非网关本机端口必须被OS拒绝，实际=${byName.get('net-external-service')}`);
    assert.equal(byName.get('net-gateway-port')?.startsWith('STATUS-'), true, `网关端口（模型通信唯一出口）必须可达，实际=${byName.get('net-gateway-port')}`);

    // 主目录中的真实项目文件也可由runner直接读取
    const grantProbePath = join(attemptBase, 'scratch', 'probe2.mjs');
    writeFileSync(grantProbePath, `
const fs = await import('node:fs');
try { fs.readFileSync(${JSON.stringify(join(grantRoot, 'authorized.txt'))}); console.log('GRANT-READ-OK'); }
catch (e) { console.log('GRANT-READ-DENIED-' + e.code); }
`);
    const grantRaw = await runProbe(profilePath, grantProbePath, attemptBase);
    assert.equal(grantRaw.trim(), 'GRANT-READ-OK', 'runner可直接读取项目原文件');
});

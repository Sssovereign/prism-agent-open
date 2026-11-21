import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { runnerEnvironment, resolvePlatformShell, shellCommand, shellGuidance } from '../src/agent/platformShell.js';
import { detachedProcessGroup, terminateProcessTree } from '../src/agent/processTree.js';
import { resolveAgentPath } from '../src/agent/toolExec.js';

test('Windows execution environment preserves case-insensitive Path and required system values, not secrets', () => {
    const env = runnerEnvironment({ Path: 'D:\\工具;C:\\Windows\\System32', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe', API_KEY: 'secret', NODE_OPTIONS: '--require evil' }, 'D:\\临时', 'win32', 'C:\\Users\\中文');
    assert.ok(env.PATH?.startsWith('D:\\工具;'));
    assert.equal(env.PATH?.split(';').filter(p => p === 'C:\\Windows\\System32').length, 1);
    assert.equal(env.TEMP, 'D:\\临时'); assert.equal(env.USERPROFILE, 'C:\\Users\\中文');
    assert.equal(env.API_KEY, undefined); assert.equal(env.NODE_OPTIONS, ''); assert.equal(env.Path, undefined);
});

test('Windows resolves pwsh, PowerShell, then ComSpec/cmd without current-directory executable search', () => {
    const env = { Path: 'C:\\工具;.', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
    for (const [filename, kind] of [['pwsh.exe','powershell'], ['powershell.exe','powershell'], ['cmd.exe','cmd']] as const) {
        const shell = resolvePlatformShell(env, 'win32', p => p.endsWith(`\\${filename}`));
        assert.equal(shell.kind, kind); assert.ok(shell.executable.startsWith('C:\\'));
    }
    assert.throws(() => resolvePlatformShell({ Path: '.' }, 'win32', () => true));
});

test('PowerShell encodes multiline Unicode without argv interpolation; cmd explicitly selects UTF8', () => {
    const shell = { executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', kind: 'powershell' as const };
    const command = "Write-Output '中文 & 空格'\nWrite-Output $env:HOME";
    const invocation = shellCommand(shell, command);
    assert.ok(Buffer.from(invocation.args.at(-1)!, 'base64').toString('utf16le').endsWith(command));
    assert.ok(invocation.args.includes('-NoProfile')); assert.match(shellGuidance(shell), /不是Bash/);
    assert.deepEqual(shellCommand({ executable: 'cmd.exe', kind: 'cmd' }, 'echo 中文').args, ['/d', '/s', '/c', 'chcp 65001 >nul & echo 中文']);
});

test('POSIX shell fallback, GUI PATH and home resolution', () => {
    const env = runnerEnvironment({ PATH: '/custom/bin', SHELL: '/missing', LANG: 'C' }, '/tmp/test', 'darwin', '/Users/example');
    assert.ok(env.PATH?.includes('/opt/homebrew/bin')); assert.equal(env.HOME, '/Users/example');
    assert.equal(resolvePlatformShell(env, 'darwin', p => p === '/bin/sh').executable, '/bin/sh');
    assert.equal(resolveAgentPath('/tmp/project', '~'), homedir());
});

test('Windows tree termination uses taskkill /T /F and never a negative pid; errors stay visible', () => {
    let args: string[] = [];
    const deps = { kill: () => { throw new Error('POSIX kill on Windows'); }, taskkill: (_file: string, a: string[]) => { args = a; return { status: 0 } as ReturnType<typeof import('node:child_process').spawnSync>; } };
    assert.equal(terminateProcessTree(123, 'SIGTERM', 'win32', deps), true);
    assert.deepEqual(args, ['/pid', '123', '/T', '/F']); assert.equal(detachedProcessGroup('win32'), false);
    assert.equal(terminateProcessTree(0, 'SIGKILL', 'win32', deps), false);
    assert.equal(terminateProcessTree(123, 'SIGKILL', 'win32', { ...deps, taskkill: () => ({ status: 1 } as ReturnType<typeof import('node:child_process').spawnSync>) }), false);
});

test('real POSIX command tree termination closes inherited output pipes promptly', { skip: process.platform === 'win32' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prism-tree-'));
    const marker = join(dir, 'child.pid');
    const childScript = 'setInterval(()=>{},1000)';
    const parentScript = `const{spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'inherit'});fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', parentScript], { detached: true, stdio: ['ignore','pipe','pipe'] });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
        let pid = 0;
        for (let i = 0; i < 100; i++) { pid = Number(await readFile(marker, 'utf8').catch(() => '0')); if (pid) break; await new Promise(r => setTimeout(r, 20)); }
        assert.ok(pid > 0);
        assert.equal(terminateProcessTree(child.pid!), true);
        await Promise.race([closed, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('descendant pipe remained open')), 3000); timer.unref(); })]);
    } finally { terminateProcessTree(child.pid!); await rm(dir, { recursive: true, force: true }); }
});

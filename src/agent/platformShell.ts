import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export interface PlatformShell { executable: string; kind: 'posix' | 'powershell' | 'cmd' }
export const COMMAND_RESTRICTION = '命令执行不可用：网络沙箱能力检查或初始化失败。仍可使用模型对话和可信工具；不会降级为无沙箱命令。';

/** Only pass execution essentials, never inherit provider credentials or NODE_OPTIONS. */
export function runnerEnvironment(source: NodeJS.ProcessEnv, tmp: string, platform: NodeJS.Platform = process.platform, home = homedir()): NodeJS.ProcessEnv {
    const value = (name: string) => Object.entries(source).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    const env: NodeJS.ProcessEnv = { HOME: home, NODE_OPTIONS: '' };
    const paths = (value('PATH') ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
    if (platform === 'win32') {
        for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'PATHEXT']) {
            const v = value(name); if (v) env[name] = v;
        }
        const root = env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows';
        env.SystemRoot = root;
        paths.push(win32.join(root, 'System32'), root, win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0'));
        env.TEMP = tmp; env.TMP = tmp;
        env.USERPROFILE ??= home;
    } else {
        paths.push(...(platform === 'darwin' ? ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin'] : ['/usr/local/bin']), '/usr/bin', '/bin', '/usr/sbin', '/sbin');
        env.TMPDIR = tmp;
        env.SHELL = source.SHELL;
        env.LANG = /utf-?8/i.test(source.LANG ?? '') ? source.LANG : platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
    }
    const seen = new Set<string>();
    env.PATH = paths.filter(p => { const key = platform === 'win32' ? p.toLowerCase() : p; if (seen.has(key)) return false; seen.add(key); return true; }).join(platform === 'win32' ? ';' : ':');
    return env;
}

export function resolvePlatformShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, executable = (path: string): boolean => {
    try { accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK); return statSync(path).isFile(); } catch { return false; }
}): PlatformShell {
    const windows = platform === 'win32', path = windows ? win32 : posix;
    const get = (name: string) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    const candidates = windows ? ['pwsh.exe', 'powershell.exe', get('ComSpec'), 'cmd.exe'] : [env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'];
    for (const candidate of candidates) {
        if (!candidate) continue;
        const locations = path.isAbsolute(candidate) ? [candidate] : (get('PATH') ?? '').split(windows ? ';' : ':').filter(p => path.isAbsolute(p)).map(p => path.join(p, candidate));
        for (const location of locations) if (executable(location)) {
            const base = path.basename(location).toLowerCase();
            if (windows && !['pwsh.exe', 'powershell.exe', 'cmd.exe'].includes(base)) continue;
            return { executable: location, kind: windows ? base === 'cmd.exe' ? 'cmd' : 'powershell' : 'posix' };
        }
    }
    throw new Error('没有找到可用的命令解释器');
}

export function shellCommand(shell: PlatformShell, command: string): { command: string; args: string[] } {
    if (shell.kind === 'powershell') {
        const script = `$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n${command}`;
        return { command: shell.executable, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
    }
    if (shell.kind === 'cmd') return { command: shell.executable, args: ['/d', '/s', '/c', `chcp 65001 >nul & ${command}`] };
    return { command: shell.executable, args: ['-c', command] };
}

export function shellGuidance(shell: PlatformShell): string {
    if (shell.kind === 'powershell') return `命令工具虽名为bash，解释器为PowerShell（${shell.executable}），不是Bash；使用PowerShell语法，路径用单引号，调用带空格的可执行文件用 &。命令以UTF-16LE传输，输出按UTF-8读取；旧外部程序可能仍输出本地代码页。`;
    if (shell.kind === 'cmd') return `命令工具虽名为bash，解释器为cmd.exe（${shell.executable}），使用cmd语法、%VAR%及双引号路径，不使用Bash/PowerShell语法。请求UTF-8代码页65001；旧程序可能不遵循。`;
    return `命令工具解释器为${shell.executable}，使用该shell的语法；输出按UTF-8读取，不加载交互终端。`;
}

import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';

/** Synchronous because runner exit/dispose cannot await a cleanup child. Never use a shell. */
export function terminateProcessTree(pid: number, signal: NodeJS.Signals = 'SIGKILL', platform: NodeJS.Platform = process.platform, deps: {
    kill: (id: number, sig: NodeJS.Signals) => unknown;
    taskkill: (file: string, args: string[]) => { status: number | null; error?: Error };
} = {
    kill: (id: number, sig: NodeJS.Signals) => process.kill(id, sig),
    taskkill: (file: string, args: string[]) => spawnSync(file, args, { windowsHide: true, stdio: 'ignore', timeout: 5000 }),
}): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    if (platform === 'win32') {
        const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
        // /T includes descendants; /F is intentional even for TERM: Windows does not implement POSIX TERM.
        const result = deps.taskkill(win32.join(root, 'System32', 'taskkill.exe'), ['/pid', String(pid), '/T', '/F']);
        return !result.error && result.status === 0;
    }
    try { deps.kill(-pid, signal); return true; }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
        try { deps.kill(pid, signal); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'ESRCH'; }
    }
}

export const detachedProcessGroup = (platform: NodeJS.Platform = process.platform): boolean => platform !== 'win32';

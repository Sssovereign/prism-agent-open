import { realpathSync } from 'node:fs';

/** 本机Agent使用宿主账户的完整文件权限。此策略仅保留既有网络限制。 */
export interface SeatbeltParams {
    attemptBase: string;
    gatewayPort: number;
}

export function buildRunnerSeatbeltProfile(p: SeatbeltParams): string {
    let attemptBase = p.attemptBase;
    try { attemptBase = realpathSync(attemptBase); } catch { /* 启动错误由调用方报告 */ }
    const base = JSON.stringify(attemptBase);
    return [
        '(version 1)',
        '(deny default)',
        '(allow file*)',
        '(allow process-exec)',
        '(allow process-fork)',
        '(allow process-info*)',
        '(allow sysctl-read)',
        '(allow mach-lookup)',
        '(allow ipc-posix*)',
        '(allow system-socket)',
        `(allow network-outbound (remote tcp "localhost:${p.gatewayPort}"))`,
        `(allow network-bind (local unix-socket (subpath ${base})))`,
        `(allow network-outbound (remote unix-socket (subpath ${base})))`,
    ].join('\n') + '\n';
}

export const SEATBELT_EXEC = '/usr/bin/sandbox-exec';

/** 其他平台不宣称进程级网络隔离；bash仍使用sandbox-runtime的网络策略。 */
export function runnerSandboxSpawnArgs(profilePath: string, nodePath: string, runnerEntry: string, bootstrapPath: string): { command: string; args: string[] } | null {
    if (process.platform !== 'darwin') return null;
    return { command: SEATBELT_EXEC, args: ['-f', profilePath, nodePath, runnerEntry, bootstrapPath] };
}

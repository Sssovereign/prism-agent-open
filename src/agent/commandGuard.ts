/**
 * Windows命令护栏（批准路线变更）：Windows命令改为真实账户执行+审批+危险命令拦截，
 * 不要求srt-win/WFP。分类器参考ZCode guarded matcher模式
 * （ZCode执行边界_2026-11-11 apps/zcode-cli/packages/core/src/tool/handlers/bash.ts:118-145
 * 的matchDangerousCommand→userApprovalRule模式），按PowerShell/cmd双方言保守匹配。
 * 接入：toolExec bash的highImpact→命中→监督器requiresApproval在ask/auto强制询问；
 * full按用户明示选择放行（approvalPolicy既有语义）。POSIX不启用。
 * 保守优先：宁可多问（一次审批），不可漏判；字符串内容导致的过匹配只多一次询问。
 */

import { win32 } from 'node:path';

export interface CommandGuardHit { ruleId: string; message: string }

/** 仅规范命令名，不解析/执行脚本：兼容调用运算符、引号路径及模块限定cmdlet。 */
function normalizeExecutable(statement: string): string {
    const input = statement.trim().replace(/^[(\s&@]+/, '');
    const match = /^("[^"]*"|'[^']*'|[^\s]+)([\s\S]*)$/.exec(input);
    if (!match) return input;
    const executable = match[1]!.replace(/^["']|["']$/g, '').replace(/`/g, '');
    return win32.basename(executable) + match[2];
}

/** 语句切分：PowerShell分号/换行、cmd的&/&&、管道符。字符串内的分隔符会被过切分，仅影响保守方向。 */
function statements(command: string): string[] {
    return command.split(/[;\r\n|]+|&&|&/)
        .map(normalizeExecutable)
        .filter(s => s.length > 0);
}

/**
 * 根路径判定：驱动器根（C:\、\、/、\\、裸C:）、C:\*类盘根通配、
 * Windows/ProgramData/Program Files及其子树、C:\Users本身与C:\Users\*。
 * C:\Users\<用户>\下的项目目录不算根（日常递归清理不误问）。
 */
function isRootTarget(token: string): boolean {
    let t = token.trim().replace(/^-(?:literalpath|path):/i, '').replace(/^["']+|["']+$/g, '');
    if (!t) return false;
    // 使用固定的Windows语义，不读验收宿主的环境，不把字符串交给shell求值。
    const systemVariables: Record<string, string> = {
        windir: 'C:\\Windows', systemroot: 'C:\\Windows', systemdrive: 'C:',
        programdata: 'C:\\ProgramData', programfiles: 'C:\\Program Files',
        'programfiles(x86)': 'C:\\Program Files (x86)', programw6432: 'C:\\Program Files',
    };
    t = t.replace(/\$\{env:([^}]+)\}|\$env:([a-z][a-z0-9_]*)|%([^%]+)%/gi,
        (original, braced: string | undefined, plain: string | undefined, cmd: string | undefined) =>
            systemVariables[(braced ?? plain ?? cmd ?? '').toLowerCase()] ?? original);
    // 递归删除的动态目标无法在此证明安全，保守要求审批（如$root、Join-Path表达式）。
    if (/\$|%[^%]+%/.test(t)) return true;
    if (/^[a-z]:$/i.test(t)) return true; // normalize会把裸盘符变为C:.，须先判定。
    t = win32.normalize(t.replace(/^\\\\[?.]\\/, ''));
    if (/^(?:[a-z]:)?[\\\/]+$/i.test(t)) return true;
    if (/^[a-z]:$/i.test(t)) return true;
    if (/^[a-z]:[\\\/](?:\*|\*(?:\.\*)?|\.\*)$/i.test(t)) return true;
    if (/^[a-z]:[\\\/](?:windows|programdata|program files(?: \(x86\))?)((?:[\\\/].*)|\*)?$/i.test(t)) return true;
    if (/^[a-z]:[\\\/]users(?:[\\\/]\*?)?$/i.test(t)) return true;
    return false;
}

/** 候选路径token：先取引号包裹串（可含空格，如"C:\Program Files"），再取去引号后的裸token。 */
function pathTargets(statement: string): string[] {
    const targets: string[] = [];
    for (const q of statement.match(/"[^"]*"|'[^']*'/g) ?? []) targets.push(q.slice(1, -1));
    targets.push(...statement.replace(/"[^"]*"|'[^']*'/g, ' ').split(/[\s,]+/));
    return targets;
}

interface GuardRule { id: string; message: string; match: (command: string, stmts: string[]) => boolean }

const GUARD_RULES: GuardRule[] = [
    {
        id: 'windows.format_volume',
        message: '格式化磁盘或磁盘分区（format/format-volume/diskpart）',
        match: (_c, stmts) => stmts.some(s =>
            (/^format(?:\.com)?\s/i.test(s) && (pathTargets(s).some(isRootTarget) || /\/(?:fs|q|y|v|vfs|label|au)\b/i.test(s)))
            || /^format-volume\b/i.test(s)
            || /^diskpart(?:\.exe)?\b/i.test(s)),
    },
    {
        id: 'windows.drive_root_recursive_delete',
        message: '盘根或系统目录递归删除（rd/rmdir/del/deltree）',
        match: (_c, stmts) => stmts.some(s => {
            const cmd = (s.split(/\s+/)[0] ?? '').toLowerCase().replace(/\.exe$/, '');
            if (cmd === 'deltree') return true;
            const targets = pathTargets(s);
            if ((cmd === 'rd' || cmd === 'rmdir') && /\/s\b/i.test(s) && targets.some(isRootTarget)) return true;
            if ((cmd === 'del' || cmd === 'erase') && targets.some(isRootTarget)) return true;
            return false;
        }),
    },
    {
        id: 'windows.remove_item_root',
        message: 'Remove-Item系列对根路径/系统目录或无法静态确认的目标递归删除',
        match: (_c, stmts) => stmts.some(s =>
            /^(?:remove-item|ri|rm|rmdir|del|erase|rd)\b/i.test(s)
            && /(?:^|\s)-(?:recurse|rec|r)\b/i.test(s)
            && pathTargets(s).some(isRootTarget)),
    },
    {
        id: 'windows.registry_hklm_write',
        message: 'HKLM注册表写入/删除（reg/regedit/Set-ItemProperty等）',
        match: (_c, stmts) => stmts.some(s =>
            (/\breg(?:\.exe)?\s+(?:add|delete|copy|load|unload|restore|import)\b/i.test(s)
                && (/\b(?:hklm|hkey_local_machine)\b/i.test(s) || /\breg(?:\.exe)?\s+import\b/i.test(s)))
            || (/\b(?:new|set|remove|clear|rename|copy|move)-item(?:property)?\b/i.test(s)
                && /\b(?:hklm|hkey_local_machine)\b/i.test(s))
            || /^regedit(?:\.exe)?\s+\/s\b/i.test(s)),
    },
    {
        id: 'windows.execution_policy',
        message: '放宽PowerShell执行策略（Bypass/Unrestricted）',
        match: (c, stmts) => stmts.some(s => /^set-executionpolicy\b/i.test(s) && /\b(?:bypass|unrestricted)\b/i.test(s))
            || /(?:^|\s)-(?:executionpolicy|ep)\s+(?:bypass|unrestricted)\b/i.test(c),
    },
    {
        id: 'windows.remote_script_exec',
        message: 'IEX/Invoke-Expression执行远程下载脚本（irm/iwr/curl等）',
        match: c => /\b(?:iex|invoke-expression)\b/i.test(c)
            && /\b(?:irm|iwr|invoke-restmethod|invoke-webrequest|downloadstring|downloadfile|webclient|bitstransfer|curl|wget)\b/i.test(c),
    },
    {
        id: 'windows.system_shutdown',
        message: '关机/重启/引导配置/卷影操作（shutdown/bcdedit/vssadmin/Stop-Computer）',
        match: (_c, stmts) => stmts.some(s =>
            /^(?:shutdown|bcdedit|vssadmin)(?:\.exe)?\b/i.test(s)
            || /\b(?:stop|restart)-computer\b/i.test(s)),
    },
    {
        id: 'windows.sched_task_change',
        message: '计划任务创建/删除/修改（schtasks/Register-ScheduledTask）',
        match: (_c, stmts) => stmts.some(s =>
            (/^schtasks(?:\.exe)?\b/i.test(s) && /\/(?:create|delete|change)\b/i.test(s))
            || /\b(?:register|unregister|set)-scheduledtask\b/i.test(s)),
    },
    {
        id: 'windows.account_change',
        message: '本地账户/组改动（net user/net localgroup/New-LocalUser等）',
        match: (_c, stmts) => stmts.some(s => {
            const m = /^net(?:\.exe)?\s+(?:user|localgroup|group)\b/i.exec(s);
            if (m) {
                if (/\/(?:add|delete|active|password\w*|expire\w*|times|fullname|homedir|scriptpath|comment|countrycode)\b/i.test(s)) return true;
                const rest = s.slice(m[0].length).trim().split(/\s+/).filter(Boolean);
                // net user <名> <明文口令>：参数不带/前缀且多于一个token
                return rest.length >= 2 && !rest.slice(1).every(t => t.startsWith('/'));
            }
            return /\b(?:new|remove|set|add|disable|enable)-local(?:user|group|groupmember)\b/i.test(s);
        }),
    },
];

/** 分类命中返回首个规则（id+说明），未命中返回null。纯函数，无IO。 */
export function classifyWindowsDanger(command: string): CommandGuardHit | null {
    if (!command || command.length > 16384) return null;
    const stmts = statements(command);
    if (stmts.length === 0) return null;
    for (const rule of GUARD_RULES) {
        if (rule.match(command, stmts)) return { ruleId: rule.id, message: rule.message };
    }
    return null;
}

/** bash highImpact入口：仅win32启用护栏；POSIX恒false（审批语义不变）。 */
export function windowsCommandGuardHit(args: Record<string, unknown> | undefined, platform: NodeJS.Platform = process.platform): boolean {
    if (platform !== 'win32') return false;
    const command = typeof args?.command === 'string' ? args.command : '';
    return command.length > 0 && classifyWindowsDanger(command) !== null;
}

/** 下发模型的bash工具描述追加段（仅win32）。 */
export const WINDOWS_GUARD_NOTE = 'Windows下命令在本机真实账户直接执行，无进程级沙箱；格式化磁盘/分区、盘根或系统目录递归删除、HKLM注册表写入、Bypass执行策略、IEX执行远程下载脚本、关机/引导/卷影、计划任务与本地账户改动等危险命令会被规则拦截，在ask/auto审批模式强制询问，full模式按用户明示选择放行。';

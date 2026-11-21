import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../contracts/errors.js';

/**
 * 最小 MCP stdio 客户端（JSON-RPC 2.0，按行分帧）。
 * 参照 MCP 规范的 initialize → notifications/initialized → tools/list → tools/call；
 * 不引入 SDK 依赖。进程由可信监督器侧管理（受信任准入后），不在沙箱内。
 */

const INIT_TIMEOUT_MS = 10_000;
const LIST_TIMEOUT_MS = 8_000;

export interface McpToolDef {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    readOnlyHint?: boolean;
}

interface PendingRequest { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

export interface McpConnection {
    serverId: string;
    tools: McpToolDef[];
    listTools(refresh?: boolean): Promise<McpToolDef[]>;
    callTool(toolName: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
    close(reason: string): void;
    alive(): boolean;
    lastError(): string | null;
}

export function validateMcpCommand(command: string, args: string[]): void {
    if (!command.trim()) throw new ApiError('VALIDATION_FAILED', '启动命令不能为空');
    if (command.length > 2000 || args.length > 64) throw new ApiError('VALIDATION_FAILED', '命令或参数过长');
    if (/[\r\n\0]/.test(command) || args.some(a => /[\r\n\0]/.test(a))) throw new ApiError('VALIDATION_FAILED', '命令含非法控制字符');
    // 显式拒绝 shell 包装形式：本客户端不经 shell 解释，直接 execvp；写进命令里的重定向/管道是字面参数。
}

export function connectMcpServer(serverId: string, command: string, args: string[], env: Record<string, string>, onError?: (message: string) => void): McpConnection {
    validateMcpCommand(command, args);
    let child: ChildProcess;
    try {
        child = spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...env },
            shell: false, // 不经shell：参数数组直传，重定向/管道不是特性而是字面量
        });
    }
    catch (error) {
        throw new ApiError('SANDBOX_UNAVAILABLE', `MCP 服务进程启动失败：${error instanceof Error ? error.message.slice(0, 120) : '未知错误'}`);
    }
    let stderrTail = '';
    let exited: string | null = null;
    const pending = new Map<string, PendingRequest>();
    const toolsCache: { at: number; tools: McpToolDef[] } = { at: 0, tools: [] };
    let initialized = false;
    let closing = false;

    child.stdout!.setEncoding('utf8');
    let buffer = '';
    child.stdout!.on('data', (chunk: string) => {
        buffer += chunk;
        if(Buffer.byteLength(buffer)>4*1024*1024){failAll('MCP响应超过4MiB上限');child.kill('SIGTERM');return;}
        let newlineAt: number;
        while ((newlineAt = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newlineAt).trim();
            buffer = buffer.slice(newlineAt + 1);
            if (!line) continue;
            let message: { id?: string | number; result?: unknown; error?: { message?: string }; method?: string };
            try { message = JSON.parse(line); }
            catch { continue; }
            if (message.id === undefined) continue; // 通知/请求忽略（本客户端不处理server→client请求）
            const key = String(message.id);
            const entry = pending.get(key);
            if (!entry) continue;
            pending.delete(key);
            clearTimeout(entry.timer);
            if (message.error) entry.reject(new Error(message.error.message?.slice(0, 200) || 'MCP 请求失败'));
            else entry.resolve(message.result);
        }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-2000);
    });
    child.on('error', error => { exited = error.message.slice(0, 200); failAll(exited); });
    child.on('exit', (code, signal) => {
        exited = signal ? `被信号 ${signal} 终止` : `退出码 ${code ?? 'null'}`;
        failAll(`MCP 服务进程已退出（${exited}）${stderrTail ? `：${stderrTail.slice(-160)}` : ''}`);
    });

    function failAll(message: string) {
        for (const [, entry] of pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error(message));
        }
        pending.clear();
        initialized = false;
        if(!closing)onError?.(message);
    }

    function request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
        if (exited) return Promise.reject(new Error(`MCP 服务进程不可用（${exited}）`));
        const id = randomUUID();
        const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', 'utf8');
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new ApiError('TOOL_TIMEOUT', `MCP 请求超时（${method}）`));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            child.stdin!.write(payload, error => {
                if (error) {
                    pending.delete(id);
                    clearTimeout(timer);
                    reject(new Error(`MCP stdin 写入失败：${error.message.slice(0, 120)}`));
                }
            });
        });
    }

    async function initialize(): Promise<void> {
        if (initialized) return;
        const result = await request('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'prism-workbench', version: '0.2.0' },
        }, INIT_TIMEOUT_MS) as { protocolVersion?: string } | undefined;
        if (!result) throw new Error('MCP initialize 无响应');
        child.stdin!.write(Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n', 'utf8'));
        initialized = true;
    }

    const connection: McpConnection = {
        serverId,
        tools: toolsCache.tools,
        async listTools(refresh = false) {
            if (!refresh && toolsCache.tools.length && Date.now() - toolsCache.at < 60_000) return toolsCache.tools;
            await initialize();
            const result = await request('tools/list', {}, LIST_TIMEOUT_MS) as { tools?: McpToolDef[] } | undefined;
            const tools = Array.isArray(result?.tools) ? result!.tools!.slice(0, 128) : [];
            toolsCache.tools = tools;
            toolsCache.at = Date.now();
            return tools;
        },
        async callTool(toolName, args, timeoutMs) {
            await initialize();
            const result = await request('tools/call', { name: toolName, arguments: args }, timeoutMs) as
                { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
            if (result?.isError) {
                const text = result.content?.map(part => part.text ?? '').join('\n').slice(0, 300) || 'MCP 工具报告错误';
                throw new ApiError('PROVIDER_ERROR', text);
            }
            return result ?? {};
        },
        close(reason) {
            closing=true;
            if (!exited) exited = reason;
            failAll(reason);
            child.kill('SIGTERM');
            setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 3000).unref();
        },
        alive() { return !exited && child.exitCode === null; },
        lastError() { return exited ?? (stderrTail ? stderrTail.slice(-200) : null); },
    };
    return connection;
}

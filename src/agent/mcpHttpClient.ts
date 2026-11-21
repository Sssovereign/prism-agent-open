import { ApiError } from '../../contracts/errors.js';
import { pinnedJsonPost } from './webTools.js';
import type { McpConnection, McpToolDef } from './mcpClient.js';

/**
 * MCP 远程传输客户端（streamable HTTP，R62）：与 stdio 客户端同一 McpConnection 接口。
 * initialize → notifications/initialized → tools/list(分页) → tools/call；
 * 会话头 mcp-session-id 回传复用，失效自动重握手一次。
 * 传输纪律复用 webTools：仅 https、DNS 钉扎、私网拒绝、8MiB 上限；不引入 SDK 依赖。
 */

const PROTOCOL_VERSION = '2025-06-18';
const INIT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_PAGES = 20;
const MAX_TOOLS = 512;

export interface RemoteJsonResponse { status: number; headers: Headers; bytes: Buffer }
export type RemoteJsonRequester = (url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) => Promise<RemoteJsonResponse>;

interface JsonRpcResponse { id?: string | number; result?: unknown; error?: { code?: number; message?: string; data?: unknown } }

function matchingRpcResponse(value: unknown, expectedId: string): value is JsonRpcResponse {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const message = value as Record<string, unknown>;
    if (message.jsonrpc !== '2.0' || !['string', 'number'].includes(typeof message.id) || String(message.id) !== expectedId) return false;
    const result = Object.hasOwn(message, 'result'), error = Object.hasOwn(message, 'error');
    if (result === error) return false;
    if (error && (!message.error || typeof message.error !== 'object' || Array.isArray(message.error)
        || typeof (message.error as Record<string, unknown>).message !== 'string')) return false;
    return true;
}

/** 解析 application/json 或 text/event-stream（取首个匹配 id 的 data 帧；流式响应读满后整体解析）。 */
export function parseRpcPayload(status: number, contentType: string, bytes: Buffer, expectedId: string): JsonRpcResponse {
    if (status < 200 || status >= 300) throw new ApiError('PROVIDER_ERROR', `MCP 服务返回 HTTP ${status}`);
    const text = bytes.toString('utf8');
    if (contentType.includes('text/event-stream')) {
        for (const frame of text.split(/\r?\n\r?\n/)) {
            const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
            if (!data) continue;
            let message: unknown;
            try { message = JSON.parse(data); } catch { continue; }
            if (matchingRpcResponse(message, expectedId)) return message;
        }
        throw new ApiError('PROVIDER_ERROR', 'MCP 流式响应中没有匹配的应答帧');
    }
    let message: unknown;
    try { message = JSON.parse(text); }
    catch { throw new ApiError('PROVIDER_ERROR', 'MCP 响应不是有效 JSON'); }
    if (!matchingRpcResponse(message, expectedId)) throw new ApiError('PROVIDER_ERROR', 'MCP 响应格式或请求ID不匹配');
    return message;
}

function assertResult(message: JsonRpcResponse): unknown {
    if (message.error) throw new Error(message.error.message?.slice(0, 200) || 'MCP 请求失败');
    return message.result;
}

/** 仅允许安全 header 名（token 字符），值不含控制字符——路由层再限数量/长度。 */
function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) throw new ApiError('VALIDATION_FAILED', `Header 名不合法：${name.slice(0, 40)}`);
        if (/[\r\n\0]/.test(value)) throw new ApiError('VALIDATION_FAILED', `Header 值含非法字符：${name.slice(0, 40)}`);
        out[name] = value;
    }
    return out;
}

export function createRemoteMcpConnection(serverId: string, rawUrl: string, headers: Record<string, string>, onError?: (message: string) => void, requester: RemoteJsonRequester = pinnedJsonPost): McpConnection {
    let url: URL;
    try { url = new URL(rawUrl.trim()); } catch { throw new ApiError('VALIDATION_FAILED', '远程 MCP 地址无效'); }
    const safeHeaders = sanitizeHeaders(headers);
    let sessionId: string | null = null;
    let protocolVersion = PROTOCOL_VERSION;
    let initialized = false;
    let closing = false;
    let lastError: string | null = null;
    const toolsCache: { at: number; tools: McpToolDef[] } = { at: 0, tools: [] };

    function noteError(message: string): void {
        lastError = message;
        onError?.(message);
    }

    async function rpc(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
        if (closing) throw new Error('MCP 连接已关闭');
        const id = Math.floor(Math.random() * 2_147_483_647);
        const response = await requester(url.href, {
            ...safeHeaders,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': protocolVersion,
            ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        }, { jsonrpc: '2.0', id, method, params }, timeoutMs);
        const session = response.headers.get('mcp-session-id');
        if (session) sessionId = session;
        const message = parseRpcPayload(response.status, response.headers.get('content-type') ?? '', response.bytes, String(id));
        return assertResult(message);
    }

    async function notify(method: string, params: unknown): Promise<void> {
        if (closing) throw new Error('MCP 连接已关闭');
        const response = await requester(url.href, {
            ...safeHeaders,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': protocolVersion,
            ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        }, { jsonrpc: '2.0', method, params }, INIT_TIMEOUT_MS);
        // 通知无应答体：2xx/202 即成功，错误码视为握手失败
        if (response.status >= 400) throw new ApiError('PROVIDER_ERROR', `MCP 通知被拒绝（HTTP ${response.status}）`);
    }

    async function handshake(): Promise<void> {
        const result = await rpc('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'prism-agent', version: '0.2.1' },
        }, INIT_TIMEOUT_MS) as { protocolVersion?: string } | undefined;
        if (result && typeof result.protocolVersion === 'string' && result.protocolVersion) protocolVersion = result.protocolVersion;
        await notify('notifications/initialized', {});
        initialized = true;
    }

    function resetSession(reason: string): void {
        initialized = false;
        sessionId = null;
        toolsCache.at = 0;
        toolsCache.tools = [];
        lastError = reason;
    }

    const connection: McpConnection = {
        serverId,
        tools: [],
        async listTools(refresh = false): Promise<McpToolDef[]> {
            if (!refresh && toolsCache.tools.length && Date.now() - toolsCache.at < 60_000) return toolsCache.tools;
            if (!initialized) await handshake();
            const out: McpToolDef[] = [];
            let cursor: string | undefined;
            for (let page = 0; page < MAX_PAGES; page++) {
                const result = await rpc('tools/list', cursor === undefined ? {} : { cursor }, 8_000) as { tools?: unknown; nextCursor?: string } | undefined;
                const rows = Array.isArray(result?.tools) ? result!.tools : [];
                for (const row of rows) {
                    const tool = row as { name?: unknown; description?: unknown; inputSchema?: Record<string, unknown>; readOnlyHint?: unknown; annotations?: { readOnlyHint?: boolean } };
                    if (typeof tool.name !== 'string' || !tool.name) continue;
                    out.push({
                        name: tool.name,
                        description: typeof tool.description === 'string' ? tool.description : undefined,
                        inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : undefined,
                        readOnlyHint: tool.readOnlyHint === true || tool.annotations?.readOnlyHint === true,
                    });
                    if (out.length >= MAX_TOOLS) break;
                }
                if (out.length >= MAX_TOOLS || typeof result?.nextCursor !== 'string' || !result.nextCursor) break;
                cursor = result.nextCursor;
            }
            toolsCache.at = Date.now();
            toolsCache.tools = out;
            connection.tools = out;
            lastError = null;
            return out;
        },
        async callTool(toolName: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
            if (!initialized) await handshake();
            try {
                return await rpc('tools/call', { name: toolName, arguments: args }, timeoutMs ?? CALL_TIMEOUT_MS);
            } catch (error) {
                // 会话失效（服务端重启/过期）：重握手一次再试，仍失败才上抛
                const message = error instanceof Error ? error.message : '';
                if (/HTTP 40[04]/.test(message) || /session/i.test(message)) {
                    resetSession('会话失效，重新握手');
                    await handshake();
                    return await rpc('tools/call', { name: toolName, arguments: args }, timeoutMs ?? CALL_TIMEOUT_MS);
                }
                throw error;
            }
        },
        close(reason: string): void {
            if (closing) return;
            closing = true;
            noteError(reason);
        },
        alive(): boolean { return !closing; },
        lastError(): string | null { return lastError; },
    };
    return connection;
}

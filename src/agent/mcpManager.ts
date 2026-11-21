import {createHash} from 'node:crypto';
import type { Db } from '../storage/db.js';
import { ApiError } from '../../contracts/errors.js';
import { connectMcpServer, type McpConnection, type McpToolDef } from './mcpClient.js';
import { createRemoteMcpConnection } from './mcpHttpClient.js';

/**
 * MCP 连接管理（监督器侧，可信进程）：按 (userId, serverId) 复用连接；
 * 空闲 5 分钟回收；仅允许 已启用+已信任 的 server 参与 Agent 任务。
 * 工具名桥接为 mcp__<server>__<tool>，与上游命名一致。
 */

const IDLE_TTL_MS = 5 * 60_000;
const MAX_SERVERS_PER_USER = 20;
const LIST_TIMEOUT_MS = 8_000;
const CALL_TIMEOUT_MS = 120_000;

interface CacheEntry { db:Db; fingerprint:string; connection: McpConnection; lastUsed: number }
const connections = new Map<string, CacheEntry>();

const dbIds=new WeakMap<Db,number>();let nextDbId=0;
function cacheKey(db:Db,userId: string, serverId: string): string { if(!dbIds.has(db))dbIds.set(db,++nextDbId);return `${dbIds.get(db)}:${userId}:${serverId}`; }
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function connectionFingerprint(server:McpServerRow){return hash([server.transport??'stdio',server.command,server.args_json,server.env_json,server.url??null,server.headers_json??'{}']);}

export interface McpServerRow {
    id: string; owner_user_id: string; name: string; command: string;
    args_json: string; env_json: string; trusted: number; enabled: number;
    transport?: 'stdio' | 'http'; url: string | null; headers_json?: string;
    last_error: string | null; last_tools_json: string | null; created_at: string; updated_at: string;
}

export function getMcpServer(db: Db, id: string, userId: string): McpServerRow | undefined {
    return db.db.prepare('SELECT * FROM mcp_servers WHERE id=? AND owner_user_id=?').get(id, userId) as McpServerRow | undefined;
}

export function listMcpServers(db: Db, userId: string): McpServerRow[] {
    return db.db.prepare('SELECT * FROM mcp_servers WHERE owner_user_id=? ORDER BY created_at,id').all(userId) as unknown as McpServerRow[];
}

function connectionFor(db: Db, userId: string, server: McpServerRow): McpConnection {
    const key = cacheKey(db, userId, server.id);
    const existing = connections.get(key);
    if (existing && existing.fingerprint===connectionFingerprint(server) && existing.connection.alive()) {
        existing.lastUsed = Date.now();
        return existing.connection;
    }
    if (existing) existing.connection.close('替换为新建连接');
    const onErrorMessage = (message: string): void => {
        db.db.prepare('UPDATE mcp_servers SET last_error=?, updated_at=? WHERE id=?').run(message.slice(0, 500), new Date().toISOString(), server.id);
    };
    const transport = server.transport ?? 'stdio';
    const connection = transport === 'http'
        ? createRemoteMcpConnection(server.id, server.url ?? '', JSON.parse(server.headers_json ?? '{}') as Record<string, string>, onErrorMessage)
        : connectMcpServer(server.id, server.command, JSON.parse(server.args_json) as string[], JSON.parse(server.env_json) as Record<string, string>, onErrorMessage);
    connections.set(key, { db, fingerprint:connectionFingerprint(server), connection, lastUsed: Date.now() });
    sweepIdle();
    return connection;
}

function sweepIdle(): void {
    const now = Date.now();
    for (const [key, entry] of connections) {
        if (now - entry.lastUsed > IDLE_TTL_MS) {
            entry.connection.close('空闲回收');
            connections.delete(key);
        }
    }
}

/** 尝试连接并列出工具（连接测试用）；失败写入 last_error 并上抛明确错误。 */
export async function probeMcpServer(db: Db, userId: string, server: McpServerRow): Promise<McpToolDef[]> {
    const connection = connectionFor(db, userId, server);
    try {
        const tools = await connection.listTools(true);
        const current=getMcpServer(db,server.id,userId);
        if(!current||connectionFingerprint(current)!==connectionFingerprint(server))throw new ApiError('POLICY_DENIED','MCP配置已变化，请重新测试连接');
        db.db.prepare('UPDATE mcp_servers SET last_error=NULL, last_tools_json=?, updated_at=? WHERE id=?')
            .run(JSON.stringify(tools.map(t => ({ name: t.name, description: t.description ?? '', inputSchema:t.inputSchema, readOnly: (t.readOnlyHint===true||(t as unknown as {annotations?:{readOnlyHint?:boolean}}).annotations?.readOnlyHint===true) }))), new Date().toISOString(), server.id);
        return tools;
    }
    catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : '连接失败';
        db.db.prepare('UPDATE mcp_servers SET last_error=?, updated_at=? WHERE id=?').run(message, new Date().toISOString(), server.id);
        connection.close('测试失败');
        if(connections.get(cacheKey(db,userId,server.id))?.connection===connection)connections.delete(cacheKey(db,userId,server.id));
        throw error instanceof ApiError ? error : new ApiError('SANDBOX_UNAVAILABLE', message);
    }
}

export interface QualifiedMcpTool {
    qualifiedName: string;
    serverId: string;
    serverName: string;
    toolName: string;
    description: string;
    inputSchema: Record<string, unknown>;
    readOnly: boolean;
    bindingHash: string;
}

/** bootstrap 构建：取最近一次探针缓存的工具清单（attempt 启动快照；探针由测试连接/保存时触发）。 */
export function collectCachedMcpTools(db: Db, userId: string): QualifiedMcpTool[] {
    const servers = listMcpServers(db, userId).filter(s => s.enabled && s.trusted).slice(0, MAX_SERVERS_PER_USER);
    const out: QualifiedMcpTool[] = [];
    const identities=new Set<string>();
    for (const server of servers) {
        const cached = server.last_tools_json;
        if (!cached) continue;
        try {
            const tools = JSON.parse(cached) as Array<{ name: string; description?: string; inputSchema?:Record<string,unknown>; readOnly?: boolean }>;
            for (const tool of tools) {
                if(typeof tool.name!=='string'||!tool.name)continue;
                const identity=JSON.stringify([server.id,tool.name]);if(identities.has(identity))continue;identities.add(identity);
                out.push({
                    qualifiedName: `mcp__${sanitizeSegment(server.name)}__${sanitizeSegment(tool.name)}`,
                    serverId: server.id,
                    serverName: server.name,
                    toolName: tool.name,
                    description: (tool.description ?? '').slice(0, 500),
                    inputSchema: tool.inputSchema ?? { type: 'object', properties: {}, additionalProperties: true },
                    readOnly: tool.readOnly===true,
                    bindingHash:hash([server.id,connectionFingerprint(server),tool.name,tool.inputSchema??null,tool.readOnly===true]),
                });
            }
        }
        catch { /* 损坏缓存按无工具处理 */ }
    }
    // Preserve ordinary aliases; disambiguate colliding/truncated names before model registration.
    const counts=new Map<string,number>();for(const tool of out)counts.set(tool.qualifiedName,(counts.get(tool.qualifiedName)??0)+1);
    const used=new Set<string>();
    for(const tool of out){const base=tool.qualifiedName;if(base.length>64||(counts.get(base)??0)>1){const suffix='_'+hash([tool.serverId,tool.toolName]).slice(0,12);tool.qualifiedName=`mcp__${sanitizeSegment(tool.serverName).slice(0,16)}__${sanitizeSegment(tool.toolName).slice(0,24)}`+suffix;}let n=0;while(used.has(tool.qualifiedName)){const suffix='_'+hash([tool.serverId,tool.toolName,++n]).slice(0,12);tool.qualifiedName=`mcp__${sanitizeSegment(tool.serverName).slice(0,16)}__${sanitizeSegment(tool.toolName).slice(0,24)}`+suffix;}used.add(tool.qualifiedName);}
    return out;
}

function sanitizeSegment(input: string): string {
    return input.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool';
}

/** 工具执行：qualifiedName → 定位 server/tool → callTool。 */
export async function callQualifiedMcpTool(db: Db, userId: string, qualifiedName: string, args: Record<string, unknown>, expected?:QualifiedMcpTool): Promise<unknown> {
    if(!/^mcp__[A-Za-z0-9_-]+$/.test(qualifiedName)||qualifiedName.length>64)throw new ApiError('POLICY_DENIED','MCP工具名不合法');
    const tool=collectCachedMcpTools(db,userId).find(t=>t.qualifiedName===qualifiedName);
    if(!tool)throw new ApiError('POLICY_DENIED','工具不在已发现清单中，或MCP服务未启用或未信任');
    if(expected&&(expected.serverId!==tool.serverId||expected.toolName!==tool.toolName||expected.bindingHash!==tool.bindingHash))throw new ApiError('POLICY_DENIED','MCP 配置或工具声明已变化，请在新任务中使用');
    const server=getMcpServer(db,tool.serverId,userId)!;
    const connection = connectionFor(db, userId, server);
    try {
        return await connection.callTool(tool.toolName, args, CALL_TIMEOUT_MS);
    }
    catch (error) {
        if (!connection.alive()) connections.delete(cacheKey(db, userId, server.id));
        throw error;
    }
}

export function closeAllMcpConnections(reason: string): void {
    for (const [, entry] of connections) entry.connection.close(reason);
    connections.clear();
}

export function closeMcpConnectionsForDb(db:Db):void{
 for(const [key,entry] of connections)if(entry.db===db){entry.connection.close('工作台关闭');connections.delete(key);}
}

export function closeMcpServerConnection(db:Db,userId:string,serverId:string):void{
 const key=cacheKey(db,userId,serverId),entry=connections.get(key);if(entry){entry.connection.close('MCP配置变更');connections.delete(key);}
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../storage/db.js';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../contracts/errors.js';
import { ok } from '../http.js';
import { validateMcpCommand } from './mcpClient.js';
import { listMcpServers, getMcpServer, probeMcpServer, closeMcpServerConnection, type McpServerRow } from './mcpManager.js';

/** 设置→MCP：server CRUD + 信任准入 + 连接测试（探针并缓存工具清单）。 */
export function registerMcpRoutes(app: FastifyInstance, db: Db): void {
    function userId(req: FastifyRequest): string {
        const session = (req as unknown as { session?: { userId?: string } }).session;
        if (!session?.userId) throw new ApiError('AUTH_REQUIRED', '请先登录');
        return session.userId;
    }

    function ownedServer(req: FastifyRequest, id: string): McpServerRow {
        const server = getMcpServer(db, id, userId(req));
        if (!server) throw new ApiError('NOT_FOUND', 'MCP 服务不存在或无权访问');
        return server;
    }

    interface McpPayload { name: string; command: string; args: string[]; env: Record<string, string>; transport: 'stdio' | 'http'; url: string | null; headers: Record<string, string> }
    function parseBody(req: FastifyRequest): { name: unknown; command: unknown; args: unknown; env: unknown; transport: unknown; url: unknown; headers: unknown } {
        return (req.body ?? {}) as { name: unknown; command: unknown; args: unknown; env: unknown; transport: unknown; url: unknown; headers: unknown };
    }

    function validatePayload(name: unknown, command: unknown, args: unknown, env: unknown, transport: unknown = 'stdio', url: unknown = null, headers: unknown = {}): McpPayload {
        if (typeof name !== 'string' || !name.trim() || name.length > 64) throw new ApiError('VALIDATION_FAILED', '名称须为1-64字符');
        if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name)) throw new ApiError('VALIDATION_FAILED', '名称仅限字母数字空格连字符下划线');
        if (transport !== 'stdio' && transport !== 'http') throw new ApiError('VALIDATION_FAILED', '连接方式仅支持本地进程（stdio）或远程 HTTP');
        if (transport === 'http') {
            if (typeof url !== 'string' || !url.trim() || url.length > 2048) throw new ApiError('VALIDATION_FAILED', '远程 MCP 须为1-2048字符的 https 地址');
            let parsed: URL;
            try { parsed = new URL(url.trim()); } catch { throw new ApiError('VALIDATION_FAILED', '远程 MCP 地址无效'); }
            if (parsed.protocol !== 'https:') throw new ApiError('VALIDATION_FAILED', '远程 MCP 仅支持 https:// 地址');
            if (parsed.username || parsed.password || parsed.hash) throw new ApiError('VALIDATION_FAILED', '地址不能包含账号信息或锚点（Key 请放 Headers）');
            if (headers !== undefined && (typeof headers !== 'object' || headers === null || Array.isArray(headers))) throw new ApiError('VALIDATION_FAILED', 'Headers 须为对象');
            const headerMap: Record<string, string> = {};
            for (const [key, value] of Object.entries((headers ?? {}) as Record<string, unknown>)) {
                if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) throw new ApiError('VALIDATION_FAILED', `Header 名不合法：${key.slice(0, 40)}`);
                if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\r\n\0]/.test(value)) throw new ApiError('VALIDATION_FAILED', `Header 值须为1-1024字符且不含控制字符：${key.slice(0, 40)}`);
                headerMap[key] = value;
            }
            if (Object.keys(headerMap).length > 16) throw new ApiError('VALIDATION_FAILED', 'Headers 数量过多（≤16）');
            return { name: name.trim(), command: '', args: [], env: {}, transport: 'http', url: url.trim(), headers: headerMap };
        }
        if (typeof command !== 'string' || !command.trim()) throw new ApiError('VALIDATION_FAILED', '缺少启动命令');
        if (args !== undefined && !Array.isArray(args)) throw new ApiError('VALIDATION_FAILED', '参数须为字符串数组');
        if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env))) throw new ApiError('VALIDATION_FAILED', '环境变量须为对象');
        const argv = (args ?? []) as unknown[];
        if (argv.length > 64 || argv.some(a => typeof a !== 'string')) throw new ApiError('VALIDATION_FAILED', '参数须为字符串数组（≤64项）');
        const envMap: Record<string, string> = {};
        for (const [key, value] of Object.entries((env ?? {}) as Record<string, unknown>)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ApiError('VALIDATION_FAILED', `环境变量名不合法：${key.slice(0, 40)}`);
            if (typeof value !== 'string' || value.length > 2048) throw new ApiError('VALIDATION_FAILED', `环境变量值须为字符串（≤2048）：${key.slice(0, 40)}`);
            envMap[key] = value;
        }
        if (Object.keys(envMap).length > 32) throw new ApiError('VALIDATION_FAILED', '环境变量数量过多（≤32）');
        return { name: name.trim(), command: command, args: argv as string[], env: envMap, transport: 'stdio', url: null, headers: {} };
    }

    app.get('/api/v1/mcp-servers', async (req, reply) => {
        const uid = userId(req);
        const servers = listMcpServers(db, uid).map(s => ({
            id: s.id, name: s.name, command: s.command, args: JSON.parse(s.args_json) as string[],
            envKeys: Object.keys(JSON.parse(s.env_json) as Record<string, string>),
            transport: (s.transport ?? 'stdio') as 'stdio' | 'http',
            url: s.url ?? null,
            headerKeys: Object.keys(JSON.parse(s.headers_json ?? '{}') as Record<string, string>),
            trusted: !!s.trusted, enabled: !!s.enabled, lastError: s.last_error,
            toolCount: (() => { try { return (JSON.parse(s.last_tools_json ?? '[]') as unknown[]).length; } catch { return 0; } })(),
            updatedAt: s.updated_at,
        }));
        return ok(req, reply, { servers });
    });

    app.post('/api/v1/mcp-servers', async (req, reply) => {
        const uid = userId(req);
        const existing = listMcpServers(db, uid);
        if (existing.length >= 20) throw new ApiError('VALIDATION_FAILED', 'MCP 服务数量已达上限（20）');
        const body = parseBody(req);
        const payload = validatePayload(body.name, body.command ?? '', body.args ?? [], body.env ?? {}, body.transport, body.url, body.headers);
        if (payload.transport === 'stdio') validateMcpCommand(payload.command, payload.args);
        const id = randomUUID();
        const now = new Date().toISOString();
        // 新增server默认未信任：信任须由用户显式开启（workspace信任准入）
        db.db.prepare(`INSERT INTO mcp_servers(id,owner_user_id,name,command,args_json,env_json,transport,url,headers_json,trusted,enabled,last_error,last_tools_json,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,'0','1',NULL,NULL,?,?)`)
            .run(id, uid, payload.name, payload.command, JSON.stringify(payload.args), JSON.stringify(payload.env), payload.transport, payload.url,
                JSON.stringify(payload.headers), now, now);
        return ok(req, reply, { id, name: payload.name });
    });

    app.put('/api/v1/mcp-servers/:id', async (req, reply) => {
        const server = ownedServer(req, (req.params as { id?: string }).id ?? '');
        const body = parseBody(req);
        const nextTransport = (body.transport ?? server.transport ?? 'stdio') as 'stdio' | 'http';
        const payload = validatePayload(body.name ?? server.name, body.command ?? server.command, body.args ?? JSON.parse(server.args_json), body.env ?? JSON.parse(server.env_json),
            nextTransport, body.url ?? server.url ?? null, body.headers ?? JSON.parse(server.headers_json ?? '{}'));
        if (payload.transport === 'stdio') validateMcpCommand(payload.command, payload.args);
        const now = new Date().toISOString();
        db.db.prepare('UPDATE mcp_servers SET name=?,command=?,args_json=?,env_json=?,transport=?,url=?,headers_json=?,last_error=NULL,last_tools_json=NULL,updated_at=? WHERE id=?')
            .run(payload.name, payload.command, JSON.stringify(payload.args), JSON.stringify(payload.env), payload.transport, payload.url, JSON.stringify(payload.headers), now, server.id);
        closeMcpServerConnection(db,userId(req),server.id);
        return ok(req, reply, { id: server.id, updated: true });
    });

    app.put('/api/v1/mcp-servers/:id/trust', async (req, reply) => {
        const server = ownedServer(req, (req.params as { id?: string }).id ?? '');
        const body = (req.body ?? {}) as { trusted?: unknown };
        if (typeof body.trusted !== 'boolean') throw new ApiError('VALIDATION_FAILED', '缺少 trusted 布尔值');
        const now = new Date().toISOString();
        // 撤销信任同时停用：下次启用须重新确认（信任降级不静默）
        db.db.prepare('UPDATE mcp_servers SET trusted=?,enabled=?,last_tools_json=?,updated_at=? WHERE id=?')
            .run(body.trusted ? '1' : '0', body.trusted ? '1' : '0', body.trusted ? server.last_tools_json : null, now, server.id);
        closeMcpServerConnection(db,userId(req),server.id);
        return ok(req, reply, { id: server.id, trusted: body.trusted, enabled: body.trusted });
    });

    app.put('/api/v1/mcp-servers/:id/enabled', async (req, reply) => {
        const server = ownedServer(req, (req.params as { id?: string }).id ?? '');
        const body = (req.body ?? {}) as { enabled?: unknown };
        if (typeof body.enabled !== 'boolean') throw new ApiError('VALIDATION_FAILED', '缺少 enabled 布尔值');
        if (body.enabled && !server.trusted) throw new ApiError('VALIDATION_FAILED', '请先信任该服务再启用');
        const now = new Date().toISOString();
        db.db.prepare('UPDATE mcp_servers SET enabled=?,updated_at=? WHERE id=?').run(body.enabled ? '1' : '0', now, server.id);
        closeMcpServerConnection(db,userId(req),server.id);
        return ok(req, reply, { id: server.id, enabled: body.enabled });
    });

    app.delete('/api/v1/mcp-servers/:id', async (req, reply) => {
        const server = ownedServer(req, (req.params as { id?: string }).id ?? '');
        db.db.prepare('DELETE FROM mcp_servers WHERE id=?').run(server.id);
        closeMcpServerConnection(db,userId(req),server.id);
        return ok(req, reply, { id: server.id, deleted: true });
    });

    app.post('/api/v1/mcp-servers/:id/test', async (req, reply) => {
        const server = ownedServer(req, (req.params as { id?: string }).id ?? '');
        const started = Date.now();
        try {
            const tools = await probeMcpServer(db, userId(req), server);
            return ok(req, reply, { ok: true, latencyMs: Date.now() - started, toolCount: tools.length, tools: tools.slice(0, 20).map(t => ({ name: t.name, readOnly: !!t.readOnlyHint })) });
        } catch (error) {
            throw new ApiError('SANDBOX_UNAVAILABLE', `连接失败：${error instanceof Error ? error.message.slice(0, 200) : '未知错误'}`);
        }
    });
}

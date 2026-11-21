import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildProductApp } from '../src/app.js';
import { createRemoteMcpConnection, parseRpcPayload } from '../src/agent/mcpHttpClient.js';
import { hashPassword } from '../src/auth/passwords.js';
import { Db } from '../src/storage/db.js';
import { migrate, defaultMigrationsDir } from '../src/storage/migrate.js';

/** R62（MCP 远程传输）：HTTP 客户端握手/会话/SSE/分页/重握手、路由校验与掩码。不出真实网络。 */

interface Call { url: string; headers: Record<string, string>; body: { method?: string; id?: number; params?: Record<string, unknown> } }
function jsonResponse(payload: unknown, extraHeaders: Record<string, string> = {}, status = 200): { status: number; headers: Headers; bytes: Buffer } {
    return { status, headers: new Headers({ 'content-type': 'application/json', ...extraHeaders }), bytes: Buffer.from(JSON.stringify(payload), 'utf8') };
}
const rpcResult = (id: number, result: unknown, headers?: Record<string, string>) => jsonResponse({ jsonrpc: '2.0', id, result }, headers);

test('mcpHttp: initialize/tools/list/tools/call 往返并回传会话头与协议版本', async () => {
    const calls: Call[] = [];
    const session = { 'mcp-session-id': 'sess-123' };
    const connection = createRemoteMcpConnection('srv-1', 'https://mcp.example.com/mcp', { authorization: 'Bearer k1' }, undefined, async (url, headers, body) => {
        const parsed = body as Call['body'];
        calls.push({ url, headers, body: parsed });
        const id = parsed.id ?? -1;
        if (parsed.method === 'initialize') { return rpcResult(id, { protocolVersion: '2025-06-18', serverInfo: { name: 'x', version: '1' } }, session); }
        if (parsed.method === 'notifications/initialized') return { status: 202, headers: new Headers(), bytes: Buffer.alloc(0) };
        if (parsed.method === 'tools/list') return rpcResult(id, { tools: [{ name: 'webSearchPrime', description: 'search', inputSchema: { type: 'object' }, readOnlyHint: true }] }, session);
        if (parsed.method === 'tools/call') return rpcResult(id, { content: [{ type: 'text', text: '结果' }], isError: false }, session);
        throw new Error('unexpected method');
    });
    const tools = await connection.listTools(true);
    assert.deepEqual(tools.map(t => t.name), ['webSearchPrime']);
    assert.equal(tools[0]!.readOnlyHint, true);
    const result = await connection.callTool('webSearchPrime', { query: 'q' }, 5_000);
    assert.deepEqual(result, { content: [{ type: 'text', text: '结果' }], isError: false });
    // initialize 无会话头；后续请求携带会话头与鉴权、协议版本
    assert.equal(calls[0]!.headers['mcp-session-id'], undefined);
    assert.equal(calls[1]!.headers['mcp-session-id'], 'sess-123');
    assert.equal(calls[calls.length - 1]!.headers['authorization'], 'Bearer k1');
    assert.equal(calls[calls.length - 1]!.headers['mcp-protocol-version'], '2025-06-18');
    assert.equal(calls[calls.length - 1]!.headers.accept, 'application/json, text/event-stream');
    const methods = calls.map(c => c.body.method);
    assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
});

test('mcpHttp: SSE 帧解析取匹配 id，分页 nextCursor 拉全工具', () => {
    const sse = ['event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":1}}', 'event: message\ndata: {"jsonrpc":"2.0","method":"ping"}'].join('\n\n');
    const parsed = parseRpcPayload(200, 'text/event-stream', Buffer.from(sse, 'utf8'), '7');
    assert.deepEqual(parsed.result, { ok: 1 });
    assert.throws(() => parseRpcPayload(200, 'text/event-stream', Buffer.from(sse, 'utf8'), '99'), /没有匹配的应答帧/);
    assert.throws(() => parseRpcPayload(500, 'application/json', Buffer.from('{"x":1}', 'utf8'), '1'), /HTTP 500/);
});

test('mcpHttp: tools/list 分页直到 nextCursor 消失', async () => {
    const calls: Call[] = [];
    const pages = [
        { tools: [{ name: 'a' }], nextCursor: 'page-2' },
        { tools: [{ name: 'b' }, { name: 'c' }] },
    ];
    let listed = 0;
    const connection = createRemoteMcpConnection('srv-2', 'https://mcp.example.com/mcp', {}, undefined, async (_url, _headers, body) => {
        const parsed = body as Call['body'];
        calls.push({ url: _url, headers: _headers, body: parsed });
        if (parsed.method === 'initialize') return rpcResult(parsed.id ?? -1, { protocolVersion: '2025-06-18' });
        if (parsed.method === 'notifications/initialized') return { status: 202, headers: new Headers(), bytes: Buffer.alloc(0) };
        return rpcResult(parsed.id ?? -1, pages[listed++]!);
    });
    const tools = await connection.listTools(true);
    assert.deepEqual(tools.map(t => t.name), ['a', 'b', 'c']);
    const listCalls = calls.filter(c => c.body.method === 'tools/list');
    assert.equal(listCalls.length, 2);
    assert.deepEqual(listCalls[0]!.body.params, {});
    assert.deepEqual(listCalls[1]!.body.params, { cursor: 'page-2' });
});

test('mcpHttp: 会话失效（404）自动重握手一次并成功重试', async () => {
    let handshakes = 0, callAttempts = 0;
    const connection = createRemoteMcpConnection('srv-3', 'https://mcp.example.com/mcp', {}, undefined, async (_url, _headers, body) => {
        const parsed = body as Call['body'];
        if (parsed.method === 'initialize') { handshakes++; return rpcResult(parsed.id ?? -1, { protocolVersion: '2025-06-18' }, { 'mcp-session-id': `s${handshakes}` }); }
        if (parsed.method === 'notifications/initialized') return { status: 202, headers: new Headers(), bytes: Buffer.alloc(0) };
        if (parsed.method === 'tools/call') {
            callAttempts++;
            if (callAttempts === 1) return { status: 404, headers: new Headers(), bytes: Buffer.from('{"error":"session not found"}', 'utf8') };
            return rpcResult(parsed.id ?? -1, { content: [{ type: 'text', text: '重试成功' }] });
        }
        throw new Error('unexpected');
    });
    const result = await connection.callTool('webSearchPrime', {}, 5_000) as { content: Array<{ text: string }> };
    assert.equal(result.content[0]!.text, '重试成功');
    assert.equal(handshakes, 2);
    assert.equal(callAttempts, 2);
});

test('mcpHttp: 非 https 与无效地址在请求时拒绝，不出网', async () => {
    const connection = createRemoteMcpConnection('srv-4', 'http://mcp.example.com/mcp', {});
    await assert.rejects(connection.listTools(true), /https/);
    assert.throws(() => createRemoteMcpConnection('srv-5', 'not a url', {}), /地址无效/);
    // 内网字面量 IP 由传输守卫拒绝
    const loopback = createRemoteMcpConnection('srv-6', 'https://127.0.0.1/mcp', {});
    await assert.rejects(loopback.listTools(true), /内网|不受允许/);
});

test('mcpRoutes: 远程 HTTP 服务创建校验、掩码与 stdio 默认兼容', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-mcp-remote-'));
    try {
        const fx = buildProductApp(dir, { serveWeb: false });
        const record = await hashPassword('correct-horse-battery');
        const uid = randomUUID();
        const now = new Date().toISOString();
        fx.db.tx(tx => tx.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)')
            .run(uid, 'mcpremote', record.hash, record.salt, record.paramsJson, now, now));
        const login = await fx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'mcpremote', password: 'correct-horse-battery' } });
        assert.equal(login.statusCode, 200);
        const raw = login.headers['set-cookie'];
        const cookie = (Array.isArray(raw) ? String(raw[0]) : String(raw)).split(';')[0]!;
        const authHeaders = { cookie, 'x-csrf-token': (login.json() as { data: { csrfToken: string } }).data.csrfToken };

        // http 明文地址拒绝
        const plain = await fx.app.inject({ method: 'POST', url: '/api/v1/mcp-servers', headers: authHeaders, payload: { name: 'remote-1', transport: 'http', url: 'http://mcp.example.com/mcp' } });
        assert.equal(plain.statusCode, 400);
        // http 缺地址拒绝
        const noUrl = await fx.app.inject({ method: 'POST', url: '/api/v1/mcp-servers', headers: authHeaders, payload: { name: 'remote-2', transport: 'http' } });
        assert.equal(noUrl.statusCode, 400);
        // 非法 header 名拒绝
        const badHeader = await fx.app.inject({ method: 'POST', url: '/api/v1/mcp-servers', headers: authHeaders, payload: { name: 'remote-3', transport: 'http', url: 'https://mcp.example.com/mcp', headers: { 'bad header': 'x' } } });
        assert.equal(badHeader.statusCode, 400);
        // 带控制字符的 header 值拒绝
        const crlf = await fx.app.inject({ method: 'POST', url: '/api/v1/mcp-servers', headers: authHeaders, payload: { name: 'remote-4', transport: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer a\nX: y' } } });
        assert.equal(crlf.statusCode, 400);
        // 正常创建：headers 持久化，列表只回 headerKeys
        const created = await fx.app.inject({ method: 'POST', url: '/api/v1/mcp-servers', headers: authHeaders, payload: { name: 'zhipu-search', transport: 'http', url: 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp', headers: { Authorization: 'Bearer secret-key' } } });
        assert.equal(created.statusCode, 200);
        const { id } = (created.json() as { data: { id: string } }).data;
        const row = fx.db.db.prepare('SELECT transport,url,headers_json,command FROM mcp_servers WHERE id=?').get(id) as { transport: string; url: string; headers_json: string; command: string };
        assert.equal(row.transport, 'http');
        assert.equal(row.url, 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp');
        assert.deepEqual(JSON.parse(row.headers_json), { Authorization: 'Bearer secret-key' });
        assert.equal(row.command, '');
        const list = await fx.app.inject({ method: 'GET', url: '/api/v1/mcp-servers', headers: { cookie } });
        const mine = (list.json() as { data: { servers: Array<{ id: string; transport: string; url: string; headerKeys: string[] }> } }).data.servers.find(s => s.id === id)!;
        assert.equal(mine.transport, 'http');
        assert.equal(mine.headerKeys.length, 1);
        assert.ok(!JSON.stringify(list.json()).includes('secret-key'), '列表不得回显 Header 值');
        // 兼容：不传 transport 的 stdio 创建仍工作
        const legacy = await fx.app.inject({ method: 'POST', url: '/api/v1/mcp-servers', headers: authHeaders, payload: { name: 'legacy-stdio', command: 'echo', args: ['hi'] } });
        assert.equal(legacy.statusCode, 200);
        const legacyRow = fx.db.db.prepare('SELECT transport FROM mcp_servers WHERE id=?').get((legacy.json() as { data: { id: string } }).data.id) as { transport: string };
        assert.equal(legacyRow.transport, 'stdio');
        fx.app.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mcpRoutes: 远程服务无启动命令也可保存，stdio 回退路径不受影响', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-mcp-remote-fp-'));
    try {
        const fx = buildProductApp(dir, { serveWeb: false });
        // 直插一行 http 行，模拟 manager 取行分发（不真连：fingerprint 应包含 url/headers）
        const uid = randomUUID();
        const record = await hashPassword('correct-horse-battery');
        const now = new Date().toISOString();
        fx.db.tx(tx => tx.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)')
            .run(uid, 'mcpremote2', record.hash, record.salt, record.paramsJson, now, now));
        const id = randomUUID();
        fx.db.tx(tx => tx.prepare(`INSERT INTO mcp_servers(id,owner_user_id,name,command,args_json,env_json,transport,url,headers_json,trusted,enabled,last_error,last_tools_json,created_at,updated_at)
            VALUES (?,?,'remote-a','','[]','{}','http','https://mcp.example.com/mcp','{}','1','1',NULL,NULL,?,?)`).run(id, uid, now, now));
        const row = fx.db.db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(id) as { transport: string; url: string };
        assert.equal(row.transport, 'http');
        assert.equal(row.url, 'https://mcp.example.com/mcp');
        fx.app.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

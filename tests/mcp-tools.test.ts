import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildProductApp } from '../src/app.js';
import { validateMcpCommand, connectMcpServer } from '../src/agent/mcpClient.js';
import { collectCachedMcpTools, callQualifiedMcpTool, getMcpServer } from '../src/agent/mcpManager.js';
import { requiresApproval } from '../src/agent/approvalPolicy.js';
import type { ToolSpec } from '../src/agent/toolExec.js';
import { hashPassword } from '../src/auth/passwords.js';
import { Db } from '../src/storage/db.js';
import { migrate, defaultMigrationsDir } from '../src/storage/migrate.js';

/** 块B（MCP）：stdio客户端真进程往返、快照装配命名/审批映射、路由准入。 */

const USER = '01234567-89ab-4def-8901-234567890abc';

function tempDb(): { db: Db; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'prism-mcp-'));
    const db = new Db(join(dir, 'db.sqlite'));
    migrate(db, defaultMigrationsDir());
    db.tx(tx => tx.prepare("INSERT INTO users(id,username,password_hash,password_salt,password_params_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(USER, 'mcper', 'x', 's', '{}', '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z'));
    return { db, dir };
}

function insertServer(db: Db, patch: Partial<{ name: string; command: string; trusted: string; enabled: string; lastToolsJson: string | null }> = {}): string {
    const id = '11111111-2222-4333-8444-' + String(Math.floor(Math.random() * 1e12)).padStart(12, '0');
    db.db.prepare(`INSERT INTO mcp_servers(id,owner_user_id,name,command,args_json,env_json,trusted,enabled,last_error,last_tools_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,? ,NULL,?,?,?)`)
        .run(id, USER, patch.name ?? 'demo-server', patch.command ?? 'echo', '[]', '{}', patch.trusted ?? '1', patch.enabled ?? '1', patch.lastToolsJson ?? null, '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z');
    return id;
}

test('mcpClient: 命令校验拒绝空命令与控制字符', () => {
    assert.throws(() => validateMcpCommand('', []), /启动命令不能为空/);
    assert.throws(() => validateMcpCommand('n\npx', []), /控制字符/);
    assert.throws(() => validateMcpCommand('node', ['--eval', 'a\rb']), /控制字符/);
    assert.doesNotThrow(() => validateMcpCommand('npx', ['-y', '@modelcontextprotocol/server-memory']));
});

test('mcpClient: 与真实stdio子进程完成 initialize/tools/list/tools/call 往返', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-mcp-server-'));
    const scriptPath = join(dir, 'fake-server.mjs');
    writeFileSync(scriptPath, `
const pending = new Map();
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') reply(msg.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0.0.1' } });
    else if (msg.method === 'tools/list') reply(msg.id, { tools: [
      { name: 'echo', description: '回显输入', inputSchema: { type: 'object' }, readOnlyHint: true },
      { name: 'mutate', description: '外部副作用', inputSchema: { type: 'object' } },
    ] });
    else if (msg.method === 'tools/call') reply(msg.id, { content: [{ type: 'text', text: 'echo:' + (msg.params.arguments?.text ?? '') }], isError: false });
  }
});
`, { mode: 0o755 });
    const connection = connectMcpServer('test', process.execPath, [scriptPath], {});
    try {
        const tools = await connection.listTools(true);
        assert.equal(tools.length, 2);
        assert.equal(tools[0]!.name, 'echo');
        assert.equal(tools[0]!.readOnlyHint, true);
        // 二次list走60s缓存，不重发请求（fake-server无请求计数，仅验证仍成功）
        const again = await connection.listTools(false);
        assert.equal(again.length, 2);
        const result = await connection.callTool('echo', { text: '你好' }, 5000) as { content: Array<{ text: string }> };
        assert.equal(result.content[0]!.text, 'echo:你好');
    } finally {
        connection.close('测试结束');
        rmSync(dir, { recursive: true, force: true });
    }
});

test('mcpManager: 快照装配限定已信任+已启用，qualifiedName与readOnly映射正确', () => {
    const { db, dir } = tempDb();
    try {
        insertServer(db, { name: 'demo server', lastToolsJson: JSON.stringify([
            { name: 'echo', description: '只读回显', readOnly: true },
            { name: 'mutate', description: '副作用', readOnly: false },
        ]) });
        insertServer(db, { name: 'untrusted', trusted: '0', lastToolsJson: JSON.stringify([{ name: 'x' }]) });
        insertServer(db, { name: 'disabled', enabled: '0', lastToolsJson: JSON.stringify([{ name: 'y' }]) });
        insertServer(db, { name: 'no-cache' });
        const tools = collectCachedMcpTools(db, USER);
        // 只有 demo-server 参与；server名空格转下划线
        assert.equal(tools.length, 2);
        assert.deepEqual(tools.map(t => t.qualifiedName), ['mcp__demo_server__echo', 'mcp__demo_server__mutate']);
        assert.equal(tools[0]!.readOnly, true);
        assert.equal(tools[1]!.readOnly, false);
        // 损坏缓存按无工具处理
        const id = insertServer(db, { name: 'corrupt', lastToolsJson: '{broken' });
        assert.equal(collectCachedMcpTools(db, USER).length, 2);
        db.db.prepare('DELETE FROM mcp_servers WHERE id=?').run(id);
    } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

function mcpSpec(readOnly: boolean): ToolSpec {
    return { name: 'mcp__demo__tool', description: 'x', parameters: {}, effect: readOnly ? 'read' : 'external', highImpact: () => true };
}

test('approval: MCP未声明只读按external——auto/ask逐次审批，full不询问（D49）', () => {
    assert.equal(requiresApproval('auto', mcpSpec(false), {}), true);
    assert.equal(requiresApproval('ask', mcpSpec(false), {}), true);
    assert.equal(requiresApproval('full', mcpSpec(false), {}), false);
    // 声明只读 → read，任何模式不询问
    for (const mode of ['auto', 'ask', 'full'] as const) assert.equal(requiresApproval(mode, mcpSpec(true), {}), false);
});

test('mcpManager: callQualifiedMcpTool 拒绝未信任服务与未发现工具', async () => {
    const { db, dir } = tempDb();
    try {
        const trusted = insertServer(db, { name: 'demo', lastToolsJson: JSON.stringify([{ name: 'echo' }]) });
        const untrusted = insertServer(db, { name: 'shady', trusted: '0', lastToolsJson: JSON.stringify([{ name: 'steal' }]) });
        await assert.rejects(() => callQualifiedMcpTool(db, USER, 'mcp__shady__steal', {}), /未启用或未信任/);
        await assert.rejects(() => callQualifiedMcpTool(db, USER, 'mcp__demo__not_discovered', {}), /已发现清单/);
        await assert.rejects(() => callQualifiedMcpTool(db, USER, 'not-a-mcp-name', {}), /不合法/);
        assert.ok(getMcpServer(db, trusted, USER));
        assert.ok(getMcpServer(db, untrusted, USER));
    } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('mcpRoutes: 未登录401；校验拒绝非法名称；信任准入拦截启用', async () => {
    const { dir } = tempDb();
    try {
        const fx = buildProductApp(dir, { serveWeb: false });
        const anon = await fx.app.inject({ method: 'GET', url: '/api/v1/mcp-servers' });
        assert.equal(anon.statusCode, 401);

        // 与 auth.test.ts 同法直接入库用户，登录取 cookie + csrf
        const record = await hashPassword('correct-horse-battery');
        const uid = randomUUID();
        const now = new Date().toISOString();
        fx.db.tx(tx => tx.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)')
            .run(uid, 'mcpuser2', record.hash, record.salt, record.paramsJson, now, now));
        const login = await fx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'mcpuser2', password: 'correct-horse-battery' } });
        assert.equal(login.statusCode, 200);
        const raw = login.headers['set-cookie'];
        const cookie = (Array.isArray(raw) ? String(raw[0]) : String(raw)).split(';')[0]!;
        const authHeaders = { cookie, 'x-csrf-token': (login.json() as { data: { csrfToken: string } }).data.csrfToken };

        // 名称非法
        const badName = await fx.app.inject({ method: 'POST', url: '/api/v1/mcp-servers', headers: authHeaders, payload: { name: 'bad name!', command: 'npx' } });
        assert.equal(badName.statusCode, 400);
        // 缺命令
        const noCommand = await fx.app.inject({ method: 'POST', url: '/api/v1/mcp-servers', headers: authHeaders, payload: { name: 'okname' } });
        assert.equal(noCommand.statusCode, 400);
        // 正常创建：默认未信任+已启用
        const created = await fx.app.inject({ method: 'POST', url: '/api/v1/mcp-servers', headers: authHeaders, payload: { name: 'demo server', command: 'echo', args: ['hi'], env: { FOO: 'bar' } } });
        assert.equal(created.statusCode, 200);
        const { id } = (created.json() as { data: { id: string } }).data;
        const list = await fx.app.inject({ method: 'GET', url: '/api/v1/mcp-servers', headers: { cookie } });
        const servers = (list.json() as { data: { servers: Array<{ id: string; trusted: boolean; enabled: boolean; envKeys: string[] }> } }).data.servers;
        const mine = servers.find(s => s.id === id);
        assert.ok(mine);
        assert.equal(mine.trusted, false);
        assert.equal(mine.enabled, true);
        assert.deepEqual(mine.envKeys, ['FOO']);
        // 未信任不允许直接启用
        const enableBlocked = await fx.app.inject({ method: 'PUT', url: `/api/v1/mcp-servers/${id}/enabled`, headers: authHeaders, payload: { enabled: true } });
        assert.equal(enableBlocked.statusCode, 400);
        // 撤销信任同时停用
        await fx.app.inject({ method: 'PUT', url: `/api/v1/mcp-servers/${id}/trust`, headers: authHeaders, payload: { trusted: true } });
        const revoke = await fx.app.inject({ method: 'PUT', url: `/api/v1/mcp-servers/${id}/trust`, headers: authHeaders, payload: { trusted: false } });
        assert.equal(revoke.statusCode, 200);
        const list2 = await fx.app.inject({ method: 'GET', url: '/api/v1/mcp-servers', headers: { cookie } });
        const after = (list2.json() as { data: { servers: Array<{ id: string; trusted: boolean; enabled: boolean }> } }).data.servers.find(s => s.id === id);
        assert.equal(after!.trusted, false);
        assert.equal(after!.enabled, false, '撤销信任应同时停用');
        // 测试连接：echo 命令不是MCP server，应显式失败（SANDBOX_UNAVAILABLE=422）而非冒充成功
        await fx.app.inject({ method: 'PUT', url: `/api/v1/mcp-servers/${id}/trust`, headers: authHeaders, payload: { trusted: true } });
        const testResult = await fx.app.inject({ method: 'POST', url: `/api/v1/mcp-servers/${id}/test`, headers: authHeaders });
        assert.equal(testResult.statusCode, 422);
        // 删除
        const removed = await fx.app.inject({ method: 'DELETE', url: `/api/v1/mcp-servers/${id}`, headers: authHeaders });
        assert.equal(removed.statusCode, 200);
        fx.app.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('MCP管理器真实链保留必填参数定义，桥接别名仍调用原始工具名',async()=>{
 const {probeMcpServer,getMcpServer,closeAllMcpConnections}=await import('../src/agent/mcpManager.js');
 const {db,dir}=tempDb();const script=join(dir,'schema-server.mjs');
 writeFileSync(script,`let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf(String.fromCharCode(10)))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);let result;if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{}};if(m.method==='tools/list')result={tools:[{name:'echo.tool',description:'echo',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query']},annotations:{readOnlyHint:true}}]};if(m.method==='tools/call')result=m.params.name==='echo.tool'&&m.params.arguments.query?{content:[{type:'text',text:m.params.arguments.query}]}:{isError:true,content:[{type:'text',text:'bad raw name or missing query'}]};if(result)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+String.fromCharCode(10));}});`);
 try{
  const id=insertServer(db,{name:'schema-server',command:process.execPath});db.db.prepare('UPDATE mcp_servers SET args_json=? WHERE id=?').run(JSON.stringify([script]),id);
  await probeMcpServer(db,USER,getMcpServer(db,id,USER)!);
  const tool=collectCachedMcpTools(db,USER)[0]!;assert.deepEqual(tool.inputSchema.required,['query']);assert.equal(tool.readOnly,true);
  const result=await callQualifiedMcpTool(db,USER,tool.qualifiedName,{query:'ACTUAL_SCHEMA_OK'}) as {content:Array<{text:string}>};assert.equal(result.content[0]!.text,'ACTUAL_SCHEMA_OK');
 }finally{closeAllMcpConnections('test');db.close();rmSync(dir,{recursive:true,force:true});}
});


test('验收：MCP命名冲突与长名称仍必须唯一、满足模型64字符限制',()=>{
 const {db,dir}=tempDb();try{
  insertServer(db,{name:'same server',lastToolsJson:JSON.stringify([{name:'tool.one',readOnly:true},{name:'tool_one',readOnly:false}])});
  insertServer(db,{name:'same_server',lastToolsJson:JSON.stringify([{name:'tool.one',readOnly:false}])});
  insertServer(db,{name:'s'.repeat(64),lastToolsJson:JSON.stringify([{name:'t'.repeat(100)}])});
  const tools=collectCachedMcpTools(db,USER);assert.equal(new Set(tools.map(t=>t.qualifiedName)).size,tools.length);assert.ok(tools.every(t=>t.qualifiedName.length<=64));
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('验收：MCP双下划线服务名可调用；修改环境后探针必须连接新进程',async()=>{
 const {db,dir}=tempDb(),{probeMcpServer,closeMcpConnectionsForDb}=await import('../src/agent/mcpManager.js');
 const script=join(dir,'server.mjs');writeFileSync(script,`let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);let result;if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{}};if(m.method==='tools/list')result={tools:[{name:'echo',description:process.env.MARKER,inputSchema:{type:'object'},readOnlyHint:true}]};if(m.method==='tools/call')result={content:[{type:'text',text:process.env.MARKER}]};if(result)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}});`);
 const id=insertServer(db,{name:'demo__server',command:process.execPath});db.db.prepare('UPDATE mcp_servers SET args_json=?,env_json=? WHERE id=?').run(JSON.stringify([script]),JSON.stringify({MARKER:'before'}),id);
 try{
  await probeMcpServer(db,USER,getMcpServer(db,id,USER)!);const tool=collectCachedMcpTools(db,USER)[0]!;
  const called=await callQualifiedMcpTool(db,USER,tool.qualifiedName,{}) as {content:Array<{text:string}>};assert.equal(called.content[0]!.text,'before');
  db.db.prepare('UPDATE mcp_servers SET env_json=? WHERE id=?').run(JSON.stringify({MARKER:'after'}),id);
  await assert.rejects(callQualifiedMcpTool(db,USER,tool.qualifiedName,{},tool),/已变化/);
  const next=await probeMcpServer(db,USER,getMcpServer(db,id,USER)!);assert.equal(next[0]!.description,'after');
 }finally{closeMcpConnectionsForDb(db);db.close();rmSync(dir,{recursive:true,force:true});}
});

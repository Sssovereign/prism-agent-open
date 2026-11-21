import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { buildProductApp } from '../src/app.js';
import { hashPassword } from '../src/auth/passwords.js';
import {
    buildMemoryBootstrap, formatMemoryIndex, memoryRootOf, parseMemoryFrontmatter,
    resolveMemoryPath, scanMemoryManifest, toolMemoryDelete, toolMemoryRead, toolMemoryWrite,
} from '../src/agent/memoryStore.js';
import { requiresApproval } from '../src/agent/approvalPolicy.js';
import { normalizeAgentSettings, DEFAULT_AGENT_SETTINGS } from '../contracts/models.js';
import type { ToolSpec } from '../src/agent/toolExec.js';

function sha(content: string): string {
    return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

function memoryFixture(): { root: string; cleanup(): void } {
    const dir = mkdtempSync(join(tmpdir(), 'prism-memory-'));
    const root = memoryRootOf(dir, 'project-1');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return { root, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const memorySpec = (name: string, highImpact = false): ToolSpec => ({ name, description: '', parameters: {}, effect: 'memory', highImpact: () => highImpact });

test('memory store: frontmatter parsing recognizes prescribed fields only', () => {
    const full = parseMemoryFrontmatter(['---', 'name: user-profile', 'description: 用户偏好概览', 'metadata:', '  type: user', '---', '', '正文'].join('\n'));
    assert.deepEqual(full, { name: 'user-profile', description: '用户偏好概览', type: 'user' });
    const aliasType = parseMemoryFrontmatter(['---', 'description: "带引号的描述"', 'type: handoff', '---'].join('\n'));
    assert.deepEqual(aliasType, { description: '带引号的描述', type: 'handoff' });
    const invalid = parseMemoryFrontmatter(['---', 'type: secret', 'name: x', '---'].join('\n'));
    assert.deepEqual(invalid, { name: 'x' });
    assert.deepEqual(parseMemoryFrontmatter('无frontmatter正文'), {});
    assert.deepEqual(parseMemoryFrontmatter(['---', 'name: 没有闭合'].join('\n')), {});
    assert.deepEqual(parseMemoryFrontmatter(['---', 'random: value', '---'].join('\n')), {});
});

test('memory store: index formatting caps content and preserves normal lines', () => {
    const longLine = 'x'.repeat(200);
    const formatted = formatMemoryIndex([longLine, '第二行'].join('\n'));
    assert.equal(formatted.split('\n')[0]!.length, 200); // 正常索引行不截断
    assert.ok(formatted.endsWith('第二行'));
    const many = Array.from({ length: 300 }, (_, i) => `条目${i}`);
    assert.equal(formatMemoryIndex(many.join('\n')).split('\n').filter(line=>line.startsWith('条目')).length, 200);
    const wide = Array.from({ length: 3000 }, (_, i) => 'y'.repeat(80));
    assert.ok(formatMemoryIndex(wide.join('\n')).length <= 25500);
    assert.match(formatMemoryIndex(wide.join('\n')), /记忆索引已截断/);
    assert.equal(formatMemoryIndex(''), '');
});

test('memory store: path pinning rejects escapes and non-markdown targets', () => {
    const { root, cleanup } = memoryFixture();
    try {
        assert.equal(resolveMemoryPath(root, 'user-profile.md').display, 'user-profile.md');
        assert.equal(resolveMemoryPath(root, 'handoff/2026-11-16.md').display, 'handoff/2026-11-16.md');
        assert.equal(resolveMemoryPath(root, 'MEMORY.md').display, 'MEMORY.md');
        for (const bad of ['../escape.md', '/etc/passwd.md', 'a\\b.md', 'notes.txt', 'a//b.md', 'a/./b.md', 'a/../b.md', '', '  ']) {
            assert.throws(() => resolveMemoryPath(root, bad), `应拒绝: ${bad}`);
        }
    } finally { cleanup(); }
});

test('memory store: manifest scan excludes index, reads frontmatter and sorts by mtime', () => {
    const { root, cleanup } = memoryFixture();
    try {
        writeFileSync(join(root, 'MEMORY.md'), '- [旧](a.md) — 索引不进清单\n', { mode: 0o600 });
        writeFileSync(join(root, 'b-latest.md'), ['---', 'description: 最新记忆', 'metadata:', '  type: handoff', '---', '正文'].join('\n'), { mode: 0o600 });
        mkdirSync(join(root, 'sub'), { recursive: true });
        writeFileSync(join(root, 'sub', 'a-older.md'), ['---', 'name: a-older', 'type: project', '---'].join('\n'), { mode: 0o600 });
        writeFileSync(join(root, 'ignored.txt'), '非md不进清单', { mode: 0o600 });
        utimesSync(join(root, 'b-latest.md'), new Date(2000), new Date(2000));
        utimesSync(join(root, 'sub', 'a-older.md'), new Date(1000), new Date(1000));
        const entries = scanMemoryManifest(root);
        assert.equal(entries.length, 2);
        assert.equal(entries[0]!.filename, 'b-latest.md');
        assert.equal(entries[0]!.type, 'handoff');
        assert.equal(entries[1]!.filename, 'sub/a-older.md');
        assert.equal(entries[1]!.description, undefined);
        assert.ok(entries[0]!.mtimeMs >= entries[1]!.mtimeMs);
    } finally { cleanup(); }
});

test('memory store: write/read/delete roundtrip with expected_hash protection', async () => {
    const { root, cleanup } = memoryFixture();
    try {
        const created = await toolMemoryWrite(root, { path: 'user/profile.md', content: '---\nname: profile\n---\n内容v1\n', expectedHash: null });
        assert.equal(created.operation, 'create');
        assert.equal(created.sizeBytes, Buffer.byteLength('---\nname: profile\n---\n内容v1\n', 'utf8'));
        // 新建不应带hash
        await assert.rejects(toolMemoryWrite(root, { path: 'another.md', content: 'x', expectedHash: sha('y') }), /expected_hash/);
        // 已存在且无hash → 拒绝
        await assert.rejects(toolMemoryWrite(root, { path: 'user/profile.md', content: '覆盖', expectedHash: null }), /已被修改/);
        // 错误hash → 拒绝
        await assert.rejects(toolMemoryWrite(root, { path: 'user/profile.md', content: '覆盖', expectedHash: sha('错误') }), /已被修改/);
        const read = await toolMemoryRead(root, { path: 'user/profile.md' });
        assert.equal(read.totalLines, 5); // 尾换行产生末尾空行
        assert.ok(read.content.startsWith('1\t---'));
        assert.equal(read.hash, created.hash);
        // 正确hash → 更新
        const updated = await toolMemoryWrite(root, { path: 'user/profile.md', content: '内容v2\n', expectedHash: read.hash });
        assert.equal(updated.operation, 'modify');
        assert.equal((await toolMemoryRead(root, { path: 'user/profile.md' })).content, '1\t内容v2\n2\t');
        // 删除保护
        await assert.rejects(toolMemoryDelete(root, { path: 'user/profile.md', expectedHash: '' }), /已被修改/);
        await toolMemoryDelete(root, { path: 'user/profile.md', expectedHash: updated.hash });
        await assert.rejects(toolMemoryRead(root, { path: 'user/profile.md' }), /不存在/);
        // 越界拒绝发生在写入前
        await assert.rejects(toolMemoryWrite(root, { path: '../escape.md', content: 'x', expectedHash: null }), /路径/);
        // 超限拒绝
        await assert.rejects(toolMemoryWrite(root, { path: 'big.md', content: '字'.repeat(64 * 1024 + 1), expectedHash: null }), /64KiB/);
    } finally { cleanup(); }
});

test('memory store: bootstrap returns index and manifest, empty library included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-memory-boot-'));
    try {
        const empty = buildMemoryBootstrap(dir, 'p-empty');
        assert.equal(empty.index, null);
        assert.equal(empty.files.length, 0);
        const projectId = 'p-seeded';
        const root = memoryRootOf(dir, projectId);
        mkdirSync(root, { recursive: true, mode: 0o700 });
        writeFileSync(join(root, 'MEMORY.md'), '- [交接](handoff.md) — 当前有效事实\n', { mode: 0o600 });
        writeFileSync(join(root, 'handoff.md'), ['---', 'description: 交接', 'metadata:', '  type: handoff', '---'].join('\n'), { mode: 0o600 });
        const boot = buildMemoryBootstrap(dir, projectId);
        assert.equal(boot.index, '- [交接](handoff.md) — 当前有效事实'); // formatMemoryIndex保留原换行结构
        assert.equal(boot.files.length, 1);
        assert.equal(boot.files[0]!.type, 'handoff');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('approval policy: memory writes stay silent, deletes confirm, full trusts', () => {
    const write = memorySpec('memory_write');
    const del = memorySpec('memory_delete', true);
    assert.equal(requiresApproval('auto', write, {}), false);
    assert.equal(requiresApproval('auto', del, {}), true);
    assert.equal(requiresApproval('ask', write, {}), true);
    assert.equal(requiresApproval('ask', del, {}), true);
    assert.equal(requiresApproval('full', write, {}), false);
    assert.equal(requiresApproval('full', del, {}), false);
});

test('agent settings: memoryEnabled defaults on, persists explicit off, coerces garbage', () => {
    assert.equal(DEFAULT_AGENT_SETTINGS.memoryEnabled, true);
    assert.equal(normalizeAgentSettings({}).memoryEnabled, true);
    assert.equal(normalizeAgentSettings({ memoryEnabled: false }).memoryEnabled, false);
    assert.equal(normalizeAgentSettings({ memoryEnabled: 'yes' as unknown as boolean }).memoryEnabled, true);
});

test('agent settings route: memoryEnabled round-trips and rejects non-boolean', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-memory-route-'));
    const fx = buildProductApp(dir, { serveWeb: false, modelTransport: () => async () => new Response('{}', { status: 500 }) });
    try {
        const pw = await hashPassword('MemoryRoute2026!');
        const ts = new Date().toISOString();
        fx.db.tx(tx => tx.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)').run(randomUUID(), 'memory-route', pw.hash, pw.salt, pw.paramsJson, ts, ts));
        const login = await fx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'memory-route', password: 'MemoryRoute2026!' } });
        assert.equal(login.statusCode, 200);
        const raw = login.headers['set-cookie'];
        const headers = { cookie: (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!, 'x-csrf-token': login.json().data.csrfToken };
        const initial = await fx.app.inject({ url: '/api/v1/agent-settings', headers });
        assert.equal(initial.json().data.memoryEnabled, true);
        const put = await fx.app.inject({ method: 'PUT', url: '/api/v1/agent-settings', headers, payload: { ...initial.json().data, memoryEnabled: false } });
        assert.equal(put.statusCode, 200);
        assert.equal(put.json().data.memoryEnabled, false);
        const bad = await fx.app.inject({ method: 'PUT', url: '/api/v1/agent-settings', headers, payload: { ...initial.json().data, memoryEnabled: 'yes' } });
        assert.equal(bad.statusCode, 400);
        const unknownKey = await fx.app.inject({ method: 'PUT', url: '/api/v1/agent-settings', headers, payload: { ...initial.json().data, memoryPath: '/tmp' } });
        assert.equal(unknownKey.statusCode, 400);
        const reread = await fx.app.inject({ url: '/api/v1/agent-settings', headers });
        assert.equal(reread.json().data.memoryEnabled, false);
    } finally {
        await fx.app.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('memory regression: concurrent old-hash updates accept exactly one writer', async()=>{
 const {root,cleanup}=memoryFixture();try{const first=await toolMemoryWrite(root,{path:'same.md',content:'v1',expectedHash:null});const results=await Promise.allSettled([toolMemoryWrite(root,{path:'same.md',content:'A',expectedHash:first.hash}),toolMemoryWrite(root,{path:'same.md',content:'B',expectedHash:first.hash})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);}finally{cleanup();}
});

test('memory regression: directory/file symlinks cannot escape read/write/delete',async()=>{
 const fs=await import('node:fs');const base=mkdtempSync(join(tmpdir(),'memory-link-fixed-')),root=join(base,'root'),outside=join(base,'outside');fs.mkdirSync(root);fs.mkdirSync(outside);fs.writeFileSync(join(outside,'value.md'),'external');
 try{fs.symlinkSync(outside,join(root,'link'),'dir');fs.symlinkSync(join(outside,'value.md'),join(root,'value.md'));
 for(const path of ['link/new.md','value.md']){await assert.rejects(toolMemoryWrite(root,{path,content:'overwrite',expectedHash:null}));await assert.rejects(toolMemoryRead(root,{path}));await assert.rejects(toolMemoryDelete(root,{path,expectedHash:sha('external')}));}
 assert.equal(fs.readFileSync(join(outside,'value.md'),'utf8'),'external');assert.equal(fs.existsSync(join(outside,'new.md')),false);
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('memory regression: scan sorts before 200-entry cap and preserves complete index links',async()=>{
 const fs=await import('node:fs');const {root,cleanup}=memoryFixture();try{for(let i=0;i<201;i++){const path=join(root,`a${String(i).padStart(3,'0')}.md`);writeFileSync(path,'x');fs.utimesSync(path,new Date(1000),new Date(1000));}writeFileSync(join(root,'zz-newest.md'),'x');const entries=scanMemoryManifest(root);assert.equal(entries.length,200);assert.equal(entries[0]!.filename,'zz-newest.md');const link=`- [交接](${'a'.repeat(95)}.md) — 长路径`;assert.equal(formatMemoryIndex(link),link);}finally{cleanup();}
});


test('memory regression: linked memory parent is rejected before creating a project outside',async()=>{
 const fs=await import('node:fs');const dir=mkdtempSync(join(tmpdir(),'memory-root-link-')),data=join(dir,'data'),outside=join(dir,'outside');fs.mkdirSync(data);fs.mkdirSync(outside);fs.symlinkSync(outside,join(data,'memory'),'dir');
 try{assert.throws(()=>buildMemoryBootstrap(data,'project-1'),/软链接/);assert.equal(fs.existsSync(join(outside,'project-1')),false);}finally{rmSync(dir,{recursive:true,force:true});}
});

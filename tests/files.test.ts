// T03 目录授权与资料验收：伪造票据/nonce拒绝、仅创建者可领取、越界/软链失败、
// 50MiB上限、上传与快照版本化、SSRF拒绝、撤销立即生效、两账号不能借同路径串权。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, truncateSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildProductApp } from '../src/app.js';
import type { ProductApp } from '../src/app.js';
import { hashPassword } from '../src/auth/passwords.js';
import { clearLoginFailures } from '../src/auth/routes.js';
import { setCsrfToken, startProjectDirectoryPicker, v1 } from '../web/api.js';

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');
let counter = 0;

interface Env { app: ProductApp['app']; db: ProductApp['db']; dir: string; dataDir: string }

async function makeApp(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), `t03-${++counter}-`));
  const dataDir = join(dir, 'data');
  const fx = buildProductApp(dataDir, { serveWeb: false });
  return { app: fx.app, db: fx.db, dir, dataDir };
}

interface Session { cookie: string; csrf: string }

async function loginAs(env: Env, username: string, password: string): Promise<Session> {
  const res = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
  assert.equal(res.statusCode, 200);
  const raw = res.headers['set-cookie'];
  const line = Array.isArray(raw) ? String(raw[0]) : String(raw);
  return { cookie: line.split(';')[0]!, csrf: (res.json().data as { csrfToken: string }).csrfToken };
}

async function makeUser(env: Env, username: string, password: string): Promise<string> {
  const record = await hashPassword(password);
  const id = randomUUID();
  const now = new Date().toISOString();
  env.db.tx(tx => tx.prepare(
    'INSERT INTO users(id, username, password_hash, password_salt, password_params_json, disabled, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)'
  ).run(id, username, record.hash, record.salt, record.paramsJson, now, now));
  return id;
}

/** 直接登记selected票据（不经osascript），模拟本机已选目录。 */
function seedSelectedTicket(env: Env, userId: string, projectId: string, chosenPath: string): { ticketId: string; nonce: string } {
  const ticketId = randomUUID();
  const nonce = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const ts = new Date().toISOString();
  env.db.tx(tx => tx.prepare(
    "INSERT INTO picker_tickets(id, user_id, project_id, nonce_hash, state, expires_at, created_at, updated_at) VALUES (?,?,?,?,'pending',?,?,?)"
  ).run(ticketId, userId, projectId, sha256(nonce), new Date(Date.now() + 600_000).toISOString(), ts, ts));
  // 生产流程由osascript回调写入selected_path；测试用同一内部出口注入
  void chosenPath;
  return { ticketId, nonce };
}

function makeAuthedHeaders(s: Session): Record<string, string> {
  return { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' };
}

test('T03 主流程：selected票据→仅创建者可领取→授权内列表/快照/下载→撤销立即生效', async () => {
  const env = await makeApp();
  try {
    const userA = await makeUser(env, 'files-a', 'password-123');
    await makeUser(env, 'files-b', 'password-456');
    const sa = await loginAs(env, 'files-a', 'password-123');
    const sb = await loginAs(env, 'files-b', 'password-456');

    // 真实工作目录
    const workspace = join(env.dir, 'workspace');
    mkdirSync(join(workspace, 'sub'), { recursive: true });
    writeFileSync(join(workspace, '报告.md'), '# 演示报告\n正文一段。');
    writeFileSync(join(workspace, 'sub', '数据.csv'), 'a,b\n1,2\n');

    const createProject = await env.app.inject({ method: 'POST', url: '/api/v1/projects', headers: makeAuthedHeaders(sa), payload: { name: '文件项目' } });
    const projectId = (createProject.json().data as { id: string }).id;

    // —— B读A的票据：404；伪造票据：404 ——
    const forged = await env.app.inject({ method: 'GET', url: `/api/v1/directory-pickers/${randomUUID()}`, headers: { cookie: sa.cookie } });
    assert.equal(forged.statusCode, 404);

    // —— 以selected票据走完整claim（票据选择由测试出口注入路径，与osascript回调同一入口） ——
    const seeded = seedSelectedTicket(env, userA, projectId, workspace);
    const { markTicketSelectedForTest } = await import('../src/files/picker.js');
    markTicketSelectedForTest(env.db, seeded.ticketId, workspace);

    // B尝试用A的票据领取（自己项目也不行——票据user_id不符）
    const bProject = await env.app.inject({ method: 'POST', url: '/api/v1/projects', headers: makeAuthedHeaders(sb), payload: { name: 'B项目' } });
    const bProjectId = (bProject.json().data as { id: string }).id;
    const bClaim = await env.app.inject({ method: 'POST', url: `/api/v1/projects/${bProjectId}/grants`, headers: makeAuthedHeaders(sb), payload: { pickerTicket: seeded.ticketId, nonce: seeded.nonce, access: 'read' } });
    assert.equal(bClaim.statusCode, 404, '他人票据不可领取');

    // 错误nonce：404
    const badNonce = await env.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/grants`, headers: makeAuthedHeaders(sa), payload: { pickerTicket: seeded.ticketId, nonce: 'f'.repeat(64), access: 'read' } });
    assert.equal(badNonce.statusCode, 404);

    // 创建者正确领取 → 201，脱敏视图不回显绝对路径
    const claim = await env.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/grants`, headers: makeAuthedHeaders(sa), payload: { pickerTicket: seeded.ticketId, nonce: seeded.nonce, access: 'read' } });
    assert.equal(claim.statusCode, 201);
    const grant = claim.json().data as { id: string; displayName: string };
    assert.equal(grant.displayName, 'workspace');
    assert.equal(JSON.stringify(claim.json()).includes(workspace), false, '响应不得包含绝对路径');

    // 重复领取：票据已claimed → 404
    const reclaim = await env.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/grants`, headers: makeAuthedHeaders(sa), payload: { pickerTicket: seeded.ticketId, nonce: seeded.nonce, access: 'read' } });
    assert.equal(reclaim.statusCode, 404);

    // —— 授权内列表/快照 ——
    const list = await env.app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/files?grantId=${grant.id}`, headers: { cookie: sa.cookie } });
    assert.equal(list.statusCode, 200);
    const names = (list.json().data as { entries: Array<{ name: string; type: string }> }).entries.map(e => e.name);
    assert.deepEqual(names, ['sub', '报告.md']);

    const snapshot = await env.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/file-snapshots`, headers: makeAuthedHeaders(sa), payload: { grantId: grant.id, relativePath: '报告.md' } });
    assert.equal(snapshot.statusCode, 201);
    const snap = snapshot.json().data as { resourceId: string; version: number; contentHash: string; sizeBytes: number };
    assert.equal(snap.contentHash, createHash('sha256').update(readFileSync(join(workspace, '报告.md'))).digest('hex'));

    // 下载字节一致
    const download = await env.app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/resources/${snap.resourceId}/versions/${snap.version}?view=download`, headers: { cookie: sa.cookie } });
    assert.equal(download.statusCode, 200);
    assert.equal(createHash('sha256').update(download.rawPayload).digest('hex'), snap.contentHash);

    // metadata视图
    const meta = await env.app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/resources/${snap.resourceId}/versions/${snap.version}`, headers: { cookie: sa.cookie } });
    assert.equal(meta.statusCode, 200);
    assert.equal((meta.json().data as { kind: string }).kind, 'local');

    // —— 越界/软链/伪造路径 ——
    const traversal = await env.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/file-snapshots`, headers: makeAuthedHeaders(sa), payload: { grantId: grant.id, relativePath: '../../../etc/passwd' } });
    assert.equal(traversal.statusCode, 404);
    const absolute = await env.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/file-snapshots`, headers: makeAuthedHeaders(sa), payload: { grantId: grant.id, relativePath: '/etc/passwd' } });
    assert.equal(absolute.statusCode, 404);
    const outside = join(env.dir, 'outside.txt');
    writeFileSync(outside, 'secret');
    const escapeLink = join(workspace, 'leak');
    symlinkSync(outside, escapeLink);
    const symlinkSnap = await env.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/file-snapshots`, headers: makeAuthedHeaders(sa), payload: { grantId: grant.id, relativePath: 'leak' } });
    assert.equal(symlinkSnap.statusCode, 404, '软链必须失败');
    // 软链目录不列出
    const listAfter = await env.app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/files?grantId=${grant.id}`, headers: { cookie: sa.cookie } });
    assert.equal((listAfter.json().data as { entries: Array<{ name: string }> }).entries.some(e => e.name === 'leak'), false);

    // —— B不能借A的grantId串权 ——
    const bFiles = await env.app.inject({ method: 'GET', url: `/api/v1/projects/${bProjectId}/files?grantId=${grant.id}`, headers: { cookie: sb.cookie } });
    assert.equal(bFiles.statusCode, 404, 'B用自己的项目+A的grantId必须404');
    const bListA = await env.app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/grants`, headers: { cookie: sb.cookie } });
    assert.equal(bListA.statusCode, 404, 'B列A项目grants必须404');

    // —— 撤销立即生效；已产生的资源不回滚 ——
    const revoke = await env.app.inject({ method: 'DELETE', url: `/api/v1/projects/${projectId}/grants/${grant.id}`, headers: { cookie: sa.cookie, 'x-csrf-token': sa.csrf } });
    assert.equal(revoke.statusCode, 200);
    const afterRevoke = await env.app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/files?grantId=${grant.id}`, headers: { cookie: sa.cookie } });
    assert.equal(afterRevoke.statusCode, 404);
    const snapAfterRevoke = await env.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/file-snapshots`, headers: makeAuthedHeaders(sa), payload: { grantId: grant.id, relativePath: '报告.md' } });
    assert.equal(snapAfterRevoke.statusCode, 404);
    const stillDownload = await env.app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/resources/${snap.resourceId}/versions/${snap.version}?view=download`, headers: { cookie: sa.cookie } });
    assert.equal(stillDownload.statusCode, 200, '已登记资源不受撤销回滚');
  } finally {
    clearLoginFailures();
    await env.app.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('T03 上传与SSRF：multipart登记版本化；本地/内网/非http拒绝', async () => {
  const env = await makeApp();
  try {
    await makeUser(env, 'upload-u', 'password-123');
    const s = await loginAs(env, 'upload-u', 'password-123');
    const project = await env.app.inject({ method: 'POST', url: '/api/v1/projects', headers: makeAuthedHeaders(s), payload: { name: '上传项目' } });
    const projectId = (project.json().data as { id: string }).id;

    const boundary = 't03boundary';
    const content = '列A,列B\n1,2\n';
    const body = Buffer.from([
      `--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="表.csv"', 'Content-Type: text/csv', '', content, `--${boundary}--`, '',
    ].join('\r\n'));
    const upload = await env.app.inject({
      method: 'POST', url: `/api/v1/projects/${projectId}/uploads`,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    assert.equal(upload.statusCode, 201);
    const up = upload.json().data as { resourceId: string; version: number; contentHash: string };
    assert.equal(up.contentHash, createHash('sha256').update(content).digest('hex'));

    // 资源列表可见；版本预览为文本
    const resources = await env.app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/resources`, headers: { cookie: s.cookie } });
    assert.equal((resources.json().data as { displayName: string }[])[0]!.displayName, '表.csv');

    // —— SSRF与协议拒绝（不发起真实外网请求） ——
    for (const [url, expectCode] of [
      ['http://127.0.0.1/x', 403], ['http://192.168.1.10/x', 403], ['http://10.0.0.5/x', 403],
      ['http://[::1]/x', 403], ['http://169.254.169.254/latest/meta-data', 403], ['ftp://example.com/x', 400],
    ] as Array<[string, number]>) {
      const denied = await env.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/web-resources`, headers: makeAuthedHeaders(s), payload: { url } });
      assert.equal(denied.statusCode, expectCode, `${url} → ${expectCode}`);
    }
  } finally {
    clearLoginFailures();
    await env.app.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('T03 上传超限：>50MiB流式拒绝413，不落盘不登记', async () => {
  const env = await makeApp();
  try {
    await makeUser(env, 'big-u', 'password-123');
    const s = await loginAs(env, 'big-u', 'password-123');
    const project = await env.app.inject({ method: 'POST', url: '/api/v1/projects', headers: makeAuthedHeaders(s), payload: { name: '大文件项目' } });
    const projectId = (project.json().data as { id: string }).id;

    const boundary = 't03big';
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const big = Buffer.alloc(50 * 1024 * 1024 + 1); // 50MiB+1
    const body = Buffer.concat([head, big, tail]);
    const upload = await env.app.inject({
      method: 'POST', url: `/api/v1/projects/${projectId}/uploads`,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    assert.equal(upload.statusCode, 413);
    const resources = await env.app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/resources`, headers: { cookie: s.cookie } });
    assert.equal((resources.json().data as unknown[]).length, 0, '超限不得登记');
  } finally {
    clearLoginFailures();
    await env.app.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('T03 快照超限：授权内>50MiB文件stat即拒413；原文件缺失返回ARTIFACT_MISSING', async () => {
  const env = await makeApp();
  try {
    const user = await makeUser(env, 'snap-u', 'password-123');
    const s = await loginAs(env, 'snap-u', 'password-123');
    const project = await env.app.inject({ method: 'POST', url: '/api/v1/projects', headers: makeAuthedHeaders(s), payload: { name: '快照项目' } });
    const projectId = (project.json().data as { id: string }).id;

    const workspace = join(env.dir, 'ws');
    mkdirSync(workspace, { recursive: true });
    const bigPath = join(workspace, 'big.bin');
    writeFileSync(bigPath, Buffer.alloc(1));
    truncateSync(bigPath, 50 * 1024 * 1024 + 1); // 稀疏文件，不实际占用

    const seeded = seedSelectedTicket(env, user, projectId, workspace);
    const { markTicketSelectedForTest } = await import('../src/files/picker.js');
    markTicketSelectedForTest(env.db, seeded.ticketId, workspace);
    const claim = await env.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/grants`, headers: makeAuthedHeaders(s), payload: { pickerTicket: seeded.ticketId, nonce: seeded.nonce, access: 'read' } });
    const grant = claim.json().data as { id: string };

    const denied = await env.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/file-snapshots`, headers: makeAuthedHeaders(s), payload: { grantId: grant.id, relativePath: 'big.bin' } });
    assert.equal(denied.statusCode, 413);

    // 正常快照后删除存储文件 → ARTIFACT_MISSING
    const small = join(workspace, 'ok.txt');
    writeFileSync(small, 'ok');
    const snap = await env.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/file-snapshots`, headers: makeAuthedHeaders(s), payload: { grantId: grant.id, relativePath: 'ok.txt' } });
    assert.equal(snap.statusCode, 201);
    const meta = (snap.json().data as { resourceId: string; version: number });
    const row = env.db.db.prepare('SELECT stored_path FROM resource_versions WHERE resource_id = ?').get(meta.resourceId) as { stored_path: string };
    rmSync(row.stored_path, { force: true });
    const missing = await env.app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/resources/${meta.resourceId}/versions/${meta.version}?view=download`, headers: { cookie: s.cookie } });
    assert.equal(missing.statusCode, 404);
    assert.equal((missing.json().error as { code: string }).code, 'ARTIFACT_MISSING');
  } finally {
    clearLoginFailures();
    await env.app.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

function localSelection(env:Env,uid:string,path:string,options:{state?:string;expiresAt?:string}={}) {
  const id=randomUUID(),nonce=randomUUID(),now=new Date().toISOString();
  env.db.db.prepare('INSERT INTO project_directory_pickers(id,user_id,nonce_hash,state,selected_path,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id,uid,sha256(nonce),options.state||'selected',path,options.expiresAt||new Date(Date.now()+600000).toISOString(),now,now);
  return {pickerTicket:id,nonce,access:'write' as 'read'|'write'};
}

test('创建项目页面的真实客户端请求能打开目录选择并绑定，旧空请求在宿主调用前被拒绝', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'picker-client-'));
  let calls = 0;
  const fx = buildProductApp(join(dir, 'data'), { serveWeb: false, directoryChooser: {
    assertAvailable() {}, close() {},
    async choose() { calls++; return { state: 'selected', path: dir }; },
  } });
  const e = { ...fx, dir, dataDir: join(dir, 'data') };
  t.after(async () => { setCsrfToken(null); await fx.app.close(); rmSync(dir, { recursive: true, force: true }); clearLoginFailures(); });
  await makeUser(e, 'picker-client', 'password-123');
  const session = await loginAs(e, 'picker-client', 'password-123');
  setCsrfToken(session.csrf);
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const response = await fx.app.inject({ method: 'POST', url: String(url), headers: { ...headers, cookie: session.cookie }, ...(init?.body ? { payload: String(init.body) } : {}) });
    return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
  });
  await assert.rejects(v1('/api/v1/project-directory-pickers', { method: 'POST' }), /请求参数不合法/);
  assert.equal(calls, 0);
  const ticket = await startProjectDirectoryPicker();
  assert.equal(calls, 1);
  const selected = await fx.app.inject({ url: `/api/v1/project-directory-pickers/${ticket.id}`, headers: { cookie: session.cookie } });
  assert.equal(selected.json().data.state, 'selected');
  const created = await fx.app.inject({ method: 'POST', url: '/api/v1/projects/local', headers: makeAuthedHeaders(session), payload: { name: '客户端选择项目', folder: { pickerTicket: ticket.id, nonce: ticket.nonce, access: 'write' } } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().data.grant.access, 'write');
});

test('本地项目：选择目录后原子创建并绑定；伪造/跨账号拒绝；创建重试不重复',async()=>{
 const e=await makeApp();try{
  const uid=await makeUser(e,'local-a','password-123');await makeUser(e,'local-b','password-456');
  const a=await loginAs(e,'local-a','password-123'),b=await loginAs(e,'local-b','password-456');
  const root=join(e.dir,'selected-folder');mkdirSync(root);writeFileSync(join(root,'hello.txt'),'hello');
  const folder=localSelection(e,uid,root);
  const create=(session:Session,payload:unknown)=>e.app.inject({method:'POST',url:'/api/v1/projects/local',headers:makeAuthedHeaders(session),payload:payload as object});
  assert.equal((await create(a,{name:'不能空建'})).statusCode,400);
  assert.equal((await create(b,{name:'冒领',folder})).statusCode,400);
  assert.equal((await create(a,{name:'伪造',folder:{...folder,nonce:'wrong'}})).statusCode,400);
  const res=await create(a,{name:'本地项目',folder});assert.equal(res.statusCode,201,res.body);
  const p=res.json().data;assert.equal(p.grant.access,'write');assert.equal(p.grant.displayName,'selected-folder');assert.ok(!res.body.includes(e.dir));
  assert.equal((await create(a,{name:'本地项目',folder})).json().data.id,p.id);
  assert.equal((e.db.db.prepare('SELECT COUNT(*) n FROM projects').get() as {n:number}).n,1);
  assert.equal((e.db.db.prepare('SELECT COUNT(*) n FROM workspace_grants').get() as {n:number}).n,1);
  const list=await e.app.inject({url:`/api/v1/projects/${p.id}/files?grantId=${p.grant.id}`,headers:{cookie:a.cookie}});
  assert.equal(list.statusCode,200);assert.ok(list.body.includes('hello.txt'));
  const again=localSelection(e,uid,root);assert.equal((await create(a,{name:'重复目录',folder:again})).statusCode,409);
  assert.equal((e.db.db.prepare('SELECT COUNT(*) n FROM projects').get() as {n:number}).n,1);
 }finally{await e.app.close();rmSync(e.dir,{recursive:true,force:true});clearLoginFailures();}
});

test('本地项目：取消和过期不生成空项目，路径不回显，取消需属主与CSRF',async()=>{
 const e=await makeApp();try{
  const uid=await makeUser(e,'cancel-a','password-123');await makeUser(e,'cancel-b','password-456');
  const a=await loginAs(e,'cancel-a','password-123'),b=await loginAs(e,'cancel-b','password-456');
  const folder=localSelection(e,uid,e.dir);const url=`/api/v1/project-directory-pickers/${folder.pickerTicket}`;
  assert.equal((await e.app.inject({url,headers:{cookie:b.cookie}})).statusCode,404);
  const selected=await e.app.inject({url,headers:{cookie:a.cookie}});assert.equal(selected.json().data.state,'selected');assert.ok(!selected.body.includes(e.dir));
  assert.equal((await e.app.inject({method:'DELETE',url,headers:{cookie:a.cookie},payload:{nonce:folder.nonce}})).statusCode,403);
  assert.equal((await e.app.inject({method:'DELETE',url,headers:makeAuthedHeaders(a),payload:{nonce:folder.nonce}})).statusCode,200);
  assert.equal((await e.app.inject({method:'POST',url:'/api/v1/projects/local',headers:makeAuthedHeaders(a),payload:{name:'取消',folder}})).statusCode,400);
  const expired=localSelection(e,uid,e.dir,{expiresAt:'2020-01-01T00:00:00Z'});
  assert.equal((await e.app.inject({method:'POST',url:'/api/v1/projects/local',headers:makeAuthedHeaders(a),payload:{name:'过期',folder:expired}})).statusCode,400);
  assert.equal((e.db.db.prepare('SELECT COUNT(*) n FROM projects').get() as {n:number}).n,0);
  assert.equal((e.db.db.prepare('SELECT selected_path FROM project_directory_pickers WHERE id=?').get(expired.pickerTicket) as {selected_path:null}).selected_path,null);
 }finally{await e.app.close();rmSync(e.dir,{recursive:true,force:true});clearLoginFailures();}
});

test('本地项目：授权写入失败时项目和票据领取一起回滚，重试可以成功',async()=>{
 const e=await makeApp();try{
  const uid=await makeUser(e,'rollback','password-123'),a=await loginAs(e,'rollback','password-123');
  const folder=localSelection(e,uid,e.dir);folder.access='read';
  e.db.db.exec("CREATE TRIGGER reject_grant BEFORE INSERT ON workspace_grants BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  const create=()=>e.app.inject({method:'POST',url:'/api/v1/projects/local',headers:makeAuthedHeaders(a),payload:{name:'回滚',folder}});
  assert.equal((await create()).statusCode,500);
  assert.equal((e.db.db.prepare('SELECT COUNT(*) n FROM projects').get() as {n:number}).n,0);
  assert.equal((e.db.db.prepare('SELECT state FROM project_directory_pickers WHERE id=?').get(folder.pickerTicket) as {state:string}).state,'selected');
  e.db.db.exec('DROP TRIGGER reject_grant');const res=await create();assert.equal(res.statusCode,201);assert.equal(res.json().data.grant.access,'read');
 }finally{await e.app.close();rmSync(e.dir,{recursive:true,force:true});clearLoginFailures();}
});

test('本地项目：多文件夹创建以首个为主要且重复路径折叠；设为主要与撤销提升',async()=>{
 const e=await makeApp();try{
  const uid=await makeUser(e,'multi-a','password-123');await makeUser(e,'multi-b','password-456');
  const a=await loginAs(e,'multi-a','password-123'),b=await loginAs(e,'multi-b','password-456');
  const primaryDir=join(e.dir,'primary-dir'),secondaryDir=join(e.dir,'second-dir');
  mkdirSync(primaryDir);mkdirSync(secondaryDir);
  const f1=localSelection(e,uid,primaryDir),dup=localSelection(e,uid,primaryDir),f2=localSelection(e,uid,secondaryDir);
  const create=(payload:object)=>e.app.inject({method:'POST',url:'/api/v1/projects/local',headers:makeAuthedHeaders(a),payload});
  const res=await create({name:'多目录项目',folders:[f1,dup,f2]});assert.equal(res.statusCode,201,res.body);
  const p=res.json().data;
  assert.equal(p.grant.isPrimary,true);assert.equal(p.grant.displayName,'primary-dir');
  assert.equal(p.grants.length,2,'同请求重复路径折叠为一个授权');
  assert.deepEqual(p.grants.map((g:{isPrimary:boolean})=>g.isPrimary),[true,false]);
  const baseUrl=`/api/v1/projects/${p.id}`;
  const listGrants=async()=>(await e.app.inject({url:`${baseUrl}/grants`,headers:{cookie:a.cookie}})).json().data as Array<{id:string;isPrimary:boolean;revoked:boolean;displayName:string}>;
  const grants=await listGrants();
  const secondary=grants.find(g=>!g.isPrimary);
  assert.ok(secondary,'应存在次要授权');
  // 归属不符同形404（b持合法CSRF但非项目主）；属主缺CSRF 403
  assert.equal((await e.app.inject({method:'POST',url:`${baseUrl}/grants/${secondary!.id}/primary`,headers:makeAuthedHeaders(b),payload:{}})).statusCode,404);
  assert.equal((await e.app.inject({method:'POST',url:`${baseUrl}/grants/${secondary!.id}/primary`,headers:{cookie:a.cookie}})).statusCode,403);
  // 设为主要：事务内清掉其他主要标记
  const promoted=await e.app.inject({method:'POST',url:`${baseUrl}/grants/${secondary!.id}/primary`,headers:makeAuthedHeaders(a),payload:{}});
  assert.equal(promoted.statusCode,200,promoted.body);
  assert.equal(promoted.json().data.isPrimary,true);
  assert.deepEqual((await listGrants()).map(g=>`${g.isPrimary?'P':'S'}:${g.displayName}`),['P:second-dir','S:primary-dir'],'主要置顶，次要按创建顺序');
  // 撤销当前主要→最早剩余授权提升为主要
  assert.equal((await e.app.inject({method:'DELETE',url:`${baseUrl}/grants/${secondary!.id}`,headers:makeAuthedHeaders(a),payload:{}})).statusCode,200);
  const remaining=(await listGrants()).filter(g=>!g.revoked);
  assert.equal(remaining.length,1);
  assert.equal(remaining[0]?.isPrimary,true,'剩余最早授权自动提升为主要');
 }finally{await e.app.close();rmSync(e.dir,{recursive:true,force:true});clearLoginFailures();}
});

function sidebarConversation(e:Env,projectId:string,title:string){
 const id=randomUUID(),pv=randomUUID(),runId=randomUUID(),now=new Date().toISOString();
 e.db.db.prepare("INSERT INTO conversations(id,project_id,mode,title,created_at,updated_at) VALUES (?,?,'ordinary',?,?,?)").run(id,projectId,title,now,now);
 e.db.db.prepare('INSERT INTO problem_versions(id,conversation_id,version,objective,created_at,updated_at) VALUES (?,?,1,?,?,?)').run(pv,id,title,now,now);
 e.db.db.prepare("INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,config_snapshot_json,created_at,updated_at) VALUES (?,?,?,?,'ordinary','succeeded','{}',?,?)").run(runId,projectId,id,pv,now,now);
 return {id,runId,pv};
}

test('侧栏：置顶/改名/分组/归档恢复持久化，跨账号与CSRF拒绝，归档保留历史',async()=>{
 const e=await makeApp();try{
  await makeUser(e,'sidebar-a','password-123');await makeUser(e,'sidebar-b','password-456');
  const a=await loginAs(e,'sidebar-a','password-123'),b=await loginAs(e,'sidebar-b','password-456');
  const project=(await e.app.inject({method:'POST',url:'/api/v1/projects',headers:makeAuthedHeaders(a),payload:{name:'侧栏项目'}})).json().data;
  const t=sidebarConversation(e,project.id,'原任务');
  const group=(await e.app.inject({method:'POST',url:'/api/v1/sidebar-groups',headers:makeAuthedHeaders(a),payload:{name:'研究'}})).json().data;
  const url=`/api/v1/conversations/${t.id}`;
  assert.equal((await e.app.inject({method:'PATCH',url,headers:makeAuthedHeaders(b),payload:{pinned:true}})).statusCode,404);
  assert.equal((await e.app.inject({method:'PATCH',url,headers:{cookie:a.cookie},payload:{pinned:true}})).statusCode,403);
  const patch=(payload:object)=>e.app.inject({method:'PATCH',url,headers:makeAuthedHeaders(a),payload});
  assert.equal((await patch({title:'改名任务',pinned:true,unread:true,groupId:group.id,archived:true})).statusCode,200);
  let tree=(await e.app.inject({url:'/api/v1/sidebar',headers:{cookie:a.cookie}})).json().data;
  assert.equal(tree.tasks[0].title,'改名任务');assert.ok(tree.tasks[0].pinnedAt&&tree.tasks[0].archivedAt&&tree.tasks[0].unreadAt);assert.equal(tree.tasks[0].groupId,group.id);
  assert.equal((await e.app.inject({url:'/api/v1/sidebar',headers:{cookie:b.cookie}})).json().data.tasks.length,0);
  assert.equal((await patch({archived:false,pinned:false,unread:false})).statusCode,200);
  await e.app.inject({method:'DELETE',url:`/api/v1/sidebar-groups/${group.id}`,headers:makeAuthedHeaders(a),payload:{}});
  tree=(await e.app.inject({url:'/api/v1/sidebar',headers:{cookie:a.cookie}})).json().data;
  assert.equal(tree.tasks.length,1);assert.equal(tree.tasks[0].groupId,null);assert.equal(tree.tasks[0].archivedAt,null);assert.equal(tree.tasks[0].pinnedAt,null);
  assert.equal((e.db.db.prepare('SELECT COUNT(*) n FROM runs').get() as {n:number}).n,1);
  e.db.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(t.runId);
  assert.equal((await patch({archived:true})).statusCode,429);
  assert.equal((await e.app.inject({method:'PATCH',url:`/api/v1/projects/${project.id}`,headers:makeAuthedHeaders(a),payload:{archived:true}})).statusCode,429);
  e.db.db.prepare("UPDATE runs SET status='succeeded' WHERE id=?").run(t.runId);
  await e.app.inject({method:'PATCH',url:`/api/v1/projects/${project.id}`,headers:makeAuthedHeaders(a),payload:{pinned:true,archived:true}});
  await e.app.close();const again=buildProductApp(e.dataDir,{serveWeb:false});e.app=again.app;e.db=again.db;
  const persisted=(await e.app.inject({url:'/api/v1/sidebar',headers:{cookie:a.cookie}})).json().data;
  assert.ok(persisted.projects[0].pinnedAt&&persisted.projects[0].archivedAt);assert.equal(persisted.tasks.length,1);
 }finally{await e.app.close();rmSync(e.dir,{recursive:true,force:true});clearLoginFailures();}
});

test('侧栏按会话聚合最新Run，历史多轮不挤掉其他项目的会话；排序拒绝他人项目',async()=>{
 const e=await makeApp();try{
  await makeUser(e,'tree-a','password-123');await makeUser(e,'tree-b','password-456');
  const a=await loginAs(e,'tree-a','password-123'),b=await loginAs(e,'tree-b','password-456');
  const create=(s:Session,name:string)=>e.app.inject({method:'POST',url:'/api/v1/projects',headers:makeAuthedHeaders(s),payload:{name}});
  const p=(await create(a,'项目A')).json().data,q=(await create(a,'项目B')).json().data,other=(await create(b,'私有项目')).json().data;
  const first=sidebarConversation(e,p.id,'长会话');sidebarConversation(e,q.id,'其他项目会话');
  for(let i=0;i<60;i++){const at=new Date(Date.now()+i*1000).toISOString();e.db.db.prepare("INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,config_snapshot_json,created_at,updated_at) VALUES (?,?,?,?,'ordinary','succeeded','{}',?,?)").run(randomUUID(),p.id,first.id,first.pv,at,at);}
  const tree=(await e.app.inject({url:'/api/v1/sidebar',headers:{cookie:a.cookie}})).json().data;assert.equal(tree.tasks.length,2);assert.equal(tree.projects.length,2);
  assert.equal((await e.app.inject({method:'PATCH',url:'/api/v1/sidebar/project-order',headers:makeAuthedHeaders(a),payload:{projectIds:[other.id,p.id]}})).statusCode,404);
  assert.equal((await e.app.inject({method:'PATCH',url:'/api/v1/sidebar/project-order',headers:makeAuthedHeaders(a),payload:{projectIds:[q.id,p.id]}})).statusCode,200);
  const ordered=(await e.app.inject({url:'/api/v1/sidebar',headers:{cookie:a.cookie}})).json().data;assert.deepEqual(ordered.projects.map((p:{id:string})=>p.id),[q.id,p.id]);
 }finally{await e.app.close();rmSync(e.dir,{recursive:true,force:true});clearLoginFailures();}
});

test('归档管理删除：仅属主+CSRF+明确确认+已归档终态可删除；其他项目和原始文件保留',async()=>{
 const e=await makeApp();try{
  await makeUser(e,'archives-a','password-123');await makeUser(e,'archives-b','password-456');
  const a=await loginAs(e,'archives-a','password-123'),b=await loginAs(e,'archives-b','password-456');
  const p=(await e.app.inject({method:'POST',url:'/api/v1/projects',headers:makeAuthedHeaders(a),payload:{name:'归档项目'}})).json().data;
  const t=sidebarConversation(e,p.id,'待删除'),keep=sidebarConversation(e,p.id,'保留任务'),url=`/api/v1/conversations/${t.id}`;
  const del=(s:Session,confirmed=true)=>e.app.inject({method:'DELETE',url,headers:makeAuthedHeaders(s),payload:{confirmed}});
  assert.equal((await del(a,false)).statusCode,400);
  assert.equal((await del(b)).statusCode,404);
  assert.equal((await del(a)).statusCode,409,'未归档不能删除');
  e.db.db.prepare('UPDATE conversations SET archived_at=? WHERE id=?').run(new Date().toISOString(),t.id);
  assert.equal((await e.app.inject({method:'DELETE',url,headers:{cookie:a.cookie},payload:{confirmed:true}})).statusCode,403);
  e.db.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(t.runId);assert.equal((await del(a)).statusCode,409);
  e.db.db.prepare("UPDATE runs SET status='succeeded' WHERE id=?").run(t.runId);
  assert.equal((await del(a)).statusCode,200);
  assert.ok(e.db.db.prepare('SELECT id FROM conversations WHERE id=?').get(keep.id));
  assert.ok(e.db.db.prepare('SELECT id FROM projects WHERE id=?').get(p.id));
  assert.equal(e.db.db.prepare('SELECT id FROM conversations WHERE id=?').get(t.id),undefined);
 }finally{await e.app.close();rmSync(e.dir,{recursive:true,force:true});clearLoginFailures();}
});

test('历史消息默认显示最新200条，并可向前分页，不遗漏长会话最后的答复',async()=>{
 const e=await makeApp();try{
  await makeUser(e,'message-pages','password-123');const a=await loginAs(e,'message-pages','password-123');
  const p=(await e.app.inject({method:'POST',url:'/api/v1/projects',headers:makeAuthedHeaders(a),payload:{name:'长会话'}})).json().data;
  const t=sidebarConversation(e,p.id,'长会话'),now=new Date().toISOString();
  for(let i=1;i<=450;i++)e.db.db.prepare("INSERT INTO messages(id,conversation_id,run_id,author_type,role_id,seq,visibility,state,content_json,created_at,updated_at) VALUES (?,?,?,'user','ordinary',?,'public','published',?,?,?)").run(randomUUID(),t.id,t.runId,i,JSON.stringify({text:`message-${i}`}),now,now);
  const get=(query:string)=>e.app.inject({url:`/api/v1/runs/${t.runId}/messages?${query}`,headers:{cookie:a.cookie}});
  const latest=(await get('limit=200')).json().data;assert.equal(latest.messages[0].seq,251);assert.equal(latest.messages.at(-1).seq,450);assert.equal(latest.hasOlder,true);
  const older=(await get('limit=200&before=251')).json().data;assert.equal(older.messages[0].seq,51);assert.equal(older.messages.at(-1).seq,250);assert.equal(older.hasOlder,true);
  const first=(await get('limit=200&before=51')).json().data;assert.equal(first.messages[0].seq,1);assert.equal(first.messages.at(-1).seq,50);assert.equal(first.hasOlder,false);
  assert.equal((await get('limit=200&after=440')).json().data.messages.length,10);
  assert.equal((await get('before=20&after=10')).statusCode,400);
 }finally{await e.app.close();rmSync(e.dir,{recursive:true,force:true});clearLoginFailures();}
});

test('授权模式按项目持久化，非法值/跨账号/无CSRF均拒绝',async()=>{
 const e=await makeApp();try{
  await makeUser(e,'permission-a','password-123');await makeUser(e,'permission-b','password-456');const a=await loginAs(e,'permission-a','password-123'),b=await loginAs(e,'permission-b','password-456');
  const p=(await e.app.inject({method:'POST',url:'/api/v1/projects',headers:makeAuthedHeaders(a),payload:{name:'授权项目'}})).json().data;
  assert.equal(p.approvalMode,'auto');const url=`/api/v1/projects/${p.id}`;
  assert.equal((await e.app.inject({method:'PATCH',url,headers:makeAuthedHeaders(b),payload:{approvalMode:'full'}})).statusCode,404);
  assert.equal((await e.app.inject({method:'PATCH',url,headers:{cookie:a.cookie},payload:{approvalMode:'full'}})).statusCode,403);
  assert.equal((await e.app.inject({method:'PATCH',url,headers:makeAuthedHeaders(a),payload:{approvalMode:'invalid'}})).statusCode,400);
  for(const mode of ['ask','auto','full']){assert.equal((await e.app.inject({method:'PATCH',url,headers:makeAuthedHeaders(a),payload:{approvalMode:mode}})).statusCode,200);assert.equal((await e.app.inject({url,headers:{cookie:a.cookie}})).json().data.approvalMode,mode);}
  await e.app.close();const again=buildProductApp(e.dataDir,{serveWeb:false});e.app=again.app;e.db=again.db;
  assert.equal((await e.app.inject({url:'/api/v1/sidebar',headers:{cookie:a.cookie}})).json().data.projects[0].approvalMode,'full');
 }finally{await e.app.close();rmSync(e.dir,{recursive:true,force:true});clearLoginFailures();}
});

test('directory HTTP refuses client absolute paths and cross-owner picker/claim requests', async () => {
  const e = await makeApp();
  try {
    const uid = await makeUser(e, 'picker-owner', 'password-123');
    await makeUser(e, 'picker-other', 'password-456');
    const owner = await loginAs(e, 'picker-owner', 'password-123'), other = await loginAs(e, 'picker-other', 'password-456');
    const created = await e.app.inject({ method: 'POST', url: '/api/v1/projects', headers: makeAuthedHeaders(owner), payload: { name: 'picker' } });
    const projectId = created.json().data.id;
    const post = (url: string, session: Session, payload: object) => e.app.inject({ method: 'POST', url, headers: makeAuthedHeaders(session), payload });
    assert.equal((await post('/api/v1/project-directory-pickers', owner, { path: e.dir })).statusCode, 400);
    assert.equal((await post(`/api/v1/projects/${projectId}/directory-picker`, owner, { path: e.dir })).statusCode, 400);
    assert.equal((await post(`/api/v1/projects/${projectId}/directory-picker`, other, {})).statusCode, 404);
    const seeded = seedSelectedTicket(e, uid, projectId, e.dir);
    assert.equal((await post(`/api/v1/projects/${projectId}/grants`, owner, { pickerTicket: seeded.ticketId, nonce: seeded.nonce, access: 'read', path: e.dir })).statusCode, 400);
    assert.equal((await post(`/api/v1/projects/${projectId}/grants`, other, { pickerTicket: seeded.ticketId, nonce: seeded.nonce, access: 'read' })).statusCode, 404);
  } finally { await e.app.close(); rmSync(e.dir, { recursive: true, force: true }); }
});

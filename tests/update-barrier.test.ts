// 更新屏障与运行身份回归：健康端点宿主/业务身份、入口门禁、忙碌快照、空闲一致性快照。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildProductApp, type ProductApp } from '../src/app.js';
import { hashPassword } from '../src/auth/passwords.js';

interface Fixture { fx: ProductApp; dir: string }

async function makeApp(env: Record<string, string> = {}): Promise<Fixture> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) { saved[key] = process.env[key]; process.env[key] = value; }
  const dir = mkdtempSync(join(tmpdir(), 'prism-updates-barrier-'));
  const fx = buildProductApp(dir, { serveWeb: false });
  (fx as unknown as { __savedEnv: Record<string, string | undefined> }).__savedEnv = saved;
  return { fx, dir };
}

function restoreEnv(fx: ProductApp): void {
  const saved = (fx as unknown as { __savedEnv: Record<string, string | undefined> }).__savedEnv;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

test('健康端点：宿主/业务身份随环境注入拆分，业务包激活后随环境切换', async () => {
  const { fx, dir } = await makeApp({ PRISM_BUSINESS_VERSION: '0.0.6-beta', PRISM_SOURCE_SHA: 'a'.repeat(40), PRISM_HOST_VERSION: '0.0.5-beta', PRISM_RUNTIME_COMPAT: 'node24.abc.m123' });
  try {
    const response = await fx.app.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(response.statusCode, 200);
    const data = response.json().data;
    assert.equal(data.businessVersion, '0.0.6-beta');
    assert.equal(data.productVersion, '0.0.6-beta'); // 旧字段兼容=业务版本
    assert.equal(data.hostVersion, '0.0.5-beta');
    assert.equal(data.runtimeCompatibilityId, 'node24.abc.m123');
    assert.equal(data.sourceSha, 'a'.repeat(40));
  } finally {
    restoreEnv(fx);
    await fx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('更新屏障：关闭后新建任务入口返回 UPDATE_PENDING，重开后恢复原行为', async () => {
  const { fx, dir } = await makeApp();
  try {
    const openBefore = await fx.app.inject({ method: 'POST', url: '/api/v1/projects/x/runs', payload: {} });
    assert.equal(openBefore.statusCode, 401); // 未登录先被全局会话校验拦截（鉴权先于屏障）
    // 建一个真实会话：屏障门禁在路由处理器内、鉴权之后
    const pw = await hashPassword('BarrierTest2026!');
    const ts = new Date().toISOString();
    fx.db.tx(tx => tx.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)')
      .run(randomUUID(), 'barrier-test', pw.hash, pw.salt, pw.paramsJson, ts, ts));
    const login = await fx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'barrier-test', password: 'BarrierTest2026!' } });
    assert.equal(login.statusCode, 200);
    const raw = login.headers['set-cookie'];
    const headers = { cookie: (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!, 'x-csrf-token': login.json().data.csrfToken };
    const post = { method: 'POST' as const, url: '/api/v1/projects/x/runs', headers, payload: {} };
    // 屏障未关闭（未确认空闲）时禁止生成快照
    assert.throws(() => fx.updateBarrier.createSnapshot(join(dir, 'snap')), { code: 'UPDATE_BARRIER_OPEN' });
    fx.updateBarrier.close('apply-1');
    const closed = await fx.app.inject(post);
    assert.equal(closed.statusCode, 403);
    assert.equal(closed.json().error?.code, 'UPDATE_PENDING');
    // 空闲快照与入口门禁同步
    assert.equal(fx.updateBarrier.busySnapshot().idle, true);
    fx.updateBarrier.reopen();
    const reopened = await fx.app.inject(post);
    assert.equal(reopened.json().error?.code, 'VALIDATION_FAILED'); // 走过屏障，进入正常业务校验
    assert.equal(fx.updateBarrier.isClosed(), false);
  } finally {
    await fx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('更新屏障：空闲确认后可生成一致性快照，含主库与主密钥副本及摘要', async () => {
  const { fx, dir } = await makeApp();
  try {
    const snapshotDir = join(dir, 'updates', 'snapshots', 'r-1');
    // 主密钥由凭证存储在首次写入凭证时惰性创建（32字节随机）；屏障按存在性复制。
    // 这里模拟已存过 Key 的安装，验证副本与摘要链路。
    writeFileSync(join(dir, 'credential-master.key'), randomBytes(32), { flag: 'wx', mode: 0o600 });
    fx.updateBarrier.close('apply-1');
    const evidence = fx.updateBarrier.createSnapshot(snapshotDir);
    const files = evidence.files.map(file => file.file);
    assert.deepEqual(JSON.parse(readFileSync(join(snapshotDir, 'evidence.json'), 'utf8')).files, evidence.files);
    assert.deepEqual(files.sort(), ['credential-master.key', 'workbench.sqlite'].sort());
    for (const file of evidence.files) {
      const digest = createHash('sha256').update(readFileSync(join(snapshotDir, file.file))).digest('hex');
      assert.equal(digest, file.sha256);
      assert.ok(file.size > 0);
    }
    // 快照是独立文件：VACUUM INTO 后正式库仍可正常查询
    const row = fx.db.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    assert.ok(row.n >= 1);
  } finally {
    await fx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('历史已分发／取消队列不阻塞更新，未发送队列阻塞快照', async()=>{
 const {fx,dir}=await makeApp();
 try {
  const now=new Date().toISOString();
  fx.db.db.prepare("INSERT INTO users(id,username,password_hash,password_salt,password_params_json,created_at,updated_at) VALUES ('u','queue-test','hash','salt','{}',?,?)").run(now,now);
  fx.db.db.prepare("INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES ('p','u','test',?,?)").run(now,now);
  fx.db.db.prepare("INSERT INTO conversations(id,project_id,mode,title,created_at,updated_at) VALUES ('c','p','ordinary','test',?,?)").run(now,now);
  for(const state of ['dispatched','cancelled']) fx.db.db.prepare("INSERT INTO conversation_queue(id,conversation_id,owner_user_id,client_key,text,position,state,created_at) VALUES (?,'c','u',?,'text',0,?,?)").run(state,state,state,now);
  assert.equal(fx.updateBarrier.busySnapshot().idle,true);
  fx.db.db.prepare("UPDATE conversation_queue SET state='queued' WHERE id='dispatched'").run();
  fx.updateBarrier.close('race');
  assert.equal(fx.updateBarrier.busySnapshot().idle,false);
  assert.throws(()=>fx.updateBarrier.createSnapshot(join(dir,'snapshot')), {code:'UPDATE_PENDING'});
 } finally {await fx.app.close();rmSync(dir,{recursive:true,force:true});}
});


test('异步写请求尚未结束时，空闲屏障拒绝快照；结束后正常恢复', async()=>{
 const {fx,dir}=await makeApp();
 try {
  const pending=fx.app.inject({method:'POST',url:'/api/v1/auth/register',payload:{username:'race_user',password:'SyntheticRace2026!',confirmation:'SyntheticRace2026!'}}).then((r: {statusCode:number})=>r);
  await new Promise(resolve=>setTimeout(resolve,10));
  fx.updateBarrier.close('during-write');
  assert.ok(fx.updateBarrier.busySnapshot().pendingWrites>0);
  assert.throws(()=>fx.updateBarrier.createSnapshot(join(dir,'snap')), {code:'UPDATE_PENDING'});
  assert.equal((await pending).statusCode,201);
  assert.equal(fx.updateBarrier.busySnapshot().pendingWrites,0);
  assert.equal(fx.updateBarrier.busySnapshot().idle,true);
 } finally {await fx.app.close();rmSync(dir,{recursive:true,force:true});}
});

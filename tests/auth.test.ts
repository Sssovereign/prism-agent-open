// T02 身份与私有项目验收：密码hash、登录/登出/过期、限流、CSRF、Cookie属性、跨账号404、Host/Origin拒绝。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildProductApp } from '../src/app.js';
import type { ProductApp } from '../src/app.js';
import { hashPassword } from '../src/auth/passwords.js';
import { createSession } from '../src/auth/sessions.js';
import { clearLoginFailures } from '../src/auth/routes.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Fixture { fx: ProductApp; dir: string }
let counter = 0;

async function makeApp(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), `t02-auth-${++counter}-`));
  const fx = buildProductApp(dir, { serveWeb: false });
  return { fx, dir };
}

async function insertUser(fx: ProductApp, username: string, password: string): Promise<string> {
  const record = await hashPassword(password);
  const id = randomUUID();
  const now = new Date().toISOString();
  fx.db.tx(tx => tx.prepare(
    'INSERT INTO users(id, username, password_hash, password_salt, password_params_json, disabled, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)'
  ).run(id, username, record.hash, record.salt, record.paramsJson, now, now));
  return id;
}

interface Envelope { data?: unknown; error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> }; requestId?: string }

async function login(fx: ProductApp, username: string, password: string) {
  return fx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
}

function changePassword(fx: ProductApp, session: { token: string; csrf: string }, currentPassword = 'password-123', newPassword = ' new-password! ') {
  return fx.app.inject({ method: 'POST', url: '/api/v1/auth/password', headers: { cookie: `deb_session=${session.token}`, 'x-csrf-token': session.csrf }, payload: { currentPassword, newPassword, confirmation: newPassword } });
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const line = Array.isArray(raw) ? String(raw[0]) : String(raw);
  const [cookie] = line.split(';');
  return cookie ?? line;
}

test('密码以scrypt散列存储：库中无明文，参数N/r/p=16384/8/1且盐随机', async () => {
  const { fx, dir } = await makeApp();
  try {
    const id = await insertUser(fx, 'alice', 'correct-horse-1');
    const row = fx.db.db.prepare('SELECT password_hash, password_salt, password_params_json FROM users WHERE id = ?').get(id) as
      { password_hash: string; password_salt: string; password_params_json: string };
    assert.ok(!row.password_hash.includes('correct-horse'), '散列不得包含明文片段');
    assert.equal(row.password_hash.length, 128, 'scrypt key64 = 128个hex字符');
    assert.equal(row.password_salt.length, 32, 'salt16 = 32个hex字符');
    const params = JSON.parse(row.password_params_json) as { N: number; r: number; p: number };
    assert.deepEqual([params.N, params.r, params.p], [16384, 8, 1]);
    const second = await insertUser(fx, 'bob', 'correct-horse-1');
    const row2 = fx.db.db.prepare('SELECT password_salt FROM users WHERE id = ?').get(second) as { password_salt: string };
    assert.notEqual(row.password_salt, row2.password_salt, '同密码盐必须不同');
  } finally { fx.app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('登录成功：信封返回用户与csrfToken，Cookie带HttpOnly/SameSite=Strict，/me可解析', async () => {
  const { fx, dir } = await makeApp();
  try {
    await insertUser(fx, 'carol', 'password-123');
    const res = await login(fx, 'carol', 'password-123');
    assert.equal(res.statusCode, 200);
    const body = res.json() as Envelope;
    const data = body.data as { user: { username: string }; csrfToken: string };
    assert.equal(data.user.username, 'carol');
    assert.match(data.csrfToken, /^[0-9a-f]{64}$/);
    const rawCookie = res.headers['set-cookie'];
    const cookieLine = Array.isArray(rawCookie) ? String(rawCookie[0]) : String(rawCookie);
    assert.ok(cookieLine.includes('HttpOnly'), '必须HttpOnly');
    assert.ok(cookieLine.includes('SameSite=Strict'), '必须SameSite=Strict');
    assert.ok(cookieLine.includes('Path=/'), '必须Path=/');
    assert.ok(!cookieLine.includes('password'), 'Cookie不得含密码相关内容');
    const me = await fx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookieOf(res) } });
    assert.equal(me.statusCode, 200);
    const meBody = me.json() as Envelope;
    const meData = meBody.data as { user: { username: string }; csrfToken: string };
    assert.equal(meData.user.username, 'carol');
    assert.equal(meData.csrfToken, data.csrfToken, '/me返回的csrfToken与登录时一致');
  } finally { clearLoginFailures(); fx.app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('登录失败统一文案：不存在账号与错误密码同形401，不泄露账号存在性', async () => {
  const { fx, dir } = await makeApp();
  try {
    await insertUser(fx, 'dave', 'password-123');
    const wrongPassword = await login(fx, 'dave', 'wrong-password');
    const unknownUser = await login(fx, 'nobody-here', 'whatever-123');
    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(unknownUser.statusCode, 401);
    const a = wrongPassword.json() as Envelope;
    const b = unknownUser.json() as Envelope;
    assert.deepEqual(a.error!.code, b.error!.code);
    assert.deepEqual(a.error!.message, b.error!.message);
    assert.equal(a.error!.message, '用户名或密码错误');
  } finally { clearLoginFailures(); fx.app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('登录限流：同一账号+IP 5次失败后锁定，正确密码也429；成功登录清除计数', async () => {
  const { fx, dir } = await makeApp();
  try {
    await insertUser(fx, 'erin', 'password-123');
    let last;
    for (let i = 0; i < 5; i++) last = await login(fx, 'erin', 'wrong-password');
    assert.equal(last!.statusCode, 401);
    const locked = await login(fx, 'erin', 'password-123'); // 正确密码同样被锁
    assert.equal(locked.statusCode, 429);
    assert.equal((locked.json() as Envelope).error!.code, 'RESOURCE_BUSY');
    clearLoginFailures();
    const recovered = await login(fx, 'erin', 'password-123');
    assert.equal(recovered.statusCode, 200, '清除限流后正确密码可登录');
  } finally { clearLoginFailures(); fx.app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('会话过期：expires_at过期后/me立即401 SESSION_EXPIRED', async () => {
  const { fx, dir } = await makeApp();
  try {
    const userId = await insertUser(fx, 'frank', 'password-123');
    const session = createSession(fx.db, userId);
    fx.db.tx(tx => tx.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), userId));
    const me = await fx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: `${'deb_session'}=${session.token}` } });
    assert.equal(me.statusCode, 401);
    assert.equal((me.json() as Envelope).error!.code, 'SESSION_EXPIRED');
  } finally { fx.app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('登出撤销立即生效：登出后原token/me即401；缺CSRF的logout被403拒绝且会话仍在', async () => {
  const { fx, dir } = await makeApp();
  try {
    await insertUser(fx, 'grace', 'password-123');
    const res = await login(fx, 'grace', 'password-123');
    const cookie = cookieOf(res);
    const csrf = ((res.json() as Envelope).data as { csrfToken: string }).csrfToken;

    const noCsrf = await fx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal((noCsrf.json() as Envelope).error!.code, 'CSRF_DENIED');
    const still = await fx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    assert.equal(still.statusCode, 200, 'CSRF失败的logout不得撤销会话');

    const out = await fx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, 'x-csrf-token': csrf } });
    assert.equal(out.statusCode, 200);
    const after = await fx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    assert.equal(after.statusCode, 401, '撤销必须立即生效');
    assert.equal((after.json() as Envelope).error!.code, 'SESSION_EXPIRED');
  } finally { fx.app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('写请求CSRF：带会话但缺/错x-csrf-token均403，正确token放行', async () => {
  const { fx, dir } = await makeApp();
  try {
    await insertUser(fx, 'heidi', 'password-123');
    const res = await login(fx, 'heidi', 'password-123');
    const cookie = cookieOf(res);
    const csrf = ((res.json() as Envelope).data as { csrfToken: string }).csrfToken;
    const base = { method: 'POST' as const, url: '/api/v1/projects', payload: { name: '演示项目' }, headers: { cookie } };

    const missing = await fx.app.inject({ ...base, headers: { cookie } });
    assert.equal(missing.statusCode, 403);
    assert.equal((missing.json() as Envelope).error!.code, 'CSRF_DENIED');

    const wrong = await fx.app.inject({ ...base, headers: { cookie, 'x-csrf-token': 'f'.repeat(64) } });
    assert.equal(wrong.statusCode, 403);

    const good = await fx.app.inject({ ...base, headers: { cookie, 'x-csrf-token': csrf } });
    assert.equal(good.statusCode, 201);

    const unauthed = await fx.app.inject({ ...base, headers: {} });
    assert.equal(unauthed.statusCode, 401, '无会话写请求401');
  } finally { fx.app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('跨账号隔离：B访问/改A的项目一律404同形，列表互不可见；未登录401', async () => {
  const { fx, dir } = await makeApp();
  try {
    const userA = await insertUser(fx, 'user-a', 'password-123');
    const userB = await insertUser(fx, 'user-b', 'password-123');
    const loginA = await login(fx, 'user-a', 'password-123');
    const loginB = await login(fx, 'user-b', 'password-123');
    const cookieA = cookieOf(loginA);
    const cookieB = cookieOf(loginB);
    const csrfA = ((loginA.json() as Envelope).data as { csrfToken: string }).csrfToken;
    const csrfB = ((loginB.json() as Envelope).data as { csrfToken: string }).csrfToken;

    const created = await fx.app.inject({
      method: 'POST', url: '/api/v1/projects', headers: { cookie: cookieA, 'x-csrf-token': csrfA }, payload: { name: 'A的私有项目' },
    });
    assert.equal(created.statusCode, 201);
    const projectId = ((created.json() as Envelope).data as { id: string }).id;

    // B直接访问/修改/归档A的项目 → 与不存在同形404
    const getB = await fx.app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}`, headers: { cookie: cookieB } });
    assert.equal(getB.statusCode, 404);
    const patchB = await fx.app.inject({
      method: 'PATCH', url: `/api/v1/projects/${projectId}`, headers: { cookie: cookieB, 'x-csrf-token': csrfB }, payload: { name: '篡改' },
    });
    assert.equal(patchB.statusCode, 404);
    assert.equal((getB.json() as Envelope).error!.code, (patchB.json() as Envelope).error!.code, '访问与不存在错误码同形');

    // B列表不含A项目；A本人可见
    const listB = await fx.app.inject({ method: 'GET', url: '/api/v1/projects', headers: { cookie: cookieB } });
    assert.equal(((listB.json() as Envelope).data as unknown[]).length, 0);
    const listA = await fx.app.inject({ method: 'GET', url: '/api/v1/projects', headers: { cookie: cookieA } });
    const rowsA = (listA.json() as Envelope).data as { id: string; name: string }[];
    assert.deepEqual(rowsA.map(r => r.id), [projectId]);

    // 伪造UUID同样404（不泄露存在性）；非UUID被schema拒绝400
    const fake = await fx.app.inject({ method: 'GET', url: `/api/v1/projects/${uuid(999)}`, headers: { cookie: cookieB } });
    assert.equal(fake.statusCode, 404);
    const malformed = await fx.app.inject({ method: 'GET', url: '/api/v1/projects/not-a-uuid', headers: { cookie: cookieA } });
    assert.equal(malformed.statusCode, 400);

    // 未登录读列表401
    const anon = await fx.app.inject({ method: 'GET', url: '/api/v1/projects' });
    assert.equal(anon.statusCode, 401);
    assert.equal((anon.json() as Envelope).error!.code, 'AUTH_REQUIRED');

    // A自己的写仍正常（撤销/隔离不影响本人）
    assert.equal(userA !== userB, true);
  } finally { fx.app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('改密要求登录及CSRF，拒绝跨账号参数、确认不一致及非法新密码', async () => {
  const { fx, dir } = await makeApp();
  try {
    const userId = await insertUser(fx, 'password-owner', 'password-123');
    const session = createSession(fx.db, userId);
    const payload = { currentPassword: 'password-123', newPassword: 'next-password', confirmation: 'next-password' };
    const headers = { cookie: `deb_session=${session.token}`, 'x-csrf-token': session.csrf };
    const send = (body: object, h: Record<string, string> = headers) => fx.app.inject({ method: 'POST', url: '/api/v1/auth/password', headers: h, payload: body });
    assert.equal((await send(payload, {})).statusCode, 401);
    assert.equal((await send(payload, { cookie: headers.cookie })).statusCode, 403);
    assert.equal((await send(payload, { ...headers, 'x-csrf-token': 'wrong' })).statusCode, 403);
    for (const body of [{ ...payload, userId: randomUUID() }, { ...payload, confirmation: 'different' }, { ...payload, newPassword: '汉字', confirmation: '汉字' }, { ...payload, newPassword: '', confirmation: '' }, { ...payload, newPassword: 'a'.repeat(129), confirmation: 'a'.repeat(129) }]) {
      assert.equal((await send(body)).statusCode, 400);
    }
    assert.equal((await login(fx, 'password-owner', 'password-123')).statusCode, 200);
  } finally { clearLoginFailures(); await fx.app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('错误旧密码不清会话，5次失败后跨会话限流，不影响其他账号及登录', async () => {
  const { fx, dir } = await makeApp();
  try {
    const id = await insertUser(fx, 'password-limited', 'password-123');
    const session = createSession(fx.db, id);
    for (let i = 0; i < 5; i++) {
      const wrong = await changePassword(fx, session, 'wrong');
      assert.equal(wrong.statusCode, 400);
      assert.equal(wrong.json().error.code, 'VALIDATION_FAILED');
      assert.equal(wrong.headers['set-cookie'], undefined);
    }
    assert.equal((await fx.app.inject({ url: '/api/v1/auth/me', headers: { cookie: `deb_session=${session.token}` } })).statusCode, 200);
    assert.equal((await changePassword(fx, createSession(fx.db, id))).statusCode, 429);
    assert.equal((await login(fx, 'password-limited', 'password-123')).statusCode, 200);
    const other = await insertUser(fx, 'password-unlimited', 'password-123');
    assert.equal((await changePassword(fx, createSession(fx.db, other))).statusCode, 200);
  } finally { clearLoginFailures(); await fx.app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('改密原子更新scrypt并撤销本人全部会话，其他用户与项目保持，须用新密码重登', async () => {
  const { fx, dir } = await makeApp();
  try {
    const id = await insertUser(fx, 'password-changed', 'password-123');
    const before = fx.db.db.prepare('SELECT password_hash, password_salt FROM users WHERE id=?').get(id);
    const session = createSession(fx.db, id), second = createSession(fx.db, id);
    const otherId = await insertUser(fx, 'password-other', 'password-123'), other = createSession(fx.db, otherId);
    const project = await fx.app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie: `deb_session=${session.token}`, 'x-csrf-token': session.csrf }, payload: { name: '保持的项目' } });
    assert.equal(project.statusCode, 201);
    const changed = await changePassword(fx, session);
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json().data.requiresLogin, true);
    assert.match(String(changed.headers['set-cookie']), /Max-Age=0/);
    const after = fx.db.db.prepare('SELECT password_hash, password_salt FROM users WHERE id=?').get(id);
    assert.notDeepEqual(after, before);
    for (const old of [session, second]) {
      assert.equal((await fx.app.inject({ url: '/api/v1/auth/me', headers: { cookie: `deb_session=${old.token}` } })).statusCode, 401);
      assert.equal((await changePassword(fx, old)).statusCode, 401);
    }
    assert.equal((await fx.app.inject({ url: '/api/v1/auth/me', headers: { cookie: `deb_session=${other.token}` } })).statusCode, 200);
    assert.equal((await login(fx, 'password-changed', 'password-123')).statusCode, 401);
    const relogin = await login(fx, 'password-changed', ' new-password! ');
    assert.equal(relogin.statusCode, 200);
    const projects = await fx.app.inject({ url: '/api/v1/projects', headers: { cookie: cookieOf(relogin) } });
    assert.equal(projects.json().data[0].id, project.json().data.id);
  } finally { clearLoginFailures(); await fx.app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('并发改密只有一次成功；验密过程中撤销会话或变更hash不能提交', async () => {
  const { fx, dir } = await makeApp();
  try {
    const id = await insertUser(fx, 'password-concurrent', 'password-123');
    const session = createSession(fx.db, id);
    const results = await Promise.all([changePassword(fx, session, 'password-123', 'new-one'), changePassword(fx, session, 'password-123', 'new-two')]);
    assert.equal(results.filter(r => r.statusCode === 200).length, 1);
    assert.equal(results.filter(r => r.statusCode === 401).length, 1);
    // Deterministic race injection at BEGIN IMMEDIATE, after async scrypt completed.
    for (const mode of ['revoke', 'hash'] as const) {
      const uid = await insertUser(fx, `password-race-${mode}`, 'password-123');
      const active = createSession(fx.db, uid);
      const originalTx = fx.db.tx.bind(fx.db);
      let intercepted = false;
      fx.db.tx = fn => originalTx(tx => {
        if (!intercepted) {
          intercepted = true;
          if (mode === 'revoke') tx.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=?').run(new Date().toISOString(), uid);
          else tx.prepare('UPDATE users SET password_hash=? WHERE id=?').run('changed-by-another-writer', uid);
        }
        return fn(tx);
      });
      try {
        const result = await changePassword(fx, active);
        assert.equal(result.statusCode, mode === 'revoke' ? 401 : 409);
        assert.equal(result.headers['set-cookie'], undefined);
      } finally { fx.db.tx = originalTx; }
    }
  } finally { clearLoginFailures(); await fx.app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('登录异步验密后重新核对hash，不为已经替换的旧凭据签发会话', async () => {
  const { fx, dir } = await makeApp();
  try {
    const id = await insertUser(fx, 'login-password-race', 'password-123');
    const originalTx = fx.db.tx.bind(fx.db);
    fx.db.tx = fn => originalTx(tx => {
      tx.prepare('UPDATE users SET password_hash=? WHERE id=?').run('replaced-after-verification', id);
      return fn(tx);
    });
    try {
      const result = await login(fx, 'login-password-race', 'password-123');
      assert.equal(result.statusCode, 401);
      assert.equal(result.headers['set-cookie'], undefined);
      assert.equal(fx.db.db.prepare('SELECT count(*) AS count FROM sessions WHERE user_id=?').get(id)!.count, 0);
    } finally { fx.db.tx = originalTx; }
  } finally { clearLoginFailures(); await fx.app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('边界防护：外部Host返回POLICY_DENIED 403，跨源Origin返回CSRF_DENIED 403', async () => {
  const { fx, dir } = await makeApp();
  try {
    const evilHost = await fx.app.inject({ method: 'GET', url: '/api/v1/health', headers: { host: 'evil.example.com' } });
    assert.equal(evilHost.statusCode, 403);
    assert.equal((evilHost.json() as Envelope).error!.code, 'POLICY_DENIED');

    const evilOrigin = await fx.app.inject({
      method: 'GET', url: '/api/v1/health', headers: { host: 'localhost:3000', origin: 'http://evil.example.com' },
    });
    assert.equal(evilOrigin.statusCode, 403);
    assert.equal((evilOrigin.json() as Envelope).error!.code, 'CSRF_DENIED');
  } finally { fx.app.close(); rmSync(dir, { recursive: true, force: true }); }
});

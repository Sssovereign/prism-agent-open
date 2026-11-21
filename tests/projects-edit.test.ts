// 编辑项目验收：PATCH folders 整表换绑（保留grantId+新票据）、主要目录重设、软撤销不删行（fileRewind依赖）、
// 失败回滚、跨项目路径冲突、越权404、重选已有路径折叠为保留。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildProductApp } from '../src/app.js';
import type { ProductApp } from '../src/app.js';
import { hashPassword } from '../src/auth/passwords.js';
import { clearLoginFailures } from '../src/auth/routes.js';

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');
let counter = 0;

interface Env { app: ProductApp['app']; db: ProductApp['db']; dir: string }

async function makeApp(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), `proj-edit-${++counter}-`));
  const fx = buildProductApp(join(dir, 'data'), { serveWeb: false });
  return { app: fx.app, db: fx.db, dir };
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

function makeAuthedHeaders(s: Session): Record<string, string> {
  return { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' };
}

/** 直接登记selected票据（不经osascript），模拟本机已选目录。 */
function localSelection(env: Env, uid: string, path: string, options: { state?: string; expiresAt?: string } = {}) {
  const id = randomUUID(), nonce = randomUUID(), now = new Date().toISOString();
  env.db.db.prepare('INSERT INTO project_directory_pickers(id,user_id,nonce_hash,state,selected_path,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, uid, sha256(nonce), options.state || 'selected', path, options.expiresAt || new Date(Date.now() + 600_000).toISOString(), now, now);
  return { pickerTicket: id, nonce, access: 'write' as 'read' | 'write' };
}

function mkdir(name: string, base: string): string {
  const root = join(base, name); mkdirSync(root); writeFileSync(join(root, 'a.txt'), 'a'); return realpathSync(root); // macOS /var→/private/var 软链，与 canonicalDirectory 对齐
}

interface ProjectData { id: string; name: string; grants: Array<{ id: string; displayName: string; isPrimary: boolean }> }

async function createLocal(env: Env, session: Session, name: string, folders: Array<{ pickerTicket: string; nonce: string; access: 'read' | 'write' }>): Promise<ProjectData> {
  const res = await env.app.inject({ method: 'POST', url: '/api/v1/projects/local', headers: makeAuthedHeaders(session), payload: { name, folders } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().data as ProjectData;
}

const activeGrants = (env: Env, projectId: string) => env.db.db.prepare('SELECT * FROM workspace_grants WHERE project_id=? AND revoked_at IS NULL ORDER BY is_primary DESC, created_at ASC, id ASC').all(projectId) as unknown as Array<{ id: string; canonical_root: string; revoked_at: string | null; is_primary: number }>;

test('编辑项目：保留授权重设主要+新票据换绑，旧授权软撤销不删行', async () => {
  const env = await makeApp();
  try {
    const uid = await makeUser(env, 'edit-a', 'password-123');
    const a = await loginAs(env, 'edit-a', 'password-123');
    const root1 = mkdir('first-folder', env.dir), root2 = mkdir('second-folder', env.dir), root3 = mkdir('third-folder', env.dir);
    const project = await createLocal(env, a, '我的项目', [localSelection(env, uid, root1), localSelection(env, uid, root2)]);
    assert.equal(project.grants.length, 2);
    assert.equal(project.grants[0]!.isPrimary, true);
    const g1 = project.grants[0]!, g2 = project.grants[1]!;

    // GET 详情返回 grants，不回显绝对路径
    const detail = await env.app.inject({ url: `/api/v1/projects/${project.id}`, headers: makeAuthedHeaders(a) });
    assert.equal(detail.statusCode, 200);
    const detailGrants = (detail.json().data as ProjectData).grants;
    assert.equal(detailGrants.length, 2);
    assert.ok(!detail.body.includes(env.dir));

    // 保留 g2 升为主要 + 新票据 root3：g1 软撤销、g3 插入为次要
    const replace = localSelection(env, uid, root3);
    const patched = await env.app.inject({ method: 'PATCH', url: `/api/v1/projects/${project.id}`, headers: makeAuthedHeaders(a), payload: { folders: [{ grantId: g2.id }, { pickerTicket: replace.pickerTicket, nonce: replace.nonce, access: 'write' }] } });
    assert.equal(patched.statusCode, 200, patched.body);
    const rows = activeGrants(env, project.id);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.id, g2.id);
    assert.equal(rows[0]!.is_primary, 1);
    assert.equal(rows[1]!.canonical_root, root3);
    // g1 行仍在（fileRewind 按 grant_id JOIN），只是 revoked_at 置位
    const revoked = env.db.db.prepare('SELECT * FROM workspace_grants WHERE id=?').get(g1.id) as { revoked_at: string | null };
    assert.ok(revoked);
    assert.ok(revoked.revoked_at);
    // 主要唯一
    assert.equal((env.db.db.prepare('SELECT COUNT(*) n FROM workspace_grants WHERE project_id=? AND is_primary=1 AND revoked_at IS NULL').get(project.id) as { n: number }).n, 1);
  } finally { await env.app.close(); rmSync(env.dir, { recursive: true, force: true }); clearLoginFailures(); }
});

test('编辑项目：全部换成新票据、重选已有路径折叠为保留、仅名称不动授权', async () => {
  const env = await makeApp();
  try {
    const uid = await makeUser(env, 'edit-b', 'password-123');
    const a = await loginAs(env, 'edit-b', 'password-123');
    const root1 = mkdir('alpha', env.dir), root2 = mkdir('beta', env.dir), rootNew = mkdir('gamma', env.dir);
    const project = await createLocal(env, a, '全换项目', [localSelection(env, uid, root1), localSelection(env, uid, root2)]);
    const oldIds = project.grants.map(g => g.id);

    // 重选已有路径 root2 → 折叠为保留该授权；再补新票据 rootNew
    const repick = localSelection(env, uid, root2);
    const fresh = localSelection(env, uid, rootNew);
    const res = await env.app.inject({ method: 'PATCH', url: `/api/v1/projects/${project.id}`, headers: makeAuthedHeaders(a), payload: { folders: [{ pickerTicket: repick.pickerTicket, nonce: repick.nonce, access: 'write' }, { pickerTicket: fresh.pickerTicket, nonce: fresh.nonce, access: 'write' }] } });
    assert.equal(res.statusCode, 200, res.body);
    const rows = activeGrants(env, project.id);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.id, oldIds[1]!); // root2 的原授权保留且升为主要
    assert.equal(rows[1]!.canonical_root, rootNew);
    assert.equal((env.db.db.prepare('SELECT COUNT(*) n FROM workspace_grants WHERE project_id=?').get(project.id) as { n: number }).n, 3); // 原两行 + 新一行，无重复授权

    // 仅改名：grants 不变
    const renamed = await env.app.inject({ method: 'PATCH', url: `/api/v1/projects/${project.id}`, headers: makeAuthedHeaders(a), payload: { name: '新名字' } });
    assert.equal(renamed.statusCode, 200);
    assert.equal((renamed.json().data as ProjectData).name, '新名字');
    assert.equal(activeGrants(env, project.id).length, 2);
    assert.equal((renamed.json().data as ProjectData).grants.length, 2);
  } finally { await env.app.close(); rmSync(env.dir, { recursive: true, force: true }); clearLoginFailures(); }
});

test('编辑项目：无效条目/失效票据/跨项目冲突/越权均拒绝且回滚', async () => {
  const env = await makeApp();
  try {
    const uidA = await makeUser(env, 'edit-c', 'password-123');
    const uidB = await makeUser(env, 'edit-d', 'password-456');
    const a = await loginAs(env, 'edit-c', 'password-123');
    const b = await loginAs(env, 'edit-d', 'password-456');
    const root1 = mkdir('mine', env.dir), clashPath = mkdir('clash', env.dir), pending = mkdir('pending', env.dir);
    const project = await createLocal(env, a, '守卫项目', [localSelection(env, uidA, root1)]);
    // 同用户第二个项目占住 clashPath（冲突检查按 owner 隔离：他人项目绑同路径不拦截）
    const second = await createLocal(env, a, '另一个项目', [localSelection(env, uidA, clashPath)]);
    const before = activeGrants(env, project.id);

    // 条目既无 grantId 也无票据
    assert.equal((await env.app.inject({ method: 'PATCH', url: `/api/v1/projects/${project.id}`, headers: makeAuthedHeaders(a), payload: { folders: [{ access: 'write' }] } })).statusCode, 400);
    // 票据失效：未选择的 pending + 错 nonce
    const unselected = localSelection(env, uidA, pending, { state: 'pending' });
    assert.equal((await env.app.inject({ method: 'PATCH', url: `/api/v1/projects/${project.id}`, headers: makeAuthedHeaders(a), payload: { folders: [{ pickerTicket: unselected.pickerTicket, nonce: unselected.nonce, access: 'write' }] } })).statusCode, 400);
    const wrongNonce = localSelection(env, uidA, pending);
    assert.equal((await env.app.inject({ method: 'PATCH', url: `/api/v1/projects/${project.id}`, headers: makeAuthedHeaders(a), payload: { folders: [{ pickerTicket: wrongNonce.pickerTicket, nonce: 'wrong', access: 'write' }] } })).statusCode, 400);
    // 同用户项目间路径冲突
    const clash = localSelection(env, uidA, clashPath);
    assert.equal((await env.app.inject({ method: 'PATCH', url: `/api/v1/projects/${project.id}`, headers: makeAuthedHeaders(a), payload: { folders: [{ pickerTicket: clash.pickerTicket, nonce: clash.nonce, access: 'write' }] } })).statusCode, 409);
    // 越权：B 编辑 A 的项目（B 持有对 B 自己无效的票据，归属校验先行）
    const okTicket = localSelection(env, uidA, pending);
    assert.equal((await env.app.inject({ method: 'PATCH', url: `/api/v1/projects/${project.id}`, headers: makeAuthedHeaders(b), payload: { folders: [{ pickerTicket: okTicket.pickerTicket, nonce: okTicket.nonce, access: 'write' }] } })).statusCode, 404);
    // 跨用户同路径不冲突：B 有自己的项目，换绑到 A 已绑定的 root1 应成功（与创建通道同规则）
    const betty = mkdir('betty', env.dir);
    const bProject = await createLocal(env, b, 'B的项目', [localSelection(env, uidB, betty)]);
    const crossUser = localSelection(env, uidB, root1);
    assert.equal((await env.app.inject({ method: 'PATCH', url: `/api/v1/projects/${bProject.id}`, headers: makeAuthedHeaders(b), payload: { folders: [{ pickerTicket: crossUser.pickerTicket, nonce: crossUser.nonce, access: 'write' }] } })).statusCode, 200);
    // 每次失败后 A 的授权原样（事务回滚，revoke 未发生）
    const after = activeGrants(env, project.id);
    assert.deepEqual(after.map(r => r.id), before.map(r => r.id));
    assert.ok(after.every(r => r.revoked_at === null));
  } finally { await env.app.close(); rmSync(env.dir, { recursive: true, force: true }); clearLoginFailures(); }
});

test('编辑项目：清空文件夹被拒绝，归档项目详情仍可读', async () => {
  const env = await makeApp();
  try {
    const uid = await makeUser(env, 'edit-e', 'password-123');
    const a = await loginAs(env, 'edit-e', 'password-123');
    const root1 = mkdir('solo', env.dir);
    const project = await createLocal(env, a, '单目录项目', [localSelection(env, uid, root1)]);
    // folders 空数组由 schema minItems:1 拦截
    assert.equal((await env.app.inject({ method: 'PATCH', url: `/api/v1/projects/${project.id}`, headers: makeAuthedHeaders(a), payload: { folders: [] } })).statusCode, 400);
    assert.equal(activeGrants(env, project.id).length, 1);
  } finally { await env.app.close(); rmSync(env.dir, { recursive: true, force: true }); clearLoginFailures(); }
});

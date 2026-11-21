// /api/v1/auth/*：登录（限流5次失败/15min，账号+IP，不泄露账号存在性）、me、logout。
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword } from './passwords.js';
import { revokeUserSessions, insertSession, SESSION_TTL_HOURS, REMEMBER_SESSION_TTL_HOURS, resolveSession, revokeSession, sessionCookie, clearSessionCookie, checkCsrf, SESSION_COOKIE } from './sessions.js';
import { ok, fail, parseCookies } from '../http.js';
import type { Db } from '../storage/db.js';
import { newPasswordError } from '../../contracts/password.js';

const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILS = 5;

interface LoginAttempt { stamps: number[] }
/** 进程内滑动窗口（单后端进程产品形态）；重启清零在回执中如实记录。 */
const loginFailures = new Map<string, LoginAttempt>();
const loginChecks = new Map<string, number>();

function failKey(username: string, ip: string): string { return `${username}|${ip}`; }

function registerFailure(key: string, now: number): number {
  const entry = loginFailures.get(key) ?? { stamps: [] };
  entry.stamps = entry.stamps.filter(t => now - t < LOGIN_WINDOW_MS);
  entry.stamps.push(now);
  loginFailures.set(key, entry);
  return entry.stamps.length;
}

function isLocked(key: string, now: number): boolean {
  const entry = loginFailures.get(key);
  if (entry) entry.stamps = entry.stamps.filter(t => now - t < LOGIN_WINDOW_MS);
  return (entry?.stamps.length ?? 0) + (loginChecks.get(key) ?? 0) >= LOGIN_MAX_FAILS;
}

export function clearLoginFailures(): void { loginFailures.clear(); loginChecks.clear(); }

interface UserRow { id: string; username: string; password_hash: string; password_salt: string; password_params_json: string; disabled: number }

function samePasswordRecord(a: UserRow, b: UserRow): boolean {
  return a.password_hash === b.password_hash && a.password_salt === b.password_salt && a.password_params_json === b.password_params_json;
}

export function registerAuthRoutes(app: FastifyInstance, db: Db): void {
  // Account-scoped, not session-scoped: a second login cannot bypass old-password throttling.
  const passwordFailures = new Map<string, number[]>();
  const passwordChecks = new Map<string, number>();
  app.post('/api/v1/auth/password', { schema: { body: {
    type: 'object', required: ['currentPassword', 'newPassword', 'confirmation'], additionalProperties: false,
    properties: {
      currentPassword: { type: 'string', minLength: 1, maxLength: 128 },
      newPassword: { type: 'string', minLength: 1, maxLength: 128 },
      confirmation: { type: 'string', minLength: 1, maxLength: 128 },
    },
  } } }, async (req, reply) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = resolveSession(db, token);
    if (!session) return fail(req, reply, 'SESSION_EXPIRED', '未登录或会话已过期');
    if (!checkCsrf(req.headers['x-csrf-token'] as string | undefined, session.csrfHash)) {
      return fail(req, reply, 'CSRF_DENIED', 'CSRF校验失败');
    }
    const { currentPassword, newPassword, confirmation } = req.body as { currentPassword: string; newPassword: string; confirmation: string };
    const error = newPasswordError(newPassword);
    if (error) return fail(req, reply, 'VALIDATION_FAILED', error);
    if (newPassword !== confirmation) return fail(req, reply, 'VALIDATION_FAILED', '两次新密码不一致');
    const key = session.userId, now = Date.now();
    const failures = (passwordFailures.get(key) ?? []).filter(t => now - t < LOGIN_WINDOW_MS);
    passwordFailures.set(key, failures);
    const pending = passwordChecks.get(key) ?? 0;
    if (failures.length + pending >= LOGIN_MAX_FAILS) {
      return fail(req, reply, 'RESOURCE_BUSY', '旧密码尝试过于频繁，请15分钟后重试', { status: 429, retryable: true });
    }
    passwordChecks.set(key, pending + 1);
    try {
      const row = db.db.prepare('SELECT * FROM users WHERE id=?').get(session.userId) as UserRow | undefined;
      if (!row || row.disabled) return fail(req, reply, 'SESSION_EXPIRED', '会话已失效，请重新登录');
      const valid = await verifyPassword(currentPassword, { hash: row.password_hash, salt: row.password_salt, paramsJson: row.password_params_json });
      if (!valid) {
        const stamps = (passwordFailures.get(key) ?? []).filter(t => Date.now() - t < LOGIN_WINDOW_MS);
        stamps.push(Date.now());
        passwordFailures.set(key, stamps);
        // Not AUTH_REQUIRED: a typo must not clear the client's valid CSRF/session state.
        return fail(req, reply, 'VALIDATION_FAILED', '当前密码错误', { details: { remainingAttempts: Math.max(0, LOGIN_MAX_FAILS - stamps.length) } });
      }
      const record = await hashPassword(newPassword);
      const result = db.tx(tx => {
        const currentSession = resolveSession(db, token);
        if (!currentSession || currentSession.sessionId !== session.sessionId || currentSession.userId !== session.userId ||
            !checkCsrf(req.headers['x-csrf-token'] as string | undefined, currentSession.csrfHash)) return 'expired';
        const current = tx.prepare('SELECT * FROM users WHERE id=?').get(session.userId) as UserRow | undefined;
        if (!current || current.disabled || !samePasswordRecord(current, row)) return 'conflict';
        const timestamp = new Date();
        tx.prepare('UPDATE users SET password_hash=?, password_salt=?, password_params_json=?, updated_at=? WHERE id=?')
          .run(record.hash, record.salt, record.paramsJson, timestamp.toISOString(), session.userId);
        revokeUserSessions(tx, session.userId, timestamp);
        return 'changed';
      });
      if (result === 'expired') return fail(req, reply, 'SESSION_EXPIRED', '会话已失效，请重新登录');
      if (result === 'conflict') return fail(req, reply, 'WRITE_CONFLICT', '密码已发生变化，请重新登录后重试');
      passwordFailures.delete(key);
      reply.header('set-cookie', clearSessionCookie());
      return ok(req, reply, { passwordChanged: true, requiresLogin: true });
    } finally {
      const remaining = (passwordChecks.get(key) ?? 1) - 1;
      if (remaining) passwordChecks.set(key, remaining); else passwordChecks.delete(key);
    }
  });
  app.get('/api/v1/auth/status', async (req, reply) => {
    return ok(req, reply, { hasAccounts: !!db.db.prepare('SELECT 1 FROM users LIMIT 1').get() });
  });

  app.post('/api/v1/auth/register', { schema: { body: {
    type: 'object', required: ['username', 'password', 'confirmation'], additionalProperties: false,
    properties: {
      username: { type: 'string', minLength: 2, maxLength: 32, pattern: '^[a-zA-Z0-9_-]{2,32}$' },
      password: { type: 'string', minLength: 1, maxLength: 128 },
      confirmation: { type: 'string', minLength: 1, maxLength: 128 }, remember: { type: 'boolean' },
    },
  } } }, async (req, reply) => {
    const { username, password, confirmation, remember = true } = req.body as { username: string; password: string; confirmation: string; remember?: boolean };
    const passwordError = newPasswordError(password);
    if (passwordError) return fail(req, reply, 'VALIDATION_FAILED', passwordError);
    if (password !== confirmation) return fail(req, reply, 'VALIDATION_FAILED', '两次密码不一致');
    const normalized = username.toLowerCase(), key = `register|${req.ip}`, now = Date.now();
    if (isLocked(key, now)) return fail(req, reply, 'RESOURCE_BUSY', '创建账号过于频繁，请15分钟后重试', { status: 429 });
    registerFailure(key, now);
    if (db.db.prepare('SELECT 1 FROM users WHERE username=?').get(normalized)) return fail(req, reply, 'WRITE_CONFLICT', '这个本机用户名已被使用，请换一个');
    const record = await hashPassword(password), id = randomUUID(), timestamp = new Date().toISOString();
    const result = db.tx(tx => {
      // Recheck after the asynchronous hash: concurrent registration cannot replace an account.
      if (tx.prepare('SELECT 1 FROM users WHERE username=?').get(normalized)) return undefined;
      tx.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)')
        .run(id, normalized, record.hash, record.salt, record.paramsJson, timestamp, timestamp);
      return insertSession(tx, id, new Date(), remember ? REMEMBER_SESSION_TTL_HOURS : SESSION_TTL_HOURS);
    });
    if (!result) return fail(req, reply, 'WRITE_CONFLICT', '这个本机用户名已被使用，请换一个');
    reply.header('set-cookie', sessionCookie(result.token, result.expiresAt, req.protocol === 'https', remember));
    return ok(req, reply, { user: { id, username: normalized }, csrfToken: result.csrf }, 201);
  });

  app.post('/api/v1/auth/login', { schema: { body: {
    type: 'object', required: ['username', 'password'], additionalProperties: false,
    properties: { username: { type: 'string', minLength: 1, maxLength: 64 }, password: { type: 'string', minLength: 1, maxLength: 128 }, remember: { type: 'boolean' } },
  } } }, async (req, reply) => {
    const { username, password, remember } = req.body as { username: string; password: string; remember?: boolean };
    const normalized = username.trim().toLowerCase();
    const key = failKey(normalized, req.ip);
    const now = Date.now();
    if (isLocked(key, now)) {
      return fail(req, reply, 'RESOURCE_BUSY', '尝试过于频繁，请15分钟后重试', { status: 429, retryable: true });
    }
    loginChecks.set(key, (loginChecks.get(key) ?? 0) + 1);
    try {
    const row = db.db.prepare('SELECT id, username, password_hash, password_salt, password_params_json, disabled FROM users WHERE username = ?')
      .get(normalized) as UserRow | undefined;
    const valid = row && !row.disabled && await verifyPassword(password, {
      hash: row.password_hash, salt: row.password_salt, paramsJson: row.password_params_json,
    });
    if (!valid) {
      const count = registerFailure(key, Date.now());
      // 统一错误文案，不区分“账号不存在/密码错误”
      return fail(req, reply, 'AUTH_REQUIRED', '用户名或密码错误', {
        status: 401,
        ...(count > 0 ? { details: { remainingAttempts: Math.max(0, LOGIN_MAX_FAILS - count) } } : {}),
      });
    }
    // Password verification yields: never create a session from credentials replaced meanwhile.
    const session = db.tx(tx => {
      const current = tx.prepare('SELECT * FROM users WHERE id=?').get(row!.id) as UserRow | undefined;
      if (!current || current.disabled || !samePasswordRecord(current, row!)) return undefined;
      return insertSession(tx, row!.id, new Date(), remember ? REMEMBER_SESSION_TTL_HOURS : SESSION_TTL_HOURS);
    });
    if (!session) return fail(req, reply, 'AUTH_REQUIRED', '用户名或密码错误', { status: 401 });
    loginFailures.delete(key);
    reply.header('set-cookie', sessionCookie(session.token, session.expiresAt, req.protocol === 'https', remember !== false));
    return ok(req, reply, { user: { id: row!.id, username: row!.username }, csrfToken: session.csrf });
    } finally {
      const remaining = (loginChecks.get(key) ?? 1) - 1;
      if (remaining > 0) loginChecks.set(key, remaining); else loginChecks.delete(key);
    }
  });

  app.get('/api/v1/auth/me', async (req, reply) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = resolveSession(db, token);
    if (!session) return fail(req, reply, 'SESSION_EXPIRED', '未登录或会话已过期', { status: 401 });
    return ok(req, reply, { user: { id: session.userId, username: session.username }, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = resolveSession(db, token);
    if (session) {
      if (!checkCsrf(req.headers['x-csrf-token'] as string | undefined, session.csrfHash)) {
        return fail(req, reply, 'CSRF_DENIED', 'CSRF校验失败', { status: 403 });
      }
      revokeSession(db, session.sessionId);
    }
    reply.header('set-cookie', clearSessionCookie());
    return ok(req, reply, { loggedOut: true });
  });
}

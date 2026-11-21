// 会话：token 32字节随机、DB仅存sha256；CSRF token独立；默认12h／记住登录30天过期；撤销立即生效。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db, Tx } from '../storage/db.js';

export const SESSION_TTL_HOURS = 12;
export const REMEMBER_SESSION_TTL_HOURS = 30 * 24;
export const SESSION_COOKIE = 'deb_session';

export interface SessionUser { userId: string; username: string; sessionId: string }

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export function newSessionSecrets(): { token: string; tokenHash: string; csrf: string; csrfHash: string } {
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  return { token, tokenHash: sha256(token), csrf, csrfHash: sha256(csrf) };
}

/** Shared transaction path lets registration create the user and session atomically. */
export function insertSession(tx: Tx, userId: string, now = new Date(), ttlHours = SESSION_TTL_HOURS): { token: string; csrf: string; expiresAt: Date } {
  const secrets = newSessionSecrets();
  const expiresAt = new Date(now.getTime() + ttlHours * 3600_000);
  const ts = now.toISOString();
  tx.prepare(`INSERT INTO sessions(id, user_id, token_hash, csrf_hash, csrf_token, expires_at, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(randomBytes(16).toString('hex'), userId, secrets.tokenHash, secrets.csrfHash, secrets.csrf, expiresAt.toISOString(), ts, ts);
  return { token: secrets.token, csrf: secrets.csrf, expiresAt };
}

export function createSession(db: Db, userId: string, now = new Date(), ttlHours = SESSION_TTL_HOURS): { token: string; csrf: string; expiresAt: Date } {
  return db.tx(tx => insertSession(tx, userId, now, ttlHours));
}

export function sessionCookie(token: string, expiresAt: Date, secure: boolean, remember = true): string {
  const parts = [`${SESSION_COOKIE}=${token}`, 'HttpOnly', 'SameSite=Strict', 'Path=/'];
  if (remember) parts.push(`Expires=${expiresAt.toUTCString()}`, `Max-Age=${Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000))}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export interface ResolvedSession extends SessionUser { csrfHash: string; csrfToken: string; expiresAt: string }

/** 按cookie token解析会话：撤销/过期均返回undefined（撤销立即生效）。 */
export function resolveSession(db: Db, token: string | undefined, now = new Date()): ResolvedSession | undefined {
  if (!token) return undefined;
  const row = db.db.prepare(`
    SELECT s.id AS session_id, s.csrf_hash, s.csrf_token, s.expires_at, s.revoked_at, u.id AS user_id, u.username, u.disabled
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(sha256(token)) as
    { session_id: string; csrf_hash: string; csrf_token: string; expires_at: string; revoked_at: string | null; user_id: string; username: string; disabled: number } | undefined;
  if (!row) return undefined;
  if (row.revoked_at !== null) return undefined;
  if (row.disabled) return undefined;
  if (new Date(row.expires_at).getTime() <= now.getTime()) return undefined;
  return { sessionId: row.session_id, userId: row.user_id, username: row.username, csrfHash: row.csrf_hash, csrfToken: row.csrf_token, expiresAt: row.expires_at };
}

export function revokeSession(db: Db, sessionId: string, now = new Date()): void {
  const ts = now.toISOString();
  db.tx(tx => tx.prepare('UPDATE sessions SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL').run(ts, ts, sessionId));
}

/** Call inside the password-update transaction so hash replacement and revocation are atomic. */
export function revokeUserSessions(tx: Tx, userId: string, now = new Date()): void {
  const ts = now.toISOString();
  tx.prepare('UPDATE sessions SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(ts, ts, userId);
}

export function checkCsrf(headerValue: string | undefined, csrfHash: string): boolean {
  if (!headerValue) return false;
  const candidate = Buffer.from(sha256(headerValue), 'hex');
  const expected = Buffer.from(csrfHash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

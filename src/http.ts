// HTTP 响应信封与公共插件：{data,requestId} / {data,nextCursor,requestId} / 错误协议。
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, httpStatusOf, retryableByDefault } from '../contracts/errors.js';

const requestIds = new WeakMap<FastifyRequest, string>();

export function requestIdOf(req: FastifyRequest): string {
  const cached = requestIds.get(req);
  if (cached) return cached;
  const existing = req.headers['x-request-id'];
  const id = typeof existing === 'string' && /^[0-9a-f-]{36}$/.test(existing) ? existing : randomUUID();
  requestIds.set(req, id);
  return id;
}

export function ok<T>(req: FastifyRequest, reply: FastifyReply, data: T, code = 200): FastifyReply {
  return reply.code(code).header('x-request-id', requestIdOf(req)).send({ data, requestId: requestIdOf(req) });
}

export function okList<T>(req: FastifyRequest, reply: FastifyReply, data: T[], nextCursor: string | null): FastifyReply {
  return reply.code(200).header('x-request-id', requestIdOf(req)).send({ data, nextCursor, requestId: requestIdOf(req) });
}

export function fail(req: FastifyRequest, reply: FastifyReply, code: import('../contracts/errors.js').ErrorCode, message: string, opts: { status?: number; retryable?: boolean; details?: Record<string, unknown> } = {}): FastifyReply {
  const status = opts.status ?? httpStatusOf(code);
  const retryable = opts.retryable ?? retryableByDefault(code);
  return reply.code(status).header('x-request-id', requestIdOf(req))
    .send({ error: { code, message, retryable, ...(opts.details ? { details: opts.details } : {}) }, requestId: requestIdOf(req) });
}

export function fromApiError(req: FastifyRequest, reply: FastifyReply, error: ApiError): FastifyReply {
  return fail(req, reply, error.code, error.message, { retryable: error.retryable, details: error.details });
}

// —— 游标（服务端编码，客户端不解释） ——
export function encodeCursor(offset: number): string { return Buffer.from(JSON.stringify({ o: offset })).toString('base64url'); }
export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: number };
    return typeof parsed.o === 'number' && Number.isInteger(parsed.o) && parsed.o >= 0 ? parsed.o : 0;
  } catch { throw new ApiError('VALIDATION_FAILED', '游标格式无效'); }
}
export function pageSizeOf(queryLimit: string | undefined): number {
  if (queryLimit === undefined) return 50;
  const n = Number(queryLimit);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new ApiError('VALIDATION_FAILED', 'limit 须为1—100整数');
  return n;
}

// —— Cookie（手工解析，值经encodeURIComponent，避免引入新依赖） ——
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try { out[name] = decodeURIComponent(value); } catch { out[name] = value; }
  }
  return out;
}

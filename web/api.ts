// /api/v1 客户端：信封解包、CSRF自动附带、会话失效上抛。模拟接口（/api/*）不经此模块。
export interface Envelope<T> { data: T; nextCursor?: string | null; requestId: string }
export interface ApiFailure { error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> }; requestId: string }

let csrfToken: string | null = null;
let sessionGeneration = 0;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** 服务端信封 error.retryable（协议默认可重试码）或显式标注；驱动UI重试提示 */
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;
  /** 服务端请求关联ID，错误横幅复制/排查用 */
  readonly requestId?: string;
  constructor(code: string, message: string, status: number, opts: { retryable?: boolean; details?: Record<string, unknown>; requestId?: string } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = opts.retryable;
    this.details = opts.details;
    this.requestId = opts.requestId;
  }
}

export function setCsrfToken(token: string | null): void { csrfToken = token; sessionGeneration++; }

/** 供需要手工构造fetch（如multipart FormData）的调用附带CSRF头。 */
export function currentCsrfToken(): string | null { return csrfToken; }

/** 新建项目的目录选择接口要求 JSON 对象，即使没有参数也必须发送 {}。 */
export function startProjectDirectoryPicker(): Promise<{ id: string; nonce: string; expiresAt: string }> {
  return v1('/api/v1/project-directory-pickers', { method: 'POST', body: JSON.stringify({}) });
}

export async function v1<T>(url: string, init: RequestInit = {}): Promise<T> {
  const generation = sessionGeneration;
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const method = (init.method ?? 'GET').toUpperCase();
  if (csrfToken && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  if (!response.ok) {
    const failure = body as ApiFailure | undefined;
    const code = failure?.error?.code ?? 'INTERNAL_ERROR';
    const message = failure?.error?.message ?? `请求失败（${response.status}）`;
    if (generation === sessionGeneration && (code === 'SESSION_EXPIRED' || code === 'AUTH_REQUIRED')) setCsrfToken(null);
    throw new ApiError(code, message, response.status, {
      retryable: failure?.error?.retryable,
      details: failure?.error?.details,
      requestId: failure?.requestId,
    });
  }
  // /me与login都返回csrfToken：刷新后内存态为空，统一在此恢复，避免刷新后写请求全被CSRF拒绝
  const data = (body as Envelope<T>).data as { csrfToken?: unknown } | undefined;
  if (generation === sessionGeneration && data && typeof data.csrfToken === 'string' && /^[0-9a-f]{64}$/.test(data.csrfToken) && data.csrfToken !== csrfToken) setCsrfToken(data.csrfToken);
  return (body as Envelope<T>).data;
}

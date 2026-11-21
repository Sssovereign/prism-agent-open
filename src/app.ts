import { registerResearchRoutes } from './agent/researchRoutes.js';
import {closeMcpConnectionsForDb} from './agent/mcpManager.js';
import {registerWorkspaceFeatures} from './agent/workspaceFeatures.js';
import { checkForUpdate, readCurrentSha } from './updateCheck.js';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { VERSION } from '@earendil-works/pi-coding-agent';
import { Db, defaultDbPath } from './storage/db.js';
import { archiveLegacyMock } from './storage/legacy.js';
import { migrate } from './storage/migrate.js';
import { registerAuthRoutes } from './auth/routes.js';
import { resolveSession, checkCsrf, SESSION_COOKIE } from './auth/sessions.js';
import { registerProjectRoutes } from './projects/routes.js';
import { createLocalDirectoryChooser, type DirectoryChooser } from './files/directoryChooser.js';
import type { DesktopBrowserHost } from './agent/desktopBrowser.js';
import { registerFileRoutes } from './files/routes.js';
import { registerModelRoutes } from './models/routes.js';
import type { ModelTransport } from './models/gateway.js';
import { RUNTIME_STREAM_PROFILE } from './models/streamNetwork.js';
import { MAX_FILE_BYTES } from './files/broker.js';
import multipart from '@fastify/multipart';
import { fail, parseCookies, fromApiError, requestIdOf } from './http.js';
import { ApiError } from '../contracts/errors.js';
import { CredentialVault } from './models/vault.js';
import { LocalCredentialStore } from './models/localCredentialStore.js';
import { TicketRegistry } from './agent/tickets.js';
import { ModelRequestRegistry } from './agent/modelRequests.js';
import { ModelGatewayServer } from './agent/gatewayServer.js';
import { Supervisor } from './agent/supervisor.js';
import { registerMemoryRoutes } from './agent/memoryRoutes.js';
import { registerRunRoutes } from './agent/runRoutes.js';
import { registerAttachmentRoutes } from './agent/attachmentRoutes.js';
import { registerConversationRoutes } from './agent/conversationRoutes.js';
import { registerSearchRoutes } from './agent/searchRoutes.js';
import { registerBrowserRoutes } from './agent/browserRoutes.js';
import { registerMcpRoutes } from './agent/mcpRoutes.js';
import { registerSkillRoutes } from './agent/skillRoutes.js';
import { UpdateBarrier } from './updates/barrier.js';
import { resolveHostIdentity } from './updates/identity.js';
import { fileURLToPath } from 'node:url';

export interface ProductApp {
  app: ReturnType<typeof Fastify>;
  db: Db;
  supervisor: Supervisor;
  gatewayServer: ModelGatewayServer;
  updateBarrier: UpdateBarrier;
}

/** 构建 /api/v1 产品服务：打开DB→归档legacy→迁移→身份/项目路由。仅监听127.0.0.1（server侧保证）。
 * recoverOnStart默认true（测试/直接装配即含崩溃恢复）；正式server.ts传false并改在listen成功后
 * 调recoverAtStartup——否则第二实例会在EADDRINUSE崩溃前就改写共享库中的活动run状态。 */
export function buildProductApp(dataDir: string, options: { serveWeb?: boolean; modelTransport?: ModelTransport; recoverOnStart?: boolean; directoryChooser?: DirectoryChooser; desktopBrowser?: DesktopBrowserHost } = {}): ProductApp {
  const db = new Db(defaultDbPath(dataDir));
  archiveLegacyMock(db);
  migrate(db);

  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });

  app.addHook('onRequest', async (req, reply) => {
    // 桌面宿主注入每次启动的随机令牌，其他浏览器不能访问桌面实例。
    if (process.env.PRISM_DESKTOP_TOKEN && req.headers['x-prism-desktop-token'] !== process.env.PRISM_DESKTOP_TOKEN) {
      return fail(req, reply, 'POLICY_DENIED', '仅限桌面应用访问', { status: 403 });
    }
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return fail(req, reply, 'POLICY_DENIED', '仅限本机访问', { status: 403 });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}` && origin !== `https://${host}`) {
      return fail(req, reply, 'CSRF_DENIED', 'Origin校验失败', { status: 403 });
    }
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store');
  });

  // 会话解析 + 写请求CSRF（login/register为公开JSON入口，其余写请求均要求）
  const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/v1/')) return;
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = resolveSession(db, token);
    (req as unknown as { session?: typeof session }).session = session;
    if (WRITE_METHODS.has(req.method) && !['/api/v1/auth/login', '/api/v1/auth/register'].includes(req.url.split('?')[0]!)) {
      if (!session) throw new ApiError('SESSION_EXPIRED', '未登录或会话已过期');
      if (!checkCsrf(req.headers['x-csrf-token'] as string | undefined, session.csrfHash)) {
        throw new ApiError('CSRF_DENIED', 'CSRF校验失败');
      }
    }
  });

  const auth = (req: unknown): { userId: string; username: string } => {
    const session = (req as { session?: { userId: string; username: string } }).session;
    if (!session) throw new ApiError('AUTH_REQUIRED', '未登录');
    return { userId: session.userId, username: session.username };
  };

  app.get('/api/v1/health', async (req, reply) => {
    // 当前源码SHA：前端构建期注入自己的SHA，比对不一致即提示刷新加载新版本；非git工作区为null。
    // 业务包更新后 sourceSha/productVersion 反映外置业务包；宿主身份由桌面宿主经环境变量注入。
    const sha = await readCurrentSha();
    const identity = resolveHostIdentity();
    return reply.code(200).header('x-request-id', requestIdOf(req)).send({
      data: {
        version: '0.2.1',
        productVersion: identity.businessVersion,
        businessVersion: identity.businessVersion,
        hostVersion: identity.hostVersion,
        runtimeCompatibilityId: identity.runtimeCompatibilityId,
        databaseSchemaVersion: identity.databaseSchemaVersion,
        sourceSha: sha,
        runtime: { node: process.version, pi: VERSION },
        sandboxCapabilities: { platform: process.platform, seatbelt: process.platform === 'darwin', filesystem: 'host' },
      },
      requestId: requestIdOf(req),
    });
  });

  // 更新检测：比对运行工作区HEAD与origin/main（ls-remote，不改写本地仓库；60s缓存）。
  // 实际更新执行（fetch/merge/构建/迁移/重启）走 scripts/deploy.sh，服务进程不自我更新。
  app.get('/api/v1/update-check', async (req, reply) => {
    auth(req);
    const result = await checkForUpdate();
    return reply.code(200).header('x-request-id', requestIdOf(req)).send({
      data: result,
      requestId: requestIdOf(req),
    });
  });

  // —— 普通Agent真实执行链装配（监督器/网关/票据/登记共享同一DB与vault） ——
  const vault = new CredentialVault(new LocalCredentialStore(db, resolve(dataDir, 'credential-master.key')));
  const tickets = new TicketRegistry(db);
  const runCancelled = (runId: string): boolean => {
    const row = db.db.prepare('SELECT status, cancel_requested_at FROM runs WHERE id=?').get(runId) as
      { status: string; cancel_requested_at: string | null } | undefined;
    return !!row && (row.status === 'cancelling' || !!row.cancel_requested_at);
  };
  const registry = new ModelRequestRegistry(db, runCancelled);
  // 仅受控验证：显式环境变量注入本机自签CA并放行回环上游（本地端到端冒烟的mock上游用）；
  // 生产不设置PRISM_TEST_UPSTREAM_CA，保持Node默认根校验与SSRF回环封锁
  const testUpstreamCa = process.env.PRISM_TEST_UPSTREAM_CA;
  const gatewayServer: ModelGatewayServer = new ModelGatewayServer({
    db, tickets, registry, vault,
    bindingOf: (attemptId: string) => supervisor.bindingFor(attemptId),
    abortOf: (attemptId: string) => supervisor.abortSignalFor(attemptId),
    profile: testUpstreamCa
      ? { ...RUNTIME_STREAM_PROFILE, caCertPem: testUpstreamCa, allowLoopbackForTest: true }
      : undefined,
  });
  const supervisor: Supervisor = new Supervisor({
    db, dataDir, tickets, registry, vault, gateway: gatewayServer,
    runnerEntry: fileURLToPath(new URL('./agent/runnerMain.js', import.meta.url)),
    // 仅受控验证：显式环境变量注入本机自签CA，用于本地端到端冒烟的mock上游；生产不设置、保持Node默认根校验
    bindingCaCertPem: process.env.PRISM_TEST_UPSTREAM_CA || undefined,
    desktopBrowser: options.desktopBrowser,
  });
  if (options.recoverOnStart !== false) supervisor.recoverAtStartup();
  // 更新屏障：桌面宿主在切换业务包前经IPC关闭任务入口并等待空闲确认；屏障只在空闲时关闭，既有任务的响应不受影响
  const updateBarrier = new UpdateBarrier({ db, dataDir, supervisor, registry });
  // 覆盖屏障关闭前已进入、但仍在异步鉴权／校验中的写请求，防止空闲检查竞态。
  const updateWrites = new WeakMap<object, () => void>();
  app.addHook('onRequest', async req => {
    if (WRITE_METHODS.has(req.method)) updateWrites.set(req, updateBarrier.trackWrite());
  });
  const releaseUpdateWrite = (req: object) => { updateWrites.get(req)?.(); updateWrites.delete(req); };
  app.addHook('onResponse', async req => { releaseUpdateWrite(req); });
  app.addHook('onRequestAbort', async req => { releaseUpdateWrite(req); });

  registerModelRoutes(app, db, options.modelTransport, {
    vault,
    onQuestionAutoResolutionDisabled: userId => supervisor.userQuestions.disableAutoResolution(userId),
    onCredentialChanged: input => supervisor.onCredentialChanged(input),
  });
  registerAuthRoutes(app, db);
  const directoryChooser = options.directoryChooser ?? createLocalDirectoryChooser();
  registerProjectRoutes(app, db, auth as never, directoryChooser);
  app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 10 } });
  registerAttachmentRoutes(app, db, auth as never, dataDir);
  registerFileRoutes(app, db, auth as never, dataDir, directoryChooser);
  registerRunRoutes(app, { db, dataDir, supervisor, updates: updateBarrier }, auth as never);
  registerResearchRoutes(app, supervisor, auth as never, { updates: updateBarrier });
  registerWorkspaceFeatures(app, db, supervisor, auth as never, updateBarrier);
  registerConversationRoutes(app, { db }, auth as never);
  registerMemoryRoutes(app, db, dataDir, auth as never);
  registerSearchRoutes(app, db);
  registerBrowserRoutes(app, options.desktopBrowser);
  registerMcpRoutes(app, db);
  registerSkillRoutes(app, db);

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ApiError) return fromApiError(req, reply, error);
    const err = error as { validation?: unknown; statusCode?: number };
    if (err.validation) {
      return fail(req, reply, 'VALIDATION_FAILED', '请求参数不合法', { status: 400 });
    }
    if (err.statusCode === 404) {
      return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
    }
    if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
      // body解析/媒体类型等框架层4xx（如空body带JSON头），按协议归一为400
      return fail(req, reply, 'VALIDATION_FAILED', '请求参数不合法', { status: 400 });
    }
    return fail(req, reply, 'INTERNAL_ERROR', '内部错误', { status: 500 });
  });

  const webRoot = resolve('web-dist');
  if (options.serveWeb !== false && existsSync(webRoot)) app.register(staticFiles, { root: webRoot });
  app.addHook('onClose', async () => {
    directoryChooser.close();
    options.desktopBrowser?.close();
    await supervisor.stop();
    closeMcpConnectionsForDb(db);
    await gatewayServer.close();
    vault.dispose();
    db.close();
  });
  return { app, db, supervisor, gatewayServer, updateBarrier };
}

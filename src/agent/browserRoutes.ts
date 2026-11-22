import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DesktopBrowserHost } from './desktopBrowser.js';
import { assertNavigableUrl, assertPanelRect } from './desktopBrowser.js';
import { ApiError } from '../../contracts/errors.js';
import { ok } from '../http.js';

/** 面板地址栏可用的命令白名单：只读导航。点击/填写/截图是模型工具面，不对 UI 开放。 */
const PANEL_COMMANDS = new Set(['navigate', 'back']);

/** 内嵌浏览器面板（R2）：渲染端 UI 通道——能力查询、状态轮询与面板化开关。
 *  模型命令面（browser_* 工具）走监督器执行，不经此路由；面板只是同一 guest 的可见形态。
 *  R3 地址栏：用户经面板输入的导航走 /command（supervisor 同一 URL 校验纪律），与模型共用同一 guest。 */
export function registerBrowserRoutes(app: FastifyInstance, desktopBrowser: DesktopBrowserHost | undefined): void {
    function userId(req: FastifyRequest): string {
        const session = (req as unknown as { session?: { userId?: string } }).session;
        if (!session?.userId) throw new ApiError('AUTH_REQUIRED', '请先登录');
        return session.userId;
    }
    function host(): DesktopBrowserHost {
        if (!desktopBrowser?.available) throw new ApiError('BROWSER_UNAVAILABLE', '内嵌浏览器需要桌面版运行');
        return desktopBrowser;
    }

    // 能力查询：纯 Web/宿主未就绪时返回 available=false，渲染端展示占位而不报错
    app.get('/api/v1/browser', async (req, reply) => {
        userId(req);
        if (!desktopBrowser?.available) return ok(req, reply, { available: false, panel: null });
        const panel = await desktopBrowser.state();
        return ok(req, reply, { available: true, panel });
    });

    app.post('/api/v1/browser/panel', async (req, reply) => {
        userId(req);
        const body = (req.body ?? {}) as { visible?: unknown; rect?: unknown };
        const visible = body.visible === true;
        const browser = host();
        if (visible) {
            const panel = await browser.panel({ visible: true, rect: assertPanelRect(body.rect) });
            return ok(req, reply, panel);
        }
        return ok(req, reply, await browser.panel({ visible: false }));
    });

    // 面板地址栏/返回按钮：与模型命令同一 guest 串行执行；navigate 复用 assertNavigableUrl
    //（协议/账号信息/本机主机名/私网 IP 全检）+ 监督器侧的解析纪律不在此重复——宿主 session 守卫兜底。
    app.post('/api/v1/browser/command', async (req, reply) => {
        userId(req);
        const body = (req.body ?? {}) as { method?: unknown; args?: unknown };
        const method = typeof body.method === 'string' ? body.method : '';
        if (!PANEL_COMMANDS.has(method)) throw new ApiError('VALIDATION_FAILED', '未知浏览器命令');
        const args = (body.args ?? {}) as Record<string, unknown>;
        if (method === 'navigate') args.url = assertNavigableUrl(args.url);
        const panel = await host().execute(method, args, method === 'navigate' ? 20_000 : 8_000) as { url?: string; title?: string };
        return ok(req, reply, { url: panel.url, title: panel.title });
    });
}

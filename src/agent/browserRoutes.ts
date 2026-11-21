import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DesktopBrowserHost } from './desktopBrowser.js';
import { assertPanelRect } from './desktopBrowser.js';
import { ApiError } from '../../contracts/errors.js';
import { ok } from '../http.js';

/** 内嵌浏览器面板（R2）：渲染端 UI 通道——能力查询、状态轮询与面板化开关。
 *  模型命令面（browser_* 工具）走监督器执行，不经此路由；面板只是同一 guest 的可见形态。 */
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
}

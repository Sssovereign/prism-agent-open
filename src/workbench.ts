import { createServer } from 'node:http';
import { buildProductApp } from './app.js';

/** 正式启动与受控验证共享装配；只由调用方选择端口、数据目录和信号处理。 */
export async function buildWorkbench(dataDir: string, options: Parameters<typeof buildProductApp>[1] = {}) {
  const product = buildProductApp(dataDir, options);
  let shutdown: Promise<void> | undefined;
  function closeApps(): Promise<void> {
    return shutdown ??= product.app.close();
  }
  try {
    // 手动 routing 不经过 Fastify.listen，须先完成插件和钩子装配。
    await product.app.ready();
  } catch (error) {
    await closeApps();
    throw error;
  }
  const server = createServer((req, res) => {
    product.app.routing(req, res);
  });
  server.on('close', () => { void closeApps(); });
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    return closing ??= (async () => {
      const closed = server.listening
        ? new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        : Promise.resolve();
      server.closeAllConnections();
      await Promise.all([closed, closeApps()]);
    })();
  }
  return { server, product, close };
}

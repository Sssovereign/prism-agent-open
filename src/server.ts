import { resolve } from 'node:path';
import { buildWorkbench } from './workbench.js';

const dataDir = resolve(process.env.DEBATE_DATA_DIR ?? '.data');
const port = Number(process.env.DEBATE_PORT ?? 4391);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_PORT');
const { server, close, product } = await buildWorkbench(dataDir, { recoverOnStart: false });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void close().catch(error => { console.error(error); process.exitCode = 1; });
  });
}
server.listen(port, '127.0.0.1', () => {
  // 崩溃恢复在listen成功后执行：第二实例端口占用退出时，不会改写实例1正在管理的活动run状态
  product.supervisor.recoverAtStartup();
  console.log(`本地工作台：http://127.0.0.1:${port}（项目与真实模型任务已接入）`);
});
server.on('error', error => { console.error(`端口监听失败（${(error as NodeJS.ErrnoException).code ?? ''}），已有实例在运行？`); process.exit(1); });

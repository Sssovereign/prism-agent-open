// 使用随包的 Node 24 承载产品和 Agent 子进程，避免依赖系统 Node / Electron ABI。
// 启动打点：依赖树经动态 import 加载，模块加载/装配/监听/恢复各阶段均落 desktop.log。
// 此前 ready 前零输出，慢盘或杀软首启卡在依赖加载时无法定位（2026-11-17 Windows 启动超时报告）。
process.on('uncaughtException', error => { console.error(`[boot] 未捕获异常：${error?.stack ?? error}`); process.exit(1); });
process.on('unhandledRejection', reason => { console.error(`[boot] 未处理的Promise拒绝：${reason?.stack ?? reason}`); process.exit(1); });
console.error('[boot] 后端进程已启动');
// 握手与依赖加载并行：公告/重发hello覆盖主进程启动繁忙期，结果落desktop.log可观测
const directoryChooserPromise = import('../dist/src/files/directoryChooser.js').then(m => m.connectDesktopDirectoryChooser(process));
// 内嵌浏览器通道：监听器挂载较晚时，主动探测补齐可能错过的能力公告。
const desktopBrowserPromise = import('../dist/src/agent/desktopBrowser.js').then(async m => {
  const host = m.connectDesktopBrowserHost(process);
  await host.probe();
  return host;
});
console.error('[boot] 业务依赖模块加载中…');
const moduleStart = Date.now();
const { buildWorkbench } = await import('../dist/src/workbench.js');
console.error(`[boot] 业务依赖模块加载完成（${((Date.now() - moduleStart) / 1000).toFixed(1)}s）`);
const directoryChooser = await directoryChooserPromise;
console.error(`[picker] 目录选择通道握手${directoryChooser.available ? '成功' : '失败（点击选择时将自动重试）'}`);
const desktopBrowser = await desktopBrowserPromise;
console.error(`[browser] 内嵌浏览器能力${desktopBrowser.available ? '可用' : '不可用（纯Web模式或宿主未公告）'}`);
const buildStart = Date.now();
const workbench = await buildWorkbench(process.env.DEBATE_DATA_DIR, { recoverOnStart: false, directoryChooser, desktopBrowser });
console.error(`[boot] 业务装配完成（${((Date.now() - buildStart) / 1000).toFixed(1)}s）`);
await new Promise((resolve, reject) => {
  workbench.server.once('error', reject);
  workbench.server.listen(0, '127.0.0.1', resolve);
});
console.error(`[boot] 本地服务监听 127.0.0.1:${workbench.server.address().port}`);
if (process.env.PRISM_UPDATE_CANDIDATE !== '1') workbench.product.supervisor.recoverAtStartup();
else workbench.product.updateBarrier.close('candidate-startup');
console.error('[boot] 崩溃恢复完成');
process.send?.({ type: 'ready', port: workbench.server.address().port, sourceSha: process.env.PRISM_SOURCE_SHA ?? null });
console.error('[boot] ready已回传主进程');
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 12000);
  deadline.unref();
  await workbench.close();
  desktopBrowser.close();
  process.disconnect?.();
}
const barrier = workbench.product.updateBarrier;
process.on('message', message => {
  if (message?.type === 'shutdown') { void close(); return; }
  // —— 更新屏障协议（仅桌面宿主可信IPC；详细状态经 result 回传，不写日志敏感内容） ——
  if (message?.type === 'update:commit') {
    barrier.reopen();
    process.send?.({ type: 'update:commit-result', applyId: message.applyId });
  } else if (message?.type === 'update:prepare') {
    barrier.close(String(message.applyId ?? ''));
    process.send?.({ type: 'update:prepare-result', applyId: message.applyId, snapshot: barrier.busySnapshot() });
  } else if (message?.type === 'update:status') {
    process.send?.({ type: 'update:status-result', applyId: message.applyId, closed: barrier.isClosed(), snapshot: barrier.busySnapshot() });
  } else if (message?.type === 'update:abort') {
    barrier.reopen();
    process.send?.({ type: 'update:abort-result', applyId: message.applyId, closed: barrier.isClosed() });
  } else if (message?.type === 'update:snapshot') {
    try {
      const evidence = barrier.createSnapshot(String(message.dir ?? ''));
      process.send?.({ type: 'update:snapshot-result', applyId: message.applyId, ok: true, evidence });
    } catch (error) {
      process.send?.({ type: 'update:snapshot-result', applyId: message.applyId, ok: false, error: error?.message ?? String(error) });
    }
  }
});
process.once('disconnect', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });

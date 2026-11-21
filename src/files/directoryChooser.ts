import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../contracts/errors.js';
import { canonicalDirectory } from './paths.js';

export type DirectoryResult = { state: 'selected'; path: string } | { state: 'cancelled' | 'failed' | 'expired' };
export interface DirectoryChooser {
  assertAvailable(): void;
  choose(requestId: string, expiresAt: number, purpose: 'project' | 'grant', signal: AbortSignal): Promise<DirectoryResult>;
  close(): void;
}
export interface PickerChannel {
  connected?: boolean;
  send?: (message: unknown, callback?: (error: Error | null) => void) => unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}
const hostUnsupported = () => { throw new ApiError('POLICY_DENIED', '当前宿主不支持目录选择，请安装新版完整桌面应用'); };
const channelUnavailable = () => { throw new ApiError('POLICY_DENIED', '未能连接桌面窗口的目录选择通道，请重启棱镜后重试'); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 与桌面宿主做一轮能力握手：周期重发hello直至应答，窗口期覆盖主进程启动繁忙。
 * 宿主也可能不经hello主动公告能力（requestId缺省），同样接受；版本不符视为无效。
 */
async function handshakeWindow(channel: PickerChannel, timeoutMs: number, helloIntervalMs = 400): Promise<boolean> {
  const requestId = randomUUID();
  return new Promise(resolve => {
    const finish = (value: boolean) => { clearInterval(hello); clearTimeout(deadline); channel.removeListener('message', listener); resolve(value); };
    const listener = (m: any): void => { if (m?.type === 'directory-picker:capability' && m.version === 1 && (m.requestId === undefined || m.requestId === null || m.requestId === requestId)) finish(true); };
    const sendHello = (): boolean => {
      if (!channel.connected || !channel.send) return true;
      try { channel.send({ type: 'directory-picker:hello', requestId }, error => { if (error) finish(false); }); } catch { /* 等待重发或超时 */ }
      return false;
    };
    const hello = setInterval(sendHello, helloIntervalMs);
    const deadline = setTimeout(() => finish(false), timeoutMs);
    channel.on('message', listener);
    if (sendHello()) finish(false);
  });
}

/** 只有可信 Node 子进程 IPC 能返回路径；渲染页仍只使用 HTTP 票据。 */
export class IpcDirectoryChooser implements DirectoryChooser {
  private pending = new Map<string, (result: DirectoryResult) => void>();
  private closed = false;
  constructor(private channel: PickerChannel, private available: boolean) {
    channel.on('message', this.onMessage);
    channel.on('disconnect', this.onDisconnect);
  }
  // available=false 不在此处硬拒：通道仍在时由 choose() 做点击期补偿握手（启动竞态恢复）。
  assertAvailable(): void { if (this.closed || !this.channel.connected) channelUnavailable(); }
  private send(message: unknown): void { try { this.channel.send?.(message, error => { if (error) this.onDisconnect(); }); } catch { this.onDisconnect(); } }
  private onMessage = (message: any): void => {
    if (message?.type !== 'directory-picker:result' || typeof message.requestId !== 'string') return;
    const finish = this.pending.get(message.requestId);
    if (!finish) return;
    if (message.state === 'selected') {
      try { finish({ state: 'selected', path: canonicalDirectory(message.path) }); }
      catch { finish({ state: 'failed' }); }
    } else if (['cancelled', 'failed', 'expired'].includes(message.state)) finish({ state: message.state });
    else finish({ state: 'failed' });
  };
  private onDisconnect = (): void => { this.available = false; for (const finish of [...this.pending.values()]) finish({ state: 'failed' }); };
  async choose(requestId: string, expiresAt: number, purpose: 'project' | 'grant', signal: AbortSignal): Promise<DirectoryResult> {
    this.assertAvailable();
    if (!uuid.test(requestId) || this.pending.has(requestId)) throw new Error('Invalid picker request');
    // 常路同步进入open，选择结果不会先于pending登记；仅启动竞态缺失时走补偿握手。
    if (this.available && this.channel.connected) return this.open(requestId, expiresAt, purpose, signal);
    this.available = await handshakeWindow(this.channel, 2000, 300) && this.channel.connected === true;
    if (!this.available) channelUnavailable();
    return this.open(requestId, expiresAt, purpose, signal);
  }
  private open(requestId: string, expiresAt: number, purpose: 'project' | 'grant', signal: AbortSignal): Promise<DirectoryResult> {
    return new Promise(resolve => {
      const finish = (result: DirectoryResult) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer); signal.removeEventListener('abort', cancel);
        resolve(Date.now() >= expiresAt ? { state: 'expired' } : result);
      };
      const cancel = () => { this.send({ type: 'directory-picker:cancel', requestId }); finish({ state: 'cancelled' }); };
      const timer = setTimeout(() => { this.send({ type: 'directory-picker:cancel', requestId }); finish({ state: 'expired' }); }, Math.max(0, expiresAt - Date.now()));
      timer.unref();
      this.pending.set(requestId, finish);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      this.send({ type: 'directory-picker:open', requestId, expiresAt, purpose });
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [requestId, finish] of [...this.pending]) { this.send({ type: 'directory-picker:cancel', requestId }); finish({ state: 'cancelled' }); }
    this.channel.removeListener('message', this.onMessage); this.channel.removeListener('disconnect', this.onDisconnect);
  }
}

/** 握手失败不永久禁用：choose() 会在点击时补偿握手；旧宿主不响应时不在桌面版偷偷回退 osascript。 */
export async function connectDesktopDirectoryChooser(channel: PickerChannel, timeoutMs = 6000): Promise<DirectoryChooser> {
  const available = await handshakeWindow(channel, timeoutMs);
  return new IpcDirectoryChooser(channel, available);
}

export function createLocalDirectoryChooser(): DirectoryChooser {
  const children = new Set<ReturnType<typeof spawn>>();
  let closed = false;
  const assertAvailable = () => { if (closed || process.env.PRISM_DESKTOP_TOKEN || process.platform !== 'darwin') hostUnsupported(); };
  return {
    assertAvailable,
    choose(_id, expiresAt, purpose, signal) {
      assertAvailable();
      return new Promise(resolve => {
        const prompt = purpose === 'project' ? '选择此项目的本地文件夹' : '选择授权给本项目的工作目录';
        const child = spawn('/usr/bin/osascript', ['-e', `POSIX path of (choose folder with prompt "${prompt}")`], { stdio: ['ignore', 'pipe', 'pipe'] });
        children.add(child);
        let output = '', errors = '', done = false;
        const finish = (result: DirectoryResult) => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', cancel); children.delete(child); resolve(Date.now() >= expiresAt ? { state: 'expired' } : result); };
        const cancel = () => { child.kill(); finish({ state: 'cancelled' }); };
        const timer = setTimeout(() => { child.kill(); finish({ state: 'expired' }); }, Math.max(0, expiresAt - Date.now())); timer.unref();
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        child.stdout?.on('data', chunk => { output += String(chunk); if (output.length > 16384) { child.kill(); finish({ state: 'failed' }); } });
        child.stderr?.on('data', chunk => { errors = (errors + String(chunk)).slice(-2000); });
        child.on('error', () => finish({ state: 'failed' }));
        child.on('close', code => {
          if (code !== 0) { finish({ state: errors.includes('(-128)') ? 'cancelled' : 'failed' }); return; }
          try { finish({ state: 'selected', path: canonicalDirectory(output.replace(/\r?\n$/, '')) }); }
          catch { finish({ state: 'failed' }); }
        });
      });
    },
    close() { closed = true; for (const child of children) child.kill(); children.clear(); },
  };
}

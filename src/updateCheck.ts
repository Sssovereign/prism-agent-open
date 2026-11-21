// GitHub 更新检测：当前运行源 = 进程工作区的 git HEAD；远端发布源 = origin/main。
// ls-remote 不改写本地仓库（fetch 由 deploy.sh 在更新执行时负责）；非 git 工作区或
// 网络失败都降级为 available:false 并带 error，不阻塞正常 API。
import { execFile } from 'node:child_process';

export interface UpdateCheckResult {
  currentSha: string | null;
  remoteSha: string | null;
  updateAvailable: boolean;
  checkedAt: string;
  error?: string;
}

export interface UpdateCheckOptions {
  /** 单次 git 子进程超时毫秒数；0 = 不设 timeout 句柄（测试用），仍受总硬顶约束 */
  timeoutMs?: number;
}

interface CacheEntry {
  at: number;
  value: UpdateCheckResult;
}

const CACHE_TTL_MS = 60_000;
const GIT_TIMEOUT_MS = 10_000;
/** 总硬顶：execFile 的 timeout 回调在异常路径上有丢失先例（挂死实测），race 兜底保证端点必然返回 */
const HARD_CAP_MS = 15_000;
const cache = new Map<string, CacheEntry>();

function git(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    // timeout=0 时不传该选项：避免 timeout 句柄在 spawn 失败路径上的回调丢失问题
    execFile('git', args, { cwd, windowsHide: true, ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}) }, (error, stdout) => {
      if (error) rejectPromise(error);
      else resolvePromise(String(stdout).trim());
    });
  });
}

async function withHardCap<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), HARD_CAP_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([work, cap]);
  } finally {
    clearTimeout(timer);
  }
}

/** 仅本地 rev-parse，不碰网络：health 端点用，供前端比对刷新信号。 */
export async function readCurrentSha(cwd: string = process.cwd()): Promise<string | null> {
  if (process.env.PRISM_SOURCE_SHA && /^[0-9a-f]{40}$/.test(process.env.PRISM_SOURCE_SHA)) return process.env.PRISM_SOURCE_SHA;
  try {
    const sha = await withHardCap(git(['rev-parse', 'HEAD'], cwd, GIT_TIMEOUT_MS), 'GIT_REV_PARSE');
    return sha || null;
  } catch {
    return null; // 非 git 工作区（历史发布快照）没有版本基线
  }
}

export async function checkForUpdate(cwd: string = process.cwd(), options: UpdateCheckOptions = {}): Promise<UpdateCheckResult> {
  const cached = cache.get(cwd);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const checkedAt = new Date().toISOString();
  const gitTimeout = options.timeoutMs ?? GIT_TIMEOUT_MS;
  let result: UpdateCheckResult;
  try {
    const currentSha = await readCurrentShaWithOptions(cwd, gitTimeout);
    if (!currentSha) {
      result = { currentSha: null, remoteSha: null, updateAvailable: false, checkedAt, error: 'NOT_A_GIT_WORKSPACE' };
    } else {
      const remoteSha = await readRemoteShaWithOptions(cwd, gitTimeout);
      if (!remoteSha) {
        result = { currentSha, remoteSha: null, updateAvailable: false, checkedAt, error: 'REMOTE_UNREACHABLE' };
      } else {
        result = { currentSha, remoteSha, updateAvailable: remoteSha !== currentSha, checkedAt };
      }
    }
  } catch (error) {
    result = { currentSha: null, remoteSha: null, updateAvailable: false, checkedAt, error: error instanceof Error ? error.message : String(error) };
  }
  cache.set(cwd, { at: Date.now(), value: result });
  return result;
}

async function readCurrentShaWithOptions(cwd: string, timeoutMs: number): Promise<string | null> {
  try {
    const sha = await withHardCap(git(['rev-parse', 'HEAD'], cwd, timeoutMs), 'GIT_REV_PARSE');
    return sha || null;
  } catch {
    return null;
  }
}

async function readRemoteShaWithOptions(cwd: string, timeoutMs: number): Promise<string | null> {
  const out = await withHardCap(git(['ls-remote', 'origin', 'refs/heads/main'], cwd, timeoutMs), 'GIT_LS_REMOTE');
  const sha = out.split('\t')[0]?.trim();
  return sha || null;
}

/** 测试用：清空缓存。 */
export function clearUpdateCheckCache(): void {
  cache.clear();
}

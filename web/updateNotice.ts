// 更新提示：前端构建SHA与服务端运行SHA比对（/api/v1/health sourceSha），不一致说明
// 服务端已更新而浏览器仍持旧bundle——提示刷新加载新版本。轮询对齐业界共识（启动一次+
// 周期检查），health为公开端点，未登录也可提示。构建SHA未知（非git工作区构建）不提示。
import { reactive } from 'vue';
import { buildSha } from './buildInfo';

export const POLL_INTERVAL_MS = 5 * 60_000;

interface HealthData {
  productVersion?: string;
  sourceSha?: string | null;
}

export const updateNotice = reactive({
  /** 服务端当前运行的源码SHA（health.sourceSha） */
  serverSha: null as string | null,
  /** 服务端产品版本（提示文案用） */
  serverVersion: '' as string,
  /** 构建SHA与服务端SHA不一致 = 有新版本已部署，刷新生效 */
  refreshNeeded: false,
  /** 用户本轮会话已选择暂不刷新 */
  dismissed: false,
});

export async function pollUpdateOnce(): Promise<void> {
  try {
    const response = await fetch('/api/v1/health', { headers: { Accept: 'application/json' } });
    if (!response.ok) return;
    const body = (await response.json()) as { data?: HealthData };
    const data = body.data;
    if (!data) return;
    updateNotice.serverSha = data.sourceSha ?? null;
    updateNotice.serverVersion = data.productVersion ?? '';
    // health.sourceSha 是 40 位全 SHA，构建烘焙的是 12 位短 SHA——用前缀比对判同构建，
    // 严格不等号会让新页面也永远弹横幅。
    const sameBuild = !!updateNotice.serverSha
      && buildSha !== 'unknown'
      && updateNotice.serverSha.startsWith(buildSha);
    updateNotice.refreshNeeded = !!updateNotice.serverSha && buildSha !== 'unknown' && !sameBuild;
    if (!updateNotice.refreshNeeded) updateNotice.dismissed = false;
  } catch {
    // 网络抖动/服务重启窗口静默跳过，下轮再试
  }
}

let started = false;
export function startUpdatePolling(): void {
  if (started) return;
  started = true;
  void pollUpdateOnce();
  setInterval(() => { void pollUpdateOnce(); }, POLL_INTERVAL_MS);
}

export function dismissUpdateNotice(): void {
  updateNotice.dismissed = true;
}

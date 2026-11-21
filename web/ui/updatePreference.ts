import type { UpdatesStatus } from '../updates.js';

// 独立于宿主实现，让已有宿主也能通过业务包取得正确的更新入口。
function compareVersion(left: string, right: string): number | null {
  const parse = (value: string) => value.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  const a = parse(left), b = parse(right);
  if (!a || !b) return null;
  for (const i of [1, 2, 3]) { const diff = Number(a[i]) - Number(b[i]); if (diff) return diff; }
  if (!a[4] || !b[4]) return a[4] ? -1 : b[4] ? 1 : 0;
  const x = a[4].split('.'), y = b[4].split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const l = x[i], r = y[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r);
    if (ln && rn) { const diff = Number(l) - Number(r); if (diff) return diff; continue; }
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

export function updatePreference(status: UpdatesStatus | null) {
  const shell = status?.shellUpdate ?? null;
  const shellActive = !!shell && ['available', 'downloading', 'downloaded', 'installing'].includes(shell.phase);
  // shell（完整应用静默更新）进行中时优先展示；业务包流程未开始且无手动安装包操作在途才让位。
  const shellMode = shellActive && !!status && !status.available && !status.pendingApply
    && !['checking', 'downloading', 'verifying', 'ready', 'waiting-idle'].includes(status.phase)
    && !(!!status.installerDownload && ['downloading', 'verifying', 'ready'].includes(status.installerDownload.phase));
  const full = status?.fullUpdate;
  const download = status?.installerDownload;
  const matching = full && download?.productVersion === full.productVersion ? download : null;
  const inProgress = matching && ['downloading', 'verifying', 'ready'].includes(matching.phase);
  const comparison = full && status ? compareVersion(full.productVersion, status.activeBusinessVersion || status.businessVersion) : null;
  // 已经开始的完整包操作保留；其余情况优先兼容业务包，且不重复推送已取得的业务版本。
  const offerInstaller = !shellMode && !!full && (!!inProgress || (!status?.available && (comparison === null || comparison > 0)));
  const installer = offerInstaller ? matching : null;
  const basePhase = status?.phase === 'installer-available' && !offerInstaller
    ? status.available ? 'available' : 'up-to-date'
    : status?.phase ?? null;
  const phase = shellMode && shell ? `shell-${shell.phase}` : basePhase;
  return { offerInstaller, installer, phase, shell: shellMode ? shell : null, shellMode };
}

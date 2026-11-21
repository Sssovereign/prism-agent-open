// 更新本地存储：<userData>/updates/ 下的状态、暂存与发布记录。
// 同卷「临时文件 + rename」保证原子性；正式数据目录不在此树内，更新失败不触碰用户数据。
'use strict';
const { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');

function validReleaseId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error('RELEASE_ID_INVALID');
  return id;
}

function writeJsonAtomic(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, file); // 同卷 rename 原子生效
}

function readJson(file, fallback = null) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback; // 记录损坏按缺省处理，调用方按「无记录」走回退路径
  }
}

class UpdateStore {
  constructor(rootDir) {
    this.root = rootDir;
    this.stagingDir = join(rootDir, 'staging');
    this.releasesDir = join(rootDir, 'releases');
    this.snapshotsDir = join(rootDir, 'snapshots');
    this.stateFile = join(rootDir, 'state.json');
    this.pendingFile = join(rootDir, 'pending.json');
    mkdirSync(this.stagingDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.releasesDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.snapshotsDir, { recursive: true, mode: 0o700 });
  }

  readState() {
    const state = readJson(this.stateFile, null);
    return {
      highestAcceptedSequence: Number.isSafeInteger(state?.highestAcceptedSequence) && state.highestAcceptedSequence >= 0 ? state.highestAcceptedSequence : 0,
      activeReleaseId: typeof state?.activeReleaseId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(state.activeReleaseId) ? state.activeReleaseId : null,
      lastGoodReleaseId: typeof state?.lastGoodReleaseId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(state.lastGoodReleaseId) ? state.lastGoodReleaseId : null,
      channel: state?.channel === 'stable' ? 'stable' : 'beta',
      checkedAt: state?.checkedAt ?? null,
    };
  }

  writeState(patch) {
    const next = { ...this.readState(), ...patch };
    writeJsonAtomic(this.stateFile, next);
    return next;
  }

  readPending() { return readJson(this.pendingFile, null); }
  writePending(record) { writeJsonAtomic(this.pendingFile, record); }
  clearPending() { rmSync(this.pendingFile, { force: true }); }

  releaseDir(releaseId) { return join(this.releasesDir, validReleaseId(releaseId)); }
  workspaceOf(releaseId) { return join(this.releaseDir(releaseId), 'workspace'); }
  manifestFileOf(releaseId) { return join(this.releaseDir(releaseId), 'manifest.json'); }

  readReleaseRecord(releaseId) {
    return readJson(join(this.releaseDir(releaseId), 'release.json'), null);
  }

  /** 写发布记录（status: ready|activated|failed），连同 manifest 一起固化。 */
  writeReleaseRecord(releaseId, record) {
    writeJsonAtomic(join(this.releaseDir(releaseId), 'release.json'), { updatedAt: new Date().toISOString(), ...record });
  }

  /** 暂存下载用随机文件名，避免并发与残留覆盖。 */
  stagingFile() { return join(this.stagingDir, `pack-${randomBytes(8).toString('hex')}.tar.gz`); }

  cleanupStaging() {
    for (const name of readdirSync(this.stagingDir)) {
      try { rmSync(join(this.stagingDir, name), { recursive: true, force: true }); } catch { /* 下轮再清 */ }
    }
  }

  /** 淘汰业务包：只删既非 active 也非 lastGood 的已记录发布目录。 */
  pruneReleases() {
    const state = this.readState();
    const keep = new Set([state.activeReleaseId, state.lastGoodReleaseId].filter(Boolean));
    for (const name of readdirSync(this.releasesDir)) {
      if (keep.has(name)) continue;
      try { rmSync(join(this.releasesDir, name), { recursive: true, force: true }); } catch { /* 下轮再清 */ }
    }
  }

  /** 只保留最近一份过渡快照（切换成功后清理上一份）。 */
  pruneSnapshots(keepReleaseId) {
    for (const name of readdirSync(this.snapshotsDir)) {
      if (name === keepReleaseId) continue;
      try { rmSync(join(this.snapshotsDir, name), { recursive: true, force: true }); } catch { /* 下轮再清 */ }
    }
  }
}

module.exports = { UpdateStore, writeJsonAtomic, readJson, validReleaseId };

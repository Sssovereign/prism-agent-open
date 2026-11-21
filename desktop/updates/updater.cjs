// 业务资源包更新器（主进程侧状态机）：发现→验签→下载→受限解包→逐文件校验→ready→应用确认。
// 完整成功前不改当前版本指针；确认/失败由宿主（main.cjs）在健康门禁后回调。
'use strict';
const { createHash } = require('node:crypto');
const { readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, renameSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { EventEmitter } = require('node:events');
const { extractTarGz, readTarGzFile, DEFAULT_CAPS } = require('./tar.cjs');
const { validateManifest, sequenceAccepted, compareVersions, parseVersion, satisfiesShellVersionRange } = require('./manifest.cjs');
const { verifyBytes } = require('./keys.cjs');
const { FeedError, listReleases, fetchBuffer, downloadToFile, downloadGuardFor, MAX_MANIFEST_PROBES } = require('./feed.cjs');
const { UpdateStore } = require('./store.cjs');
const { InstallerDownload } = require('./installer.cjs');

const AUTO_INITIAL_DELAY_MS = 3 * 60_000;
const AUTO_INTERVAL_MS = 6 * 60 * 60_000;
const AUTO_BACKOFF_MAX_MS = 24 * 60 * 60_000;
const MANIFEST_BYTES_CAP = 1024 * 1024;
const SIGNATURE_BYTES_CAP = 64 * 1024;

class UpdaterError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; }
}

/** 逐文件复核工作区与清单一致（启动复核与应用前复核共用）。node_modules 由宿主管理，不在包内。 */
function verifyWorkspaceFiles(workspaceDir, manifest, caps = DEFAULT_CAPS) {
  const expected = new Map(manifest.files.map(file => [file.path, file]));
  let seen = 0;
  let total = 0;
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' && dir === workspaceDir) continue;
      const full = join(dir, entry.name);
      const relative = full.slice(workspaceDir.length + 1).replaceAll('\\', '/');
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const file = expected.get(relative);
        if (!file) throw new UpdaterError('VERIFY_UNEXPECTED_FILE', relative);
        const size = statSync(full).size;
        if (size !== file.size) throw new UpdaterError('VERIFY_SIZE_MISMATCH', relative);
        total += size;
        if (total > caps.maxTotalBytes) throw new UpdaterError('VERIFY_TOTAL_TOO_LARGE');
        const digest = createHash('sha256').update(readFileSync(full)).digest('hex');
        if (digest !== file.sha256) throw new UpdaterError('VERIFY_HASH_MISMATCH', relative);
        seen += 1;
        if (seen > caps.maxFiles) throw new UpdaterError('VERIFY_TOO_MANY_FILES');
      } else throw new UpdaterError('VERIFY_SPECIAL_ENTRY', relative);
    }
  };
  if (!existsDir(workspaceDir)) throw new UpdaterError('VERIFY_WORKSPACE_MISSING', workspaceDir);
  walk(workspaceDir);
  if (seen !== manifest.files.length) throw new UpdaterError('VERIFY_COUNT_MISMATCH', `${seen}/${manifest.files.length}`);
}

function existsDir(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

class PrismUpdater extends EventEmitter {
  /**
   * hostIdentity：{ platform, arch, channel, hostVersion, businessVersion,
   * runtimeCompatibilityId, updatesPublicKey, updatesKeyId }；
   * feed：{ githubRepo } 或 { localFeedUrl, localFeedAssetBase }（仅隔离测试）。
   */
  constructor({ userDataDir, hostIdentity, feed, caps = DEFAULT_CAPS, onLog }) {
    super();
    this.store = new UpdateStore(join(userDataDir, 'updates'));
    this.host = hostIdentity;
    this.feed = feed;
    this.caps = caps;
    this.onLog = typeof onLog === 'function' ? onLog : null;
    this.phase = 'idle';
    this.available = null;
    this.fullUpdate = null;
    this.downloadProgress = null;
    this.lastError = null;
    this.checking = false;
    this.opLock = Promise.resolve();
    this.autoTimer = null;
    this.disposed = false;
    this.autoBackoffMs = AUTO_INTERVAL_MS;
    this.discovered = [];
    this.guard = downloadGuardFor(feed.localFeedUrl ? { localFeedUrl: feed.localFeedUrl } : { githubRepo: feed.githubRepo });
    this.installer = new InstallerDownload(join(this.store.root, 'installers'), this.guard);
    this.installer.on('state', () => this.emitState());
    // 完整安装包装完不会自动消失，残留会无限堆积（0.1.3 收尾时单机实测 530MB/699MB）：
    // 启动时清掉 ≤ 当前版本的包与中断残留；待装的新版本保留。仅打包版（有更新身份）执行，dev 不动。
    if (this.host.updatesPublicKey) {
      try {
        const pruned = this.installer.pruneInstalled(this.host.hostVersion);
        if (pruned.length) this.onLog?.(`已清理 ${pruned.length} 份已安装或失效的残留安装包：${pruned.join(', ')}`);
      } catch { /* 清理失败不影响更新功能 */ }
    }
  }

  // —— 状态快照 —— //

  getStatus() {
    const state = this.store.readState();
    const active = state.activeReleaseId ? this.store.readReleaseRecord(state.activeReleaseId) : null;
    const pendingApply = this.store.readPending();
    return {
      phase: this.phase,
      supported: !!this.host.updatesPublicKey,
      channel: state.channel,
      hostVersion: this.host.hostVersion,
      businessVersion: this.host.businessVersion,
      activeReleaseId: state.activeReleaseId,
      activeBusinessVersion: this.host.businessVersion,
      lastGoodReleaseId: state.lastGoodReleaseId,
      checkedAt: state.checkedAt,
      available: this.available,
      fullUpdate: this.fullUpdate,
      installerDownload: this.installer.status(),
      downloadProgress: this.downloadProgress,
      lastError: this.lastError,
      pendingApply: pendingApply ? { releaseId: pendingApply.releaseId, startedAt: pendingApply.startedAt } : null,
    };
  }

  emitState() { this.emit('state', this.getStatus()); }

  setPhase(phase) {
    this.phase = phase;
    if (phase !== 'error') this.lastError = null;
    this.emitState();
  }

  serialize(op) {
    const run = this.opLock.then(op);
    this.opLock = run.catch(() => {});
    return run;
  }

  assetUrl(tag, assetName) {
    if (this.feed.localFeedUrl) return `${this.feed.localFeedAssetBase}${tag}/${assetName}`;
    return `https://github.com/${this.feed.githubRepo}/releases/download/${tag}/${assetName}`;
  }

  /** 拉发行列表并按通道过滤；返回按 SemVer 倒序的候选。 */
  async fetchCandidates() {
    const releases = await listReleases({ githubRepo: this.feed.githubRepo, localFeedUrl: this.feed.localFeedUrl });
    const channelOk = this.host.channel === 'stable' ? release => !release.prerelease : () => true;
    return releases
      .filter(release => release.tag && parseVersion(release.tag))
      .filter(channelOk)
      .sort((a, b) => compareVersions(b.tag, a.tag));
  }

  /** 校验一份（未信任的）清单字节 + 签名 + 兼容条件；通过返回 manifest。 */
  verifyManifestBytes({ manifestBytes, signatureBytes }) {
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new UpdaterError('MANIFEST_JSON_INVALID'); }
    validateManifest(manifest, this.caps);
    if (!this.host.updatesPublicKey) throw new UpdaterError('TRUST_ROOT_MISSING');
    if (manifest.keyId !== this.host.updatesKeyId) throw new UpdaterError('KEY_ID_MISMATCH', `${manifest.keyId}≠${this.host.updatesKeyId}`);
    if (!verifyBytes(this.host.updatesPublicKey, manifestBytes, signatureBytes.toString('utf8').trim())) throw new UpdaterError('SIGNATURE_INVALID');
    if (manifest.platform !== this.host.platform) throw new UpdaterError('PLATFORM_MISMATCH', manifest.platform);
    if (manifest.arch !== this.host.arch) throw new UpdaterError('ARCH_MISMATCH', manifest.arch);
    if (manifest.channel !== this.host.channel) throw new UpdaterError('CHANNEL_MISMATCH', manifest.channel);
    if (manifest.runtimeCompatibilityId !== this.host.runtimeCompatibilityId) {
      throw new UpdaterError('INCOMPATIBLE_RUNTIME', `${manifest.runtimeCompatibilityId}≠${this.host.runtimeCompatibilityId}`);
    }
    if (!satisfiesShellVersionRange(this.host.hostVersion, manifest.shellVersionRange)) throw new UpdaterError('SHELL_RANGE_REJECTED', manifest.shellVersionRange);
    return manifest;
  }

  async fetchManifestPair(tag) {
    const manifestBytes = await fetchBuffer(this.assetUrl(tag, `manifest-${this.host.platform}-${this.host.arch}.json`),
      { Accept: 'application/json', 'User-Agent': 'prism-updater' }, this.guard, MANIFEST_BYTES_CAP);
    const signatureBytes = await fetchBuffer(this.assetUrl(tag, `manifest-${this.host.platform}-${this.host.arch}.json.sig`),
      { Accept: 'application/octet-stream', 'User-Agent': 'prism-updater' }, this.guard, SIGNATURE_BYTES_CAP);
    return { manifestBytes, signatureBytes };
  }

  checkNow({ manual = false } = {}) {
    return this.serialize(async () => {
      if (this.checking) return this.getStatus();
      this.checking = true;
      this.setPhase('checking');
      try {
        const state = this.store.readState();
        const candidates = await this.fetchCandidates();
        this.discovered = candidates;
        const installerName = version => this.host.platform === 'darwin'
          ? `Prism-${version}-mac-${this.host.arch}.dmg` : `Prism-Setup-${version}-win-${this.host.arch}.exe`;
        const fullRelease = candidates.find(release => compareVersions(release.tag, this.host.hostVersion) > 0
          && release.assetNames?.includes(installerName(release.tag.replace(/^v/, ''))));
        this.fullUpdate = fullRelease ? { productVersion: fullRelease.tag.replace(/^v/, ''),
          url: this.feed.localFeedUrl ? `${this.feed.localFeedAssetBase}${fullRelease.tag}/${installerName(fullRelease.tag.replace(/^v/, ''))}`
            : `https://github.com/${this.feed.githubRepo}/releases/tag/${fullRelease.tag}` } : null;
        if (fullRelease) {
          const name = installerName(fullRelease.tag.replace(/^v/, ''));
          const asset = fullRelease.assets?.find(asset => asset.name === name);
          this.fullUpdate = { ...this.fullUpdate, name, size: asset?.size, digest: asset?.digest, downloadUrl: this.assetUrl(fullRelease.tag, name) };
        }
        let found = null;
        let probed = 0;
        for (const release of candidates) {
          if (probed >= MAX_MANIFEST_PROBES) break;
          let manifest;
          try {
            const pair = await this.fetchManifestPair(release.tag);
            manifest = this.verifyManifestBytes(pair);
          } catch (error) {
            if (error instanceof FeedError && error.code === 'FEED_NOT_FOUND') { probed += 1; continue; } // 该发行无本平台资源包
            if (['INCOMPATIBLE_RUNTIME', 'SHELL_RANGE_REJECTED'].includes(error.code)) { probed += 1; continue; }
            throw error;
          }
          probed += 1;
          const allowed = sequenceAccepted(manifest.updateSequence, state.highestAcceptedSequence,
            { releaseId: manifest.releaseId, activeReleaseId: state.activeReleaseId, lastGoodReleaseId: state.lastGoodReleaseId });
          if (!allowed) continue; // 已接受／更旧：继续看更早发行
          if (release.assetNames && ![manifest.package.file, `manifest-${this.host.platform}-${this.host.arch}.json`, `manifest-${this.host.platform}-${this.host.arch}.json.sig`].every(name => release.assetNames.includes(name))) continue;
          if (compareVersions(manifest.productVersion, release.tag) !== 0) throw new UpdaterError('RELEASE_VERSION_MISMATCH');
          if (compareVersions(manifest.productVersion, this.host.businessVersion) <= 0) continue;
          found = {
            releaseId: manifest.releaseId, tag: release.tag, productVersion: manifest.productVersion,
            updateSequence: manifest.updateSequence, notes: release.notes, publishedAt: release.publishedAt,
          };
          break;
        }
        this.available = found;
        this.store.writeState({ checkedAt: new Date().toISOString() });
        this.autoBackoffMs = AUTO_INTERVAL_MS;
        this.setPhase(found ? 'available' : this.fullUpdate ? 'installer-available' : 'up-to-date');
        if (manual && !found && !this.fullUpdate) this.emit('up-to-date');
      } catch (error) {
        this.lastError = { code: error.code ?? 'CHECK_FAILED', message: error.message, at: new Date().toISOString() };
        this.setPhase('error');
        this.autoBackoffMs = Math.min(this.autoBackoffMs * 2, AUTO_BACKOFF_MAX_MS);
        // 失败落宿主日志：UI 状态之外，事后排查 desktop.log 也要有据可查（2026-11-18 审计）
        this.onLog?.(`后台更新检查失败：${error.message}；${Math.round(this.autoBackoffMs / 60_000)}分钟后重试`);
        this.scheduleAutoCheck(this.autoBackoffMs);
      } finally {
        this.checking = false;
        if (!this.disposed) this.scheduleAutoCheck(this.autoBackoffMs);
      }
      return this.getStatus();
    });
  }

  // —— 下载与暂存 —— //

  downloadInstaller() {
    return this.serialize(async () => {
      await this.installer.download(this.fullUpdate);
      return this.getStatus();
    });
  }

  download(releaseId) {
    return this.serialize(async () => {
      const tag = this.available?.releaseId === releaseId ? this.available.tag
        : this.discovered.find(item => item.tag === releaseId)?.tag ?? null;
      if (!tag) throw new UpdaterError('DOWNLOAD_TARGET_UNKNOWN', releaseId);
      this.setPhase('downloading');
      try {
        const release = this.discovered.find(item => item.tag === tag);
        const { manifestBytes, signatureBytes } = await this.fetchManifestPair(tag);
        const manifest = this.verifyManifestBytes({ manifestBytes, signatureBytes });
        if (manifest.releaseId !== releaseId) throw new UpdaterError('DOWNLOAD_TARGET_MISMATCH', manifest.releaseId);
        if (this.store.readState().activeReleaseId === releaseId || this.store.readState().lastGoodReleaseId === releaseId) throw new UpdaterError('DOWNLOAD_ACTIVE_RELEASE');
        const staging = this.store.stagingFile();
        this.downloadProgress = { releaseId, receivedBytes: 0, totalBytes: manifest.package.size };
        this.emitState();
        const downloaded = await downloadToFile(this.assetUrl(tag, manifest.package.file), this.guard, staging, manifest.package.size, progress => {
          this.downloadProgress = { releaseId, receivedBytes: progress.receivedBytes, totalBytes: manifest.package.size };
          this.emitState();
        });
        if (downloaded.size !== manifest.package.size || downloaded.sha256 !== manifest.package.sha256) {
          throw new UpdaterError('PACKAGE_DIGEST_MISMATCH', `${downloaded.sha256}≠${manifest.package.sha256}`);
        }
        this.setPhase('verifying');
        const archive = await readTarGzFile(staging, this.caps);
        rmSync(staging, { force: true });
        const releaseDir = this.store.releaseDir(manifest.releaseId);
        const candidateDir = mkdtempSync(join(this.store.stagingDir, 'unpack-'));
        const workspaceDir = join(candidateDir, 'workspace');
        const extracted = extractTarGz(archive, workspaceDir, this.caps);
        const expected = new Map(manifest.files.map(file => [file.path, file]));
        if (extracted.files.length !== expected.size) throw new UpdaterError('EXTRACT_COUNT_MISMATCH');
        for (const file of extracted.files) {
          const want = expected.get(file.path);
          if (!want || want.size !== file.size || want.sha256 !== file.sha256) throw new UpdaterError('EXTRACT_FILE_MISMATCH', file.path);
        }
        writeFileSync(join(candidateDir, 'manifest.json'), manifestBytes, { mode: 0o600 });
        writeFileSync(join(candidateDir, 'manifest.sig'), signatureBytes, { mode: 0o600 });
        rmSync(releaseDir, { recursive: true, force: true });
        renameSync(candidateDir, releaseDir);
        this.store.writeReleaseRecord(manifest.releaseId, { status: 'ready', manifest, verifiedAt: new Date().toISOString() });
        this.store.cleanupStaging();
        this.available = { releaseId: manifest.releaseId, tag, productVersion: manifest.productVersion, updateSequence: manifest.updateSequence, notes: release?.notes ?? '', publishedAt: release?.publishedAt ?? null };
        this.downloadProgress = null;
        this.setPhase('ready');
        return this.getStatus();
      } catch (error) {
        this.store.cleanupStaging();
        this.downloadProgress = null;
        this.lastError = { code: error.code ?? 'DOWNLOAD_FAILED', message: error.message, at: new Date().toISOString() };
        this.setPhase('error');
        throw error;
      }
    });
  }

  // —— 应用（宿主驱动；这里维护记录、序号与证据） —— //

  /** 应用前复核：ready/activated 状态 + 清单签名 + 工作区逐文件一致。返回 manifest。 */
  preApplyCheck(releaseId, { allowRollback = false } = {}) {
    const record = this.store.readReleaseRecord(releaseId);
    const status = record?.status;
    const localState = this.store.readState();
    const localRollback = allowRollback && [localState.activeReleaseId, localState.lastGoodReleaseId].includes(releaseId);
    if (status !== 'ready' && status !== 'activated' && !(localRollback && status === 'replaced')) throw new UpdaterError('APPLY_TARGET_NOT_READY', `${releaseId}:${status ?? 'missing'}`);
    const manifestBytes = readFileSync(this.store.manifestFileOf(releaseId));
    const signatureBytes = readFileSync(join(this.store.releaseDir(releaseId), 'manifest.sig'));
    const manifest = this.verifyManifestBytes({ manifestBytes, signatureBytes });
    if (manifest.releaseId !== releaseId) throw new UpdaterError('RELEASE_ID_MISMATCH');
    const state = this.store.readState();
    if (!localRollback && !sequenceAccepted(manifest.updateSequence, state.highestAcceptedSequence,
      { releaseId, activeReleaseId: state.activeReleaseId, lastGoodReleaseId: state.lastGoodReleaseId })) {
      throw new UpdaterError('SEQUENCE_REJECTED', String(manifest.updateSequence));
    }
    verifyWorkspaceFiles(this.store.workspaceOf(releaseId), manifest, this.caps);
    return manifest;
  }

  /** 健康门禁通过后由宿主调用：确认切换，推进 active/lastGood/最高序号，淘汰旧包。 */
  confirmApply(releaseId) {
    const record = this.store.readReleaseRecord(releaseId);
    if (!record?.manifest) throw new UpdaterError('APPLY_TARGET_UNKNOWN', releaseId);
    const state = this.store.readState();
    const previousActive = state.activeReleaseId;
    this.store.writeReleaseRecord(releaseId, { status: 'activated', manifest: record.manifest, activatedAt: new Date().toISOString() });
    if (previousActive && previousActive !== releaseId) {
      const previousRecord = this.store.readReleaseRecord(previousActive);
      this.store.writeReleaseRecord(previousActive, { status: 'replaced', manifest: previousRecord?.manifest ?? null });
    }
    this.store.writeState({
      activeReleaseId: releaseId,
      lastGoodReleaseId: previousActive && previousActive !== releaseId ? previousActive : state.lastGoodReleaseId,
      highestAcceptedSequence: Math.max(state.highestAcceptedSequence, record.manifest.updateSequence),
    });
    this.store.clearPending();
    try { this.store.pruneReleases(); } catch { /* 清理不影响已确认版本 */ }
    this.available = null;
    this.setPhase('idle');
  }

  /** 健康门禁失败后由宿主调用：保留证据；宿主负责重启旧工作区。 */
  failApply(releaseId, reason, { markFailed = true } = {}) {
    const record = this.store.readReleaseRecord(releaseId);
    if (markFailed && record?.manifest) this.store.writeReleaseRecord(releaseId, { status: 'failed', manifest: record.manifest, failedAt: new Date().toISOString(), reason: String(reason).slice(0, 500) });
    this.store.clearPending();
    this.lastError = { code: 'APPLY_FAILED', message: String(reason).slice(0, 300), at: new Date().toISOString() };
    this.setPhase('error');
  }

  // —— 后台检查：启动延迟一次，此后固定间隔；失败指数退避 —— //

  scheduleAutoCheck(delayMs = AUTO_INITIAL_DELAY_MS) {
    if (this.disposed) return;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = setTimeout(() => { void this.checkNow().catch(() => {}); }, delayMs);
    this.autoTimer.unref?.();
  }

  dispose() {
    this.disposed = true;
    if (this.autoTimer) clearTimeout(this.autoTimer);
  }
}

module.exports = { PrismUpdater, UpdaterError, verifyWorkspaceFiles, AUTO_INITIAL_DELAY_MS, AUTO_INTERVAL_MS };

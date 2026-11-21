// 完整安装包只下载并校验；打开文件须经独立的用户操作，不切换业务包或终止任务。
'use strict';
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { createReadStream, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } = require('node:fs');
const { join, dirname, relative, resolve, isAbsolute } = require('node:path');
const { downloadToFile } = require('./feed.cjs');
const { compareVersions } = require('./manifest.cjs');
const MAX_INSTALLER_BYTES = 4 * 1024 * 1024 * 1024;
const INSTALLER_NAME_PATTERN = /^Prism-(?:Setup-)?([0-9A-Za-z.+-]+)-(?:mac-arm64|win-x64)\.(?:dmg|exe)$/;

/** 从安装包文件名提取版本（如 0.1.3-beta）；非安装包文件返回 null。 */
function installerVersion(fileName) {
  const match = INSTALLER_NAME_PATTERN.exec(fileName);
  return match ? match[1] : null;
}

class InstallerDownload extends EventEmitter {
  constructor(root, guard) { super(); this.root = root; this.guard = guard; this.state = null; this.file = null; this.target = null; }
  status() { return this.state ? { ...this.state } : null; }
  notify(patch) { this.state = { ...this.state, ...patch }; this.emit('state'); }
  async download(target) {
    if (!target || !/^Prism-(?:Setup-)?[0-9A-Za-z.+-]+\.(?:dmg|exe)$/.test(target.name)
      || !Number.isSafeInteger(target.size) || target.size <= 0 || target.size > MAX_INSTALLER_BYTES
      || !/^sha256:[a-f0-9]{64}$/.test(target.digest ?? '')) throw new Error('INSTALLER_METADATA_INVALID');
    this.guard(target.downloadUrl);
    if (this.state?.phase === 'ready' && this.target?.digest === target.digest) {
      await this.verifiedPath(); return this.status();
    }
    const previous = this.file;
    this.file = null; this.target = { ...target };
    this.state = { phase: 'downloading', productVersion: target.productVersion, name: target.name, receivedBytes: 0, totalBytes: target.size, error: null };
    this.notify({});
    let dir;
    let lastProgress = 0;
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      dir = mkdtempSync(join(this.root, 'installer-'));
      const part = join(dir, `${target.name}.part`);
      const result = await downloadToFile(target.downloadUrl, this.guard, part, target.size, progress => {
        const now = Date.now();
        if (now - lastProgress >= 150 || progress.receivedBytes === target.size) {
          lastProgress = now; this.notify({ receivedBytes: progress.receivedBytes });
        }
      }, 30 * 60_000);
      this.notify({ phase: 'verifying', receivedBytes: result.size });
      if (result.size !== target.size || `sha256:${result.sha256}` !== target.digest) throw new Error('INSTALLER_DIGEST_MISMATCH');
      this.file = join(dir, target.name); renameSync(part, this.file);
      this.notify({ phase: 'ready' });
      if (previous) rmSync(dirname(previous), { recursive: true, force: true });
    } catch (error) {
      this.file = null; if (dir) rmSync(dir, { recursive: true, force: true });
      this.notify({ phase: 'error', error: error.code ?? error.message });
    }
    return this.status();
  }
  readyPath() {
    if (!this.file || this.state?.phase !== 'ready') throw new Error('INSTALLER_NOT_READY');
    const rel = relative(resolve(this.root), resolve(this.file));
    const stat = lstatSync(this.file);
    if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)
      || !stat.isFile() || stat.isSymbolicLink() || lstatSync(dirname(this.file)).isSymbolicLink()
      || stat.size !== this.target.size) throw new Error('INSTALLER_DIGEST_MISMATCH');
    return this.file;
  }
  async verifiedPath() {
    try {
      const file = this.readyPath();
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      if (`sha256:${hash.digest('hex')}` !== this.target.digest) throw new Error('INSTALLER_DIGEST_MISMATCH');
      return this.file;
    } catch (error) {
      if (this.file) { rmSync(dirname(this.file), { recursive: true, force: true }); this.file = null; }
      if (this.state) this.notify({ phase: 'error', error: error.code ?? error.message });
      throw error;
    }
  }
  /**
   * 清理已安装版本的残留安装包：≤ 当前运行版本的包已无用（用户已在运行该版本或更新），
   * 中断的 .part 与孤儿目录一并删除；比当前版本新的下载件是待装包，保留（同版本多份只留最新）。
   * currentVersion 不可解析时直接抛出（调用方兜底跳过），本方法自身逐目录容错。
   */
  pruneInstalled(currentVersion) {
    const removed = [];
    let entries;
    try { entries = readdirSync(this.root, { withFileTypes: true }); } catch { return removed; }
    const pending = new Map(); // 未来版本 -> [{dir,name,mtime}]
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^installer-[A-Za-z0-9_-]+$/.test(entry.name)) continue;
      const dir = join(this.root, entry.name);
      let files;
      try { files = readdirSync(dir).filter(name => !name.startsWith('.')); } catch { continue; }
      const installer = files.find(name => INSTALLER_NAME_PATTERN.test(name));
      const version = installer ? installerVersion(installer) : null;
      if (!installer || !version || compareVersions(version, currentVersion) <= 0) {
        try { rmSync(dir, { recursive: true, force: true }); removed.push(entry.name); } catch { /* 占用等下一轮再清 */ }
        continue;
      }
      const list = pending.get(version) ?? [];
      list.push({ dir, name: entry.name, mtime: statSync(dir).mtimeMs });
      pending.set(version, list);
    }
    for (const list of pending.values()) {
      list.sort((a, b) => a.mtime - b.mtime);
      for (const stale of list.slice(0, -1)) {
        try { rmSync(stale.dir, { recursive: true, force: true }); removed.push(stale.name); } catch { /* 下一轮再清 */ }
      }
    }
    return removed;
  }
}
module.exports = { InstallerDownload, MAX_INSTALLER_BYTES, installerVersion };

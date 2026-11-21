import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UpdatesStatus } from '../web/updates.js';
import { updatePreference } from '../web/ui/updatePreference.js';

function status(patch: Partial<UpdatesStatus> = {}): UpdatesStatus {
  return { phase: 'installer-available', supported: true, channel: 'beta', hostVersion: '0.1.0-beta', businessVersion: '0.1.0-beta', activeBusinessVersion: '0.1.0-beta', activeReleaseId: null, lastGoodReleaseId: null, checkedAt: null, available: null, downloadProgress: null, lastError: null, pendingApply: null,
    fullUpdate: { productVersion: '0.1.1-beta', url: 'https://example.com/release' }, ...patch };
}
const available = { releaseId: 'next', tag: 'v0.1.1-beta', productVersion: '0.1.1-beta', updateSequence: 6, notes: '', publishedAt: null };

test('同一版本同时有业务包和安装包时优先小包，真正不兼容才提示整包', () => {
  assert.equal(updatePreference(status({ phase: 'available', available })).offerInstaller, false);
  assert.equal(updatePreference(status({ available })).phase, 'available');
  assert.equal(updatePreference(status()).offerInstaller, true);
  assert.equal(updatePreference(null).offerInstaller, false);
});
test('业务包已升级后不再按旧宿主版本重复推送整包，识别预发布和数字版本', () => {
  for (const version of ['0.1.1-beta', '0.1.1', '0.1.2-beta', '0.1.10-beta']) {
    const result = updatePreference(status({ activeBusinessVersion: version }));
    assert.equal(result.offerInstaller, false, version);
    assert.equal(result.phase, 'up-to-date');
  }
  assert.equal(updatePreference(status({ activeBusinessVersion: '0.1.1-beta.2', fullUpdate: { productVersion: '0.1.1-beta.10', url: '' } })).offerInstaller, true);
  assert.equal(updatePreference(status({ activeBusinessVersion: 'unknown' })).offerInstaller, true, '未知版本不静默隐藏整包入口');
});
test('用户已开始的整包下载、校验和就绪状态保留，旧目标或失败不遮挡小包', () => {
  for (const phase of ['downloading', 'verifying', 'ready', 'error'] as const) {
    const installerDownload = { phase, productVersion: '0.1.1-beta', name: 'Prism.exe', receivedBytes: 10, totalBytes: 100, error: null };
    const result = updatePreference(status({ available, installerDownload }));
    assert.equal(result.offerInstaller, phase !== 'error');
    assert.equal(!!result.installer, phase !== 'error');
    assert.equal(updatePreference(status({ available, installerDownload: { ...installerDownload, productVersion: '0.0.9-beta' } })).installer, null);
  }
});

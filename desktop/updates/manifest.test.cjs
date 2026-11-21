// 清单回归：SemVer 比较、白名单校验、shell 范围、递增序号与同号白名单。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseVersion, compareVersions, validateShellVersionRange, satisfiesShellVersionRange, validateManifest, sequenceAccepted } = require('./manifest.cjs');

const SHA64 = 'a'.repeat(64);
const SHA40 = 'b'.repeat(40);

function validManifest(overrides = {}) {
  return {
    manifestVersion: 1,
    releaseId: 'r-0.0.6-beta-2',
    productVersion: '0.0.6-beta',
    updateSequence: 2,
    sourceSha: SHA40,
    channel: 'beta',
    platform: 'darwin',
    arch: 'arm64',
    runtimeCompatibilityId: 'node24.abc123456789.m12345678',
    shellVersionRange: '>=0.0.5-beta <0.1.0',
    productionDependenciesHash: SHA64,
    databaseSchemaVersion: 24,
    keyId: 'prism-updates-beta',
    package: { file: 'prism-update-0.0.6-beta-darwin-arm64.tar.gz', size: 123456, sha256: SHA64 },
    files: [
      { path: 'desktop/backend.mjs', size: 10, sha256: SHA64 },
      { path: 'package.json', size: 10, sha256: SHA64 },
      { path: 'dist/src/app.js', size: 10, sha256: SHA64 },
    ],
    ...overrides,
  };
}

test('版本比较：SemVer 预发布排序正确', () => {
  assert.deepEqual(parseVersion('v0.0.5-beta'), { major: 0, minor: 0, patch: 5, prerelease: 'beta', raw: 'v0.0.5-beta' });
  assert.equal(compareVersions('0.0.5-beta', '0.0.4-beta'), 1);
  assert.equal(compareVersions('0.0.10-beta', '0.0.9-beta'), 1);
  assert.equal(compareVersions('0.0.5-beta', '0.0.5'), -1); // 有预发布 < 正式
  assert.ok(compareVersions('0.0.5-beta.2', '0.0.5-beta.10') < 0); // 数字段数值比较（2 < 10，非字符串序）
  assert.equal(compareVersions('0.1.0-beta', '0.0.99'), 1);
  assert.throws(() => compareVersions('nonsense', '0.0.1'), /VERSION_UNPARSEABLE/);
});

test('shell 范围：解析与满足判断', () => {
  assert.equal(validateShellVersionRange('>=0.0.5-beta'), true);
  assert.equal(validateShellVersionRange('>=0.0.5-beta <0.1.0'), true);
  assert.equal(validateShellVersionRange('>0.0.5'), false);
  assert.equal(validateShellVersionRange('garbage'), false);
  assert.equal(satisfiesShellVersionRange('0.0.5-beta', '>=0.0.5-beta <0.1.0'), true);
  assert.equal(satisfiesShellVersionRange('0.0.4-beta', '>=0.0.5-beta <0.1.0'), false);
  assert.equal(satisfiesShellVersionRange('0.1.0-beta', '>=0.0.5-beta <0.1.0'), true); // 纯SemVer序：0.1.0-beta < 0.1.0
  assert.equal(satisfiesShellVersionRange('0.1.0', '>=0.0.5-beta <0.1.0'), false);
  assert.equal(satisfiesShellVersionRange('0.0.9', '>=0.0.5-beta <0.1.0'), true);
});

test('清单校验：合法清单通过，逐项违规拒绝', () => {
  assert.doesNotThrow(() => validateManifest(validManifest()));
  assert.throws(() => validateManifest({ ...validManifest(), unknownField: 1 }), /MANIFEST_UNKNOWN_FIELD/);
  assert.throws(() => validateManifest({ ...validManifest(), updateSequence: 0 }), /MANIFEST_SEQUENCE_INVALID/);
  assert.throws(() => validateManifest({ ...validManifest(), sourceSha: 'short' }), /MANIFEST_SOURCE_SHA_INVALID/);
  assert.throws(() => validateManifest({ ...validManifest(), channel: 'dev' }), /MANIFEST_CHANNEL_INVALID/);
  assert.throws(() => validateManifest({ ...validManifest(), package: { ...validManifest().package, sha256: 'zz' } }), /MANIFEST_PACKAGE_SHA_INVALID/);
  assert.throws(() => validateManifest({ ...validManifest(), files: validManifest().files.filter(file => file.path !== 'desktop/backend.mjs') }), /MANIFEST_CORE_FILES_MISSING/);
  assert.throws(() => validateManifest({ ...validManifest(), files: [{ path: '../evil', size: 1, sha256: SHA64 }] }), /TAR_PATH_DOT/);
  assert.throws(() => validateManifest(null), /MANIFEST_NOT_OBJECT/);
});

test('递增序号：严格递增；同号仅允许当前/上次成功发布重装', () => {
  assert.equal(sequenceAccepted(3, 2), true);
  assert.equal(sequenceAccepted(2, 2), false);
  assert.equal(sequenceAccepted(1, 2), false);
  assert.equal(sequenceAccepted(2, 2, { releaseId: 'r', activeReleaseId: 'r' }), true);
  assert.equal(sequenceAccepted(2, 2, { releaseId: 'r', lastGoodReleaseId: 'r' }), true);
  assert.equal(sequenceAccepted(2, 2, { releaseId: 'r', activeReleaseId: 'other' }), false);
  assert.equal(sequenceAccepted('x', 2), false);
});

// 更新清单：字段白名单校验、SemVer 比较与递增序号规则。
// 校验字段缺失、超界或版本未知时拒绝更新；清单覆盖原始 UTF-8 字节，本模块不重新序列化。
'use strict';
const { safePackPath } = require('./tar.cjs');

const MANIFEST_VERSION = 1;
const CHANNELS = ['beta', 'stable'];
const PLATFORMS = ['darwin', 'win32'];
const ARCHES = ['arm64', 'x64'];
const MANIFEST_KEYS = ['manifestVersion', 'releaseId', 'productVersion', 'updateSequence', 'sourceSha', 'channel',
  'platform', 'arch', 'runtimeCompatibilityId', 'shellVersionRange', 'productionDependenciesHash',
  'databaseSchemaVersion', 'keyId', 'package', 'files'];
const FILE_KEYS = ['path', 'size', 'sha256'];

function isHex(value, length) { return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value); }
function isPlainObject(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/** 严格 SemVer（主.次.补丁[-预发布]）；返回 null 表示不可解析。 */
function parseVersion(text) {
  const match = typeof text === 'string' ? text.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/) : null;
  if (!match) return null;
  return { major: +match[1], minor: +match[2], patch: +match[3], prerelease: match[4] ?? null, raw: text.trim() };
}

function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) throw new Error(`VERSION_UNPARSEABLE:${va ? b : a}`);
  if (va.major !== vb.major) return va.major - vb.major;
  if (va.minor !== vb.minor) return va.minor - vb.minor;
  if (va.patch !== vb.patch) return va.patch - vb.patch;
  // SemVer：有预发布 < 无预发布；预发布按 . 分段，数字段数值比较，缺失段更低
  if (!va.prerelease && !vb.prerelease) return 0;
  if (!va.prerelease) return 1;
  if (!vb.prerelease) return -1;
  const left = va.prerelease.split('.');
  const right = vb.prerelease.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) { const diff = +l - +r; if (diff) return diff; }
    else if (ln !== rn) return ln ? -1 : 1; // 数字段 < 字符串段
    else if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/** shellVersionRange：">=X" 或 ">=X <Y"（Y 上界不含）。 */
function validateShellVersionRange(range) {
  if (typeof range !== 'string') return false;
  const parts = range.trim().split(/\s+/);
  if (parts.length === 0 || parts.length > 2) return false;
  if (!parts[0].startsWith('>=') || !parseVersion(parts[0].slice(2))) return false;
  if (parts.length === 2 && (!parts[1].startsWith('<') || !parseVersion(parts[1].slice(1)))) return false;
  return true;
}

function satisfiesShellVersionRange(hostVersion, range) {
  if (!validateShellVersionRange(range)) throw new Error('SHELL_RANGE_INVALID');
  const parts = range.trim().split(/\s+/);
  if (compareVersions(hostVersion, parts[0].slice(2)) < 0) return false;
  if (parts.length === 2 && compareVersions(hostVersion, parts[1].slice(1)) >= 0) return false;
  return true;
}

/**
 * 校验清单对象（已 JSON.parse）：白名单外字段、类型、边界、文件合法性（路径安全、
 * 求和不超限、backend.mjs 与 package.json 必在）。失败抛错，返回原对象。
 */
function validateManifest(manifest, caps = { maxFiles: 20000, maxTotalBytes: 256 * 1024 * 1024, maxFileBytes: 64 * 1024 * 1024 }) {
  if (!isPlainObject(manifest)) throw new Error('MANIFEST_NOT_OBJECT');
  for (const key of Object.keys(manifest)) if (!MANIFEST_KEYS.includes(key)) throw new Error(`MANIFEST_UNKNOWN_FIELD:${key}`);
  const missing = MANIFEST_KEYS.filter(key => !(key in manifest));
  if (missing.length) throw new Error(`MANIFEST_MISSING_FIELD:${missing.join(',')}`);
  if (manifest.manifestVersion !== MANIFEST_VERSION) throw new Error(`MANIFEST_VERSION_UNSUPPORTED:${manifest.manifestVersion}`);
  if (typeof manifest.releaseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(manifest.releaseId)) throw new Error('MANIFEST_RELEASE_ID_INVALID');
  if (!parseVersion(manifest.productVersion)) throw new Error(`MANIFEST_PRODUCT_VERSION_INVALID:${manifest.productVersion}`);
  if (!Number.isInteger(manifest.updateSequence) || manifest.updateSequence < 1 || manifest.updateSequence > 2 ** 31 - 1) throw new Error('MANIFEST_SEQUENCE_INVALID');
  if (!isHex(manifest.sourceSha, 40)) throw new Error('MANIFEST_SOURCE_SHA_INVALID');
  if (!CHANNELS.includes(manifest.channel)) throw new Error(`MANIFEST_CHANNEL_INVALID:${manifest.channel}`);
  if (!PLATFORMS.includes(manifest.platform)) throw new Error(`MANIFEST_PLATFORM_INVALID:${manifest.platform}`);
  if (!ARCHES.includes(manifest.arch)) throw new Error(`MANIFEST_ARCH_INVALID:${manifest.arch}`);
  if (typeof manifest.runtimeCompatibilityId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(manifest.runtimeCompatibilityId)) throw new Error('MANIFEST_COMPAT_INVALID');
  if (!validateShellVersionRange(manifest.shellVersionRange)) throw new Error('MANIFEST_SHELL_RANGE_INVALID');
  if (!isHex(manifest.productionDependenciesHash, 64)) throw new Error('MANIFEST_DEPS_HASH_INVALID');
  if (!Number.isInteger(manifest.databaseSchemaVersion) || manifest.databaseSchemaVersion < 1) throw new Error('MANIFEST_SCHEMA_VERSION_INVALID');
  if (typeof manifest.keyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(manifest.keyId)) throw new Error('MANIFEST_KEY_ID_INVALID');
  const pkg = manifest.package;
  if (!isPlainObject(pkg) || Object.keys(pkg).some(key => !['file', 'size', 'sha256'].includes(key))) throw new Error('MANIFEST_PACKAGE_FIELDS_INVALID');
  if (typeof pkg.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz$/.test(pkg.file)) throw new Error('MANIFEST_PACKAGE_FILE_INVALID');
  if (!Number.isInteger(pkg.size) || pkg.size < 1 || pkg.size > caps.maxTotalBytes) throw new Error('MANIFEST_PACKAGE_SIZE_INVALID');
  if (!isHex(pkg.sha256, 64)) throw new Error('MANIFEST_PACKAGE_SHA_INVALID');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > caps.maxFiles) throw new Error('MANIFEST_FILES_INVALID');
  const seen = new Set();
  const folded = new Set();
  let total = 0;
  for (const file of manifest.files) {
    if (!isPlainObject(file) || Object.keys(file).some(key => !FILE_KEYS.includes(key))) throw new Error(`MANIFEST_FILE_FIELDS_INVALID:${file?.path}`);
    if (safePackPath(file.path) !== file.path) throw new Error('MANIFEST_PATH_NOT_CANONICAL');
    if (file.path.split('/').includes('node_modules') || !(file.path === 'package.json' || file.path === 'desktop/backend.mjs' || ['dist/src/', 'dist/contracts/', 'web-dist/', 'resources/'].some(root => file.path.startsWith(root)))) throw new Error(`MANIFEST_FILE_FORBIDDEN:${file.path}`);
    if (!Number.isInteger(file.size) || file.size < 0 || file.size > caps.maxFileBytes) throw new Error(`MANIFEST_FILE_SIZE_INVALID:${file.path}`);
    if (!isHex(file.sha256, 64)) throw new Error(`MANIFEST_FILE_SHA_INVALID:${file.path}`);
    if (folded.has(file.path.toLowerCase())) throw new Error(`MANIFEST_FILE_DUPLICATE:${file.path}`);
    seen.add(file.path); folded.add(file.path.toLowerCase());
    total += file.size;
    if (total > caps.maxTotalBytes) throw new Error('MANIFEST_FILES_TOTAL_INVALID');
  }
  if (!seen.has('desktop/backend.mjs') || !seen.has('package.json')) throw new Error('MANIFEST_CORE_FILES_MISSING');
  return manifest;
}

/** 递增序号规则：必须严格大于本地最高已接受序号（拒绝同号重放与降级）；
 * 例外：与当前 active／lastGood 相同序号的同一发布允许（本地损坏后重装当前版本）。 */
function sequenceAccepted(updateSequence, highestAcceptedSequence, allow = {}) {
  if (!Number.isInteger(updateSequence)) return false;
  if (updateSequence > highestAcceptedSequence) return true;
  if (updateSequence === highestAcceptedSequence) {
    return !!allow.releaseId && (allow.releaseId === allow.activeReleaseId || allow.releaseId === allow.lastGoodReleaseId);
  }
  return false;
}

module.exports = { MANIFEST_VERSION, MANIFEST_KEYS, parseVersion, compareVersions, validateShellVersionRange, satisfiesShellVersionRange, validateManifest, sequenceAccepted };

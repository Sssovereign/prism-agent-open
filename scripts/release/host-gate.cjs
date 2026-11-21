'use strict';
const { readFileSync, readdirSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { createHash } = require('node:crypto');
const { parseVersion, compareVersions, validateShellVersionRange, satisfiesShellVersionRange } = require('../../desktop/updates/manifest.cjs');

// hostVersion 是已验证兼容基线的版本，不是每次新安装包的产品版本。
// 发布侧不扩展 v1 清单，旧宿主仍只需理解 shellVersionRange。
function checkHostRange({ minimumHostVersion, hostVersion, shellRange, businessVersion }) {
  if (!parseVersion(minimumHostVersion) || !parseVersion(hostVersion)) throw new Error('HOST_VERSION_REQUIRED');
  if (compareVersions(minimumHostVersion, hostVersion) !== 0) throw new Error('HOST_MINIMUM_MUST_MATCH_BUILD');
  if (compareVersions(businessVersion, minimumHostVersion) < 0) throw new Error('BUSINESS_BELOW_HOST');
  const range = shellRange ?? `>=${minimumHostVersion}`;
  if (!validateShellVersionRange(range)) throw new Error('SHELL_RANGE_INVALID');
  if (compareVersions(range.trim().split(/\s+/)[0].slice(2), minimumHostVersion) < 0) throw new Error('SHELL_RANGE_TOO_BROAD');
  if (!satisfiesShellVersionRange(hostVersion, range)) throw new Error('BUILD_HOST_EXCLUDED');
  return range;
}
function hostFiles(dir) {
  const files = [];
  function walk(path) {
    for (const item of readdirSync(join(dir, path), { withFileTypes: true })) {
      const rel = path ? `${path}/${item.name}` : item.name;
      if (['backend.mjs', 'build-info.json'].includes(rel) || item.name.endsWith('.test.cjs')) continue;
      if (item.isDirectory()) walk(rel);
      else if (item.isFile()) files.push(rel);
      else throw new Error(`HOST_SPECIAL_FILE:${rel}`);
    }
  }
  walk('');
  for (const file of ['main.cjs', 'policy.cjs', 'preload.cjs']) {
    if (!files.includes(file)) throw new Error(`HOST_FILE_MISSING:${file}`);
  }
  return Object.fromEntries(files.sort().map(file => [file, createHash('sha256').update(readFileSync(join(dir, file))).digest('hex')]));
}
function compareHostFiles(sourceDesktop, builtDesktop) {
  const source = hostFiles(sourceDesktop), built = hostFiles(builtDesktop);
  const changed = [...new Set([...Object.keys(source), ...Object.keys(built)])].filter(file => source[file] !== built[file]);
  if (changed.length) throw new Error(`HOST_FILES_CHANGED_REBUILD_INSTALLER:${changed.join(',')}`);
  return source;
}

const digest = value => createHash('sha256').update(value).digest('hex');
const electronVersion = require('../../package.json').devDependencies.electron;
function createHostBaseline(buildInfoPath) {
  const info = JSON.parse(readFileSync(buildInfoPath, 'utf8'));
  const baseline = {
    baselineVersion: 1,
    hostVersion: info.hostVersion ?? info.version,
    electronVersion,
    sourceSha: info.sourceSha ?? null,
    runtimeCompatibilityId: info.runtimeCompatibilityId,
    productionDependenciesHash: info.productionDependenciesHash,
    databaseSchemaVersion: info.databaseSchemaVersion,
    updatesPublicKeySha256: digest(info.updatesPublicKey ?? ''),
    updatesKeyId: info.updatesKeyId ?? null,
    hostFiles: hostFiles(dirname(buildInfoPath)),
  };
  validateHostBaseline(baseline);
  return baseline;
}
function validateHostBaseline(baseline) {
  if (baseline?.baselineVersion !== 1 || !parseVersion(baseline.hostVersion) || !parseVersion(baseline.electronVersion)
    || typeof baseline.runtimeCompatibilityId !== 'string' || !baseline.runtimeCompatibilityId
    || !/^[a-f0-9]{64}$/.test(baseline.productionDependenciesHash ?? '')
    || !Number.isInteger(baseline.databaseSchemaVersion) || baseline.databaseSchemaVersion < 1
    || !/^[a-f0-9]{64}$/.test(baseline.updatesPublicKeySha256 ?? '')
    || !baseline.hostFiles || typeof baseline.hostFiles !== 'object'
    || !['main.cjs', 'preload.cjs', 'policy.cjs'].every(file => /^[a-f0-9]{64}$/.test(baseline.hostFiles[file] ?? ''))
    || Object.values(baseline.hostFiles).some(value => !/^[a-f0-9]{64}$/.test(value))) throw new Error('HOST_BASELINE_INVALID');
  return baseline;
}
function checkHostBaseline(baseline, { desktopDir, compat, buildInfo }) {
  validateHostBaseline(baseline);
  if (baseline.electronVersion !== electronVersion) throw new Error('HOST_ELECTRON_CHANGED_REBUILD_INSTALLER');
  const actual = hostFiles(desktopDir);
  const changed = [...new Set([...Object.keys(actual), ...Object.keys(baseline.hostFiles)])].filter(file => actual[file] !== baseline.hostFiles[file]);
  if (changed.length) throw new Error(`HOST_FILES_CHANGED_REBUILD_INSTALLER:${changed.join(',')}`);
  if (['runtimeCompatibilityId', 'productionDependenciesHash', 'databaseSchemaVersion'].some(key => compat[key] !== baseline[key])) {
    throw new Error('HOST_BASELINE_INCOMPATIBLE：与兼容基线不兼容，拒绝打包；须验证完整安装包并登记新基线');
  }
  if (digest(buildInfo.updatesPublicKey ?? '') !== baseline.updatesPublicKeySha256 || (buildInfo.updatesKeyId ?? null) !== baseline.updatesKeyId) throw new Error('HOST_TRUST_ROOT_CHANGED_REBUILD_INSTALLER');
  const version = buildInfo.hostVersion ?? buildInfo.version;
  if (!parseVersion(version) || compareVersions(version, baseline.hostVersion) < 0) throw new Error('BUILD_BELOW_HOST_BASELINE');
  return baseline.hostVersion;
}
module.exports = { checkHostRange, compareHostFiles, createHostBaseline, validateHostBaseline, checkHostBaseline };

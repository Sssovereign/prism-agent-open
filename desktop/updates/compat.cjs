// 运行时兼容标识：业务资源包只能在「同 Node 大版本 + 同生产依赖图 + 同迁移集合」的宿主上启用。
// 依赖图指纹取 node_modules 顶层实体目录及版本、锁文件摘要（@scope 目录展开为 scope/name；打包侧与资源包
// 构建侧都必须从「--prod + hoisted」安装后的工作区计算，两边同法同集）。pnpm 隔离布局的
// .pnpm/.bin 与 .modules.yaml 等元数据条目不属于依赖清单，全部排除。
// 迁移集合指纹取 dist/src/storage/migrations 的 SQL 文件名及内容摘要。任一变化 → 拒绝资源包，要求完整应用升级。
'use strict';
const { readdirSync, readFileSync, existsSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');

function hashNames(names) {
  return createHash('sha256').update(names.join('\n'), 'utf8').digest('hex');
}

function readDependencyNames(workspaceDir) {
  const nm = join(workspaceDir, 'node_modules');
  let entries;
  try {
    entries = readdirSync(nm, { withFileTypes: true });
  } catch {
    throw new Error('COMPAT_DEPS_UNAVAILABLE：缺少 node_modules（须以生产依赖安装后的工作区计算依赖指纹）');
  }
  const names = [];
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue; // 元数据（.pnpm/.bin/.modules.yaml 等）与散文件
    if (entry.name.startsWith('@')) {
      for (const child of readdirSync(join(nm, entry.name), { withFileTypes: true })) {
        if (child.isDirectory()) names.push(`${entry.name}/${child.name}`);
      }
    } else {
      names.push(entry.name);
    }
  }
  if (!names.length) throw new Error('COMPAT_DEPS_EMPTY：node_modules 无生产依赖（须先以 hoisted 布局安装生产依赖）');
  return names.sort().map(name => {
    const file = join(nm, name, 'package.json');
    const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    return `${name}@${data.version ?? 'unknown'}`;
  });
}

/**
 * 计算工作区的兼容三元组。nodeMajor 缺省按宿主运行时推断不可行（主进程是 Electron），
 * 由调用方显式传入（打包期为随包 Node 的大版本，客户端为自身 build-info 记录值）。
 */
function computeWorkspaceCompat({ workspaceDir, nodeMajor }) {
  const depNames = readDependencyNames(workspaceDir);
  const lock = join(workspaceDir, 'pnpm-lock.yaml');
  const productionDependenciesHash = hashNames([...depNames, existsSync(lock) ? createHash('sha256').update(readFileSync(lock)).digest('hex') : 'no-lock']);

  const migrationsDir = join(workspaceDir, 'dist', 'src', 'storage', 'migrations');
  let migrations;
  try {
    migrations = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
  } catch {
    throw new Error('COMPAT_MIGRATIONS_UNAVAILABLE：缺少 dist/src/storage/migrations');
  }
  const numbers = migrations.map(name => parseInt(name.match(/^(\d+)_/)?.[1] ?? '0', 10));
  const databaseSchemaVersion = numbers.length ? Math.max(...numbers) : 0;
  if (!databaseSchemaVersion) throw new Error('COMPAT_MIGRATIONS_EMPTY');
  const migrationsHash = hashNames(migrations.map(name => `${name}:${createHash('sha256').update(readFileSync(join(migrationsDir, name))).digest('hex')}`));

  const runtimeCompatibilityId = `node${nodeMajor}.${productionDependenciesHash.slice(0, 12)}.m${migrationsHash.slice(0, 8)}`;
  return { productionDependenciesHash, databaseSchemaVersion, runtimeCompatibilityId, dependencyCount: depNames.length };
}

module.exports = { computeWorkspaceCompat, hashNames };

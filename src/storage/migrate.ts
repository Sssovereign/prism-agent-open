import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Db } from './db.js';

export interface MigrationRow { version: number; checksum: string; applied_at: string }

interface Applied { version: number; checksum: string }

function ensureMigrationsTable(db: Db): void {
  db.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(
    version INTEGER PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

function applied(db: Db): Map<number, string> {
  const rows = db.db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as unknown as Applied[];
  return new Map(rows.map(r => [Number(r.version), String(r.checksum)]));
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/**
 * 运行时解析迁移目录：源码运行取 ./migrations；编译产物（dist/src/storage/）回退到
 * 源码树 ../../src/storage/migrations。tsc 不复制 .sql，须保证两条路径都可用。
 */
export function defaultMigrationsDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const local = join(here, 'migrations');
  if (existsSync(join(local, '001_initial.sql'))) return local;
  const source = join(here, '../../../src/storage/migrations');
  if (existsSync(join(source, '001_initial.sql'))) return source;
  throw new Error('MIGRATIONS_DIR_NOT_FOUND');
}

/**
 * 依次应用 migrations 目录下的 NNN_name.sql。
 * - 已应用且checksum一致：跳过（迁移可重复执行）
 * - 已应用但checksum不同：抛 MIGRATION_CHECKSUM_MISMATCH，禁止覆盖已执行迁移
 * - 每个迁移在独立事务中执行；失败回滚无半状态
 * 调用方须先停写并备份（规格：迁移前停写并备份）。
 */
export function migrate(db: Db, dir: string = defaultMigrationsDir()): { applied: number[]; skipped: number[] } {
  ensureMigrationsTable(db);
  const files = readdirSync(dir).filter(f => /^\d{3}_[A-Za-z0-9_-]+\.sql$/.test(f)).sort();
  const done = applied(db);
  const appliedNow: number[] = [];
  const skipped: number[] = [];
  for (const file of files) {
    const version = Number(file.slice(0, 3));
    const sql = readFileSync(join(dir, file), 'utf8');
    const checksum = checksumOf(sql);
    const previous = done.get(version);
    if (previous !== undefined) {
      if (previous !== checksum) {
        throw new Error(`MIGRATION_CHECKSUM_MISMATCH: version ${version} 已以不同内容应用（禁止覆盖已执行迁移）`);
      }
      skipped.push(version);
      continue;
    }
    db.tx(tx => {
      tx.exec(sql);
      tx.prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?,?,?)')
        .run(version, checksum, new Date().toISOString());
    });
    done.set(version, checksum);
    appliedNow.push(version);
  }
  return { applied: appliedNow, skipped };
}

export function migrationRows(db: Db): MigrationRow[] {
  ensureMigrationsTable(db);
  return db.db.prepare('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version').all() as unknown as MigrationRow[];
}

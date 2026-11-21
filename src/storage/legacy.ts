import type { Db } from './db.js';

export interface LegacyArchiveResult { renamed: string[]; marked: boolean }

function tableExists(db: Db, name: string): boolean {
  return db.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

function columnsOf(db: Db, name: string): string[] {
  return (db.db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all() as unknown as Array<{ name: string }>).map(c => c.name);
}

/** mock-v1 的 runs 表特征列（id, body, artifact）。 */
function looksLikeMockRuns(db: Db, name: string): boolean {
  const cols = columnsOf(db, name);
  return cols.includes('body') && cols.includes('artifact') && !cols.includes('status');
}

/**
 * 迁移前的旧mock归档：把 mock-v1 的 runs/events/evidence 重命名为 legacy_*，
 * 并在 legacy_migration_meta 登记 mock-v1 来源；不删除、不改写其数据，
 * 不自动补造账号/角色/真实用量。无 mock 表时为无操作。
 */
export function archiveLegacyMock(db: Db): LegacyArchiveResult {
  const renamed: string[] = [];
  if (!tableExists(db, 'runs') || !looksLikeMockRuns(db, 'runs')) return { renamed, marked: false };
  db.tx(tx => {
    tx.exec('ALTER TABLE evidence RENAME TO legacy_evidence');
    tx.exec('ALTER TABLE events RENAME TO legacy_events');
    tx.exec('ALTER TABLE runs RENAME TO legacy_runs');
    renamed.push('evidence→legacy_evidence', 'events→legacy_events', 'runs→legacy_runs');
    tx.exec(`CREATE TABLE IF NOT EXISTS legacy_migration_meta(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      archived_at TEXT NOT NULL
    )`);
    tx.prepare('INSERT OR REPLACE INTO legacy_migration_meta(key, value, archived_at) VALUES (?,?,?)')
      .run('legacy_source', 'mock-v1', new Date().toISOString());
  });
  return { renamed, marked: true };
}

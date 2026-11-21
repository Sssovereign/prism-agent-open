import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Tx = DatabaseSync;

export class Db {
  readonly db: DatabaseSync;
  private inTx = false;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.db.exec('PRAGMA busy_timeout=5000;');
  }

  /** 事务包装：BEGIN IMMEDIATE，禁止嵌套（同库事务不等待HTTP/模型/审批由调用方保证）。 */
  tx<T>(fn: (tx: Tx) => T): T {
    if (this.inTx) throw new Error('NESTED_TRANSACTION');
    this.inTx = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(this.db);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTx = false;
    }
  }

  close() { this.db.close(); }
}

export function defaultDbPath(dataDir: string): string {
  return join(dataDir, 'workbench.sqlite');
}

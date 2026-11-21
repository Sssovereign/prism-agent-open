import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/storage/db.js';
import { migrate, defaultMigrationsDir } from '../src/storage/migrate.js';
import { appendEvent, readEvents } from '../src/events.js';

const MIGRATIONS = defaultMigrationsDir();
const temporary = () => mkdtempSync(join(tmpdir(), 't01-tx-'));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function seedRun(db: Db): string {
  const now = new Date().toISOString();
  const u = uuid(1), p = uuid(2), c = uuid(3), pv = uuid(4), r = uuid(5);
  db.tx(tx => {
    tx.prepare("INSERT INTO users(id, username, password_hash, password_salt, password_params_json, disabled, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)")
      .run(u, 'tester', 'h', 's', '{}', now, now);
    tx.prepare("INSERT INTO projects(id, owner_user_id, name, created_at, updated_at) VALUES (?,?,?,?,?)")
      .run(p, u, '项目A', now, now);
    tx.prepare("INSERT INTO conversations(id, project_id, mode, title, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run(c, p, 'ordinary', '会话', now, now);
    tx.prepare("INSERT INTO problem_versions(id, conversation_id, version, objective, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run(pv, c, 1, '目标', now, now);
    tx.prepare(`INSERT INTO runs(id, project_id, conversation_id, problem_version_id, mode, status, config_snapshot_json, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(r, p, c, pv, 'ordinary', 'created', '{}', now, now);
  });
  return r;
}

test('事务回滚无半状态：抛错后插入全部消失', () => {
  const dir = temporary();
  const db = new Db(join(dir, 'workbench.sqlite'));
  try {
    migrate(db, MIGRATIONS);
    assert.throws(() => db.tx(tx => {
      tx.prepare("INSERT INTO users(id, username, password_hash, password_salt, password_params_json, disabled, created_at, updated_at) VALUES ('u9','nine','h','s','{}',0,'t','t')").run();
      throw new Error('boom');
    }), /boom/);
    assert.equal((db.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 0);
    assert.throws(() => db.tx(() => db.tx(() => 1)), /NESTED_TRANSACTION/, '嵌套事务必须被拒绝');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('事件序号原子分配：同一连接内连续分配严格递增，跨连接交错亦唯一', async () => {
  const dir = temporary();
  const dbA = new Db(join(dir, 'workbench.sqlite'));
  const dbB = new Db(join(dir, 'workbench.sqlite'));
  try {
    migrate(dbA, MIGRATIONS);
    const runId = seedRun(dbA);
    const seqs: number[] = [];
    for (const type of ['run.created', 'run.started', 'run.status_changed'] as const) {
      seqs.push(appendEvent(dbA, dbA.db, { runId, type }).seq);
    }
    assert.deepEqual(seqs, [1, 2, 3]);
    // 第二连接在A的已提交状态上继续分配——从4开始且不冲突
    seqs.push(appendEvent(dbB, dbB.db, { runId, type: 'run.status_changed' }).seq);
    assert.equal(seqs[3], 4);
    const all = readEvents(dbA, runId);
    assert.deepEqual(all.map(e => e.seq), [1, 2, 3, 4]);
    assert.equal(new Set(all.map(e => e.eventId)).size, 4);
  } finally { dbA.close(); dbB.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('事件唯一约束：event_id 与 (attempt_id, producer_seq) 重复写入被拒', () => {
  const dir = temporary();
  const db = new Db(join(dir, 'workbench.sqlite'));
  try {
    migrate(db, MIGRATIONS);
    const runId = seedRun(db);
    const first = appendEvent(db, db.db, { runId, type: 'tool.started', attemptId: uuid(11), producerSeq: 7 });
    assert.equal(first.seq, 1);
    assert.throws(() => db.tx(tx => appendEvent(db, tx, { runId, type: 'tool.result', attemptId: uuid(11), producerSeq: 7 })),
      /UNIQUE constraint failed/);
    // 相同 producerSeq 但不同 attempt 允许
    const other = appendEvent(db, db.db, { runId, type: 'tool.started', attemptId: uuid(12), producerSeq: 7 });
    assert.equal(other.seq, 2);
    // 手工重复 eventId 直接落库同样被拒
    assert.throws(() => db.tx(tx => tx.prepare("INSERT INTO run_events(run_id, seq, event_id, visibility, type, occurred_at, payload_json) VALUES (?, 99, ?, 'public', 'run.started', 't', '{}')")
      .run(runId, first.eventId)), /UNIQUE constraint failed/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('事件信封经契约校验后落库：未知type在写入前抛出', () => {
  const dir = temporary();
  const db = new Db(join(dir, 'workbench.sqlite'));
  try {
    migrate(db, MIGRATIONS);
    const runId = seedRun(db);
    assert.throws(() => appendEvent(db, db.db, { runId, type: 'not.a.type' as never }), /EVENT_ENVELOPE_INVALID/);
    assert.equal((db.db.prepare('SELECT COUNT(*) AS n FROM run_events').get() as { n: number }).n, 0);
    assert.equal((db.db.prepare('SELECT next_event_seq AS n FROM runs WHERE id=?').get(runId) as { n: number }).n, 0, '失败分配不得推进序号');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

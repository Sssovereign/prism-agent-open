import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/storage/db.js';
import { migrate, migrationRows, defaultMigrationsDir } from '../src/storage/migrate.js';
import { archiveLegacyMock } from '../src/storage/legacy.js';

const temporary = () => mkdtempSync(join(tmpdir(), 't01-storage-'));

test('全新库迁移：31张业务表建立，schema_migrations登记，重复执行跳过', () => {
  const dir = temporary();
  const db = new Db(join(dir, 'workbench.sqlite'));
  try {
    const first = migrate(db, defaultMigrationsDir());
    assert.ok(first.applied.length >= 1, '至少应用基线迁移');
    const tables = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as unknown as Array<{ name: string }>).map(r => r.name);
    for (const t of ['users', 'sessions', 'projects', 'workspace_grants', 'picker_tickets', 'resources', 'resource_versions',
      'conversations', 'problem_versions', 'model_configs', 'model_entries', 'runs', 'agent_bindings', 'phase_tasks',
      'attempts', 'worker_instances', 'messages', 'evidence', 'arguments', 'argument_responses', 'argument_evidence',
      'tool_invocations', 'approvals', 'artifacts', 'reports', 'usage_entries', 'run_events', 'publications',
      'change_records', 'idempotency_requests', 'path_leases', 'schema_migrations']) {
      assert.ok(tables.includes(t), `缺少表 ${t}`);
    }
    const second = migrate(db, defaultMigrationsDir());
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, first.applied, '重复执行全部跳过且不新增登记');
    assert.equal(migrationRows(db).length, first.applied.length, '重复执行不得新增登记');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('checksum不一致：禁止覆盖已执行迁移', () => {
  const dir = temporary();
  const migDir = join(dir, 'migrations');
  mkdirSync(migDir, { recursive: true });
  writeFileSync(join(migDir, '001_x.sql'), 'CREATE TABLE t1(a TEXT);');
  const db = new Db(join(dir, 'workbench.sqlite'));
  try {
    migrate(db, migDir);
    writeFileSync(join(migDir, '001_x.sql'), 'CREATE TABLE t1(b TEXT); -- changed');
    assert.throws(() => migrate(db, migDir), /MIGRATION_CHECKSUM_MISMATCH/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('旧mock数据归档为legacy_*并标记来源，正式迁移在其上执行', () => {
  const dir = temporary();
  const db = new Db(join(dir, 'workbench.sqlite'));
  try {
    db.db.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY, body TEXT NOT NULL, artifact TEXT);
      CREATE TABLE events(run_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(run_id, seq));
      CREATE TABLE evidence(run_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(run_id,id));`);
    db.db.prepare("INSERT INTO runs(id, body) VALUES ('r1', ?)").run(JSON.stringify({ id: 'r1', runtime: 'mock-v1' }));
    const result = archiveLegacyMock(db);
    assert.equal(result.marked, true);
    assert.deepEqual(result.renamed.sort(), ['events→legacy_events', 'evidence→legacy_evidence', 'runs→legacy_runs']);
    assert.equal((db.db.prepare('SELECT COUNT(*) AS n FROM legacy_runs').get() as { n: number }).n, 1, 'mock数据保留');
    assert.equal((db.db.prepare("SELECT value FROM legacy_migration_meta WHERE key='legacy_source'").get() as { value: string }).value, 'mock-v1');
    migrate(db, defaultMigrationsDir());
    assert.ok(existsSync(join(dir, 'workbench.sqlite-wal')), 'WAL模式生效');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('无mock表时归档为无操作', () => {
  const dir = temporary();
  const db = new Db(join(dir, 'workbench.sqlite'));
  try {
    const result = archiveLegacyMock(db);
    assert.equal(result.marked, false);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});


test('025迁移：保留旧审批、引文与检查点，移除无用途摘要且可重复执行', () => {
  const dir = temporary(), oldMigrations = join(dir, 'migrations');
  mkdirSync(oldMigrations);
  for (const name of readdirSync(defaultMigrationsDir()).filter(name => /^\d{3}_/.test(name) && Number(name.slice(0, 3)) < 25)) {
    copyFileSync(join(defaultMigrationsDir(), name), join(oldMigrations, name));
  }
  const db = new Db(join(dir, 'workbench.sqlite'));
  try {
    migrate(db, oldMigrations);
    db.db.exec(`
      INSERT INTO users(id,username,password_hash,password_salt,password_params_json,created_at,updated_at) VALUES ('u','fixture','x','x','{}','t','t');
      INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES ('p','u','fixture','t','t');
      INSERT INTO conversations(id,project_id,mode,title,created_at,updated_at) VALUES ('c','p','ordinary','fixture','t','t');
      INSERT INTO problem_versions(id,conversation_id,version,objective,created_at,updated_at) VALUES ('pv','c',1,'fixture','t','t');
      INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,config_snapshot_json,created_at,updated_at) VALUES ('r','p','c','pv','ordinary','succeeded','{}','t','t');
      INSERT INTO model_configs(id,owner_user_id,preset,name,base_url,created_at,updated_at) VALUES ('mc','u','custom','fixture','https://example.invalid','t','t');
      INSERT INTO agent_bindings(id,run_id,role_id,model_config_id,model_id,created_at,updated_at) VALUES ('ab','r','ordinary','mc','fixture','t','t');
      INSERT INTO phase_tasks(id,run_id,agent_binding_id,phase_key,status,created_at,updated_at) VALUES ('pt','r','ab','ordinary','succeeded','t','t');
      INSERT INTO attempts(id,phase_task_id,number,status,created_at,updated_at) VALUES ('a','pt',1,'succeeded','t','t');
      INSERT INTO tool_invocations(id,run_id,phase_task_id,attempt_id,call_key,tool_name,tool_version,args_hash,redacted_args_json,canonical_exec_args_json,state,created_at,updated_at) VALUES ('ti','r','pt','a','call','bash','v1','tool-digest','{}','{"command":"echo fixture"}','succeeded','t','t');
      INSERT INTO approvals(id,invocation_id,owner_user_id,params_hash,policy_version,state,expires_at,created_at,updated_at) VALUES ('ap','ti','u','unused','v1','approved','2099-01-01','t','t');
      INSERT INTO resources(id,project_id,kind,display_name,created_at,updated_at) VALUES ('res','p','web','fixture','t','t');
      INSERT INTO resource_versions(id,resource_id,version,content_hash,created_at,updated_at) VALUES ('rv','res',1,'source-digest','t','t');
      INSERT INTO evidence(id,project_id,run_id,resource_version_id,excerpt,excerpt_hash,producer_role,state,created_at,updated_at) VALUES ('e','p','r','rv','保留引文','unused','ordinary','published','t','t');
      INSERT INTO context_checkpoints(id,run_id,attempt_id,conversation_id,input_manifest_hash,summary_text,source_seq,schema_version,prompt_version,policy_version,model_id,state,created_at,updated_at,source_manifest_json) VALUES ('cp','r','a','c','legacy-source-id','保留摘要',1,'cp-v1','p1','v1','fixture','confirmed','t','t','{"keptIds":["old"]}');
    `);
    assert.deepEqual(migrate(db).applied, [25, 26, 27, 28]);
    const columns = (table: string) => db.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    assert.ok(!columns('approvals').includes('params_hash'));
    assert.ok(!columns('evidence').includes('excerpt_hash'));
    assert.ok(!columns('context_checkpoints').includes('input_manifest_hash'));
    assert.equal(db.db.prepare("SELECT state FROM approvals WHERE id='ap'").get()!.state, 'approved');
    assert.equal(db.db.prepare("SELECT canonical_exec_args_json FROM tool_invocations WHERE id='ti'").get()!.canonical_exec_args_json, '{"command":"echo fixture"}');
    assert.equal(db.db.prepare("SELECT excerpt FROM evidence WHERE id='e'").get()!.excerpt, '保留引文');
    const checkpoint = db.db.prepare("SELECT * FROM context_checkpoints WHERE id='cp'").get()!;
    assert.equal(checkpoint.preflight_id, 'legacy-source-id');
    assert.equal(checkpoint.summary_text, '保留摘要');
    assert.equal(checkpoint.source_manifest_json, '{"keptIds":["old"]}');
    assert.equal(db.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.deepEqual(migrate(db).applied, []);
  } finally { db.close(); rmSync(dir, {recursive:true,force:true}); }
});

test('027迁移：workspace_grants新增is_primary并把每项目最早未撤销授权回填为主要', () => {
  const dir = temporary(), oldMigrations = join(dir, 'migrations');
  mkdirSync(oldMigrations);
  for (const name of readdirSync(defaultMigrationsDir()).filter(name => /^\d{3}_/.test(name) && Number(name.slice(0, 3)) < 27)) {
    copyFileSync(join(defaultMigrationsDir(), name), join(oldMigrations, name));
  }
  const db = new Db(join(dir, 'workbench.sqlite'));
  try {
    migrate(db, oldMigrations);
    db.db.exec(`
      INSERT INTO users(id,username,password_hash,password_salt,password_params_json,created_at,updated_at) VALUES ('u','fixture','x','x','{}','t','t');
      INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES ('p1','u','多目录','t','t');
      INSERT INTO workspace_grants(id,project_id,canonical_root,access,revision,selected_by,excludes_json,created_at,updated_at) VALUES ('g-old','p1','/tmp/a','write',1,'u','[]','2020-01-01T00:00:00.000Z','t');
      INSERT INTO workspace_grants(id,project_id,canonical_root,access,revision,selected_by,excludes_json,created_at,updated_at) VALUES ('g-new','p1','/tmp/b','write',1,'u','[]','2021-01-01T00:00:00.000Z','t');
      INSERT INTO workspace_grants(id,project_id,canonical_root,access,revision,selected_by,excludes_json,created_at,updated_at) VALUES ('g-revoked','p1','/tmp/c','write',1,'u','[]','2019-01-01T00:00:00.000Z','t');
    `);
    db.db.prepare("UPDATE workspace_grants SET revoked_at='2021-06-01T00:00:00.000Z' WHERE id='g-revoked'").run();
    assert.deepEqual(migrate(db).applied, [27, 28]);
    const primary = (id: string) => (db.db.prepare('SELECT is_primary FROM workspace_grants WHERE id=?').get(id) as { is_primary: number }).is_primary;
    assert.equal(primary('g-old'), 1, '最早未撤销授权回填为主要');
    assert.equal(primary('g-new'), 0);
    assert.equal(primary('g-revoked'), 0, '已撤销授权不参与回填');
    assert.deepEqual(migrate(db).applied, []);
  } finally { db.close(); rmSync(dir, {recursive:true,force:true}); }
});

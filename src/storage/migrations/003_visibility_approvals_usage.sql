-- 003_visibility_approvals_usage.sql — 普通Agent执行链（计划v1.6 §4.1—4.5）
-- 1) run_events visibility 四值化（public/owner/role_private/audit）；旧private→role_private、system→audit为保守映射。
-- 2) approvals 同invocation多条历史：移除invocation_id全局UNIQUE，增加仅pending/approved生效的部分唯一索引。
-- 3) usage_entries 扩展：requestKind、轮次/消息关联、分段时间、reasoning/缓存分桶、有效性标记、速度配对。
-- 4) conversations 增加置顶/归档字段。
-- 5) 同会话至多一个非终态Run：runs部分唯一索引升级为UNIQUE（终态集合 succeeded/failed/cancelled）。

-- ---------- run_events 重建（SQLite不能改CHECK，须表重建） ----------
CREATE TABLE run_events_new (
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  attempt_id TEXT,
  producer_seq INTEGER,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','owner','role_private','audit')),
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, seq)
);
INSERT INTO run_events_new(run_id, seq, event_id, attempt_id, producer_seq, visibility, type, occurred_at, payload_json)
SELECT run_id, seq, event_id, attempt_id, producer_seq,
       CASE visibility WHEN 'private' THEN 'role_private' WHEN 'system' THEN 'audit' ELSE 'public' END,
       type, occurred_at, payload_json
FROM run_events;
DROP TABLE run_events;
ALTER TABLE run_events_new RENAME TO run_events;
CREATE UNIQUE INDEX idx_run_events_producer ON run_events(attempt_id, producer_seq) WHERE attempt_id IS NOT NULL;
CREATE INDEX idx_run_events_run_seq ON run_events(run_id, seq);

-- ---------- approvals 重建：同一invocation允许多条历史，仅一张有效 ----------
CREATE TABLE approvals_new (
  id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES tool_invocations(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  params_hash TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  resource_revision INTEGER,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','rejected','expired','cancelled','superseded')),
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  claimed_at TEXT,
  replaces_approval_id TEXT REFERENCES approvals_new(id),
  cancellation_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO approvals_new SELECT * FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;
CREATE INDEX idx_approvals_owner_state ON approvals(owner_user_id, state);
CREATE INDEX idx_approvals_invocation ON approvals(invocation_id);
-- 每个invocation至多一张 pending/approved 有效审批；替代须先supersede/cancel旧记录。
CREATE UNIQUE INDEX idx_approvals_effective ON approvals(invocation_id)
  WHERE state IN ('pending','approved');

-- ---------- usage_entries 扩展 ----------
ALTER TABLE usage_entries ADD COLUMN request_kind TEXT NOT NULL DEFAULT 'main'
  CHECK (request_kind IN ('main','compaction','repair'));
ALTER TABLE usage_entries ADD COLUMN turn_id TEXT;
ALTER TABLE usage_entries ADD COLUMN client_message_id TEXT;
ALTER TABLE usage_entries ADD COLUMN input_message_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE usage_entries ADD COLUMN source_seq INTEGER;
ALTER TABLE usage_entries ADD COLUMN checkpoint_id TEXT;
ALTER TABLE usage_entries ADD COLUMN started_at TEXT;
ALTER TABLE usage_entries ADD COLUMN first_chunk_at TEXT;
ALTER TABLE usage_entries ADD COLUMN first_generation_delta_at TEXT;
ALTER TABLE usage_entries ADD COLUMN first_text_at TEXT;
ALTER TABLE usage_entries ADD COLUMN first_tool_delta_at TEXT;
ALTER TABLE usage_entries ADD COLUMN completed_at TEXT;
ALTER TABLE usage_entries ADD COLUMN ttft_ms INTEGER;
ALTER TABLE usage_entries ADD COLUMN first_text_ms INTEGER;
ALTER TABLE usage_entries ADD COLUMN reasoning_tokens INTEGER;
ALTER TABLE usage_entries ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE usage_entries ADD COLUMN cache_write_tokens INTEGER;
ALTER TABLE usage_entries ADD COLUMN usage_source TEXT NOT NULL DEFAULT 'unknown'
  CHECK (usage_source IN ('provider','partial','absent','unknown'));
ALTER TABLE usage_entries ADD COLUMN speed_valid INTEGER NOT NULL DEFAULT 0 CHECK (speed_valid IN (0,1));
ALTER TABLE usage_entries ADD COLUMN decode_tokens INTEGER;
ALTER TABLE usage_entries ADD COLUMN decode_ms INTEGER;
CREATE INDEX idx_usage_run_kind ON usage_entries(run_id, request_kind);
CREATE INDEX idx_usage_attempt ON usage_entries(attempt_id);

-- ---------- conversations 置顶/归档 ----------
ALTER TABLE conversations ADD COLUMN pinned_at TEXT;
ALTER TABLE conversations ADD COLUMN archived_at TEXT;
CREATE INDEX idx_conversations_project_order ON conversations(project_id, archived_at, pinned_at, updated_at DESC);

-- ---------- 同会话至多一个非终态Run（§4.5，终态=succeeded/failed/cancelled） ----------
-- 保守迁移：历史遗留的非终态Run（正常产品路径不应存在）统一记为failed，随后升级为UNIQUE部分索引。
UPDATE runs SET status='failed', stop_reason='MIGRATION_DEDUP', ended_at=updated_at
  WHERE status NOT IN ('succeeded','failed','cancelled');
DROP INDEX IF EXISTS idx_runs_active;
CREATE UNIQUE INDEX idx_runs_active ON runs(conversation_id)
  WHERE status NOT IN ('succeeded','failed','cancelled');

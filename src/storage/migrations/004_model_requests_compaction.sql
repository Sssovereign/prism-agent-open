-- 004_model_requests_compaction.sql — 请求登记与压缩checkpoint（计划v1.6 §4.2/4.6/4.7、§5/§9）
-- 1) context_checkpoints：压缩摘要/保留段的监督器确认门禁。
-- 2) model_requests：每次模型请求的reservation生命周期与用量登记（仅网关记账）。
-- 3) compaction_operations：压缩操作状态（排队/运行/完成/失败/取消）。

CREATE TABLE context_checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  input_manifest_hash TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  first_kept_entry_id TEXT,
  kept_entry_ids_json TEXT NOT NULL DEFAULT '[]',
  source_seq INTEGER NOT NULL,
  tokens_before INTEGER,
  tokens_after INTEGER,
  schema_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('proposed','confirmed','rejected','superseded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirmed_at TEXT
);
CREATE INDEX idx_checkpoints_run ON context_checkpoints(run_id, state);
CREATE INDEX idx_checkpoints_conversation ON context_checkpoints(conversation_id, state);

CREATE TABLE model_requests (
  id TEXT PRIMARY KEY,                              -- requestId（每次实际上游请求唯一）
  reservation_id TEXT NOT NULL UNIQUE,              -- 一次性短期reservation
  run_id TEXT NOT NULL REFERENCES runs(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  request_kind TEXT NOT NULL CHECK (request_kind IN ('main','compaction','repair')),
  body_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  turn_id TEXT,
  client_message_id TEXT,
  input_message_ids_json TEXT NOT NULL DEFAULT '[]',
  source_seq INTEGER,
  checkpoint_id TEXT REFERENCES context_checkpoints(id),
  max_output_tokens INTEGER,
  state TEXT NOT NULL CHECK (state IN ('reserved','started','completed','failed','cancelled')),
  error_code TEXT,
  usage_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_model_requests_run ON model_requests(run_id);
CREATE INDEX idx_model_requests_attempt ON model_requests(attempt_id, state);

CREATE TABLE compaction_operations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('auto','manual','overflow')),
  state TEXT NOT NULL CHECK (state IN ('queued','running','completed','failed','cancelled')),
  checkpoint_id TEXT REFERENCES context_checkpoints(id),
  source_seq INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_compaction_ops_run ON compaction_operations(run_id, state);

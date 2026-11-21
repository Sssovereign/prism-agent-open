-- Separate memory model usage from user requests; preserve every existing row and index.
CREATE TABLE model_requests_memory_new (
  id TEXT PRIMARY KEY,                              -- requestId（每次实际上游请求唯一）
  reservation_id TEXT NOT NULL UNIQUE,              -- 一次性短期reservation
  run_id TEXT NOT NULL REFERENCES runs(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  request_kind TEXT NOT NULL CHECK (request_kind IN ('main','compaction','repair','memory_recall','memory_extraction')),
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
, context_window INTEGER, estimated_input_tokens INTEGER, reserve_output_tokens INTEGER);
INSERT INTO model_requests_memory_new SELECT * FROM model_requests;
DROP TABLE model_requests;
ALTER TABLE model_requests_memory_new RENAME TO model_requests;
CREATE INDEX idx_model_requests_run ON model_requests(run_id);
CREATE INDEX idx_model_requests_attempt ON model_requests(attempt_id, state);
CREATE TABLE usage_entries_memory_new (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  attempt_id TEXT REFERENCES attempts(id),
  request_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_tokens_json TEXT NOT NULL DEFAULT '{}',
  estimated INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0,1)),
  latency_ms INTEGER,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, request_kind TEXT NOT NULL DEFAULT 'main'
  CHECK (request_kind IN ('main','compaction','repair','memory_recall','memory_extraction')), turn_id TEXT, client_message_id TEXT, input_message_ids_json TEXT NOT NULL DEFAULT '[]', source_seq INTEGER, checkpoint_id TEXT, started_at TEXT, first_chunk_at TEXT, first_generation_delta_at TEXT, first_text_at TEXT, first_tool_delta_at TEXT, completed_at TEXT, ttft_ms INTEGER, first_text_ms INTEGER, reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, usage_source TEXT NOT NULL DEFAULT 'unknown'
  CHECK (usage_source IN ('provider','partial','absent','unknown')), speed_valid INTEGER NOT NULL DEFAULT 0 CHECK (speed_valid IN (0,1)), decode_tokens INTEGER, decode_ms INTEGER, normalized_usage_json TEXT, usage_evidence_json TEXT);
INSERT INTO usage_entries_memory_new SELECT * FROM usage_entries;
DROP TABLE usage_entries;
ALTER TABLE usage_entries_memory_new RENAME TO usage_entries;
CREATE INDEX idx_usage_run ON usage_entries(run_id);
CREATE INDEX idx_usage_run_kind ON usage_entries(run_id, request_kind);
CREATE INDEX idx_usage_attempt ON usage_entries(attempt_id);
CREATE INDEX idx_usage_request_order ON usage_entries(created_at, request_id);
CREATE TABLE memory_extractions (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), conversation_id TEXT NOT NULL REFERENCES conversations(id), run_id TEXT NOT NULL REFERENCES runs(id), attempt_id TEXT NOT NULL REFERENCES attempts(id),
 boundary_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','completed','failed','cancelled')), created_at TEXT NOT NULL, ended_at TEXT, error TEXT,
 UNIQUE(conversation_id,boundary_hash)
);
CREATE TABLE memory_handoffs (
 project_id TEXT NOT NULL REFERENCES projects(id), source_path TEXT NOT NULL, source_hash TEXT NOT NULL, memory_path TEXT NOT NULL, memory_hash TEXT NOT NULL,
 run_id TEXT NOT NULL REFERENCES runs(id), git_head TEXT, saved_at TEXT NOT NULL, PRIMARY KEY(project_id,source_path)
);

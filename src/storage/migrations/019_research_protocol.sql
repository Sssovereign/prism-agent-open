-- Explicit research identities supplement the historical four-role binding table.
-- No rebuilding of existing tables or changes to ordinary runs.
CREATE TABLE research_runs (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  policy_version TEXT NOT NULL,
  summary_requested INTEGER NOT NULL DEFAULT 0 CHECK(summary_requested IN (0,1)),
  supplement_seq INTEGER NOT NULL DEFAULT 0,
  model_request_limit INTEGER NOT NULL DEFAULT 80,
  tool_request_limit INTEGER NOT NULL DEFAULT 120,
  report_json TEXT,
  source_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL
);
CREATE TABLE research_participants (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  role TEXT NOT NULL CHECK(role IN ('pro','con','host','juror','aggregate')),
  label TEXT NOT NULL,
  model_snapshot_json TEXT NOT NULL,
  UNIQUE(run_id,label)
);
CREATE TABLE research_views (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  participant_id TEXT NOT NULL REFERENCES research_participants(id),
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE research_phases (
  phase_task_id TEXT PRIMARY KEY REFERENCES phase_tasks(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  participant_id TEXT NOT NULL REFERENCES research_participants(id),
  ordinal INTEGER NOT NULL,
  batch TEXT,
  view_id TEXT REFERENCES research_views(id),
  output_json TEXT,
  output_hash TEXT,
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
  UNIQUE(run_id,ordinal)
);
CREATE TABLE research_records (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL CHECK(kind IN ('source','statement','host','opinion','verdict','supplement')),
  participant_id TEXT REFERENCES research_participants(id),
  phase_task_id TEXT REFERENCES phase_tasks(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_url TEXT,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0,1)),
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
  supplement_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_research_records_run ON research_records(run_id);
CREATE INDEX idx_research_phases_run ON research_phases(run_id,ordinal);
-- Content and fixed views are immutable; only publication changes.
CREATE TRIGGER research_records_immutable BEFORE UPDATE OF content,content_hash,source_url,run_id,kind,participant_id,phase_task_id ON research_records
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RESEARCH_RECORD'); END;
CREATE TRIGGER research_views_immutable BEFORE UPDATE ON research_views
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RESEARCH_VIEW'); END;

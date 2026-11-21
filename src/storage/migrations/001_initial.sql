-- 001_initial.sql — 开题版基线schema（依据 数据与接口.md v0.2.1 表清单）
-- 约定：TEXT id (UUID)、时间UTC ISO字符串、JSON存TEXT、snake_case列名。
-- 通用 created_at/updated_at 按规格补齐；CHECK约束固定状态枚举，非法状态入库即失败。

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_params_json TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_projects_owner ON projects(owner_user_id);

CREATE TABLE workspace_grants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  canonical_root TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('read','write')),
  revision INTEGER NOT NULL DEFAULT 1,
  selected_by TEXT NOT NULL,
  revoked_at TEXT,
  excludes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_grants_project ON workspace_grants(project_id);

CREATE TABLE picker_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  nonce_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','selected','cancelled','failed','expired','claimed')),
  expires_at TEXT NOT NULL,
  grant_id TEXT REFERENCES workspace_grants(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_picker_tickets_user_project ON picker_tickets(user_id, project_id);

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  grant_id TEXT REFERENCES workspace_grants(id),
  kind TEXT NOT NULL CHECK (kind IN ('upload','local','web')),
  display_name TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','project')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_resources_project ON resources(project_id);

CREATE TABLE resource_versions (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  locator_manifest_json TEXT NOT NULL DEFAULT '{}',
  source_url TEXT,
  fetched_at TEXT,
  stored_path TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(resource_id, version)
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  mode TEXT NOT NULL CHECK (mode IN ('ordinary','debate','jury')),
  title TEXT NOT NULL,
  last_message_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_conversations_project ON conversations(project_id);

CREATE TABLE problem_versions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  version INTEGER NOT NULL,
  objective TEXT NOT NULL CHECK (length(trim(objective)) > 0),
  constraints_json TEXT NOT NULL DEFAULT '[]',
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(conversation_id, version)
);

CREATE TABLE model_configs (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  preset TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_protocol TEXT NOT NULL DEFAULT 'openai-completions',
  revision INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_model_configs_owner ON model_configs(owner_user_id);

CREATE TABLE model_entries (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL REFERENCES model_configs(id),
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  parameters_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(config_id, model_id)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  problem_version_id TEXT NOT NULL REFERENCES problem_versions(id),
  mode TEXT NOT NULL CHECK (mode IN ('ordinary','debate','jury')),
  status TEXT NOT NULL CHECK (status IN ('created','running','waiting_approval','waiting_input','recovering','summarizing','cancelling','succeeded','failed','cancelled','needs_reconciliation')),
  phase TEXT,
  round_count INTEGER NOT NULL DEFAULT 0,
  config_snapshot_json TEXT NOT NULL,
  stop_reason TEXT,
  next_event_seq INTEGER NOT NULL DEFAULT 0,
  cancel_requested_at TEXT,
  ended_at TEXT,
  partial INTEGER CHECK (partial IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_runs_project ON runs(project_id);
CREATE INDEX idx_runs_conversation ON runs(conversation_id);
CREATE INDEX idx_runs_active ON runs(conversation_id) WHERE status NOT IN ('succeeded','failed','cancelled');

CREATE TABLE agent_bindings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  role_id TEXT NOT NULL CHECK (role_id IN ('ordinary','pro','con','host')),
  model_config_id TEXT NOT NULL REFERENCES model_configs(id),
  model_id TEXT NOT NULL,
  model_snapshot_json TEXT NOT NULL DEFAULT '{}',
  prompt_version TEXT NOT NULL DEFAULT 'v0',
  policy_version TEXT NOT NULL DEFAULT 'v0',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, role_id)
);
CREATE INDEX idx_agent_bindings_run ON agent_bindings(run_id);

CREATE TABLE phase_tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  agent_binding_id TEXT NOT NULL REFERENCES agent_bindings(id),
  phase_key TEXT NOT NULL,
  round_no INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending','running','waiting_approval','succeeded','failed','cancelled','skipped','needs_reconciliation')),
  active_attempt_id TEXT,
  input_manifest_json TEXT NOT NULL DEFAULT '{}',
  result_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, phase_key, agent_binding_id)
);
CREATE INDEX idx_phase_tasks_run ON phase_tasks(run_id);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  phase_task_id TEXT NOT NULL REFERENCES phase_tasks(id),
  number INTEGER NOT NULL,
  worker_id TEXT,
  lease_token_hash TEXT,
  lease_until TEXT,
  checkpoint_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','cancelled','needs_reconciliation')),
  error_code TEXT,
  reconciled INTEGER CHECK (reconciled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(phase_task_id, number)
);
CREATE INDEX idx_attempts_phase_task ON attempts(phase_task_id);

CREATE TABLE worker_instances (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  host_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  process_start_stamp TEXT NOT NULL,
  process_group_or_job TEXT,
  instance_nonce TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting','running','stopping','stopped','lost')),
  heartbeat_at TEXT,
  stop_requested_at TEXT,
  stopped_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_worker_instances_attempt ON worker_instances(attempt_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  run_id TEXT REFERENCES runs(id),
  phase_task_id TEXT REFERENCES phase_tasks(id),
  author_type TEXT NOT NULL CHECK (author_type IN ('user','agent','system')),
  role_id TEXT CHECK (role_id IN ('ordinary','pro','con','host')),
  client_message_id TEXT,
  seq INTEGER,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private','system')),
  state TEXT NOT NULL CHECK (state IN ('draft','published','abandoned')),
  content_json TEXT NOT NULL,
  consumed_cursor_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(conversation_id, seq),
  UNIQUE(conversation_id, client_message_id)
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_run ON messages(run_id);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  resource_version_id TEXT NOT NULL REFERENCES resource_versions(id),
  locator_json TEXT NOT NULL DEFAULT '{}',
  excerpt TEXT NOT NULL,
  excerpt_hash TEXT NOT NULL,
  producer_role TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('published','withdrawn','conflicted')),
  conflict_group_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_evidence_project ON evidence(project_id);
CREATE INDEX idx_evidence_run ON evidence(run_id);

CREATE TABLE arguments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  claim_key TEXT NOT NULL,
  text TEXT NOT NULL,
  stance TEXT NOT NULL CHECK (stance IN ('pro','con','host','neutral')),
  state TEXT NOT NULL CHECK (state IN ('active','withdrawn','superseded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_arguments_run ON arguments(run_id);

CREATE TABLE argument_responses (
  argument_id TEXT NOT NULL REFERENCES arguments(id),
  target_argument_id TEXT NOT NULL REFERENCES arguments(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (argument_id, target_argument_id)
);

CREATE TABLE argument_evidence (
  argument_id TEXT NOT NULL REFERENCES arguments(id),
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  relation TEXT NOT NULL CHECK (relation IN ('support','refute','context')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (argument_id, evidence_id)
);

CREATE TABLE tool_invocations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  phase_task_id TEXT NOT NULL REFERENCES phase_tasks(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  call_key TEXT NOT NULL UNIQUE,
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  canonical_exec_args_json TEXT,
  credential_refs_json TEXT NOT NULL DEFAULT '[]',
  redacted_args_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL CHECK (state IN ('proposed','awaiting_approval','claimed','succeeded','denied','failed','cancelled','unknown')),
  effect_kind TEXT,
  result_json TEXT,
  error_code TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_tool_invocations_run ON tool_invocations(run_id);
CREATE INDEX idx_tool_invocations_attempt ON tool_invocations(attempt_id);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL UNIQUE REFERENCES tool_invocations(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  params_hash TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  resource_revision INTEGER,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','rejected','expired','cancelled','superseded')),
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  claimed_at TEXT,
  replaces_approval_id TEXT REFERENCES approvals(id),
  cancellation_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_approvals_owner_state ON approvals(owner_user_id, state);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  producer_role TEXT NOT NULL,
  display_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  internal_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','verified','missing','quarantined')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_artifacts_run ON artifacts(run_id);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  schema_version TEXT NOT NULL,
  content_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  partial INTEGER NOT NULL DEFAULT 0 CHECK (partial IN (0,1)),
  completion_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, version)
);

CREATE TABLE usage_entries (
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
);
CREATE INDEX idx_usage_run ON usage_entries(run_id);

CREATE TABLE run_events (
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  attempt_id TEXT,
  producer_seq INTEGER,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private','system')),
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, seq)
);
CREATE UNIQUE INDEX idx_run_events_producer ON run_events(attempt_id, producer_seq) WHERE attempt_id IS NOT NULL;

CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  grant_id TEXT NOT NULL REFERENCES workspace_grants(id),
  relative_path TEXT NOT NULL,
  base_hash TEXT,
  proposed_hash TEXT NOT NULL,
  backup_ref TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','applied','conflict','failed')),
  conflict_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_publications_run ON publications(run_id);

CREATE TABLE change_records (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  invocation_id TEXT NOT NULL REFERENCES tool_invocations(id),
  publication_id TEXT REFERENCES publications(id),
  grant_id TEXT NOT NULL REFERENCES workspace_grants(id),
  relative_path TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create','modify','delete')),
  before_version_id TEXT,
  after_version_id TEXT,
  before_hash TEXT,
  after_hash TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','applied','conflict','failed')),
  applied_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_change_records_run ON change_records(run_id);

CREATE TABLE idempotency_requests (
  user_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_progress','completed')),
  response_status INTEGER,
  response_json TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, route_key, key)
);
CREATE INDEX idx_idempotency_expires ON idempotency_requests(expires_at);

CREATE TABLE path_leases (
  grant_id TEXT NOT NULL REFERENCES workspace_grants(id),
  relative_path TEXT NOT NULL,
  invocation_id TEXT NOT NULL REFERENCES tool_invocations(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (grant_id, relative_path)
);

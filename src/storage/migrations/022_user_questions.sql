-- User questions are separate from permission approvals. Full authorization never supplies answers.
CREATE TABLE user_questions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  invocation_id TEXT NOT NULL UNIQUE REFERENCES tool_invocations(id),
  questions_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','answered','skipped','auto_continued','cancelled')),
  answers_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  deadline_at TEXT,
  snoozed_at TEXT
);
CREATE UNIQUE INDEX idx_user_questions_pending ON user_questions(run_id) WHERE state='pending';

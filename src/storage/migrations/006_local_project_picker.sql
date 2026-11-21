-- 先选本地目录，确认后才原子创建项目与授权；取消不产生空项目。
CREATE TABLE project_directory_pickers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  nonce_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','selected','cancelled','failed','expired','claimed')),
  selected_path TEXT,
  expires_at TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  grant_id TEXT REFERENCES workspace_grants(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_project_directory_pickers_owner ON project_directory_pickers(user_id, state, expires_at);

ALTER TABLE projects ADD COLUMN pinned_at TEXT;
ALTER TABLE projects ADD COLUMN sidebar_position INTEGER NOT NULL DEFAULT 0;
CREATE TABLE sidebar_groups (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE conversations ADD COLUMN sidebar_group_id TEXT REFERENCES sidebar_groups(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN unread_at TEXT;

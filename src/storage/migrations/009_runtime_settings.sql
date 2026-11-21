CREATE TABLE agent_runtime_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    settings_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
ALTER TABLE context_checkpoints ADD COLUMN source_manifest_json TEXT NOT NULL DEFAULT '{}';

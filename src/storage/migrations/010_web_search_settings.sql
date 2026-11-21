CREATE TABLE search_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    provider TEXT NOT NULL DEFAULT 'none',
    updated_at TEXT NOT NULL
);

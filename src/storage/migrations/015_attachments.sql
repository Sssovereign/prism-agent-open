-- 块E2：会话图片附件登记表。正文（base64）落盘 attachments/<id>，库内仅存元数据；
-- mime 白名单在写入时经魔数校验（CHECK 为最后一道防线）。
CREATE TABLE IF NOT EXISTS attachments(
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/gif','image/webp')),
    size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
    sha256 TEXT NOT NULL,
    display_name TEXT NOT NULL,
    internal_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(owner_user_id, created_at DESC);

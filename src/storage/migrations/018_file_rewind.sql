-- 原始变更保留；撤销另记时间，不改写已执行的历史。
ALTER TABLE change_records ADD COLUMN reverted_at TEXT;
ALTER TABLE change_records ADD COLUMN target_path TEXT;
ALTER TABLE change_records ADD COLUMN before_mode INTEGER;

-- 013: 任务清单（块D）。run级 todo 列表，todo_write 全量覆写；run 终态后不清理（回放可见）。
CREATE TABLE IF NOT EXISTS run_todos (
    id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (run_id, position)
);
CREATE INDEX IF NOT EXISTS idx_run_todos_run ON run_todos(run_id, position);

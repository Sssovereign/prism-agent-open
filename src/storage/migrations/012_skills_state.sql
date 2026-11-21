-- 012: 技能启停状态（块C）。目录扫描按约定路径实时进行，不入库；
-- 库中仅存每个用户对每个技能的启用开关（默认启用）。
CREATE TABLE IF NOT EXISTS skills_state (
    user_id TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, skill_name)
);

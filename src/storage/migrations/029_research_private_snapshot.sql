-- 研究run私有正文专列：技能方法正文与记忆索引等不进 runs.config_snapshot_json
-- （fork 只克隆 runs 表的 config_snapshot_json，永不触碰本列，私有文本不会随分叉泄漏）。
ALTER TABLE research_runs ADD COLUMN private_json TEXT;

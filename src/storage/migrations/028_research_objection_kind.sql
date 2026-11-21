-- 研究协议阶段③：新增用户异议记录类别。SQLite不能改CHECK，重建表并原样迁移全部行；
-- 触发器与索引随重建恢复（不可变约束保持不变）。
CREATE TABLE research_records_objection (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL CHECK(kind IN ('source','statement','host','opinion','verdict','supplement','objection')),
  participant_id TEXT REFERENCES research_participants(id),
  phase_task_id TEXT REFERENCES phase_tasks(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_url TEXT,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0,1)),
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
  supplement_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
INSERT INTO research_records_objection SELECT id,run_id,kind,participant_id,phase_task_id,title,content,content_hash,source_url,truncated,published,supplement_seq,created_at FROM research_records;
DROP TABLE research_records;
ALTER TABLE research_records_objection RENAME TO research_records;
CREATE INDEX idx_research_records_run ON research_records(run_id);
CREATE TRIGGER research_records_immutable BEFORE UPDATE OF content,content_hash,source_url,run_id,kind,participant_id,phase_task_id ON research_records
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RESEARCH_RECORD'); END;

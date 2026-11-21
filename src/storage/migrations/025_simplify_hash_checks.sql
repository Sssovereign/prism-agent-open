-- 摘要没有承担验证职责的字段移除；实际工具参数及引文原文保留。
ALTER TABLE approvals DROP COLUMN params_hash;
ALTER TABLE evidence DROP COLUMN excerpt_hash;
-- 新检查点记录监督器签发的预检编号；历史值原样保留为不透明来源标识。
ALTER TABLE context_checkpoints RENAME COLUMN input_manifest_hash TO preflight_id;

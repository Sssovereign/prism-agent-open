-- 块F1：change_records 持久化统一 diff 补丁（写入时计算，展示层直读）
ALTER TABLE change_records ADD COLUMN diff_patch TEXT;

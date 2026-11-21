-- T03：目录选择票据需要保存本机选择器返回的目录真实路径（仅可信侧内部使用，任何API不回显）。
-- 规格picker_tickets必备字段为最小集；本列是可信侧内部列，与workspace_grants.canonical_root同级的私密性。
ALTER TABLE picker_tickets ADD COLUMN selected_path TEXT;

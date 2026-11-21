-- 联网搜索可引用模型配置的 API Key（R39）：引用存搜索侧，删除配置时自动置空。
ALTER TABLE search_settings ADD COLUMN source_config_id TEXT REFERENCES model_configs(id) ON DELETE SET NULL;

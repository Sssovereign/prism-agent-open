-- 接口级联网搜索能力位（学 ZCode 的 supportsNativeWebSearch：配置模型时显式勾选并持久化）。
-- NULL=未勾选；非 NULL=后端按 base_url 推导的搜索厂商 id（勾选时校验推导命中后才写入）。
-- 运行时解析顺序：本次任务接口已勾选 → 复用该接口 Key 执行；未勾选 → 回落全局 search_settings。
ALTER TABLE model_configs ADD COLUMN search_provider TEXT;

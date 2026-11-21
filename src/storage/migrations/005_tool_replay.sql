-- F04（waiting_input恢复幂等）：跨attempt重放的工具调用登记来源，副作用计数与审计可区分
-- "真实执行"与"结果回放"。回放行不产生新副作用；证据链见 tool.replayed 事件与该列。
ALTER TABLE tool_invocations ADD COLUMN replayed_from_invocation_id TEXT;

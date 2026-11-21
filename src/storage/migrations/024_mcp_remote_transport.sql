-- R62：MCP 远程传输（streamable HTTP）。仅新增列；存量行默认 stdio，行为不变。
-- command 保持 NOT NULL（sqlite 改约束需整表重建，不做）：http 传输存空串，不再参与校验。
ALTER TABLE mcp_servers ADD COLUMN transport TEXT NOT NULL DEFAULT 'stdio' CHECK (transport IN ('stdio','http'));
ALTER TABLE mcp_servers ADD COLUMN url TEXT;
ALTER TABLE mcp_servers ADD COLUMN headers_json TEXT NOT NULL DEFAULT '{}';

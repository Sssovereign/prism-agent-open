-- Additive provenance only; legacy NOT NULL token columns remain compatible.
ALTER TABLE usage_entries ADD COLUMN normalized_usage_json TEXT;
ALTER TABLE usage_entries ADD COLUMN usage_evidence_json TEXT;
ALTER TABLE model_requests ADD COLUMN context_window INTEGER;
ALTER TABLE model_requests ADD COLUMN estimated_input_tokens INTEGER;
ALTER TABLE model_requests ADD COLUMN reserve_output_tokens INTEGER;
CREATE INDEX idx_usage_request_order ON usage_entries(created_at, request_id);

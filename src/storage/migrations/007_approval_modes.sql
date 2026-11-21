-- Existing projects retain the prior automatic ordinary-operation policy.
ALTER TABLE projects ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'auto' CHECK (approval_mode IN ('ask','auto','full'));

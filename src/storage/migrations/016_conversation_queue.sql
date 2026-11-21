ALTER TABLE conversations ADD COLUMN queue_paused INTEGER NOT NULL DEFAULT 0 CHECK(queue_paused IN (0,1));
CREATE TABLE conversation_queue (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 owner_user_id TEXT NOT NULL REFERENCES users(id),
 client_key TEXT NOT NULL,
 text TEXT NOT NULL,
 attachment_ids_json TEXT NOT NULL DEFAULT '[]',
 position INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','dispatched','cancelled')),
 message_id TEXT,
 created_at TEXT NOT NULL,
 UNIQUE(conversation_id,client_key)
);
CREATE INDEX idx_conversation_queue ON conversation_queue(conversation_id,state,position);

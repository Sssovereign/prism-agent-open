-- Both ordinary and research runners persist public events. Keep notification
-- marking in that same transaction, including rollback and producer deduplication.
CREATE TRIGGER sidebar_unread_on_event
AFTER INSERT ON run_events
WHEN NEW.visibility = 'public' AND NEW.type IN (
  'run.succeeded', 'run.failed', 'run.waiting_input',
  'run.needs_reconciliation', 'approval.requested', 'tool.awaiting_approval'
)
BEGIN
  UPDATE conversations
  SET unread_at = CASE WHEN NEW.occurred_at > updated_at THEN NEW.occurred_at
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds') END,
      updated_at = CASE WHEN NEW.occurred_at > updated_at THEN NEW.occurred_at
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds') END
  WHERE id = (SELECT conversation_id FROM runs WHERE id = NEW.run_id)
    AND archived_at IS NULL;
END;

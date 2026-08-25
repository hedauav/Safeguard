-- ============================================
-- Migration 0015: escalations that did not happen during a call
--
-- Two defects in one table, both of them about records that do not describe
-- anything real.
--
-- 1. escalations.call_log_id was NOT NULL, but the escalation tool is invoked
--    without any call context. The service satisfied the constraint by
--    inserting a synthetic call_logs row — direction 'inbound', status
--    'in_progress', no ended_at — for every escalation. Those rows are calls
--    that never happened: they sat in Call History forever and counted
--    permanently towards analytics.calls_by_status.in_progress. Making the
--    column nullable lets an escalation raised outside a call simply have no
--    call attached, which is what is true.
--
-- 2. The reference number the agent reads aloud to the caller existed only
--    inside the free-text `notes` string, so the thing a distressed caller was
--    told to quote could not be looked up by anyone. It gets a column and a
--    unique constraint, and the service generates it from a CSPRNG over a
--    100M-value space rather than Math.random() over 10,000.
--
-- Additive and idempotent. Safe to re-run.
--
-- Note on the phantom rows already in call_logs: this migration does not
-- delete them. Deleting call records is exactly the kind of unreviewed write
-- that put them there, so the cleanup is left to be run deliberately — the
-- statement is at the bottom of this file, commented out.
-- ============================================

-- --- 1. An escalation need not belong to a call -----------------------------

ALTER TABLE escalations
  ALTER COLUMN call_log_id DROP NOT NULL;

COMMENT ON COLUMN escalations.call_log_id IS
  'The call this escalation was raised during, or NULL when it was raised outside one. Never fabricate a call_logs row to fill this in — a synthetic call inflates the in-progress call count forever.';

-- --- 2. The reference number is a column, not prose -------------------------

ALTER TABLE escalations
  ADD COLUMN IF NOT EXISTS reference_number TEXT;

COMMENT ON COLUMN escalations.reference_number IS
  'The reference read aloud to the caller, e.g. ESC-2026-04817263. Unique, so the number the agent promises is the number a supervisor can find. NULL only on rows written before this migration, whose reference survives only in notes.';

-- Shape check, so a reference that cannot be read back over the phone in the
-- canonical PREFIX-YEAR-SERIAL form cannot be stored. NULL is allowed for the
-- historical rows; every new row carries one.
ALTER TABLE escalations
  DROP CONSTRAINT IF EXISTS escalations_reference_number_format;
ALTER TABLE escalations
  ADD CONSTRAINT escalations_reference_number_format
  CHECK (reference_number IS NULL OR reference_number ~ '^ESC-[0-9]{4}-[0-9]{8}$');

-- The database-level half of the uniqueness guarantee. A partial index so the
-- pre-migration rows, which have no reference at all, do not collide with each
-- other. The service retries on this constraint firing rather than treating a
-- collision as an outage.
CREATE UNIQUE INDEX IF NOT EXISTS idx_escalations_reference_number
  ON escalations(reference_number)
  WHERE reference_number IS NOT NULL;

-- The supervisor queue is read newest-first and filtered by status.
CREATE INDEX IF NOT EXISTS idx_escalations_status_created
  ON escalations(status, created_at DESC);

-- --- Cleanup of the fabricated call_logs rows (deliberate, not automatic) ----
--
-- Every escalation-era phantom has the same signature: an inbound call with no
-- ended_at, no duration, no transcript, no summary, no ElevenLabs conversation
-- id, and no customer. Inspect before deleting — a genuinely live call at the
-- moment you run this matches the same shape.
--
--   SELECT c.id, c.started_at
--     FROM call_logs c
--    WHERE c.status = 'in_progress'
--      AND c.ended_at IS NULL
--      AND c.customer_id IS NULL
--      AND c.transcript IS NULL
--      AND c.summary IS NULL
--      AND c.elevenlabs_conversation_id IS NULL
--      AND c.started_at < now() - interval '1 hour'
--      AND NOT EXISTS (SELECT 1 FROM call_tool_executions t WHERE t.call_log_id = c.id);
--
-- Then, having checked the list, detach any escalations pointing at them (now
-- possible, because the column is nullable) and delete:
--
--   UPDATE escalations SET call_log_id = NULL WHERE call_log_id IN (<ids>);
--   DELETE FROM call_logs WHERE id IN (<ids>);

-- ============================================
-- Migration 0022: why the Filecoin upload failed
--
-- `filecoin_uploads` records that an archival attempt failed. It has never
-- recorded why, because 0003 gave it no column to put a reason in. The
-- pipeline writes upload_status = 'failed' and drops the provider's message
-- into a log line that a hosted runtime rotates away within the day.
--
-- That gap is not academic here. Archival in this deployment has failed on
-- every attempt it has ever made: /health reports `last_success_at: null` for
-- filecoin_uploads, and live claim rows carry filecoin_cid, piece_cid and
-- dataset_id all NULL. Chain attestation, by contrast, genuinely works — there
-- is a real Base Sepolia transaction behind it. So the deployment has one
-- subsystem that has never once succeeded, and the only artefact it leaves
-- behind is the word 'failed'.
--
-- The comment at filecoin-service.ts names a likely cause — an unfunded USDFC
-- Warm Storage rail reverting with InsufficientLockupFunds — and DEPLOYMENT.md
-- repeats it. Neither is evidence. Nobody has ever seen the actual message,
-- because there has never been anywhere to keep it. One nullable TEXT column
-- turns the next failure into a diagnosis instead of another guess.
--
-- Additive and idempotent. Safe to re-run.
-- ============================================

-- --- 1. The reason ----------------------------------------------------------
--
-- Nullable, and no backfill. Every row that already exists failed for a reason
-- that no longer exists anywhere, and writing a plausible-sounding one in now
-- would be inventing evidence — the exact habit the evidence pipeline was
-- rewritten to break. NULL here means "this attempt predates the column", and
-- that is the honest thing for it to mean.
--
-- TEXT rather than a code or an enum. The useful part of a Synapse failure is
-- the provider's own sentence, revert data and all; classifying it into a
-- short list would throw away the detail on the very first failure anyone
-- looks at, which is the failure this column exists for.

ALTER TABLE filecoin_uploads
  ADD COLUMN IF NOT EXISTS error TEXT;

COMMENT ON COLUMN filecoin_uploads.error IS
  'Why the attempt did not fully succeed, verbatim from the upload layer. On a ''failed'' row this is the reason nothing was stored. On a ''completed'' row it is set only when the piece was stored with fewer copies than were attempted, and the text says so. NULL means either a clean success or an attempt made before this column existed — never "failed for no reason".';

-- --- 2. Guards --------------------------------------------------------------

-- A blank string is worse than NULL: NULL says "we do not know", '' says "we
-- looked and the answer was nothing", and a reader cannot tell the second from
-- a bug. The service already refuses to produce one; this makes it unwritable.
ALTER TABLE filecoin_uploads
  DROP CONSTRAINT IF EXISTS filecoin_uploads_error_not_blank;
ALTER TABLE filecoin_uploads
  ADD CONSTRAINT filecoin_uploads_error_not_blank
  CHECK (error IS NULL OR length(btrim(error)) > 0);

-- DELIBERATELY ABSENT: CHECK (upload_status <> 'failed' OR error IS NOT NULL).
--
-- It is the constraint this migration is obviously for, and adding it would
-- make the migration itself unrunnable. Every failed row already in the live
-- table has a NULL error, so Postgres would reject the ADD CONSTRAINT and the
-- column would never land — on the one database that most needs it. Adding it
-- NOT VALID would work and would still be wrong: it would then be enforced on
-- new rows only, silently, which is a rule that reads as absolute in the
-- schema and is not. The pipeline is the place that guarantees this, and it
-- does; revisit here once no NULL-error failure rows remain.

-- --- 3. Indexes -------------------------------------------------------------

-- The only question this column is ever asked: what went wrong most recently,
-- and has it been the same thing every time. Partial, because a healthy row
-- has no error and would only bloat a scan that never wants it — and in a
-- deployment where archival has never succeeded, the partial index and the
-- full one would be the same size anyway. That is the point of measuring it.
CREATE INDEX IF NOT EXISTS idx_filecoin_uploads_error_attempted
  ON filecoin_uploads(attempted_at DESC)
  WHERE error IS NOT NULL;

-- --- 4. Row-level security --------------------------------------------------
--
-- 0007 put filecoin_uploads in its blanket-read list: RLS on, with a SELECT
-- policy granting anon and authenticated everything in the table. A new column
-- inherits that policy automatically, so without the revoke below this
-- migration would publish raw upload failure text to anyone holding the
-- publishable key — and that key ships inside the frontend bundle.
--
-- That matters more for this column than for the rest of the table. The other
-- columns are CIDs and timestamps. This one is whatever the storage layer
-- threw, unedited, and the strings that layer throws routinely carry the
-- agent's wallet address, the Warm Storage contract it was talking to, and the
-- Calibration RPC endpoint — which is a URL that in most hosted setups has an
-- API key in its path. None of that is something a browser needs.
--
-- And nothing is losing access. 0016 established that the only client-side
-- Supabase reads in this frontend are against `claims`; every read of
-- filecoin_uploads goes through the backend on the service role key, which
-- bypasses RLS and column privileges alike. The health endpoint, check-setup
-- and the evidence pipeline all sit on that key and are unaffected.
--
-- Column-level rather than dropping 0007's policy outright, because the rest
-- of the table's blanket read is 0007's decision to revisit, not this
-- migration's. The one caller this would break is an anon `select=*` over
-- filecoin_uploads, which would start returning "permission denied for column
-- error" instead of quietly leaking it. There is no such caller today.
--
-- To undo:  GRANT SELECT (error) ON filecoin_uploads TO anon, authenticated;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    -- Guarded so this file also runs against a plain Postgres that has never
    -- heard of Supabase's roles, rather than aborting the whole migration on
    -- a role that does not exist.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE SELECT (error) ON filecoin_uploads FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- Not added to the supabase_realtime publication, and neither is the table.
-- Streaming archival failures to the browser would be a second exposure that
-- the revoke above does not gate.

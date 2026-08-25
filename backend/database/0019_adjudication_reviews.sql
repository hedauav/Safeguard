-- ============================================
-- Migration 0019: the human decision
--
-- 0017 records what the AI recommended, and is careful to say, in its header
-- and in its constraints, that a recommendation is not a decision. It leaves
-- claims.status alone. That was the right call and it left a hole: there was
-- nowhere for the human's answer to go, and so no way to tell a claim nobody
-- had looked at from a claim somebody had read and waved through.
--
-- This table is that answer. One row per adjudication, written only when a
-- person with the admin token presses Approve or Reject on the review queue.
--
-- What it holds and why:
--   * WHO decided and WHEN — the two things an audit of an AI-assisted process
--     is actually asked for. Neither is inferable from anywhere else.
--   * The verdict the AI recommended AT THE TIME, snapshotted. Adjudications
--     are re-runnable; a later run must not be able to rewrite what the
--     reviewer was looking at when they decided. Stored here, an override
--     ("the model said escalate, the reviewer approved") stays legible forever.
--   * The claim status before and after. The status write is a separate
--     statement from this insert and can fail on its own. claim_status_after
--     NULL therefore means something real — the decision was recorded and the
--     claim was not moved — and the queue renders that rather than hiding it.
--
-- Additive and idempotent. Safe to re-run.
-- ============================================

CREATE TABLE IF NOT EXISTS adjudication_reviews (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- UNIQUE: one adjudication gets one decision. A double-clicked Approve
  -- button must not be able to write a second, and a reviewer who wants a
  -- different answer needs a fresh adjudication, not a quiet overwrite.
  adjudication_id     UUID NOT NULL UNIQUE REFERENCES adjudications(id) ON DELETE CASCADE,

  claim_id            UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  -- Denormalised for the same reason 0017 denormalises it: an audit row must
  -- stay readable after the claim it refers to has been renumbered or removed.
  claim_number        TEXT NOT NULL,

  -- What the human did. Deliberately NOT the same vocabulary as
  -- adjudications.verdict: a verdict is a recommendation, a decision is a
  -- decision, and using one word for both is how the distinction erodes.
  decision            TEXT NOT NULL,          -- 'approved' | 'rejected'

  -- Who. Free text supplied by the caller holding the admin token; this system
  -- has no user accounts, so this is an attribution, not an authentication.
  -- The token is what authorises; this records who says they used it.
  reviewer            TEXT NOT NULL,
  note                TEXT,

  -- The recommendation as it stood when the button was pressed.
  recommended_verdict TEXT NOT NULL,
  -- Whether the model was consulted at all for that recommendation, snapshotted
  -- so "a human overrode a rule veto" can be told from "a human overrode a
  -- model" without re-reading the adjudication row.
  model_invoked       BOOLEAN NOT NULL DEFAULT false,

  claim_status_before TEXT,
  -- NULL means the claim status was not changed: the write failed, or the
  -- claim was already paid or closed and this queue refused to move it.
  claim_status_after  TEXT,

  decided_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE adjudication_reviews IS
  'The human decision on one AI adjudication. Written only by the admin-token-guarded review endpoint. One row per adjudication, enforced by a unique constraint.';

COMMENT ON COLUMN adjudication_reviews.reviewer IS
  'Who says they decided. The admin token authorises the write; this column attributes it. There are no user accounts in this system, so it is not proof of identity and must never be presented as one.';

COMMENT ON COLUMN adjudication_reviews.recommended_verdict IS
  'adjudications.verdict as it stood when the decision was made, snapshotted so a later re-run cannot rewrite what the reviewer was looking at.';

COMMENT ON COLUMN adjudication_reviews.claim_status_after IS
  'NULL means the claim status was NOT changed by this decision — the update failed, or the claim was already paid/closed. A NULL here is a fact to render, not a gap to hide.';

ALTER TABLE adjudication_reviews
  DROP CONSTRAINT IF EXISTS adjudication_reviews_decision_check;
ALTER TABLE adjudication_reviews
  ADD CONSTRAINT adjudication_reviews_decision_check
  CHECK (decision IN ('approved', 'rejected'));

-- A decision with no one attached to it is not an audit record.
ALTER TABLE adjudication_reviews
  DROP CONSTRAINT IF EXISTS adjudication_reviews_reviewer_present;
ALTER TABLE adjudication_reviews
  ADD CONSTRAINT adjudication_reviews_reviewer_present
  CHECK (length(btrim(reviewer)) > 0);

ALTER TABLE adjudication_reviews
  DROP CONSTRAINT IF EXISTS adjudication_reviews_recommended_verdict_check;
ALTER TABLE adjudication_reviews
  ADD CONSTRAINT adjudication_reviews_recommended_verdict_check
  CHECK (recommended_verdict IN ('approve', 'deny', 'escalate'));

-- --- Indexes ----------------------------------------------------------------

-- "What has been decided lately, and by whom."
CREATE INDEX IF NOT EXISTS idx_adjudication_reviews_decided
  ON adjudication_reviews(decided_at DESC);

-- The queue's join: given a page of adjudications, which already have answers.
CREATE INDEX IF NOT EXISTS idx_adjudication_reviews_claim
  ON adjudication_reviews(claim_id, decided_at DESC);

-- --- Row-level security -----------------------------------------------------
--
-- Follows 0016 and 0017: RLS on, no policy at all. In Supabase a table without
-- RLS is fully readable AND writable through PostgREST by the anon key, and
-- that key ships in the frontend bundle.
--
-- INSERT rights here would let anyone fabricate a human approval — a row
-- naming an adjuster who never saw the claim. The dashboard reads this table
-- through the backend, which holds the service role key and bypasses RLS, and
-- writes to it only behind ADMIN_TOKEN. The browser needs no access of its own.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'adjudication_reviews') THEN
    EXECUTE 'ALTER TABLE adjudication_reviews ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS dashboard_read_adjudication_reviews ON adjudication_reviews';
  END IF;
END $$;

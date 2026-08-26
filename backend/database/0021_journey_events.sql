-- ============================================
-- Migration 0021: journey_events — the spine a claim's history hangs on
--
-- Nothing in this schema records what happened to a claim, or when. There is
-- no claim_events table, no status_history, not even an updated_at trigger:
-- `claims` carries a single `status` column that is overwritten in place, so
-- the moment a claim moves from 'submitted' to 'under_review' the fact that it
-- was ever 'submitted' is gone, along with who moved it and why.
--
-- The consequences are not theoretical:
--
-- 1. The claim page shows one status badge over ten per-step tables it never
--    reads (adjudications, adjudication_reviews, claim_documents,
--    deductible_payments, evidence_bundles, filecoin_uploads, escalations,
--    policy_renewals, settlements, call_logs). "Where has this claim reached?"
--    is answerable today only by UNION-ing ten tables on their own timestamp
--    columns and hoping their clocks agree.
-- 2. A step that FAILED leaves no trace at all. A renewal payment that was
--    declined, an adjudication whose model call threw, a deductible link that
--    expired unpaid — every one of those is a row that never gets written, so
--    the record of the journey is silently a record only of its successes.
--    That is the defect this table exists to fix. A failure is an event.
-- 3. A renewal has no claim to hang off. It belongs to a policy, and often
--    there is no claim in the story at all yet — the caller rang to file one,
--    was refused because the policy had lapsed, paid to renew, and only then
--    filed. Keeping renewals in a claim-keyed table would either lose them or
--    invent a claim to hold them.
--
-- Hence: ONE table, claim_id and policy_id both nullable, with a CHECK that at
-- least one is set. "policy lapsed → renewed → reactivated → claim filed →
-- adjudicated → decided → deductible paid → settled → refunded" then reads
-- back as one ordered story from one place, rather than as ten fragments.
--
-- APPEND-ONLY. The writer inserts and never updates or deletes. A row here is
-- a statement that something happened at a moment, and those do not stop being
-- true later. Correcting one means appending the correction, not editing the
-- claim history until it agrees with the present.
--
-- WHAT THIS TABLE IS NOT:
-- It is not a replacement for the per-step tables, and it does not duplicate
-- them. deductible_payments still holds the Razorpay payment id and the
-- amounts; adjudications still holds the prompt and the raw response. This
-- table holds the ordering and a small JSONB `detail` for what a reader needs
-- to see in a timeline without opening the detail table. The per-step tables
-- stay authoritative for their own facts.
--
-- It is also not a decision anywhere. Writing 'decided' here records that a
-- decision was made; claims.status remains what the deciding code sets.
--
-- Additive and idempotent. Safe to re-run.
-- ============================================

-- --- 1. The table -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS journey_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Both nullable, at least one set — see the constraint below. A claim event
  -- normally carries its policy too, and is welcome to; a renewal carries only
  -- the policy, because there is no claim yet and inventing one would be the
  -- same mistake 0015 was written to undo.
  --
  -- ON DELETE CASCADE on both, for two reasons. reseed.sh deletes call_logs,
  -- then claims, then policies, then customers; a restricting foreign key here
  -- would make that script fail on its second line. And history about a claim
  -- that no longer exists is not history, it is an orphan nobody can resolve.
  -- The append-only rule is a rule about the application: no code path in this
  -- repository updates or deletes a row here.
  claim_id    UUID REFERENCES claims(id)   ON DELETE CASCADE,
  policy_id   UUID REFERENCES policies(id) ON DELETE CASCADE,

  -- Deliberately NOT a CHECK-constrained enum. Six separate workstreams write
  -- to this table — claim_filed, adjudicated, documents_requested,
  -- document_received, escalated, decided, deductible_requested,
  -- deductible_paid, settled, refunded, renewal_offered, renewal_paid,
  -- renewal_failed, policy_reactivated, assessment_explained — and a closed
  -- list here would mean a migration every time a step is added, with the
  -- alternative being that the recording SILENTLY FAILS at the exact moment
  -- someone adds a step and forgets. A lost event is worse than an
  -- unrecognised one: the reader can render an unknown event_type verbatim,
  -- but it cannot render a row that was refused. The one thing it may not be
  -- is empty, which is always a bug rather than a new step.
  event_type  TEXT NOT NULL,

  -- Who or what did it. This one IS closed, because it is a four-way
  -- distinction with real consequences for how a row should be read:
  --   'agent'    the voice agent, acting on a live call
  --   'system'   this backend, acting on its own (auto-adjudication, a job)
  --   'human'    a named person in the review queue
  --   'provider' an outside party telling us something — a Razorpay webhook
  -- Conflating 'human' with 'agent' would let a timeline claim a person
  -- approved something a model did, which is the single worst sentence this
  -- table could be made to say.
  actor       TEXT NOT NULL,

  -- Whatever the timeline needs to render this step without opening the
  -- per-step table: an amount, a reference number, a refusal reason. Never the
  -- authoritative copy of anything — see the header.
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- When the thing happened, which is not always when the row was written: a
  -- webhook records a capture Razorpay timestamped earlier, and a retried
  -- delivery records it later still. The timeline orders by this; created_at
  -- stays as the audit fact of when we learned it.
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The call this happened during, or NULL when it happened outside one —
  -- exactly as 0015 made escalations.call_log_id nullable. Most events have no
  -- call: a webhook capture, a reviewer's decision, a background adjudication.
  -- ON DELETE SET NULL rather than CASCADE or RESTRICT: 0015 leaves a
  -- deliberate, commented-out cleanup for the phantom call_logs rows it
  -- describes, and this table must neither block that cleanup nor let it take
  -- a claim's history down with it. Losing the pointer to a deleted call is
  -- acceptable; losing the event is not.
  call_log_id UUID REFERENCES call_logs(id) ON DELETE SET NULL,

  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Stated separately so re-running against a table created by an earlier form
-- of this migration still converges.
ALTER TABLE journey_events
  ADD COLUMN IF NOT EXISTS claim_id    UUID,
  ADD COLUMN IF NOT EXISTS policy_id   UUID,
  ADD COLUMN IF NOT EXISTS detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS call_log_id UUID;

COMMENT ON TABLE journey_events IS
  'Append-only record of every step in a claim or policy journey, including the steps that failed. Never updated, never deleted. The per-step tables (adjudications, deductible_payments, policy_renewals, claim_documents, escalations) stay authoritative for their own facts; this table supplies the ordering that makes them a timeline.';

COMMENT ON COLUMN journey_events.claim_id IS
  'The claim this step belongs to, or NULL when there is no claim yet — a renewal on a lapsed policy is the ordinary case. At least one of claim_id and policy_id is always set.';

COMMENT ON COLUMN journey_events.policy_id IS
  'The policy this step belongs to. Set on renewal and reactivation events, and welcome on claim events too, so that a policy''s whole story can be read without joining through claims.';

COMMENT ON COLUMN journey_events.event_type IS
  'What happened, e.g. claim_filed, adjudicated, documents_requested, decided, deductible_paid, settled, refunded, renewal_offered, renewal_failed, policy_reactivated. Deliberately not a closed enum: a step nobody anticipated must be recordable rather than silently refused.';

COMMENT ON COLUMN journey_events.actor IS
  'Who acted: ''agent'' (the voice agent on a live call), ''system'' (this backend, unattended), ''human'' (a named reviewer), ''provider'' (an outside party such as a Razorpay webhook). Never record a model''s action as ''human''.';

COMMENT ON COLUMN journey_events.detail IS
  'Small, render-only payload for the timeline — an amount, a reference, a refusal reason. Not the authoritative copy of anything; the per-step table owns that.';

COMMENT ON COLUMN journey_events.occurred_at IS
  'When the step happened, which for a webhook-sourced event is earlier than when the row was written. The timeline orders by this; created_at records when we learned of it.';

COMMENT ON COLUMN journey_events.call_log_id IS
  'The call this step happened during, or NULL when it happened outside one. Never fabricate a call_logs row to fill this in — 0015 exists because that was done once already.';

-- --- 2. Guards --------------------------------------------------------------

-- The one rule that makes a single table safe to share between claim journeys
-- and policy journeys: an event that belongs to neither belongs nowhere, and
-- would sit in the table forever appearing on no timeline. The service refuses
-- it first and says so; this makes it unwritable regardless.
ALTER TABLE journey_events
  DROP CONSTRAINT IF EXISTS journey_events_belongs_to_something;
ALTER TABLE journey_events
  ADD CONSTRAINT journey_events_belongs_to_something
  CHECK (claim_id IS NOT NULL OR policy_id IS NOT NULL);

-- Closed, because the four values mean different things to a reader. See the
-- column comment above.
ALTER TABLE journey_events
  DROP CONSTRAINT IF EXISTS journey_events_actor_check;
ALTER TABLE journey_events
  ADD CONSTRAINT journey_events_actor_check
  CHECK (actor IN ('agent', 'system', 'human', 'provider'));

-- Not an enum, but not nothing either. A blank event_type renders as a blank
-- row in the timeline: the reader can see something happened and can never
-- find out what.
ALTER TABLE journey_events
  DROP CONSTRAINT IF EXISTS journey_events_event_type_not_blank;
ALTER TABLE journey_events
  ADD CONSTRAINT journey_events_event_type_not_blank
  CHECK (length(btrim(event_type)) > 0);

-- --- 3. Indexes -------------------------------------------------------------

-- The only query the claim page makes: this claim's timeline, newest first.
-- Partial, because policy-only rows have no claim_id and NULLs would bloat it
-- for a scan that never wants them.
CREATE INDEX IF NOT EXISTS idx_journey_events_claim_occurred
  ON journey_events(claim_id, occurred_at DESC)
  WHERE claim_id IS NOT NULL;

-- The renewal half of the same question: what has happened to this policy.
CREATE INDEX IF NOT EXISTS idx_journey_events_policy_occurred
  ON journey_events(policy_id, occurred_at DESC)
  WHERE policy_id IS NOT NULL;

-- DELIBERATELY ABSENT: any unique index over (claim_id, event_type).
--
-- It is tempting, and it is wrong. A claim can legitimately have two
-- documents_requested events, two escalations, a renewal_failed followed by a
-- renewal_paid. Repetition is the story, not a duplicate — and a unique index
-- would turn "this happened twice" into a write that fails silently in a
-- background .catch(), which is precisely the failure mode this table was
-- built to end.

-- --- 4. Row-level security --------------------------------------------------
--
-- Follows 0016, not 0007: RLS on, no policy at all. In Supabase a table
-- without RLS is fully readable AND writable through PostgREST by the anon
-- key, and that key is embedded in the shipped frontend bundle.
--
-- Read access would publish a complete per-customer narrative — when they
-- claimed, what was refused and why, what they were charged, what was refunded
-- — in one query, with no join needed. Write access is worse: INSERT rights on
-- an append-only audit table let anyone fabricate history that no other table
-- contradicts, because this table's whole purpose is to be the record when the
-- others are silent.
--
-- Nothing in the frontend reads it from the browser. The claim page gets the
-- timeline from GET /claims/:id, served by the backend, which holds the
-- service role key and bypasses RLS entirely. With RLS enabled and zero
-- policies the anon and authenticated roles get nothing — no SELECT, no
-- INSERT, no UPDATE, no DELETE — while the service role continues unchanged.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'journey_events') THEN
    EXECUTE 'ALTER TABLE journey_events ENABLE ROW LEVEL SECURITY';
    -- Defensive: if a copy of 0007's blanket-read loop ever ran over this
    -- table, drop what it left behind. Re-running must converge on "no policy".
    EXECUTE 'DROP POLICY IF EXISTS dashboard_read_journey_events ON journey_events';
  END IF;
END $$;

-- Not added to the supabase_realtime publication. The claim page polls, which
-- is honest about what it is, and publication membership is a second, separate
-- exposure that RLS does not gate the way it gates table reads.

-- ============================================
-- Migration 0020: the paid half of a policy renewal
--
-- 0012 gave a lapsed policy a payment link. It did not give it a way back into
-- force, and the gap was not cosmetic: `policy_renewals` recorded the link and
-- nothing else — no payment id, no captured amount, no paid timestamp — so a
-- customer could pay a real premium with real money and the policy stayed
-- expired forever. Nothing in the codebase wrote to `policies` at all.
--
-- These columns are the landing place for a signature-verified
-- `payment_link.paid` webhook, and the audit trail for the one write in this
-- system that puts a policy back in force.
--
--   REAL      Collecting the renewal premium. A Razorpay payment link, an
--             ordinary card or UPI capture, recorded here from a signed
--             webhook.
--   REAL      Extending the policy term. Not a movement of money — a change of
--             state in our own records, made only because the money above
--             actually arrived.
--
-- WHAT MONEY STILL CANNOT DO, and this is deliberate: it cannot reinstate a
-- CANCELLED policy. A lapse is the absence of payment and paying cures it. A
-- cancellation is a decision somebody made — for non-payment, for fraud, or at
-- the customer's own request — and a decision is not reversed by a card being
-- charged. The handler refuses that case loudly and leaves the row untouched
-- for a human to reconcile.
--
-- Additive and idempotent. Safe to re-run.
-- ============================================

-- --- 1. The capture ---------------------------------------------------------
--
-- All NULL until a signed webhook fills them in. A row with a NULL payment_id
-- has received no money, and the policy above it has been extended by nothing.

ALTER TABLE policy_renewals
  ADD COLUMN IF NOT EXISTS payment_id            TEXT,        -- Razorpay payment id of the capture
  ADD COLUMN IF NOT EXISTS captured_amount_paise BIGINT,      -- what the rail says actually arrived
  ADD COLUMN IF NOT EXISTS captured_at           TIMESTAMPTZ, -- when it was paid, per the rail
  ADD COLUMN IF NOT EXISTS capture_event_id      TEXT;        -- the webhook delivery that recorded it

-- --- 2. What the capture did to the policy ----------------------------------
--
-- The deductible table records a capture and stops, because recording it
-- changes nothing else. This one mutates `policies`, so it has to say what it
-- did. Without these three columns the question "why does this policy run to
-- 2027?" has no answer anywhere in the system, and an extension nobody can
-- justify is exactly the kind of state this codebase refuses to create.
--
-- new_end_date is also load-bearing at runtime, not just for audit: it is the
-- target the handler re-applies if the write to `policies` failed after the
-- capture was recorded. Storing the target rather than recomputing it is what
-- makes the repair idempotent — recomputing "term_months from today" on a
-- retry would push the date out a second time.

ALTER TABLE policy_renewals
  ADD COLUMN IF NOT EXISTS previous_end_date DATE,        -- policies.end_date as it stood before
  ADD COLUMN IF NOT EXISTS new_end_date      DATE,        -- policies.end_date as this renewal set it
  ADD COLUMN IF NOT EXISTS activated_at      TIMESTAMPTZ; -- when the policy was put back in force

COMMENT ON COLUMN policy_renewals.payment_id IS
  'Set only by the signature-verified Razorpay webhook. A row with a NULL payment_id has received no money and has extended no policy.';

COMMENT ON COLUMN policy_renewals.captured_amount_paise IS
  'The rail''s figure, not ours. A capture short of amount_paise is refused rather than recorded: a part-paid premium does not buy a term.';

COMMENT ON COLUMN policy_renewals.new_end_date IS
  'The end date this renewal put on the policy. Recorded so the extension can be justified after the fact, and so a failed write to policies can be re-applied to the same target instead of a freshly computed one.';

COMMENT ON COLUMN policy_renewals.previous_end_date IS
  'policies.end_date immediately before the extension. NULL means no extension was applied by this row.';

-- --- 3. Guards --------------------------------------------------------------
--
-- Each one mirrors a refusal the service already makes, so that bypassing the
-- service — a console session, a future endpoint, a bug — still cannot write a
-- state nobody can justify.

-- Money that arrived must have a payment behind it. A captured amount with no
-- payment id is an amount from nowhere.
ALTER TABLE policy_renewals
  DROP CONSTRAINT IF EXISTS policy_renewals_capture_needs_payment;
ALTER TABLE policy_renewals
  ADD CONSTRAINT policy_renewals_capture_needs_payment
  CHECK (captured_amount_paise IS NULL OR payment_id IS NOT NULL);

-- A capture of zero is not a capture.
ALTER TABLE policy_renewals
  DROP CONSTRAINT IF EXISTS policy_renewals_capture_positive;
ALTER TABLE policy_renewals
  ADD CONSTRAINT policy_renewals_capture_positive
  CHECK (captured_amount_paise IS NULL OR captured_amount_paise > 0);

-- An extension only exists because money arrived. A new_end_date with no
-- payment behind it is cover granted for free.
ALTER TABLE policy_renewals
  DROP CONSTRAINT IF EXISTS policy_renewals_extension_needs_payment;
ALTER TABLE policy_renewals
  ADD CONSTRAINT policy_renewals_extension_needs_payment
  CHECK (new_end_date IS NULL OR payment_id IS NOT NULL);

-- A renewal extends a term; it never shortens one. If these two ever cross,
-- something computed a date backwards and the row must not be writable.
ALTER TABLE policy_renewals
  DROP CONSTRAINT IF EXISTS policy_renewals_extension_moves_forward;
ALTER TABLE policy_renewals
  ADD CONSTRAINT policy_renewals_extension_moves_forward
  CHECK (
    new_end_date IS NULL
    OR previous_end_date IS NULL
    OR new_end_date > previous_end_date
  );

-- --- 4. Idempotency ---------------------------------------------------------

-- One capture belongs to exactly one renewal. Partial, because every
-- unpaid link is NULL here and NULLs do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_renewals_payment_id
  ON policy_renewals(payment_id) WHERE payment_id IS NOT NULL;

-- DELIBERATELY ABSENT: any "one capture per policy" index.
--
-- 0018 has one of those on deductible_payments, because a claim carries
-- exactly one excess and being paid twice for it is always wrong. A policy is
-- the opposite: it is renewed once a term, for as long as the customer keeps
-- it, and each of those is a separate legitimate capture against a separate
-- link. Copying the deductible's index here would make the second year of a
-- policy unwritable.

-- The webhook's reverse lookup, from a link id to the renewal it belongs to,
-- is already served by the unique index on payment_link_id in 0012.

-- Reconciliation's question: which renewals were paid, and when.
CREATE INDEX IF NOT EXISTS idx_policy_renewals_captured_at
  ON policy_renewals(captured_at) WHERE captured_at IS NOT NULL;

-- --- 5. Row-level security --------------------------------------------------
--
-- Nothing to do. 0016 already enables RLS on policy_renewals with no anon or
-- authenticated policy at all, and columns added to a table inherit that: the
-- anon key that ships in the frontend bundle gets no SELECT, no INSERT, no
-- UPDATE and no DELETE here, while the backend's service role key bypasses RLS
-- and continues to work unchanged.
--
-- That inheritance is worth stating rather than assuming, because these
-- columns are the first on this table to carry a Razorpay payment id.

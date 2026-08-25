-- ============================================
-- Migration 0018: deductible collection and waiver
--
-- This is the one loop in the system where real money moves in both
-- directions, so it is worth being exact about which half is which.
--
--   REAL      The claimant pays their policy deductible when filing. A
--             Razorpay payment link, an ordinary card or UPI capture,
--             recorded here from a signature-verified webhook.
--   REAL      If the claim settles with the other party at fault, the
--             deductible is waived and refunded — POST /v1/payments/:id/refund
--             against that capture. The money genuinely goes back.
--   SIMULATED The settlement of the claim itself. Paying a claimant is a
--             payout, payouts require RazorpayX and business KYC, and this
--             account has neither. payout-provider.ts is a labelled simulation
--             and every row it writes says so.
--
-- The waiver is not a stand-in for the settlement. Returning the excess on a
-- claim the policyholder did not cause is an ordinary insurance operation with
-- its own justification, and nothing in this schema or in the code above it
-- describes it as anything else.
--
-- Additive and idempotent. Safe to re-run.
-- ============================================

-- --- 1. Who was at fault ----------------------------------------------------
--
-- The waiver turns on a finding of fact, and there was nowhere to record one.
-- Nothing on the agent path writes these columns: a language model on a phone
-- line does not get to decide who caused a collision, and the refund gate
-- refuses outright until a human has recorded a determination. That refusal is
-- the desired behaviour, not a gap — 'undetermined' and NULL both mean "no
-- refund", and they mean it loudly.

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS fault_determination TEXT,       -- who was at fault, once someone has decided
  ADD COLUMN IF NOT EXISTS fault_determined_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fault_determined_by TEXT;       -- the adjuster who made the finding

COMMENT ON COLUMN claims.fault_determination IS
  'Who was at fault. Only ''other_party'' waives the deductible; ''shared'' does not. Set by a human adjuster — no agent-facing endpoint writes this column.';

ALTER TABLE claims
  DROP CONSTRAINT IF EXISTS claims_fault_determination_check;
ALTER TABLE claims
  ADD CONSTRAINT claims_fault_determination_check
  CHECK (fault_determination IS NULL OR fault_determination IN (
    'insured', 'other_party', 'shared', 'undetermined'
  ));

-- --- 2. The deductible payment itself ---------------------------------------

CREATE TABLE IF NOT EXISTS deductible_payments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id              UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  policy_id             UUID NOT NULL REFERENCES policies(id),
  provider              TEXT NOT NULL,          -- rail that issued the link: 'razorpay' or 'simulated'
  payment_link_id       TEXT NOT NULL,          -- provider's payment link id
  short_url             TEXT NOT NULL,          -- the URL read out to the caller
  amount_paise          BIGINT NOT NULL,        -- the deductible demanded, in minor units
  status                TEXT NOT NULL,          -- link status at the time of the write

  reference_id          TEXT NOT NULL,          -- our deterministic per-claim reference
  simulated             BOOLEAN NOT NULL DEFAULT false,

  -- Filled in only by the signed Razorpay webhook. Until payment_id is set,
  -- no money has been shown to have arrived and no refund is possible.
  payment_id            TEXT,                   -- Razorpay payment id of the capture
  captured_amount_paise BIGINT,                 -- what the rail says was actually captured
  captured_at           TIMESTAMPTZ,
  capture_event_id      TEXT,                   -- the webhook delivery that recorded it

  -- Filled in only by a successful refund.
  refund_id             TEXT,
  refund_status         TEXT,
  refund_amount_paise   BIGINT,
  refund_receipt        TEXT,                   -- Razorpay treats this as an idempotency key
  refund_simulated      BOOLEAN NOT NULL DEFAULT false,
  refunded_at           TIMESTAMPTZ,

  created_at            TIMESTAMPTZ DEFAULT now()
);

-- Stated separately so re-running against a table created by an earlier form
-- of this migration still converges.
ALTER TABLE deductible_payments
  ADD COLUMN IF NOT EXISTS payment_id            TEXT,
  ADD COLUMN IF NOT EXISTS captured_amount_paise BIGINT,
  ADD COLUMN IF NOT EXISTS captured_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS capture_event_id      TEXT,
  ADD COLUMN IF NOT EXISTS refund_id             TEXT,
  ADD COLUMN IF NOT EXISTS refund_status         TEXT,
  ADD COLUMN IF NOT EXISTS refund_amount_paise   BIGINT,
  ADD COLUMN IF NOT EXISTS refund_receipt        TEXT,
  ADD COLUMN IF NOT EXISTS refund_simulated      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS refunded_at           TIMESTAMPTZ;

COMMENT ON COLUMN deductible_payments.simulated IS
  'True when the link came from SimulatedPaymentLinkProvider rather than Razorpay. The URL resolves nowhere, no payment can be made against it, and the webhook refuses to record a capture for it.';

COMMENT ON COLUMN deductible_payments.amount_paise IS
  'The policy deductible, in paise, read server-side from policies.deductible. Never supplied by a caller or a model.';

COMMENT ON COLUMN deductible_payments.payment_id IS
  'Set only by the signature-verified Razorpay webhook. A row with a NULL payment_id has received no money and cannot be refunded.';

COMMENT ON COLUMN deductible_payments.refund_amount_paise IS
  'Bounded by captured_amount_paise. Refunding more than arrived is refused in the application and by the constraint below.';

-- Soft enum guards mirroring the provider statuses the code handles.
ALTER TABLE deductible_payments
  DROP CONSTRAINT IF EXISTS deductible_payments_status_check;
ALTER TABLE deductible_payments
  ADD CONSTRAINT deductible_payments_status_check
  CHECK (status IN ('created', 'partially_paid', 'paid', 'expired', 'cancelled'));

ALTER TABLE deductible_payments
  DROP CONSTRAINT IF EXISTS deductible_payments_refund_status_check;
ALTER TABLE deductible_payments
  ADD CONSTRAINT deductible_payments_refund_status_check
  CHECK (refund_status IS NULL OR refund_status IN ('pending', 'processed', 'failed'));

-- A demand for nothing is a bug, not a zero-rupee link to read out.
ALTER TABLE deductible_payments
  DROP CONSTRAINT IF EXISTS deductible_payments_amount_positive;
ALTER TABLE deductible_payments
  ADD CONSTRAINT deductible_payments_amount_positive
  CHECK (amount_paise > 0);

-- The database-level half of the over-refund guard. The application refuses
-- first and says why; this makes the bad row unwritable regardless.
ALTER TABLE deductible_payments
  DROP CONSTRAINT IF EXISTS deductible_payments_refund_within_capture;
ALTER TABLE deductible_payments
  ADD CONSTRAINT deductible_payments_refund_within_capture
  CHECK (
    refund_amount_paise IS NULL
    OR (
      captured_amount_paise IS NOT NULL
      AND refund_amount_paise > 0
      AND refund_amount_paise <= captured_amount_paise
    )
  );

-- A refund cannot exist without the capture it was made against.
ALTER TABLE deductible_payments
  DROP CONSTRAINT IF EXISTS deductible_payments_refund_needs_capture;
ALTER TABLE deductible_payments
  ADD CONSTRAINT deductible_payments_refund_needs_capture
  CHECK (refund_id IS NULL OR payment_id IS NOT NULL);

-- --- 3. Idempotency, enforced by the database -------------------------------
--
-- Every guarantee the application makes is mirrored here, so that bypassing
-- the service — a console session, a future endpoint, a bug — still cannot
-- charge or refund the same money twice.

-- One live demand per claim: two rows can never share a reference.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deductible_payments_reference_id
  ON deductible_payments(reference_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deductible_payments_payment_link_id
  ON deductible_payments(payment_link_id);

-- One capture belongs to exactly one claim. Partial, because uncollected
-- deductibles are all NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deductible_payments_payment_id
  ON deductible_payments(payment_id) WHERE payment_id IS NOT NULL;

-- One refund, once. The same refund id cannot be recorded against two rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deductible_payments_refund_id
  ON deductible_payments(refund_id) WHERE refund_id IS NOT NULL;

-- A claim may carry at most one captured deductible, whatever the link
-- history behind it. Re-issuing after an expired link is allowed; being paid
-- twice for one excess is not.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deductible_payments_one_capture_per_claim
  ON deductible_payments(claim_id) WHERE payment_id IS NOT NULL;

-- The strongest of the set: a claim may carry at most one refunded deductible,
-- whatever the refund id says. This is what makes "refund twice" unwritable
-- rather than merely refused.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deductible_payments_one_refund_per_claim
  ON deductible_payments(claim_id) WHERE refund_id IS NOT NULL;

-- The lookups the service does: everything for a claim, and the reverse
-- lookup the webhook does from a link id.
CREATE INDEX IF NOT EXISTS idx_deductible_payments_claim_id ON deductible_payments(claim_id);
CREATE INDEX IF NOT EXISTS idx_deductible_payments_status   ON deductible_payments(status);

-- --- 4. The webhook delivery ledger -----------------------------------------
--
-- Razorpay signs the raw body and nothing else — no timestamp in the header,
-- no id in the payload. A captured delivery therefore stays valid forever and
-- replays byte-identically, so the signature alone cannot tell a retry from an
-- attack. This table is the replay guard: every delivery is recorded under
-- Razorpay's x-razorpay-event-id (or, absent the header, the digest of the raw
-- body), and a second arrival of the same id is skipped rather than applied.
--
-- Razorpay retries a failed delivery for about 24 hours, and those retries are
-- legitimate — which is why the guard is this ledger and not a short tolerance
-- window that would throw real captures away.

CREATE TABLE IF NOT EXISTS razorpay_webhook_events (
  id              TEXT PRIMARY KEY,       -- x-razorpay-event-id, or a digest of the raw body
  event           TEXT NOT NULL,          -- e.g. 'payment_link.paid'
  payment_id      TEXT,
  payment_link_id TEXT,
  payload         JSONB,                  -- the delivery as received, for reconciliation
  received_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_razorpay_webhook_events_payment_id
  ON razorpay_webhook_events(payment_id);
CREATE INDEX IF NOT EXISTS idx_razorpay_webhook_events_received_at
  ON razorpay_webhook_events(received_at);

-- --- 5. Row-level security --------------------------------------------------
--
-- Following 0016, not 0007. In Supabase a table without RLS is fully readable
-- AND writable through PostgREST by the anon key, and that key is embedded in
-- the shipped frontend bundle. These two tables hold payment links, the
-- amounts behind them, Razorpay payment and refund ids, and complete webhook
-- payloads including the payer's email, contact number and card metadata.
--
-- WHY NO ANON POLICY AT ALL:
-- Nothing in the frontend reads either table. The only client-side Supabase
-- reads are `claims` (Blockchain.tsx, useRealtimeClaims.ts); every access to
-- deductible_payments and razorpay_webhook_events goes through the backend,
-- which holds the service role key and bypasses RLS entirely. Granting anon
-- SELECT would publish live payment links and payer PII to buy nothing.
--
-- With RLS enabled and zero policies the anon and authenticated roles get
-- nothing — no SELECT, no INSERT, no UPDATE, no DELETE — while the service
-- role continues to work unchanged.

DO $$
DECLARE
  t text;
  -- RLS on, deliberately no anon/authenticated policy. See header.
  protected_tables text[] := ARRAY['deductible_payments', 'razorpay_webhook_events'];
BEGIN
  FOREACH t IN ARRAY protected_tables LOOP
    IF EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);

      -- Defensive, exactly as 0016: if a copy of 0007's blanket read loop ever
      -- ran over these tables, drop what it left behind. Re-running must
      -- converge on "no policy".
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'dashboard_read_' || t, t);
    END IF;
  END LOOP;
END $$;

-- Neither table is streamed to the browser, so neither is added to the
-- supabase_realtime publication. Publication membership is not gated by RLS in
-- the way table reads are; adding them would be a second, separate exposure.

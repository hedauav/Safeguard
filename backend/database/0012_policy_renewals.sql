-- ============================================
-- Migration 0012: policy renewal payment links
--
-- A lapsed policy is a dead end for the agent: it must refuse the claim. The
-- one bounded thing it may do instead is offer a payment link for the premium
-- owed. This table is what makes that safe to repeat — without a stored link
-- per policy, a second call to the tool issues a second demand for the same
-- premium, and a payment arriving later has no record to land against.
--
-- Additive and idempotent. Safe to re-run.
-- ============================================

CREATE TABLE IF NOT EXISTS policy_renewals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id        UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,          -- rail that issued the link, e.g. 'razorpay' or 'simulated'
  payment_link_id  TEXT NOT NULL,          -- provider's payment link id
  short_url        TEXT NOT NULL,          -- the URL read out to the caller
  amount_paise     BIGINT NOT NULL,        -- minor units, as sent to the provider
  term_months      INTEGER,                -- policy term the premium covers
  status           TEXT NOT NULL,          -- provider status at the time of the write
  reference_id     TEXT NOT NULL,          -- our deterministic per-renewal reference
  simulated        BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- Stated separately so re-running against a table created by an earlier form
-- of this migration still converges.
ALTER TABLE policy_renewals
  ADD COLUMN IF NOT EXISTS term_months INTEGER,
  ADD COLUMN IF NOT EXISTS simulated   BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN policy_renewals.simulated IS
  'True when the link came from SimulatedPaymentLinkProvider rather than Razorpay. The URL resolves nowhere and no payment can be made against it.';

COMMENT ON COLUMN policy_renewals.amount_paise IS
  'Renewal computed server-side as premium_monthly * term_months, in paise. Never supplied by a caller.';

COMMENT ON COLUMN policy_renewals.reference_id IS
  'sha256-derived from the policy number. Providers reject a repeat, so a retried tool call cannot bill a second term.';

-- Soft enum guard mirroring the provider statuses the code handles.
ALTER TABLE policy_renewals
  DROP CONSTRAINT IF EXISTS policy_renewals_status_check;
ALTER TABLE policy_renewals
  ADD CONSTRAINT policy_renewals_status_check
  CHECK (status IN ('created', 'partially_paid', 'paid', 'expired', 'cancelled'));

-- A renewal for nothing is a bug, not a zero-rupee link to read out.
ALTER TABLE policy_renewals
  DROP CONSTRAINT IF EXISTS policy_renewals_amount_positive;
ALTER TABLE policy_renewals
  ADD CONSTRAINT policy_renewals_amount_positive
  CHECK (amount_paise > 0);

-- The database-level half of the double-billing guard: the same reference can
-- never be recorded twice, so a duplicated link cannot be stored even if the
-- application check is bypassed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_renewals_reference_id
  ON policy_renewals(reference_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_renewals_payment_link_id
  ON policy_renewals(payment_link_id);

-- The lookup the service does before issuing anything: has this policy already
-- got a link that is still payable?
CREATE INDEX IF NOT EXISTS idx_policy_renewals_policy_id ON policy_renewals(policy_id);
CREATE INDEX IF NOT EXISTS idx_policy_renewals_status    ON policy_renewals(status);

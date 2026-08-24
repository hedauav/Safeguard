-- ============================================
-- Migration 0010: claim settlement payouts
--
-- `claims.status` already allows 'paid' and `approved_amount` already exists,
-- but nothing recorded *how* a claim was paid. Without a stored payout id
-- there is no way to tell an unpaid claim from one whose payment succeeded
-- while the status write failed, which is exactly the ambiguity that lets a
-- retry pay twice.
--
-- Additive and idempotent. Safe to re-run.
-- ============================================

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS payout_provider  TEXT,         -- rail that produced the payout, e.g. 'simulated'
  ADD COLUMN IF NOT EXISTS payout_id        TEXT,         -- provider's payout id
  ADD COLUMN IF NOT EXISTS payout_status    TEXT,         -- provider status at the time of the write
  ADD COLUMN IF NOT EXISTS payout_amount    NUMERIC,      -- amount actually disbursed
  ADD COLUMN IF NOT EXISTS payout_utr       TEXT,         -- bank reference for the transfer
  ADD COLUMN IF NOT EXISTS payout_simulated BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS paid_at          TIMESTAMPTZ;  -- when the payout was created

COMMENT ON COLUMN claims.payout_simulated IS
  'True when payout_id came from SimulatedPayoutProvider rather than a real payout rail. No money moved.';

COMMENT ON COLUMN claims.payout_amount IS
  'Settlement computed server-side as max(0, min(claimed_amount, coverage_amount) - deductible). Never supplied by a caller.';

-- Soft enum guard mirroring the provider statuses the code handles.
ALTER TABLE claims
  DROP CONSTRAINT IF EXISTS claims_payout_status_check;
ALTER TABLE claims
  ADD CONSTRAINT claims_payout_status_check
  CHECK (payout_status IS NULL OR payout_status IN ('queued', 'processing', 'processed', 'reversed', 'failed'));

-- The database-level half of the double-payment guard: two claims can never
-- share a payout id, so a duplicated payout cannot be recorded even if the
-- application check is bypassed. Partial, because unpaid claims are all NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_payout_id
  ON claims(payout_id) WHERE payout_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_claims_paid_at ON claims(paid_at);

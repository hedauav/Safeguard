-- ============================================
-- Migration 0006: simulation mode
--
-- Adds an explicit marker distinguishing simulated evidence archival from
-- real archival. Without this column a simulated CID is indistinguishable
-- from one backed by an actual Filecoin upload, which is precisely the
-- ambiguity that makes fabricated attestations dangerous.
-- ============================================

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS simulated BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN claims.simulated IS
  'True when filecoin_cid / attestation_tx_hash were produced by SIMULATE_BLOCKCHAIN demo mode rather than a real upload or transaction.';

ALTER TABLE filecoin_uploads
  ADD COLUMN IF NOT EXISTS simulated BOOLEAN NOT NULL DEFAULT false;

-- pdp_proof_status gains a 'simulated' state.
ALTER TABLE claims
  DROP CONSTRAINT IF EXISTS claims_pdp_proof_status_check;
ALTER TABLE claims
  ADD CONSTRAINT claims_pdp_proof_status_check
  CHECK (pdp_proof_status IS NULL OR pdp_proof_status IN ('pending', 'verified', 'failed', 'simulated'));

CREATE INDEX IF NOT EXISTS idx_claims_simulated ON claims(simulated);

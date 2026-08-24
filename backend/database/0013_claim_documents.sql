-- ============================================
-- Migration 0013: uploaded claim documents
--
-- Until now a "document" on a claim was a string in claims.documents_received
-- and, at best, a URL somebody told the agent about. Nothing in the system had
-- ever seen the bytes, so a file swapped after the fact was undetectable. This
-- table records the keccak256 of the bytes that were actually received, which
-- is the thing a later copy can be checked against.
--
-- The hash is recorded unconditionally; the CID is not. A file whose bytes
-- never reached Filecoin must read as unarchived, never as stored — recording
-- a storage location that does not exist is what made v1's evidence worthless.
--
-- Additive and idempotent. Safe to re-run.
-- ============================================

CREATE TABLE IF NOT EXISTS claim_documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id          UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  document_type     TEXT NOT NULL,          -- one of the claim's documents_required entries
  original_filename TEXT NOT NULL,          -- as supplied by the claimant, for their reference only
  mime_type         TEXT NOT NULL,          -- from the allowlist the upload endpoint enforces
  size_bytes        BIGINT NOT NULL,        -- bytes actually received and hashed
  content_hash      TEXT NOT NULL,          -- keccak256 of those bytes, 0x-prefixed
  cid               TEXT,                   -- NULL whenever archival did not happen
  storage_status    TEXT NOT NULL,          -- 'stored' | 'simulated' | 'unarchived'
  simulated         BOOLEAN NOT NULL DEFAULT false,
  uploaded_at       TIMESTAMPTZ DEFAULT now()
);

-- Stated separately so re-running against a table created by an earlier form
-- of this migration still converges.
ALTER TABLE claim_documents
  ADD COLUMN IF NOT EXISTS cid            TEXT,
  ADD COLUMN IF NOT EXISTS storage_status TEXT,
  ADD COLUMN IF NOT EXISTS simulated      BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN claim_documents.content_hash IS
  'keccak256 of the exact bytes received, computed before any archival is attempted. Recorded even when archival fails, because the hash alone is what makes tampering detectable.';

COMMENT ON COLUMN claim_documents.cid IS
  'Content address of the archived copy. NULL means the bytes were never stored — never populate it to make a row look complete.';

COMMENT ON COLUMN claim_documents.simulated IS
  'True when the CID came from SIMULATE_BLOCKCHAIN demo mode. The address is a genuine content address for the bytes, but nothing was uploaded anywhere.';

-- Soft enum guard mirroring the statuses the upload path can produce.
ALTER TABLE claim_documents
  DROP CONSTRAINT IF EXISTS claim_documents_storage_status_check;
ALTER TABLE claim_documents
  ADD CONSTRAINT claim_documents_storage_status_check
  CHECK (storage_status IN ('stored', 'simulated', 'unarchived'));

-- The two halves must agree. A row claiming storage without a CID is missing
-- its evidence; a row claiming none while holding one is a fabricated CID
-- waiting to be believed.
ALTER TABLE claim_documents
  DROP CONSTRAINT IF EXISTS claim_documents_cid_matches_status;
ALTER TABLE claim_documents
  ADD CONSTRAINT claim_documents_cid_matches_status
  CHECK (
    (storage_status = 'unarchived' AND cid IS NULL)
    OR (storage_status <> 'unarchived' AND cid IS NOT NULL)
  );

-- Shape check on the hash itself, so a truncated or differently-encoded digest
-- cannot be stored and later compared against a correctly-computed one.
ALTER TABLE claim_documents
  DROP CONSTRAINT IF EXISTS claim_documents_content_hash_format;
ALTER TABLE claim_documents
  ADD CONSTRAINT claim_documents_content_hash_format
  CHECK (content_hash ~ '^0x[0-9a-f]{64}$');

-- An empty file has nothing to prove and hashes to a constant.
ALTER TABLE claim_documents
  DROP CONSTRAINT IF EXISTS claim_documents_size_positive;
ALTER TABLE claim_documents
  ADD CONSTRAINT claim_documents_size_positive
  CHECK (size_bytes > 0);

-- The database-level half of the duplicate guard: the same bytes can never be
-- recorded twice against one claim, so a replayed upload cannot inflate the
-- evidence bundle even if the application check is bypassed. Scoped to the
-- claim, because the same stock photo on two unrelated claims is legitimate
-- and is itself worth being able to see.
CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_documents_claim_content
  ON claim_documents(claim_id, content_hash);

-- Verification looks a document up by hash across claims, which is also how
-- the same file turning up on several claims becomes visible.
CREATE INDEX IF NOT EXISTS idx_claim_documents_content_hash ON claim_documents(content_hash);
CREATE INDEX IF NOT EXISTS idx_claim_documents_claim_id     ON claim_documents(claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_documents_storage      ON claim_documents(storage_status);

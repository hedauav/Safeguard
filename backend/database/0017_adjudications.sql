-- ============================================
-- Migration 0017: AI claim adjudication
--
-- Until now the model in this system routed intents to CRUD endpoints. It
-- looked up a claim, it read a status back, it filed a row. Two audits called
-- that the weakest part of the project, and they were right: nothing the model
-- did required a model.
--
-- Adjudication is the work. The model reads a policy, a claim, and the text of
-- the documents the claimant uploaded, and reports where they contradict each
-- other — a 12,000 repair estimate behind an 80,000 claim, a police report
-- dated three weeks from the incident. That is what an adjuster looks for and
-- what a keyword matcher cannot find.
--
-- This table exists so that finding can be audited rather than trusted. Every
-- row holds enough to reconstruct exactly why a recommendation was made: which
-- deterministic checks fired and what each of them said, the exact prompt the
-- model was given, the raw bytes it returned, which model, how long it took,
-- and — separately, never merged — the figure the model proposed alongside the
-- figure computed in code.
--
-- WHAT THIS TABLE IS NOT:
-- It is not a decision. Nothing in it approves a claim, changes a claim status,
-- or releases a payout. adjudication-service.ts writes here and nowhere else;
-- claims.status and claims.approved_amount remain a human's to set. A row here
-- is a recommendation with its working shown, waiting for somebody to read it.
--
-- Additive and idempotent. Safe to re-run.
-- ============================================

-- --- 1. Document text, so there is something to cross-check -----------------
--
-- claim_documents (0013) records metadata and the keccak256 of the bytes. That
-- is the right thing for tamper-evidence and it is useless for adjudication: a
-- hash cannot tell you the estimate says 12,000.
--
-- The text is recorded at UPLOAD time, next to the hash of the bytes it came
-- from, rather than extracted later at adjudication time. Three reasons, in
-- order of how much they cost to get wrong:
--
--   1. Storage is not guaranteed. storage_status can be 'unarchived' — the
--      bytes were hashed and then not kept anywhere. Adjudication-time
--      extraction would therefore be impossible for exactly the documents most
--      likely to matter, and a feature that silently skips those is worse than
--      one that admits it has no text.
--   2. Text recorded beside the hash is checkable. A reviewer can ask whether
--      this text belongs to the file that was attested; text extracted later,
--      from a copy, cannot answer that.
--   3. Running OCR or PDF parsing inside the upload path would add a
--      dependency and a failure mode to the one path that must never lose the
--      hash. 0013's whole header is about what happened the last time an
--      optional step was allowed to compromise a mandatory one.
--
-- So the column is populated from whatever the uploader supplies, and
-- text_source records where it came from. That distinction is load-bearing:
-- 'claimant' text is adversarial input. It is forgeable, and it reaches a
-- model prompt, so it is prompt-injectable. adjudication-service.ts fences it,
-- strips the fence delimiters out of it, and tells the model in the system
-- prompt that anything inside the fence is content and never instruction.

ALTER TABLE claim_documents
  ADD COLUMN IF NOT EXISTS extracted_text TEXT,
  ADD COLUMN IF NOT EXISTS text_source    TEXT;

COMMENT ON COLUMN claim_documents.extracted_text IS
  'Text read out of this document, recorded at upload time beside the hash of the bytes it came from. NULL means nothing has been read out of it — a document with no text here is reported to the adjudicator as not cross-checked, never silently omitted from the prompt.';

COMMENT ON COLUMN claim_documents.text_source IS
  'Where extracted_text came from. ''claimant'' is adversarial input: forgeable, and it reaches a model prompt. ''ocr'' and ''pdf_text'' are machine-read from the stored bytes. ''adjuster'' was typed by staff. Never leave this NULL while extracted_text is set.';

-- The two halves must agree, the same way cid and storage_status must in 0013.
-- Text with no stated source is text whose trustworthiness cannot be judged.
ALTER TABLE claim_documents
  DROP CONSTRAINT IF EXISTS claim_documents_text_source_stated;
ALTER TABLE claim_documents
  ADD CONSTRAINT claim_documents_text_source_stated
  CHECK (
    (extracted_text IS NULL)
    OR (text_source IN ('claimant', 'ocr', 'pdf_text', 'adjuster'))
  );

-- --- 2. The adjudication record ---------------------------------------------

CREATE TABLE IF NOT EXISTS adjudications (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id                UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  -- Denormalised deliberately: an audit row must stay readable after the claim
  -- number it refers to has been renumbered or the claim row has gone.
  claim_number            TEXT NOT NULL,

  -- The recommendation. Never a decision. See the header.
  verdict                 TEXT NOT NULL,          -- 'approve' | 'deny' | 'escalate'
  confidence              NUMERIC NOT NULL DEFAULT 0,

  -- The two amounts, kept apart on purpose.
  --
  -- computed_payable_amount is max(0, min(claimed, coverage) - deductible),
  -- worked out in code by the same function the settlement path uses. It is the
  -- only figure with any authority.
  --
  -- model_proposed_amount is what the model calculated. It is asked for so that
  -- it can be COMPARED, not used: a model whose arithmetic differs from ours has
  -- misread something, and that is worth a human's attention. When they differ
  -- the verdict is forced to 'escalate' and amount_agreement says 'disagreed'.
  computed_payable_amount NUMERIC NOT NULL,
  model_proposed_amount   NUMERIC,
  amount_agreement        TEXT NOT NULL,          -- 'agreed'|'disagreed'|'not_proposed'|'not_asked'

  -- What the model reported.
  policy_clauses          TEXT[] NOT NULL DEFAULT '{}',
  inconsistencies         TEXT[] NOT NULL DEFAULT '{}',

  -- The deterministic layer: every check that ran, in order, each with its id,
  -- whether it passed, and the sentence a reviewer reads. Stored in full rather
  -- than as a list of failures, because "these seven checks passed" is itself
  -- the evidence that the model was only asked what it was entitled to answer.
  checks                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The rule that short-circuited before the model was called, or NULL.
  vetoed_by               TEXT,

  -- The model, exactly as it happened.
  model_invoked           BOOLEAN NOT NULL DEFAULT false,
  model_provider          TEXT,                   -- 'groq' | 'fake'
  model_id                TEXT,                   -- as reported by the provider
  model_latency_ms        INT,
  -- True when the answer came from FakeLlmProvider: no model read anything.
  -- Recorded so an unconfigured deployment cannot read back as a working one.
  simulated               BOOLEAN NOT NULL DEFAULT false,

  -- The exact prompt and the raw response. This is the part that makes the row
  -- an audit record rather than a summary. Reconstructing a recommendation
  -- means re-reading what the model was actually shown, not a paraphrase.
  prompt_system           TEXT,
  prompt_user             TEXT,
  raw_response            TEXT,
  -- Why the response could not be reduced to the closed schema, when it could
  -- not be. A row with a parse_error always has verdict 'escalate': anything
  -- unparseable escalates, and never becomes a silent default.
  parse_error             TEXT,

  created_at              TIMESTAMPTZ DEFAULT now()
);

-- Stated separately so re-running against a table created by an earlier form
-- of this migration still converges.
ALTER TABLE adjudications
  ADD COLUMN IF NOT EXISTS model_provider   TEXT,
  ADD COLUMN IF NOT EXISTS model_id         TEXT,
  ADD COLUMN IF NOT EXISTS model_latency_ms INT,
  ADD COLUMN IF NOT EXISTS parse_error      TEXT,
  ADD COLUMN IF NOT EXISTS vetoed_by        TEXT,
  ADD COLUMN IF NOT EXISTS simulated        BOOLEAN NOT NULL DEFAULT false;

COMMENT ON TABLE adjudications IS
  'AI-assisted claim adjudication recommendations. Never decisions: no row here approves a claim, changes claims.status, or releases a payout. Each row carries enough to reconstruct why the recommendation was made — the checks, the exact prompt, the raw response, the model, the latency.';

COMMENT ON COLUMN adjudications.computed_payable_amount IS
  'max(0, min(claimed_amount, coverage_amount) - deductible), computed in code by the same function the settlement path uses. The only figure here with any authority.';

COMMENT ON COLUMN adjudications.model_proposed_amount IS
  'What the model calculated. Recorded to be compared against computed_payable_amount, never to be paid. A disagreement forces verdict = escalate.';

COMMENT ON COLUMN adjudications.simulated IS
  'True when the answer came from FakeLlmProvider because no GROQ_API_KEY was configured. No model read anything. Never present such a row as a model-reviewed claim.';

-- --- Soft enum guards, mirroring what the service can produce ---------------

ALTER TABLE adjudications
  DROP CONSTRAINT IF EXISTS adjudications_verdict_check;
ALTER TABLE adjudications
  ADD CONSTRAINT adjudications_verdict_check
  CHECK (verdict IN ('approve', 'deny', 'escalate'));

ALTER TABLE adjudications
  DROP CONSTRAINT IF EXISTS adjudications_amount_agreement_check;
ALTER TABLE adjudications
  ADD CONSTRAINT adjudications_amount_agreement_check
  CHECK (amount_agreement IN ('agreed', 'disagreed', 'not_proposed', 'not_asked'));

ALTER TABLE adjudications
  DROP CONSTRAINT IF EXISTS adjudications_confidence_range;
ALTER TABLE adjudications
  ADD CONSTRAINT adjudications_confidence_range
  CHECK (confidence >= 0 AND confidence <= 1);

-- The computed figure is a payout ceiling, and a negative one is not a smaller
-- payout, it is a demand. The service floors it at zero; so does the database.
ALTER TABLE adjudications
  DROP CONSTRAINT IF EXISTS adjudications_computed_amount_non_negative;
ALTER TABLE adjudications
  ADD CONSTRAINT adjudications_computed_amount_non_negative
  CHECK (computed_payable_amount >= 0);

-- A row that says no model ran must not also carry a model's output. Without
-- this, a bug that skipped the call but kept a stale response would produce a
-- row indistinguishable from a genuine review.
ALTER TABLE adjudications
  DROP CONSTRAINT IF EXISTS adjudications_model_fields_match_invocation;
ALTER TABLE adjudications
  ADD CONSTRAINT adjudications_model_fields_match_invocation
  CHECK (
    model_invoked
    OR (model_id IS NULL AND raw_response IS NULL AND model_latency_ms IS NULL AND simulated = false)
  );

-- A deterministic veto short-circuits before the model is called. A row
-- claiming both a veto and a model invocation means that short-circuit did not
-- happen, which is the property the whole design rests on.
ALTER TABLE adjudications
  DROP CONSTRAINT IF EXISTS adjudications_veto_precludes_model;
ALTER TABLE adjudications
  ADD CONSTRAINT adjudications_veto_precludes_model
  CHECK (vetoed_by IS NULL OR model_invoked = false);

-- Anything unparseable escalates. Stated in the schema as well as the service,
-- so a future caller cannot record a parse failure as an approval.
ALTER TABLE adjudications
  DROP CONSTRAINT IF EXISTS adjudications_parse_failure_escalates;
ALTER TABLE adjudications
  ADD CONSTRAINT adjudications_parse_failure_escalates
  CHECK (parse_error IS NULL OR verdict = 'escalate');

-- --- Indexes ----------------------------------------------------------------

-- The adjuster queue: the recommendations on one claim, newest first.
CREATE INDEX IF NOT EXISTS idx_adjudications_claim_created
  ON adjudications(claim_id, created_at DESC);

-- "Show me everything waiting on a human", and "how often does the model
-- disagree with the arithmetic" — the two questions worth asking of this table.
CREATE INDEX IF NOT EXISTS idx_adjudications_verdict_created
  ON adjudications(verdict, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_adjudications_amount_agreement
  ON adjudications(amount_agreement)
  WHERE amount_agreement = 'disagreed';

-- --- Row-level security -----------------------------------------------------
--
-- Follows 0016, not 0007: RLS on, no policy at all. In Supabase a table without
-- RLS is fully readable AND writable through PostgREST by the anon key, and
-- that key is embedded in the shipped frontend bundle.
--
-- This table is the worst one in the schema to leave open. prompt_user contains
-- the incident description and the full text of the claimant's documents, and
-- INSERT rights on it would let anyone fabricate an audit trail — a row saying
-- a model recommended approval, with a prompt and a response nobody ever sent.
--
-- Nothing in the frontend reads it from the browser; the backend holds the
-- service role key and bypasses RLS. With RLS enabled and zero policies the
-- anon and authenticated roles get nothing, while the service role continues
-- unchanged. If a dashboard ever renders these, add a scoped SELECT policy
-- then, and weigh publishing prompt_user before you do.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'adjudications') THEN
    EXECUTE 'ALTER TABLE adjudications ENABLE ROW LEVEL SECURITY';
    -- Defensive: if a copy of 0007's blanket-read loop ever ran over this
    -- table, drop what it left behind. Re-running must converge on "no policy".
    EXECUTE 'DROP POLICY IF EXISTS dashboard_read_adjudications ON adjudications';
  END IF;
END $$;

-- Not added to the supabase_realtime publication. Nothing streams these to a
-- browser, and publication membership is a second, separate exposure.

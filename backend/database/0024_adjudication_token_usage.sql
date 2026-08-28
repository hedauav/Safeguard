-- ============================================
-- Migration 0024: what each adjudication cost
--
-- `adjudications` records the prompt, the raw response, the model id and the
-- latency, and then discards the one field that says what the call cost.
-- Groq returns `usage` — prompt_tokens, completion_tokens, total_tokens — in
-- the same response body as the answer, and GroqProvider.complete() read the
-- content out of that body and threw the rest away.
--
-- The consequence is not abstract. Every cost figure quoted about this system
-- has had to be either assumed or sourced from a single cached measurement
-- taken by hand, because the 37 adjudication rows on record carry no token
-- count at all. A per-claim cost cannot be measured from a table that never
-- wrote one down, and each further batch of adjudications multiplies rows
-- without adding a single unit of evidence.
--
-- Four columns, all nullable, all null on every existing row:
--
--   prompt_tokens      as reported by the provider
--   completion_tokens  as reported by the provider
--   total_tokens       as reported by the provider, NOT derived by adding the
--                      other two — providers count cached and reasoning tokens
--                      that do not appear in either, and a sum computed here
--                      would silently disagree with the invoice
--   model_cost_usd     tokens priced at a rate someone configured; NULL unless
--                      GROQ_PRICE_INPUT_PER_MTOK / GROQ_PRICE_OUTPUT_PER_MTOK
--                      are set, because this repository does not hold a price
--                      list and inventing one produces a number that looks
--                      sourced and is not
--
-- NULL means "not reported", and it is the honest value for every row written
-- before this migration. Nothing backfills them: the token counts for calls
-- already made are gone, and writing a plausible estimate into a column a
-- reader would take as measured is the failure this migration exists to end.
--
-- Additive and idempotent. Safe to re-run.
-- ============================================

-- --- 1. The columns ---------------------------------------------------------

ALTER TABLE adjudications
  ADD COLUMN IF NOT EXISTS prompt_tokens     INT,
  ADD COLUMN IF NOT EXISTS completion_tokens INT,
  ADD COLUMN IF NOT EXISTS total_tokens      INT,
  ADD COLUMN IF NOT EXISTS model_cost_usd    NUMERIC(14, 8);

COMMENT ON COLUMN adjudications.prompt_tokens IS
  'Input tokens as reported by the provider''s usage object. NULL when the provider reported none, or when no model ran.';

COMMENT ON COLUMN adjudications.completion_tokens IS
  'Output tokens as reported by the provider''s usage object. NULL when the provider reported none, or when no model ran.';

COMMENT ON COLUMN adjudications.total_tokens IS
  'Total tokens as reported by the provider. Recorded verbatim, never computed as prompt + completion — a provider that bills cached or reasoning tokens counts them here and in neither of the other two.';

COMMENT ON COLUMN adjudications.model_cost_usd IS
  'Token counts priced at the configured per-million rates. NULL unless GROQ_PRICE_INPUT_PER_MTOK and GROQ_PRICE_OUTPUT_PER_MTOK are set: no price list ships with this repository, so an unconfigured deployment records tokens and declines to guess the money.';

-- --- 2. A count is a count --------------------------------------------------
--
-- Negative tokens are not a smaller bill, they are a corrupt read. Refused
-- here as well as in the reader that writes them.

ALTER TABLE adjudications
  DROP CONSTRAINT IF EXISTS adjudications_token_counts_non_negative;
ALTER TABLE adjudications
  ADD CONSTRAINT adjudications_token_counts_non_negative
  CHECK (
    (prompt_tokens     IS NULL OR prompt_tokens     >= 0) AND
    (completion_tokens IS NULL OR completion_tokens >= 0) AND
    (total_tokens      IS NULL OR total_tokens      >= 0) AND
    (model_cost_usd    IS NULL OR model_cost_usd    >= 0)
  );

-- --- 3. A row that says no model ran carries no bill ------------------------
--
-- 0017 established that a row with model_invoked = false must not also carry a
-- model_id, a raw_response or a latency, so that a bug which skipped the call
-- but kept a stale field could not produce a row indistinguishable from a
-- genuine review. Token counts and a cost belong in exactly the same list, and
-- for the sharper reason: a cost attached to a call that never happened is a
-- fabricated expense, which is the one thing a cost column must never be able
-- to hold.
--
-- Replaces the 0017 constraint of the same name rather than adding a second,
-- so there is one statement of this rule and not two that can drift.

ALTER TABLE adjudications
  DROP CONSTRAINT IF EXISTS adjudications_model_fields_match_invocation;
ALTER TABLE adjudications
  ADD CONSTRAINT adjudications_model_fields_match_invocation
  CHECK (
    model_invoked
    OR (
      model_id          IS NULL AND
      raw_response      IS NULL AND
      model_latency_ms  IS NULL AND
      prompt_tokens     IS NULL AND
      completion_tokens IS NULL AND
      total_tokens      IS NULL AND
      model_cost_usd    IS NULL AND
      simulated = false
    )
  );

-- --- 4. Finding the rows that carry evidence -------------------------------
--
-- Partial, because the question asked of this table is always "which
-- adjudications have a measured cost", never "which have none". The index
-- stays the size of the answer rather than the size of the table.

CREATE INDEX IF NOT EXISTS idx_adjudications_total_tokens
  ON adjudications(total_tokens)
  WHERE total_tokens IS NOT NULL;

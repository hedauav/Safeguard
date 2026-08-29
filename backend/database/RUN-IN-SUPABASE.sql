-- ============================================
-- SafeGuard — paste this whole file into the Supabase SQL editor and run it.
--
-- Two migrations. Both are additive and idempotent: running this file a second
-- time changes nothing.
--
--   0025_batch_journey_policies.sql
--       Twenty customers and twenty policies — fifteen active, to drive a
--       claim from filing through to its refund, and five lapsed, to be
--       renewed first. They are not in the database until this runs.
--
--       Nothing needs redeploying to use them. Policies are data, and the
--       deployed API reads this same Supabase project, so all twenty are
--       reachable from the live dashboard the moment this finishes.
--
--   0024_adjudication_token_usage.sql
--       Four nullable columns on 'adjudications' recording what each model
--       call cost in tokens. Harmless to the currently deployed backend,
--       which does not write them and will carry on exactly as it does today.
--
--       It is here because the code in this repository DOES write them. Apply
--       this before deploying that code: without the columns every
--       adjudication INSERT fails, the audit row is not recorded, and the
--       service downgrades its verdict to 'escalate' — which would stop every
--       journey at the adjudication step.
--
-- Order does not matter; they touch different tables.
-- ============================================

-- ============================================
-- SOURCE: 0024_adjudication_token_usage.sql
-- ============================================

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

-- ============================================
-- SOURCE: 0025_batch_journey_policies.sql
-- ============================================

-- ============================================
-- Migration 0025: twenty policies for the end-to-end journey batch
--
-- The seeded book of business is full of history, which is what makes lookups
-- worth demonstrating, and 0009 added three clean policies so a walkthrough
-- could begin at "file a claim". Neither is enough to run the journey twenty
-- times: the three demo policies collect a claim each on the first pass and
-- stop being clean, and every other policy already carries claims that trip
-- the near-duplicate check.
--
-- These twenty customers each hold exactly one policy and no claims. Fifteen
-- are active and are meant to be driven the whole way — file, adjudicate,
-- collect the deductible, approve, settle, refund. Five are lapsed and are
-- meant to be renewed first, so the renewal path is exercised by the same
-- batch rather than being demonstrated separately.
--
-- Re-running this file restores the twenty rows and does not delete claims
-- filed against them.
--
-- Generated by database/build-batch-policies.mjs — do not edit by hand.
--
-- ## Why these numbers and not others
--
-- Three ceilings in the code decide whether a claim on one of these policies
-- can actually reach a refund, and every row below sits inside all three.
--
--   50,000   settlement-service.ts  DEFAULT_SETTLEMENT_AUTO_APPROVE_LIMIT
--            min(claimed, coverage) - deductible must not exceed it, or
--            settle-claim refuses with 'above_auto_approve_limit' and the
--            journey stops one step short of the money. The suggested claim
--            amounts in the comments below leave between 9,800 and
--            46,000 payable on the fifteen active policies.
--
--  100,000   deductible-service.ts  DEFAULT_DEDUCTIBLE_MAX_LINK_AMOUNT
--            the largest deductible the agent may put behind a payment link.
--            These carry a 1,000-2,000 motor excess and a 5,000-10,000 excess
--            on home and health, which is what an Indian policy of each kind
--            actually carries.
--
--  200,000   renewal-service.ts     DEFAULT_RENEWAL_MAX_LINK_AMOUNT
--            premium_monthly x 12 must not exceed it, or offer-renewal
--            refuses with 'above_link_limit'. The dearest here is 3,200
--            a month, so 38,400 a year.
--
-- ## Why the five are 'expired' and not 'cancelled'
--
-- renewal-service.ts Gate 2 offers a link only for a policy whose status reads
-- exactly 'expired'. 'cancelled' is refused permanently and deliberately — a
-- cancelled policy was terminated by a decision, and no amount of money paid
-- to a voice agent may put it back in force. Their terms also ended in the
-- past, so a claim filed against one BEFORE it is renewed is refused at intake
-- by claims-service.ts, which gates on policy.status before it inserts anything
-- (reason: policy_not_active). No claims row is created, no adjudication runs,
-- and no model is called. That refusal is a passing test, not a failure: it is
-- the refusal the renewal offer then answers.
--
-- Corrected 2026-08-29. This comment previously named
-- 'policy_in_force_on_incident_date' in adjudication-rules.ts as the gate. That
-- rule never runs on these policies, because intake refuses first — established
-- by running both cases; see eval/journey/PRE-REGISTRATION.md, Amendments.
--
-- ## No new policy_type is introduced
--
-- adjudication-rules.ts holds a coverage schedule for auto, home, health and
-- life only. A policy of any other type reaches 'claim_type_covered' with no
-- schedule to check against and vetoes to 'escalate' before the model runs,
-- which would stop all twenty journeys at adjudication. Life is scheduled but
-- unused here: its covered claim types are death and terminal_illness, and
-- driving one of those through a deductible payment and a refund is not a
-- journey worth demonstrating.
-- ============================================

-- --- Customers --------------------------------------------------------------

INSERT INTO customers (id, full_name, email, phone, date_of_birth, address) VALUES
  ('78b4a9f7-6e33-4e2a-af2e-825b87b17fef', 'Devansh Kulkarni', 'devansh.kulkarni@email.com', '+14155550133', '1990-03-18', '412 Beechwood Lane, Burlingame, CA 94010'),
  ('df87c977-a7f7-48e2-a682-38d021e38a7f', 'Ira Chatterjee', 'ira.chatterjee@email.com', '+14155550134', '1987-11-05', '96 Alder Court, San Bruno, CA 94066'),
  ('bc4214e9-1fee-40df-9d34-38a6903996d3', 'Yash Bhardwaj', 'yash.bhardwaj@email.com', '+14155550135', '1994-07-22', '2207 Juniper Drive, Foster City, CA 94404'),
  ('9d84dc0e-59d4-4dee-8b02-15eaf09deeb7', 'Aisha Siddiqui', 'aisha.siddiqui@email.com', '+14155550136', '1982-01-30', '58 Marigold Way, Belmont, CA 94002'),
  ('5fe8b04e-9f47-4030-a406-3d3cd5e36241', 'Rohan Deshpande', 'rohan.deshpande@email.com', '+14155550137', '1991-09-14', '1730 Cypress Avenue, San Carlos, CA 94070'),
  ('9081f269-4705-4419-96ec-a041516cc90f', 'Nandini Krishnan', 'nandini.krishnan@email.com', '+14155550138', '1985-05-09', '344 Sequoia Ridge, Redwood City, CA 94061'),
  ('cc67e948-8828-497f-9e15-dc4923dcb888', 'Zaid Ansari', 'zaid.ansari@email.com', '+14155550139', '1993-12-27', '89 Larkspur Street, Millbrae, CA 94030'),
  ('92bed1d1-4c5f-4eb0-99bc-c9a50a76a27b', 'Trisha Ramaswamy', 'trisha.ramaswamy@email.com', '+14155550140', '1988-08-16', '1512 Hawthorne Place, San Mateo, CA 94402'),
  ('54d23522-c53a-4263-a283-4d9b4b7128ce', 'Kabir Chauhan', 'kabir.chauhan@email.com', '+14155550141', '1979-04-03', '705 Fernwood Circle, Daly City, CA 94015'),
  ('44f1f07a-be42-4ba6-bae3-ad48675b0fc7', 'Simran Gill', 'simran.gill@email.com', '+14155550142', '1996-02-11', '223 Poplar Terrace, South San Francisco, CA 94080'),
  ('9563c302-86b0-4684-a65c-d59941d3567a', 'Arnav Bose', 'arnav.bose@email.com', '+14155550143', '1984-10-25', '1860 Willowbrook Road, Pacifica, CA 94044'),
  ('264d6c83-bdd2-4565-a4ae-c3317a1181e0', 'Meghna Pillai', 'meghna.pillai@email.com', '+14155550144', '1992-06-07', '67 Chestnut Grove, Half Moon Bay, CA 94019'),
  ('f34e4da9-6ecf-4d96-8f0f-1d27877b6260', 'Siddharth Rane', 'siddharth.rane@email.com', '+14155550145', '1981-12-19', '940 Bayberry Court, Foster City, CA 94404'),
  ('437adcbd-1a1c-4a54-a608-c0f96fe499c0', 'Ayesha Merchant', 'ayesha.merchant@email.com', '+14155550146', '1995-03-02', '128 Sycamore Bend, Burlingame, CA 94010'),
  ('60239a5e-e110-4806-a381-4aa3dd8b52cd', 'Nikita Barve', 'nikita.barve@email.com', '+14155550147', '1989-07-30', '1604 Redwood Shores Parkway, Redwood City, CA 94065'),
  ('e658abea-18fb-4b94-9856-9d1158aac23f', 'Vedant Salvi', 'vedant.salvi@email.com', '+14155550148', '1986-09-12', '382 Fairview Avenue, San Bruno, CA 94066'),
  ('f3104211-15b9-4a66-b756-0b6edd1cb2ee', 'Ruhi Kaul', 'ruhi.kaul@email.com', '+14155550149', '1993-05-24', '75 Magnolia Street, Millbrae, CA 94030'),
  ('6fbed3cf-3a7e-45b8-8cf8-dde901672c06', 'Aniket Phadke', 'aniket.phadke@email.com', '+14155550150', '1983-02-06', '2011 Oakhurst Drive, San Mateo, CA 94403'),
  ('c39ef1fd-64d4-4eef-8fef-faba55c73f23', 'Sanya Kohli', 'sanya.kohli@email.com', '+14155550151', '1997-11-17', '516 Brookvale Lane, Belmont, CA 94002'),
  ('27dff297-5685-4c29-a694-50ea20db0d80', 'Harsh Vora', 'harsh.vora@email.com', '+14155550152', '1980-06-28', '1345 Crestline Road, Pacifica, CA 94044')
ON CONFLICT (id) DO NOTHING;

-- --- The fifteen active policies: file a claim straight away ---------------

INSERT INTO policies (id, policy_number, customer_id, policy_type, provider, coverage_amount, deductible, premium_monthly, start_date, end_date, status, coverage_details) VALUES
  -- POL-2026-300001  Devansh Kulkarni — collision claim of 32,000 leaves 31,000 payable
  ('edd0dea4-a42d-44fc-bca6-87a1e9651f23', 'POL-2026-300001', '78b4a9f7-6e33-4e2a-af2e-825b87b17fef', 'auto', 'SafeGuard Insurance', 850000, 1000, 1450, '2026-01-08', '2029-01-08', 'active', '{"vehicle":"2025 Hyundai Creta SX","registration":"MH12 QR 4417","idv":850000,"cover":"comprehensive","own_damage":true,"third_party_liability":1500000,"zero_depreciation":true,"roadside_assistance":true}'::jsonb),
  -- POL-2026-300002  Ira Chatterjee — windshield claim of 14,500 leaves 13,500 payable
  ('0a1b5bb2-80cd-4945-a789-b91ec819d85f', 'POL-2026-300002', 'df87c977-a7f7-48e2-a682-38d021e38a7f', 'auto', 'SafeGuard Insurance', 620000, 1000, 1180, '2026-01-22', '2029-01-22', 'active', '{"vehicle":"2024 Honda City VX","registration":"KA05 MJ 8902","idv":620000,"cover":"comprehensive","own_damage":true,"third_party_liability":1500000,"zero_depreciation":true,"roadside_assistance":true}'::jsonb),
  -- POL-2026-300003  Yash Bhardwaj — theft claim of 48,000 leaves 46,000 payable
  ('fb82ecc2-941b-4226-80a3-c96307247baa', 'POL-2026-300003', 'bc4214e9-1fee-40df-9d34-38a6903996d3', 'auto', 'SafeGuard Insurance', 1240000, 2000, 2150, '2026-02-04', '2029-02-04', 'active', '{"vehicle":"2026 Toyota Innova Crysta","registration":"DL8C AB 1236","idv":1240000,"cover":"comprehensive","own_damage":true,"third_party_liability":1500000,"zero_depreciation":true,"roadside_assistance":true}'::jsonb),
  -- POL-2026-300004  Aisha Siddiqui — vandalism claim of 17,200 leaves 16,200 payable
  ('060b39e0-43df-4737-965e-d70543082b15', 'POL-2026-300004', '9d84dc0e-59d4-4dee-8b02-15eaf09deeb7', 'auto', 'SafeGuard Insurance', 495000, 1000, 980, '2026-02-17', '2029-02-17', 'active', '{"vehicle":"2023 Maruti Baleno Zeta","registration":"GJ01 KL 7715","idv":495000,"cover":"comprehensive","own_damage":true,"third_party_liability":1500000,"zero_depreciation":true,"roadside_assistance":true}'::jsonb),
  -- POL-2026-300005  Rohan Deshpande — comprehensive claim of 38,500 leaves 36,500 payable
  ('f654daff-bee6-42a2-8ae2-4b7717dd314a', 'POL-2026-300005', '5fe8b04e-9f47-4030-a406-3d3cd5e36241', 'auto', 'SafeGuard Insurance', 910000, 2000, 1620, '2026-03-03', '2029-03-03', 'active', '{"vehicle":"2025 Kia Seltos HTX","registration":"TN10 BD 6344","idv":910000,"cover":"comprehensive","own_damage":true,"third_party_liability":1500000,"zero_depreciation":true,"roadside_assistance":true}'::jsonb),
  -- POL-2026-300006  Nandini Krishnan — collision claim of 21,800 leaves 20,800 payable
  ('fd75c6c3-5331-4161-87e3-d70431ea2792', 'POL-2026-300006', '9081f269-4705-4419-96ec-a041516cc90f', 'auto', 'SafeGuard Insurance', 735000, 1000, 1310, '2026-03-19', '2029-03-19', 'active', '{"vehicle":"2024 Tata Nexon XZ","registration":"MH14 GF 1809","idv":735000,"cover":"comprehensive","own_damage":true,"third_party_liability":1500000,"zero_depreciation":true,"roadside_assistance":true}'::jsonb),
  -- POL-2026-300007  Zaid Ansari — water_damage claim of 39,500 leaves 34,500 payable
  ('e737dd78-22d7-4eda-9fdc-8b049b5f452f', 'POL-2026-300007', 'cc67e948-8828-497f-9e15-dc4923dcb888', 'home', 'SafeGuard Insurance', 2800000, 5000, 890, '2026-01-14', '2029-01-14', 'active', '{"property_type":"apartment","square_feet":1680,"year_built":2006,"structure_cover":2800000,"contents_cover":700000,"public_liability":500000,"water_damage":true,"burglary":true,"earthquake":true,"flood":false}'::jsonb),
  -- POL-2026-300008  Trisha Ramaswamy — fire_damage claim of 51,000 leaves 46,000 payable
  ('b7f37327-889e-4222-91fa-64a551501d16', 'POL-2026-300008', '92bed1d1-4c5f-4eb0-99bc-c9a50a76a27b', 'home', 'SafeGuard Insurance', 1950000, 5000, 720, '2026-02-11', '2029-02-11', 'active', '{"property_type":"apartment","square_feet":1410,"year_built":1998,"structure_cover":1950000,"contents_cover":480000,"public_liability":500000,"water_damage":true,"burglary":true,"earthquake":true,"flood":false}'::jsonb),
  -- POL-2026-300009  Kabir Chauhan — storm_damage claim of 37,600 leaves 27,600 payable
  ('ef74b3a9-2967-4c54-afb3-ef55e54f3c8c', 'POL-2026-300009', '54d23522-c53a-4263-a283-4d9b4b7128ce', 'home', 'SafeGuard Insurance', 3600000, 10000, 1240, '2026-03-26', '2029-03-26', 'active', '{"property_type":"apartment","square_feet":1875,"year_built":2012,"structure_cover":3600000,"contents_cover":900000,"public_liability":500000,"water_damage":true,"burglary":true,"earthquake":true,"flood":false}'::jsonb),
  -- POL-2026-300010  Simran Gill — theft claim of 23,400 leaves 18,400 payable
  ('999cac92-e96a-423c-ac41-c56093c8cecc', 'POL-2026-300010', '44f1f07a-be42-4ba6-bae3-ad48675b0fc7', 'home', 'SafeGuard Insurance', 1520000, 5000, 640, '2026-04-07', '2029-04-07', 'active', '{"property_type":"apartment","square_feet":1290,"year_built":1994,"structure_cover":1520000,"contents_cover":380000,"public_liability":500000,"water_damage":true,"burglary":true,"earthquake":true,"flood":false}'::jsonb),
  -- POL-2026-300011  Arnav Bose — vandalism claim of 27,900 leaves 22,900 payable
  ('e44c6a45-4519-405f-b6ce-fd3e34bc1303', 'POL-2026-300011', '9563c302-86b0-4684-a65c-d59941d3567a', 'home', 'SafeGuard Insurance', 2450000, 5000, 820, '2026-04-21', '2029-04-21', 'active', '{"property_type":"apartment","square_feet":1605,"year_built":2003,"structure_cover":2450000,"contents_cover":610000,"public_liability":500000,"water_damage":true,"burglary":true,"earthquake":true,"flood":false}'::jsonb),
  -- POL-2026-300012  Meghna Pillai — medical claim of 46,000 leaves 41,000 payable
  ('55762ae0-91a7-4d26-9e94-a0c3320f5442', 'POL-2026-300012', '264d6c83-bdd2-4565-a4ae-c3317a1181e0', 'health', 'SafeGuard Health', 1000000, 5000, 2450, '2026-01-29', '2029-01-29', 'active', '{"plan":"Family Floater","network":"BayCare Plus","room_rent_limit":7500,"copay_percent":10,"pre_existing_waiting_months":36,"day_care_procedures":true,"prescription_coverage":true,"emergency_room":true}'::jsonb),
  -- POL-2026-300013  Siddharth Rane — hospitalisation claim of 41,500 leaves 36,500 payable
  ('9a54edd8-7b52-4039-a04e-4674e98d6521', 'POL-2026-300013', 'f34e4da9-6ecf-4d96-8f0f-1d27877b6260', 'health', 'SafeGuard Health', 700000, 5000, 1880, '2026-02-25', '2029-02-25', 'active', '{"plan":"Individual","network":"Peninsula Health","room_rent_limit":5000,"copay_percent":10,"pre_existing_waiting_months":36,"day_care_procedures":true,"prescription_coverage":true,"emergency_room":true}'::jsonb),
  -- POL-2026-300014  Ayesha Merchant — prescription claim of 19,800 leaves 9,800 payable
  ('4d9f357f-beb6-46cb-9cf0-dde96439e03b', 'POL-2026-300014', '437adcbd-1a1c-4a54-a608-c0f96fe499c0', 'health', 'SafeGuard Health', 1500000, 10000, 3200, '2026-03-11', '2029-03-11', 'active', '{"plan":"Family Floater","network":"BayCare Premier","room_rent_limit":10000,"copay_percent":0,"pre_existing_waiting_months":36,"day_care_procedures":true,"prescription_coverage":true,"emergency_room":true}'::jsonb),
  -- POL-2026-300015  Nikita Barve — medical claim of 33,300 leaves 28,300 payable
  ('be19e74a-a69f-48fc-9927-fc982e70e656', 'POL-2026-300015', '60239a5e-e110-4806-a381-4aa3dd8b52cd', 'health', 'SafeGuard Health', 850000, 5000, 2100, '2026-04-15', '2029-04-15', 'active', '{"plan":"Individual","network":"Coastside Network","room_rent_limit":6000,"copay_percent":20,"pre_existing_waiting_months":36,"day_care_procedures":true,"prescription_coverage":true,"emergency_room":true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- --- The five lapsed policies: renew, then file ----------------------------
--
-- A claim filed against one of these before renewal is denied on the date,
-- by arithmetic, with no model involved. Renew it and the reactivated term
-- starts today, so file with an incident date on or after the renewal.

INSERT INTO policies (id, policy_number, customer_id, policy_type, provider, coverage_amount, deductible, premium_monthly, start_date, end_date, status, coverage_details) VALUES
  -- POL-2026-300016  Vedant Salvi — collision claim of 22,500 leaves 21,500 payable; renew at 15,000 first
  ('03b88661-26cb-4b37-8e91-554552e6d7ef', 'POL-2026-300016', 'e658abea-18fb-4b94-9856-9d1158aac23f', 'auto', 'SafeGuard Insurance', 680000, 1000, 1250, '2023-02-20', '2026-02-20', 'expired', '{"vehicle":"2023 Volkswagen Virtus GT","registration":"MH02 TR 2045","idv":680000,"cover":"comprehensive","own_damage":true,"third_party_liability":1500000,"zero_depreciation":true,"roadside_assistance":true}'::jsonb),
  -- POL-2026-300017  Ruhi Kaul — windshield claim of 13,400 leaves 12,400 payable; renew at 12,480 first
  ('391755b3-f275-4cf0-9b2c-9b0fbf6a6200', 'POL-2026-300017', 'f3104211-15b9-4a66-b756-0b6edd1cb2ee', 'auto', 'SafeGuard Insurance', 540000, 1000, 1040, '2022-11-05', '2025-11-05', 'expired', '{"vehicle":"2022 Renault Kiger RXZ","registration":"RJ14 NB 5772","idv":540000,"cover":"comprehensive","own_damage":true,"third_party_liability":1500000,"zero_depreciation":true,"roadside_assistance":true}'::jsonb),
  -- POL-2026-300018  Aniket Phadke — water_damage claim of 34,700 leaves 29,700 payable; renew at 9,360 first
  ('23d5e073-b49e-49af-ada1-b4964cf857d3', 'POL-2026-300018', '6fbed3cf-3a7e-45b8-8cf8-dde901672c06', 'home', 'SafeGuard Insurance', 2150000, 5000, 780, '2023-04-12', '2026-04-12', 'expired', '{"property_type":"apartment","square_feet":1495,"year_built":2001,"structure_cover":2150000,"contents_cover":530000,"public_liability":500000,"water_damage":true,"burglary":true,"earthquake":true,"flood":false}'::jsonb),
  -- POL-2026-300019  Sanya Kohli — theft claim of 34,100 leaves 24,100 payable; renew at 13,800 first
  ('3eaf72a1-ad47-4b8f-9936-7d083ece3130', 'POL-2026-300019', 'c39ef1fd-64d4-4eef-8fef-faba55c73f23', 'home', 'SafeGuard Insurance', 3100000, 10000, 1150, '2022-08-30', '2025-08-30', 'expired', '{"property_type":"apartment","square_feet":1740,"year_built":2009,"structure_cover":3100000,"contents_cover":770000,"public_liability":500000,"water_damage":true,"burglary":true,"earthquake":true,"flood":false}'::jsonb),
  -- POL-2026-300020  Harsh Vora — medical claim of 38,200 leaves 33,200 payable; renew at 27,360 first
  ('5cf9cd73-e302-4aed-87ae-4f5e4442a9df', 'POL-2026-300020', '27dff297-5685-4c29-a694-50ea20db0d80', 'health', 'SafeGuard Health', 900000, 5000, 2280, '2023-06-18', '2026-06-18', 'expired', '{"plan":"Family Floater","network":"BayCare Plus","room_rent_limit":6500,"copay_percent":10,"pre_existing_waiting_months":36,"day_care_procedures":true,"prescription_coverage":true,"emergency_room":true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- --- Resetting between runs -------------------------------------------------
--
-- Clears claims filed against the twenty, returning them to a clean slate for
-- another pass. Deliberately commented out: running it by accident during a
-- recorded walkthrough would delete the evidence of the walkthrough.
--
--   DELETE FROM claims WHERE policy_id IN (
--     SELECT id FROM policies
--     WHERE policy_number BETWEEN 'POL-2026-300001' AND 'POL-2026-300020'
--   );
--
-- Putting the five lapsed ones back after a renewal has reactivated them:
--
--   UPDATE policies SET status = 'expired', start_date = t.start_date, end_date = t.end_date
--   FROM (VALUES
--     ('POL-2026-300016', DATE '2023-02-20', DATE '2026-02-20'),
--     ('POL-2026-300017', DATE '2022-11-05', DATE '2025-11-05'),
--     ('POL-2026-300018', DATE '2023-04-12', DATE '2026-04-12'),
--     ('POL-2026-300019', DATE '2022-08-30', DATE '2025-08-30'),
--     ('POL-2026-300020', DATE '2023-06-18', DATE '2026-06-18')
--   ) AS t(policy_number, start_date, end_date)
--   WHERE policies.policy_number = t.policy_number;

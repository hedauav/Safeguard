-- ============================================
-- SafeGuard — complete database setup
--
-- Generated from, in order:
--   migration.sql
--   0002_filecoin_columns.sql
--   0003_filecoin_tables.sql
--   0004_call_log_analysis.sql
--   seed.sql
--   0005_test_dataset.sql
--   0006_simulation_mode.sql
--   0007_dashboard_read_policies.sql
--   0008_agent_settings.sql
--   0009_demo_policies.sql
--   0010_settlement.sql
--   0011_extended_dataset.sql
--   0012_policy_renewals.sql
--   0013_claim_documents.sql
--   0015_escalations_without_call.sql
--   0016_rls_for_new_tables.sql
--   0017_adjudications.sql
--   0018_deductible_payments.sql
--   0019_adjudication_reviews.sql
--   0020_renewal_capture.sql
--   0021_journey_events.sql
--   0022_filecoin_upload_errors.sql
--   0023_filecoin_error_column_grant_fix.sql
--
-- Paste the whole file into the Supabase SQL editor and run it.
-- Safe to re-run: every statement is IF NOT EXISTS / idempotent.
--
-- Regenerate with: bash database/build-run-all.sh
-- ============================================


-- ============================================
-- SOURCE: migration.sql
-- ============================================

-- ============================================
-- Insurance AI Call Agent — Database Migration
-- ============================================

-- 1. Customers
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT NOT NULL,
  date_of_birth DATE,
  address TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Policies
CREATE TABLE IF NOT EXISTS policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_number TEXT UNIQUE NOT NULL,
  customer_id UUID NOT NULL REFERENCES customers(id),
  policy_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  coverage_amount NUMERIC NOT NULL,
  deductible NUMERIC NOT NULL,
  premium_monthly NUMERIC NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled', 'pending')),
  coverage_details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Claims
CREATE TABLE IF NOT EXISTS claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_number TEXT UNIQUE NOT NULL,
  policy_id UUID NOT NULL REFERENCES policies(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  claim_type TEXT NOT NULL,
  status TEXT DEFAULT 'submitted' CHECK (status IN (
    'submitted', 'under_review', 'documents_needed',
    'approved', 'denied', 'paid', 'closed'
  )),
  incident_date DATE NOT NULL,
  incident_description TEXT NOT NULL,
  claimed_amount NUMERIC,
  approved_amount NUMERIC,
  assigned_adjuster TEXT,
  documents_required TEXT[],
  documents_received TEXT[],
  notes TEXT,
  filed_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Call Logs
CREATE TABLE IF NOT EXISTS call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  elevenlabs_conversation_id TEXT,
  customer_id UUID REFERENCES customers(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'webrtc')),
  phone_number TEXT,
  status TEXT DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'failed')),
  duration_seconds INT,
  transcript JSONB,
  summary TEXT,
  outcome TEXT,
  tools_used TEXT[],
  recording_url TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ
);

-- 5. Call Tool Executions
CREATE TABLE IF NOT EXISTS call_tool_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_log_id UUID NOT NULL REFERENCES call_logs(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  tool_args JSONB,
  tool_result JSONB,
  success BOOLEAN DEFAULT true,
  latency_ms INT,
  executed_at TIMESTAMPTZ DEFAULT now()
);

-- 6. Escalations
CREATE TABLE IF NOT EXISTS escalations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_log_id UUID NOT NULL REFERENCES call_logs(id),
  claim_id UUID REFERENCES claims(id),
  customer_id UUID REFERENCES customers(id),
  reason TEXT NOT NULL,
  priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'resolved')),
  assigned_to TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- 7. Scheduled Callbacks
CREATE TABLE IF NOT EXISTS scheduled_callbacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_log_id UUID REFERENCES call_logs(id),
  customer_id UUID REFERENCES customers(id),
  phone_number TEXT NOT NULL,
  scheduled_time TIMESTAMPTZ NOT NULL,
  reason TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_claims_customer ON claims(customer_id);
CREATE INDEX IF NOT EXISTS idx_claims_policy ON claims(policy_id);
CREATE INDEX IF NOT EXISTS idx_claims_number ON claims(claim_number);
CREATE INDEX IF NOT EXISTS idx_policies_number ON policies(policy_number);
CREATE INDEX IF NOT EXISTS idx_policies_customer ON policies(customer_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_customer ON call_logs(customer_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_conversation ON call_logs(elevenlabs_conversation_id);
CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);
CREATE INDEX IF NOT EXISTS idx_callbacks_status ON scheduled_callbacks(status, scheduled_time);


-- ============================================
-- SOURCE: 0002_filecoin_columns.sql
-- ============================================

-- ============================================
-- Migration 0002: ClaimVault + ERC-8004 columns on `claims`
-- Adds Filecoin/Synapse upload metadata, on-chain attestation
-- references (Base Sepolia ClaimRegistry / EAS), evidence
-- bundle hash, PDP proof status, and ERC-8004 agent linkage.
-- ============================================

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS filecoin_cid         TEXT,        -- IPFS root CID returned by Synapse upload
  ADD COLUMN IF NOT EXISTS piece_cid            TEXT,        -- piece CID from FOC (Filecoin Onchain Cloud)
  ADD COLUMN IF NOT EXISTS dataset_id           TEXT,        -- Filecoin dataset id
  ADD COLUMN IF NOT EXISTS attestation_tx_hash  TEXT,        -- Base Sepolia tx hash from ClaimRegistry.attestClaim
  ADD COLUMN IF NOT EXISTS eas_uid              TEXT,        -- EAS attestation UID (nullable)
  ADD COLUMN IF NOT EXISTS evidence_hash        TEXT,        -- keccak256 of canonical evidence bundle (0x-prefixed)
  ADD COLUMN IF NOT EXISTS pdp_proof_status     TEXT,        -- 'pending' | 'verified' | 'failed'
  ADD COLUMN IF NOT EXISTS agent_id             BIGINT,      -- ERC-8004 agent NFT id
  ADD COLUMN IF NOT EXISTS attested_at          TIMESTAMPTZ; -- when on-chain attestation succeeded

-- Soft enum guard for pdp_proof_status (skip if values diverge later).
ALTER TABLE claims
  DROP CONSTRAINT IF EXISTS claims_pdp_proof_status_check;
ALTER TABLE claims
  ADD CONSTRAINT claims_pdp_proof_status_check
  CHECK (pdp_proof_status IS NULL OR pdp_proof_status IN ('pending', 'verified', 'failed'));

-- Lookup helpers for on-chain reconciliation and dashboard queries.
CREATE INDEX IF NOT EXISTS idx_claims_attestation_tx ON claims(attestation_tx_hash);
CREATE INDEX IF NOT EXISTS idx_claims_eas_uid        ON claims(eas_uid);
CREATE INDEX IF NOT EXISTS idx_claims_filecoin_cid   ON claims(filecoin_cid);
CREATE INDEX IF NOT EXISTS idx_claims_piece_cid      ON claims(piece_cid);
CREATE INDEX IF NOT EXISTS idx_claims_agent_id       ON claims(agent_id);
CREATE INDEX IF NOT EXISTS idx_claims_pdp_status     ON claims(pdp_proof_status);


-- ============================================
-- SOURCE: 0003_filecoin_tables.sql
-- ============================================

-- ============================================
-- Migration 0003: ClaimVault + ERC-8004 supporting tables
-- - agent_registrations : one row per ERC-8004 agent NFT
-- - filecoin_uploads    : per-claim Synapse/FOC upload + PDP tracking
-- - evidence_bundles    : canonical JSON bundle hashed and attested
-- ============================================

-- pgcrypto is assumed enabled (existing tables use gen_random_uuid()).
-- CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. ERC-8004 Agent Registrations
CREATE TABLE IF NOT EXISTS agent_registrations (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id                  BIGINT UNIQUE NOT NULL,        -- ERC-8004 NFT id
  agent_card_cid            TEXT,                          -- IPFS CID of agent card JSON
  identity_registry_address TEXT,                          -- ERC-8004 IdentityRegistry contract address
  network                   TEXT,                          -- e.g. 'base-sepolia'
  owner_address             TEXT,                          -- EOA / smart-account that owns the agent NFT
  registered_at             TIMESTAMPTZ DEFAULT now(),
  registration_tx_hash      TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_registrations_owner   ON agent_registrations(owner_address);
CREATE INDEX IF NOT EXISTS idx_agent_registrations_network ON agent_registrations(network);

-- 2. Filecoin Uploads (Synapse + FOC + PDP lifecycle)
CREATE TABLE IF NOT EXISTS filecoin_uploads (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id           UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  piece_cid          TEXT,
  dataset_id         TEXT,
  root_cid           TEXT,
  upload_status      TEXT,        -- 'pending' | 'uploading' | 'completed' | 'failed'
  pdp_status         TEXT,        -- 'pending' | 'verified' | 'failed'
  last_proven_epoch  BIGINT NULL,
  attempted_at       TIMESTAMPTZ DEFAULT now(),
  completed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_filecoin_uploads_claim         ON filecoin_uploads(claim_id);
CREATE INDEX IF NOT EXISTS idx_filecoin_uploads_piece_cid     ON filecoin_uploads(piece_cid);
CREATE INDEX IF NOT EXISTS idx_filecoin_uploads_upload_status ON filecoin_uploads(upload_status);
CREATE INDEX IF NOT EXISTS idx_filecoin_uploads_pdp_status    ON filecoin_uploads(pdp_status);

-- 3. Evidence Bundles (canonical JSON hashed and attested)
CREATE TABLE IF NOT EXISTS evidence_bundles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id     UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  bundle_json  JSONB NOT NULL,
  bundle_hash  TEXT  NOT NULL,                 -- keccak256(canonical(bundle_json)), 0x-prefixed
  photo_cids   TEXT[] DEFAULT ARRAY[]::TEXT[],
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evidence_bundles_claim ON evidence_bundles(claim_id);
CREATE INDEX IF NOT EXISTS idx_evidence_bundles_hash  ON evidence_bundles(bundle_hash);


-- ============================================
-- SOURCE: 0004_call_log_analysis.sql
-- ============================================

-- ============================================
-- Migration 0004: JSONB analysis/evaluation storage
-- Adds structured payload capture for ElevenLabs analysis
-- and internal evaluation parsing.
-- ============================================

ALTER TABLE call_logs
  ADD COLUMN IF NOT EXISTS analysis        JSONB,
  ADD COLUMN IF NOT EXISTS evaluation      JSONB,
  ADD COLUMN IF NOT EXISTS metadata        JSONB,
  ADD COLUMN IF NOT EXISTS webhook_payload JSONB;

CREATE INDEX IF NOT EXISTS idx_call_logs_analysis_gin
  ON call_logs USING GIN (analysis);

CREATE INDEX IF NOT EXISTS idx_call_logs_evaluation_gin
  ON call_logs USING GIN (evaluation);


-- ============================================
-- SOURCE: seed.sql
-- ============================================

-- ============================================
-- Insurance AI Call Agent — Seed Data (Demo v2)
-- ============================================
-- Indian-diaspora customers in the SF Bay Area
-- Story hero: Arjun Mehta (CLM-2026-000456)
-- Recurring adjuster: Neha Agarwal

-- Wipe existing data in FK-safe order
TRUNCATE TABLE
  call_tool_executions,
  scheduled_callbacks,
  escalations,
  call_logs,
  claims,
  policies,
  customers
RESTART IDENTITY CASCADE;

-- ============================================
-- CUSTOMERS (8)
-- ============================================
INSERT INTO customers (id, full_name, email, phone, date_of_birth, address) VALUES
  ('ceff82d7-acda-4553-9fb9-5e97c3c1e9f5', 'Arjun Mehta',      'arjun.mehta@email.com',     '+14155550101', '1988-03-15', '742 Evergreen Terrace, San Francisco, CA 94110'),
  ('653eb0bf-9421-4d34-af61-75b636d46c8b', 'Priya Sharma',     'priya.sharma@email.com',    '+14155550102', '1991-07-22', '1847 Oak Avenue, San Jose, CA 95126'),
  ('76969bf8-33da-42a3-b682-a82d273fc08e', 'Rohit Kapoor',     'rohit.kapoor@email.com',    '+14155550103', '1982-11-08', '523 Pine Street, Oakland, CA 94612'),
  ('632db4bf-5e1e-4646-8679-e824f7ae0c5c', 'Ananya Iyer',      'ananya.iyer@email.com',     '+14155550104', '1993-01-30', '2100 Market Street, San Francisco, CA 94114'),
  ('bdc63764-2cf8-40e4-ba9e-8f8eadd78e81', 'Vikram Singh',     'vikram.singh@email.com',    '+14155550105', '1985-09-12', '890 Broadway, Redwood City, CA 94063'),
  ('4a769410-333c-43f5-be07-2db1a6ebcff8', 'Kavya Reddy',      'kavya.reddy@email.com',     '+14155550106', '1995-05-18', '1234 Mission Blvd, Fremont, CA 94539'),
  ('a438b10d-0815-4fea-9754-f90de0dc3c9b', 'Rahul Nair',       'rahul.nair@email.com',      '+14155550107', '1987-12-03', '456 El Camino Real, Palo Alto, CA 94301'),
  ('56fcc031-a8c3-48f4-8d94-c0cbb9636f21', 'Divya Patel',      'divya.patel@email.com',     '+14155550108', '1978-06-25', '789 University Ave, Berkeley, CA 94710')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- POLICIES (10: 4 auto, 3 home, 2 health, 1 life)
-- ============================================
INSERT INTO policies (id, policy_number, customer_id, policy_type, provider, coverage_amount, deductible, premium_monthly, start_date, end_date, status, coverage_details) VALUES
  -- Arjun Mehta — Auto (DEMO HERO)
  ('fce88350-4512-4701-83b1-6d26540212ec', 'POL-2024-001234', 'ceff82d7-acda-4553-9fb9-5e97c3c1e9f5', 'auto', 'SafeGuard Insurance', 50000, 1000, 185.50, '2024-01-15', '2027-01-15', 'active',
   '{"vehicle": "2023 Honda Accord", "vin": "1HGCV1F30PA123456", "liability": "100/300/100", "collision": true, "comprehensive": true, "uninsured_motorist": true, "roadside_assistance": true}'),

  -- Arjun Mehta — Home (used in live file_claim demo)
  ('2f410070-8581-47ea-9834-0d0dbcd3f871', 'POL-2024-005678', 'ceff82d7-acda-4553-9fb9-5e97c3c1e9f5', 'home', 'SafeGuard Insurance', 450000, 2500, 210.00, '2024-03-01', '2027-03-01', 'active',
   '{"property_type": "single_family", "square_feet": 1850, "year_built": 1998, "dwelling_coverage": 450000, "personal_property": 225000, "liability": 300000, "water_damage": true, "flood": false, "earthquake": true}'),

  -- Priya Sharma — Auto
  ('3914ed72-6138-448a-967d-cadbc62100c0', 'POL-2024-002345', '653eb0bf-9421-4d34-af61-75b636d46c8b', 'auto', 'SafeGuard Insurance', 35000, 500, 145.00, '2024-06-01', '2026-06-01', 'active',
   '{"vehicle": "2022 Toyota Corolla", "vin": "5YFBURHE7NP543210", "liability": "50/100/50", "collision": true, "comprehensive": true, "uninsured_motorist": false, "roadside_assistance": false}'),

  -- Rohit Kapoor — Auto
  ('86bf4e4d-2e16-4db7-a9fd-4584da17bc65', 'POL-2023-003456', '76969bf8-33da-42a3-b682-a82d273fc08e', 'auto', 'SafeGuard Insurance', 75000, 1500, 220.00, '2023-09-01', '2025-09-01', 'active',
   '{"vehicle": "2023 Tesla Model Y", "vin": "7SAYGDEE5NF278901", "liability": "250/500/250", "collision": true, "comprehensive": true, "uninsured_motorist": true, "roadside_assistance": true}'),

  -- Ananya Iyer — Home
  ('50f41cf7-f922-4a0b-a74b-a1368743f503', 'POL-2024-006789', '632db4bf-5e1e-4646-8679-e824f7ae0c5c', 'home', 'SafeGuard Insurance', 320000, 2000, 175.00, '2024-02-15', '2027-02-15', 'active',
   '{"property_type": "condo", "square_feet": 1200, "year_built": 2010, "dwelling_coverage": 320000, "personal_property": 160000, "liability": 200000, "theft": true, "flood": false}'),

  -- Vikram Singh — Health
  ('82cd7e8d-7b39-4af8-bae1-a24706824aff', 'POL-2024-007890', 'bdc63764-2cf8-40e4-ba9e-8f8eadd78e81', 'health', 'SafeGuard Health', 500000, 3000, 450.00, '2024-01-01', '2026-12-31', 'active',
   '{"plan_type": "PPO", "network": "nationwide", "copay_primary": 25, "copay_specialist": 50, "prescription_coverage": true, "emergency_room_copay": 250, "dental": false, "vision": true, "max_out_of_pocket": 8000}'),

  -- Kavya Reddy — Auto
  ('50b81696-620c-4d5a-b8b8-7a3b054152a9', 'POL-2025-004567', '4a769410-333c-43f5-be07-2db1a6ebcff8', 'auto', 'SafeGuard Insurance', 40000, 750, 155.00, '2025-01-10', '2027-01-10', 'active',
   '{"vehicle": "2024 Hyundai Elantra", "vin": "KMHLN4AG4RU234567", "liability": "100/300/100", "collision": true, "comprehensive": true, "uninsured_motorist": true, "roadside_assistance": true}'),

  -- Rahul Nair — Home
  ('d35137ba-6a1c-4eb9-9b35-13cfb5a1db04', 'POL-2024-008901', 'a438b10d-0815-4fea-9754-f90de0dc3c9b', 'home', 'SafeGuard Insurance', 780000, 5000, 340.00, '2024-05-01', '2027-05-01', 'active',
   '{"property_type": "single_family", "square_feet": 2800, "year_built": 2015, "dwelling_coverage": 780000, "personal_property": 390000, "liability": 500000, "fire": true, "flood": false, "earthquake": true, "additional_living_expenses": 50000}'),

  -- Divya Patel — Health
  ('1e660eae-9270-46a9-864e-64afec2942ee', 'POL-2024-009012', '56fcc031-a8c3-48f4-8d94-c0cbb9636f21', 'health', 'SafeGuard Health', 750000, 2000, 520.00, '2024-01-01', '2026-12-31', 'active',
   '{"plan_type": "HMO", "network": "california", "copay_primary": 15, "copay_specialist": 35, "prescription_coverage": true, "dental": true, "vision": true, "max_out_of_pocket": 6000}'),

  -- Divya Patel — Life
  ('ecfb7e18-a373-4090-a233-9056c75b05c1', 'POL-2024-010123', '56fcc031-a8c3-48f4-8d94-c0cbb9636f21', 'life', 'SafeGuard Insurance', 1000000, 0, 85.00, '2024-04-01', '2054-04-01', 'active',
   '{"term_years": 30, "beneficiary": "Rohan Patel (spouse)", "type": "term_life", "accidental_death": true, "waiver_of_premium": true}')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- CLAIMS (11)
-- NOTE: Arjun's home claim intentionally DOES NOT exist.
-- During live demo, file_claim will create it.
-- ============================================
INSERT INTO claims (id, claim_number, policy_id, customer_id, claim_type, status, incident_date, incident_description, claimed_amount, approved_amount, assigned_adjuster, documents_required, documents_received, notes, filed_at, updated_at) VALUES
  -- Arjun Mehta — DEMO HERO: auto collision, under review, missing documents
  ('4a3ee369-d48a-4717-8603-01f7a4257cdd', 'CLM-2026-000456', 'fce88350-4512-4701-83b1-6d26540212ec', 'ceff82d7-acda-4553-9fb9-5e97c3c1e9f5',
   'collision', 'under_review', '2026-04-10',
   'Rear-ended at intersection of Market St and 5th Ave while stopped at a red light. Other driver ran the light. Moderate damage to rear bumper, trunk lid, and tail lights. No injuries reported. Police report filed (#SF-2026-04-8834).',
   8275.00, NULL, 'Neha Agarwal',
   ARRAY['police_report', 'repair_estimate', 'photos', 'other_driver_info'],
   ARRAY['police_report', 'other_driver_info'],
   'Awaiting repair estimate from customer-preferred body shop. Damage photos still pending. Other driver''s insurance (Progressive, policy #PG-445566) has been contacted.',
   '2026-04-11 10:30:00-07', '2026-04-17 14:15:00-07'),

  -- Priya Sharma — approved windshield (smooth happy-path example)
  ('653b9f83-c876-4c66-867f-6af4eb6099a2', 'CLM-2026-000321', '3914ed72-6138-448a-967d-cadbc62100c0', '653eb0bf-9421-4d34-af61-75b636d46c8b',
   'windshield', 'approved', '2026-04-05',
   'Rock struck windshield on Highway 101 causing a large crack across the driver side. Full replacement required.',
   925.00, 925.00, 'Neha Agarwal',
   ARRAY['photos', 'repair_estimate'],
   ARRAY['photos', 'repair_estimate'],
   'Claim approved for full windshield replacement. Safelite authorized for repair. Zero deductible for glass claims under this policy.',
   '2026-04-06 09:00:00-07', '2026-04-12 16:45:00-07'),

  -- Rohit Kapoor — DENIED claim (used in escalation scenarios)
  ('13561ee8-304c-4e90-9262-d09a5dd40c27', 'CLM-2026-000789', '86bf4e4d-2e16-4db7-a9fd-4584da17bc65', '76969bf8-33da-42a3-b682-a82d273fc08e',
   'collision', 'denied', '2026-02-14',
   'Vehicle struck a pothole causing damage to front right wheel and suspension. Customer contends the City of Oakland is responsible.',
   4180.00, 0, 'Deepak Gupta',
   ARRAY['photos', 'repair_estimate', 'police_report'],
   ARRAY['photos', 'repair_estimate'],
   'Claim denied. Pothole damage is excluded under Section 4.2 (Road Hazard Exclusion). Customer advised to file with City of Oakland. Appeal window closes 2026-05-14.',
   '2026-02-15 14:20:00-08', '2026-03-01 10:00:00-08'),

  -- Ananya Iyer — recent theft, fresh submission
  ('70dd8e9f-77a7-4db1-8d55-2500c9eacecc', 'CLM-2026-000112', '50f41cf7-f922-4a0b-a74b-a1368743f503', '632db4bf-5e1e-4646-8679-e824f7ae0c5c',
   'theft', 'submitted', '2026-04-18',
   'Package containing a MacBook Pro 16" stolen from front porch. Ring doorbell footage captures theft at 2:47 PM. Police report filed the same day.',
   2785.00, NULL, NULL,
   ARRAY['police_report', 'proof_of_purchase', 'doorbell_footage'],
   ARRAY[]::text[],
   'New claim submitted via phone. Awaiting initial document collection.',
   '2026-04-19 11:00:00-07', '2026-04-19 11:00:00-07'),

  -- Vikram Singh — fresh ER claim
  ('538882e8-6c23-424c-94a9-0530d815a48f', 'CLM-2026-000890', '82cd7e8d-7b39-4af8-bae1-a24706824aff', 'bdc63764-2cf8-40e4-ba9e-8f8eadd78e81',
   'medical', 'submitted', '2026-04-16',
   'Emergency room visit for severe allergic reaction. Administered epinephrine and observed for 6 hours. Follow-up with allergist scheduled.',
   4485.00, NULL, NULL,
   ARRAY['er_records', 'itemized_bill', 'referral_letter'],
   ARRAY[]::text[],
   'Claim submitted online. Waiting on hospital to send itemized bill.',
   '2026-04-17 19:30:00-07', '2026-04-17 19:30:00-07'),

  -- Kavya Reddy — hit-and-run under review
  ('fff91358-13a8-413b-bcde-a6045654bbd2', 'CLM-2026-000234', '50b81696-620c-4d5a-b8b8-7a3b054152a9', '4a769410-333c-43f5-be07-2db1a6ebcff8',
   'collision', 'under_review', '2026-04-02',
   'Sideswipe collision in parking garage at Westfield Mall. Other vehicle left the scene. Security camera footage obtained from mall.',
   3220.00, NULL, 'Neha Agarwal',
   ARRAY['photos', 'repair_estimate', 'security_footage', 'police_report'],
   ARRAY['photos', 'repair_estimate', 'security_footage', 'police_report'],
   'All documents received. Adjuster reviewing security footage to identify other vehicle. Hit-and-run supplement filed.',
   '2026-04-03 08:45:00-07', '2026-04-15 13:20:00-07'),

  -- Rahul Nair — fire damage, documents_needed (high-drama open claim)
  ('c2f3436d-c03f-4b40-9667-cbda61996c40', 'CLM-2026-000345', 'd35137ba-6a1c-4eb9-9b35-13cfb5a1db04', 'a438b10d-0815-4fea-9754-f90de0dc3c9b',
   'fire_damage', 'documents_needed', '2026-03-28',
   'Kitchen fire caused by faulty electrical outlet. Fire department responded. Damage to cabinets, countertops, appliances. Smoke damage across the first floor.',
   44800.00, NULL, 'Rajiv Khanna',
   ARRAY['fire_dept_report', 'contractor_estimates', 'inventory_damaged_items', 'photos', 'temporary_housing_receipts'],
   ARRAY['fire_dept_report', 'photos'],
   'Major claim. Customer currently in temporary housing. Need contractor estimates and full inventory. Fire marshal confirmed electrical cause.',
   '2026-03-29 07:00:00-07', '2026-04-15 09:15:00-07'),

  -- Divya Patel — approved knee surgery (health happy-path)
  ('11e97387-2d99-465d-bd77-f7d64ebee741', 'CLM-2026-000567', '1e660eae-9270-46a9-864e-64afec2942ee', '56fcc031-a8c3-48f4-8d94-c0cbb9636f21',
   'medical', 'approved', '2026-03-15',
   'Outpatient knee surgery (arthroscopic meniscus repair). Pre-authorized by PCP referral.',
   8500.00, 6800.00, 'Claims Auto-Process',
   ARRAY['surgical_records', 'itemized_bill', 'pcp_referral'],
   ARRAY['surgical_records', 'itemized_bill', 'pcp_referral'],
   'Approved after standard review. Patient responsibility: $1,700 (copay + coinsurance). Payment processing to provider.',
   '2026-03-18 10:00:00-07', '2026-03-28 14:30:00-07'),

  -- Priya Sharma — paid previous claim (historical)
  ('e885297f-1bdd-4b06-8dc1-6eb69c813645', 'CLM-2025-000999', '3914ed72-6138-448a-967d-cadbc62100c0', '653eb0bf-9421-4d34-af61-75b636d46c8b',
   'collision', 'paid', '2025-11-15',
   'Minor fender bender in parking lot. Scratches and small dent on rear passenger door.',
   1180.00, 680.00, 'Deepak Gupta',
   ARRAY['photos', 'repair_estimate'],
   ARRAY['photos', 'repair_estimate'],
   'Claim paid. $680 approved after $500 deductible. Direct deposit sent 2025-12-20.',
   '2025-11-16 13:00:00-08', '2025-12-20 09:00:00-08'),

  -- Vikram Singh — PT claim, documents needed
  ('6211f504-dfd8-4a98-943c-728fa4f9c755', 'CLM-2026-000678', '82cd7e8d-7b39-4af8-bae1-a24706824aff', 'bdc63764-2cf8-40e4-ba9e-8f8eadd78e81',
   'medical', 'documents_needed', '2026-01-15',
   'Physical therapy sessions (12 visits) for lower back pain. Referred by primary care physician.',
   3575.00, NULL, 'Claims Auto-Process',
   ARRAY['pt_records', 'itemized_bills', 'pcp_referral', 'treatment_plan'],
   ARRAY['pcp_referral'],
   'Need itemized bills for each session and the treatment plan from the physical therapist.',
   '2026-02-01 11:00:00-08', '2026-03-15 16:00:00-07'),

  -- Rohit Kapoor — closed hail damage (historical)
  ('17c3767f-536f-4356-89a0-33679825372b', 'CLM-2025-000444', '86bf4e4d-2e16-4db7-a9fd-4584da17bc65', '76969bf8-33da-42a3-b682-a82d273fc08e',
   'comprehensive', 'closed', '2025-08-20',
   'Hail damage to vehicle roof and hood during summer storm. Multiple dents and cracked windshield.',
   6775.00, 5275.00, 'Neha Agarwal',
   ARRAY['photos', 'repair_estimate', 'weather_report'],
   ARRAY['photos', 'repair_estimate', 'weather_report'],
   'Repairs completed at certified body shop. $5,275 paid after $1,500 deductible. Customer satisfied.',
   '2025-08-21 10:00:00-07', '2025-09-30 15:00:00-07')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- CALL LOGS (10, mostly recent, mix of directions)
-- ============================================
INSERT INTO call_logs (id, elevenlabs_conversation_id, customer_id, direction, phone_number, status, duration_seconds, transcript, summary, outcome, tools_used, recording_url, started_at, ended_at) VALUES
  -- Arjun Mehta — prior status inquiry
  ('a2bd756d-3177-45ea-9609-88a64c262380', 'conv_1prd57534aqe7qf9ftqg785a60', 'ceff82d7-acda-4553-9fb9-5e97c3c1e9f5', 'inbound', '+14155550101', 'completed', 245,
   '[{"role":"agent","message":"Hi, this is Ansh from SafeGuard Insurance claims. How can I help you today?"},{"role":"user","message":"Hi Ansh, this is Arjun Mehta. I want to check on my auto claim from the accident last week."},{"role":"agent","message":"Of course, Mr. Mehta. Could you give me the claim number?"},{"role":"user","message":"CLM-2026-000456."},{"role":"agent","message":"Got it. Your collision claim is currently under review with Neha Agarwal. It looks like we are still waiting on a few documents from you. Would you like me to tell you what is missing?"},{"role":"user","message":"Yes please."},{"role":"agent","message":"We still need your repair estimate and photos of the damage. Once those come in, Neha can move forward with the evaluation."},{"role":"user","message":"Alright, I will have those by this week."},{"role":"agent","message":"Thank you. Is there anything else I can help you with today?"},{"role":"user","message":"No, that is all for now."},{"role":"agent","message":"Thanks for calling SafeGuard. Have a great day."}]',
   'Arjun Mehta called to check auto collision claim CLM-2026-000456. Informed claim is under review, missing repair estimate and photos. Will provide this week.',
   'information_provided',
   ARRAY['lookup_claim', 'check_documents'],
   NULL,
   '2026-04-17 14:30:00-07', '2026-04-17 14:34:05-07'),

  -- Priya Sharma — approved notification
  ('5cd677f6-9ebd-48c6-bae4-df664987738c', 'conv_gv9jkddk9m7zjgqsg54yye3gn5', '653eb0bf-9421-4d34-af61-75b636d46c8b', 'outbound', '+14155550102', 'completed', 180,
   '[{"role":"agent","message":"Hello, may I speak with Priya Sharma? This is Ansh from SafeGuard Insurance."},{"role":"user","message":"Yes, this is Priya."},{"role":"agent","message":"Great news — your windshield claim CLM-2026-000321 has been approved for the full amount of $925."},{"role":"user","message":"Oh wonderful. When can I get it fixed?"},{"role":"agent","message":"We have authorized Safelite for the repair. They will contact you within 24 hours. Since this is a glass claim, there is no deductible."},{"role":"user","message":"Perfect, thank you."},{"role":"agent","message":"You are welcome. Is there anything else I can help with today?"},{"role":"user","message":"No, that is everything."}]',
   'Outbound call to Priya Sharma notifying windshield claim CLM-2026-000321 approved for $925. Safelite will schedule repair.',
   'claim_update_delivered',
   ARRAY['lookup_claim'],
   NULL,
   '2026-04-13 10:00:00-07', '2026-04-13 10:03:00-07'),

  -- Rohit Kapoor — denied claim dispute (escalation)
  ('94137026-9cb9-432c-a236-8fe813fb464e', 'conv_2hzfj3aeej8ggdnk1z9j8f9j5s', '76969bf8-33da-42a3-b682-a82d273fc08e', 'inbound', '+14155550103', 'completed', 420,
   '[{"role":"agent","message":"Hi, this is Ansh from SafeGuard Insurance claims. How can I help you today?"},{"role":"user","message":"My claim was denied. CLM-2026-000789. This is unacceptable."},{"role":"agent","message":"I am really sorry to hear that, Mr. Kapoor. Let me look into this for you right away."},{"role":"user","message":"Fine. It is for the pothole damage to my Tesla."},{"role":"agent","message":"I see the denial was based on Section 4.2, the Road Hazard Exclusion. Pothole damage falls outside collision coverage."},{"role":"user","message":"That makes no sense. I pay $220 a month for this policy. Can I appeal this?"},{"role":"agent","message":"Absolutely. You have until May 14th to file an appeal. Would you like me to escalate this to a supervisor for further review?"},{"role":"user","message":"Yes, please do that."},{"role":"agent","message":"I have escalated your case with high priority. A senior specialist will contact you within 2 business hours. Is there anything else?"},{"role":"user","message":"No, just make sure someone calls me."}]',
   'Rohit Kapoor disputed denied pothole claim CLM-2026-000789. Agent explained Section 4.2 exclusion, offered appeal path, escalated to supervisor with high priority.',
   'escalation_created',
   ARRAY['lookup_claim', 'escalate_to_human'],
   NULL,
   '2026-03-05 16:15:00-08', '2026-03-05 16:22:00-08'),

  -- Ananya Iyer — new theft claim
  ('bc427582-6dbb-410f-a7a6-bc2a3de0d1d9', 'conv_eg0ttetm41aewggz0zqdfd8rb3', '632db4bf-5e1e-4646-8679-e824f7ae0c5c', 'inbound', '+14155550104', 'completed', 360,
   '[{"role":"agent","message":"Hi, this is Ansh from SafeGuard Insurance claims. How can I help you today?"},{"role":"user","message":"My laptop was stolen from my porch. I need to file a claim."},{"role":"agent","message":"I am sorry to hear that. Can you give me your policy number?"},{"role":"user","message":"POL-2024-006789."},{"role":"agent","message":"Thank you, Ananya. What was the value of the laptop?"},{"role":"user","message":"A MacBook Pro 16 inch, around $2,785."},{"role":"agent","message":"I have filed your claim. Your claim number is CLM-2026-000112. We will need a police report, proof of purchase, and the Ring doorbell footage."},{"role":"user","message":"I already have all of that."},{"role":"agent","message":"Great. Email those to claims@safeguard.com with your claim number in the subject. Your adjuster will be assigned within 48 hours."}]',
   'Ananya Iyer filed theft claim CLM-2026-000112 for stolen MacBook Pro. Has police report and doorbell footage.',
   'new_claim_filed',
   ARRAY['check_policy', 'file_claim'],
   NULL,
   '2026-04-19 11:00:00-07', '2026-04-19 11:06:00-07'),

  -- Arjun Mehta — earlier policy check via browser
  ('67e56730-df6c-4c4b-bf03-92af55ad975e', 'conv_h8ha3yar5nwg58et860z7e7j7p', 'ceff82d7-acda-4553-9fb9-5e97c3c1e9f5', 'webrtc', NULL, 'completed', 195,
   '[{"role":"agent","message":"Hi, this is Ansh from SafeGuard Insurance claims. How can I help you today?"},{"role":"user","message":"I want to check what my auto policy covers. Does it include rental car coverage?"},{"role":"agent","message":"Let me pull up your policy. What is your policy number?"},{"role":"user","message":"POL-2024-001234."},{"role":"agent","message":"You have collision, comprehensive, uninsured motorist, and roadside assistance. Rental car coverage is not currently included."},{"role":"user","message":"Can I add it?"},{"role":"agent","message":"Absolutely. That would be around $15 to $20 per month. Would you like me to schedule a callback with an agent to add it?"},{"role":"user","message":"Yes, tomorrow afternoon please."},{"role":"agent","message":"I have scheduled a callback for tomorrow at 2 PM. Anything else?"},{"role":"user","message":"No thanks."}]',
   'Arjun Mehta inquired about rental coverage on auto policy. Not currently included. Callback scheduled for next-day discussion.',
   'callback_scheduled',
   ARRAY['check_policy', 'schedule_callback'],
   NULL,
   '2026-04-14 16:00:00-07', '2026-04-14 16:03:15-07'),

  -- Vikram Singh — ER coverage question
  ('b291f581-12ef-4c92-9afc-a94fdbc40811', 'conv_943zkkf996jafb6qdbmgpnjmkw', 'bdc63764-2cf8-40e4-ba9e-8f8eadd78e81', 'inbound', '+14155550105', 'completed', 290,
   '[{"role":"agent","message":"Hi, this is Ansh from SafeGuard Health. How can I help you today?"},{"role":"user","message":"I went to the ER last night and I want to understand my coverage."},{"role":"agent","message":"Happy to help. Policy number?"},{"role":"user","message":"POL-2024-007890."},{"role":"agent","message":"You have a PPO plan with a $3,000 deductible and $8,000 max out-of-pocket. ER visits have a $250 copay plus 20 percent coinsurance after the deductible."},{"role":"user","message":"OK. Any update on my submitted claim?"},{"role":"agent","message":"Claim CLM-2026-000890 is in initial review. We are waiting for the itemized hospital bill. Processing takes 5 to 7 business days after that."},{"role":"user","message":"Thanks for explaining."}]',
   'Vikram Singh asked about ER coverage and status of claim CLM-2026-000890. Claim pending itemized bill.',
   'information_provided',
   ARRAY['check_policy', 'lookup_claim'],
   NULL,
   '2026-04-17 09:20:00-07', '2026-04-17 09:24:50-07'),

  -- Kavya Reddy — hit-and-run file_claim
  ('3dcac0dd-d277-4e1e-827d-a7f3d6e8924a', 'conv_x82g46z8q06b88h1qn9w7dfw2k', '4a769410-333c-43f5-be07-2db1a6ebcff8', 'inbound', '+14155550106', 'completed', 310,
   '[{"role":"agent","message":"Hi, this is Ansh from SafeGuard Insurance claims. How can I help you today?"},{"role":"user","message":"I need to report an accident. Someone sideswiped me in a parking garage and left."},{"role":"agent","message":"I am really sorry. Are you or anyone else injured?"},{"role":"user","message":"No, just damage to my car."},{"role":"agent","message":"That is a hit and run situation. Policy number please?"},{"role":"user","message":"POL-2025-004567."},{"role":"agent","message":"I have filed claim CLM-2026-000234. Since this is a hit-and-run, please file a police report and secure any security camera footage."},{"role":"user","message":"I already have the mall security footage."},{"role":"agent","message":"Excellent. Your adjuster will be Neha Agarwal."}]',
   'Kavya Reddy reported hit-and-run sideswipe, filed claim CLM-2026-000234. Has security footage. Assigned to Neha Agarwal.',
   'new_claim_filed',
   ARRAY['check_policy', 'file_claim'],
   NULL,
   '2026-04-03 08:45:00-07', '2026-04-03 08:50:10-07'),

  -- Rahul Nair — fire damage urgency
  ('ed6868e5-b326-411d-ab3a-18e22b49bd5e', 'conv_avhn2s344wrd0t10et61zt5dhe', 'a438b10d-0815-4fea-9754-f90de0dc3c9b', 'inbound', '+14155550107', 'completed', 480,
   '[{"role":"agent","message":"Hi, this is Ansh from SafeGuard Insurance claims. How can I help you today?"},{"role":"user","message":"This is Rahul Nair. I am calling about my fire damage claim. It has been weeks and I am still in a hotel."},{"role":"agent","message":"Mr. Nair, I completely understand how stressful this is. Let me check on your claim right away."},{"role":"user","message":"It is CLM-2026-000345."},{"role":"agent","message":"I see the claim is in documents needed status. We have your fire department report and photos, but we still need contractor estimates, an inventory of damaged items, and temporary housing receipts."},{"role":"user","message":"The hotel is costing $200 a night. Will SafeGuard keep covering it?"},{"role":"agent","message":"Yes. You have up to $50,000 in Additional Living Expenses coverage. Submit your receipts and we can start reimbursing those while the main claim is evaluated. Would you like me to escalate this with urgent priority?"},{"role":"user","message":"Yes please."},{"role":"agent","message":"I have escalated this with urgent priority. Rajiv Khanna will contact you within 2 hours."}]',
   'Rahul Nair called about fire damage claim CLM-2026-000345. Concerned about hotel costs. Confirmed ALE coverage. Escalated with urgent priority.',
   'escalation_created',
   ARRAY['lookup_claim', 'check_policy', 'escalate_to_human'],
   NULL,
   '2026-04-15 13:30:00-07', '2026-04-15 13:38:00-07'),

  -- Divya Patel — knee surgery confirmation
  ('5ea61b30-8b3c-4fa5-8786-29e29db925d3', 'conv_tcy4kam1hfjy8xsx6vea037n6b', '56fcc031-a8c3-48f4-8d94-c0cbb9636f21', 'webrtc', NULL, 'completed', 210,
   '[{"role":"agent","message":"Hi, this is Ansh from SafeGuard Health. How can I help you today?"},{"role":"user","message":"My knee surgery claim was approved. I wanted to confirm what I owe."},{"role":"agent","message":"Sure. Claim number?"},{"role":"user","message":"CLM-2026-000567."},{"role":"agent","message":"Approved for $6,800 of the $8,500 total. Your responsibility is $1,700."},{"role":"user","message":"Thank you."}]',
   'Divya Patel confirmed approved knee surgery claim. Patient owes $1,700.',
   'information_provided',
   ARRAY['lookup_claim'],
   NULL,
   '2026-03-29 11:15:00-07', '2026-03-29 11:18:30-07'),

  -- Kavya Reddy — status check-in
  ('a42ce12c-4afc-4731-b2b5-cce91e5cc1e5', 'conv_6b2q9spgq54gyt14vqbjc4gx2b', '4a769410-333c-43f5-be07-2db1a6ebcff8', 'inbound', '+14155550106', 'completed', 200,
   '[{"role":"agent","message":"Hi, this is Ansh from SafeGuard Insurance claims. How can I help you today?"},{"role":"user","message":"Checking in on my claim for the parking garage incident."},{"role":"agent","message":"Claim number please?"},{"role":"user","message":"CLM-2026-000234."},{"role":"agent","message":"All documents received. Neha Agarwal is reviewing the security footage to identify the other vehicle. Expect an update by April 22nd."},{"role":"user","message":"Will my rates go up?"},{"role":"agent","message":"Since this is a hit-and-run where you are not at fault, your rates should not be affected."},{"role":"user","message":"Thanks."}]',
   'Kavya Reddy checked status of claim CLM-2026-000234. All docs received. Expected update April 22.',
   'information_provided',
   ARRAY['lookup_claim'],
   NULL,
   '2026-04-18 15:45:00-07', '2026-04-18 15:48:25-07')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- ESCALATIONS (3 pending)
-- ============================================
INSERT INTO escalations (id, call_log_id, claim_id, customer_id, reason, priority, status, assigned_to, notes, created_at) VALUES
  ('c91686e0-7d4c-47bc-8e78-9caed07f5fd9', '94137026-9cb9-432c-a236-8fe813fb464e', '13561ee8-304c-4e90-9262-d09a5dd40c27', '76969bf8-33da-42a3-b682-a82d273fc08e',
   'Customer disputing denied pothole damage claim. Requesting supervisor review of policy exclusion interpretation.',
   'high', 'pending', NULL,
   'Customer was upset during call. Appeal window until May 14, 2026. Review Section 4.2 Road Hazard Exclusion applicability.',
   '2026-03-05 16:22:00-08'),

  ('63ed0d95-4e70-4b1b-928c-6b61e83ab23c', 'ed6868e5-b326-411d-ab3a-18e22b49bd5e', 'c2f3436d-c03f-4b40-9667-cbda61996c40', 'a438b10d-0815-4fea-9754-f90de0dc3c9b',
   'Major fire damage claim — customer displaced in hotel. Needs expedited processing for ALE reimbursement.',
   'urgent', 'pending', NULL,
   'Customer incurring $200/night hotel costs. ALE coverage confirmed up to $50K. Hotel receipts need immediate processing.',
   '2026-04-15 13:38:00-07'),

  ('3e8d3ffb-1a81-4cd8-9267-33f87797731a', 'a2bd756d-3177-45ea-9609-88a64c262380', '4a3ee369-d48a-4717-8603-01f7a4257cdd', 'ceff82d7-acda-4553-9fb9-5e97c3c1e9f5',
   'Auto claim CLM-2026-000456 stalled — repair estimate and photos outstanding. Proactive follow-up needed.',
   'normal', 'pending', NULL,
   'Customer said during April 17 call he would provide documents this week. Follow up if not received by April 21.',
   '2026-04-18 09:00:00-07')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- SCHEDULED CALLBACKS (2 pending, recent)
-- ============================================
INSERT INTO scheduled_callbacks (id, call_log_id, customer_id, phone_number, scheduled_time, reason, status, created_at) VALUES
  ('c4bdaa1e-4489-4911-8cc0-fc4426c6f2d8', '67e56730-df6c-4c4b-bf03-92af55ad975e', 'ceff82d7-acda-4553-9fb9-5e97c3c1e9f5', '+14155550101',
   '2026-04-22 14:00:00-07',
   'Customer interested in adding rental car coverage to auto policy POL-2024-001234. Quote approx $15-20/month.',
   'pending',
   '2026-04-14 16:03:00-07'),

  ('311b7e44-1cee-4908-8849-2dde6985ed32', 'ed6868e5-b326-411d-ab3a-18e22b49bd5e', 'a438b10d-0815-4fea-9754-f90de0dc3c9b', '+14155550107',
   '2026-04-22 10:00:00-07',
   'Rajiv Khanna to call Rahul Nair re: fire claim CLM-2026-000345 timeline and ALE reimbursement process.',
   'pending',
   '2026-04-15 13:38:00-07')
ON CONFLICT (id) DO NOTHING;


-- ============================================
-- SOURCE: 0005_test_dataset.sql
-- ============================================

-- ============================================
-- Migration 0005: extended test dataset
--
-- Adds what seed.sql does not cover:
--   * expired and cancelled policies, so file_claim rejection is testable
--   * a customer with an active policy and no claim history
--   * a water_damage claim (a supported type with no example)
--   * call_tool_executions, including one failed execution
--   * agent_registrations / filecoin_uploads / evidence_bundles
--
-- bundle_hash values are real keccak256 digests of bundle_json, so
-- POST /api/claims/:id/verify-integrity returns match: true.
-- CIDs are real CIDv1 content addresses of the same bundle bytes. They were
-- never uploaded to a live network, so public gateways will not resolve them.
--
-- Generated by database/build-test-dataset.mjs — do not edit by hand.
-- ============================================

-- A customer with an active policy and no claims: exercises the clean
-- file_claim path and the "No history" branch of conversation-init.
INSERT INTO customers (id, full_name, email, phone, date_of_birth, address) VALUES
  ('916904d8-36f5-46b6-bbd8-84e875bfa8dc', 'Meera Joshi', 'meera.joshi@email.com', '+14155550109', '1990-08-14', '55 Cedar Lane, Sunnyvale, CA 94086')
ON CONFLICT (id) DO NOTHING;

-- Policies covering the non-active states.
INSERT INTO policies (id, policy_number, customer_id, policy_type, provider, coverage_amount, deductible, premium_monthly, start_date, end_date, status, coverage_details) VALUES
  ('607ec7c5-348a-4a9b-8a72-0fe9608af130', 'POL-2022-000111', 'ceff82d7-acda-4553-9fb9-5e97c3c1e9f5', 'auto', 'SafeGuard Insurance', 40000, 1000, 165.00, '2022-01-10', '2024-01-10', 'expired', '{"vehicle":"2018 Honda Civic","vin":"2HGFC2F59JH512843","note":"Superseded by POL-2024-001234"}'::jsonb),
  ('6a743f2f-71ea-4190-b8f3-8f4e9d69f562', 'POL-2024-000222', '916904d8-36f5-46b6-bbd8-84e875bfa8dc', 'home', 'SafeGuard Insurance', 300000, 2000, 160.00, '2024-05-01', '2027-05-01', 'cancelled', '{"property_type":"condo","square_feet":1100,"cancellation_reason":"non_payment","cancelled_on":"2025-11-30"}'::jsonb),
  ('bd712ebf-0014-4db7-b364-571245bf3ef1', 'POL-2025-000333', '916904d8-36f5-46b6-bbd8-84e875bfa8dc', 'auto', 'SafeGuard Insurance', 45000, 750, 172.00, '2025-06-01', '2028-06-01', 'active', '{"vehicle":"2024 Hyundai Tucson","vin":"5NMJBCAE9RH123456","liability":"100/300/100","collision":true,"comprehensive":true,"uninsured_motorist":true,"roadside_assistance":true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- water_damage claim — the one supported claim type with no seeded example.
INSERT INTO claims (id, claim_number, policy_id, customer_id, claim_type, status, incident_date, incident_description, claimed_amount, approved_amount, assigned_adjuster, documents_required, documents_received, notes, filed_at, updated_at) VALUES
  ('fb84d220-258c-4f81-a75d-f4657bb1add7', 'CLM-2026-000601', '50f41cf7-f922-4a0b-a74b-a1368743f503', '632db4bf-5e1e-4646-8679-e824f7ae0c5c', 'water_damage', 'documents_needed', '2026-04-20',
   'Supply line to the upstairs washing machine burst overnight, flooding the laundry room and soaking through to the living room ceiling below. Emergency plumber stopped the leak at 6am. Drywall, flooring, and ceiling require replacement.',
   14200.00, NULL, 'Sanjay Verma', ARRAY['plumber_invoice', 'damage_photos', 'contractor_estimate']::TEXT[], ARRAY['plumber_invoice']::TEXT[],
   'Emergency mitigation approved same day. Awaiting contractor estimate and full damage photos before adjuster site visit. Flood endorsement does not apply — this is sudden internal discharge, covered under the base policy.', '2026-04-20 08:15:00-07', '2026-04-21 11:00:00-07')
ON CONFLICT (id) DO NOTHING;

-- Tool executions for the seeded calls, including one failure.
INSERT INTO call_tool_executions (id, call_log_id, tool_name, tool_args, tool_result, success, latency_ms, executed_at) VALUES
  ('904d9106-fee7-4eda-ac52-0aa3b1de8bb8', 'a2bd756d-3177-45ea-9609-88a64c262380', 'lookup_claim', '{"claim_number":"CLM-2026-000456"}'::jsonb, '{"found":true,"claim":{"claim_number":"CLM-2026-000456","status":"under_review","claim_type":"collision","claimed_amount":"8275.00","assigned_adjuster":"Neha Agarwal"}}'::jsonb, true, 312, '2026-04-17 14:31:12-07'),
  ('a9213d99-fe52-4d5e-a9fb-2d45c74168fb', 'a2bd756d-3177-45ea-9609-88a64c262380', 'check_documents', '{"claim_number":"CLM-2026-000456"}'::jsonb, '{"found":true,"documents_missing":["repair_estimate","photos"],"message":"You still need to submit the following for claim CLM-2026-000456: repair estimate and photos."}'::jsonb, true, 288, '2026-04-17 14:32:40-07'),
  ('af776bb0-4280-44b5-8d38-d42a652eee2e', '5cd677f6-9ebd-48c6-bae4-df664987738c', 'lookup_claim', '{"claim_number":"CLM-2026-000321"}'::jsonb, '{"found":true,"claim":{"claim_number":"CLM-2026-000321","status":"approved"}}'::jsonb, true, 265, '2026-04-13 10:01:05-07'),
  ('e12e3deb-3ddd-47cb-a1b4-8624f49f9278', '94137026-9cb9-432c-a236-8fe813fb464e', 'lookup_claim', '{"claim_number":"CLM-2026-000789"}'::jsonb, '{"found":true,"claim":{"claim_number":"CLM-2026-000789","status":"denied"}}'::jsonb, true, 341, '2026-03-05 16:15:30-08'),
  ('d1f3b4dd-6bb5-4e79-8f5e-6140eae559c8', '94137026-9cb9-432c-a236-8fe813fb464e', 'check_documents', '{"claim_number":"CLM-2026-00789"}'::jsonb, '{"found":false,"message":"I couldn''t find a claim with that number."}'::jsonb, false, 190, '2026-03-05 16:18:02-08'),
  ('60c05734-c07b-49e5-9676-c106d937406e', '94137026-9cb9-432c-a236-8fe813fb464e', 'escalate_to_human', '{"reason":"Customer disputing denied pothole damage claim.","priority":"high"}'::jsonb, '{"success":true,"reference_number":"ESC-2026-0042"}'::jsonb, true, 455, '2026-03-05 16:21:48-08')
ON CONFLICT (id) DO NOTHING;

-- ERC-8004 agent identity shown on the dashboard identity card.
INSERT INTO agent_registrations (id, agent_id, agent_card_cid, identity_registry_address, network, owner_address, registered_at, registration_tx_hash) VALUES
  ('40fa6f0d-a424-4dbb-8a3c-b5c7266ccaf6', 1247, 'bafkreielvaiidvs2ivihwbfbrqwt6cmramh2dyry7cgvre642ljr335vpq', '0x2ABdEc1d51E5BBA447ad78078CCaE01E22668BfC', 'base-sepolia', '0xcE541841cb39392E2800A403eD0271230170F963', '2026-04-01 09:00:00-07', '0x321c9a94017252c93c465905327816922cb1224af4d683c8e134c4cae507c972')
ON CONFLICT (agent_id) DO NOTHING;

-- Filecoin uploads. These are seeded demo rows: the CIDs are real content
-- addresses but nothing was published, so the claims are marked simulated.
INSERT INTO filecoin_uploads (id, claim_id, piece_cid, dataset_id, root_cid, upload_status, pdp_status, last_proven_epoch, attempted_at, completed_at) VALUES
  ('cd44d8e0-5832-4002-9703-3179f79488db', '4a3ee369-d48a-4717-8603-01f7a4257cdd', 'bafkreigpzg2qg2extzlyzbqeacewmfojfox4y564hou4cxconqbzxtki6q', '312', 'bafkreigpzg2qg2extzlyzbqeacewmfojfox4y564hou4cxconqbzxtki6q', 'completed', 'verified', 2418877, '2026-04-11 10:33:00-07', '2026-04-11 10:34:20-07'),
  ('33af5b78-d57e-411e-a084-30a3afd10b6b', '653b9f83-c876-4c66-867f-6af4eb6099a2', 'bafkreihjrbdgejlqeuwb6pqlognwzvu7vkqk67my6biuapae3gxy7sorwm', '312', 'bafkreihjrbdgejlqeuwb6pqlognwzvu7vkqk67my6biuapae3gxy7sorwm', 'completed', 'pending', NULL, '2026-04-11 10:33:00-07', '2026-04-11 10:34:20-07')
ON CONFLICT (id) DO NOTHING;

-- Evidence bundles. bundle_hash verifies against bundle_json.
INSERT INTO evidence_bundles (id, claim_id, bundle_json, bundle_hash, photo_cids, created_at) VALUES
  ('76ee01b7-b73d-4a5e-812e-69e859dc8dae', '4a3ee369-d48a-4717-8603-01f7a4257cdd', '{"claim_id":"4a3ee369-d48a-4717-8603-01f7a4257cdd","claim_number":"CLM-2026-000456","claim_type":"collision","policy_number":"POL-2024-001234","customer_id":"ceff82d7-acda-4553-9fb9-5e97c3c1e9f5","incident_date":"2026-04-10","incident_description":"Rear-ended at intersection of Market St and 5th Ave while stopped at a red light. Other driver ran the light. Moderate damage to rear bumper, trunk lid, and tail lights. No injuries reported. Police report filed (#SF-2026-04-8834).","documents":["police_report","other_driver_info"],"filed_at":"2026-04-11T17:30:00.000Z","call_log_id":"a2bd756d-3177-45ea-9609-88a64c262380"}'::jsonb, '0x9ed40da62553b990914a64dc3d4e4308d29fc578aa17fb386f466d37acf82282', ARRAY['bafkreigpzg2qg2extzlyzbqeacewmfojfox4y564hou4cxconqbzxtki6q']::TEXT[], '2026-04-11 10:34:20-07'),
  ('7e1ba9b7-04ef-46bd-bb68-eea8ebe7d5d2', '653b9f83-c876-4c66-867f-6af4eb6099a2', '{"claim_id":"653b9f83-c876-4c66-867f-6af4eb6099a2","claim_number":"CLM-2026-000321","claim_type":"windshield","policy_number":"POL-2024-002345","customer_id":"653eb0bf-9421-4d34-af61-75b636d46c8b","incident_date":"2026-04-05","incident_description":"Rock struck windshield on Highway 101 causing a large crack across the driver side. Full replacement required.","documents":["photos","repair_estimate"],"filed_at":"2026-04-06T16:00:00.000Z"}'::jsonb, '0x2542e774df13b86a4eccf022d5d2e18f35485c5e653031915d28c236c1b8ae1c', ARRAY['bafkreihjrbdgejlqeuwb6pqlognwzvu7vkqk67my6biuapae3gxy7sorwm']::TEXT[], '2026-04-11 10:34:20-07')
ON CONFLICT (id) DO NOTHING;

-- Mirror the archival state onto the claims themselves.
UPDATE claims SET
  filecoin_cid = 'bafkreigpzg2qg2extzlyzbqeacewmfojfox4y564hou4cxconqbzxtki6q',
  piece_cid = 'bafkreigpzg2qg2extzlyzbqeacewmfojfox4y564hou4cxconqbzxtki6q',
  dataset_id = '312',
  evidence_hash = '0x9ed40da62553b990914a64dc3d4e4308d29fc578aa17fb386f466d37acf82282',
  attestation_tx_hash = '0x46e6de48c3568f9243f25fa2cea600f0932d9fe149509d7f4f4425003acc3c65',
  pdp_proof_status = 'verified',
  agent_id = 1247,
  simulated = true,
  attested_at = '2026-04-11 10:35:12-07'
WHERE id = '4a3ee369-d48a-4717-8603-01f7a4257cdd';

UPDATE claims SET
  filecoin_cid = 'bafkreihjrbdgejlqeuwb6pqlognwzvu7vkqk67my6biuapae3gxy7sorwm',
  piece_cid = 'bafkreihjrbdgejlqeuwb6pqlognwzvu7vkqk67my6biuapae3gxy7sorwm',
  dataset_id = '312',
  evidence_hash = '0x2542e774df13b86a4eccf022d5d2e18f35485c5e653031915d28c236c1b8ae1c',
  attestation_tx_hash = NULL,
  pdp_proof_status = 'pending',
  agent_id = 1247,
  simulated = true,
  attested_at = NULL
WHERE id = '653b9f83-c876-4c66-867f-6af4eb6099a2';



-- ============================================
-- SOURCE: 0006_simulation_mode.sql
-- ============================================

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


-- ============================================
-- SOURCE: 0007_dashboard_read_policies.sql
-- ============================================

-- ============================================
-- Migration 0007: read-only access for the dashboard
--
-- The React dashboard reads Supabase directly from the browser for the
-- Blockchain page and for realtime claim/call subscriptions. With RLS enabled
-- and no policies, those queries return an empty set with no error, so the UI
-- renders as "no data" rather than failing visibly.
--
-- These policies grant SELECT only. No INSERT/UPDATE/DELETE policy exists, so
-- the publishable key still cannot modify anything; all writes go through the
-- backend, which uses the service role key.
--
-- SCOPE NOTE: this makes the seeded claim data readable by anyone holding the
-- publishable key, which is embedded in the client bundle and therefore public.
-- That matches the backend's existing /api/claims endpoint, which is also
-- unauthenticated. Before putting real policyholder data in this database,
-- add authentication and replace these blanket policies with per-user rules.
-- ============================================

DO $$
DECLARE
  t text;
  readable_tables text[] := ARRAY[
    'customers', 'policies', 'claims', 'call_logs', 'call_tool_executions',
    'escalations', 'scheduled_callbacks',
    'agent_registrations', 'filecoin_uploads', 'evidence_bundles'
  ];
BEGIN
  FOREACH t IN ARRAY readable_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'dashboard_read_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO anon, authenticated USING (true)',
      'dashboard_read_' || t, t
    );
  END LOOP;
END $$;

-- Realtime delivers row changes only for tables in this publication.
DO $$
DECLARE
  t text;
  realtime_tables text[] := ARRAY['claims', 'call_logs'];
BEGIN
  FOREACH t IN ARRAY realtime_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', t);
    END IF;
  END LOOP;
END $$;


-- ============================================
-- SOURCE: 0008_agent_settings.sql
-- ============================================

-- ============================================
-- Migration 0008: editable agent settings
--
-- Stores dashboard overrides for the voice agent's prompt, greeting, and which
-- tools are enabled. The backend's agent-definition.ts remains the default;
-- this table only holds what an operator has deliberately changed, so an empty
-- table means "use the shipped defaults".
--
-- Single row, id fixed at 1.
-- ============================================

CREATE TABLE IF NOT EXISTS agent_settings (
  id             SMALLINT PRIMARY KEY DEFAULT 1,
  agent_name     TEXT,
  first_message  TEXT,
  system_prompt  TEXT,
  -- Tool names the operator has switched off. Tools absent here are enabled.
  disabled_tools TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Last time these settings were pushed to ElevenLabs, if ever.
  synced_at      TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_settings_single_row CHECK (id = 1)
);

INSERT INTO agent_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Operators read the current config through the backend, which uses the service
-- role key; the dashboard reads it via the API too. No anon policy is added,
-- so the prompt is not world-readable straight out of the database.
ALTER TABLE agent_settings ENABLE ROW LEVEL SECURITY;


-- ============================================
-- SOURCE: 0009_demo_policies.sql
-- ============================================

-- ============================================
-- Migration 0009: policies reserved for live demos
--
-- The seeded book of business is full of history, which is what makes
-- lookups worth demonstrating. It leaves nowhere to show the claim
-- lifecycle from the start, though, because every policy already has
-- claims attached.
--
-- These three customers each hold one active policy and no claims, so a
-- walkthrough can begin at "file a claim" every time. Re-running this file
-- restores them, but does not delete claims filed against them.
--
-- Generated by database/build-demo-policies.mjs — do not edit by hand.
-- ============================================

INSERT INTO customers (id, full_name, email, phone, date_of_birth, address) VALUES
  ('28d17652-9946-4a26-aa31-d2021fff753e', 'Neel Kapadia', 'neel.kapadia@email.com', '+14155550110', '1992-04-11', '318 Laurel Street, San Mateo, CA 94401'),
  ('358cb70e-5e75-4de3-8315-1d82beefb1aa', 'Sara Dsouza', 'sara.dsouza@email.com', '+14155550111', '1986-09-27', '1204 Sequoia Avenue, Millbrae, CA 94030'),
  ('525d4f21-9641-4480-b420-4fa8c4784f4b', 'Imran Sheikh', 'imran.sheikh@email.com', '+14155550112', '1979-12-02', '77 Hillcrest Road, Daly City, CA 94014')
ON CONFLICT (id) DO NOTHING;

INSERT INTO policies (id, policy_number, customer_id, policy_type, provider, coverage_amount, deductible, premium_monthly, start_date, end_date, status, coverage_details) VALUES
  -- auto — the default choice for a live "file a claim" walkthrough
  ('8d0b220f-5087-433c-b13a-2fae0dcfc825', 'POL-2026-100001', '28d17652-9946-4a26-aa31-d2021fff753e', 'auto', 'SafeGuard Insurance', 55000, 1000, 192, '2026-01-05', '2029-01-05', 'active', '{"vehicle":"2025 Mazda CX-5","vin":"JM3KFBDM1S0412887","liability":"100/300/100","collision":true,"comprehensive":true,"uninsured_motorist":true,"roadside_assistance":true}'::jsonb),
  -- home — for water damage, theft, or fire walkthroughs
  ('885babbb-0f22-4739-964b-1dbb60870c69', 'POL-2026-100002', '358cb70e-5e75-4de3-8315-1d82beefb1aa', 'home', 'SafeGuard Insurance', 410000, 2000, 198, '2026-02-01', '2029-02-01', 'active', '{"property_type":"single_family","square_feet":1620,"year_built":2004,"dwelling_coverage":410000,"personal_property":205000,"liability":300000,"water_damage":true,"theft":true,"flood":false}'::jsonb),
  -- health — for medical claim walkthroughs
  ('e63f0980-2691-4bc2-be13-be11128b6241', 'POL-2026-100003', '525d4f21-9641-4480-b420-4fa8c4784f4b', 'health', 'SafeGuard Insurance', 600000, 2500, 470, '2026-01-15', '2029-01-15', 'active', '{"plan":"PPO","network":"BayCare Plus","out_of_pocket_max":8000,"prescription_coverage":true,"emergency_room":true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Reset helper. Run this to clear claims filed against the demo policies and
-- return them to a clean slate before another walkthrough.
--
--   DELETE FROM claims WHERE policy_id IN (
--     SELECT id FROM policies WHERE policy_number IN (
--       'POL-2026-100001',
--       'POL-2026-100002',
--       'POL-2026-100003'
--     )
--   );


-- ============================================
-- SOURCE: 0010_settlement.sql
-- ============================================

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


-- ============================================
-- SOURCE: 0011_extended_dataset.sql
-- ============================================

-- ============================================
-- Migration 0011: extended synthetic dataset
--
-- The seeded book of business is 12 customers, 16 policies and 12 claims.
-- That is enough to demonstrate every tool by hand, but it is a thin base
-- for the evaluation harness: the exhaustive coverage cases in
-- backend/scripts/coverage-cases.mjs generate one case per claim and per
-- policy, so the measured surface is only as wide as the dataset.
--
-- This file widens it to roughly four times the size:
--   * 20 more customers
--   * 35 more policies (16 auto, 10 home, 8 health, 1 life;
--     25 active, 5 expired, 3 cancelled, 2 pending)
--   * 50 more claims covering all seven statuses in the CHECK constraint
--     and all seven claim types the agent knows how to file
--
-- Purely additive. Nothing here updates or deletes an existing row, so the
-- twelve claims and sixteen policies cited in README.md, EVALUATION.md and
-- the test suite keep their exact values. Every id is hardcoded and every
-- statement is ON CONFLICT DO NOTHING, so re-running is a no-op.
--
-- Deliberately untouched:
--   * POL-2025-000333 / Meera Joshi — `npm run check:setup` asserts she has
--     zero claims, which is what makes the clean file_claim path testable.
--   * POL-2026-1000xx — the demo policies reserved for live walkthroughs and
--     for the file_claim cases in the evaluation harness.
--   * CLM-2026-2NNNNN — reserved for claims created at runtime.
--
-- documents_required follows getDefaultDocuments() in
-- backend/src/services/claims-service.ts exactly, so a claim filed by the
-- agent and a claim seeded here are indistinguishable in shape.
-- documents_received is always a subset of documents_required.
-- approved_amount is set only on approved and paid claims, and never exceeds
-- the coverage_amount of the policy it is filed against.
-- ============================================

-- ============================================
-- CUSTOMERS (20)
-- ============================================
INSERT INTO customers (id, full_name, email, phone, date_of_birth, address) VALUES
  ('cc110001-0000-4011-8011-000000000001', 'Aditya Rao',          'aditya.rao@email.com',          '+14155550113', '1984-02-19', '411 Ashbury Street, San Francisco, CA 94117'),
  ('cc110001-0000-4011-8011-000000000002', 'Nisha Bhatt',         'nisha.bhatt@email.com',         '+14155550114', '1990-11-05', '2287 Alameda de las Pulgas, San Mateo, CA 94403'),
  ('cc110001-0000-4011-8011-000000000003', 'Karthik Subramanian', 'karthik.subramanian@email.com', '+14155550115', '1981-06-30', '940 Sierra Vista Avenue, Mountain View, CA 94043'),
  ('cc110001-0000-4011-8011-000000000004', 'Ritu Malhotra',       'ritu.malhotra@email.com',       '+14155550116', '1994-03-08', '615 Blossom Hill Road, San Jose, CA 95123'),
  ('cc110001-0000-4011-8011-000000000005', 'Sameer Ghosh',        'sameer.ghosh@email.com',        '+14155550117', '1977-10-21', '128 Tamalpais Drive, Corte Madera, CA 94925'),
  ('cc110001-0000-4011-8011-000000000006', 'Anjali Deshmukh',     'anjali.deshmukh@email.com',     '+14155550118', '1989-05-02', '3300 Telegraph Avenue, Oakland, CA 94609'),
  ('cc110001-0000-4011-8011-000000000007', 'Harish Menon',        'harish.menon@email.com',        '+14155550119', '1975-01-17', '78 Sharon Park Drive, Menlo Park, CA 94025'),
  ('cc110001-0000-4011-8011-000000000008', 'Sneha Kulkarni',      'sneha.kulkarni@email.com',      '+14155550120', '1996-09-09', '1450 Fillmore Street, San Francisco, CA 94115'),
  ('cc110001-0000-4011-8011-000000000009', 'Vivek Chandran',      'vivek.chandran@email.com',      '+14155550121', '1983-12-14', '2109 Central Avenue, Alameda, CA 94501'),
  ('cc110001-0000-4011-8011-000000000010', 'Pooja Agarwal',       'pooja.agarwal@email.com',       '+14155550122', '1992-07-27', '501 Forest Avenue, Palo Alto, CA 94301'),
  ('cc110001-0000-4011-8011-000000000011', 'Rakesh Bhandari',     'rakesh.bhandari@email.com',     '+14155550123', '1970-04-03', '1622 Grant Road, Los Altos, CA 94024'),
  ('cc110001-0000-4011-8011-000000000012', 'Lakshmi Narayanan',   'lakshmi.narayanan@email.com',   '+14155550124', '1987-08-23', '3411 Homestead Road, Santa Clara, CA 95051'),
  ('cc110001-0000-4011-8011-000000000013', 'Tanvi Shah',          'tanvi.shah@email.com',          '+14155550125', '1998-02-11', '244 Castro Street, San Francisco, CA 94114'),
  ('cc110001-0000-4011-8011-000000000014', 'Ashok Pillai',        'ashok.pillai@email.com',        '+14155550126', '1968-11-29', '905 Marina Village Parkway, Alameda, CA 94501'),
  ('cc110001-0000-4011-8011-000000000015', 'Farah Qureshi',       'farah.qureshi@email.com',       '+14155550127', '1991-01-06', '1780 Solano Avenue, Berkeley, CA 94707'),
  ('cc110001-0000-4011-8011-000000000016', 'Nikhil Varma',        'nikhil.varma@email.com',        '+14155550128', '1986-06-16', '2740 Middlefield Road, Redwood City, CA 94063'),
  ('cc110001-0000-4011-8011-000000000017', 'Ishita Banerjee',     'ishita.banerjee@email.com',     '+14155550129', '1993-10-04', '88 Bay Street, San Francisco, CA 94133'),
  ('cc110001-0000-4011-8011-000000000018', 'Manoj Thakur',        'manoj.thakur@email.com',        '+14155550130', '1979-03-25', '1201 Bird Avenue, San Jose, CA 95125'),
  ('cc110001-0000-4011-8011-000000000019', 'Preeti Sood',         'preeti.sood@email.com',         '+14155550131', '1985-12-19', '456 Skyline Boulevard, Daly City, CA 94015'),
  ('cc110001-0000-4011-8011-000000000020', 'Gaurav Sethi',        'gaurav.sethi@email.com',        '+14155550132', '1997-05-30', '690 Chestnut Street, Menlo Park, CA 94025')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- POLICIES (35: 16 auto, 10 home, 8 health, 1 life)
-- 25 active, 5 expired, 3 cancelled, 2 pending underwriting
-- ============================================
INSERT INTO policies (id, policy_number, customer_id, policy_type, provider, coverage_amount, deductible, premium_monthly, start_date, end_date, status, coverage_details) VALUES
  -- Aditya Rao — auto + home
  ('b0110002-0000-4011-8011-000000000001', 'POL-2024-011001', 'cc110001-0000-4011-8011-000000000001', 'auto', 'SafeGuard Insurance', 48000, 1000, 178.00, '2024-02-01', '2027-02-01', 'active',
   '{"vehicle":"2023 Subaru Outback","vin":"4S4BTAFC5P3418822","liability":"100/300/100","collision":true,"comprehensive":true,"uninsured_motorist":true,"roadside_assistance":true}'::jsonb),
  ('b0110002-0000-4011-8011-000000000002', 'POL-2025-011002', 'cc110001-0000-4011-8011-000000000001', 'home', 'SafeGuard Insurance', 520000, 2500, 232.00, '2025-03-15', '2028-03-15', 'active',
   '{"property_type":"single_family","square_feet":1940,"year_built":1992,"dwelling_coverage":520000,"personal_property":260000,"liability":300000,"water_damage":true,"theft":true,"flood":false,"earthquake":true}'::jsonb),

  -- Nisha Bhatt — auto
  ('b0110002-0000-4011-8011-000000000003', 'POL-2024-011003', 'cc110001-0000-4011-8011-000000000002', 'auto', 'SafeGuard Insurance', 32000, 500, 138.00, '2024-08-01', '2027-08-01', 'active',
   '{"vehicle":"2021 Honda Civic","vin":"2HGFE2F52MH571340","liability":"50/100/50","collision":true,"comprehensive":true,"uninsured_motorist":true,"roadside_assistance":false}'::jsonb),

  -- Karthik Subramanian — auto + health
  ('b0110002-0000-4011-8011-000000000004', 'POL-2023-011004', 'cc110001-0000-4011-8011-000000000003', 'auto', 'SafeGuard Insurance', 68000, 1500, 205.00, '2023-05-01', '2027-05-01', 'active',
   '{"vehicle":"2022 BMW X3","vin":"5UX53DP08N9K12094","liability":"250/500/250","collision":true,"comprehensive":true,"uninsured_motorist":true,"roadside_assistance":true}'::jsonb),
  ('b0110002-0000-4011-8011-000000000005', 'POL-2024-011005', 'cc110001-0000-4011-8011-000000000003', 'health', 'SafeGuard Health', 550000, 2500, 465.00, '2024-01-01', '2026-12-31', 'active',
   '{"plan_type":"PPO","network":"nationwide","copay_primary":25,"copay_specialist":50,"prescription_coverage":true,"emergency_room_copay":250,"dental":false,"vision":true,"max_out_of_pocket":8000}'::jsonb),

  -- Ritu Malhotra — auto
  ('b0110002-0000-4011-8011-000000000006', 'POL-2025-011006', 'cc110001-0000-4011-8011-000000000004', 'auto', 'SafeGuard Insurance', 38000, 750, 149.00, '2025-02-10', '2028-02-10', 'active',
   '{"vehicle":"2024 Kia Seltos","vin":"KNDEUCAA3R7284119","liability":"100/300/100","collision":true,"comprehensive":true,"uninsured_motorist":true,"roadside_assistance":true}'::jsonb),

  -- Sameer Ghosh — a lapsed auto policy and the one that replaced it
  ('b0110002-0000-4011-8011-000000000007', 'POL-2022-011007', 'cc110001-0000-4011-8011-000000000005', 'auto', 'SafeGuard Insurance', 42000, 1000, 170.00, '2022-04-01', '2025-04-01', 'expired',
   '{"vehicle":"2019 Audi A4","vin":"WAUENAF48KA093771","note":"Superseded by POL-2025-011008"}'::jsonb),
  ('b0110002-0000-4011-8011-000000000008', 'POL-2025-011008', 'cc110001-0000-4011-8011-000000000005', 'auto', 'SafeGuard Insurance', 61000, 1000, 196.00, '2025-04-01', '2028-04-01', 'active',
   '{"vehicle":"2025 Volvo XC60","vin":"YV4L12RK9S1660428","liability":"250/500/250","collision":true,"comprehensive":true,"uninsured_motorist":true,"roadside_assistance":true}'::jsonb),

  -- Anjali Deshmukh — home + health
  ('b0110002-0000-4011-8011-000000000009', 'POL-2024-011009', 'cc110001-0000-4011-8011-000000000006', 'home', 'SafeGuard Insurance', 385000, 2000, 181.00, '2024-07-01', '2027-07-01', 'active',
   '{"property_type":"condo","square_feet":1080,"year_built":2008,"dwelling_coverage":385000,"personal_property":192500,"liability":250000,"theft":true,"water_damage":true,"flood":false}'::jsonb),
  ('b0110002-0000-4011-8011-000000000010', 'POL-2024-011010', 'cc110001-0000-4011-8011-000000000006', 'health', 'SafeGuard Health', 480000, 3000, 430.00, '2024-01-01', '2026-12-31', 'active',
   '{"plan_type":"HMO","network":"california","copay_primary":20,"copay_specialist":45,"prescription_coverage":true,"dental":false,"vision":true,"max_out_of_pocket":7500}'::jsonb),

  -- Harish Menon — home + auto
  ('b0110002-0000-4011-8011-000000000011', 'POL-2023-011011', 'cc110001-0000-4011-8011-000000000007', 'home', 'SafeGuard Insurance', 940000, 5000, 402.00, '2023-06-01', '2028-06-01', 'active',
   '{"property_type":"single_family","square_feet":3100,"year_built":1978,"dwelling_coverage":940000,"personal_property":470000,"liability":500000,"fire":true,"water_damage":true,"flood":false,"additional_living_expenses":75000}'::jsonb),
  ('b0110002-0000-4011-8011-000000000012', 'POL-2024-011012', 'cc110001-0000-4011-8011-000000000007', 'auto', 'SafeGuard Insurance', 72000, 1500, 228.00, '2024-09-01', '2027-09-01', 'active',
   '{"vehicle":"2024 Lexus RX 350","vin":"2T2BAMCA1RC048163","liability":"250/500/250","collision":true,"comprehensive":true,"uninsured_motorist":true,"roadside_assistance":true}'::jsonb),

  -- Sneha Kulkarni — an auto policy cancelled at her request, plus health
  ('b0110002-0000-4011-8011-000000000013', 'POL-2025-011013', 'cc110001-0000-4011-8011-000000000008', 'auto', 'SafeGuard Insurance', 29000, 500, 132.00, '2025-05-01', '2027-05-01', 'cancelled',
   '{"vehicle":"2020 Mazda3","vin":"JM1BPBLM7L1152807","cancellation_reason":"customer_request","cancelled_on":"2026-04-30","note":"Moved to a carrier bundled with renters cover"}'::jsonb),
  ('b0110002-0000-4011-8011-000000000014', 'POL-2024-011014', 'cc110001-0000-4011-8011-000000000008', 'health', 'SafeGuard Health', 400000, 2000, 385.00, '2024-03-01', '2026-12-31', 'active',
   '{"plan_type":"PPO","network":"bay_area","copay_primary":25,"copay_specialist":45,"prescription_coverage":true,"emergency_room_copay":300,"dental":true,"vision":false,"max_out_of_pocket":6500}'::jsonb),

  -- Vivek Chandran — home, plus a lapsed auto policy
  ('b0110002-0000-4011-8011-000000000015', 'POL-2023-011015', 'cc110001-0000-4011-8011-000000000009', 'home', 'SafeGuard Insurance', 610000, 3000, 275.00, '2023-10-01', '2026-10-01', 'active',
   '{"property_type":"single_family","square_feet":2150,"year_built":1961,"dwelling_coverage":610000,"personal_property":305000,"liability":300000,"fire":true,"theft":true,"flood":false}'::jsonb),
  ('b0110002-0000-4011-8011-000000000016', 'POL-2022-011016', 'cc110001-0000-4011-8011-000000000009', 'auto', 'SafeGuard Insurance', 36000, 1000, 160.00, '2022-02-15', '2025-02-15', 'expired',
   '{"vehicle":"2017 Toyota RAV4","vin":"JTMRFREV8HJ713265","note":"Not renewed; vehicle sold in 2025"}'::jsonb),

  -- Pooja Agarwal — auto + health
  ('b0110002-0000-4011-8011-000000000017', 'POL-2025-011017', 'cc110001-0000-4011-8011-000000000010', 'auto', 'SafeGuard Insurance', 44000, 750, 158.00, '2025-07-01', '2028-07-01', 'active',
   '{"vehicle":"2025 Honda CR-V","vin":"7FARS4H93SE022914","liability":"100/300/100","collision":true,"comprehensive":true,"uninsured_motorist":true,"roadside_assistance":true}'::jsonb),
  ('b0110002-0000-4011-8011-000000000018', 'POL-2024-011018', 'cc110001-0000-4011-8011-000000000010', 'health', 'SafeGuard Health', 520000, 2000, 442.00, '2024-01-01', '2026-12-31', 'active',
   '{"plan_type":"PPO","network":"nationwide","copay_primary":20,"copay_specialist":40,"prescription_coverage":true,"emergency_room_copay":250,"dental":true,"vision":true,"max_out_of_pocket":7000}'::jsonb),

  -- Rakesh Bhandari — high-value home + term life
  ('b0110002-0000-4011-8011-000000000019', 'POL-2023-011019', 'cc110001-0000-4011-8011-000000000011', 'home', 'SafeGuard Insurance', 1250000, 7500, 515.00, '2023-04-01', '2027-04-01', 'active',
   '{"property_type":"single_family","square_feet":3650,"year_built":2003,"dwelling_coverage":1250000,"personal_property":625000,"liability":750000,"fire":true,"water_damage":true,"wildfire":true,"flood":false,"additional_living_expenses":100000}'::jsonb),
  ('b0110002-0000-4011-8011-000000000020', 'POL-2024-011020', 'cc110001-0000-4011-8011-000000000011', 'life', 'SafeGuard Insurance', 750000, 0, 78.00, '2024-06-01', '2049-06-01', 'active',
   '{"term_years":25,"beneficiary":"Sunita Bhandari (spouse)","type":"term_life","accidental_death":true,"waiver_of_premium":false}'::jsonb),

  -- Lakshmi Narayanan — home, plus a health plan that ran to term
  ('b0110002-0000-4011-8011-000000000021', 'POL-2024-011021', 'cc110001-0000-4011-8011-000000000012', 'home', 'SafeGuard Insurance', 355000, 2000, 168.00, '2024-11-01', '2027-11-01', 'active',
   '{"property_type":"townhouse","square_feet":1490,"year_built":2001,"dwelling_coverage":355000,"personal_property":177500,"liability":250000,"theft":true,"water_damage":true,"sewer_and_drain_backup":true,"flood":false}'::jsonb),
  ('b0110002-0000-4011-8011-000000000022', 'POL-2023-011022', 'cc110001-0000-4011-8011-000000000012', 'health', 'SafeGuard Health', 600000, 2500, 470.00, '2023-01-01', '2025-12-31', 'expired',
   '{"plan_type":"PPO","network":"nationwide","copay_primary":25,"copay_specialist":50,"prescription_coverage":true,"dental":false,"vision":true,"max_out_of_pocket":8000,"note":"Plan year ended; member moved to an employer plan"}'::jsonb),

  -- Tanvi Shah — auto
  ('b0110002-0000-4011-8011-000000000023', 'POL-2025-011023', 'cc110001-0000-4011-8011-000000000013', 'auto', 'SafeGuard Insurance', 27000, 500, 126.00, '2025-09-01', '2027-09-01', 'active',
   '{"vehicle":"2019 Nissan Sentra","vin":"3N1AB7AP4KY335018","liability":"50/100/50","collision":true,"comprehensive":true,"uninsured_motorist":true,"roadside_assistance":false}'::jsonb),

  -- Ashok Pillai — home + health
  ('b0110002-0000-4011-8011-000000000024', 'POL-2024-011024', 'cc110001-0000-4011-8011-000000000014', 'home', 'SafeGuard Insurance', 820000, 5000, 356.00, '2024-04-01', '2027-04-01', 'active',
   '{"property_type":"single_family","square_feet":2620,"year_built":1988,"dwelling_coverage":820000,"personal_property":410000,"liability":500000,"fire":true,"water_damage":true,"flood":false,"additional_living_expenses":60000}'::jsonb),
  ('b0110002-0000-4011-8011-000000000025', 'POL-2024-011025', 'cc110001-0000-4011-8011-000000000014', 'health', 'SafeGuard Health', 700000, 1500, 540.00, '2024-01-01', '2026-12-31', 'active',
   '{"plan_type":"PPO","network":"nationwide","copay_primary":20,"copay_specialist":40,"prescription_coverage":true,"emergency_room_copay":200,"dental":true,"vision":true,"max_out_of_pocket":5500}'::jsonb),

  -- Farah Qureshi — auto, plus a condo policy cancelled for non-payment
  ('b0110002-0000-4011-8011-000000000026', 'POL-2023-011026', 'cc110001-0000-4011-8011-000000000015', 'auto', 'SafeGuard Insurance', 33000, 750, 141.00, '2023-08-01', '2027-08-01', 'active',
   '{"vehicle":"2021 Volkswagen Jetta","vin":"3VWC57BU4MM058233","liability":"100/300/100","collision":true,"comprehensive":true,"uninsured_motorist":true,"roadside_assistance":false}'::jsonb),
  ('b0110002-0000-4011-8011-000000000027', 'POL-2024-011027', 'cc110001-0000-4011-8011-000000000015', 'home', 'SafeGuard Insurance', 295000, 1500, 152.00, '2024-05-15', '2026-05-15', 'cancelled',
   '{"property_type":"condo","square_feet":960,"year_built":1997,"cancellation_reason":"non_payment","cancelled_on":"2026-02-28"}'::jsonb),

  -- Nikhil Varma — auto + health
  ('b0110002-0000-4011-8011-000000000028', 'POL-2025-011028', 'cc110001-0000-4011-8011-000000000016', 'auto', 'SafeGuard Insurance', 51000, 1000, 184.00, '2025-03-01', '2028-03-01', 'active',
   '{"vehicle":"2024 Toyota Highlander","vin":"5TDKDRBH1RS123877","liability":"100/300/100","collision":true,"comprehensive":true,"uninsured_motorist":true,"roadside_assistance":true}'::jsonb),
  ('b0110002-0000-4011-8011-000000000029', 'POL-2024-011029', 'cc110001-0000-4011-8011-000000000016', 'health', 'SafeGuard Health', 450000, 3500, 408.00, '2024-02-01', '2026-12-31', 'active',
   '{"plan_type":"HMO","network":"california","copay_primary":15,"copay_specialist":35,"prescription_coverage":true,"maternity":true,"dental":false,"vision":true,"max_out_of_pocket":7000}'::jsonb),

  -- Ishita Banerjee — a condo policy that ran out, plus a current auto policy
  ('b0110002-0000-4011-8011-000000000030', 'POL-2022-011030', 'cc110001-0000-4011-8011-000000000017', 'home', 'SafeGuard Insurance', 340000, 2000, 163.00, '2022-09-01', '2025-09-01', 'expired',
   '{"property_type":"condo","square_feet":1020,"year_built":1985,"dwelling_coverage":340000,"personal_property":170000,"liability":200000,"water_damage":true,"note":"Not renewed; unit sold in 2025"}'::jsonb),
  ('b0110002-0000-4011-8011-000000000031', 'POL-2025-011031', 'cc110001-0000-4011-8011-000000000017', 'auto', 'SafeGuard Insurance', 31000, 500, 135.00, '2025-10-01', '2028-10-01', 'active',
   '{"vehicle":"2022 Subaru Impreza","vin":"4S3GKAV60N3608471","liability":"100/300/100","collision":true,"comprehensive":true,"uninsured_motorist":true,"roadside_assistance":true}'::jsonb),

  -- Manoj Thakur — a cancelled auto policy and a health plan that ran to term
  ('b0110002-0000-4011-8011-000000000032', 'POL-2024-011032', 'cc110001-0000-4011-8011-000000000018', 'auto', 'SafeGuard Insurance', 39000, 1000, 152.00, '2024-12-01', '2027-12-01', 'cancelled',
   '{"vehicle":"2018 Ford Fusion","vin":"3FA6P0HD8JR246590","cancellation_reason":"non_payment","cancelled_on":"2026-01-31"}'::jsonb),
  ('b0110002-0000-4011-8011-000000000033', 'POL-2023-011033', 'cc110001-0000-4011-8011-000000000018', 'health', 'SafeGuard Health', 500000, 3000, 455.00, '2023-03-01', '2026-03-01', 'expired',
   '{"plan_type":"HMO","network":"california","copay_primary":25,"copay_specialist":50,"prescription_coverage":true,"dental":false,"vision":false,"max_out_of_pocket":8500}'::jsonb),

  -- Preeti Sood and Gaurav Sethi — new business still in underwriting
  ('b0110002-0000-4011-8011-000000000034', 'POL-2026-011034', 'cc110001-0000-4011-8011-000000000019', 'home', 'SafeGuard Insurance', 465000, 2500, 214.00, '2026-09-01', '2029-09-01', 'pending',
   '{"property_type":"single_family","square_feet":1720,"year_built":1996,"dwelling_coverage":465000,"personal_property":232500,"liability":300000,"underwriting_status":"awaiting_inspection","water_damage":true,"flood":false}'::jsonb),
  ('b0110002-0000-4011-8011-000000000035', 'POL-2026-011035', 'cc110001-0000-4011-8011-000000000020', 'auto', 'SafeGuard Insurance', 46000, 1000, 175.00, '2026-09-15', '2029-09-15', 'pending',
   '{"vehicle":"2026 Hyundai Ioniq 5","vin":"KM8KRDDF7TU419063","liability":"100/300/100","underwriting_status":"awaiting_driving_record","collision":true,"comprehensive":true,"uninsured_motorist":true,"roadside_assistance":true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- CLAIMS (50)
--
-- Statuses:  paid 9, documents_needed 9, under_review 8, approved 8,
--            submitted 6, denied 5, closed 5
-- Types:     medical 12, collision 10, theft 7, water_damage 7,
--            comprehensive 6, windshield 4, fire_damage 4
--
-- 40 claims sit on active policies, 6 on policies that have since expired and
-- 4 on policies that were later cancelled. The two pending policies have none,
-- which is what new business looks like.
--
-- No claim is filed against POL-2025-000333 (Meera Joshi must stay at zero)
-- or against the POL-2026-1000xx demo policies.
-- ============================================
INSERT INTO claims (id, claim_number, policy_id, customer_id, claim_type, status, incident_date, incident_description, claimed_amount, approved_amount, assigned_adjuster, documents_required, documents_received, notes, filed_at, updated_at) VALUES
  -- Aditya Rao — single-vehicle loss paid out last spring
  ('a0110003-0000-4011-8011-000000000001', 'CLM-2025-011001', 'b0110002-0000-4011-8011-000000000001', 'cc110001-0000-4011-8011-000000000001',
   'collision', 'paid', '2025-03-12',
   'Rear tire blew out on I-280 near Bunker Hill Drive and the car struck the center divider. Front left quarter panel, wheel, and lower control arm damaged. Vehicle towed from the scene; no other vehicle involved and no injuries.',
   6420.00, 5420.00, 'Deepak Gupta',
   ARRAY['police_report', 'repair_estimate', 'photos', 'other_driver_info']::TEXT[],
   ARRAY['police_report', 'repair_estimate', 'photos']::TEXT[],
   'Single-vehicle loss, so no other driver information applies. Paid 5,420 after the 1,000 deductible; direct deposit sent 2025-04-28.',
   '2025-03-13 09:20:00-07', '2025-04-28 10:05:00-07'),

  -- Aditya Rao — open water damage claim waiting on a contractor estimate
  ('a0110003-0000-4011-8011-000000000002', 'CLM-2026-011002', 'b0110002-0000-4011-8011-000000000002', 'cc110001-0000-4011-8011-000000000001',
   'water_damage', 'under_review', '2026-06-18',
   'Dishwasher supply hose split while the family was away for the weekend, soaking the kitchen subfloor and the finished basement ceiling below. A restoration company ran dehumidifiers for four days before drying was certified.',
   21500.00, NULL, 'Sanjay Verma',
   ARRAY['plumber_invoice', 'damage_photos', 'contractor_estimate']::TEXT[],
   ARRAY['plumber_invoice', 'damage_photos']::TEXT[],
   'Mitigation invoice and photos in hand. Contractor estimate for cabinetry and ceiling replacement still outstanding; adjuster site visit held 2026-06-29.',
   '2026-06-19 07:45:00-07', '2026-06-29 15:30:00-07'),

  -- Aditya Rao — routine glass claim, approved in full
  ('a0110003-0000-4011-8011-000000000003', 'CLM-2026-011003', 'b0110002-0000-4011-8011-000000000001', 'cc110001-0000-4011-8011-000000000001',
   'windshield', 'approved', '2026-05-02',
   'Gravel thrown by a truck on Highway 92 chipped the windshield, and the chip spread into an eight-inch crack across the passenger side within two days.',
   880.00, 880.00, 'Claims Auto-Process',
   ARRAY['photos', 'repair_estimate']::TEXT[],
   ARRAY['photos', 'repair_estimate']::TEXT[],
   'Glass claim approved in full. No deductible applies to glass under this policy. Mobile replacement authorized with the vendor of the customer choice.',
   '2026-05-03 11:10:00-07', '2026-05-06 09:40:00-07'),

  -- Nisha Bhatt — commercial vehicle at fault, estimate outstanding
  ('a0110003-0000-4011-8011-000000000004', 'CLM-2026-011004', 'b0110002-0000-4011-8011-000000000003', 'cc110001-0000-4011-8011-000000000002',
   'collision', 'under_review', '2026-07-21',
   'Struck on the driver side by a delivery van that turned left across her lane at Hamilton Avenue and Bascom. Both driver-side doors crumpled and the side airbag deployed. Drivers exchanged information at the scene and police attended.',
   9850.00, NULL, 'Neha Agarwal',
   ARRAY['police_report', 'repair_estimate', 'photos', 'other_driver_info']::TEXT[],
   ARRAY['police_report', 'photos', 'other_driver_info']::TEXT[],
   'Liability appears to sit with the commercial carrier for the van. Photos and police report on file; body shop estimate expected this week.',
   '2026-07-22 08:30:00-07', '2026-08-04 13:00:00-07'),

  -- Nisha Bhatt — storm damage reported the next morning
  ('a0110003-0000-4011-8011-000000000005', 'CLM-2026-011005', 'b0110002-0000-4011-8011-000000000003', 'cc110001-0000-4011-8011-000000000002',
   'comprehensive', 'submitted', '2026-08-11',
   'Tree limb fell onto the parked car during high winds on Alameda de las Pulgas, denting the roof panel and cracking the rear window. The car was drivable but the headliner is soaked.',
   3140.00, NULL, NULL,
   ARRAY['photos', 'repair_estimate', 'incident_report']::TEXT[],
   ARRAY[]::TEXT[],
   'Filed the morning after the storm. Awaiting photos and a body shop estimate before an adjuster is assigned.',
   '2026-08-12 09:05:00-07', '2026-08-12 09:05:00-07'),

  -- Karthik Subramanian — clean rear-end collision, approved
  ('a0110003-0000-4011-8011-000000000006', 'CLM-2026-011006', 'b0110002-0000-4011-8011-000000000004', 'cc110001-0000-4011-8011-000000000003',
   'collision', 'approved', '2026-04-27',
   'Low-speed rear-end collision on the Ellis Street on-ramp to 101. Rear bumper cover, parking sensors, and exhaust trim damaged. The other driver admitted fault at the scene and stayed for the police report.',
   7300.00, 5800.00, 'Neha Agarwal',
   ARRAY['police_report', 'repair_estimate', 'photos', 'other_driver_info']::TEXT[],
   ARRAY['police_report', 'repair_estimate', 'photos', 'other_driver_info']::TEXT[],
   'Approved for 5,800 after the 1,500 deductible. Subrogation opened against the carrier for the at-fault driver; deductible recovery expected.',
   '2026-04-28 10:00:00-07', '2026-05-15 14:20:00-07'),

  -- Karthik Subramanian — day surgery, paid to the facility
  ('a0110003-0000-4011-8011-000000000007', 'CLM-2026-011007', 'b0110002-0000-4011-8011-000000000005', 'cc110001-0000-4011-8011-000000000003',
   'medical', 'paid', '2026-02-09',
   'Outpatient hernia repair at Sequoia Hospital, referred by primary care after three months of symptoms. Discharged the same afternoon with a two-week follow-up.',
   12400.00, 9900.00, 'Claims Auto-Process',
   ARRAY['medical_records', 'itemized_bill', 'referral_letter']::TEXT[],
   ARRAY['medical_records', 'itemized_bill', 'referral_letter']::TEXT[],
   'Paid to the facility on 2026-03-20 at the in-network negotiated rate. Member responsibility 2,500, being the deductible plus coinsurance.',
   '2026-02-12 09:00:00-08', '2026-03-20 11:30:00-07'),

  -- Karthik Subramanian — physiotherapy course, billing outstanding
  ('a0110003-0000-4011-8011-000000000008', 'CLM-2026-011008', 'b0110002-0000-4011-8011-000000000005', 'cc110001-0000-4011-8011-000000000003',
   'medical', 'documents_needed', '2026-06-30',
   'Course of eight physiotherapy sessions for a rotator cuff tear sustained in a cycling fall on Stevens Creek Trail.',
   2960.00, NULL, 'Anita Desai',
   ARRAY['medical_records', 'itemized_bill', 'referral_letter']::TEXT[],
   ARRAY['referral_letter']::TEXT[],
   'Referral letter received. Need the itemized bill for the session block and the clinic treatment records before the claim can be adjudicated.',
   '2026-07-06 10:15:00-07', '2026-08-03 16:00:00-07'),

  -- Ritu Malhotra — catalytic converter theft, just filed
  ('a0110003-0000-4011-8011-000000000009', 'CLM-2026-011009', 'b0110002-0000-4011-8011-000000000006', 'cc110001-0000-4011-8011-000000000004',
   'theft', 'submitted', '2026-08-14',
   'Catalytic converter cut from the underside of the Seltos overnight while parked on Blossom Hill Road. Discovered when the engine started unusually loud the next morning.',
   2850.00, NULL, NULL,
   ARRAY['police_report', 'proof_of_purchase', 'photos']::TEXT[],
   ARRAY['police_report']::TEXT[],
   'Police report SJ-2026-08-2277 provided during the call. Awaiting photos of the cut pipe and the replacement quote from the dealer.',
   '2026-08-15 08:40:00-07', '2026-08-15 08:40:00-07'),

  -- Ritu Malhotra — glass claim paid straight through
  ('a0110003-0000-4011-8011-000000000010', 'CLM-2026-011010', 'b0110002-0000-4011-8011-000000000006', 'cc110001-0000-4011-8011-000000000004',
   'windshield', 'paid', '2026-03-05',
   'Windshield cracked upward from the base on a cold morning, spreading from a stone strike picked up the previous week. The glass shop recommended replacement rather than repair.',
   760.00, 760.00, 'Claims Auto-Process',
   ARRAY['photos', 'repair_estimate']::TEXT[],
   ARRAY['photos', 'repair_estimate']::TEXT[],
   'Paid directly to the glass vendor on 2026-03-19. No deductible on glass claims under this policy.',
   '2026-03-06 12:00:00-08', '2026-03-19 09:15:00-07'),

  -- Sameer Ghosh — historical claim on the policy that has since expired
  ('a0110003-0000-4011-8011-000000000011', 'CLM-2024-011011', 'b0110002-0000-4011-8011-000000000007', 'cc110001-0000-4011-8011-000000000005',
   'collision', 'closed', '2024-11-02',
   'Slid on wet leaves turning onto Tamalpais Drive and clipped a parked pickup. Minor damage to the front bumper cover and to the tailgate of the other vehicle.',
   1150.00, NULL, 'Deepak Gupta',
   ARRAY['police_report', 'repair_estimate', 'photos', 'other_driver_info']::TEXT[],
   ARRAY['police_report', 'repair_estimate', 'photos', 'other_driver_info']::TEXT[],
   'Final repair estimate came to 840, below the 1,000 deductible, so no payment was due and the file was closed at the request of the customer. Damage to the parked pickup was settled under the liability section.',
   '2024-11-04 09:30:00-08', '2024-12-02 10:00:00-08'),

  -- Sameer Ghosh — vandalism under review on the replacement policy
  ('a0110003-0000-4011-8011-000000000012', 'CLM-2026-011012', 'b0110002-0000-4011-8011-000000000008', 'cc110001-0000-4011-8011-000000000005',
   'comprehensive', 'under_review', '2026-07-04',
   'Vandalism in the Corte Madera town center garage: both flanks keyed end to end and the passenger wing mirror snapped off. Reported to the sheriff the same evening.',
   4380.00, NULL, 'Vikas Menon',
   ARRAY['photos', 'repair_estimate', 'incident_report']::TEXT[],
   ARRAY['photos', 'incident_report']::TEXT[],
   'Garage CCTV requested from the property manager. Paint and mirror estimate still to come from the preferred shop of the customer.',
   '2026-07-05 18:20:00-07', '2026-07-30 11:45:00-07'),

  -- Sameer Ghosh — fresh glass claim
  ('a0110003-0000-4011-8011-000000000013', 'CLM-2026-011013', 'b0110002-0000-4011-8011-000000000008', 'cc110001-0000-4011-8011-000000000005',
   'windshield', 'submitted', '2026-08-22',
   'Stone chip on the passenger side of the windshield picked up on Highway 101, now spreading after the hot weekend.',
   640.00, NULL, NULL,
   ARRAY['photos', 'repair_estimate']::TEXT[],
   ARRAY[]::TEXT[],
   'Filed by phone. Photographs and a written glass quote requested from the customer.',
   '2026-08-23 08:10:00-07', '2026-08-23 08:10:00-07'),

  -- Anjali Deshmukh — storage cage break-in, approved
  ('a0110003-0000-4011-8011-000000000014', 'CLM-2026-011014', 'b0110002-0000-4011-8011-000000000009', 'cc110001-0000-4011-8011-000000000006',
   'theft', 'approved', '2026-05-19',
   'Storage cage in the condo garage broken into overnight. Two bicycles and a set of camping equipment taken. The building manager confirmed the padlock had been cut and filed an incident report with the HOA.',
   5600.00, 3600.00, 'Rajiv Khanna',
   ARRAY['police_report', 'proof_of_purchase', 'photos']::TEXT[],
   ARRAY['police_report', 'proof_of_purchase', 'photos']::TEXT[],
   'Approved for 3,600 after the 2,000 deductible. Purchase receipts matched the claimed replacement values within tolerance.',
   '2026-05-20 09:00:00-07', '2026-06-09 15:20:00-07'),

  -- Anjali Deshmukh — cosmetic procedure, denied
  ('a0110003-0000-4011-8011-000000000015', 'CLM-2026-011015', 'b0110002-0000-4011-8011-000000000010', 'cc110001-0000-4011-8011-000000000006',
   'medical', 'denied', '2026-03-22',
   'Dermatology procedure billed as a medically necessary excision, performed at an out-of-plan clinic in Walnut Creek.',
   3200.00, NULL, 'Anita Desai',
   ARRAY['medical_records', 'itemized_bill', 'referral_letter']::TEXT[],
   ARRAY['medical_records', 'itemized_bill']::TEXT[],
   'Denied. The reviewing physician found no medical necessity in the submitted records, and elective cosmetic procedures are excluded under Section 7.1. Appeal window closes 2026-06-22.',
   '2026-03-24 14:00:00-07', '2026-04-08 10:30:00-07'),

  -- Anjali Deshmukh — escape of water from the unit above
  ('a0110003-0000-4011-8011-000000000016', 'CLM-2026-011016', 'b0110002-0000-4011-8011-000000000009', 'cc110001-0000-4011-8011-000000000006',
   'water_damage', 'documents_needed', '2026-08-02',
   'The water heater in the unit upstairs failed and drained through the shared wall into the master bedroom closet. Carpet, baseboards, and stored clothing were soaked before the building shut off the riser.',
   8700.00, NULL, 'Sanjay Verma',
   ARRAY['plumber_invoice', 'damage_photos', 'contractor_estimate']::TEXT[],
   ARRAY['damage_photos']::TEXT[],
   'The HOA has accepted responsibility in principle. Still need the plumber invoice from the repair upstairs and a contractor estimate for the closet rebuild.',
   '2026-08-03 10:30:00-07', '2026-08-18 09:10:00-07'),

  -- Harish Menon — major fire loss, rebuilt and paid out
  ('a0110003-0000-4011-8011-000000000017', 'CLM-2025-011017', 'b0110002-0000-4011-8011-000000000011', 'cc110001-0000-4011-8011-000000000007',
   'fire_damage', 'paid', '2025-07-14',
   'A barbecue on the rear deck ignited the cedar siding and spread to the eaves before the fire department arrived. Deck, siding, and two upstairs window frames were destroyed, with heavy smoke damage in the adjoining bedroom.',
   96500.00, 91500.00, 'Rajiv Khanna',
   ARRAY['fire_dept_report', 'contractor_estimates', 'photos']::TEXT[],
   ARRAY['fire_dept_report', 'contractor_estimates', 'photos']::TEXT[],
   'Rebuild completed by an approved contractor. Paid 91,500 in two installments after the 5,000 deductible; final payment released 2025-11-20. Temporary housing reimbursed separately under the ALE limit.',
   '2025-07-15 07:10:00-07', '2025-11-20 16:00:00-08'),

  -- Harish Menon — late report, denied
  ('a0110003-0000-4011-8011-000000000018', 'CLM-2026-011018', 'b0110002-0000-4011-8011-000000000012', 'cc110001-0000-4011-8011-000000000007',
   'collision', 'denied', '2026-01-18',
   'Damage to the front bumper and grille that the customer reported six weeks after the parking lot strike that he believes caused it.',
   5200.00, NULL, 'Deepak Gupta',
   ARRAY['police_report', 'repair_estimate', 'photos', 'other_driver_info']::TEXT[],
   ARRAY['repair_estimate', 'photos']::TEXT[],
   'Denied. The reported date of loss falls outside the 30-day reporting requirement in Section 3.4, and the damage pattern is inconsistent with the described impact. Appeal window closes 2026-06-02.',
   '2026-03-02 11:00:00-08', '2026-03-16 09:45:00-07'),

  -- Harish Menon — crawl space seepage, all documents in
  ('a0110003-0000-4011-8011-000000000019', 'CLM-2026-011019', 'b0110002-0000-4011-8011-000000000011', 'cc110001-0000-4011-8011-000000000007',
   'water_damage', 'under_review', '2026-06-05',
   'Irrigation line under the front lawn ruptured and seeped into the crawl space, saturating insulation and part of the subfloor. The leak was only discovered when the water bill tripled.',
   17300.00, NULL, 'Sanjay Verma',
   ARRAY['plumber_invoice', 'damage_photos', 'contractor_estimate']::TEXT[],
   ARRAY['plumber_invoice', 'damage_photos', 'contractor_estimate']::TEXT[],
   'All documents received. Adjuster is reviewing whether the duration of the seepage triggers the gradual damage limitation before authorizing the subfloor scope.',
   '2026-06-08 08:00:00-07', '2026-07-01 14:30:00-07'),

  -- Sneha Kulkarni — rear-ended by a rideshare driver, paid and subrogated
  ('a0110003-0000-4011-8011-000000000020', 'CLM-2025-011020', 'b0110002-0000-4011-8011-000000000013', 'cc110001-0000-4011-8011-000000000008',
   'collision', 'paid', '2025-08-09',
   'Rear-ended at a stoplight on Fillmore Street by a rideshare driver who was watching his phone. Bumper cover, impact absorber, and trunk latch replaced.',
   4260.00, 3760.00, 'Neha Agarwal',
   ARRAY['police_report', 'repair_estimate', 'photos', 'other_driver_info']::TEXT[],
   ARRAY['police_report', 'repair_estimate', 'photos', 'other_driver_info']::TEXT[],
   'Paid 3,760 after the 500 deductible on 2025-09-15. The deductible was recovered through subrogation and refunded to the customer in November.',
   '2025-08-10 09:15:00-07', '2025-11-04 10:00:00-08'),

  -- Sneha Kulkarni — emergency surgery, approved
  ('a0110003-0000-4011-8011-000000000021', 'CLM-2026-011021', 'b0110002-0000-4011-8011-000000000014', 'cc110001-0000-4011-8011-000000000008',
   'medical', 'approved', '2026-04-14',
   'Emergency appendectomy at CPMC Van Ness following an overnight admission through the emergency department, with a two-night inpatient stay.',
   28400.00, 24900.00, 'Claims Auto-Process',
   ARRAY['medical_records', 'itemized_bill', 'referral_letter']::TEXT[],
   ARRAY['medical_records', 'itemized_bill', 'referral_letter']::TEXT[],
   'Approved at the in-network negotiated rate. Member owes the 2,000 deductible plus 1,500 coinsurance; payment to the hospital is scheduled.',
   '2026-04-17 13:00:00-07', '2026-05-02 11:20:00-07'),

  -- Sneha Kulkarni — immunotherapy course just submitted
  ('a0110003-0000-4011-8011-000000000022', 'CLM-2026-011022', 'b0110002-0000-4011-8011-000000000014', 'cc110001-0000-4011-8011-000000000008',
   'medical', 'submitted', '2026-08-06',
   'Allergy immunotherapy course started after a specialist consultation for persistent seasonal reactions that no longer respond to antihistamines.',
   1850.00, NULL, NULL,
   ARRAY['medical_records', 'itemized_bill', 'referral_letter']::TEXT[],
   ARRAY[]::TEXT[],
   'Submitted through the member portal. Nothing received yet from the office of the specialist.',
   '2026-08-07 16:45:00-07', '2026-08-07 16:45:00-07'),

  -- Vivek Chandran — dryer fire, estimates outstanding
  ('a0110003-0000-4011-8011-000000000023', 'CLM-2026-011023', 'b0110002-0000-4011-8011-000000000015', 'cc110001-0000-4011-8011-000000000009',
   'fire_damage', 'documents_needed', '2026-05-30',
   'Dryer lint fire in the laundry room spread to the adjoining garage wall. The fire department cut the drywall back to the studs to check for extension into the ceiling cavity.',
   38200.00, NULL, 'Rajiv Khanna',
   ARRAY['fire_dept_report', 'contractor_estimates', 'photos']::TEXT[],
   ARRAY['fire_dept_report', 'photos']::TEXT[],
   'Cause confirmed as a blocked dryer vent, which is covered. Two contractor estimates are still needed before the scope of repair can be agreed.',
   '2026-05-31 08:20:00-07', '2026-06-22 15:00:00-07'),

  -- Vivek Chandran — animal strike on the policy that later expired
  ('a0110003-0000-4011-8011-000000000024', 'CLM-2024-011024', 'b0110002-0000-4011-8011-000000000016', 'cc110001-0000-4011-8011-000000000009',
   'comprehensive', 'closed', '2024-09-21',
   'A deer ran into the front of the RAV4 on a rural stretch of Highway 1 near Tomales Bay, breaking the headlight assembly and creasing the hood.',
   3900.00, NULL, 'Vikas Menon',
   ARRAY['photos', 'repair_estimate', 'incident_report']::TEXT[],
   ARRAY['photos', 'repair_estimate', 'incident_report']::TEXT[],
   'Customer withdrew the claim after deciding to sell the vehicle unrepaired. No payment was issued and the file was closed on 2024-10-30.',
   '2024-09-22 10:00:00-07', '2024-10-30 09:00:00-07'),

  -- Vivek Chandran — burglary while the family was away
  ('a0110003-0000-4011-8011-000000000025', 'CLM-2026-011025', 'b0110002-0000-4011-8011-000000000015', 'cc110001-0000-4011-8011-000000000009',
   'theft', 'under_review', '2026-07-27',
   'Garage side door forced while the family was away for a week. Power tools, a road bicycle, and a laptop were taken. A neighbor reported an unfamiliar van in the driveway on the Thursday evening.',
   9400.00, NULL, 'Rajiv Khanna',
   ARRAY['police_report', 'proof_of_purchase', 'photos']::TEXT[],
   ARRAY['police_report', 'proof_of_purchase', 'photos']::TEXT[],
   'All documents in. Adjuster is verifying tool serial numbers against the police report before authorizing payment.',
   '2026-07-28 09:40:00-07', '2026-08-12 14:10:00-07'),

  -- Pooja Agarwal — sideswipe reported the same evening
  ('a0110003-0000-4011-8011-000000000026', 'CLM-2026-011026', 'b0110002-0000-4011-8011-000000000017', 'cc110001-0000-4011-8011-000000000010',
   'collision', 'submitted', '2026-08-18',
   'Sideswiped on Embarcadero Road by a driver merging out of the bike lane. Passenger door and mirror damaged; both cars pulled over and exchanged details.',
   4700.00, NULL, NULL,
   ARRAY['police_report', 'repair_estimate', 'photos', 'other_driver_info']::TEXT[],
   ARRAY['other_driver_info']::TEXT[],
   'Reported the same evening. Police were not called to the scene, so a counter report will be needed. Customer has the other driver details and will send photos.',
   '2026-08-19 07:55:00-07', '2026-08-19 07:55:00-07'),

  -- Pooja Agarwal — imaging claim awaiting network pricing
  ('a0110003-0000-4011-8011-000000000027', 'CLM-2026-011027', 'b0110002-0000-4011-8011-000000000018', 'cc110001-0000-4011-8011-000000000010',
   'medical', 'under_review', '2026-06-11',
   'MRI and follow-up consultation for persistent lower back pain after a fall on the stairs at home.',
   4300.00, NULL, 'Anita Desai',
   ARRAY['medical_records', 'itemized_bill', 'referral_letter']::TEXT[],
   ARRAY['medical_records', 'itemized_bill', 'referral_letter']::TEXT[],
   'Documents complete. Awaiting network pricing confirmation from the imaging center before adjudication.',
   '2026-06-15 10:00:00-07', '2026-07-07 09:30:00-07'),

  -- Pooja Agarwal — urgent care visit below the deductible
  ('a0110003-0000-4011-8011-000000000028', 'CLM-2025-011028', 'b0110002-0000-4011-8011-000000000018', 'cc110001-0000-4011-8011-000000000010',
   'medical', 'closed', '2025-12-03',
   'Urgent care visit for a suspected wrist fracture that X-rays showed to be a sprain. Splinted and discharged the same evening.',
   640.00, NULL, 'Claims Auto-Process',
   ARRAY['medical_records', 'itemized_bill', 'referral_letter']::TEXT[],
   ARRAY['medical_records', 'itemized_bill']::TEXT[],
   'Total billed charges fell below the remaining deductible for the plan year, so no benefit was payable. File closed and an explanation of benefits was sent to the member.',
   '2025-12-05 11:00:00-08', '2025-12-19 10:00:00-08'),

  -- Rakesh Bhandari — burst pipe, approved
  ('a0110003-0000-4011-8011-000000000029', 'CLM-2026-011029', 'b0110002-0000-4011-8011-000000000019', 'cc110001-0000-4011-8011-000000000011',
   'water_damage', 'approved', '2026-04-08',
   'Copper pipe in the upstairs bathroom wall corroded through and ran for several hours before anyone was home, bringing down part of the dining room ceiling and soaking the hardwood below.',
   46800.00, 39300.00, 'Sanjay Verma',
   ARRAY['plumber_invoice', 'damage_photos', 'contractor_estimate']::TEXT[],
   ARRAY['plumber_invoice', 'damage_photos', 'contractor_estimate']::TEXT[],
   'Approved for 39,300 after the 7,500 deductible. Contents cleaning is handled under the personal property limit; payment scheduled to the restoration contractor.',
   '2026-04-09 07:30:00-07', '2026-05-01 16:15:00-07'),

  -- Rakesh Bhandari — hillside grass fire, just reported
  ('a0110003-0000-4011-8011-000000000030', 'CLM-2026-011030', 'b0110002-0000-4011-8011-000000000019', 'cc110001-0000-4011-8011-000000000011',
   'fire_damage', 'submitted', '2026-08-20',
   'A grass fire on the hillside behind the property scorched the rear fence line and the garden shed before crews contained it. The main structure was not damaged.',
   12500.00, NULL, NULL,
   ARRAY['fire_dept_report', 'contractor_estimates', 'photos']::TEXT[],
   ARRAY[]::TEXT[],
   'Reported the morning after containment. The incident report has been requested from Santa Clara County Fire; fence and shed estimates to follow.',
   '2026-08-21 08:00:00-07', '2026-08-21 08:00:00-07'),

  -- Lakshmi Narayanan — drain backup, covered by endorsement and paid
  ('a0110003-0000-4011-8011-000000000031', 'CLM-2026-011031', 'b0110002-0000-4011-8011-000000000021', 'cc110001-0000-4011-8011-000000000012',
   'water_damage', 'paid', '2026-02-16',
   'The storm drain serving the row of townhouses backed up during the February rains and pushed water under the garage door seal into the ground floor storage room.',
   9100.00, 7100.00, 'Sanjay Verma',
   ARRAY['plumber_invoice', 'damage_photos', 'contractor_estimate']::TEXT[],
   ARRAY['plumber_invoice', 'damage_photos', 'contractor_estimate']::TEXT[],
   'Approved and paid on 2026-03-27. Backup of sewer and drain is covered by the endorsement on this policy; 7,100 paid after the 2,000 deductible.',
   '2026-02-17 09:00:00-08', '2026-03-27 10:30:00-07'),

  -- Lakshmi Narayanan — cataract surgery on the plan that has since expired
  ('a0110003-0000-4011-8011-000000000032', 'CLM-2025-011032', 'b0110002-0000-4011-8011-000000000022', 'cc110001-0000-4011-8011-000000000012',
   'medical', 'paid', '2025-05-08',
   'Cataract surgery on the right eye, performed as a day case at an ambulatory center after an ophthalmologist referral.',
   7600.00, 6100.00, 'Claims Auto-Process',
   ARRAY['medical_records', 'itemized_bill', 'referral_letter']::TEXT[],
   ARRAY['medical_records', 'itemized_bill', 'referral_letter']::TEXT[],
   'Paid to the surgical center on 2025-06-18. Member responsibility 1,500 against the plan deductible.',
   '2025-05-12 09:30:00-07', '2025-06-18 14:00:00-07'),

  -- Lakshmi Narayanan — out-of-network therapy without a referral, denied
  ('a0110003-0000-4011-8011-000000000033', 'CLM-2025-011033', 'b0110002-0000-4011-8011-000000000022', 'cc110001-0000-4011-8011-000000000012',
   'medical', 'denied', '2025-09-14',
   'Out-of-network chiropractic sessions billed over six weeks for neck pain, arranged by the member directly with the clinic.',
   2200.00, NULL, 'Anita Desai',
   ARRAY['medical_records', 'itemized_bill', 'referral_letter']::TEXT[],
   ARRAY['itemized_bill']::TEXT[],
   'Denied. The plan requires a written primary care referral for out-of-network therapy and none was supplied within the 60-day window. Section 5.3 applies.',
   '2025-09-30 11:00:00-07', '2025-11-06 10:15:00-08'),

  -- Lakshmi Narayanan — porch parcel theft, receipts outstanding
  ('a0110003-0000-4011-8011-000000000034', 'CLM-2026-011034', 'b0110002-0000-4011-8011-000000000021', 'cc110001-0000-4011-8011-000000000012',
   'theft', 'documents_needed', '2026-06-24',
   'Parcel containing a replacement laptop battery and two cameras taken from the front step. The delivery photograph shows the parcel at the door at 1:12 PM and it was gone by 4 PM.',
   2450.00, NULL, 'Rajiv Khanna',
   ARRAY['police_report', 'proof_of_purchase', 'photos']::TEXT[],
   ARRAY['police_report']::TEXT[],
   'Police report filed the same day. Still need the purchase receipts for the cameras and photographs of the delivery point before the claim can proceed.',
   '2026-06-25 08:20:00-07', '2026-07-15 11:00:00-07'),

  -- Tanvi Shah — struck while stationary, approved
  ('a0110003-0000-4011-8011-000000000035', 'CLM-2026-011035', 'b0110002-0000-4011-8011-000000000023', 'cc110001-0000-4011-8011-000000000013',
   'collision', 'approved', '2026-05-11',
   'Hit while stationary in traffic on Castro Street by a driver who misjudged the gap pulling out of a parking space. Rear quarter panel and tail light replaced.',
   3980.00, 3480.00, 'Neha Agarwal',
   ARRAY['police_report', 'repair_estimate', 'photos', 'other_driver_info']::TEXT[],
   ARRAY['police_report', 'repair_estimate', 'photos', 'other_driver_info']::TEXT[],
   'Approved for 3,480 after the 500 deductible. The carrier for the at-fault driver has accepted liability, so the deductible will be recovered.',
   '2026-05-12 10:20:00-07', '2026-06-01 13:00:00-07'),

  -- Tanvi Shah — glass claim waiting on a written quote
  ('a0110003-0000-4011-8011-000000000036', 'CLM-2026-011036', 'b0110002-0000-4011-8011-000000000023', 'cc110001-0000-4011-8011-000000000013',
   'windshield', 'documents_needed', '2026-08-09',
   'Windshield struck by debris on the Bay Bridge approach, leaving a spider crack directly in the line of sight of the driver.',
   690.00, NULL, 'Claims Auto-Process',
   ARRAY['photos', 'repair_estimate']::TEXT[],
   ARRAY['photos']::TEXT[],
   'Photos received and the crack is clearly in the critical viewing area. Need a written replacement quote from an approved glass vendor before authorization.',
   '2026-08-10 09:00:00-07', '2026-08-19 10:30:00-07'),

  -- Ashok Pillai — garage electrical fire, scoping in progress
  ('a0110003-0000-4011-8011-000000000037', 'CLM-2026-011037', 'b0110002-0000-4011-8011-000000000024', 'cc110001-0000-4011-8011-000000000014',
   'fire_damage', 'under_review', '2026-07-02',
   'An electrical fault in the garage subpanel started a fire that damaged the panel, the adjacent wall, and a stored chest freezer. Crews ventilated the garage roof to clear smoke.',
   61000.00, NULL, 'Rajiv Khanna',
   ARRAY['fire_dept_report', 'contractor_estimates', 'photos']::TEXT[],
   ARRAY['fire_dept_report', 'contractor_estimates', 'photos']::TEXT[],
   'The fire marshal attributed the cause to an over-tightened neutral bar. Estimates received; the adjuster is scoping the roof ventilation damage separately from the electrical rebuild.',
   '2026-07-03 07:45:00-07', '2026-08-05 15:00:00-07'),

  -- Ashok Pillai — cardiac procedure, approved
  ('a0110003-0000-4011-8011-000000000038', 'CLM-2026-011038', 'b0110002-0000-4011-8011-000000000025', 'cc110001-0000-4011-8011-000000000014',
   'medical', 'approved', '2026-03-02',
   'Coronary stent placement following an abnormal stress test, with one night in the cardiac care unit and a cardiac rehabilitation referral on discharge.',
   54200.00, 51200.00, 'Claims Auto-Process',
   ARRAY['medical_records', 'itemized_bill', 'referral_letter']::TEXT[],
   ARRAY['medical_records', 'itemized_bill', 'referral_letter']::TEXT[],
   'Approved at the negotiated in-network rate. The 1,500 deductible plus coinsurance is the share of the member; the balance is scheduled to the hospital.',
   '2026-03-05 09:00:00-08', '2026-03-25 11:40:00-07'),

  -- Ashok Pillai — roof leak excluded as wear, closed without payment
  ('a0110003-0000-4011-8011-000000000039', 'CLM-2025-011039', 'b0110002-0000-4011-8011-000000000024', 'cc110001-0000-4011-8011-000000000014',
   'water_damage', 'closed', '2025-10-17',
   'Rainwater entered through a lifted roof shingle above the guest bedroom during the first storm of the season, staining the ceiling and the top of the wall.',
   4200.00, NULL, 'Sanjay Verma',
   ARRAY['plumber_invoice', 'damage_photos', 'contractor_estimate']::TEXT[],
   ARRAY['damage_photos', 'contractor_estimate']::TEXT[],
   'The roofer report found the shingle had lifted through age-related wear, which falls under the maintenance exclusion in Section 6.2. Closed with no payment after the customer accepted the finding.',
   '2025-10-19 10:00:00-07', '2025-11-25 09:30:00-08'),

  -- Farah Qureshi — flood water in the cabin, approved
  ('a0110003-0000-4011-8011-000000000040', 'CLM-2026-011040', 'b0110002-0000-4011-8011-000000000026', 'cc110001-0000-4011-8011-000000000015',
   'comprehensive', 'approved', '2026-06-02',
   'Flash flooding on Solano Avenue during a summer downpour left standing water above the door sills. The interior carpets and the driver seat electronics were soaked.',
   6800.00, 6050.00, 'Vikas Menon',
   ARRAY['photos', 'repair_estimate', 'incident_report']::TEXT[],
   ARRAY['photos', 'repair_estimate', 'incident_report']::TEXT[],
   'Approved for 6,050 after the 750 deductible. Seat module replacement authorized at a certified automotive electrical shop rather than the dealer.',
   '2026-06-03 09:15:00-07', '2026-06-24 14:45:00-07'),

  -- Farah Qureshi — mysterious disappearance on the cancelled condo policy
  ('a0110003-0000-4011-8011-000000000041', 'CLM-2025-011041', 'b0110002-0000-4011-8011-000000000027', 'cc110001-0000-4011-8011-000000000015',
   'theft', 'denied', '2025-11-08',
   'Jewelry reported missing from the condo after a house move, with no sign of forced entry and no witnesses.',
   7500.00, NULL, 'Deepak Gupta',
   ARRAY['police_report', 'proof_of_purchase', 'photos']::TEXT[],
   ARRAY['police_report']::TEXT[],
   'Denied. Mysterious disappearance without evidence of forced entry is excluded under Section 5.6, and no proof of ownership was supplied. The appeal window closed on 2026-02-10.',
   '2025-11-12 13:00:00-08', '2025-12-15 10:00:00-08'),

  -- Nikhil Varma — collision waiting on three of four documents
  ('a0110003-0000-4011-8011-000000000042', 'CLM-2026-011042', 'b0110002-0000-4011-8011-000000000028', 'cc110001-0000-4011-8011-000000000016',
   'collision', 'documents_needed', '2026-07-12',
   'Collided with a car that pulled out of a driveway on Middlefield Road. Front bumper, radiator support, and one headlight damaged; the vehicle was driven home but the coolant temperature ran high on the way.',
   11200.00, NULL, 'Neha Agarwal',
   ARRAY['police_report', 'repair_estimate', 'photos', 'other_driver_info']::TEXT[],
   ARRAY['photos']::TEXT[],
   'Photos received. Still need the police report, the repair estimate, and the insurance details of the other driver before the file can move to review.',
   '2026-07-13 08:50:00-07', '2026-08-06 10:20:00-07'),

  -- Nikhil Varma — observation stay, billing outstanding
  ('a0110003-0000-4011-8011-000000000043', 'CLM-2026-011043', 'b0110002-0000-4011-8011-000000000029', 'cc110001-0000-4011-8011-000000000016',
   'medical', 'documents_needed', '2026-05-21',
   'Two-day observation stay for gestational hypertension, followed by weekly monitoring appointments through the second trimester.',
   15600.00, NULL, 'Anita Desai',
   ARRAY['medical_records', 'itemized_bill', 'referral_letter']::TEXT[],
   ARRAY['medical_records']::TEXT[],
   'Hospital records received. The itemized bill and the referral letter from the obstetrician are still outstanding.',
   '2026-05-26 09:00:00-07', '2026-06-30 15:45:00-07'),

  -- Nikhil Varma — reported stolen, recovered two days later
  ('a0110003-0000-4011-8011-000000000044', 'CLM-2026-011044', 'b0110002-0000-4011-8011-000000000028', 'cc110001-0000-4011-8011-000000000016',
   'theft', 'closed', '2026-02-28',
   'Vehicle reported stolen from a hotel parking structure in Redwood City overnight after the customer could not find it in the morning.',
   51000.00, NULL, 'Vikas Menon',
   ARRAY['police_report', 'proof_of_purchase', 'photos']::TEXT[],
   ARRAY['police_report', 'photos']::TEXT[],
   'The vehicle was recovered undamaged two days later. It had been towed from a restricted bay rather than stolen, so the claim was closed with no payment and the towing fee was handled outside the policy.',
   '2026-03-01 07:30:00-08', '2026-03-06 12:00:00-08'),

  -- Ishita Banerjee — riser leak on the condo policy that has since expired
  ('a0110003-0000-4011-8011-000000000045', 'CLM-2025-011045', 'b0110002-0000-4011-8011-000000000030', 'cc110001-0000-4011-8011-000000000017',
   'water_damage', 'paid', '2025-03-19',
   'The shared riser pipe in the condo stack leaked behind the kitchen wall for several days, damaging cabinetry, the backsplash, and the ceiling of the unit below.',
   13400.00, 11400.00, 'Sanjay Verma',
   ARRAY['plumber_invoice', 'damage_photos', 'contractor_estimate']::TEXT[],
   ARRAY['plumber_invoice', 'damage_photos', 'contractor_estimate']::TEXT[],
   'Approved and paid on 2025-05-06. The HOA master policy covered the riser repair itself; this claim covered the interior finishes only, paid at 11,400 after the 2,000 deductible.',
   '2025-03-20 08:40:00-07', '2025-05-06 11:00:00-07'),

  -- Ishita Banerjee — smash and grab, estimate outstanding
  ('a0110003-0000-4011-8011-000000000046', 'CLM-2026-011046', 'b0110002-0000-4011-8011-000000000031', 'cc110001-0000-4011-8011-000000000017',
   'comprehensive', 'under_review', '2026-08-01',
   'Rear window smashed and the glovebox emptied while the car was parked overnight near Bay Street. Nothing of value was taken but the interior trim and the rear speaker grille were damaged.',
   2380.00, NULL, 'Vikas Menon',
   ARRAY['photos', 'repair_estimate', 'incident_report']::TEXT[],
   ARRAY['photos', 'incident_report']::TEXT[],
   'Police incident number SF-2026-08-1194 on file. Awaiting the glass and trim estimate before authorizing repair.',
   '2026-08-02 09:30:00-07', '2026-08-14 10:00:00-07'),

  -- Manoj Thakur — hail damage paid before the policy lapsed
  ('a0110003-0000-4011-8011-000000000047', 'CLM-2025-011047', 'b0110002-0000-4011-8011-000000000032', 'cc110001-0000-4011-8011-000000000018',
   'comprehensive', 'paid', '2025-05-23',
   'A late spring hailstorm dimpled the roof and hood while the car was parked at the Bird Avenue office lot. Paintless dent repair was recommended over panel replacement.',
   5300.00, 4300.00, 'Vikas Menon',
   ARRAY['photos', 'repair_estimate', 'incident_report']::TEXT[],
   ARRAY['photos', 'repair_estimate', 'incident_report']::TEXT[],
   'Paid 4,300 after the 1,000 deductible on 2025-07-08. Paintless dent repair completed at a certified shop and verified by photographs.',
   '2025-05-26 09:00:00-07', '2025-07-08 14:30:00-07'),

  -- Manoj Thakur — screening panel outside the benefit schedule, denied
  ('a0110003-0000-4011-8011-000000000048', 'CLM-2025-011048', 'b0110002-0000-4011-8011-000000000033', 'cc110001-0000-4011-8011-000000000018',
   'medical', 'denied', '2025-08-19',
   'Elective genetic screening panel ordered directly by the member through an online provider, without an in-network physician involved.',
   1900.00, NULL, 'Anita Desai',
   ARRAY['medical_records', 'itemized_bill', 'referral_letter']::TEXT[],
   ARRAY['itemized_bill']::TEXT[],
   'Denied. Predictive genetic screening without a documented clinical indication is not in the benefit schedule for this plan. Section 8.2 applies; the appeal window closed 2025-11-19.',
   '2025-08-22 11:00:00-07', '2025-09-30 10:00:00-07'),

  -- Manoj Thakur — collision left open after the policy was cancelled
  ('a0110003-0000-4011-8011-000000000049', 'CLM-2026-011049', 'b0110002-0000-4011-8011-000000000032', 'cc110001-0000-4011-8011-000000000018',
   'collision', 'documents_needed', '2026-01-05',
   'Struck a concrete bollard reversing out of a tight space at the Bird Avenue lot, damaging the rear bumper, the tailgate trim, and one reversing sensor.',
   2740.00, NULL, 'Deepak Gupta',
   ARRAY['police_report', 'repair_estimate', 'photos', 'other_driver_info']::TEXT[],
   ARRAY['photos']::TEXT[],
   'The incident occurred while the policy was still in force, so the claim remains valid. The customer has not responded to three document requests since the policy was cancelled for non-payment; the file will be closed if nothing is received by 2026-09-30.',
   '2026-01-07 10:40:00-08', '2026-06-15 09:00:00-07'),

  -- Ishita Banerjee — theft from the vehicle, receipts outstanding
  ('a0110003-0000-4011-8011-000000000050', 'CLM-2026-011050', 'b0110002-0000-4011-8011-000000000031', 'cc110001-0000-4011-8011-000000000017',
   'theft', 'documents_needed', '2026-07-19',
   'Roof box prised off the crossbars in the Bay Street garage overnight, taking a pair of skis and a camera bag with it.',
   3650.00, NULL, 'Rajiv Khanna',
   ARRAY['police_report', 'proof_of_purchase', 'photos']::TEXT[],
   ARRAY['police_report', 'photos']::TEXT[],
   'Police report and photographs of the damaged crossbars received. Proof of purchase for the skis and the camera bag is still needed before valuation.',
   '2026-07-20 08:15:00-07', '2026-08-10 11:30:00-07')
ON CONFLICT (id) DO NOTHING;


-- ============================================
-- SOURCE: 0012_policy_renewals.sql
-- ============================================

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


-- ============================================
-- SOURCE: 0013_claim_documents.sql
-- ============================================

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


-- ============================================
-- SOURCE: 0015_escalations_without_call.sql
-- ============================================

-- ============================================
-- Migration 0015: escalations that did not happen during a call
--
-- Two defects in one table, both of them about records that do not describe
-- anything real.
--
-- 1. escalations.call_log_id was NOT NULL, but the escalation tool is invoked
--    without any call context. The service satisfied the constraint by
--    inserting a synthetic call_logs row — direction 'inbound', status
--    'in_progress', no ended_at — for every escalation. Those rows are calls
--    that never happened: they sat in Call History forever and counted
--    permanently towards analytics.calls_by_status.in_progress. Making the
--    column nullable lets an escalation raised outside a call simply have no
--    call attached, which is what is true.
--
-- 2. The reference number the agent reads aloud to the caller existed only
--    inside the free-text `notes` string, so the thing a distressed caller was
--    told to quote could not be looked up by anyone. It gets a column and a
--    unique constraint, and the service generates it from a CSPRNG over a
--    100M-value space rather than Math.random() over 10,000.
--
-- Additive and idempotent. Safe to re-run.
--
-- Note on the phantom rows already in call_logs: this migration does not
-- delete them. Deleting call records is exactly the kind of unreviewed write
-- that put them there, so the cleanup is left to be run deliberately — the
-- statement is at the bottom of this file, commented out.
-- ============================================

-- --- 1. An escalation need not belong to a call -----------------------------

ALTER TABLE escalations
  ALTER COLUMN call_log_id DROP NOT NULL;

COMMENT ON COLUMN escalations.call_log_id IS
  'The call this escalation was raised during, or NULL when it was raised outside one. Never fabricate a call_logs row to fill this in — a synthetic call inflates the in-progress call count forever.';

-- --- 2. The reference number is a column, not prose -------------------------

ALTER TABLE escalations
  ADD COLUMN IF NOT EXISTS reference_number TEXT;

COMMENT ON COLUMN escalations.reference_number IS
  'The reference read aloud to the caller, e.g. ESC-2026-04817263. Unique, so the number the agent promises is the number a supervisor can find. NULL only on rows written before this migration, whose reference survives only in notes.';

-- Shape check, so a reference that cannot be read back over the phone in the
-- canonical PREFIX-YEAR-SERIAL form cannot be stored. NULL is allowed for the
-- historical rows; every new row carries one.
ALTER TABLE escalations
  DROP CONSTRAINT IF EXISTS escalations_reference_number_format;
ALTER TABLE escalations
  ADD CONSTRAINT escalations_reference_number_format
  CHECK (reference_number IS NULL OR reference_number ~ '^ESC-[0-9]{4}-[0-9]{8}$');

-- The database-level half of the uniqueness guarantee. A partial index so the
-- pre-migration rows, which have no reference at all, do not collide with each
-- other. The service retries on this constraint firing rather than treating a
-- collision as an outage.
CREATE UNIQUE INDEX IF NOT EXISTS idx_escalations_reference_number
  ON escalations(reference_number)
  WHERE reference_number IS NOT NULL;

-- The supervisor queue is read newest-first and filtered by status.
CREATE INDEX IF NOT EXISTS idx_escalations_status_created
  ON escalations(status, created_at DESC);

-- --- Cleanup of the fabricated call_logs rows (deliberate, not automatic) ----
--
-- Every escalation-era phantom has the same signature: an inbound call with no
-- ended_at, no duration, no transcript, no summary, no ElevenLabs conversation
-- id, and no customer. Inspect before deleting — a genuinely live call at the
-- moment you run this matches the same shape.
--
--   SELECT c.id, c.started_at
--     FROM call_logs c
--    WHERE c.status = 'in_progress'
--      AND c.ended_at IS NULL
--      AND c.customer_id IS NULL
--      AND c.transcript IS NULL
--      AND c.summary IS NULL
--      AND c.elevenlabs_conversation_id IS NULL
--      AND c.started_at < now() - interval '1 hour'
--      AND NOT EXISTS (SELECT 1 FROM call_tool_executions t WHERE t.call_log_id = c.id);
--
-- Then, having checked the list, detach any escalations pointing at them (now
-- possible, because the column is nullable) and delete:
--
--   UPDATE escalations SET call_log_id = NULL WHERE call_log_id IN (<ids>);
--   DELETE FROM call_logs WHERE id IN (<ids>);


-- ============================================
-- SOURCE: 0016_rls_for_new_tables.sql
-- ============================================

-- ============================================
-- Migration 0016: row-level security for policy_renewals and claim_documents
--
-- 0007 enabled RLS on the ten tables that existed then. policy_renewals (0012)
-- and claim_documents (0013) arrived afterwards and were never added, so both
-- shipped with RLS off. In Supabase that is not "no policies, no access" — a
-- table without RLS is fully readable AND writable through PostgREST by the
-- anon key, and that key is embedded in the shipped frontend bundle. Anyone
-- with the dashboard URL could read every renewal payment link, its short_url
-- and amount, and every document content hash — and insert or delete rows.
--
-- WHY NO ANON SELECT POLICY HERE:
-- 0007 granted anon SELECT because the dashboard queries those tables directly
-- from the browser (the Blockchain page and the realtime claim/call
-- subscriptions). Neither of these two tables is read that way: the only
-- client-side Supabase reads in the frontend are `claims` (Blockchain.tsx,
-- useRealtimeClaims.ts), and every access to policy_renewals and
-- claim_documents goes through the backend, which holds the service role key
-- and bypasses RLS entirely (renewal-service.ts, claim-documents-service.ts,
-- evidence-pipeline.ts, webhook-tools.ts). Granting anon SELECT would publish
-- payment links and document hashes to buy nothing.
--
-- So these follow agent_settings (0008), not 0007: RLS on, no policy at all.
-- With RLS enabled and zero policies the anon and authenticated roles get
-- nothing — no SELECT, no INSERT, no UPDATE, no DELETE — while the service
-- role continues to work unchanged. If the dashboard ever needs to render
-- renewals or documents in the browser, add a scoped SELECT policy then, and
-- weigh publishing short_url and content_hash before you do.
--
-- Additive and idempotent. Safe to re-run.
-- ============================================

DO $$
DECLARE
  t text;
  -- RLS on, deliberately no anon/authenticated policy. See header.
  protected_tables text[] := ARRAY['policy_renewals', 'claim_documents'];
BEGIN
  FOREACH t IN ARRAY protected_tables LOOP
    IF EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);

      -- Defensive: if an earlier hand-run of this file, or a copy of 0007's
      -- loop, ever created a blanket read policy on these tables, drop it.
      -- Leaving one behind would silently undo the whole point of this
      -- migration, and re-running must converge on "no policy".
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'dashboard_read_' || t, t);
    END IF;
  END LOOP;
END $$;

-- Neither table is streamed to the browser, so neither is added to the
-- supabase_realtime publication. Publication membership is not gated by RLS in
-- the way table reads are; adding them would be a second, separate exposure.


-- ============================================
-- SOURCE: 0017_adjudications.sql
-- ============================================

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


-- ============================================
-- SOURCE: 0018_deductible_payments.sql
-- ============================================

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


-- ============================================
-- SOURCE: 0019_adjudication_reviews.sql
-- ============================================

-- ============================================
-- Migration 0019: the human decision
--
-- 0017 records what the AI recommended, and is careful to say, in its header
-- and in its constraints, that a recommendation is not a decision. It leaves
-- claims.status alone. That was the right call and it left a hole: there was
-- nowhere for the human's answer to go, and so no way to tell a claim nobody
-- had looked at from a claim somebody had read and waved through.
--
-- This table is that answer. One row per adjudication, written only when a
-- person with the admin token presses Approve or Reject on the review queue.
--
-- What it holds and why:
--   * WHO decided and WHEN — the two things an audit of an AI-assisted process
--     is actually asked for. Neither is inferable from anywhere else.
--   * The verdict the AI recommended AT THE TIME, snapshotted. Adjudications
--     are re-runnable; a later run must not be able to rewrite what the
--     reviewer was looking at when they decided. Stored here, an override
--     ("the model said escalate, the reviewer approved") stays legible forever.
--   * The claim status before and after. The status write is a separate
--     statement from this insert and can fail on its own. claim_status_after
--     NULL therefore means something real — the decision was recorded and the
--     claim was not moved — and the queue renders that rather than hiding it.
--
-- Additive and idempotent. Safe to re-run.
-- ============================================

CREATE TABLE IF NOT EXISTS adjudication_reviews (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- UNIQUE: one adjudication gets one decision. A double-clicked Approve
  -- button must not be able to write a second, and a reviewer who wants a
  -- different answer needs a fresh adjudication, not a quiet overwrite.
  adjudication_id     UUID NOT NULL UNIQUE REFERENCES adjudications(id) ON DELETE CASCADE,

  claim_id            UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  -- Denormalised for the same reason 0017 denormalises it: an audit row must
  -- stay readable after the claim it refers to has been renumbered or removed.
  claim_number        TEXT NOT NULL,

  -- What the human did. Deliberately NOT the same vocabulary as
  -- adjudications.verdict: a verdict is a recommendation, a decision is a
  -- decision, and using one word for both is how the distinction erodes.
  decision            TEXT NOT NULL,          -- 'approved' | 'rejected'

  -- Who. Free text supplied by the caller holding the admin token; this system
  -- has no user accounts, so this is an attribution, not an authentication.
  -- The token is what authorises; this records who says they used it.
  reviewer            TEXT NOT NULL,
  note                TEXT,

  -- The recommendation as it stood when the button was pressed.
  recommended_verdict TEXT NOT NULL,
  -- Whether the model was consulted at all for that recommendation, snapshotted
  -- so "a human overrode a rule veto" can be told from "a human overrode a
  -- model" without re-reading the adjudication row.
  model_invoked       BOOLEAN NOT NULL DEFAULT false,

  claim_status_before TEXT,
  -- NULL means the claim status was not changed: the write failed, or the
  -- claim was already paid or closed and this queue refused to move it.
  claim_status_after  TEXT,

  decided_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE adjudication_reviews IS
  'The human decision on one AI adjudication. Written only by the admin-token-guarded review endpoint. One row per adjudication, enforced by a unique constraint.';

COMMENT ON COLUMN adjudication_reviews.reviewer IS
  'Who says they decided. The admin token authorises the write; this column attributes it. There are no user accounts in this system, so it is not proof of identity and must never be presented as one.';

COMMENT ON COLUMN adjudication_reviews.recommended_verdict IS
  'adjudications.verdict as it stood when the decision was made, snapshotted so a later re-run cannot rewrite what the reviewer was looking at.';

COMMENT ON COLUMN adjudication_reviews.claim_status_after IS
  'NULL means the claim status was NOT changed by this decision — the update failed, or the claim was already paid/closed. A NULL here is a fact to render, not a gap to hide.';

ALTER TABLE adjudication_reviews
  DROP CONSTRAINT IF EXISTS adjudication_reviews_decision_check;
ALTER TABLE adjudication_reviews
  ADD CONSTRAINT adjudication_reviews_decision_check
  CHECK (decision IN ('approved', 'rejected'));

-- A decision with no one attached to it is not an audit record.
ALTER TABLE adjudication_reviews
  DROP CONSTRAINT IF EXISTS adjudication_reviews_reviewer_present;
ALTER TABLE adjudication_reviews
  ADD CONSTRAINT adjudication_reviews_reviewer_present
  CHECK (length(btrim(reviewer)) > 0);

ALTER TABLE adjudication_reviews
  DROP CONSTRAINT IF EXISTS adjudication_reviews_recommended_verdict_check;
ALTER TABLE adjudication_reviews
  ADD CONSTRAINT adjudication_reviews_recommended_verdict_check
  CHECK (recommended_verdict IN ('approve', 'deny', 'escalate'));

-- --- Indexes ----------------------------------------------------------------

-- "What has been decided lately, and by whom."
CREATE INDEX IF NOT EXISTS idx_adjudication_reviews_decided
  ON adjudication_reviews(decided_at DESC);

-- The queue's join: given a page of adjudications, which already have answers.
CREATE INDEX IF NOT EXISTS idx_adjudication_reviews_claim
  ON adjudication_reviews(claim_id, decided_at DESC);

-- --- Row-level security -----------------------------------------------------
--
-- Follows 0016 and 0017: RLS on, no policy at all. In Supabase a table without
-- RLS is fully readable AND writable through PostgREST by the anon key, and
-- that key ships in the frontend bundle.
--
-- INSERT rights here would let anyone fabricate a human approval — a row
-- naming an adjuster who never saw the claim. The dashboard reads this table
-- through the backend, which holds the service role key and bypasses RLS, and
-- writes to it only behind ADMIN_TOKEN. The browser needs no access of its own.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'adjudication_reviews') THEN
    EXECUTE 'ALTER TABLE adjudication_reviews ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS dashboard_read_adjudication_reviews ON adjudication_reviews';
  END IF;
END $$;


-- ============================================
-- SOURCE: 0020_renewal_capture.sql
-- ============================================

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


-- ============================================
-- SOURCE: 0021_journey_events.sql
-- ============================================

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


-- ============================================
-- SOURCE: 0022_filecoin_upload_errors.sql
-- ============================================

-- ============================================
-- Migration 0022: why the Filecoin upload failed
--
-- `filecoin_uploads` records that an archival attempt failed. It has never
-- recorded why, because 0003 gave it no column to put a reason in. The
-- pipeline writes upload_status = 'failed' and drops the provider's message
-- into a log line that a hosted runtime rotates away within the day.
--
-- That gap is not academic here. Archival in this deployment has failed on
-- every attempt it has ever made: /health reports `last_success_at: null` for
-- filecoin_uploads, and live claim rows carry filecoin_cid, piece_cid and
-- dataset_id all NULL. Chain attestation, by contrast, genuinely works — there
-- is a real Base Sepolia transaction behind it. So the deployment has one
-- subsystem that has never once succeeded, and the only artefact it leaves
-- behind is the word 'failed'.
--
-- The comment at filecoin-service.ts names a likely cause — an unfunded USDFC
-- Warm Storage rail reverting with InsufficientLockupFunds — and DEPLOYMENT.md
-- repeats it. Neither is evidence. Nobody has ever seen the actual message,
-- because there has never been anywhere to keep it. One nullable TEXT column
-- turns the next failure into a diagnosis instead of another guess.
--
-- Additive and idempotent. Safe to re-run.
-- ============================================

-- --- 1. The reason ----------------------------------------------------------
--
-- Nullable, and no backfill. Every row that already exists failed for a reason
-- that no longer exists anywhere, and writing a plausible-sounding one in now
-- would be inventing evidence — the exact habit the evidence pipeline was
-- rewritten to break. NULL here means "this attempt predates the column", and
-- that is the honest thing for it to mean.
--
-- TEXT rather than a code or an enum. The useful part of a Synapse failure is
-- the provider's own sentence, revert data and all; classifying it into a
-- short list would throw away the detail on the very first failure anyone
-- looks at, which is the failure this column exists for.

ALTER TABLE filecoin_uploads
  ADD COLUMN IF NOT EXISTS error TEXT;

COMMENT ON COLUMN filecoin_uploads.error IS
  'Why the attempt did not fully succeed, verbatim from the upload layer. On a ''failed'' row this is the reason nothing was stored. On a ''completed'' row it is set only when the piece was stored with fewer copies than were attempted, and the text says so. NULL means either a clean success or an attempt made before this column existed — never "failed for no reason".';

-- --- 2. Guards --------------------------------------------------------------

-- A blank string is worse than NULL: NULL says "we do not know", '' says "we
-- looked and the answer was nothing", and a reader cannot tell the second from
-- a bug. The service already refuses to produce one; this makes it unwritable.
ALTER TABLE filecoin_uploads
  DROP CONSTRAINT IF EXISTS filecoin_uploads_error_not_blank;
ALTER TABLE filecoin_uploads
  ADD CONSTRAINT filecoin_uploads_error_not_blank
  CHECK (error IS NULL OR length(btrim(error)) > 0);

-- DELIBERATELY ABSENT: CHECK (upload_status <> 'failed' OR error IS NOT NULL).
--
-- It is the constraint this migration is obviously for, and adding it would
-- make the migration itself unrunnable. Every failed row already in the live
-- table has a NULL error, so Postgres would reject the ADD CONSTRAINT and the
-- column would never land — on the one database that most needs it. Adding it
-- NOT VALID would work and would still be wrong: it would then be enforced on
-- new rows only, silently, which is a rule that reads as absolute in the
-- schema and is not. The pipeline is the place that guarantees this, and it
-- does; revisit here once no NULL-error failure rows remain.

-- --- 3. Indexes -------------------------------------------------------------

-- The only question this column is ever asked: what went wrong most recently,
-- and has it been the same thing every time. Partial, because a healthy row
-- has no error and would only bloat a scan that never wants it — and in a
-- deployment where archival has never succeeded, the partial index and the
-- full one would be the same size anyway. That is the point of measuring it.
CREATE INDEX IF NOT EXISTS idx_filecoin_uploads_error_attempted
  ON filecoin_uploads(attempted_at DESC)
  WHERE error IS NOT NULL;

-- --- 4. Row-level security --------------------------------------------------
--
-- !! THIS SECTION DID NOT WORK. The statement below is a no-op. It is left
-- !! here unchanged because it is what was actually applied to the database,
-- !! and rewriting it now would make this file a record of what was intended
-- !! rather than of what happened. 0023 is the fix. Read the correction at the
-- !! end of this comment before trusting anything above it.
--
-- 0007 put filecoin_uploads in its blanket-read list: RLS on, with a SELECT
-- policy granting anon and authenticated everything in the table. A new column
-- inherits that policy automatically, so without the revoke below this
-- migration would publish raw upload failure text to anyone holding the
-- publishable key — and that key ships inside the frontend bundle.
--
-- That matters more for this column than for the rest of the table. The other
-- columns are CIDs and timestamps. This one is whatever the storage layer
-- threw, unedited, and the strings that layer throws routinely carry the
-- agent's wallet address, the Warm Storage contract it was talking to, and the
-- Calibration RPC endpoint — which is a URL that in most hosted setups has an
-- API key in its path. None of that is something a browser needs.
--
-- And nothing is losing access. 0016 established that the only client-side
-- Supabase reads in this frontend are against `claims`; every read of
-- filecoin_uploads goes through the backend on the service role key, which
-- bypasses RLS and column privileges alike. The health endpoint, check-setup
-- and the evidence pipeline all sit on that key and are unaffected.
--
-- Column-level rather than dropping 0007's policy outright, because the rest
-- of the table's blanket read is 0007's decision to revisit, not this
-- migration's. The one caller this would break is an anon `select=*` over
-- filecoin_uploads, which would start returning "permission denied for column
-- error" instead of quietly leaking it. There is no such caller today.
--
-- To undo:  GRANT SELECT (error) ON filecoin_uploads TO anon, authenticated;
--
-- ---------------------------------------------------------------------------
-- CORRECTION, added later. Everything above this line describes an intent the
-- statement below does not carry out.
--
-- The REVOKE is a no-op. A column-level REVOKE cannot subtract from a
-- table-level GRANT. From the PostgreSQL REVOKE documentation:
--
--     "if a role has been granted privileges on a table, then revoking the
--      same privileges from individual columns will have no effect."
--
-- Supabase's project defaults give anon and authenticated a table-wide
-- `GRANT ALL ON ALL TABLES IN SCHEMA public`. So this statement removed a
-- column-level grant that had never been issued, left the table-level SELECT
-- untouched, and raised nothing — there was no error for the DO block to hit.
-- `error` was readable by the publishable key the whole time; this was
-- confirmed against the live database, where select=error, order=error.desc
-- and error=not.is.null all return HTTP 200 on the anon key.
--
-- The paragraph beginning "And nothing is losing access" is still true, and
-- was in fact true for the wrong reason: nothing lost access because nothing
-- was revoked.
--
-- The working form is a table-level revoke followed by an explicit re-grant of
-- every column except this one. That is 0023, and it is where the undo line
-- above should be read from too — after 0023 the way to restore `error` to the
-- browser is `GRANT SELECT ON filecoin_uploads TO anon, authenticated`, since
-- there is no longer a table-level grant for a column grant to hide inside.

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    -- Guarded so this file also runs against a plain Postgres that has never
    -- heard of Supabase's roles, rather than aborting the whole migration on
    -- a role that does not exist.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE SELECT (error) ON filecoin_uploads FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- Not added to the supabase_realtime publication, and neither is the table.
-- Streaming archival failures to the browser would be a second exposure that
-- the revoke above does not gate.


-- ============================================
-- SOURCE: 0023_filecoin_error_column_grant_fix.sql
-- ============================================

-- ============================================
-- Migration 0023: the revoke in 0022 was a no-op — actually close it
--
-- 0022 added `filecoin_uploads.error` and, in its own words, kept it away from
-- the browser with:
--
--     REVOKE SELECT (error) ON filecoin_uploads FROM anon, authenticated;
--
-- That statement ran without error and did nothing. From the PostgreSQL REVOKE
-- documentation, second half of the sentence that matters:
--
--     "When revoking privileges on a table, the corresponding column
--      privileges (if any) are automatically revoked on each column of the
--      table, as well. On the other hand, if a role has been granted
--      privileges on a table, then revoking the same privileges from
--      individual columns will have no effect."
--
-- A column-level REVOKE cannot subtract from a table-level GRANT. Supabase's
-- project defaults hand anon and authenticated a table-wide
-- `GRANT ALL ON ALL TABLES IN SCHEMA public`, so 0022 removed a column grant
-- that had never been issued and left the whole-table SELECT standing. The
-- guarded DO block reported success because there was nothing for it to fail
-- at.
--
-- VERIFIED AGAINST THE LIVE DATABASE, using the publishable key out of
-- frontend/.env — the same key compiled into the browser bundle:
--
--   GET /rest/v1/filecoin_uploads?select=error       -> HTTP 200 (not 42501)
--   GET /rest/v1/filecoin_uploads?order=error.desc   -> HTTP 200
--   GET /rest/v1/filecoin_uploads?error=not.is.null  -> HTTP 200
--
-- The last two are the conclusive ones: PostgREST can only order or filter on
-- a column the calling role holds SELECT on. The key was confirmed to really
-- be the anon role and not a service key in disguise — policy_renewals,
-- claim_documents and agent_settings all return [] on it and return rows on
-- the service key.
--
-- NOTHING HAS LEAKED. Every `error` in the live table is NULL, and the
-- deployed API (0b0f7a3) predates the code that writes the column at all. The
-- exposure opens on the next deploy of this branch, and the first Synapse
-- failure it captures is expected to carry the agent wallet address and the
-- Calibration RPC URL — which in most hosted setups has an API key in its
-- path. This migration has to land before that deploy, not after it.
--
-- Idempotent and re-runnable. Grants only; no schema change.
-- ============================================

-- --- 1. Table-level revoke, then an explicit per-column re-grant ------------
--
-- The shape the first sentence of that doc quote gives us. Revoking SELECT at
-- the table level clears the table privilege AND every column privilege on it,
-- so the GRANT that follows is not additive to anything — it is the complete
-- new definition of what these two roles may read. `error` is the one column
-- left out, and leaving a column out is the only mechanism that actually
-- withholds it.
--
-- EVERY OTHER COLUMN MUST BE NAMED. After the revoke there is no table-level
-- SELECT to fall back on, so a column missing from this list is a column anon
-- can no longer read. The list below is the live schema of filecoin_uploads —
-- ten columns from 0003, `simulated` from 0006 — minus `error`.
--
-- A consequence worth stating because it will bite someone later: a column
-- added to this table by a future migration will NOT be readable by anon or
-- authenticated until it is added to a grant. That is the safe direction to
-- fail in, and it is the opposite of how the table behaved before today, when
-- a new column was public the instant it existed. That default is what made
-- 0022's mistake dangerous rather than merely wrong.
--
-- Names are filtered through information_schema so this file still runs on a
-- database where 0006 never applied. The RAISE EXCEPTION guards the one
-- outcome worse than the leak: revoking SELECT and then granting nothing back,
-- which would take the table dark for every browser read.
--
-- To undo (restores the exposure — do not):
--   GRANT SELECT ON filecoin_uploads TO anon, authenticated;

DO $$
DECLARE
  readable CONSTANT text[] := ARRAY[
    'id', 'claim_id', 'piece_cid', 'dataset_id', 'root_cid', 'upload_status',
    'pdp_status', 'last_proven_epoch', 'attempted_at', 'completed_at',
    'simulated'
  ];
  col_list text;
  r        text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'filecoin_uploads'
  ) THEN
    RAISE NOTICE '0023: filecoin_uploads does not exist; nothing to re-grant.';
    RETURN;
  END IF;

  SELECT string_agg(quote_ident(c.name), ', ' ORDER BY c.ord)
    INTO col_list
    FROM unnest(readable) WITH ORDINALITY AS c(name, ord)
   WHERE EXISTS (
     SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_schema = 'public'
        AND ic.table_name   = 'filecoin_uploads'
        AND ic.column_name  = c.name
   );

  IF col_list IS NULL THEN
    RAISE EXCEPTION '0023: filecoin_uploads exists but none of its expected '
                    'columns do. Refusing to revoke SELECT, because that '
                    'would leave the table unreadable to every browser '
                    'client rather than merely hiding one column.';
  END IF;

  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    -- Same pg_roles guard 0022 used, and for the same reason: this file also
    -- has to run against a plain Postgres that has never heard of Supabase's
    -- roles, rather than aborting the whole migration on a missing role.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE SELECT ON public.filecoin_uploads FROM %I', r);
      EXECUTE format('GRANT SELECT (%s) ON public.filecoin_uploads TO %I',
                     col_list, r);
    END IF;
  END LOOP;
END $$;

-- --- 2. What is deliberately NOT touched ------------------------------------
--
-- 0007's blanket-read RLS policy on filecoin_uploads stays exactly as it is.
-- Column privileges and row policies are two independent gates and this
-- migration only closes one of them: which ROWS anon may see is 0007's
-- decision to revisit, and widening this file to re-litigate it would put an
-- unrelated frontend-visible change inside a security fix. The eleven columns
-- above remain as readable as they were this morning.
--
-- The service role is unaffected in every respect. It bypasses RLS and holds
-- its privileges independently of these two roles, so the health endpoint,
-- check-setup and the evidence pipeline — all of which read filecoin_uploads
-- on the service key, including the `error` column — continue unchanged. 0016
-- established that the only client-side Supabase reads in this frontend are
-- against `claims`, so nothing in the browser loses a column it was using.
--
-- INSERT, UPDATE and DELETE are also left alone. Supabase's default GRANT ALL
-- gives anon those too, and they are gated today only by 0007 having written
-- no policy for them. That is a real weakness and it is not this migration's:
-- it predates `error`, it applies to every table in the schema, and fixing it
-- one table at a time inside an unrelated file is how it would get missed
-- everywhere else.
--
-- Still not in the supabase_realtime publication, and neither is the table.
-- Publication membership is a third exposure that neither the revoke here nor
-- the policy in 0007 gates.


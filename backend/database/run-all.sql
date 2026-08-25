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


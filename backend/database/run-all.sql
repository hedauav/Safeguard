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


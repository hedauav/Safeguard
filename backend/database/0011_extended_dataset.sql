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

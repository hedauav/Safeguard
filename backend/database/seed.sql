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

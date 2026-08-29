/**
 * Generate the refusal/approval batch: twenty policies, twelve built to be
 * approvable and eight built to be refused, each refusal on its own clean
 * policy.
 *
 * Why a separate batch rather than reusing the journey twenty: a refusal case
 * needs a policy with no other claim on it. Case R2 of the first refusal run was
 * designed to trip `something_payable` and tripped `no_near_duplicate_claim`
 * instead, because the policy already carried a vandalism claim from the
 * completion run. The gate that fires first wins, so a refusal case sharing a
 * policy is not testing what it says it is testing.
 *
 * Each of the eight names the gate it is built to trip and the verdict that gate
 * forces. Writing the prediction into the fixture is the point: a case that
 * trips a different gate is then visibly a different gate rather than something
 * to be reinterpreted after the fact.
 *
 * Run:  node build-refusal-policies.mjs
 * Emits: 0026_refusal_batch_policies.sql and refusal-batch-policies.json
 */
import { randomUUID } from 'crypto';
import fs from 'fs';

const START = 400001;

const people = [
  ['Aarav Deshmukh', '1988-02-14', '77 Alder Rise, San Mateo, CA 94402'],
  ['Diya Raghavan', '1993-06-08', '215 Cedar Hollow, Belmont, CA 94002'],
  ['Kabir Sethi', '1985-10-21', '48 Fernhill Court, Millbrae, CA 94030'],
  ['Anika Bhatt', '1991-04-30', '1902 Juniper Walk, Foster City, CA 94404'],
  ['Rehan Malik', '1979-08-12', '306 Poplar Bend, San Bruno, CA 94066'],
  ['Saanvi Kulkarni', '1996-01-25', '89 Laurelwood Drive, Burlingame, CA 94010'],
  ['Vihaan Chopra', '1983-11-03', '1140 Birchwood Lane, San Carlos, CA 94070'],
  ['Myra Fernandes', '1990-07-19', '523 Willowmere Road, Daly City, CA 94015'],
  ['Arjun Bakshi', '1987-03-27', '64 Hazel Grove, Pacifica, CA 94044'],
  ['Tara Venkatesh', '1994-09-05', '2210 Maplewood Terrace, Redwood City, CA 94061'],
  ['Ishaan Grover', '1981-12-16', '17 Rowan Close, Half Moon Bay, CA 94019'],
  ['Nyra Sinha', '1997-05-11', '845 Sycamore Point, San Mateo, CA 94403'],
  ['Dev Acharya', '1986-06-23', '132 Thornbury Way, Belmont, CA 94002'],
  ['Kiara Mehrotra', '1992-10-09', '1671 Elmridge Avenue, Millbrae, CA 94030'],
  ['Rudra Panicker', '1984-01-18', '95 Ashford Lane, San Bruno, CA 94066'],
  ['Aisha Kapoor', '1995-08-26', '408 Brambleton Road, Foster City, CA 94404'],
  ['Neel Varshney', '1989-04-07', '2033 Hollybrook Drive, Burlingame, CA 94010'],
  ['Sara Chandran', '1998-02-02', '56 Wren Meadow, San Carlos, CA 94070'],
  ['Yuvan Rastogi', '1982-09-29', '1284 Foxglove Street, Pacifica, CA 94044'],
  ['Amara Joshi', '1993-12-13', '719 Kestrel Court, Redwood City, CA 94065'],
];

const autoDetail = (vehicle, registration, idv) => ({
  vehicle, registration, idv, cover: 'comprehensive', own_damage: true,
  third_party_liability: 1500000, zero_depreciation: true, roadside_assistance: true,
});
const homeDetail = (sqft, year, structure) => ({
  property_type: 'apartment', square_feet: sqft, year_built: year,
  structure_cover: structure, contents_cover: Math.round(structure / 4),
  public_liability: 500000, water_damage: true, burglary: true, earthquake: true, flood: false,
});
const healthDetail = (plan, network, room) => ({
  plan, network, room_rent_limit: room, copay_percent: 0,
  pre_existing_waiting_months: 36, day_care_procedures: true,
  prescription_coverage: true, emergency_room: true,
});

// --- The twelve that should be approvable --------------------------------
// payable = claimed - excess, kept inside the 50,000 settlement ceiling.
const APPROVE = [
  ['auto', 780000, 1000, 1380, 'collision', 28000, autoDetail('2025 Hyundai Verna SX', 'MH12 AB 1122', 780000)],
  ['auto', 640000, 1000, 1210, 'windshield', 12800, autoDetail('2024 Honda Amaze VX', 'KA03 CD 3344', 640000)],
  ['auto', 1120000, 2000, 1980, 'theft', 44000, autoDetail('2026 Toyota Hyryder', 'DL3C EF 5566', 1120000)],
  ['auto', 520000, 1000, 1020, 'vandalism', 15600, autoDetail('2023 Maruti Swift ZXi', 'GJ05 GH 7788', 520000)],
  ['auto', 890000, 2000, 1560, 'comprehensive', 36000, autoDetail('2025 Kia Sonet HTX', 'TN22 IJ 9900', 890000)],
  ['auto', 710000, 1000, 1290, 'collision', 19400, autoDetail('2024 Tata Punch Accomplished', 'MH14 KL 2233', 710000)],
  ['home', 2650000, 5000, 860, 'water_damage', 37500, homeDetail(1620, 2007, 2650000)],
  ['home', 1880000, 5000, 700, 'fire_damage', 48000, homeDetail(1380, 1999, 1880000)],
  ['home', 3400000, 10000, 1190, 'storm_damage', 34800, homeDetail(1810, 2013, 3400000)],
  ['home', 1460000, 5000, 620, 'theft', 21600, homeDetail(1250, 1996, 1460000)],
  ['health', 950000, 5000, 2380, 'medical', 43000, healthDetail('Family Floater', 'BayCare Plus', 7500)],
  ['health', 680000, 5000, 1820, 'hospitalisation', 38500, healthDetail('Individual', 'Peninsula Health', 5000)],
];

// --- The eight built to be refused ----------------------------------------
// [type, cover, excess, premium, claim_type, claimed, detail, status, termOffsetYears,
//  gate, verdict, incidentOffsetDays, note]
const REFUSE = [
  ['auto', 700000, 1000, 1300, 'collision', 24000, autoDetail('2024 Skoda Slavia', 'MH01 MN 4455', 700000),
   'active', 0, 'policy_in_force_on_incident_date', 'deny', -400,
   'The incident predates the policy term. A date comparison, not a judgement.'],
  ['auto', 660000, 1000, 1240, 'medical', 40000, autoDetail('2024 Nissan Magnite', 'KA51 OP 6677', 660000),
   'active', 0, 'claim_type_covered', 'deny', -2,
   'A medical claim on a motor policy. Outside the schedule, so the refusal is a matter of record.'],
  ['auto', 540000, 2000, 1080, 'vandalism', 900, autoDetail('2023 Renault Triber', 'RJ14 QR 8899', 540000),
   'active', 0, 'something_payable', 'deny', -3,
   'The claim is smaller than the excess. Nothing is payable and the arithmetic says so.'],
  ['auto', 820000, 1000, 1450, 'comprehensive', 2000000, autoDetail('2025 MG Astor Sharp', 'TS09 ST 1010', 820000),
   'active', 0, 'claimed_amount_within_coverage', 'escalate', -1,
   'Above the sum insured. Escalates rather than denies: what this needs is somebody telling the claimant.'],
  ['home', 2100000, 5000, 790, 'water_damage', 32000, homeDetail(1490, 2002, 2100000),
   'active', 0, 'no_near_duplicate_claim', 'escalate', -1,
   'Filed twice within the seven-day window. Possibly one incident claimed twice, possibly two; the system refuses to decide that itself.'],
  ['home', 1740000, 5000, 680, 'theft', null, homeDetail(1310, 1998, 1740000),
   'active', 0, 'claimed_amount_stated', 'escalate', -2,
   'No amount stated, so there is nothing to assess. Escalates rather than guessing on the claimant\'s behalf.'],
  ['auto', 590000, 1000, 1120, 'collision', 18000, autoDetail('2022 Ford EcoSport Titanium', 'MH04 UV 1212', 590000),
   'cancelled', 0, 'INTAKE:policy_not_active', 'refused_at_intake', -2,
   'A cancelled policy. file-claim refuses before a row is written; the adjudication gate is never reached.'],
  ['health', 720000, 5000, 1900, 'medical', 30000, healthDetail('Individual', 'Coastside Network', 6000),
   'expired', -1, 'INTAKE:policy_not_active', 'refused_at_intake', -2,
   'A lapsed policy, unrenewed. Same intake refusal, and the renewal path is what answers it.'],
];

const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const shift = (days) => { const d = new Date(today); d.setDate(d.getDate() + days); return iso(d); };
const years = (n) => { const d = new Date(today); d.setFullYear(d.getFullYear() + n); return iso(d); };

const rows = [];

for (let i = 0; i < 20; i++) {
  const approve = i < 12;
  const spec = approve ? APPROVE[i] : REFUSE[i - 12];
  const [full_name, dob, address] = people[i];
  const [first, last] = full_name.toLowerCase().split(' ');

  const customer = {
    id: randomUUID(), full_name,
    email: first + '.' + last + '@email.com',
    phone: '+141555502' + String(1 + i).padStart(2, '0'),
    date_of_birth: dob, address,
  };

  const type = spec[0], cover = spec[1], excess = spec[2], premium = spec[3];
  const claim_type = spec[4], claimed = spec[5], detail = spec[6];
  const status = approve ? 'active' : spec[7];
  const termOffset = approve ? 0 : spec[8];

  rows.push({
    customer,
    policy: {
      id: randomUUID(),
      policy_number: 'POL-2026-' + (START + i),
      customer_id: customer.id,
      policy_type: type,
      provider: type === 'health' ? 'SafeGuard Health' : 'SafeGuard Insurance',
      coverage_amount: cover,
      deductible: excess,
      premium_monthly: premium,
      start_date: years(-2),
      end_date: status === 'expired' ? shift(-30) : years(2 + termOffset),
      status,
      coverage_details: detail,
    },
    expectation: approve
      ? { kind: 'approve', claim_type, claimed_amount: claimed, payable: claimed - excess, incident_date: shift(-2) }
      : {
          kind: 'refuse', claim_type, claimed_amount: claimed,
          incident_date: shift(spec[11]),
          gate: spec[9], verdict: spec[10], why: spec[12],
          fileTwice: spec[9] === 'no_near_duplicate_claim',
        },
  });
}

// --- invariants, checked before anything is written -----------------------
const problems = [];
for (const r of rows) {
  const e = r.expectation;
  if (e.kind === 'approve') {
    if (e.payable <= 0 || e.payable > 50000) problems.push(r.policy.policy_number + ': payable ' + e.payable + ' outside (0, 50000]');
    if (e.claimed_amount > r.policy.coverage_amount) problems.push(r.policy.policy_number + ': claimed exceeds cover');
    if (r.policy.status !== 'active') problems.push(r.policy.policy_number + ': approval case is not active');
  }
}
if (new Set(rows.map((r) => r.policy.policy_number)).size !== 20) problems.push('duplicate policy numbers');
if (new Set(rows.map((r) => r.customer.phone)).size !== 20) problems.push('duplicate phones');
if (problems.length) { console.error('Refusing to write:'); for (const p of problems) console.error('  - ' + p); process.exit(1); }

fs.writeFileSync('refusal-batch-policies.json', JSON.stringify(rows, null, 2));

// --- SQL -------------------------------------------------------------------
const q = (v) => (v === null || v === undefined ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'");
const j = (v) => q(JSON.stringify(v)) + '::jsonb';

const header = `-- ============================================
-- Migration 0026: twenty policies for the refusal and approval batch
--
-- The journey completion run measured how far a good claim gets: ten of ten,
-- every stage. It said nothing about a claim that should not be paid, and a
-- result reporting only approvals invites exactly that question.
--
-- These twenty answer it. Twelve are built to be approvable; eight are built to
-- be refused, and each of the eight trips a DIFFERENT gate.
--
-- Each refusal has its own clean policy, and that is the point of a separate
-- batch rather than reusing the journey twenty. The first refusal run put a
-- case designed to trip 'something_payable' on a policy that already carried a
-- claim of the same type, and it tripped 'no_near_duplicate_claim' instead --
-- the earlier gate wins, so the case was not testing what it said it was.
--
-- The expected gate and verdict for each are recorded in
-- refusal-batch-policies.json, written before the batch was run. A case that
-- trips a different gate is then visibly a different gate, rather than
-- something to be reinterpreted afterwards.
--
-- Generated by database/build-refusal-policies.mjs -- do not edit by hand.
-- Additive and idempotent. Safe to re-run.
-- ============================================

INSERT INTO customers (id, full_name, email, phone, date_of_birth, address) VALUES
`;

const custVals = rows.map((r) => {
  const c = r.customer;
  return `  (${q(c.id)}, ${q(c.full_name)}, ${q(c.email)}, ${q(c.phone)}, ${q(c.date_of_birth)}, ${q(c.address)})`;
}).join(',\n');

const polLine = (r) => {
  const p = r.policy, e = r.expectation;
  const comment = e.kind === 'approve'
    ? `  -- ${p.policy_number}  approvable: ${e.claim_type} of ${e.claimed_amount.toLocaleString('en-IN')} leaves ${e.payable.toLocaleString('en-IN')} payable`
    : `  -- ${p.policy_number}  refusal: expects ${e.verdict} at ${e.gate}\n  --   ${e.why}`;
  return comment + '\n' +
    `  (${q(p.id)}, ${q(p.policy_number)}, ${q(p.customer_id)}, ${q(p.policy_type)}, ${q(p.provider)}, ` +
    `${p.coverage_amount}, ${p.deductible}, ${p.premium_monthly}, ${q(p.start_date)}, ${q(p.end_date)}, ` +
    `${q(p.status)}, ${j(p.coverage_details)})`;
};

const sql = header + custVals + '\nON CONFLICT (id) DO NOTHING;\n\n' +
  '-- --- The twelve built to be approvable ------------------------------------\n\n' +
  'INSERT INTO policies (id, policy_number, customer_id, policy_type, provider, coverage_amount, deductible, premium_monthly, start_date, end_date, status, coverage_details) VALUES\n' +
  rows.filter((r) => r.expectation.kind === 'approve').map(polLine).join(',\n') +
  '\nON CONFLICT (id) DO NOTHING;\n\n' +
  '-- --- The eight built to be refused, one gate each --------------------------\n\n' +
  'INSERT INTO policies (id, policy_number, customer_id, policy_type, provider, coverage_amount, deductible, premium_monthly, start_date, end_date, status, coverage_details) VALUES\n' +
  rows.filter((r) => r.expectation.kind === 'refuse').map(polLine).join(',\n') +
  '\nON CONFLICT (id) DO NOTHING;\n';

fs.writeFileSync('0026_refusal_batch_policies.sql', sql);

console.log('wrote 0026_refusal_batch_policies.sql and refusal-batch-policies.json');
console.log('  approvable: ' + rows.filter((r) => r.expectation.kind === 'approve').length);
console.log('  refusals:   ' + rows.filter((r) => r.expectation.kind === 'refuse').length);
console.log('');
for (const r of rows.filter((x) => x.expectation.kind === 'refuse')) {
  console.log('  ' + r.policy.policy_number + '  ' + r.expectation.verdict.padEnd(18) + r.expectation.gate);
}

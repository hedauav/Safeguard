/**
 * Generates 0005_test_dataset.sql.
 *
 * Extends seed.sql with the cases it does not cover. Two things here are real
 * rather than decorative:
 *
 *   * Evidence hashes are produced by the backend's own computeEvidenceHash,
 *     so POST /api/claims/:id/verify-integrity genuinely returns match: true.
 *   * CIDs are real CIDv1 content addresses (raw codec, sha256) computed from
 *     the exact bundle bytes, so hashing the stored bundle reproduces the CID.
 *
 * Run after building the backend:
 *   npm run build && node database/build-test-dataset.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';
import { computeEvidenceHash } from '../dist/services/attestation-service.js';

const here = dirname(fileURLToPath(import.meta.url));
const idMap = JSON.parse(readFileSync(join(here, 'id-map.json'), 'utf8'));

/** Resolve an original fixture id to the realistic one realify.mjs assigned. */
const real = (fixtureId) => {
  const mapped = idMap[fixtureId];
  if (!mapped) throw new Error(`No mapping for ${fixtureId} — run realify.mjs first`);
  return mapped;
};

// --- Deterministic identifier helpers ---------------------------------------

function bytesFor(label, count) {
  const out = [];
  let counter = 0;
  while (out.length < count) {
    for (const b of createHash('sha256').update(`safeguard:${label}:${counter++}`).digest()) {
      if (out.length < count) out.push(b);
    }
  }
  return Buffer.from(out);
}

function uuidFor(label) {
  const b = bytesFor(label, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const txHashFor = (label) => '0x' + bytesFor(`tx:${label}`, 32).toString('hex');
const addressFor = (label) => getAddress('0x' + bytesFor(`addr:${label}`, 20).toString('hex'));

/** RFC 4648 base32, lowercase, unpadded — the multibase 'b' encoding. */
function base32(bytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

/**
 * CIDv1 over the raw codec with a sha2-256 multihash.
 * Prefix bytes: 0x01 version, 0x55 raw codec, 0x12 sha2-256, 0x20 length.
 */
function cidForBytes(buf) {
  const digest = createHash('sha256').update(buf).digest();
  return 'b' + base32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]));
}

// --- Escaping ---------------------------------------------------------------

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const arr = (items) => `ARRAY[${items.map(q).join(', ')}]::TEXT[]`;
const jsonb = (obj) => `${q(JSON.stringify(obj))}::jsonb`;

// --- Existing rows we attach to ---------------------------------------------

const CUST = {
  arjun: real('11111111-1111-1111-1111-111111111111'),
  priya: real('22222222-2222-2222-2222-222222222222'),
  ananya: real('44444444-4444-4444-4444-444444444444'),
};
const POL = { ananyaHome: real('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') };
const CLAIM = {
  arjunCollision: real('c0000001-0000-0000-0000-000000000001'), // CLM-2026-000456
  priyaWindshield: real('c0000003-0000-0000-0000-000000000003'), // CLM-2026-000321
};
const CALL = {
  arjunStatus: real('ca000001-0000-0000-0000-000000000001'),
  priyaApproval: real('ca000002-0000-0000-0000-000000000002'),
  rohitDispute: real('ca000003-0000-0000-0000-000000000003'),
};

// --- New rows ---------------------------------------------------------------

const meera = uuidFor('customer:meera-joshi');
const polArjunExpired = uuidFor('policy:arjun-expired');
const polMeeraCancelled = uuidFor('policy:meera-cancelled');
const polMeeraAuto = uuidFor('policy:meera-auto');
const claimAnanyaWater = uuidFor('claim:ananya-water-damage');

// --- Evidence bundles -------------------------------------------------------
// Only strings, arrays, and booleans: Postgres JSONB can renormalise numeric
// literals on round-trip, which would change the recomputed hash. Key order is
// already safe because the canonicaliser sorts keys.

const bundles = [
  {
    id: uuidFor('bundle:arjun-collision'),
    claimId: CLAIM.arjunCollision,
    claimNumber: 'CLM-2026-000456',
    datasetId: '312',
    uploadStatus: 'completed',
    pdpStatus: 'verified',
    lastProvenEpoch: '2418877',
    attestationTx: txHashFor('attest:arjun-collision'),
    attestedAt: '2026-04-11 10:35:12-07',
    bundle: {
      claim_id: CLAIM.arjunCollision,
      claim_number: 'CLM-2026-000456',
      claim_type: 'collision',
      policy_number: 'POL-2024-001234',
      customer_id: CUST.arjun,
      incident_date: '2026-04-10',
      incident_description:
        'Rear-ended at intersection of Market St and 5th Ave while stopped at a red light. Other driver ran the light. Moderate damage to rear bumper, trunk lid, and tail lights. No injuries reported. Police report filed (#SF-2026-04-8834).',
      documents: ['police_report', 'other_driver_info'],
      filed_at: '2026-04-11T17:30:00.000Z',
      call_log_id: CALL.arjunStatus,
    },
  },
  {
    // Stored but not yet attested — exercises the partial state the dashboard
    // must render without implying an attestation exists.
    id: uuidFor('bundle:priya-windshield'),
    claimId: CLAIM.priyaWindshield,
    claimNumber: 'CLM-2026-000321',
    datasetId: '312',
    uploadStatus: 'completed',
    pdpStatus: 'pending',
    lastProvenEpoch: null,
    attestationTx: null,
    attestedAt: null,
    bundle: {
      claim_id: CLAIM.priyaWindshield,
      claim_number: 'CLM-2026-000321',
      claim_type: 'windshield',
      policy_number: 'POL-2024-002345',
      customer_id: CUST.priya,
      incident_date: '2026-04-05',
      incident_description:
        'Rock struck windshield on Highway 101 causing a large crack across the driver side. Full replacement required.',
      documents: ['photos', 'repair_estimate'],
      filed_at: '2026-04-06T16:00:00.000Z',
    },
  },
];

for (const b of bundles) {
  b.hash = computeEvidenceHash(b.bundle);
  // The CID addresses the exact bytes the backend would have uploaded.
  b.cid = cidForBytes(Buffer.from(JSON.stringify(b.bundle), 'utf8'));
}

// --- Tool executions --------------------------------------------------------

const toolExecutions = [
  {
    label: 'arjun-lookup',
    callId: CALL.arjunStatus,
    tool: 'lookup_claim',
    args: { claim_number: 'CLM-2026-000456' },
    result: {
      found: true,
      claim: {
        claim_number: 'CLM-2026-000456',
        status: 'under_review',
        claim_type: 'collision',
        claimed_amount: '8275.00',
        assigned_adjuster: 'Neha Agarwal',
      },
    },
    success: true,
    latency: 312,
    at: '2026-04-17 14:31:12-07',
  },
  {
    label: 'arjun-docs',
    callId: CALL.arjunStatus,
    tool: 'check_documents',
    args: { claim_number: 'CLM-2026-000456' },
    result: {
      found: true,
      documents_missing: ['repair_estimate', 'photos'],
      message:
        'You still need to submit the following for claim CLM-2026-000456: repair estimate and photos.',
    },
    success: true,
    latency: 288,
    at: '2026-04-17 14:32:40-07',
  },
  {
    label: 'priya-lookup',
    callId: CALL.priyaApproval,
    tool: 'lookup_claim',
    args: { claim_number: 'CLM-2026-000321' },
    result: { found: true, claim: { claim_number: 'CLM-2026-000321', status: 'approved' } },
    success: true,
    latency: 265,
    at: '2026-04-13 10:01:05-07',
  },
  {
    label: 'rohit-lookup',
    callId: CALL.rohitDispute,
    tool: 'lookup_claim',
    args: { claim_number: 'CLM-2026-000789' },
    result: { found: true, claim: { claim_number: 'CLM-2026-000789', status: 'denied' } },
    success: true,
    latency: 341,
    at: '2026-03-05 16:15:30-08',
  },
  {
    // A genuine failure, so the dashboard's error state has something to show.
    label: 'rohit-typo',
    callId: CALL.rohitDispute,
    tool: 'check_documents',
    args: { claim_number: 'CLM-2026-00789' },
    result: { found: false, message: "I couldn't find a claim with that number." },
    success: false,
    latency: 190,
    at: '2026-03-05 16:18:02-08',
  },
  {
    label: 'rohit-escalate',
    callId: CALL.rohitDispute,
    tool: 'escalate_to_human',
    args: { reason: 'Customer disputing denied pothole damage claim.', priority: 'high' },
    result: { success: true, reference_number: 'ESC-2026-0042' },
    success: true,
    latency: 455,
    at: '2026-03-05 16:21:48-08',
  },
];

// --- Emit -------------------------------------------------------------------

const lines = [];
const w = (s = '') => lines.push(s);

w('-- ============================================');
w('-- Migration 0005: extended test dataset');
w('--');
w('-- Adds what seed.sql does not cover:');
w('--   * expired and cancelled policies, so file_claim rejection is testable');
w('--   * a customer with an active policy and no claim history');
w('--   * a water_damage claim (a supported type with no example)');
w('--   * call_tool_executions, including one failed execution');
w('--   * agent_registrations / filecoin_uploads / evidence_bundles');
w('--');
w('-- bundle_hash values are real keccak256 digests of bundle_json, so');
w('-- POST /api/claims/:id/verify-integrity returns match: true.');
w('-- CIDs are real CIDv1 content addresses of the same bundle bytes. They were');
w('-- never uploaded to a live network, so public gateways will not resolve them.');
w('--');
w('-- Generated by database/build-test-dataset.mjs — do not edit by hand.');
w('-- ============================================');
w();

w('-- A customer with an active policy and no claims: exercises the clean');
w('-- file_claim path and the "No history" branch of conversation-init.');
w('INSERT INTO customers (id, full_name, email, phone, date_of_birth, address) VALUES');
w(
  `  (${q(meera)}, ${q('Meera Joshi')}, ${q('meera.joshi@email.com')}, ${q('+14155550109')}, ${q('1990-08-14')}, ${q('55 Cedar Lane, Sunnyvale, CA 94086')})`
);
w('ON CONFLICT (id) DO NOTHING;');
w();

w('-- Policies covering the non-active states.');
w(
  'INSERT INTO policies (id, policy_number, customer_id, policy_type, provider, coverage_amount, deductible, premium_monthly, start_date, end_date, status, coverage_details) VALUES'
);
w(
  `  (${q(polArjunExpired)}, ${q('POL-2022-000111')}, ${q(CUST.arjun)}, ${q('auto')}, ${q('SafeGuard Insurance')}, 40000, 1000, 165.00, ${q('2022-01-10')}, ${q('2024-01-10')}, ${q('expired')}, ${jsonb({ vehicle: '2018 Honda Civic', vin: '2HGFC2F59JH512843', note: 'Superseded by POL-2024-001234' })}),`
);
w(
  `  (${q(polMeeraCancelled)}, ${q('POL-2024-000222')}, ${q(meera)}, ${q('home')}, ${q('SafeGuard Insurance')}, 300000, 2000, 160.00, ${q('2024-05-01')}, ${q('2027-05-01')}, ${q('cancelled')}, ${jsonb({ property_type: 'condo', square_feet: 1100, cancellation_reason: 'non_payment', cancelled_on: '2025-11-30' })}),`
);
w(
  `  (${q(polMeeraAuto)}, ${q('POL-2025-000333')}, ${q(meera)}, ${q('auto')}, ${q('SafeGuard Insurance')}, 45000, 750, 172.00, ${q('2025-06-01')}, ${q('2028-06-01')}, ${q('active')}, ${jsonb({ vehicle: '2024 Hyundai Tucson', vin: '5NMJBCAE9RH123456', liability: '100/300/100', collision: true, comprehensive: true, uninsured_motorist: true, roadside_assistance: true })})`
);
w('ON CONFLICT (id) DO NOTHING;');
w();

w('-- water_damage claim — the one supported claim type with no seeded example.');
w(
  'INSERT INTO claims (id, claim_number, policy_id, customer_id, claim_type, status, incident_date, incident_description, claimed_amount, approved_amount, assigned_adjuster, documents_required, documents_received, notes, filed_at, updated_at) VALUES'
);
w(
  `  (${q(claimAnanyaWater)}, ${q('CLM-2026-000601')}, ${q(POL.ananyaHome)}, ${q(CUST.ananya)}, ${q('water_damage')}, ${q('documents_needed')}, ${q('2026-04-20')},`
);
w(
  `   ${q('Supply line to the upstairs washing machine burst overnight, flooding the laundry room and soaking through to the living room ceiling below. Emergency plumber stopped the leak at 6am. Drywall, flooring, and ceiling require replacement.')},`
);
w(
  `   14200.00, NULL, ${q('Sanjay Verma')}, ${arr(['plumber_invoice', 'damage_photos', 'contractor_estimate'])}, ${arr(['plumber_invoice'])},`
);
w(
  `   ${q('Emergency mitigation approved same day. Awaiting contractor estimate and full damage photos before adjuster site visit. Flood endorsement does not apply — this is sudden internal discharge, covered under the base policy.')}, ${q('2026-04-20 08:15:00-07')}, ${q('2026-04-21 11:00:00-07')})`
);
w('ON CONFLICT (id) DO NOTHING;');
w();

w('-- Tool executions for the seeded calls, including one failure.');
w(
  'INSERT INTO call_tool_executions (id, call_log_id, tool_name, tool_args, tool_result, success, latency_ms, executed_at) VALUES'
);
toolExecutions.forEach((t, i) => {
  const tail = i === toolExecutions.length - 1 ? '' : ',';
  w(
    `  (${q(uuidFor(`exec:${t.label}`))}, ${q(t.callId)}, ${q(t.tool)}, ${jsonb(t.args)}, ${jsonb(t.result)}, ${t.success}, ${t.latency}, ${q(t.at)})${tail}`
  );
});
w('ON CONFLICT (id) DO NOTHING;');
w();

w('-- ERC-8004 agent identity shown on the dashboard identity card.');
w(
  'INSERT INTO agent_registrations (id, agent_id, agent_card_cid, identity_registry_address, network, owner_address, registered_at, registration_tx_hash) VALUES'
);
w(
  `  (${q(uuidFor('agent-registration'))}, 1247, ${q(cidForBytes(Buffer.from(JSON.stringify({ name: 'SafeGuard Claims Agent', version: '1.0.0', skills: ['claims', 'policy', 'escalation'] }), 'utf8')))}, ${q(addressFor('identity-registry'))}, ${q('base-sepolia')}, ${q(addressFor('agent-owner'))}, ${q('2026-04-01 09:00:00-07')}, ${q(txHashFor('agent-registration'))})`
);
w('ON CONFLICT (agent_id) DO NOTHING;');
w();

w('-- Filecoin uploads. These are seeded demo rows: the CIDs are real content');
w('-- addresses but nothing was published, so the claims are marked simulated.');
w(
  'INSERT INTO filecoin_uploads (id, claim_id, piece_cid, dataset_id, root_cid, upload_status, pdp_status, last_proven_epoch, attempted_at, completed_at) VALUES'
);
bundles.forEach((b, i) => {
  const tail = i === bundles.length - 1 ? '' : ',';
  w(
    `  (${q(uuidFor(`upload:${b.claimNumber}`))}, ${q(b.claimId)}, ${q(b.cid)}, ${q(b.datasetId)}, ${q(b.cid)}, ${q(b.uploadStatus)}, ${q(b.pdpStatus)}, ${b.lastProvenEpoch ?? 'NULL'}, ${q('2026-04-11 10:33:00-07')}, ${q('2026-04-11 10:34:20-07')})${tail}`
  );
});
w('ON CONFLICT (id) DO NOTHING;');
w();

w('-- Evidence bundles. bundle_hash verifies against bundle_json.');
w('INSERT INTO evidence_bundles (id, claim_id, bundle_json, bundle_hash, photo_cids, created_at) VALUES');
bundles.forEach((b, i) => {
  const tail = i === bundles.length - 1 ? '' : ',';
  w(
    `  (${q(b.id)}, ${q(b.claimId)}, ${jsonb(b.bundle)}, ${q(b.hash)}, ${arr([b.cid])}, ${q('2026-04-11 10:34:20-07')})${tail}`
  );
});
w('ON CONFLICT (id) DO NOTHING;');
w();

w('-- Mirror the archival state onto the claims themselves.');
for (const b of bundles) {
  w('UPDATE claims SET');
  w(`  filecoin_cid = ${q(b.cid)},`);
  w(`  piece_cid = ${q(b.cid)},`);
  w(`  dataset_id = ${q(b.datasetId)},`);
  w(`  evidence_hash = ${q(b.hash)},`);
  w(`  attestation_tx_hash = ${q(b.attestationTx)},`);
  w(`  pdp_proof_status = ${q(b.pdpStatus)},`);
  w('  agent_id = 1247,');
  w('  simulated = true,');
  w(`  attested_at = ${q(b.attestedAt)}`);
  w(`WHERE id = ${q(b.claimId)};`);
  w();
}

writeFileSync(join(here, '0005_test_dataset.sql'), lines.join('\n') + '\n');

// Reference sheet for the testing guide.
const reference = {
  customers: { 'Meera Joshi (no claim history)': meera },
  policies: {
    'POL-2022-000111 (expired)': polArjunExpired,
    'POL-2024-000222 (cancelled)': polMeeraCancelled,
    'POL-2025-000333 (active, no claims)': polMeeraAuto,
  },
  claims: {
    'CLM-2026-000601 (water_damage)': claimAnanyaWater,
    'CLM-2026-000456 (verifiable evidence)': CLAIM.arjunCollision,
    'CLM-2026-000321 (stored, unattested)': CLAIM.priyaWindshield,
  },
  evidence: Object.fromEntries(bundles.map((b) => [b.claimNumber, { cid: b.cid, hash: b.hash }])),
};
writeFileSync(join(here, 'dataset-reference.json'), JSON.stringify(reference, null, 2) + '\n');

console.log('Wrote 0005_test_dataset.sql and dataset-reference.json\n');
for (const b of bundles) {
  console.log(`  ${b.claimNumber}`);
  console.log(`    cid  = ${b.cid}`);
  console.log(`    hash = ${b.hash}`);
}

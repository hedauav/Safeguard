#!/usr/bin/env node
/**
 * Every capability, against every kind of policy, one cell at a time.
 *
 *   node scripts/functionality-matrix.mjs                 # read and refusal paths
 *   node scripts/functionality-matrix.mjs --include-money # also the paying paths
 *   node scripts/functionality-matrix.mjs --json
 *
 * `npm run evaluate` reports 204 cases in six groups and answers "does the tool
 * layer work". It cannot answer "does settlement work on a life policy", because
 * its Coverage group visits every record with the same two tools and its other
 * groups visit one record each. A 100% pass rate over that shape is compatible
 * with a capability never having been tried on half the book.
 *
 * This walks the other axis. It samples policies across every type and status
 * the database actually holds, then exercises each capability against each one
 * and records what came back and how long it took. A cell can pass by working,
 * or pass by refusing — for an expired policy, a refusal IS the correct
 * behaviour, and a harness that only counts successes would score the safest
 * path as a failure.
 *
 * Money paths are opt-in. `collect_deductible` and `offer_renewal` create real
 * Razorpay links; running them across a sample creates real objects, so they
 * stay behind --include-money rather than firing because someone ran the
 * default command.
 */
import { config as loadEnv } from 'dotenv';

loadEnv();

const API = process.env.API_BASE_URL ?? 'https://safeguard-api-production-7c24.up.railway.app';
const TOKEN = process.env.TOOLS_API_TOKEN ?? '';
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const argv = process.argv.slice(2);
const INCLUDE_MONEY = argv.includes('--include-money');
const AS_JSON = argv.includes('--json');

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to pick the sample.');
  process.exit(2);
}

const db = async (path) => {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!response.ok) throw new Error(`supabase ${path}: ${response.status}`);
  return response.json();
};

/** One tool call, timed. Never throws — a thrown call is a result too. */
async function callTool(tool, body) {
  const started = Date.now();
  try {
    const response = await fetch(`${API}/api/tools/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tools-token': TOKEN },
      body: JSON.stringify(body),
    });
    const latency = Date.now() - started;
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { ok: response.ok, status: response.status, latency, payload };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latency: Date.now() - started,
      payload: null,
      error: String(error instanceof Error ? error.message : error),
    };
  }
}

// ---------------------------------------------------------------------------
// The sample: widest spread of type and status the book actually contains
// ---------------------------------------------------------------------------

async function pickSample() {
  const policies = await db(
    'policies?select=policy_number,policy_type,status,coverage_amount,deductible,premium_monthly'
  );
  const claims = await db('claims?select=claim_number,policy_id,status,claim_type,claimed_amount');
  const policyRows = await db('policies?select=id,policy_number');
  const idToNumber = new Map(policyRows.map((p) => [p.id, p.policy_number]));

  const claimsByPolicy = new Map();
  for (const c of claims) {
    const number = idToNumber.get(c.policy_id);
    if (!number) continue;
    if (!claimsByPolicy.has(number)) claimsByPolicy.set(number, []);
    claimsByPolicy.get(number).push(c);
  }

  // One policy per (type, status) that exists, preferring ones that carry a
  // claim so the claim-shaped capabilities have something real to run against.
  const buckets = new Map();
  for (const p of policies) {
    const key = `${p.policy_type}/${p.status}`;
    const withClaims = (claimsByPolicy.get(p.policy_number) ?? []).length;
    const current = buckets.get(key);
    if (!current || withClaims > current.claimCount) {
      buckets.set(key, { ...p, claimCount: withClaims, claims: claimsByPolicy.get(p.policy_number) ?? [] });
    }
  }

  return [...buckets.values()].sort(
    (a, b) => a.policy_type.localeCompare(b.policy_type) || a.status.localeCompare(b.status)
  );
}

// ---------------------------------------------------------------------------
// What each capability should do, per policy status
// ---------------------------------------------------------------------------

/**
 * Only `active` is in force. The first version of this harness counted
 * `pending` as live and scored two refusals as failures — the backend was
 * right and the expectation was wrong. A pending policy has not incepted, so
 * refusing a claim against it is the correct behaviour, and a harness that
 * demanded otherwise would have been arguing for a bug.
 */
const isLive = (status) => status === 'active';

/**
 * Each capability declares what it expects rather than just "did it 200".
 * `expect` returns 'work' or 'refuse'; a refusal where a refusal is correct is
 * a pass, and a success where a refusal was correct is the failure that matters.
 */
const CAPABILITIES = [
  {
    name: 'check_policy',
    money: false,
    expect: () => 'work',
    run: (p) => callTool('check-policy', { policy_number: p.policy_number }),
    judge: (p, r) => (r.payload?.found === true ? null : 'policy not returned'),
  },
  {
    name: 'lookup_claim',
    money: false,
    needsClaim: true,
    expect: () => 'work',
    run: (p) => callTool('lookup-claim', { claim_number: p.claims[0].claim_number }),
    judge: (p, r) => (r.payload?.found === true ? null : 'claim not returned'),
  },
  {
    name: 'check_documents',
    money: false,
    needsClaim: true,
    expect: () => 'work',
    run: (p) => callTool('check-documents', { claim_number: p.claims[0].claim_number }),
    judge: (p, r) => (r.payload && r.payload.found !== false ? null : 'no document status'),
  },
  {
    name: 'file_claim',
    money: false,
    creates: true,
    expect: (p) => (isLive(p.status) ? 'work' : 'refuse'),
    run: (p) =>
      callTool('file-claim', {
        policy_number: p.policy_number,
        incident_description: 'Functionality matrix probe — automated, safe to delete.',
        claim_type: p.policy_type,
      }),
    judge: (p, r) => {
      const filed = Boolean(r.payload?.claim_number);
      if (isLive(p.status)) return filed ? null : `expected a claim number, got: ${r.payload?.message ?? r.status}`;
      // The important half: a refusal must not hand back an identifier.
      if (filed) return `filed against a ${p.status} policy and returned ${r.payload.claim_number}`;
      return null;
    },
  },
  {
    name: 'adjudicate_claim',
    money: false,
    needsClaim: true,
    expect: () => 'work',
    run: (p) => callTool('adjudicate-claim', { claim_number: p.claims[0].claim_number }),
    judge: (p, r) => {
      const v = r.payload?.verdict;
      if (!v) return `no verdict: ${r.payload?.reason ?? r.status}`;
      if (!['approve', 'deny', 'escalate'].includes(v)) return `unexpected verdict ${v}`;
      return null;
    },
    detail: (r) => (r.payload?.verdict ? `${r.payload.verdict}` : ''),
  },
  {
    name: 'escalate_to_human',
    money: false,
    expect: () => 'work',
    run: () =>
      callTool('escalate-to-human', {
        reason: 'Functionality matrix probe — automated.',
        priority: 'low',
      }),
    judge: (p, r) => (r.payload?.reference_number ? null : 'no reference number'),
  },
  {
    name: 'schedule_callback',
    money: false,
    expect: () => 'work',
    run: () =>
      callTool('schedule-callback', {
        phone_number: '+15550100999',
        preferred_time: 'tomorrow morning',
        reason: 'Functionality matrix probe — automated.',
      }),
    judge: (p, r) => (r.payload?.success === true ? null : 'callback not recorded'),
  },
  {
    name: 'attach_document',
    money: false,
    needsClaim: true,
    expect: () => 'work',
    run: (p) =>
      callTool('attach-document', {
        claim_number: p.claims[0].claim_number,
        document_type: 'photos',
      }),
    judge: (p, r) => (r.payload?.upload_url ? null : 'no upload url returned'),
  },
  {
    // Writes an escalations row and, when EAS is configured, an attestation.
    // EAS is currently off, so this touches nothing on chain. It resolves the
    // claim by internal UUID only — a known limitation, so the claim's id is
    // passed rather than its number.
    name: 'escalate_to_regulator',
    money: false,
    needsClaim: true,
    expect: () => 'work',
    run: async (p) => {
      const rows = await db(
        `claims?select=id&claim_number=eq.${encodeURIComponent(p.claims[0].claim_number)}`
      );
      return callTool('escalate-to-regulator', {
        claim_id: rows[0]?.id,
        reason: 'Functionality matrix probe — automated.',
      });
    },
    judge: (p, r) =>
      r.payload?.reference_number ? null : `no reference number: ${r.payload?.message ?? r.status}`,
    detail: (r) => (r.payload?.attestation_uid ? 'attested' : 'recorded, no attestation'),
  },
  {
    name: 'settle_claim',
    money: true,
    needsClaim: true,
    expect: (p) => (p.claims.some((c) => c.status === 'approved') ? 'work' : 'refuse'),
    run: (p) => {
      const approved = p.claims.find((c) => c.status === 'approved') ?? p.claims[0];
      return callTool('settle-claim', { claim_number: approved.claim_number });
    },
    judge: (p, r) => {
      const settled = Boolean(r.payload?.payout_id ?? r.payload?.amount);
      const expectWork = p.claims.some((c) => c.status === 'approved');
      if (expectWork) return settled ? null : `expected settlement, got ${r.payload?.reason ?? r.status}`;
      if (settled) return 'settled a claim that was not approved';
      return null;
    },
    detail: (r) => r.payload?.reason ?? (r.payload?.amount ? `paid ${r.payload.amount}` : ''),
  },
  {
    name: 'offer_renewal',
    money: true,
    expect: (p) => (p.status === 'expired' ? 'work' : 'refuse'),
    run: (p) => callTool('offer-renewal', { policy_number: p.policy_number }),
    judge: (p, r) => {
      const link = Boolean(r.payload?.payment_link_url);
      if (p.status === 'expired') return link ? null : `expected a link, got ${r.payload?.reason ?? r.status}`;
      if (link) return `offered renewal on a ${p.status} policy`;
      return null;
    },
    detail: (r) => r.payload?.reason ?? (r.payload?.amount ? `link for ${r.payload.amount}` : ''),
  },
  {
    name: 'collect_deductible',
    money: true,
    needsClaim: true,
    expect: () => 'either',
    run: (p) => callTool('collect-deductible', { claim_number: p.claims[0].claim_number }),
    judge: (p, r) => {
      // Either a link or a stated reason is correct; silence is not.
      if (r.payload?.payment_link_url) return null;
      if (r.payload?.reason || r.payload?.message) return null;
      return `neither a link nor a reason: ${r.status}`;
    },
    detail: (r) => r.payload?.reason ?? (r.payload?.payment_link_url ? 'link issued' : ''),
  },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const sample = await pickSample();
const capabilities = CAPABILITIES.filter((c) => INCLUDE_MONEY || !c.money);
const createdClaims = [];
const results = [];

if (!AS_JSON) {
  console.log('');
  console.log(`  ${sample.length} policies sampled across every type and status in the book.`);
  console.log(`  ${capabilities.length} capabilities${INCLUDE_MONEY ? ' (including money paths)' : ' (money paths skipped — pass --include-money)'}.`);
  console.log('');
}

for (const policy of sample) {
  for (const cap of capabilities) {
    if (cap.needsClaim && policy.claims.length === 0) {
      results.push({
        policy: policy.policy_number,
        type: policy.policy_type,
        status: policy.status,
        capability: cap.name,
        outcome: 'skipped',
        reason: 'this policy has no claim to run it against',
        latency_ms: null,
      });
      continue;
    }

    const expected = cap.expect(policy);
    const response = await cap.run(policy);
    const failure = cap.judge(policy, response);

    if (cap.creates && response.payload?.claim_number) createdClaims.push(response.payload.claim_number);

    results.push({
      policy: policy.policy_number,
      type: policy.policy_type,
      status: policy.status,
      capability: cap.name,
      expected,
      outcome: failure ? 'fail' : 'pass',
      reason: failure ?? (cap.detail ? cap.detail(response) : ''),
      http: response.status,
      latency_ms: response.latency,
    });
  }
}

// Clean up what we filed, exactly as evaluate.mjs does.
let cleaned = 0;
for (const claimNumber of createdClaims) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/claims?claim_number=eq.${encodeURIComponent(claimNumber)}`,
    { method: 'DELETE', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
  );
  if (response.ok) cleaned++;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (AS_JSON) {
  console.log(JSON.stringify({ sample, results, cleaned }, null, 2));
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
const padStart = (s, n) => String(s).padStart(n);

console.log('  PER CAPABILITY');
console.log('  ' + '-'.repeat(88));
console.log(
  `  ${pad('capability', 22)}${padStart('pass', 6)}${padStart('fail', 6)}${padStart('skip', 6)}${padStart('p50', 9)}${padStart('max', 9)}   verdict`
);
for (const cap of capabilities) {
  const rows = results.filter((r) => r.capability === cap.name);
  const pass = rows.filter((r) => r.outcome === 'pass').length;
  const fail = rows.filter((r) => r.outcome === 'fail').length;
  const skip = rows.filter((r) => r.outcome === 'skipped').length;
  const lat = rows.filter((r) => r.latency_ms != null).map((r) => r.latency_ms).sort((a, b) => a - b);
  const p50 = lat.length ? `${lat[Math.floor(lat.length / 2)]}ms` : '—';
  const max = lat.length ? `${lat[lat.length - 1]}ms` : '—';
  const verdict = fail > 0 ? 'FAILING' : pass === 0 ? 'never exercised' : 'ok';
  console.log(
    `  ${pad(cap.name, 22)}${padStart(pass, 6)}${padStart(fail, 6)}${padStart(skip, 6)}${padStart(p50, 9)}${padStart(max, 9)}   ${verdict}`
  );
}

console.log('');
console.log('  FAILURES AND SKIPS — the exception list');
console.log('  ' + '-'.repeat(88));
const exceptions = results.filter((r) => r.outcome !== 'pass');
if (exceptions.length === 0) {
  console.log('  none');
} else {
  for (const r of exceptions) {
    console.log(`  ${pad(r.outcome.toUpperCase(), 8)}${pad(r.capability, 22)}${pad(`${r.policy} (${r.type}/${r.status})`, 34)}${r.reason}`);
  }
}

const pass = results.filter((r) => r.outcome === 'pass').length;
const fail = results.filter((r) => r.outcome === 'fail').length;
const skip = results.filter((r) => r.outcome === 'skipped').length;

console.log('');
console.log(`  ${results.length} cells: ${pass} passed, ${fail} failed, ${skip} skipped.`);
console.log(`  ${cleaned} claim(s) filed by this run were deleted afterwards.`);
console.log('');
console.log('  A cell passes by doing the right thing, which for an expired or cancelled');
console.log('  policy means refusing. A refusal that still returns an identifier is a');
console.log('  failure even when the HTTP status is 200.');
console.log('');

process.exit(fail > 0 ? 1 : 0);

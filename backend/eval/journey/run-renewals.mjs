/**
 * The two lapsed-policy renewal cases of the journey run, against the DEPLOYED
 * API, as far as the point where a human has to pay a link.
 *
 * The pre-registration says a claim filed against a lapsed policy is expected to
 * be denied on the incident date by `policy_in_force_on_incident_date`, and that
 * the denial is a pass rather than a failure — it is the refusal the renewal
 * answers. So the claim is filed FIRST and the adjudication row is read straight
 * out of the database, before any renewal is offered. Reading the row rather
 * than the tool response is deliberate: `vetoed_by` and `model_invoked` are what
 * establish that arithmetic, not a model, did the refusing.
 *
 * Paying the renewal link needs hands on a Razorpay checkout, so the script
 * stops at the link and reports it.
 *
 *   node eval/journey/run-renewals.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '..', '.env') });

const API = 'https://safeguard-api-production-7c24.up.railway.app';
const TOOLS = process.env.TOOLS_API_TOKEN;
if (!TOOLS) { console.error('TOOLS_API_TOKEN missing'); process.exit(1); }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Fixed by PRE-REGISTRATION.md. Both lapsed, both carrying no claims.
const CASES = [
  {
    policy: 'POL-2026-300016',
    claim_type: 'collision',
    estimated_amount: 22500,
    incident_description:
      'Rear-ended at a signal on the Outer Ring Road; the boot lid and rear bumper are stoved in and the boot will not shut.',
  },
  {
    policy: 'POL-2026-300017',
    claim_type: 'windshield',
    estimated_amount: 13400,
    incident_description:
      'A stone thrown up by a truck on the highway starred the windscreen on the driver side and the crack has spread across it.',
  },
];

// The pre-registered expectation, written down here so the script reports
// whether it held rather than assuming it did.
const EXPECTED = { vetoed_by: 'policy_in_force_on_incident_date', verdict: 'deny', model_invoked: false };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tool(pathname, body) {
  const res = await fetch(API + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tools-token': TOOLS },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Filing kicks adjudication off in the background; wait for the row to land. */
async function waitForAdjudication(claimNumber, budgetMs = 45000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const { data } = await sb
      .from('adjudications')
      .select('id, claim_number, verdict, confidence, vetoed_by, model_invoked, model_provider, model_id, checks, computed_payable_amount, created_at')
      .eq('claim_number', claimNumber)
      .order('created_at', { ascending: false })
      .limit(1);
    if (data && data.length) return data[0];
    await sleep(3000);
  }
  return null;
}

const today = new Date().toISOString().slice(0, 10);
const results = [];

console.log('Journey run — renewals — ' + CASES.length + ' cases against ' + API);
console.log('');

for (const c of CASES) {
  const row = { policy: c.policy, stages: {}, expected: EXPECTED, notes: [] };

  const { data: pol } = await sb
    .from('policies')
    .select('id, policy_number, policy_type, status, premium_monthly, start_date, end_date')
    .eq('policy_number', c.policy)
    .maybeSingle();
  row.policy_state_before = pol
    ? { status: pol.status, premium_monthly: Number(pol.premium_monthly), start_date: pol.start_date, end_date: pol.end_date }
    : null;

  // --- 1. the denial before the renewal ----------------------------------
  const filed = await tool('/api/tools/file-claim', {
    policy_number: c.policy,
    claim_type: c.claim_type,
    incident_date: today,
    incident_description: c.incident_description,
    estimated_amount: c.estimated_amount,
  });
  row.claim_type = c.claim_type;
  row.estimated_amount = c.estimated_amount;
  row.incident_date = today;
  row.claim = filed.json?.claim_number ?? null;
  row.stages['R0 claim filed on lapsed policy'] = Boolean(filed.json?.success && row.claim);
  row.refusal = {
    layer: row.claim ? 'adjudication' : 'file-claim intake',
    http_status: filed.status,
    reason: filed.json?.reason ?? null,
    message: filed.json?.message ?? null,
  };
  if (!row.stages['R0 claim filed on lapsed policy']) {
    row.notes.push('file-claim: HTTP ' + filed.status + ' ' + (filed.json?.reason ?? '') + ' ' + (filed.json?.message ?? ''));
  }

  if (row.claim) {
    const adj = await waitForAdjudication(row.claim);
    if (!adj) {
      row.stages['R0a adjudicated'] = false;
      row.notes.push('no adjudications row appeared within the budget');
    } else {
      row.stages['R0a adjudicated'] = true;
      const veto = Array.isArray(adj.checks) ? adj.checks.find((k) => k.id === adj.vetoed_by) : null;
      row.adjudication = {
        verdict: adj.verdict,
        vetoed_by: adj.vetoed_by,
        model_invoked: adj.model_invoked,
        model_provider: adj.model_provider,
        model_id: adj.model_id,
        confidence: Number(adj.confidence),
        computed_payable_amount: Number(adj.computed_payable_amount),
        detail: veto?.detail ?? null,
        checks_run: Array.isArray(adj.checks) ? adj.checks.map((k) => ({ id: k.id, passed: k.passed })) : [],
      };
      row.stages['R0b denied before any model ran'] =
        adj.vetoed_by === EXPECTED.vetoed_by && adj.verdict === EXPECTED.verdict && adj.model_invoked === EXPECTED.model_invoked;
      if (!row.stages['R0b denied before any model ran']) {
        row.notes.push(
          'expectation NOT met — vetoed_by=' + adj.vetoed_by + ' verdict=' + adj.verdict + ' model_invoked=' + adj.model_invoked
        );
      }
    }
  }

  await sleep(6000);

  // --- 2. the renewal offer ----------------------------------------------
  const off = await tool('/api/tools/offer-renewal', { policy_number: c.policy });
  row.stages['R1 renewal offered'] = Boolean(off.json?.success && off.json?.payment_link_url);
  row.renewal = {
    success: off.json?.success ?? false,
    reason: off.json?.reason ?? null,
    payment_link_url: off.json?.payment_link_url ?? null,
    payment_link_id: off.json?.payment_link_id ?? null,
    amount: off.json?.renewal_amount ?? off.json?.amount ?? null,
    simulated: off.json?.simulated ?? null,
  };
  if (!row.stages['R1 renewal offered']) row.notes.push('offer-renewal: ' + (off.json?.message ?? 'no message'));

  // The amount is only trustworthy if it is the policy's own arithmetic.
  const expectedAmount = pol ? Number(pol.premium_monthly) * 12 : null;
  row.renewal.expected_amount = expectedAmount;
  row.renewal.amount_matches_premium_x12 =
    expectedAmount !== null && row.renewal.amount !== null && Number(row.renewal.amount) === expectedAmount;

  // Did the pre-registered expectation hold, exactly as it was written? The
  // claim can only be denied by a rule if a claim row was ever made.
  row.expectation_held = row.stages['R0b denied before any model ran'] === true;
  row.model_invoked = row.adjudication ? row.adjudication.model_invoked : false;
  if (!row.claim) {
    row.model_invoked_note =
      'No model ran, but not because a rule vetoed one: no claim row was created, so nothing was adjudicated.';
  }

  // --- 3. stop. Paying needs a human at a Razorpay checkout. --------------
  row.stoppedAt = 'renewal payment — needs a human at the checkout';

  results.push(row);
  console.log('  ' + c.policy + '  ' + String(row.claim ?? '—').padEnd(17) +
    (row.adjudication ? row.adjudication.verdict + ' / ' + row.adjudication.vetoed_by + ' / model=' + row.adjudication.model_invoked : 'no adjudication'));
  if (row.renewal.payment_link_url) {
    console.log('      pay: ' + row.renewal.payment_link_url + '   (INR ' + row.renewal.amount +
      (row.renewal.amount_matches_premium_x12 ? ', = premium x 12' : ', EXPECTED ' + expectedAmount) + ')');
  }
  for (const n of row.notes) console.log('      note: ' + n);
  await sleep(6000);
}

// The finding, stated as what happened rather than as what was expected.
const held = results.filter((r) => r.expectation_held).length;
const intake = results.filter((r) => r.refusal && r.refusal.layer === 'file-claim intake');
const finding = {
  expectation_held_for: held + ' of ' + results.length,
  refused_at: intake.length === results.length
    ? 'file-claim intake, on policy status — one layer earlier than the pre-registration named'
    : 'see each case',
  reasons: [...new Set(results.map((r) => r.refusal?.reason).filter(Boolean))],
  model_invoked_anywhere: results.some((r) => r.model_invoked === true),
  reading: intake.length === results.length
    ? 'A lapsed policy is refused before a claim row exists, so `policy_in_force_on_incident_date` never gets the chance ' +
      'to fire and no `adjudications` row is written. The refusal is still arithmetic and still ahead of any model — ' +
      'it is simply the intake gate (claims-service.ts, `policy.status !== "active"`), not the adjudication rule. ' +
      'The pre-registration named the wrong layer, not the wrong behaviour.'
    : null,
};
const out = path.join(here, 'renewals.json');
fs.writeFileSync(out, JSON.stringify({ run_at: new Date().toISOString(), api: API, expectation: EXPECTED, finding, cases: results }, null, 2));
console.log('');
console.log('finding: expectation held for ' + finding.expectation_held_for + '; refused at ' + finding.refused_at);
console.log('');
console.log('written: ' + out);

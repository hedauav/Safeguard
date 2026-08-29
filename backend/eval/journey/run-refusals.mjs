/**
 * Refusal cases — the other half of the workflow.
 *
 * The completion run measured how far a good claim gets. It says nothing about
 * what happens to one that should not be paid, and a run reporting 10 of 10
 * approvals invites exactly that question.
 *
 * These four are constructed to fail, each at a different gate, and each for a
 * reason a person could state in a sentence. They are NOT part of the
 * pre-registered completion run and must never be counted in its denominator:
 * they were designed after the outcome of that run was known, which is precisely
 * the thing pre-registration exists to prevent. Reported separately for that
 * reason.
 *
 * They run against journey-batch fixture policies, which `coverage-cases.mjs`
 * and `check-numbers.mjs` both exclude from the evaluation. The nine held-out
 * policies are not touched.
 *
 *   node run-refusals.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '..', '.env') });

const API = 'https://safeguard-api-production-7c24.up.railway.app';
const T = process.env.TOOLS_API_TOKEN;
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);

const post = async (p, body) =>
  (await fetch(API + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tools-token': T },
    body: JSON.stringify(body),
  })).json();

/**
 * Each case names the gate it is built to trip and the verdict that gate forces,
 * written down before the run so a wrong gate is visible as a wrong gate rather
 * than reinterpreted afterwards.
 */
const CASES = [
  {
    id: 'R1 — claim type outside the cover',
    policy: 'POL-2026-300003',
    claim_type: 'medical',
    amount: 40000,
    description: 'Hospital admission for a chest infection, three nights, treated at a network hospital.',
    expectGate: 'claim_type_covered',
    expectVerdict: 'deny',
    why: 'A medical claim on a motor policy. The schedule in adjudication-rules.ts does not cover it, so the refusal is a matter of record rather than judgement.',
  },
  {
    id: 'R2 — nothing left after the excess',
    policy: 'POL-2026-300004',
    claim_type: 'vandalism',
    amount: 600,
    description: 'Wing mirror casing scratched in a car park overnight; minor cosmetic damage only.',
    expectGate: 'something_payable',
    expectVerdict: 'deny',
    why: 'The claim is smaller than the excess on the policy. There is nothing to pay, and saying so is arithmetic.',
  },
  {
    id: 'R3 — claimed above the sum insured',
    policy: 'POL-2026-300005',
    claim_type: 'comprehensive',
    amount: 1500000,
    description: 'Vehicle written off after a collision; replacement quoted well above the insured value.',
    expectGate: 'claimed_amount_within_coverage',
    expectVerdict: 'escalate',
    why: 'Above the limit is not automatically fraud. It escalates rather than denies, because what this needs is somebody telling the claimant, which is a conversation and not a refusal.',
  },
  {
    id: 'R4 — the same incident claimed twice',
    policy: 'POL-2026-300006',
    claim_type: 'collision',
    amount: 21800,
    description: 'Rear-end collision at a signal; bumper and boot lid damaged, other driver at fault.',
    expectGate: 'no_near_duplicate_claim',
    expectVerdict: 'escalate',
    why: 'An open claim of the same type on the same policy within seven days. It may be one incident claimed twice, or two genuine incidents; the system refuses to decide that itself.',
  },
];

const results = [];

for (const c of CASES) {
  const filed = await post('/api/tools/file-claim', {
    policy_number: c.policy,
    claim_type: c.claim_type,
    incident_date: today,
    incident_description: c.description,
    estimated_amount: c.amount,
  });

  const row = { ...c, filed: filed.success === true, claim: filed.claim_number ?? null, refusedAtIntake: filed.success === false, intakeReason: filed.reason ?? null };

  if (!row.filed) {
    console.log(c.id + '\n    refused at intake: ' + (filed.reason ?? '?') + ' — ' + String(filed.message ?? '').slice(0, 90));
    results.push(row);
    await sleep(8000);
    continue;
  }

  // Filing adjudicates in the background. Wait rather than calling adjudicate
  // again, which would write a second recommendation for one claim.
  await sleep(8000);

  const { data: adj } = await s.from('adjudications')
    .select('verdict,vetoed_by,model_invoked,inconsistencies,computed_payable_amount,created_at')
    .eq('claim_number', row.claim).order('created_at').limit(1);

  const a = adj?.[0];
  row.verdict = a?.verdict ?? null;
  row.vetoedBy = a?.vetoed_by ?? null;
  row.modelInvoked = a?.model_invoked ?? null;
  row.payable = a?.computed_payable_amount ?? null;
  row.gateMatched = row.vetoedBy === c.expectGate;
  row.verdictMatched = row.verdict === c.expectVerdict;

  console.log(c.id);
  console.log('    ' + row.claim + '  verdict=' + row.verdict + '  vetoed_by=' + row.vetoedBy +
    '  model_invoked=' + row.modelInvoked +
    '   [' + (row.gateMatched && row.verdictMatched ? 'as predicted' : 'DIFFERENT FROM PREDICTION') + ']');

  results.push(row);
  await sleep(8000);
}

fs.writeFileSync(path.join(here, 'refusals.json'), JSON.stringify(results, null, 2));
console.log('\nwritten refusals.json');

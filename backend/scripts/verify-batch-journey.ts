/**
 * Dry-run the deterministic half of adjudication over the twenty batch
 * policies, against the rows as they actually stand in the database.
 *
 * Run from backend/:  npx tsx scripts/verify-batch-journey.ts
 *
 * Nothing here is written, no model is called and no money moves. It answers
 * one question before a walkthrough is recorded rather than during it: for
 * each of the twenty, would `runDeterministicChecks` let the claim through to
 * the model, and is the figure it would compute the figure the journey needs?
 *
 * The expectation differs by half of the batch, and both halves are assertions:
 *
 *   the fifteen active   every check passes, no veto, and the payable amount
 *                        is inside (0, 50000] so settle-claim will release it
 *
 *   the five lapsed      vetoed at 'policy_in_force_on_incident_date' with a
 *                        'deny', by arithmetic, before any model is called.
 *                        That refusal is what the renewal offer then answers,
 *                        so a lapsed policy that quietly PASSED would be the
 *                        failure — it would mean a claim was admitted against
 *                        a term that had ended.
 *
 * Exits non-zero if any of the twenty does not behave as its half requires.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import {
  runDeterministicChecks,
  type AdjudicationFacts,
} from '../src/services/adjudication-rules.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '.env') });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see backend/.env).');
  process.exit(1);
}

const SETTLEMENT_CEILING = 50_000;

interface BatchRow {
  customer: { full_name: string };
  policy: { policy_number: string; status: string };
  journey: { claim_type: string; suggested_claim_amount: number; payable_after_deductible: number };
}

const rows: BatchRow[] = JSON.parse(
  readFileSync(path.join(here, '..', 'database', 'batch-journey-policies.json'), 'utf8')
);

const supabase = createClient(url, key);

const { data: policies, error } = await supabase
  .from('policies')
  .select('id, policy_number, policy_type, status, coverage_amount, deductible, start_date, end_date, coverage_details')
  .in('policy_number', rows.map((r) => r.policy.policy_number));

if (error) {
  console.error('Could not read the policies:', error.message);
  process.exit(1);
}

const money = (n: number) => Number(n).toLocaleString('en-IN');

// Today, for the active half. The lapsed half is deliberately given an
// incident date of today too — which is after every one of their terms ended,
// and is exactly the claim a caller would make before being offered a renewal.
const today = new Date().toISOString().slice(0, 10);

const failures: string[] = [];

console.log('Dry run against ' + (policies?.length ?? 0) + ' policies, incident date ' + today);
console.log('');
console.log('  policy            expected  verdict   vetoed by                            payable');
console.log('  ' + '-'.repeat(92));

for (const row of rows) {
  const policy = policies?.find((p) => p.policy_number === row.policy.policy_number);
  const label = row.policy.policy_number;

  if (!policy) {
    failures.push(label + ' is not in the database');
    console.log('  ' + label + '  NOT PRESENT');
    continue;
  }

  const shouldPass = policy.status === 'active';

  const facts: AdjudicationFacts = {
    claim: {
      id: 'dry-run',
      claim_number: 'DRY-' + label,
      claim_type: row.journey.claim_type,
      status: 'submitted',
      incident_date: today,
      claimed_amount: row.journey.suggested_claim_amount,
      incident_description: 'Dry run for the journey batch. Nothing is written.',
    },
    policy: {
      policy_number: policy.policy_number,
      policy_type: policy.policy_type,
      status: policy.status,
      coverage_amount: policy.coverage_amount,
      deductible: policy.deductible,
      start_date: policy.start_date,
      end_date: policy.end_date,
      coverage_details: policy.coverage_details as Record<string, unknown> | null,
    },
    // No siblings: each of the twenty holds one policy and no claims, which is
    // what keeps the near-duplicate check quiet on the first pass.
    siblingClaims: [],
  };

  const result = runDeterministicChecks(facts);
  const verdict = result.veto ? result.veto.vetoes : 'passes to the model';
  const vetoedBy = result.veto ? result.veto.id : '—';

  console.log(
    '  ' +
      label +
      '  ' +
      (shouldPass ? 'proceed ' : 'deny    ').padEnd(9) +
      String(verdict).padEnd(10) +
      vetoedBy.padEnd(36) +
      money(result.payableAmount).padStart(10)
  );

  if (shouldPass) {
    if (result.veto) {
      failures.push(label + ' should have passed every check but was vetoed at ' + result.veto.id + ': ' + result.veto.detail);
    }
    if (result.payableAmount <= 0) {
      failures.push(label + ' computes nothing payable, so there would be no settlement to refund against');
    }
    if (result.payableAmount > SETTLEMENT_CEILING) {
      failures.push(label + ' computes ' + money(result.payableAmount) + ' payable, above the ' + money(SETTLEMENT_CEILING) + ' ceiling — settle-claim would refuse it');
    }
    if (result.payableAmount !== row.journey.payable_after_deductible) {
      failures.push(label + ' computes ' + money(result.payableAmount) + ' but the batch file expects ' + money(row.journey.payable_after_deductible));
    }
  } else {
    if (!result.veto) {
      failures.push(label + ' is lapsed but passed every check — a claim would be admitted against a term that has ended');
    } else if (result.veto.id !== 'policy_in_force_on_incident_date') {
      failures.push(label + ' is lapsed but was stopped at ' + result.veto.id + ' rather than on the date');
    } else if (result.veto.vetoes !== 'deny') {
      failures.push(label + ' is lapsed and was vetoed on the date, but to ' + result.veto.vetoes + ' rather than deny');
    }
  }
}

console.log('');

if (failures.length) {
  console.error(failures.length + ' problem(s):');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

console.log('All 20 behave as the batch requires.');
console.log('  15 active  pass every deterministic check and reach the model, with a payable');
console.log('             figure inside the ' + money(SETTLEMENT_CEILING) + ' settlement ceiling.');
console.log('  5 lapsed   are denied on the incident date in code, before any model is called —');
console.log('             the refusal that offer-renewal then answers.');

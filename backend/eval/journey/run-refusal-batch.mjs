/**
 * Run the eight refusal cases of the 0026 batch, each on its own clean policy.
 *
 * Every case carries the gate it is built to trip and the verdict that gate
 * forces, written into refusal-batch-policies.json before the run. This script
 * compares what happened against that prediction and reports both, so a case
 * that trips a different gate is visible as one rather than reinterpreted.
 *
 *   node run-refusal-batch.mjs
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

const batch = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'database', 'refusal-batch-policies.json'), 'utf8'));
const cases = batch.filter((r) => r.expectation.kind === 'refuse');

const file = async (policy, e) => {
  const body = {
    policy_number: policy,
    claim_type: e.claim_type,
    incident_date: e.incident_date,
    incident_description: 'Refusal batch case. ' + e.claim_type.replace(/_/g, ' ') + ' reported by the policyholder.',
  };
  if (e.claimed_amount !== null && e.claimed_amount !== undefined) body.estimated_amount = e.claimed_amount;
  return (await fetch(API + '/api/tools/file-claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tools-token': T },
    body: JSON.stringify(body),
  })).json();
};

const out = [];

for (const r of cases) {
  const p = r.policy.policy_number;
  const e = r.expectation;
  const row = { policy: p, gate: e.gate, expectedVerdict: e.verdict, why: e.why };

  const first = await file(p, e);

  if (e.verdict === 'refused_at_intake') {
    row.actual = first.success === false ? 'refused_at_intake' : 'FILED';
    row.reason = first.reason ?? null;
    row.message = String(first.message ?? '').slice(0, 110);
    row.matched = first.success === false && first.reason === 'policy_not_active';
    console.log(p + '  expected refused_at_intake   got ' + row.actual +
      ' (' + row.reason + ')   ' + (row.matched ? '[as predicted]' : '[DIFFERENT]'));
    out.push(row);
    await sleep(8000);
    continue;
  }

  if (!first.success) {
    row.actual = 'refused_at_intake';
    row.reason = first.reason ?? null;
    row.matched = false;
    console.log(p + '  expected ' + e.verdict + ' at ' + e.gate + '   got intake refusal (' + row.reason + ')   [DIFFERENT]');
    out.push(row);
    await sleep(8000);
    continue;
  }

  row.claim = first.claim_number;

  // The duplicate case needs a second claim of the same type to trip the gate.
  if (e.fileTwice) {
    await sleep(8000);
    const second = await file(p, e);
    row.secondClaim = second.claim_number ?? null;
    row.claim = second.claim_number ?? row.claim;
  }

  await sleep(9000);

  const { data: adj } = await s.from('adjudications')
    .select('verdict,vetoed_by,model_invoked,computed_payable_amount,created_at')
    .eq('claim_number', row.claim).order('created_at').limit(1);
  const a = adj?.[0];

  row.actual = a?.verdict ?? null;
  row.actualGate = a?.vetoed_by ?? null;
  row.modelInvoked = a?.model_invoked ?? null;
  row.matched = row.actual === e.verdict && row.actualGate === e.gate;

  console.log(p + '  ' + String(row.claim).padEnd(17) + 'expected ' + e.verdict + '/' + e.gate);
  console.log('      got ' + row.actual + '/' + row.actualGate + '  model_invoked=' + row.modelInvoked +
    '   ' + (row.matched ? '[as predicted]' : '[DIFFERENT]'));

  out.push(row);
  await sleep(8000);
}

fs.writeFileSync(path.join(here, 'refusal-batch.json'), JSON.stringify(out, null, 2));
const hit = out.filter((r) => r.matched).length;
console.log('\n' + hit + ' of ' + out.length + ' behaved exactly as predicted.');
console.log('written refusal-batch.json');

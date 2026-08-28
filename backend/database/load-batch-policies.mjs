/**
 * Insert the twenty journey-batch policies into a live database.
 *
 * Run from the database/ directory:  node load-batch-policies.mjs
 * Add --check to report what is already there and write nothing.
 *
 * The same twenty rows as 0025_batch_journey_policies.sql, from the same JSON,
 * over PostgREST instead of the SQL editor. Both exist because they answer
 * different questions: the migration is what a fresh deployment runs as part
 * of run-all.sql, and this is what puts the rows into a database that is
 * already up without anyone pasting a file into a browser.
 *
 * Idempotent, and deliberately in the weaker direction. `ignoreDuplicates`
 * mirrors the migration's ON CONFLICT (id) DO NOTHING: a row already present
 * is left exactly as it is. That matters after a walkthrough, because renewing
 * one of the five lapsed policies rewrites its status and its term — and a
 * loader that "restored" those columns would silently undo a renewal somebody
 * had just paid for.
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, read from ../.env.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '.env') });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see backend/.env).');
  process.exit(1);
}

const checkOnly = process.argv.includes('--check');
const rows = JSON.parse(fs.readFileSync(path.join(here, 'batch-journey-policies.json'), 'utf8'));
const supabase = createClient(url, key);

const numbers = rows.map((r) => r.policy.policy_number);

const { data: existing, error: existingError } = await supabase
  .from('policies')
  .select('policy_number, status, start_date, end_date')
  .in('policy_number', numbers);

if (existingError) {
  console.error('Could not read the policies table:', existingError.message);
  process.exit(1);
}

const present = new Map((existing ?? []).map((p) => [p.policy_number, p]));
console.log(present.size + ' of the 20 batch policies are already on record.');

if (checkOnly) {
  for (const r of rows) {
    const live = present.get(r.policy.policy_number);
    const state = live
      ? live.status + ' ' + live.start_date + ' to ' + live.end_date
      : 'not present';
    const drifted = live && live.status !== r.policy.status ? '  <- differs from the file' : '';
    console.log('  ' + r.policy.policy_number + '  ' + r.customer.full_name.padEnd(18) + state + drifted);
  }
  process.exit(0);
}

const { error: customerError } = await supabase
  .from('customers')
  .upsert(rows.map((r) => r.customer), { onConflict: 'id', ignoreDuplicates: true });

if (customerError) {
  console.error('Customer insert failed:', customerError.message);
  process.exit(1);
}

const { error: policyError } = await supabase
  .from('policies')
  .upsert(rows.map((r) => r.policy), { onConflict: 'id', ignoreDuplicates: true });

if (policyError) {
  console.error('Policy insert failed:', policyError.message);
  process.exit(1);
}

const { data: after, error: afterError } = await supabase
  .from('policies')
  .select('policy_number, policy_type, status, coverage_amount, deductible, premium_monthly')
  .in('policy_number', numbers)
  .order('policy_number');

if (afterError) {
  console.error('Wrote the rows but could not read them back:', afterError.message);
  process.exit(1);
}

const money = (n) => Number(n).toLocaleString('en-IN');
console.log('');
console.log(after.length + ' of 20 present after the load.');
console.log('');
console.log('  policy            type    status    coverage     excess   premium/mo   suggested claim');
console.log('  ' + '-'.repeat(88));

for (const r of rows) {
  const live = after.find((p) => p.policy_number === r.policy.policy_number);
  if (!live) {
    console.log('  ' + r.policy.policy_number + '  MISSING');
    continue;
  }
  console.log(
    '  ' +
      live.policy_number +
      '  ' +
      live.policy_type.padEnd(7) +
      ' ' +
      live.status.padEnd(9) +
      money(live.coverage_amount).padStart(10) +
      money(live.deductible).padStart(11) +
      money(live.premium_monthly).padStart(13) +
      (money(r.journey.suggested_claim_amount) + ' ' + r.journey.claim_type).padStart(28)
  );
}

const missing = rows.filter((r) => !after.some((p) => p.policy_number === r.policy.policy_number));
if (missing.length) {
  console.error('');
  console.error(missing.length + ' row(s) did not land: ' + missing.map((r) => r.policy.policy_number).join(', '));
  process.exit(1);
}

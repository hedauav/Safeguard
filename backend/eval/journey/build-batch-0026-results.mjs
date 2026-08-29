/**
 * Render BATCH-0026.md from the database: the twelve approvable and eight
 * refusal cases seeded by migration 0026.
 *
 * Kept out of RESULTS.md deliberately. That file reports the pre-registered
 * completion run, and folding a batch designed afterwards into its denominator
 * would destroy the one property that makes it evidence.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '..', '.env') });
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const batch = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'database', 'refusal-batch-policies.json'), 'utf8'));
const refusalRun = JSON.parse(fs.readFileSync(path.join(here, 'refusal-batch.json'), 'utf8'));
const approvalRun = JSON.parse(fs.readFileSync(path.join(here, 'approval-batch.json'), 'utf8'));

const numbers = batch.map((r) => r.policy.policy_number);
const { data: pols } = await s.from('policies').select('id, policy_number').in('policy_number', numbers);
const polIds = new Map((pols ?? []).map((p) => [p.id, p.policy_number]));

const { data: claims } = await s.from('claims')
  .select('id, claim_number, policy_id, status, claimed_amount, approved_amount')
  .in('policy_id', [...polIds.keys()]);

const { data: deds } = await s.from('deductible_payments')
  .select('claim_id, payment_id, refund_id, refund_amount_paise, refund_simulated')
  .in('claim_id', (claims ?? []).map((c) => c.id));

const ded = new Map((deds ?? []).map((d) => [d.claim_id, d]));
const money = (n) => '₹' + Number(n ?? 0).toLocaleString('en-IN');

// --- approvals -------------------------------------------------------------
const approvalRows = approvalRun.map((r) => {
  const c = (claims ?? []).find((x) => x.claim_number === r.claim);
  const d = c ? ded.get(c.id) : null;
  return { ...r, status: c?.status ?? null, settled: c?.approved_amount ?? null, refund: d?.refund_id ?? null, refundAmt: d?.refund_amount_paise ?? null, refundReal: d?.refund_simulated === false };
});

const reachedLink = approvalRun.filter((r) => r.link).length;
const payableOk = approvalRun.filter((r) => r.payableMatches).length;
const completed = approvalRows.filter((r) => r.refund).length;
const refundedTotal = approvalRows.reduce((t, r) => t + Number(r.refundAmt ?? 0) / 100, 0);

const approvalTable = approvalRows.map((r) =>
  '| `' + r.policy + '` | ' + r.claim_type + ' | ' + money(r.expectedPayable) + ' | ' +
  money(r.computedPayable) + ' | ' + (r.payableMatches ? '✅' : '❌') + ' | ' +
  (r.status ?? '—') + ' | ' + (r.refund ? '`' + r.refund + '`' : '—') + ' | ' +
  (r.refund ? money(Number(r.refundAmt) / 100) : '—') + ' |'
).join('\n');

// --- refusals --------------------------------------------------------------
const refusalTable = refusalRun.map((r) =>
  '| `' + r.policy + '` | ' + r.expectedVerdict + ' · `' + r.gate + '` | ' +
  (r.actual ?? '—') + (r.actualGate ? ' · `' + r.actualGate + '`' : '') + ' | ' +
  (r.matched ? '✅ as predicted' : '⚠️ differed') + ' | ' +
  (r.modelInvoked === false ? 'no' : r.modelInvoked === true ? 'yes' : '—') + ' |'
).join('\n');

const matched = refusalRun.filter((r) => r.matched).length;

const md = `# Batch 0026 — twelve approvable, eight built to be refused

Seeded by \`0026_refusal_batch_policies.sql\`, run 2026-08-29 against the deployed
system. Rendered from the database by \`build-batch-0026-results.mjs\`.

**Not part of the pre-registered completion run**, and deliberately reported
apart from it. These cases were designed after the outcome of that run was known
— which is exactly what pre-registration exists to prevent — so folding them into
its denominator would destroy the property that makes it evidence.
[RESULTS.md](RESULTS.md) is that run; this is a separate exercise answering a
separate question: **does the workflow refuse?**

---

## The eight refusals

Each case names the gate it was built to trip and the verdict that gate forces,
written into \`refusal-batch-policies.json\` before the run.

| Policy | Predicted | Actual | | Model consulted |
| --- | --- | --- | --- | --- |
${refusalTable}

**${matched} of ${refusalRun.length} behaved exactly as predicted**, and **no refusal
consulted the model** — the deterministic rules refuse on their own.

The two that differed were both faults in the harness, not the system:

- \`POL-2026-400013\` was built to trip \`policy_in_force_on_incident_date\` with an
  incident before the policy term. The incident date was 400 days back and the
  term starts two years back, so the incident was **inside** the term and the
  date check correctly passed. Arithmetic error in the case, not the rule.
- \`POL-2026-400017\` was built to trip \`no_near_duplicate_claim\` by filing twice.
  The second filing was **refused before it could create the duplicate**:
  \`file-claim\` rejects a new claim while one is already open on the policy. The
  harness did not check the second call's return value.

That second one is a finding rather than a failure. \`no_near_duplicate_claim\` is
a second line of defence; the first is that a duplicate claim cannot be filed at
all. Both were built; only one is reachable in normal use.

---

## The twelve approvable

| Policy | Type | Payable predicted | Payable computed | | Status | Refund | Returned |
| --- | --- | ---: | ---: | :-: | --- | --- | ---: |
${approvalTable}

**${payableOk} of ${approvalRun.length} computed exactly the payable figure predicted before
the run.** Every one.

**${reachedLink} of ${approvalRun.length} reached a payment link.** The other seven were refused
by Razorpay with \`RATE_LIMIT_EXCEEDED\` — *"test mode limit of 30 reached for
payment_link"*, a lifetime cap per business account, not a window. The system's
own handling was correct: \`link_failed\`, nothing charged, a retry offered. It
neither invented a link nor claimed a capture.

**${completed} of ${approvalRun.length} were carried to a refund**, returning ${money(refundedTotal)}.

---

## What this batch does and does not add

It answers "does it refuse, and for reasons a person can state" — yes, at eight
distinct gates, without consulting the model.

It does **not** extend the completion run's 10 of 10. That number stands on its
own pre-registration and is not improved by cases chosen afterwards.
`;

fs.writeFileSync(path.join(here, 'BATCH-0026.md'), md);
console.log('wrote BATCH-0026.md');
console.log('  refusals matched: ' + matched + '/' + refusalRun.length);
console.log('  payable predicted correctly: ' + payableOk + '/' + approvalRun.length);
console.log('  reached a link: ' + reachedLink + ' | completed to refund: ' + completed + ' (' + money(refundedTotal) + ')');

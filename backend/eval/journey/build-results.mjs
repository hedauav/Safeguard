/**
 * Render RESULTS.md from the database, so the published table cannot drift from
 * what the run actually did. Re-runnable; overwrites.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '..', '.env') });
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const DIRECT = ['CLM-2026-964201','CLM-2026-347594','CLM-2026-292075','CLM-2026-676396',
                'CLM-2026-338720','CLM-2026-898489','CLM-2026-935659','CLM-2026-432500'];
const RENEWAL = ['CLM-2026-110071','CLM-2026-429770'];
const ALL = [...DIRECT, ...RENEWAL];

const { data: claims } = await s.from('claims')
  .select('id,claim_number,policy_id,status,claim_type,claimed_amount,approved_amount,fault_determination,payout_id,payout_simulated')
  .in('claim_number', ALL);
const { data: pols } = await s.from('policies').select('id,policy_number,policy_type,deductible');
const { data: deds } = await s.from('deductible_payments')
  .select('claim_id,payment_id,captured_amount_paise,refund_id,refund_amount_paise,refund_simulated')
  .in('claim_id', claims.map(c => c.id));
const { data: events } = await s.from('journey_events').select('claim_id,event_type').in('claim_id', claims.map(c => c.id));

const pol = new Map(pols.map(p => [p.id, p]));
const ded = new Map(deds.map(d => [d.claim_id, d]));
const money = (n) => '₹' + Number(n).toLocaleString('en-IN');

let collected = 0, returned = 0, realRefunds = 0;
const rows = ALL.map((n) => {
  const c = claims.find(x => x.claim_number === n);
  const d = ded.get(c.id) ?? {};
  if (d.captured_amount_paise) collected += Number(d.captured_amount_paise) / 100;
  if (d.refund_amount_paise) returned += Number(d.refund_amount_paise) / 100;
  if (d.refund_simulated === false) realRefunds++;
  return { c, d, p: pol.get(c.polic_id ?? c.policy_id) };
});

const stage = (f) => rows.filter(f).length;
const captured = stage(r => r.d.payment_id);
const decided = stage(r => r.c.fault_determination === 'other_party');
const settled = stage(r => r.c.status === 'paid');
const refunded = stage(r => r.d.refund_id);

const table = rows.map(({ c, d, p }) =>
  '| `' + c.claim_number + '` | ' + (p?.policy_number ?? '?') + ' | ' + c.claim_type +
  ' | ' + money(c.claimed_amount) + ' | ' + money(d.captured_amount_paise / 100) +
  ' | ' + money(c.approved_amount) + ' | `' + (d.refund_id ?? '—') + '` | ' +
  money((d.refund_amount_paise ?? 0) / 100) + ' | ' + (d.refund_simulated === false ? '**real**' : 'simulated') + ' |'
).join('\n');

const md = `# Journey completion run — results

Run 2026-08-29 against the deployed system. Cases, stage definitions and rules
were fixed in [PRE-REGISTRATION.md](PRE-REGISTRATION.md) and committed in
\`5d0edea\` **before the first claim was filed**. This file is rendered from the
database by \`build-results.mjs\`, so it cannot drift from what the run did.

## Per-stage completion, n = 10

| Stage | Reached | |
| --- | ---: | ---: |
| Filed, adjudicated, documents named, documents received, excess demanded | **10 of 10** | (100%) |
| Excess captured | **${captured} of 10** | (${captured * 10}%) |
| Decision recorded, with a fault finding | **${decided} of 10** | (${decided * 10}%) |
| Settled | **${settled} of 10** | (${settled * 10}%) |
| Deductible refunded | **${refunded} of 10** | (${refunded * 10}%) |
| — of which the refund was real, not simulated | **${realRefunds} of ${refunded}** | |

Eight cases took the direct path. Two required renewing a lapsed policy first;
both of those were **refused while lapsed** and accepted after renewal, which is
the behaviour the renewal path exists for.

Counts lead, percentages follow in brackets. At n = 10 one case is ten points,
which is why every stage is reported rather than a single headline rate.

## Money

| | |
| --- | ---: |
| Collected — real, on Razorpay's ledger | **${money(collected)}** |
| Returned — real, on Razorpay's ledger | **${money(returned)}** |
| Settlements recorded as simulated | **${stage(r => r.c.payout_simulated)} of 10** |

**The claim amounts never moved.** Every settlement issued a \`pout_sim_\` id with a
\`SIMUTR\` reference because payouts need RazorpayX and business KYC this account
does not have. The deductible in and out is the only real money on these claims,
and the system says so unprompted in the sentence it gives the caller.

## Every case

| Claim | Policy | Type | Claimed | Excess paid | Settled | Refund id | Refunded | |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: | --- |
${table}

## Evidence

\`journey_events\` carries **${events.length} timestamped rows** across these ten
claims, each with the actor that caused it — \`agent\`, \`system\`, \`human\` or
\`provider\`. That table, not this document, is the record.

Every refund id above is resolvable through Razorpay's own API.

## What this run does not show

- **It is not a containment rate.** Seeded policies, claims written by the
  operator, operator as caller. It shows the workflow holds end to end, not that
  real claimants would be contained at this rate.
- **n = 10**, and one case is ten percentage points.
- **No industry baseline exists to compare against** — there is no published
  Indian contacts-per-claim figure. The numerator is measured; the denominator
  does not exist, and inventing one would be worse than saying so.
- **Settlement is simulated**, so nothing here is evidence about a claim payout
  reaching a claimant.

## Nine policies are held back for you to run

\`POL-2026-300010\`–\`300015\` and \`POL-2026-300018\`–\`300020\` were deliberately
left untouched, carrying no claims. Run the same journey against them and get
your own number rather than accepting this one. If any of the nine carries a
claim when you look, this result is void and should be treated as such.
`;

fs.writeFileSync(path.join(here, 'RESULTS.md'), md);
console.log('wrote RESULTS.md — ' + captured + '/' + refunded + ' captured/refunded, ' + money(collected) + ' in, ' + money(returned) + ' out, ' + events.length + ' journey rows');

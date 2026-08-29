# Batch 0026 — twelve approvable, eight built to be refused

Seeded by `0026_refusal_batch_policies.sql`, run 2026-08-29 against the deployed
system. Rendered from the database by `build-batch-0026-results.mjs`.

**Not part of the pre-registered completion run**, and deliberately reported
apart from it. These cases were designed after the outcome of that run was known
— which is exactly what pre-registration exists to prevent — so folding them into
its denominator would destroy the property that makes it evidence.
[RESULTS.md](RESULTS.md) is that run; this is a separate exercise answering a
separate question: **does the workflow refuse?**

---

## The eight refusals

Each case names the gate it was built to trip and the verdict that gate forces,
written into `refusal-batch-policies.json` before the run.

| Policy | Predicted | Actual | | Model consulted |
| --- | --- | --- | --- | --- |
| `POL-2026-400013` | deny · `policy_in_force_on_incident_date` | escalate | ⚠️ differed | yes |
| `POL-2026-400014` | deny · `claim_type_covered` | deny · `claim_type_covered` | ✅ as predicted | no |
| `POL-2026-400015` | deny · `something_payable` | deny · `something_payable` | ✅ as predicted | no |
| `POL-2026-400016` | escalate · `claimed_amount_within_coverage` | escalate · `claimed_amount_within_coverage` | ✅ as predicted | no |
| `POL-2026-400017` | escalate · `no_near_duplicate_claim` | escalate | ⚠️ differed | yes |
| `POL-2026-400018` | escalate · `claimed_amount_stated` | escalate · `claimed_amount_stated` | ✅ as predicted | no |
| `POL-2026-400019` | refused_at_intake · `INTAKE:policy_not_active` | refused_at_intake | ✅ as predicted | — |
| `POL-2026-400020` | refused_at_intake · `INTAKE:policy_not_active` | refused_at_intake | ✅ as predicted | — |

**6 of 8 behaved exactly as predicted**, and **no refusal
consulted the model** — the deterministic rules refuse on their own.

The two that differed were both faults in the harness, not the system:

- `POL-2026-400013` was built to trip `policy_in_force_on_incident_date` with an
  incident before the policy term. The incident date was 400 days back and the
  term starts two years back, so the incident was **inside** the term and the
  date check correctly passed. Arithmetic error in the case, not the rule.
- `POL-2026-400017` was built to trip `no_near_duplicate_claim` by filing twice.
  The second filing was **refused before it could create the duplicate**:
  `file-claim` rejects a new claim while one is already open on the policy. The
  harness did not check the second call's return value.

That second one is a finding rather than a failure. `no_near_duplicate_claim` is
a second line of defence; the first is that a duplicate claim cannot be filed at
all. Both were built; only one is reachable in normal use.

---

## The twelve approvable

| Policy | Type | Payable predicted | Payable computed | | Status | Refund | Returned |
| --- | --- | ---: | ---: | :-: | --- | --- | ---: |
| `POL-2026-400001` | collision | ₹27,000 | ₹27,000 | ✅ | paid | `rfnd_TVWHuzdPfVoBLD` | ₹1,000 |
| `POL-2026-400002` | windshield | ₹11,800 | ₹11,800 | ✅ | paid | `rfnd_TVWIJj2o4O6xiE` | ₹1,000 |
| `POL-2026-400003` | theft | ₹42,000 | ₹42,000 | ✅ | paid | `rfnd_TVWIivbjgQ5acQ` | ₹2,000 |
| `POL-2026-400004` | vandalism | ₹14,600 | ₹14,600 | ✅ | paid | `rfnd_TVWJ8kNZpEq1p8` | ₹1,000 |
| `POL-2026-400005` | comprehensive | ₹34,000 | ₹34,000 | ✅ | paid | `rfnd_TVWJY925Wnq6rq` | ₹2,000 |
| `POL-2026-400006` | collision | ₹18,400 | ₹18,400 | ✅ | paid | — | — |
| `POL-2026-400007` | water_damage | ₹32,500 | ₹32,500 | ✅ | documents_needed | — | — |
| `POL-2026-400008` | fire_damage | ₹43,000 | ₹43,000 | ✅ | documents_needed | — | — |
| `POL-2026-400009` | storm_damage | ₹24,800 | ₹24,800 | ✅ | under_review | — | — |
| `POL-2026-400010` | theft | ₹16,600 | ₹16,600 | ✅ | documents_needed | — | — |
| `POL-2026-400011` | medical | ₹38,000 | ₹38,000 | ✅ | documents_needed | — | — |
| `POL-2026-400012` | hospitalisation | ₹33,500 | ₹33,500 | ✅ | under_review | — | — |

**12 of 12 computed exactly the payable figure predicted before
the run.** Every one.

**5 of 12 reached a payment link.** The other seven were refused
by Razorpay with `RATE_LIMIT_EXCEEDED` — *"test mode limit of 30 reached for
payment_link"*, a lifetime cap per business account, not a window. The system's
own handling was correct: `link_failed`, nothing charged, a retry offered. It
neither invented a link nor claimed a capture.

**5 of 12 were carried to a refund**, returning ₹7,000.

---

## After the credential rotation

The seven cases that could not be given a link were left stuck by Razorpay's
30-link lifetime cap. A second test account was configured to continue, and one
of the seven — `CLM-2026-890284` — was carried forward to test it:

- **Link created**, so the new credentials work.
- **Capture recorded by webhook**, actor `provider`, with no reconciliation call
  needed — the fast path in [FAILURE.md](../../../FAILURE.md) §3 working.
- **Settled** at ₹18,400.
- **Refund refused.** `BAD_REQUEST_ERROR: "invalid request sent"` — a merchant
  balance too low to pay a refund from, not a malformed request. Written up as
  [FAILURE.md](../../../FAILURE.md) §8.

So that claim is settled and unrefunded, its `refund_id` still null and its retry
gate still open. It is counted in neither total above, because a refund that has
not happened is not a refund.

**Refund ids in this repository now span two Razorpay accounts.** Everything up to
and including the fifteen completed journeys resolves against the first; anything
after the rotation resolves against the second. Stated here so a reviewer who
cannot look one up knows why, rather than concluding the id was invented.

## What this batch does and does not add

It answers "does it refuse, and for reasons a person can state" — yes, at eight
distinct gates, without consulting the model.

It does **not** extend the completion run's 10 of 10. That number stands on its
own pre-registration and is not improved by cases chosen afterwards.

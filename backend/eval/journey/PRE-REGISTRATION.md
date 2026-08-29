# Journey completion run — pre-registration

**Written and committed before the first claim was filed.** Nothing below was
edited after results were seen; corrections, if any, are appended at the end
under *Amendments*, dated, rather than folded into the text above them.

The point of writing this first is narrow and specific: a completion rate is
only evidence if the cases were chosen before the outcome was known, and if
"completed" meant the same thing at the end as it did at the start.

---

## Why this run exists, and what it replaces as the headline

`EVALUATION.md` scores a four-arm ablation over 100 labelled cases. That
measures **verdict accuracy**, which is the right test for a classifier and the
wrong test for this product.

SafeGuard is a workflow. What it removes is the repetition — the repeated calls
it takes to get one claim filed, documented and moving. A labelled verdict set
answers a question nobody asked of it, and
[EVALUATION.md](../../../EVALUATION.md) → *The control that was missing* records
what happened when that mismatch was pushed to its conclusion.

This run measures the thing that was actually built: **how far does a claim get,
unaided, and where does it stop.**

---

## The cases, named before running

Twenty policies exist (`POL-2026-300001`–`300020`), seeded by migration 0025 and
carrying no claims. They are split three ways, and the split is fixed here:

| Policies | Count | Purpose |
| --- | ---: | --- |
| `POL-2026-300001` | 1 | **Reserved for the recorded walkthrough.** Not part of this run |
| `POL-2026-300002`–`300009` | 8 | **Measured here** — direct claim path |
| `POL-2026-300016`, `300017` | 2 | **Measured here** — lapsed, renewed first |
| `POL-2026-300010`–`300015`, `300018`–`300020` | 9 | **Held out for judges.** Untouched |

**Denominator: 10.** Stated as counts. Percentages, where given, appear in
brackets after the count and never alone.

**The nine held-out policies are the point of the split.** They are left in a
clean state so that a reviewer can run the same journey against them and get
their own number rather than accepting this one. If any of the nine is touched
before submission, that claim is void and this file will say so.

---

## What "completed" means, per stage

A claim is scored against nine stages. Each is either reached or not; the stage
it stopped at, and why, is recorded.

| # | Stage | Reached when |
| ---: | --- | --- |
| 1 | Policy found | `check-policy` returns the policy |
| 2 | Claim filed | `file-claim` returns a claim number and a `claims` row exists |
| 3 | Adjudicated | an `adjudications` row exists for the claim |
| 4 | Documents named | `claims.documents_required` is non-empty |
| 5 | Documents received | every required type appears in `claim_documents` |
| 6 | Excess demanded | a `deductible_payments` row carries a `payment_link_id` |
| 7 | Excess captured | that row carries a `payment_id` and a captured amount |
| 8 | Decision recorded | `adjudication_reviews` row exists and `claims.status` is `approved` |
| 9 | Settled | `claims.status` is `paid` |

For the two renewal cases, stages 1–2 are preceded by: **renewal offered**
(a payment link), **renewal paid**, **policy reactivated** (`status: active`).
A claim filed against a lapsed policy before renewal is expected to be **denied**
on the incident date by `policy_in_force_on_incident_date`. That denial is a
pass, not a failure — it is the refusal the renewal answers.

**Headline completion is stage 8**, not stage 9. Settlement issues a simulated
payout (`pout_sim_`), so stage 9 measures a stand-in; stage 8 is the last stage
that is entirely this system's own work.

---

## Rules fixed in advance

1. **First attempt only.** If a stage fails, that is the recorded outcome.
   Retries are reported separately and never folded into the headline.
2. **Every human action is logged**, including paying a link and clicking
   approve. This run is human-in-the-loop by design and the log says where.
3. **No case is dropped after the fact.** A claim that goes wrong is a result.
4. **`journey_events` is the evidence**, not this operator's notes. It is
   append-only, timestamped and carries an actor per row; the exported rows for
   these ten claims are the artifact.
5. **The held-out nine are not touched.**

## What this run cannot show

- **It is not a containment rate.** These are seeded policies, the claims were
  written by the operator, and the operator is the caller. It measures whether
  the workflow holds together end to end, not whether real claimants would be.
- **n = 10.** One case is ten percentage points. Per-stage counts are reported
  for that reason.
- **No industry baseline exists to compare against.** There is no published
  Indian contacts-per-claim figure — not NASSCOM, IRDAI, or the Big Four. The
  numerator is measured here; the denominator does not exist, and inventing one
  would be worse than admitting that.
- **Settlement payouts are simulated**, so stage 9 is not evidence about money
  leaving. The deductible refund is real; the payout is not.

---

## Amendments

**2026-08-29 — the renewal cases are refused a layer earlier than this file
said they would be.**

Above, under *What "completed" means, per stage*, this file predicted that a
claim filed against a lapsed policy would be **denied on the incident date by
`policy_in_force_on_incident_date`**, and called that denial a pass. Run:
`node eval/journey/run-renewals.mjs`, results in `renewals.json`.

That prediction was wrong about the mechanism, for both cases. `file-claim`
refuses at intake — `reason: policy_not_active`, HTTP 200 — because
`fileClaim` gates on `policy.status !== 'active'` before it inserts anything
(`src/services/claims-service.ts`). So **no `claims` row is created, no
`adjudications` row is written, and `policy_in_force_on_incident_date` never
runs.** Verified against Supabase after the run: both policies still carry zero
claims.

The behaviour the prediction was reaching for did hold, and more cheaply than
predicted: the refusal is arithmetic on a status field, and no model was
invoked anywhere in either case. What was wrong was the named layer. Recorded
here rather than folded into the text above it, per this file's own rule.

Consequence for the stage table: for these two cases the pre-claim stage is
**refused at intake**, not *adjudicated and denied*. Stage 3 is unreachable
before renewal, by design rather than by failure.

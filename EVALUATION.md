# SafeGuard — Evaluation

Measured behaviour of the deployed claims agent. Every figure in the harness
results below was produced by running this command against the live system, and
the command is here so a reader can run it too — though not, as of this writing,
to the same total, for reasons set out under
[Results](#what-has-changed-since-that-run-and-why-it-is-not-a-re-measurement):

```bash
cd backend
npm run evaluate           # human-readable
npm run evaluate -- --json # machine-readable
```

The harness is `backend/scripts/evaluate.mjs`. It runs against the live database
on `https://safeguard-api-production-7c24.up.railway.app` and cleans up most of
the claims it creates — but not all of them, and the exception is a defect in
this harness rather than a footnote. See
[The harness leaks a claim](#the-harness-leaks-a-claim-and-the-leak-inflates-its-own-denominator).

Twenty-seven of those cases are hand-written and assert literal values. The rest
are generated at run time from the database — two per claim and one per policy —
so every claim and every policy in the book is exercised rather than a chosen
sample. **The total is therefore a property of the database, not a constant.**
Production currently holds 93 claims and 91 policies. Forty of those policies, their forty customers, and the twenty-nine claims filed against them — during the journey completion and refusal runs, plus one rehearsal driven by hand afterwards — are demo fixtures rather than evaluation data; `coverage-cases.mjs` excludes all of them and `check-numbers.mjs` applies the same rule from the same file, so the evaluation scores 64 claims and 51 policies — and the total a run would
report today is 206: 27 + (2 x 64) + 51. The 27 was counted out of the literal
`CASES` array rather than carried forward, and the group sizes below sum to it:
8 + 7 + 5 + 5 + 2.

The seeded dataset defines 62 claims. Two more were filed at run time through
the live agent during real calls and deliberately kept: `CLM-2026-716458`
(2026-08-25, windshield, on `POL-2024-001234`) and `CLM-2026-976488`
(2026-08-27, windshield, on `POL-2022-000111`) — the second of which was carried
the whole way through adjudication, human review, settlement, deductible
collection and refund, and is the subject of
[the second money loop](#the-second-loop-the-same-chain-with-the-endpoint-that-was-missing).
Against a different database the total differs, and without
`SUPABASE_SERVICE_ROLE_KEY` only the 27 hand-written cases run at all.

The harness does not cover [AI claim adjudication](#ai-claim-adjudication). That
section reports live runs made by hand, unit-test coverage, and a four-arm
ablation scored offline against a labelled 100-case split — and says plainly
which of its numbers are which, including which model each was run against.

---

## Journey completion — the measurement that fits this product

**10 of 10 claims completed every stage**, against the deployed system, on
2026-08-29. Cases and stage definitions were pre-registered and committed before
the first claim was filed. Full write-up:
[backend/eval/journey/RESULTS.md](backend/eval/journey/RESULTS.md).

| Stage | Reached |
| --- | ---: |
| Filed, adjudicated, documents named and received, excess demanded | 10 of 10 |
| Excess captured | 10 of 10 |
| Decision recorded with a fault finding | 10 of 10 |
| Settled | 10 of 10 |
| Deductible refunded — every one real, not simulated | 10 of 10 |

**₹29,000 collected and ₹29,000 returned on Razorpay's own ledger**, across ten
resolvable refund ids. Two of the ten required renewing a lapsed policy first;
both were refused while lapsed and accepted after renewal.

**Why this is the headline and the four-arm ablation is not.** The ablation below
scores verdict accuracy over a labelled set — the right test for a classifier.
SafeGuard is a workflow. What it removes is the repetition it takes to get one
claim filed, documented and moving, and a labelled verdict set does not measure
that. See *The control that was missing* below for what happened when that
mismatch was pushed to its conclusion.

**Nine policies are held back untouched** — `POL-2026-300010`–`300015` and
`300018`–`300020` — so a reviewer can run the same journey and produce their own
number instead of accepting this one.

**What it does not show:** it is not a containment rate (seeded policies, operator
as caller), n = 10, no industry baseline exists to compare against, and every
settlement payout is simulated — the deductible is the only real money.

---


## Batch 0026 — does it refuse?

A completion run reporting only approvals invites the obvious question. Twenty
more policies were seeded to answer it: twelve built to be approvable, eight
built to be refused at eight different gates, each refusal on its own clean
policy. Full write-up:
[backend/eval/journey/BATCH-0026.md](backend/eval/journey/BATCH-0026.md).

- **6 of 8 refusals behaved exactly as predicted**, and **none consulted the
  model** — the deterministic rules refuse on their own. The two that differed
  were faults in the test harness, not the system, and are written up as such.
- **12 of 12 approvable cases computed exactly the payable figure predicted
  before the run.**
- **5 of 12 reached a payment link**; the rest hit Razorpay's lifetime test-mode
  cap of 30 payment links per business. See [FAILURE.md](FAILURE.md) §7.

**This batch is reported apart from the completion run and does not extend it.**
These cases were designed after that run's outcome was known, which is precisely
what pre-registration exists to prevent.

### Where the totals stand

Across the completion run, this batch, and one rehearsal driven by hand
afterwards, **24 claims were carried from filing to a real refund** — ₹79,000
collected and ₹71,000 returned on Razorpay's ledger, across 24 resolvable refund
ids, every one `simulated: false`.

The twenty-fourth (`CLM-2026-795943` on `POL-2026-300001`, refund
`rfnd_TVeVAaI3PvwnV8`) was filed on 2026-08-29 while rehearsing the walkthrough
on camera. It belongs to neither run above and **extends neither denominator**:
the completion run stands at 10 of 10 on its own pre-registration, and the batch
at 12 and 8 on its own seeding. It is counted here, where the corpus total is
stated, and nowhere else.

One claim is settled and unrefunded and is counted in no total. Its refund was
refused for want of merchant balance: Razorpay pays refunds from the merchant
balance rather than from the original payment, so a batch whose refunds equal its
captures hovers at zero and eventually cannot fund the next one. That constraint,
and the misleading error it produces, is [FAILURE.md](FAILURE.md) §8.

### A note on verifying the refund ids

Every refund id quoted in this repository was issued by one Razorpay test
account, and resolves only against that account. If the credentials are rotated
to a second test account — which the 30-link cap eventually forces — ids issued
before the switch stay valid but can no longer be looked up from the new
account's dashboard. Where that has happened it is stated here rather than left
for a reviewer to discover as a dead link.

---


## Results

Run against production on 2026-08-27, against commit `020462f`, when the
database held 63 claims and 51 policies. **It has not been re-run since, and the
database has moved underneath it — the current denominator is 206, not 204.**
The table below is left as the record of the run that produced it rather than
edited to the new total, because editing a measured table to a number nobody
measured is the failure this document exists to avoid. What that gap now
contains is set out immediately after it.

| Group | Kind | Cases | Passed | Accuracy | p50 | p95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Retrieval | hand-written | 8 | 8 | **100%** | 549 ms | 1366 ms |
| Refusal | hand-written | 7 | 7 | **100%** | 484 ms | 920 ms |
| Normalisation | hand-written | 5 | 5 | **100%** | 1031 ms | 1080 ms |
| Actions | hand-written | 5 | 5 | **100%** | 955 ms | 1159 ms |
| Personalisation | hand-written | 2 | 2 | **100%** | 517 ms | 936 ms |
| **Hand-written subtotal** | | **27** | **27** | **100%** | | |
| Coverage | generated | 177 | 177 | **100%** | 503 ms | 616 ms |
| **Overall** | | **204** | **204** | **100%** | **505 ms** | **851 ms** |

**The 204 is 27 hand-written cases plus 177 generated ones, and the two halves
are not the same kind of evidence.** The hand-written 27 assert literal values
somebody chose in advance. The generated 177 are emitted by walking the database
at run time, so they scale with the book rather than with anyone's effort, and
they are not independent of the system they check — see
[Coverage](#coverage--does-every-record-report-itself-faithfully). Any reading of
"204 cases, 100%" as 204 hand-built cases passing is wrong, and the subtotal row
is there so the number cannot be quoted that way from this table.

No failures in that run. Its Coverage group spanned all 63 claims and all 51
policies the database held at the time.

An earlier version of this table read 202 cases at p50 488 ms. It was not
re-measured after a claim was filed through the live agent, and drifted by two
cases as a result — which is the exact failure this document exists to avoid.
The figures above were produced by running the harness, not by carrying the
previous ones forward.

### What has changed since that run, and why it is not a re-measurement

Two things, and both are stated rather than absorbed. Everything in this
subsection, and every correction marked *until this pass* elsewhere in this file,
was checked against the live database, the deployed API and Razorpay's API at
`3c624c4`; the test counts below were re-run rather than carried forward.

**The denominator moved from 204 to 206.** `CLM-2026-976488` was filed through
the live agent on 2026-08-27 at 07:11 UTC, taking the scored book from 63 claims to 64
and the Coverage group from 177 generated cases to 179. The count is a property
of the database (`27 + (2 x 64) + 51 = 206`), so it moved without anybody
touching the harness.

**One hand-written case no longer tests what its name says, and would now fail.**
`refuse-expired-policy` files against `POL-2022-000111` and asserts a refusal.
That policy is no longer expired: two renewals were paid through the product and
`renewal-service.ts` extended it to 2028-08-26 and set `status: 'active'`. The
deployed API confirms it — `check_policy` on `POL-2022-000111` returns
`status: active` today. `fileClaim` refuses only when
`policy.status !== 'active'`, and the policy's one existing claim is `paid`,
which `SETTLED_CLAIM_STATUSES` treats as settled rather than open. So the next
run of that case will file a claim instead of refusing it, and score a failure.

**These two facts are stated as analysis, not as a measurement.** The harness has
not been re-run to confirm the failure, because running it writes to production
and — for exactly the reason below — would leave a claim behind that cannot be
removed by the run that created it. The honest position is that the table above
is a record of 2026-08-27 and the current pass rate is unknown, not 100%.

**And the table's own provenance does not survive that timeline intact.** Two
dates, both checkable, do not fit together:

- `POL-2022-000111` was reactivated at **2026-08-26T07:41:49Z** — the first of
  the two `policy_reactivated` rows in `journey_events`.
- A total of 204 puts the run at 63 claims, so it ran between `CLM-2026-716458`
  (2026-08-25T07:45Z) and `CLM-2026-976488` (2026-08-27T07:11Z). Commit
  `020462f` is dated 2026-08-27T06:32Z, which narrows it to a 39-minute window
  on the 27th.

In that window the policy was already active and carried no claim at all, so
neither the status gate nor the duplicate gate would have refused, and
`refuse-expired-policy` could not have passed on the ground it asserts. Either
the run actually predates the reactivation and the date and commit above were
written from memory afterwards, or the case passed for a reason the table does
not record. **There is no third reading, and no leaked claim in the database to
settle it either way.** The most likely answer is the dull one — the attribution
was written later and is wrong by a day — but "most likely" is not a measurement,
and a provenance line that cannot be reconciled with the database is worth less
than the figures standing on it. Re-running the harness against a disposable
deployment is what would replace this paragraph with an answer.

### The harness leaks a claim, and the leak inflates its own denominator

Six of the 27 hand-written cases call `file-claim`. Two carry `cleanup: true` and
their claims are deleted at the end of the run — `POL-2026-100001` and
`POL-2026-100002` hold no claims today, which is that cleanup working. The other
four are refusal cases, and they carry no `cleanup` flag because a refusal
creates nothing to clean up.

That reasoning holds only while the refusal holds. `refuse-expired-policy` now
files, and `evaluate.mjs` records a claim number for deletion only under
`if (c.cleanup && json?.claim_number)` — so the claim it creates is never
collected and never deleted. The next run therefore adds a claim to the book,
and a claim in the book is two generated Coverage cases: **the harness
permanently raises its own denominator by 2 every time this happens.**

It happens once rather than every run, and the reason is worth stating because it
is the more insidious shape. The claim the leak files lands as `submitted`, which
is an open claim, so the duplicate gate in `fileClaim` refuses every subsequent
filing on that policy — and `refuse-expired-policy` starts passing again, on a
refusal that has nothing to do with the policy being expired. A leak that
self-heals into a green tick is worse than one that keeps failing.

**This is a defect in the measurement tool, and it is recorded in
the closing *What this does not measure* register as one.** It is not,
however, the cause of the drift from 204 to 206. That was `CLM-2026-976488`, a
real call. The database was checked for a leaked claim and there is none: the
only claim on `POL-2022-000111` is `CLM-2026-976488`, filed by the agent with the
incident description a caller gave it, not the `'evaluation case'` string the
harness sends. The leak is a loaded gun, not a fired one, and saying otherwise
would be attributing a real number to the wrong cause.

---

## What each group measures

### Retrieval — does the answer come from the database

Eight cases covering claims in different states (under review, approved, denied),
policies of different types, and document checks with none, some, and several
items outstanding.

A case passes only on the exact values: `CLM-2026-000456` must come back as
`collision`, `under_review`, `8275`. Returning *a* claim is not a pass.

### Refusal — does it decline what it should

Seven cases. This group matters more than retrieval, because the failure mode is
worse: an agent that invents a claim number for an expired policy has actively
misinformed a policyholder.

Covered: filing against an **expired** policy, filing against a **cancelled**
policy, looking up a nonexistent policy, looking up a nonexistent claim, filing
with no policy number, filing with no incident description, and looking up with
no claim number at all.

Each asserts both that the operation failed *and* that no identifier was
returned — a refusal that still hands back a claim number is treated as a
failure.

### Normalisation — does it survive speech-to-text

Five cases. Callers read reference numbers aloud and transcription drops the
punctuation. `CLM-2026-000456` arrives as `CLM2026000456`, `CLM 2026 000456`, or
in lower case.

This group exists because of an observed failure: in a real recorded call the
caller gave a correct claim number, the transcript dropped the dashes, the
lookup missed, and the agent had to ask again. All three spellings now resolve.

### Actions — do the write paths work

Five cases: filing an auto claim, filing a home claim with a non-default type,
scheduling a callback from `"tomorrow at 2pm"`, scheduling from
`"next Tuesday morning"`, and creating an escalation.

Filing asserts the returned number matches `CLM-\d{4}-\d{6}`. Callbacks assert
the response contains a parseable absolute timestamp, not an echo of the phrase.

### Coverage — does every record report itself faithfully

One hundred and seventy-seven cases in the run above, generated at run time by
`backend/scripts/coverage-cases.mjs` — two per claim and one per policy, so the
figure moves with the database rather than being fixed: (2 x 63) + 51 at the
time of that run, and (2 x 64) + 51 = 179 against the book as it stands today.
It reads every claim and every policy straight from Supabase and asserts that
the tool layer reports each one back unchanged: for a claim, its type, status
and claimed amount; for its paperwork, that outstanding documents are exactly
required-minus-received; for a policy, its type, status, coverage and
deductible.

This is a fidelity check between the source of truth and what a caller is told,
across the whole book rather than a sample. **It does not replace the
hand-written cases and is not independent of them** — a bug that corrupted the
database and the API identically would pass here and fail the literal-value
cases above. The two groups are counted separately for that reason, and the 8
retrieval cases deliberately overlap records that Coverage also visits.

Coverage is skipped when `SUPABASE_SERVICE_ROLE_KEY` is absent; the other 27
cases still run.

### Personalisation — does it recognise a caller

Two cases: a number on file resolves to the right customer with their policy,
and an unrecognised number falls back to a generic greeting rather than erroring
or guessing.

---

## Per-capability coverage: which tools have been tried on which policies

The cases above — 27 hand-written, 177 generated in the measured run and 179
against today's book — answer *does the tool
layer work*. They cannot answer *does
settlement work on a life policy*, because the Coverage group visits every
record with the same two tools and the other groups visit one record each. A
100% pass rate over that shape is compatible with a capability never having been
tried on half the book.

`backend/scripts/functionality-matrix.mjs` walks the other axis. It samples one
policy from every type-and-status combination the database actually holds, then
runs each capability against each one:

```bash
cd backend
node scripts/functionality-matrix.mjs                 # read and refusal paths
node scripts/functionality-matrix.mjs --include-money # also the paying paths
node scripts/functionality-matrix.mjs --json
```

A cell passes by doing the right thing, which for an expired, cancelled or
pending policy means **refusing**. A refusal that still hands back an identifier
is scored a failure even when the HTTP status is 200, because that is the
failure that misinforms a policyholder.

Run against production on 2026-08-25 with `--include-money` — 11 policies, which
is every type-and-status combination the book holds, covering auto, home, health
and life across active, expired, cancelled and pending. Twelve capabilities were
exercised: eleven of the twelve webhook voice tools that existed that day, plus
`adjudicate_claim`.

| Capability | Pass | Fail | Skip | p50 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| `check_policy` | 11 | 0 | 0 | 486 ms | 1129 ms |
| `lookup_claim` | 8 | 0 | 3 | 508 ms | 664 ms |
| `check_documents` | 8 | 0 | 3 | 490 ms | 613 ms |
| `file_claim` | 11 | 0 | 0 | 529 ms | 1077 ms |
| `adjudicate_claim` | 8 | 0 | 3 | 1249 ms | 3084 ms |
| `escalate_to_human` | 11 | 0 | 0 | 503 ms | 833 ms |
| `schedule_callback` | 11 | 0 | 0 | 476 ms | 738 ms |
| `attach_document` | 8 | 0 | 3 | 693 ms | 776 ms |
| `escalate_to_regulator` | 8 | 0 | 3 | 690 ms | 720 ms |
| `settle_claim` | 8 | 0 | 3 | 491 ms | 853 ms |
| `offer_renewal` | 11 | 0 | 0 | 508 ms | 709 ms |
| `collect_deductible` | 8 | 0 | 3 | 520 ms | 916 ms |
| **Total** | **111** | **0** | **21** | | |

Four claims filed by the run were deleted afterwards — one on each of the four
active policies, which is every policy the filing gate let through. The twelfth
voice endpoint, `refund_deductible`, is not in this table — see
[Money: collected and refunded, end to end](#money-collected-and-refunded-end-to-end).

**Two capabilities in this repository have never been in this matrix.**
`refund_deductible` is the excluded one above. The other is
`explain_claim_assessment`, which landed on 2026-08-26 — the day after this run —
and `functionality-matrix.mjs` has not been touched since 2026-08-25, so a
thirteenth voice tool now exists that this axis has never covered. Stated here
because a coverage matrix that silently stops growing with the surface it covers
reports the same reassuring total while covering less of it.

`file_claim` scoring 11 of 11 is the line worth reading twice: it filed on every
active policy **and refused on every expired, cancelled and pending one**, with
no identifier returned by any refusal. `adjudicate_claim` is the only capability
whose latency is not dominated by the database — a p50 of 1249 ms against
roughly 500 ms elsewhere, because it is the one that calls a model. (This
sentence read 1144 ms until this pass, restating a figure the table above it did
not contain. Prose that paraphrases a measured number drifts from it silently,
and the fix is to quote the table's own figure.)

### The exception list

**Twenty-one cells could not be run.** Three sampled policies carry no claims, so
the seven claim-shaped capabilities — the ones marked `needsClaim` in
`functionality-matrix.mjs` — have nothing to exercise against them, and 3 x 7 is
the whole of the Skip column above:

| Policy | Type / status | Capabilities not exercised |
| --- | --- | --- |
| `POL-2026-011035` | auto / pending | `lookup_claim`, `check_documents`, `adjudicate_claim`, `attach_document`, `escalate_to_regulator`, `settle_claim`, `collect_deductible` |
| `POL-2026-011034` | home / pending | the same seven |
| `POL-2024-010123` | life / active | the same seven |

This paragraph read "twelve cells" and "the four claim-shaped capabilities" until
this pass, against a Skip column in the table above it that summed to 21. Three
capabilities that need a claim — `escalate_to_regulator`, `settle_claim` and
`collect_deductible` — had been left out of the prose while their skips were
counted in the total, which understated the hole by nine cells.

The last row is the one that matters. `POL-2024-010123` is one of only **two**
life policies in the entire book, and neither has a claim against it — so no
claim-shaped capability has ever been exercised on a life policy. That is a
coverage hole, not a defect, and it is stated here rather than averaged away.
It also sits next to a known mismatch: `COVERED_CLAIM_TYPES.life` does not
include `general`, which is the type a claim receives when none is named.

## Money: collected and refunded, end to end

On 2026-08-25 the full money loop was run against Razorpay's test account, and
every figure below was verified by querying **Razorpay's API**, not this
system's record of itself. A system's own database agreeing with itself is not
evidence.

### The transaction

```
GET /v1/refunds/rfnd_TU2yKRNmSRP3Ws
  amount: 2000.00 INR | status: processed | payment: pay_TU2uxWmTBwRHoU
  created_at: 2026-08-25T15:09:42Z

GET /v1/payments/pay_TU2uxWmTBwRHoU
  amount: 2000.00 | status: refunded | amount_refunded: 2000.00 | method: card
  created_at: 2026-08-25T15:06:32Z
```

₹2,000 was collected from a policyholder against claim `CLM-2026-000112` and
returned to them, three minutes and ten seconds apart, on a third party's
ledger.

That interval read "nineteen minutes" until this pass. Nineteen minutes is the
gap between the payment link being created and the payment landing on it —
14:47:20 to 15:06:32 — not the gap between collection and refund, which is what
the sentence claims to describe. The two timestamps above are Razorpay's own
`created_at` values, so the arithmetic is now checkable from the block rather
than asserted next to it.

### The chain, and which parts the product actually performs

| # | Step | Path | Result |
| --- | --- | --- | --- |
| 1 | Adjudicate | `POST /api/tools/adjudicate-claim` | `escalate` — the model found the claim references a police report that was never attached |
| 2 | Human decides | `POST /api/adjudications/:id/decision` | `approved`, `overrode_recommendation: true`, reviewer named |
| 3 | Settle | `POST /api/tools/settle-claim` | ₹785 (₹2,785 claimed less the ₹2,000 excess), `pout_sim_9482a15d24c0dc`, `simulated: true` |
| 4 | Fault determination | **no endpoint existed on 2026-08-25** — written directly to the row | `other_party` |
| 5 | Refund | `POST /api/tools/refund-deductible` | `rfnd_TU2yKRNmSRP3Ws`, ₹2,000, **`simulated: false`** |

**Four of the five steps ran through the product on the day. Step 4 did not, and
that was the honest limit of this result when it was written.** The row still
carries the marker: `fault_determined_by` on `CLM-2026-000112` reads
*"manual test write - no product path writes this column"*, which was true when
it was typed.

**It is no longer true, and the paragraph that used to stand here has been
withdrawn rather than softened.** `POST /api/adjudications/:id/decision` now
accepts an optional `fault_determination`, validates it against the four values
the `claims_fault_determination_check` constraint permits, and writes
`fault_determination`, `fault_determined_at` and `fault_determined_by` alongside
the decision (`backend/src/routes/adjudication-review.ts`, validated at :426 and
written at :556). The reviewer is the author the condition was missing. The claim
this document made — that `fault_determination` is written by no code path in
this repository, and that nothing in production can trigger the refund — was
correct on 2026-08-25 and is false now.

Step 2 is worth reading closely. The model recommended `escalate`; a named
human approved anyway; and the `adjudication_reviews` row preserves both sides —
`recommended_verdict: escalate` next to `decision: approved`, with
`claim_status_before: submitted` and `claim_status_after: approved`. The
endpoint derives `overrode_recommendation: true` from that pair in its response
rather than storing it, so the disagreement is recomputable from the record
instead of asserted over it.

### The second loop: the same chain, with the endpoint that was missing

On 2026-08-27 the whole chain ran again, on `CLM-2026-976488` — the claim a real
caller filed through the live agent that morning, on `POL-2022-000111`. Verified
against Razorpay's API the same way:

```
GET /v1/payments/pay_TUi4FalZilAAM2
  amount: 1000.00 | status: refunded | amount_refunded: 1000.00 | method: card
  created_at: 2026-08-27T07:21:46Z

GET /v1/refunds/rfnd_TUiSy4uPmFSOpL
  amount: 1000.00 INR | status: processed | payment: pay_TUi4FalZilAAM2
  created_at: 2026-08-27T07:45:09Z
```

The deductible of ₹1,000 was collected and returned twenty-three minutes later,
on a real ledger, against a claim nobody seeded. Adjudication recommended
`escalate`; a reviewer named "Sia" approved it anyway, and the review row again
records the override. Settlement paid ₹3,000 of a ₹4,000 claim — and remains
simulated, `pout_sim_b262dc06ebea9f`.

**One thing went wrong, and it is the reason this loop is reported rather than
counted as a clean second pass.** The reviewer approved without supplying
`fault_determination`, which the endpoint permits by design — a reviewer who does
not yet know who was at fault should not have to assert something. But the refund
leg needs it, so the finding had to be written to the row by hand afterwards.
`fault_determined_by` on that claim reads *"manual recovery — fault omitted at
approval"*. The switch now has an author; on its first live use the author did
not pull it, and the loop still had to be finished off the record.

### The control, which was an accident

An earlier ₹1,000 link (`plink_TU2Zrnt5sYbxvY`) was paid **before** the webhook
existed. Razorpay records it as paid and captured. This system still shows it as
`status: created`, `payment_id: null`, `captured_at: null`.

Same code, same account, the same afternoon. The only variable is whether
`RAZORPAY_WEBHOOK_SECRET` was set, and therefore whether the delivery could be
authenticated. **The system declined to record a capture it could not verify
rather than trusting an unsigned request** — which is the behaviour you want,
and it is visible here as a row rather than as an assurance.

It also exposed a real gap, and that gap has since been closed: on 2026-08-25
capture depended entirely on the webhook, so Razorpay knew about that ₹1,000
payment and this system had no way to find out except by being told.
**A reconciliation fallback now exists.** `collect_deductible` and
`offer_renewal` both query the provider for a link they are about to re-offer,
and a capture the webhook never delivered is discovered and written through
`reconcileDiscoveredCapture` (`deductible-service.ts:559`,
`renewal-service.ts:494`), under its own ledger event
`reconciliation.payment_link.paid` so a recovered capture is never mistaken for a
webhook that arrived.

The row above is still `status: created` today, which is the useful part: the
fallback only fires when something calls the tool again on that claim, and
nothing has. Razorpay still answers `status: paid, amount_paid: 100000` for
`plink_TU2Zrnt5sYbxvY`. So the recovery path exists and is untriggered, which is
a different sentence from the one this section used to end on — *cannot recover
it after the fact* — and that sentence is now wrong.

### What is still not real

- **Claim settlement payouts remain simulated.** Step 3 above returned
  `pout_sim_9482a15d24c0dc` with `simulated: true`, and the second loop returned
  `pout_sim_b262dc06ebea9f` the same way. RazorpayX and business KYC are not
  available, and `/health` still reports
  `claim_settlement_payouts: simulated`. Money comes *in* for real; the payout
  leg does not.
- **Five links remain unpaid** — one ₹1,500 deductible link
  (`plink_TU7q5wZcOo8oZs`, against `CLM-2026-011006`) and four renewal links, of
  which one is deliberately simulated, its host under the reserved `.invalid`
  TLD so it can never resolve. Razorpay was asked directly and answers
  `status: created, amount_paid: 0` for each of the four real ones.

**One item that stood here has been withdrawn, and it was withdrawn because a
payment proved it wrong.** This list used to read *"a paid renewal still does not
reactivate a policy — nothing writes `policies.status`."* Something does now:
`renewal-service.ts:1192` writes `{ status: 'active', end_date: newEndDate }`,
and `POL-2022-000111` has been renewed through the product twice and reactivated
both times.

| Renewal link | Paid | Payment | End date | Reactivated |
| --- | --- | --- | --- | ---: |
| `plink_TUJi5wzZba5mAu` | ₹1,980 | `pay_TUJsAY1wyNry8n` | 2024-01-10 → 2027-08-26 | 2026-08-26T07:41:49Z |
| `plink_TUhGVccvig6eTF` | ₹1,980 | `pay_TUhs4GqCdZSKVy` | 2027-08-26 → 2028-08-26 | 2026-08-27T07:10:27Z |

Two `policy_reactivated` rows sit in `journey_events` against that policy, both
actor `system`, each naming the payment that caused it. Razorpay confirms both
links as `paid`. **The withdrawal is not free**, and the price is paid in
[Results](#results) and in the ablation below: `POL-2022-000111` is the expired
policy that `refuse-expired-policy` and the refusal-gate arm are both built on,
and it is not expired any more. A real payment through the product invalidated a test fixture, which is a
thing that happens when the fixtures live in the production book.

### A correction this harness earned

The first version scored two failures. It expected `file_claim` to succeed on a
`pending` policy; the backend refused with *"That policy is not currently active,
so a new claim cannot be filed."* The backend was right — a pending policy has
not incepted — and the harness was arguing for a bug. The expectation was fixed,
not the product. Recorded because a measurement tool that is never wrong is a
measurement tool nobody checked.

---

---

# Everything below measures the model, and the model is not the product

The sections above measure the workflow: how far a claim gets unaided, where it
stops, and whether it refuses what it should refuse. That is what SafeGuard is —
an agentic workflow that collapses four phone calls into one interaction.

Everything from here down measures something narrower and more familiar: given a
labelled case, does the recommendation match the label. That is the right test
for a classifier, and SafeGuard is not one. No model was trained here; a hosted
model is called at one step of a longer workflow, and scoring the whole system on
that step's verdict accuracy answers a question nobody asked of it.

**It is kept, and kept in full, for three reasons.**

First, it answers a real question, just a narrow one: *is the model safe to put
in the money path?* The answer is that it cannot reach the money at all — the
figure is computed in code, the money tools take no amount parameter, and a
disagreement escalates with both numbers named. The ablation is the measurement
behind that claim rather than an assertion of it.

Second, the result is unflattering and deleting it would be the worst thing this
repository could do to itself. The rules-only arm was reported as paying
₹36,89,100 in error until a control nobody had run showed that figure was an
artifact of one literal in the harness — see *The control that was missing*
below. That correction is the single most useful thing the evaluation produced,
and it cannot exist without the thing it corrects.

Third, [FAILURE.md](FAILURE.md) §6 documents that discovery as a failure found
and acted on. Removing the ablation would leave that entry describing something
the reader cannot check.

**What a reader should take from it:** the model's measured contribution over a
model-free baseline that escalates rather than assumes is one case in a hundred.
That is a finding about verdict accuracy, and it is not a finding about whether
the workflow works — which the journey completion run measures, and which is the
number this project stands on.

---


## Ablation: what each safety layer is worth

A 100% pass rate is not a result on its own. It invites one question — *versus
what?* — and without an answer the honest reading is that the test set was easy.

`npm run ablate` answers it by removing one layer at a time and rerunning the
cases that depend on it.

| Layer removed | Cases | Pass with it | Pass without it | Broken |
| --- | ---: | ---: | ---: | ---: |
| Reference-number normalisation | 4 | 4 | **0** | **4** |
| Refusal gates on filing | 2 | 2 | **0** | **2** |

**Normalisation.** With it removed, reference numbers are looked up exactly as
transcribed. Every spoken spelling then fails: `CLM2026000456`,
`CLM 2026 000456`, `clm-2026-000456`, and the same for policy numbers. Since
speech-to-text drops punctuation as a matter of course, without this layer
essentially no caller who reads a claim number aloud is understood.

**Refusal gates.** With them removed, the agent files claims against
`POL-2022-000111` and the cancelled policy `POL-2024-000222`, returning real
claim numbers for both. These are the cases the Refusal group asserts are
declined; the gate is the only thing declining them.

**That result was measured when `POL-2022-000111` was expired, and it is not any
more.** Two renewals were paid through the product and the policy is `active`
today, with an end date of 2028-08-26 — see
[what is still not real](#what-is-still-not-real). So the gates-removed arm no
longer demonstrates what this row claims: on that policy the baseline arm files
too, and the "pass with it / pass without it" contrast collapses to nothing.
`POL-2024-000222` is still cancelled, so half the row survives. The ablation has
not been re-run against a currently-expired policy — the book holds five, among
them `POL-2022-011016` and `POL-2023-011033` — and until it is, the **2** in that
row should be read as a 1 that was measured and a 1 that has since lost its
fixture.

**Controls.** Each arm includes cases that must behave identically whatever is
ablated: a claim number spelled exactly as stored, and a legitimate filing
against an active policy. Both hold in all three arms, which is what
distinguishes a targeted ablation from a server that is simply broken.

### How it runs, and why it is not run against production

The harness starts a local server three times — baseline, normalisation removed,
gates removed — and checks `/health` each time to confirm the flags actually
reached the process before trusting the arm's results.

Ablating the deployment is not an option: a deployment with its refusal gates
removed would file invalid claims for real callers. `src/config/ablation.ts`
refuses to start under `NODE_ENV=production`, exiting rather than serving in a
degraded state, and `/health` always lists any active ablation so such a server
cannot be mistaken for a normal one.

The gates-removed arm genuinely writes claims the system would otherwise reject.
Every claim created is deleted afterwards, and the script refuses to run at all
without the service-role credentials needed to do that cleanup.

### An error this caught

The first version of this harness reported that all three arms behaved
identically — that removing either layer changed nothing. That was a bug in the
harness, not a finding: on Windows the child server was spawned through a shell,
so killing it left the real process running and every arm after the first was
answered by the baseline server. A second version then reported normalisation as
worth 3 cases out of 4, because policy lookup normalises on its own code path
that the flag did not yet reach.

Both are recorded here because the failure mode of an ablation is to
under-report, and an ablation nobody can check is worth as little as an accuracy
figure nobody can check. The port guard and the `/health` verification exist so
neither error can recur silently.

---

## AI claim adjudication

Everything above measures the tool layer: given an intent, does the right
endpoint return the right data. Adjudication is the one place in this system
where a model is asked to *judge* rather than to route, so it needs its own
account, and the honest version of that account includes a negative result.

`POST /api/tools/adjudicate-claim` reads a policy, a claim, and the text of the
documents attached to it, and reports where they contradict each other. Nine
deterministic checks run first and can veto before the model is called; the
payable figure is computed in code and withheld from the prompt; a human
approves everything. The mechanism is described in
[ARCHITECTURE.md § 13](ARCHITECTURE.md#13-ai-claim-adjudication-flow).

### What is covered by tests

The deterministic half is fully covered and involves no model at all: **65 tests
in `backend/src/services/adjudication-service.test.ts`**, out of 629 in the
backend suite, exercise every veto, the payable figure surviving a
model that insists otherwise, every parse failure, the timeout, the unreachable
provider, the row that could not be written, the fence claimant text cannot
forge, and the assertion that the computed amount never reaches the prompt.
They run with `cd backend && npm test` and use an in-process fake provider, so
they measure the code and say nothing about the model.

**The scope of that 65 is stated because it is the kind of number that drifts.**
It is one file. Widen the scope to everything matching `*adjudicat*` and the
figure is **78**, because `src/routes/adjudication-review.test.ts` adds 13 more
covering the human-decision endpoint — the one that records
`overrode_recommendation`. Both numbers are correct; they answer different
questions, and a bare "78" would quietly credit the route tests to the
deterministic adjudication layer.

**The 629 does not include the eval harness.** `npm test` runs
`src/**/*.test.ts`, which is exactly what CI runs: 599 in `src/services/` and 30
in `src/routes/`. The four-arm harness under `backend/eval/tests/` carries a
further **85** tests — `cache.test.ts`, `dataset.test.ts`, `scoring.test.ts`
(which is where the Wilson and McNemar arithmetic is checked) and `seal.test.ts`
— and **CI never runs them**, so they are counted apart rather than folded into
the headline. All 629 and all 85 pass as the runner reports them today; it was 620
and 85 at `3c624c4` and at `8da0356`, and the nine added since are the public
evidence endpoint and the API root — up from the 364 this
document reported at `befdbff`; the rise is new tests, not a changed way of
counting.

Findings 1 and 2 below are from live runs against the deployed endpoint with
`GROQ_API_KEY` configured, on `openai/gpt-oss-120b` — the model production
calls. Finding 3 is the four-arm ablation scored over a labelled 100-case
split, and it was run against `mistral-large-latest` instead. The three are not
one result, and the substitution is stated again where the numbers are.

### 1. The model finds what it was built to find

A claim with a policy limit of ₹50,000, a claimed amount of ₹80,000, and an
uploaded repair estimate totalling ₹12,000. The model returned `escalate` and
reported both problems:

```text
"claimed amount 80000 exceeds policy limit 50000"
"repair estimate total 12000 does not support claimed amount"
```

The second is the one that matters. Nobody planted it as a test of the estimate
check — the case was built around the limit — and the model found it anyway by
reading the document against the claim. That finding is not reachable by keyword
matching, and it is the reason there is a model in this part of the system.

The control case, where the policy, the claim and the documents all agree,
returned a clean `approve` with no inconsistencies. A detector that fires on
everything is not a detector, so the negative case is part of the result.

One thing to note about the first case, because it is checkable and would
otherwise mislead: a claim above the policy's `coverage_amount` never reaches
the model at all — `claimed_amount_within_coverage` vetoes it first and returns.
Since the model *was* called here, the ₹50,000 limit it reported against was a
term inside the policy's `coverage_details`, which the deterministic layer does
not read and the prompt passes through verbatim.

### 2. `temperature: 0` does not buy determinism, and this is measured

`GroqProvider` sends `temperature: 0`. That is a request for greedy decoding,
not a guarantee of it, and nothing downstream is built on the assumption that
the same prompt returns the same bytes twice. This is what that assumption would
have cost.

The same three cases, run five times each at `temperature: 0` on
`openai/gpt-oss-120b`:

| Case | Verdicts across 5 runs | |
| --- | --- | --- |
| clear approve | approve ×5 | stable |
| one rupee over the limit | deny ×5 | stable |
| genuinely ambiguous | escalate, escalate, escalate, **approve**, escalate | **unstable** |

The easy cases are stable. The hard one is not, and it flipped to the one
verdict that would have taken a human out of the loop.

**The model's confidence was inversely useful.** The outlier — the single
`approve` among four escalates — came back with *high* confidence. The four
correct escalates reported medium, low, low, and medium. On the one case where
confidence would have been worth reading, reading it would have led to the wrong
answer. (`adjudications.confidence` is stored as a 0–1 number; the bands here are
how the five runs grouped.)

Two consequences, and neither is a workaround:

- **This is why a human approves everything.** Not as a compliance gesture — as
  the direct consequence of a measurement. A verdict that is stable on the easy
  cases and unstable on the hard one is a verdict that cannot be the last word,
  and the hard cases are the ones a human is needed for anyway.
- **Confidence is recorded, not acted on.** Nothing in the code branches on
  `confidence`. It is stored because a reviewer may want it and because a
  measurement like this one needs it, and that is all.

Within-case variance is not something this field usually reports. Accuracy over
a case set is; running the same case repeatedly and publishing the spread is
not. It is three cases and five runs — small — but it is the number that decided
the design.

### 3. The four-arm ablation, and it is a negative result

The completions were fetched on 2026-08-25, against commit `937daf8`, with the
eval harness pointed at Mistral's API. The scored report committed here was
regenerated from that cache on 2026-08-27 — the manifest records
`started_at: 2026-08-27T14:08:21.778Z` — and the regeneration changed the
manifest in ways that are set out in
[The re-score changed the manifest](#the-re-score-changed-the-manifest-and-no-score-with-it)
below. The full report is `backend/eval/results/four-arm-dev.txt` and
the manifest is `backend/eval/results/run-dev.json`; every figure below is read
from those two files, and where this document and those files disagree the files
are right.

**This run measures `mistral-large-latest`. Production runs
`openai/gpt-oss-120b` through Groq.** The dev split was scored against a
different model from the one the deployed endpoint calls, because that is the
provider whose token budget the fetch could complete on. So what follows is a
result about `mistral-large-latest` on this case set. It is not yet a result
about the model SafeGuard ships, and no line below should be read as though it
were. Re-running the same harness against `openai/gpt-oss-120b` is the work that
would change that, and it has not been done.

The one thing that did hold to production is the token budget. The run used
`max_tokens: 1024` — **the same budget the shipping code uses**, recorded in the
manifest as both `max_tokens` and `shipped_max_tokens`. An earlier fetch needed
three times that to get completions back at all (the superseded cache file still
carries `mt3072` in its name). These numbers were obtained under the
configuration production actually runs, not under a loosened one.

The split is 100 dev cases, labelled under rulebook v1.0.0 and scored under
scoring rules v1.0.0, both fixed before any result was measured.

| Arm | What it is | Exact match | 95% CI (Wilson) | approve / deny / escalate |
| --- | --- | ---: | ---: | --- |
| A | Deterministic rules only, no model | **71/100** | 61.5 – 79.0% | 65 / 25 / 10 |
| B | Model only, no rules layer, no veto | 33/100 | 24.6 – 42.7% | 6 / 3 / **91** |
| C | Rules + model — the shipped *design*, not the shipped *model* | 50/100 | 40.4 – 59.6% | 1 / 25 / **74** |
| D | Random verdicts drawn to match C's mix | 23/100 | 15.8 – 32.2% | 1 / 25 / 74 |
| | *(ground truth)* | — | — | 41 / 31 / 28 |

The denominator for every exact-match figure is cases in the split, n = 100 for
each arm. Arm C is labelled the shipped *design* deliberately: the rules-then-model
arrangement is what SafeGuard deploys, but the model inside it here is
`mistral-large-latest` and the model inside it in production is
`openai/gpt-oss-120b`. **Arm C does not measure what ships.**

#### The mechanism: the model escalates three quarters of the book

**Adding the model made the system worse by 21 cases.** Arm A, which never calls
a model at all, is right on 71 of 100. Arm C, the shipped combination, is right
on 50. On this split and this model the recommendation the harness produces is
to ship arm A.

*Why* is the part worth having, because "the model was inaccurate" is
unfalsifiable and fixes nothing. The failure has a specific, diagnosable shape,
and it is in the verdict mix:

| | approve | deny | escalate | escalation rate |
| --- | ---: | ---: | ---: | ---: |
| ground truth | 41 | 31 | 28 | **28%** |
| B model only | 6 | 3 | 91 | **91%** |
| C rules + model | 1 | 25 | 74 | **74%** |
| A rules only | 65 | 25 | 10 | 10% |

**The model escalates 74–91% of everything it is shown, against a truth that
escalates 28%.** Left alone it escalates 91 of 100; with the deterministic layer
in front of it holding the policy-state cases back, it still drags the shipped
combination to 74. Approvals collapse to match: arm B approves 6 and arm C
approves exactly 1, against a ground truth of 41.

That is not caution, and it is not a calibration problem that a threshold would
fix. **It converts a decision problem into a queue.** A verdict of `escalate` is
a decision not to decide, and a layer that returns it three times out of four has
not adjudicated 100 claims — it has forwarded 74 of them to a human and charged
tokens for the trip. The score is what that costs; the ₹2,03,39,395 in the
`delayed` column below is what it costs the policyholders waiting behind it.

It is also the reason this reads as a design that is sound and an aggregate that
is bad. The rules layer and the model are right about different cases —
[shown per claim type below](#what-matters-more-than-the-headline-the-two-layers-fail-in-opposite-places)
— but a model that escalates by default cannot express what it knows, because
`escalate` is the answer that is never wrong enough to be caught and never right
enough to be worth anything. Fixing the escalation rate is a concrete piece of
work with a measurable target: prompt changes, or a different model, scored the
same way against the same split.

#### The intervals, and what they are not

The 95% intervals in the table are Wilson score intervals on n = 100. Wilson
rather than the normal (Wald) approximation or a bootstrap: below a few hundred
samples both of those misbehave, and both collapse to zero width at 0/n and n/n
— precisely where a bound matters most and is least honest to omit. At this n
Wilson is the correct estimator, and `scoring.ts` computes it. Adding the
intervals moved no point estimate in the table; if a bound ever appears to move
one, the arithmetic above it is what is wrong.

**These are each arm's own uncertainty. They are not a test of whether two arms
differ, and they must not be read as one.** Arm A's interval clears arm C's
entirely, so that separation stands on the intervals alone. But arm B's overlaps
arm D's, and arm C's overlaps arm B's, and the tempting inference — *therefore
those pairs are indistinguishable* — is a statistical error, not a finding.
Both pairs turn out to separate cleanly once tested properly, so the overlap
reading here would not merely have been unsound; it would have been wrong.

The reason is that these are not independent samples. **Arms B and C read the
same cached completions on the same 100 cases, and arm D is drawn to arm C's
exact verdict multiset.** Every comparison here is *paired*: the same case is
scored under each arm. Comparing overlapping marginal confidence intervals on
paired data is a known mistake and is far less powerful than the correct test,
because it throws away the pairing — which is the whole of the information about
whether one arm is better on the cases where the two disagree.

The right instrument is **McNemar's test**, which reads only the discordant
cells: the cases one arm got right and the other got wrong, and the reverse. The
concordant cases carry no evidence about which arm is better and are correctly
ignored.

| Comparison | Right in 1st only | Right in 2nd only | Discordant | Right in both | McNemar *p* (exact) |
| --- | ---: | ---: | ---: | ---: | ---: |
| A rules only **vs** C rules + model | **38** | 17 | 55 | 33 | **0.0065** |
| C rules + model **vs** B model only | **22** | 5 | 27 | 28 | **0.0015** |
| B model only **vs** D random control | **15** | 5 | 20 | 18 | **0.0414** |

**All three pairs separate at the conventional 5%.** The cases both arms got
right — and the cases both got wrong — carry no information about which arm is
better, and the test discards them; the discordant column says how much of the
split each test actually ran on.

**The B-vs-D row is the argument above, demonstrated on this document's own
data.** Arm B's Wilson interval is 24.6–42.7% and arm D's is 15.8–32.2%. They
overlap across a wide band, and the marginal reading of that overlap is *the
model on its own is not distinguishable from a random control* — which is a
conclusion, and it is wrong. Paired, 15 of the 20 discordant cases fall arm B's
way and the test returns p = 0.0414. Reading the overlap threw a real result
away. **C vs B is the same failure more starkly:** the two intervals overlap
heavily, and paired the difference is p = 0.0015. If this section needed a worked
example of why an overlapping interval is not a negative result, it did not have
to go outside its own numbers to find one.

**The headline pair sharpens the negative finding rather than rescuing it.** A vs
C is significant *in arm A's favour*, 38 discordant cases to 17, p = 0.0065. The
paired test is the more powerful instrument and it agrees with the marginal one:
on the same 100 cases, removing the model helped, and that is not an artefact of
n = 100.

**Exact binomial, not chi-square.** McNemar's chi-square approximation with a
continuity correction wants b + c ≳ 25; uncorrected it is anti-conservative and
corrected it is over-conservative, and at b + c of 55, 27 and 20 that is the
wrong tool while the exact test costs nothing at this size. The chi-square
statistics were computed anyway as a smell test — 8.02, 10.70 and 5.00 — and
they agree, with the exact p slightly the more conservative of the two, which is
the correct direction for a disagreement to fall in. The B-vs-D p was also
checked by hand against the binomial sum: 2 × 21700 / 2²⁰ =
0.04138946533203125.

**These figures were computed twice, independently, and agreed.** The harness
produces them in `four-arm-report.ts`; the discordant cells were also derived
separately from `predictions-dev-arm-*.json` against
`dataset/dev/ground-truth.json` while this section was being written, and both
routes gave 38/17, 22/5 and 15/5. That is not proof either is right, but a
transcription or off-by-one error would have had to occur identically in two
places to survive it.

**The pairing is recomputable from the committed artifact, not taken on trust.**
`backend/eval/results/run-dev.json` carries `correct_by_case` on each arm — a
per-case record of which arm was right on which case — so anyone can rebuild the
2×2 tables above and rerun the test without re-running the model or trusting this
document. The p-values themselves are rendered into
`backend/eval/results/four-arm-dev.txt`; the inputs that produce them are in the
JSON. Publishing a p-value a reader can re-derive is a different act from
publishing one they have to believe.

#### The money, as two numbers that are never added

| Arm | Paid in error | Withheld | Paid unreviewed | Delayed |
| --- | ---: | ---: | ---: | ---: |
| A rules only | ₹36,89,100 | ₹24,64,899 | ₹69,55,700 | ₹0 |
| B model only | ₹16,800 | ₹0 | ₹0 | ₹2,27,93,194 |
| C rules + model | ₹0 | ₹24,64,899 | ₹0 | ₹2,03,39,395 |
| D random control | ₹0 | ₹53,03,799 | ₹1,78,300 | ₹1,78,44,395 |

Every rupee figure is that case's own
`max(0, min(claimed_amount, coverage_amount) - deductible)`, taken from the
fixture. No average claim size is used anywhere, and no column here is added to
another — `scoring.ts` ships a `blendedCost()` that throws rather than produce a
single number covering both a wrong approval and a wrong denial.

The trade is the whole point. Arm C pays **₹0** in error where arm A pays
**₹36,89,100** — but arm C delays **₹2,03,39,395** into human review, where arm
A delays nothing. One number is money lost; the other is money owed to
policyholders who now wait. They land on different people and they are reported
apart for that reason.

**Read down the two money-out columns, though, and the headline reverses.**
`Paid in error` is not the whole of what an arm hands over without authority.
`Paid unreviewed` — predicting `approve` where the truth was `escalate` — is
money that also leaves, on a file that nobody with authority ever read. Arm A
scores on both:

| | Wrong approvals | Paid in error | Settled unreviewed | Paid unreviewed | Money out on no authority |
| --- | ---: | ---: | ---: | ---: | ---: |
| A rules only | 9/31 | ₹36,89,100 | 17/28 | ₹69,55,700 | **₹1,06,44,800** |
| C rules + model | 0/31 | ₹0 | 0/28 | ₹0 | **₹0** |

Both halves are read from `backend/eval/results/report-dev-arm-a.txt` and
`report-dev-arm-c-run1.txt`; the larger of the two arm A figures is the one a
summary that stops at "wrong approvals" leaves out. Against that, arm A's
over-escalation is **0/72, ₹0** and arm C's is **47/72, ₹2,03,39,395**. So the
true shape of the trade is: arm A recommends over a crore for payment with no
authority behind it and delays nobody; arm C recommends nothing without authority
and delays two crore.

**That last column is a sum, and S2 permits it where the report does not.**
Adding ₹36,89,100 to ₹69,55,700 is not the forbidden blend: S2 forbids combining
a wrong approval with a wrong *denial*, because one pays money that was not owed
and the other refuses money that was, and they land on opposite people. Both
summands here point the same way — money leaving on no authority, once because
the correct verdict was `deny` and once because it was `escalate`. S4 keeps them
apart in the report because they are different failures; this column adds them
because it answers a different question, *how much left the building*, and it is
labelled as that rather than as a score.


### The control that was missing, and what it does to the figure above

**Every rupee in the arm A rows above is an artifact of one literal, and the
conclusion drawn from them was wrong. This section is the correction; the numbers
themselves are arithmetically right and are left standing.**

The nine deterministic checks only ever produce *vetoes*. They have no approve
verdict of their own — `runDeterministicChecks` returns a veto or nothing. So the
harness had to decide what a rules-only arm does when nothing objects, and
`armA` in `backend/eval/arms.ts` chose `approve`, tagged
`source: 'rules_no_objection'`.

That choice produced **65 of arm A's 100 verdicts**, and therefore all of the
₹36,89,100 and all of the ₹69,55,700.

Run the same arm with the choice made the other way — no objection means nobody
has cleared it, so escalate — and nothing else altered. No model, no API key, no
tokens:

| Variant | Exact match | approve/deny/escalate | Paid in error | Settled unreviewed |
| --- | ---: | --- | ---: | ---: |
| A rules only, defaults to `approve` *(as published above)* | 71 | 65/25/10 | ₹36,89,100 | ₹69,55,700 |
| **A′ rules only, defaults to `escalate`** | **49** | 0/25/75 | **₹0** | **₹0** |
| C rules + model *(ships)* | 50 | 1/25/74 | ₹0 | ₹0 |

**A′ and C agree on 99 of the 100 cases.** The measured contribution of the
language model over a model-free arm that escalates rather than assumes is **one
case**, and **₹0** of avoided wrong payment.

The defence originally offered for the `approve` default — that it has "the same
shape as R8 in the answer key's own rulebook" — does not hold. R8 is the terminal
rule of a rulebook that also contains R4 and R7, two document-reading rules the
shipping engine structurally cannot evaluate. Mapping a terminal-approve rule onto
a nine-check engine that is blind to two of its predecessors is what fabricates
the ₹36,89,100.

**What this does not overturn.** Arm C still recommends nothing without authority,
still names both figures when its arithmetic disagrees with the model's, and still
cannot approve anything. What it overturns is the claim that the model prevents a
crore of wrong payment. It does not. What the model buys is the reading — the nine
checks cannot see inside a document, and cannot notice that evidence is ambiguous.

**And the wider point.** Verdict accuracy is the wrong measure for this product.
SafeGuard is a workflow, not a classifier: what it removes is the repetition — the
repeated calls to file one claim — not the wrong payment. A labelled verdict set
answers a question nobody asked of it. See [PRODUCT_PRD.md](PRODUCT_PRD.md) §2.

**This is the reframing that matters, and it is an indictment of the headline
metric rather than of either arm.** `exact_match` gives one point per case and
takes one point away per case, so an unneeded escalation — which costs a review
and a claimant's patience — is weighted identically to a wrong approval, which
costs the money. Arm C buys 47 of the former to avoid 26 of the latter — 9 wrong
approvals and 17 settled unreviewed — and `exact_match` scores that as a loss of
21. **That is precisely why the harness prints "ship arm A"**, in those words, in
`four-arm-dev.txt`.

Whether a cost-weighted metric would print the same thing depends entirely on a
number nobody in this repository has chosen: the exchange rate between a rupee
that left on no authority and a rupee a claimant is waiting on. At parity the
recommendation stands, because ₹1,06,44,800 is less than ₹2,03,39,395. At any
rate that discounts a delay below about half a loss it inverts. **The point is
not that arm C wins under some weighting — it is that `exact_match` picks a
weighting silently, and picks 1:1.** `scoring.ts` refuses to ship the alternative
rather than guess it: `blendedCost()` throws. Somebody has to choose that rate,
and choosing it is not a measurement.

In counts: arm A makes 9 wrong approvals and 2 wrong denials and settles 17 cases
that needed a review; arm C makes 0 wrong approvals, 2 wrong denials, and
over-escalates 47.

#### What matters more than the headline: the two layers fail in opposite places

Scored per claim type, the aggregate stops looking like one system being bad and
starts looking like two systems that are each right about different cases.

| Claim type | n | A rules | B model | C shipped |
| --- | ---: | ---: | ---: | ---: |
| ambiguous_evidence | 3 | **0%** | **100%** | 100% |
| estimate_contradiction | 8 | **0%** | **100%** | 100% |
| report_date_mismatch | 6 | **0%** | **100%** | 100% |
| deductible_exceeds_claim | 7 | **100%** | **0%** | 100% |
| policy_cancelled | 4 | **100%** | **0%** | 100% |
| policy_lapsed_before | 7 | **100%** | **0%** | 100% |
| policy_lapsed_after | 5 | **100%** | **0%** | 0% |
| stacked_lapse_and_contradiction | 4 | 100% | 0% | 100% |
| documents_complete_approve | 6 | 100% | 0% | 0% |
| straightforward_approve | 16 | 94% | 6% | 0% |
| exclusion_near_miss | 8 | 100% | 13% | 13% |
| exclusion_applies | 9 | 0% | 33% | 0% |
| limit_boundary_under | 6 | 83% | 0% | 0% |
| limit_boundary_over | 6 | 83% | 100% | 83% |
| near_duplicate_filing | 5 | 100% | 100% | 100% |

The top three rows are judgement: an estimate that contradicts the claimed
amount, a police report whose date is not the incident date, evidence that does
not settle the question either way. The rules score **0 of 17** on them and the
model scores **17 of 17**. The next three are policy state and arithmetic —
cancelled, lapsed, nothing payable after the deductible. The rules score **18 of
18** and the model scores **0 of 18**. That is the right-tool-in-the-right-place
claim with numbers behind it, and it is the reason the aggregate reads as a
failure while the design is sound.

Two rows explain where the 21 cases went. `straightforward_approve` and
`documents_complete_approve` are the 22 clean cases the set contains so that it
is not made entirely of traps. Arm A gets 21 of them. Arm C gets **0**, because
the model escalates cases the rules would have approved and the shipped design
lets it. The layer that is worth 17 cases on judgement gives back more than that
on the cases with nothing wrong.

One row is a rules gap rather than a model failure: `exclusion_applies`, 0 of 9
for arm A. The deterministic layer does not read exclusion wording — it reaches
the model through `coverage_details`, mapped in `eval/adapter.ts` — so R2 never
fires deterministically, and those nine cases are arm A's largest single loss.

**The oracle bound, which is not a result.** Taking the better arm on each claim
type scores **92 of 100**. That is not achievable: choosing per category requires
already knowing which arm was right, which means reading the answer key.
Recorded because of the one thing it does establish — the ceiling on this split
is not 71. Both layers hold cases the other misses, so a router that could tell
judgement cases from policy-state cases *without* the labels has 21 cases of
headroom above arm A. Building and measuring that router is the work; the 92 is
only evidence that the work is worth doing.

#### What holds the comparison still

- **Arms B and C read the same cached completions.** The model was called once
  per case and both arms were handed the same answer, rather than each calling
  independently and trusting `temperature: 0` to make the two draws agree. Arm C
  beats arm B by 17 cases over identical model output, so that margin is the
  rules layer and nothing else — no provider variance, no second draw.
- **Arm D draws arm C's exact verdict multiset** — the same 1 approval, 25
  denials and 74 escalations — and attaches it to the wrong cases. It scores 23.
  Arm C's 27-case margin over it is the part of arm C's score that came from
  reading the case rather than from the shape of its output distribution.
- **Repeatability was measured, not assumed.** k=1 run per case here, so this
  run reports agreement trivially and buys nothing: 98 of 98 measurable cases
  agree with themselves, which at k=1 is arithmetic rather than evidence, and
  2 cases are excluded because no run returned a readable verdict. The
  within-case variance result that actually decided the design is
  [above](#2-temperature-0-does-not-buy-determinism-and-this-is-measured).

#### The re-score changed the manifest, and no score with it

Regenerating the report from the committed cache on 2026-08-27 changed the run
manifest, and that change is recorded here rather than absorbed silently.

`completions-dev.json` holds two *recorded failures* from the 25 August fetch:
`dev-030#1`, six attempts all rate-limited (`error_kind: throttled`, a 429
storm), and `dev-074#1`, which reached the provider on its sixth attempt and
then timed out at 45 seconds (`error_kind: timeout`). **The cache deliberately
never reuses a failure** — a failed call is not an answer — so a re-score
re-attempts exactly those two calls. On 25 August they were made live and
succeeded. On regeneration they were refused offline.

| Manifest field | 25 Aug run | Committed 27 Aug re-score |
| --- | ---: | ---: |
| `calls_made` | — | 2 |
| `calls_reused_from_cache` | — | 98 |
| `calls_failed` | 0 | **2** |
| `throttled_attempts` | 8 | **0** |
| arm B `api fail` | 0 | **2** |
| arm C `api fail` | 0 | **1** |
| k-repeat measurable | 100/100 | **98/98, 2 excluded** |

**No score moved.** Both cases resolve to `escalate` either way — arm B and arm C
predict `escalate` on `dev-030` and `dev-074` in the committed predictions, which
is also what they predicted when the calls succeeded — so every exact-match
count, every confusion cell and every rupee figure in this section is identical
to the 25 August one.

The change that matters is not to the numbers but to what they rest on: **the
committed report is the one reproducible from what is actually in this
repository, and the 25 August report is not.** Anyone who clones this repo and
re-scores gets 2 failed calls and 0 throttled attempts, because the two live
calls that succeeded that afternoon are not in the cache and cannot be replayed.
Reporting the 25 August manifest alongside numbers a reader cannot reproduce
would be reporting a run nobody else can have.

The honest cost of this is stated too: two of the 100 cases now reach their arm
through an API failure rather than a model decision, and the report's accounting
table counts them as `api fail` rather than as the model choosing to escalate,
which is the distinction that separates a cautious arm from a throttled one.

#### What this run still does not settle

Beyond the model mismatch stated at the top:

- **A documented bias against arm B.** The shared system prompt tells the model
  the deterministic checks have already run and passed. That is true for arm C
  on every case it consults the model about, and false for arm B on the 35 cases
  the rules vetoed, which arm B answers anyway. It pushes arm B toward approving
  claims a lapsed or cancelled policy should have refused. Removing it means a
  second prompt and a second call per case, which puts provider variance back
  inside the comparison the shared cache exists to remove.
- **The prompt does not say which documents were *required*,** only which were
  uploaded, because `claims.documents_required` is not in
  `buildAdjudicationPrompt`. Eight dev cases are missing a required document and
  the model cannot know it. That is a property of the shipped system, and it was
  left in place so the measured pipeline stays the shipped one.
- **Two model calls failed outright** in the committed run — `dev-030#1` and
  `dev-074#1` — and each became an escalation in the arm that read it. The
  manifest counts them as `calls_failed 2` and the accounting table as `api
  fail`, separately from the model's own escalations, because an escalation
  caused by the network is not the system being careful. The eight throttled
  attempts behind those two failures belong to the 25 August fetch and are
  recorded in `completions-dev.json`, not in this run's manifest, which reads
  `throttled_attempts 0`. See
  [The re-score changed the manifest](#the-re-score-changed-the-manifest-and-no-score-with-it).
- **The sealed 50-case holdout has not been touched, and will not be to settle
  an argument.** Everything here is the dev split, which is the set you are
  allowed to look at. The lock is `backend/eval/holdout.lock.json`, sealed at
  `2026-08-25T08:35:01Z` with sha256 digests of `cases.json` and
  `ground-truth.json` under seed 9930517, at `rulebook_version 1.0.0`. What the
  seal proves is an ordering in time — that the holdout existed, untouched,
  before the measurement it would be used to check — and the proof of that is
  nothing more than the fact that the file has not been modified. **Running it
  once is cheap; re-sealing it destroys that proof permanently.** Once a lock is
  rewritten, every number ever reported against that split becomes a number
  reported against a dataset that could have been adjusted to produce it,
  including the numbers already published, and there is no way to re-earn it. So
  the holdout can be spent exactly once, and spending it to win an argument in a
  demo is precisely what the lock exists to prevent. An unspent sealed split is
  therefore not a gap in the evidence; it is the one piece of evidence here that
  is still worth something, because the next measurement taken against it will
  still be credible — a property no re-run can restore once it is lost. Read
  against any bar that asks for measured precision and recall on a held-out set:
  that measurement is available on demand and has been deliberately preserved
  rather than spent, and the reasoning above is why. If the holdout genuinely
  has to change, the lock file itself states the procedure — delete the lock in
  a commit of its own naming what was wrong and who decided, re-seal in a
  separate commit, and treat every prior holdout number as void.

#### Structure, credited

The four-arm shape of this evaluation is not original to SafeGuard. It was taken
from [`shivaanshh/razorpay_KHATA`](https://github.com/shivaanshh/razorpay_KHATA),
whose `eval/ablations.py` predates this harness: the deterministic floor, the
unsupervised-model arm, the shipped combination, the control, and the discipline
of calling the model once and handing the same answer to both arms. What was
adopted and what was not is set out in [Prior work](#prior-work).

### Recorded honestly: the first live run

The first adjudication run against the live endpoint returned `escalate` on a
claim where all nine deterministic checks passed and the model's arithmetic
agreed with ours. The reason: no documents had been uploaded to the claim, so
there was nothing to cross-check.

That is the right answer, and nobody wrote a rule for it. It falls out of two
things that were built for other reasons — the prompt states plainly that no
documents have been uploaded rather than showing an empty section, and the
system prompt tells the model to escalate whenever the documents do not settle
the question. There is no `documents_present` check among the nine. The
behaviour is correct and undesigned, and it is recorded that way rather than
claimed as a feature.

### What this does not measure

- **There is an accuracy figure for adjudication, and it is not for the model
  that ships.** The four-arm ablation above scored all 100 dev cases, but
  against `mistral-large-latest`. Nothing in this document reports the accuracy
  of `openai/gpt-oss-120b`, which is what the deployed endpoint calls.
- **The four-arm evaluation has been run on the dev split only.** The harness is
  `backend/eval/` — `arms.ts`, `run-cli.ts`, `scoring.ts`, `four-arm-report.ts`,
  `seal.ts` — and it compares deterministic rules only (A), model only (B), the
  shipped combination (C) and a random control (D) over one shared set of
  completions. All four arms were scored over the complete 100-case dev split;
  the completions were fetched on 2026-08-25 and the committed report was
  regenerated from them on 2026-08-27. **The sealed 50-case holdout has not been
  touched** — `backend/eval/holdout.lock.json`, `sealed_at
  2026-08-25T08:35:01Z`, still matching its digests — so nothing
  here is a held-out result, and the dev figures are from the set that was
  available to look at while the harness was being built. It stays sealed:
  spending it to win an argument in a demo would destroy the only evidence that
  it predates the measurement, which is the whole of what it is for, and that
  evidence cannot be re-earned by re-running anything.
- **The completions behind the ablation were fetched across two providers.** An
  earlier fetch on `openai/gpt-oss-20b` through Groq stopped at the provider's
  daily token cap with 55 of 100 cases cached, and the log records where and why
  (`backend/eval/results/fetch-dev.log`). The scored run replaced that cache
  entirely with `mistral-large-latest` completions; the superseded file is kept
  alongside it rather than deleted.
- **Three cases, five runs.** The variance result is real and small. It is
  enough to refute "temperature 0 makes this deterministic"; it is not a
  distribution.
- **Two models, and they are not the same model.** The live-run findings and the
  variance measurement are `openai/gpt-oss-120b` through Groq, which is what
  production calls. The four-arm ablation is `mistral-large-latest` through
  Mistral's API. `LlmProvider` is what made the swap possible, and it is also
  why the two halves of this section cannot be read as one result.
- **Adjudication latency is not characterised.** The latency of every call is
  recorded on its row (`model_latency_ms`); no distribution has been taken from
  those rows.
- **Document text quality is not measured.** Today `extracted_text` is supplied
  by whoever uploads the file and recorded as `text_source = 'claimant'`. No OCR
  or PDF extraction runs, so nothing here measures how well a document is read —
  only what the model does with the text it is given.

---

## Observations

**Normalisation costs latency.** That group's p50 is 1031 ms against 484 ms for
refusal, because a mangled reference number is retried against several candidate
spellings sequentially. The trade is deliberate — a slower answer beats asking
the caller to repeat themselves — but a single indexed normalised column would
remove it.

**Refusal is the fastest group.** Rejections short-circuit before doing work,
which is the right shape: the system spends its time on requests that can be
served.

**p95 is dominated by cold starts.** The outliers in the table above — 1366 ms
for Retrieval, 1159 ms for Actions, 1080 ms for Normalisation — are early
requests in a run hitting an idle container. Subsequent requests to the same
endpoint settle lower: the Coverage group, 177 requests deep into a warm run,
has a p95 of 616 ms.

These three lines were themselves stale until this pass: they carried p50 731 ms
and p95 1311/1084/627 ms from a run older than the table above them. Prose that
restates a measured figure drifts from it silently, which is the same failure as
the 202-case table, and it is recorded here for the same reason.

---

## What this does not measure

Stating the limits plainly, because a metric presented as broader than it is
would be worse than no metric.

**The harness contaminates the dataset it measures, and the contamination
inflates its own score.** This is a defect in the measurement tool, not a
limitation of scope, and it belongs at the top of this list for that reason.
`refuse-expired-policy` in `backend/scripts/evaluate.mjs` carries no
`cleanup: true`, because it was written against a policy that would refuse the
filing. The policy was reactivated by a paid renewal and no longer refuses, so
the case now files a claim the run has no record of and cannot delete — and a
claim in the book is two more generated Coverage cases on every subsequent run.
**A harness whose denominator grows when it fails is a harness that cannot report
a stable rate**, and one whose failure then hides behind a duplicate-filing
refusal — see
[The harness leaks a claim](#the-harness-leaks-a-claim-and-the-leak-inflates-its-own-denominator)
— is worse than one that stays red. Three refusal cases sit on the same fault
line: `refuse-cancelled-policy`, `refuse-missing-policy-number` and
`refuse-missing-description` are all `file-claim` cases with no cleanup, safe
only for as long as their refusals hold. The fix is one flag on each of the four,
and it is not applied here because this document does not edit the code it
measures.

**Tool selection by the language model is not measured here.** The harness
exercises the tool layer — given an intent, does the correct tool return the
correct data. It does not measure whether the agent *chooses* the right tool
from a spoken sentence, because that requires placing real calls through
ElevenLabs, which consumes voice credits and cannot be run in a loop.

Selection has been exercised manually. In a recorded call the agent correctly
chose `lookup_claim` for a status question and `check_documents` for a follow-up
about paperwork, and correctly retried with a reformatted number when the first
lookup missed. That is anecdote, not measurement, and it is labelled as such.

**The dataset is synthetic, even though coverage of it is complete.** 204 cases
in the measured run — 27 hand-written, 177 generated from the book — over the 63
claims and 51 policies it then held; 206 against the 64 claims and 51 policies
the book holds today. Every record is exercised, which is not the same
as exercising every situation — synthetic records are internally consistent in a
way real ones are not, and no generated book carries the long tail of genuine
claim states.

**Latency is measured from a single client on one network.** These are useful
relative to each other, not as an SLA.

**Speech recognition accuracy is not measured.** The normalisation group tests
recovery from known transcription failures; it does not measure how often those
failures occur.

**Adjudication accuracy is not measured by this harness.** None of its cases
— hand-written or generated — touch `adjudicate-claim`. It has its own scored ablation, on a different model
from the one production calls, and what is and is not known about it is set out
in [AI claim adjudication](#ai-claim-adjudication).

---

## Modelled value: arithmetic, not measurement

Everything above this line is measured against the deployed system. Nothing
below it is. This section is arithmetic over published third-party figures and
assumptions stated in the open, and it is separated out precisely so it cannot
be mistaken for a result.

**SafeGuard has never handled a real policyholder call.** Any figure about money
saved is therefore a projection, and the honest way to present one is to show
the inputs and let the reader disagree with them.

### Inputs

| Input | Value | Where it comes from |
| --- | --- | ---: |
| Tool-layer accuracy | 100% over 204 cases (27 hand-written, 177 generated), measured 2026-08-27 and not since | Measured — table above, with the caveats stated under it |
| Tool-layer latency | p50 505 ms, p95 851 ms | Measured — table above |
| Intents fully implemented | 6 (claim status, policy terms, outstanding documents, file claim, callback, escalation) | Measured — the repo |
| Voice cost | $0.10 / min | Assumed — [ElevenLabs Agents](https://elevenlabs.io/pricing/agents) lists $0.08 (Standard), $0.10 (Turbo), $0.12 (Premium); midpoint taken |
| AI call duration | 3 min | **Assumed.** No IVR tree and no queue; the tool layer is not the bottleneck at 505 ms p50 |
| Human handle time | 7–10 min for insurance | [Callin](https://callin.io/insurance-outsourcing-call-center/), [Liveops](https://liveops.com/blog/the-modern-insurance-call-center-technology-talent-and-trends-to-know/) |
| Containment | 50% | **Assumed, deliberately below benchmark.** Industry voice-AI containment runs 65–80% in tuned enterprise deployments; Forrester puts deflection at 45–60% |

### The arithmetic

At $0.10/min over a 3-minute call, a contained call costs **about $0.30** in
voice spend. Take a routine-enquiry volume of 10,000 calls a month and the
assumed 50% containment:

| Baseline cost per human-handled call | Cost of those 5,000 calls today | Via SafeGuard | Difference |
| ---: | ---: | ---: | ---: |
| $2 | $10,000 | $1,500 | $8,500 |
| $4 | $20,000 | $1,500 | $18,500 |
| $6 | $30,000 | $1,500 | $28,500 |
| $8 | $40,000 | $1,500 | $38,500 |

The baseline is left as a range rather than a single number because the searches
behind this section did not turn up a defensible per-call cost for insurance
specifically. Anyone with their own figure can read their own row.

### Why this model is probably optimistic

Stating this rather than waiting to be asked:

- **$0.30 per call excludes real costs.** Carrier/telephony is billed separately
  from the ElevenLabs rate, and ElevenLabs currently absorbs LLM costs but has
  said it will pass them on. Both push the true figure up.
- **The 50% that is not contained is not free.** A caller who fails containment
  and then reaches a human has cost more than if they had gone straight there.
  This model does not charge for that.
- **The implied per-call reduction is 85–96%**, which sits at or above the top
  of Forrester's cited 65–90% range. When a model beats the published benchmark,
  the model is usually wrong before the benchmark is.
- **Containment is assumed, not observed.** Measuring it means placing real
  calls and counting how many end without a handoff. That has not been done.

### What would replace this section with a measurement

Route a real queue of routine claim enquiries to the agent, count the calls that
end without a human handoff, and record the voice spend against them. Three
figures — containment, cost, and callers who called back anyway — would make
every projection here unnecessary.

---

## Regression value

Two of the hand-written cases exist because of bugs found in production
rather than in review:

- **Cross-turn tool pairing** — ElevenLabs records a tool call and its result on
  different transcript turns. Pairing within a single turn split every call into
  two rows, one falsely marked failed. Found by reading a real call's stored
  executions.
- **Dropped dashes** — found in the same recording.

Both are now covered by tests and by the normalisation group here, so the bugs
cannot return silently. The backend suite is **629 tests, all passing** — 599 in
`backend/src/services/*.test.ts` and 30 in `backend/src/routes/*.test.ts`. That
is the same services-and-routes split this line has always reported; at
`befdbff` it read 356 and 8 against a total of 364.
The eval-harness tests under `backend/eval/tests/` are not in that 629 and are
counted separately above.

---

## Reproducing

```bash
cd backend
npm install
npm run evaluate
```

Runs against production by default. To target another deployment:

```bash
API_BASE_URL=http://localhost:3005 npm run evaluate
```

With `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` present, the claims the two
`Actions` filing cases create are deleted afterwards. Without them the run still
completes and leaves those two evaluation claims on the demo policies.

**Cleanup is not complete even with the credentials.** Only cases carrying
`cleanup: true` are collected for deletion, and `refuse-expired-policy` is not
one of them — it now files rather than refuses, so running this against
production today adds a permanent claim to the book. Run it against a local or
disposable deployment via `API_BASE_URL` unless you mean to. This is the defect
described in
the closing *What this does not measure* register; it is stated in the
reproduction instructions as well because that is where somebody about to trip
over it is standing.

---

## Prior work

The four-arm structure of the adjudication evaluation — a deterministic-only
floor, an unsupervised-model arm, the shipped combination, and a control —
follows [`shivaanshh/razorpay_KHATA`](https://github.com/shivaanshh/razorpay_KHATA),
whose `eval/ablations.py` predates this harness. Adopted from it: the four-arm
framing itself, the decision to call the model once and hand the same answer to
both the supervised and unsupervised arms rather than calling twice and trusting
`temperature: 0` to make the draws agree, the sealed holdout with a lock file,
and the rule that an arm which cannot run reports that it did not run instead of
substituting a plausible number.

What is different here, and was not taken:

- **Arm D is a random control**, drawn to match arm C's own verdict
  distribution and attached to the wrong cases, so any margin C holds over D is
  the part of its score that came from reading the case rather than from the
  shape of its output. The corresponding arm in the source is model-only, which
  is this harness's arm B.
- **k runs per case**, so run-to-run instability is measured rather than
  assumed away.
- **A shared completions cache** recording per-call token usage, attempt count
  and throttled attempts, so an escalation caused by a rate limit can be told
  apart from one the model chose.
- **Scoring rules fixed before any result was measured** (S1–S6), including the
  refusal to combine wrong approvals with wrong denials into a single figure.

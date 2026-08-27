# SafeGuard — submission index

Razorpay AI Buildathon 2026, Open Track. This page exists because the repository
holds close to six thousand lines of documentation and no entry point. Every
claim below names the file or commit that proves it; nothing here is asserted
that is not checkable in this repository.

## What this is

SafeGuard is an AI voice agent for insurance claims support: a policyholder
speaks to it in a browser or over the phone, and it looks up claims, explains
coverage, names outstanding documents, files new claims, takes payment for a
lapsed premium or an excess, escalates to a human, and refuses what it should
refuse. Behind it is a reviewer dashboard where an adjuster reads an AI
adjudication recommendation — every deterministic check, the model's reasoning,
and the two amounts kept apart — and approves or rejects before any claim moves.
Dashboard: `https://safeguard-dashboard-cyan.vercel.app` · API health:
`https://safeguard-api-production-7c24.up.railway.app/health`

## The one design property that matters

**The model holds no claim facts.** Every figure it speaks came back from a tool
call against Postgres in the same turn. It cannot invent a claim number because
it never holds one.

This is structural, not a prompt instruction that happens to be obeyed:

| Enforcement | Where |
| --- | --- |
| `settle_claim`, `collect_deductible`, `offer_renewal` take a reference number and **no amount parameter** — the model has no slot in which to name a figure | `backend/src/config/agent-definition.ts` |
| Every amount is computed server-side from stored rows: settlement is `max(0, min(claimed, coverage) − deductible)` | `backend/src/services/settlement-service.ts` |
| A lookup failing for any reason other than "no such row" reports *unavailable*, never *not found* — an outage must not read back as "your policy does not exist" | `backend/src/services/lookup-result.ts` |
| The prompt's own rule, for the cases a tool boundary cannot cover: *"Never state claim or policy facts from memory."* | `agent-definition.ts`, `systemPromptFor` |

The same constraint governs adjudication in the opposite direction: the prompt is
**deliberately not shown** the computed payable figure, so the model's own
arithmetic can be compared against ours instead of echoing it. A test asserts the
computed figure never appears in the prompt text.

## Claim → evidence

| Claim | Where it is proved |
| --- | --- |
| It is deployed and answering live | `README.md` → *Live*; `GET /health` returns `mode: live` and a per-integration status object, reproduced in `README.md` → *Verifying a deployment* |
| The evaluation runs against the deployed system, not a local mock | `backend/scripts/evaluate.mjs` targets the Railway API by default; `EVALUATION.md` → *Reproducing* |
| Money moved, and was verified on **Razorpay's own ledger** rather than self-reported | `EVALUATION.md` → *Money: collected and refunded, end to end* — ₹2,000 collected and refunded three minutes and ten seconds apart, read back from `GET /v1/refunds/rfnd_TU2yKRNmSRP3Ws` and `GET /v1/payments/pay_TU2uxWmTBwRHoU` |
| A payment the system could *not* authenticate was refused rather than recorded | Same section, *The control, which was an accident* — Razorpay shows `plink_TU2Zrnt5sYbxvY` paid; this system still shows `status: created, payment_id: null`, because the webhook secret was unset |
| Adjudication is nine deterministic checks first, any of which can veto before the model is called | `backend/src/services/adjudication-rules.ts`; the short-circuit is enforced twice — in the service and by the DB constraint `adjudications_veto_precludes_model` |
| A human approves everything; the service's only write is an audit row | `backend/src/services/adjudication-service.ts` (writes `adjudications`, never `claims.status`); `backend/src/routes/adjudication-review.ts` (`POST /api/adjudications/:id/decision`, ADMIN_TOKEN required) |
| Disagreement between model and human is preserved, not resolved into silence | `adjudication-review.ts` records `overrode_recommendation`; a real instance is in `EVALUATION.md` → *The chain* |
| Every failure path escalates rather than approving | `adjudication-service.ts`; DB constraint `adjudications_parse_failure_escalates` refuses any row pairing a parse error with a non-escalate verdict |
| The evaluation is sealed and pre-registered | `backend/eval/holdout.lock.json` — sha256 of the holdout cases and ground truth, `sealed_at: 2026-08-25T08:35:01Z`, sealed under rulebook v1.0.0 before any result was measured; `backend/eval/seal.ts` |
| Scoring rules were fixed before results, and refuse to be gamed | `backend/eval/scoring.ts` — S1–S6; its `blendedCost()` **throws** rather than combine a wrong approval and a wrong denial into one number |
| Ablation cannot be run against production by accident | `backend/src/config/ablation.ts` refuses to start under `NODE_ENV=production`; `/health` always lists any active ablation |
| The prior art the four-arm structure came from is credited | `EVALUATION.md` → *Prior work* — `shivaanshh/razorpay_KHATA`, with what was adopted and what was not |

## What is measured, and what is not

Precisely, because a metric presented as broader than it is would be worse than
no metric.

**Measured.** The automated harness runs 27 hand-written behavioural cases that
assert literal values — retrieval, refusal, speech-to-text normalisation, write
actions, personalisation — plus 177 generated integrity checks, one pair per
claim and one per policy, asserting that every record in the book reports itself
back unchanged. The total is a property of the database, not a constant. Latency
is recorded per group.

**Not measured by that harness.** Tool *selection* by the language model — the
harness exercises the tool layer, not whether the agent picks the right tool from
a spoken sentence, which needs live ElevenLabs calls that consume voice credits
and cannot be looped. It has been checked by hand and is labelled anecdote.
Speech-recognition error *rate* is not measured either, only recovery from known
failures. **And it does not touch adjudication at all.**

**Adjudication.** Its evidence is a separate four-arm ablation over **100 dev
cases on synthetic data**, plus unit coverage and hand-run live calls. The
**50-case holdout is sealed and unspent** — deliberately, because the only thing
a sealed split proves is an ordering in time, and re-sealing destroys it. The
dataset is synthetic throughout, and complete coverage of a generated book is not
the same as coverage of real claim states.

## The negative result

A four-arm ablation was run to measure what the LLM adds to the decision path.
Under exact match it subtracts. It ships anyway, and the reason is in the rupee
columns below. Full method: `EVALUATION.md` →
*The four-arm ablation, and it is a negative result*; raw report
`backend/eval/results/four-arm-dev.txt`, manifest `run-dev.json`.

| Arm | What it is | Exact match |
| --- | --- | ---: |
| A | Deterministic rules only, no model | **71/100** |
| B | Model only, no rules, no veto | 33/100 |
| C | Rules + model — **what ships** | **50/100** |
| D | Random control matched to C's verdict mix | 23/100 |

**Adding the model cost 21 exact-match cases; arm C ships regardless.**
Production is arm C — the rules gate, the model recommends, the rules compute the
money, a human decides. The whole A-vs-C difference is a single line that exists
only in harness code: `backend/eval/arms.ts:107` hard-codes `approve` where no
check objected, where `adjudication-service.ts:626` reads the model's own verdict
and carries it unchanged to the `adjudications` insert at `:718`. That verdict
never becomes money — `payableAmount` is assigned once, at `:502`, from
`adjudication-rules.ts:189`, and no money path reads `model_proposed_amount`.

**The mechanism is named, not guessed at.** The model escalates 91 of 100 cases
where ground truth escalates 28; arm C escalates 74. Arm C approves exactly one
claim in the split against a ground truth of 41. A system that escalates almost
everything is not being careful — it has converted a decision problem into a
queue.

**The cost asymmetry is two numbers that are never added, and it reverses the
ranking.** Arm A's 21-case lead is bought with **₹1,06,44,800** wrongly
recommended for payment: 9/31 wrong approvals (**₹36,89,100**) plus 17/28
escalations settled without review (**₹69,55,700**). Arm C's two are **0/31 and
0/28** — the shipped configuration never once recommends a wrong payout on this
split. Its entire deficit is over-escalation, 47/72, which `scoring.ts` itself
labels *"a cost, not an error and not a win"*: **₹2,03,39,395** delayed into
human review. Money lost and money owed land on different people, so
`blendedCost()` throws rather than produce a single figure covering both.
`exact_match` weights an unneeded escalation and a wrong approval identically,
which is why the harness prints *ship arm A* — a recommendation produced, and
not acted on.

**Why the design is still sound.** Per claim type, the two layers fail in
opposite places: on judgement categories — a repair estimate contradicting the
claim, a police report dated wrong, ambiguous evidence — rules score **0 of 17**
and the model **17 of 17**; on policy state and arithmetic the model alone scores
**0 of 18** and rules **18 of 18**. Taking the better arm per category would
score 92, which is not achievable (it requires the answer key) but does establish
that the ceiling is not 71.

**The caveat, which `EVALUATION.md` states before it quotes a single number.**
That run used `mistral-large-latest`; production runs `openai/gpt-oss-120b`
through Groq. It is a measured result about that model on this split, not yet
about the model SafeGuard ships, and re-running the harness against the shipped
model has not been done.

## What it is worth, in numbers that were measured

Every rupee below is either an output of the scored ablation or an object on
Razorpay's ledger. There is no assumed cost per call, no handle time, no
containment rate and no annualised return in this section. `EVALUATION.md` does
carry a projection built on exactly those things — *Modelled value: arithmetic,
not measurement*, which assumes a 3-minute call, $0.10/min voice spend and 50%
containment — and it says in its own heading what it is. No figure from it
appears here.

### The insurer — loss prevention, as a difference between two arms

Same 100 cases, same answer key, one layer changed.

| | Arm A — rules only | Arm C — what ships |
| --- | ---: | ---: |
| Wrong approvals — recommended for payment where the verdict should be deny | 9/31, **₹36,89,100** | **0/31, ₹0** |
| Escalations settled without the review the file needed | 17/28, **₹69,55,700** | **0/28, ₹0** |
| **Total wrongly recommended for payment** | **₹1,06,44,800** | **₹0** |
| Over-escalation — payable money held in a review queue | 0/72, ₹0 | 47/72, **₹2,03,39,395** |

**The cost side is the larger number, so it is stated first rather than last.**
Arm C buys ₹1,06,44,800 of avoided wrong payment recommendations by sending 47 of
72 decidable cases to a reviewer who did not need to see them. The ₹2,03,39,395
is the approve-truth subset of those 47 — `backend/eval/scoring.ts:531` sums only
cases whose correct verdict was approve, because delaying a claim that should
have been denied delays nobody's money. It is still a real cost, and it is the
insurer's as much as the claimant's: reviewer time bought, per claim, that arm A
does not spend. The two totals are never added; `blendedCost()` throws rather
than return one figure covering both.

**On one axis the model changes nothing.** Both arms wrongly deny the same 2 of
41 approvable cases (**₹24,64,899**) and refuse the same single escalate case
(**₹29,07,300**, `dev-099`). A policyholder who was owed and was refused is no
better off under either.

**Three caveats bound every figure above.** The ablation ran on **synthetic
data**, on the **100-case dev split**, and against `mistral-large-latest` while
production runs Groq `openai/gpt-oss-120b`. And **a recommendation is not a
payment**: `adjudication-service.ts` writes an `adjudications` row and never
`claims.status`, so these rupees measure what lands in front of a named reviewer,
not money that moved.

### The policyholder — three checkable things, and one that is not measured

**Not measured: time.** Not time to resolution, not calls avoided, not whether a
caller finishes without reaching a human. No claim about time saved is made here,
because none has been measured.

What is checkable:

- **The call and the dashboard cannot disagree.** Every figure a caller hears
  came back from a tool call against Postgres in the same turn, so there is no
  second copy of the number to drift from. The Retrieval group — claims in three
  states, policies of different types, and document checks with none, some and
  several items outstanding — passed 8/8 at p50 549 ms in the 2026-08-27 run
  (overall p50 505 ms, p95 851 ms; that table is a record of that date and the
  current pass rate is unknown, which `EVALUATION.md` states immediately after
  it).
- **Outstanding documents are named during the call, not in a letter afterwards.**
  `check_documents` reads `documents_required` against `documents_received` on
  the row and reports the difference while the caller is still on the line. It
  checks presence, never contents.
- **One claim has a complete recorded journey.** `CLM-2026-976488` was filed by
  the live agent on 2026-08-27 at 07:11 UTC against a policy renewed thirty-five
  seconds earlier; its ₹1,000 excess was collected (`pay_TUi4FalZilAAM2`,
  07:21:46Z) and returned (`rfnd_TUiSy4uPmFSOpL`, 07:45:09Z); it was adjudicated
  `escalate` and approved anyway by a named reviewer, with the override recorded.
  The settlement leg is simulated, and the fault determination the refund needed
  was written to the row by hand after the reviewer omitted it — both in
  `EVALUATION.md` → *The second loop*.

**These are test-mode transactions.** Real Razorpay API objects with real payment
and refund ids, verifiable on Razorpay's own ledger — and **no rupees left
anyone's account.** Four captures exist: the ₹2,000 and ₹1,000 excesses above,
both refunded, and two renewals of ₹1,980 on `POL-2022-000111`
(`pay_TUJsAY1wyNry8n`, `pay_TUhs4GqCdZSKVy`) that moved its end date to 2027 and
then 2028. Test mode is not a book of business. It is also not a simulator, and
claiming more than that would forfeit the only difference worth having.

### What would complete this case

Three numbers are missing and none of them can be reasoned into existence:
**cost per contact against a measured baseline** — this repository has no
baseline, and `EVALUATION.md` records that the searches behind its modelled
section found no defensible per-call figure for insurance; **containment**, the
share of calls that end without a human handoff; and **repeat contact**, the
callers who called back anyway. Routing a batch of routine claim enquiries
through the deployed system and counting those three would produce all of them,
and would make every projection anywhere in this repository unnecessary. Until
that run happens, the honest total is the one above: a measured difference in
what gets recommended, four real payment objects on somebody else's ledger, and
no claim about time.

## Known limitations

- **Settlement payouts are simulated.** Razorpay's payout API belongs to
  RazorpayX, which needs a registered business and completed KYC. Standard test
  credentials return **HTTP 400 on `POST /v1/payouts`** — verified directly, not
  assumed. `/health` reports `claim_settlement_payouts: simulated`, and
  `SimulatedPayoutProvider` says so in every result it returns. Money comes *in*
  for real; the payout leg does not.
- **Document contents are never read.** `check_documents` checks presence, not
  content. `extracted_text` on a claim document is supplied by whoever uploaded
  the file and recorded as `text_source = 'claimant'` — adversarial input. No OCR
  or PDF extraction runs anywhere.
- **The deductible refund had no trigger for most of this project's life.**
  `claims.fault_determination` has existed since migration 0018 and was read by
  the refund gate while **no code path wrote it**, so `refund_deductible` could
  only ever answer `fault_not_determined`. Fixed in `99aec77` (a reviewer records
  fault at decision time) and `581a41c` (the review queue actually sends it). It
  is optional on purpose: an approval without one carries a warning that the
  deductible can now never be waived.
- **Filecoin archival is failing on the live deployment; chain attestation is
  not.** `/health` reports `filecoin_uploads.last_attempt: failed` and
  `chain_attestation.last_attempt: succeeded`. That is the design working:
  `ClaimRegistryV2` anchors the keccak256 evidence hash rather than the CID, so
  tamper-evidence survives an archival outage, and the on-chain record carries an
  empty storage locator saying plainly the bytes were not kept.
- **The read endpoints are unauthenticated.** `GET /api/claims`, `/api/calls`,
  `/api/escalations`, `/api/analytics`, `/api/agent-config` and the review queue
  are open to anyone with the URL; the dashboard has no login; and there is no
  caller identity verification — the agent trusts the claim number read out to
  it. `ARCHITECTURE.md` → *What this does not cover*, `DEPLOYMENT.md` →
  *Security before real use*.
- **Three smaller ones, stated where they are relevant rather than collected
  away:** `RAZORPAY_WEBHOOK_SECRET` is unset in production, so the webhook is
  fail-closed and captures are not being recorded live; rate-limit counters live
  in process memory, so the effective ceiling multiplies by replica count; and
  prompt injection is bounded rather than solved — claimant text is fenced,
  sanitised and capped and cannot approve or pay anything, but a reviewer reading
  the reported inconsistencies is reading text an attacker influenced.

## What broke, and what I did about it

Every one of these produced a plausible-looking wrong result rather than an
error, which is worse than a crash, because a crash gets noticed.

**Speech-to-text was silently breaking every spoken claim number.** A caller says
"C-L-M 2026 000456"; the transcript arrives as `CLM2026000456`; the lookup
returns nothing and reads as a caller mistake. Found by pulling a real recording
and reading what the transcript contained, not by reading code. Fixed in
`reference-number.ts`; the ablation shows all four normalisation cases fail
without it.

**The webhook signature check could never have passed.** It HMAC'd the body
alone; ElevenLabs signs `${timestamp}.${body}`. No real webhook had ever been
verified — the integration only looked like it worked because other code was
faking the result. Rewritten in `elevenlabs-webhook.ts` with a replay window and
constant-time comparison.

**Two mechanisms existed purely to manufacture success**, both deleted: a
Filecoin upload failure returned a hardcoded CID that was then attested on-chain
as genuine evidence, and the post-call webhook injected a fake claim whenever the
agent failed to file one (`fd53963`, *"always inject mock claim if AI fails so
Filecoin pipeline always runs"*). Uploads now return a discriminated result the
type system forces every caller to handle.

**A paid renewal link was offered again, and the money was never found**
(`020462f`). A caller was read a link already paid; Razorpay declined a second
payment, so no webhook fired, the policy stayed expired, and the agent said the
payment "might take a while" — untrue, and it had no way to know better. `paid`
was missing from `SPENT_LINK_STATUSES`. The fix is narrower than the bug: a row
carrying a `payment_id` is now unreusable whatever its status says, because
status is a label a webhook wrote and `payment_id` is money actually held.

**A real test call exposed four more, one of which cost somebody money**
(`0b0f7a3`). A settlement was announced with no mention of the ₹1,000 excess the
caller had paid, so they were left assuming it was gone. It was held, waiting on
a fault determination. The diagnosis was one level shallower than the bug:
`settleClaim` short-circuited before the refusal path ran, so the sentence was
never generated and no log line existed either — fixing the spoken line alone
would have left the call exactly as silent.

**Three commits exist purely to retract a claim**, which is the part I would
point at hardest:

- `a4e6938` — the dashboard's landing page was still carrying accuracy figures
  `EVALUATION.md` had publicly withdrawn, and was claiming every filed claim is
  adjudicated server-side. Grepping every writer of `claims.status` found two.
  The page now makes the narrower claim, which is true.
- `2abf3d5` — the *drift checker* was itself asserting something unverified: that
  the dashboard deploys from GitHub via Vercel. Disproved by pushing four commits
  and re-fetching the deployed bundle. Four copies exist and none updates
  another.
- `774fb1c` — deleted pages that could never have shown anything, including a
  Live Call page whose event had no publisher and a panel reading "On-chain
  attestation verified" off nothing but a truthy transaction hash.

The evaluation harness has been wrong twice and both errors are written up rather
than quietly fixed: an ablation that reported all three arms identical (a Windows
process-kill bug, so every arm after the first was answered by the baseline
server), and a harness that scored two failures because it was arguing for a bug
the backend was right to refuse. `EVALUATION.md` records both, because a
measurement tool that is never wrong is a measurement tool nobody checked.

## Where to start — five minutes

1. `GET /health` on the API. It reports which integrations are configured **and
   whether their last attempt succeeded**, so a deployment cannot look healthy
   while a configured feature is failing. Read the Filecoin/attestation split.
2. `README.md` → *What broke, and what I did about it*. Five failures, each
   linked to the code or commit that fixes it.
3. `EVALUATION.md` → *The four-arm ablation, and it is a negative result*. Why
   the lower-scoring arm is the one that ships, with the numbers.
4. `backend/src/services/adjudication-rules.ts` and
   `backend/src/routes/adjudication-review.ts`. Nine checks that can veto before
   the model runs, and the one human who decides after it.
5. `backend/eval/scoring.ts`. `blendedCost()` throws rather than return a
   number. That is the project's argument about measurement in seven lines.

If you only open one file, open `EVALUATION.md`. It is the document that says
what is *not* known.

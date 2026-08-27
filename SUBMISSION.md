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
| Money moved, and was verified on **Razorpay's own ledger** rather than self-reported | `EVALUATION.md` → *Money: collected and refunded, end to end* — ₹2,000 collected and refunded nineteen minutes apart, read back from `GET /v1/refunds/rfnd_TU2yKRNmSRP3Ws` and `GET /v1/payments/pay_TU2uxWmTBwRHoU` |
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

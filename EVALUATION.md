# SafeGuard — Evaluation

Measured behaviour of the deployed claims agent. Every figure in the harness
results below is reproducible against the live system:

```bash
cd backend
npm run evaluate           # human-readable
npm run evaluate -- --json # machine-readable
```

The harness is `backend/scripts/evaluate.mjs`. It runs 202 cases against the
seeded dataset on `https://safeguard-api-production-7c24.up.railway.app` and
cleans up any claims it creates, so repeated runs do not drift the dataset.

Twenty-seven of those cases are hand-written and assert literal values. The
other 175 are generated at run time from the database — two per claim and one
per policy — so every claim and every policy in the book is exercised rather
than a chosen sample. The 202 is therefore a property of the seeded book: 27
plus (2 x 62) plus 51. Against a different database the total is different, and
without `SUPABASE_SERVICE_ROLE_KEY` only the 27 hand-written cases run at all.

The harness does not cover [AI claim adjudication](#ai-claim-adjudication). That
section reports live runs made by hand and unit-test coverage, and says plainly
which of its numbers are which.

---

## Results

Run against production, 202 cases.

| Group | Cases | Passed | Accuracy | p50 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Retrieval | 8 | 8 | **100%** | 493 ms | 793 ms |
| Refusal | 7 | 7 | **100%** | 475 ms | 484 ms |
| Normalisation | 5 | 5 | **100%** | 731 ms | 1118 ms |
| Actions | 5 | 5 | **100%** | 687 ms | 699 ms |
| Personalisation | 2 | 2 | **100%** | 472 ms | 917 ms |
| Coverage | 175 | 175 | **100%** | 487 ms | 560 ms |
| **Overall** | **202** | **202** | **100%** | **488 ms** | **699 ms** |

Slowest single case: 1118 ms. No failures. Coverage spans all 62 claims and all
51 policies in the dataset.

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

One hundred and seventy-five cases, generated at run time by
`backend/scripts/coverage-cases.mjs`.
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

**Refusal gates.** With them removed, the agent files claims against the expired
policy `POL-2022-000111` and the cancelled policy `POL-2024-000222`, returning
real claim numbers for both. These are the cases the Refusal group asserts are
declined; the gate is the only thing declining them.

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

The deterministic half is fully covered and involves no model at all: 65 of the
backend's 323 unit tests exercise every veto, the payable figure surviving a
model that insists otherwise, every parse failure, the timeout, the unreachable
provider, the row that could not be written, the fence claimant text cannot
forge, and the assertion that the computed amount never reaches the prompt.
They run with `cd backend && npm test` and use an in-process fake provider, so
they measure the code and say nothing about the model.

The two findings below are from live runs against the deployed endpoint with
`GROQ_API_KEY` configured, on `openai/gpt-oss-120b`.

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

- **There is no accuracy figure for adjudication, and none is claimed.** A
  labelled set of claims with known-correct verdicts, scored against the
  endpoint, does not exist yet.
- **The four-arm evaluation is built but has not been run to completion, so it
  has produced no result.** The harness is `backend/eval/` — `arms.ts`,
  `run-cli.ts`, `scoring.ts`, `four-arm-report.ts`, `seal.ts` — and it compares
  deterministic rules only (A), model only (B), the shipped combination (C) and
  a random control (D) over one shared set of completions. The dev split is 100
  cases; 55 of them have a successful completion cached. The fetch stopped when
  the provider's daily token cap for `openai/gpt-oss-20b` was reached, and the
  log records where and why (`backend/eval/results/fetch-dev.log`). No arm has
  been scored over a complete split and the sealed 50-case holdout has not been
  touched, so there is no four-arm figure anywhere in this document and nothing
  above should be read as though there were one.
- **Three cases, five runs.** The variance result is real and small. It is
  enough to refute "temperature 0 makes this deterministic"; it is not a
  distribution.
- **One model, one provider.** Everything here is `openai/gpt-oss-120b` through
  Groq. `LlmProvider` exists so that can change, but nothing else has been run.
- **Adjudication latency is not characterised.** The latency of every call is
  recorded on its row (`model_latency_ms`); no distribution has been taken from
  those rows.
- **Document text quality is not measured.** Today `extracted_text` is supplied
  by whoever uploads the file and recorded as `text_source = 'claimant'`. No OCR
  or PDF extraction runs, so nothing here measures how well a document is read —
  only what the model does with the text it is given.

---

## Observations

**Normalisation costs latency.** That group's p50 is 731 ms against 475 ms for
refusal, because a mangled reference number is retried against several candidate
spellings sequentially. The trade is deliberate — a slower answer beats asking
the caller to repeat themselves — but a single indexed normalised column would
remove it.

**Refusal is the fastest group.** Rejections short-circuit before doing work,
which is the right shape: the system spends its time on requests that can be
served.

**p95 is dominated by cold starts.** The 1118 ms outlier is the first request of
a run hitting an idle container. Subsequent requests to the same endpoint settle
under 600 ms — the Coverage group, 175 requests deep into a warm run, has a p95
of 560 ms.

---

## What this does not measure

Stating the limits plainly, because a metric presented as broader than it is
would be worse than no metric.

**Tool selection by the language model is not measured here.** The harness
exercises the tool layer — given an intent, does the correct tool return the
correct data. It does not measure whether the agent *chooses* the right tool
from a spoken sentence, because that requires placing real calls through
ElevenLabs, which consumes voice credits and cannot be run in a loop.

Selection has been exercised manually. In a recorded call the agent correctly
chose `lookup_claim` for a status question and `check_documents` for a follow-up
about paperwork, and correctly retried with a reformatted number when the first
lookup missed. That is anecdote, not measurement, and it is labelled as such.

**The dataset is synthetic, even though coverage of it is complete.** 202 cases
over 62 claims and 51 policies. Every record is exercised, which is not the same
as exercising every situation — synthetic records are internally consistent in a
way real ones are not, and no generated book carries the long tail of genuine
claim states.

**Latency is measured from a single client on one network.** These are useful
relative to each other, not as an SLA.

**Speech recognition accuracy is not measured.** The normalisation group tests
recovery from known transcription failures; it does not measure how often those
failures occur.

**Adjudication accuracy is not measured either.** The 202 cases do not touch
`adjudicate-claim`. What is and is not known about it is set out in
[AI claim adjudication](#ai-claim-adjudication).

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
| Tool-layer accuracy | 100% over 202 cases | Measured — table above |
| Tool-layer latency | p50 488 ms, p95 699 ms | Measured — table above |
| Intents fully implemented | 6 (claim status, policy terms, outstanding documents, file claim, callback, escalation) | Measured — the repo |
| Voice cost | $0.10 / min | Assumed — [ElevenLabs Agents](https://elevenlabs.io/pricing/agents) lists $0.08 (Standard), $0.10 (Turbo), $0.12 (Premium); midpoint taken |
| AI call duration | 3 min | **Assumed.** No IVR tree and no queue; the tool layer is not the bottleneck at 488 ms p50 |
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

Both are now covered by tests (`backend/src/services/*.test.ts`, 323 cases) and by
the normalisation group here. The bugs cannot return silently.

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

With `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` present, claims created
during the run are deleted afterwards. Without them the run still completes and
leaves two evaluation claims on the demo policies.

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

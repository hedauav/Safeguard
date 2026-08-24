# SafeGuard — Evaluation

Measured behaviour of the deployed claims agent. Every figure here is
reproducible against the live system:

```bash
cd backend
npm run evaluate           # human-readable
npm run evaluate -- --json # machine-readable
```

The harness is `backend/scripts/evaluate.mjs`. It runs 69 cases against
`https://safeguard-api-production-7c24.up.railway.app` and cleans up any claims
it creates, so repeated runs do not drift the dataset.

Twenty-seven of those cases are hand-written and assert literal values. The
other 42 are generated at run time from the database, one per record, so every
claim and every policy in the book is exercised rather than a chosen sample.

---

## Results

Run against production, 69 cases.

| Group | Cases | Passed | Accuracy | p50 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Retrieval | 8 | 8 | **100%** | 477 ms | 1020 ms |
| Refusal | 7 | 7 | **100%** | 460 ms | 835 ms |
| Normalisation | 5 | 5 | **100%** | 734 ms | 1070 ms |
| Actions | 5 | 5 | **100%** | 656 ms | 663 ms |
| Personalisation | 2 | 2 | **100%** | 527 ms | 850 ms |
| Coverage | 42 | 42 | **100%** | 482 ms | 617 ms |
| **Overall** | **69** | **69** | **100%** | **506 ms** | **850 ms** |

Slowest single case: 1070 ms. No failures. Coverage spans all 13 claims and all
16 policies in the dataset.

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

Forty-two cases, generated at run time by `backend/scripts/coverage-cases.mjs`.
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

## Observations

**Normalisation costs latency.** That group's p50 is 766 ms against 453 ms for
refusal, because a mangled reference number is retried against several candidate
spellings sequentially. The trade is deliberate — a slower answer beats asking
the caller to repeat themselves — but a single indexed normalised column would
remove it.

**Refusal is the fastest group.** Rejections short-circuit before doing work,
which is the right shape: the system spends its time on requests that can be
served.

**p95 is dominated by cold starts.** The 1105 ms outlier is the first request of
a run hitting an idle container. Subsequent requests to the same endpoint settle
under 600 ms.

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

**The dataset is small, even though coverage of it is complete.** 69 cases over
13 claims and 16 policies. Every record is exercised, which is not the same as
exercising every situation — a book of 13 claims cannot characterise the long
tail of real claim states, and synthetic records do not carry the messiness of
real ones.

**Latency is measured from a single client on one network.** These are useful
relative to each other, not as an SLA.

**Speech recognition accuracy is not measured.** The normalisation group tests
recovery from known transcription failures; it does not measure how often those
failures occur.

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
| Tool-layer accuracy | 100% over 69 cases | Measured — table above |
| Tool-layer latency | p50 506 ms, p95 850 ms | Measured — table above |
| Intents fully implemented | 6 (claim status, policy terms, outstanding documents, file claim, callback, escalation) | Measured — the repo |
| Voice cost | $0.10 / min | Assumed — [ElevenLabs Agents](https://elevenlabs.io/pricing/agents) lists $0.08 (Standard), $0.10 (Turbo), $0.12 (Premium); midpoint taken |
| AI call duration | 3 min | **Assumed.** No IVR tree and no queue; the tool layer is not the bottleneck at 506 ms p50 |
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

Both are now covered by tests (`backend/src/services/*.test.ts`, 28 cases) and by
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

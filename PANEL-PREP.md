# Panel prep — SafeGuard, for the Razorpay AI Builder internship

`STUDY-GUIDE.md` teaches you the system. This file is narrower: it is about the
room. What the panel is scoring, what they will push on, and what you should know
about Razorpay and about the AI Builder job that this repo does not teach you.

Read §1 and §2 the night before. Read §6 twice — the traps are where good
projects lose.

---

## 1. What they are actually scoring

Razorpay published the rubric. Four dimensions, and selection is a panel review
off your repo, video and architecture — no aptitude test, no GD.

| Dimension | What they mean | Your strongest evidence |
| --- | --- | --- |
| **Problem taste** | Did you pick a real problem with financial or operational weight? | Claims intake is repetition-bound and India-specific; measured per-call cost sits in the business case. Not a toy. |
| **Build quality** | Code structure, repo organisation, execution stability, architecture | 704 tests, CI on both halves — backend typechecks and tests, frontend lints and builds — `check:numbers` drift check, migrations numbered through 0027, a deployed system anyone can curl |
| **AI judgment** | Was the model applied where it earns its place — or forced in? | The payout is arithmetic and stays arithmetic. The model is used for speech, and for "do the documents support this". Nine deterministic checks veto before it runs. |
| **Failure recovery** | Did you find runtime failures and engineer graceful fallbacks? | `FAILURE.md` in full — and `FakeLlmProvider` answering `escalate`, never `approve` |

**The fourth one is the sleeper.** Most submissions have nothing to say about it.
You have an entire document. Bring `FAILURE.md` up yourself — do not wait to be
asked.

The single sentence that carries the whole rubric:

> "The model never touches money. It recommends; nine deterministic checks veto
> before it is ever called; a Postgres CHECK constraint makes a row that claims
> both a veto and a model call impossible to store; and the refund tool is not
> registered as an agent tool at all."

---

## 2. The five-minute spine

They asked for: problem, solution, product, technology, key decisions, working
demo. In that order, roughly:

1. **Problem** (30s) — claims intake, why it is repetition, what it costs.
2. **What it does** (45s) — a caller speaks; a claim gets filed, documented,
   assessed, decided by a human, paid, and the excess refunded.
3. **The one big idea** (30s) — *no path from the model reaches money.* Say this
   before any architecture.
4. **Demo** (2m) — `POL-2026-300001`, auto, ₹1,000 excess. File → decide in the
   Review Queue with fault set → pay the excess → settle, and the refund fires
   inside that.
5. **Proof** (45s) — `/verify` against Razorpay's own API, no login, no repo
   access. 26 of 26 confirmed.
6. **What's honest about it** (30s) — payouts simulated, Filecoin never
   succeeded, scans and photos still unreadable, one shared password rather than
   accounts. Say it before they find it.

Traps from the rehearsal: untick **"Save this card"**; set fault **before**
settling; never a health policy — the copay makes model and formula disagree and
the claim escalates.

**One trap has changed, and it needs a decision before you record.** It used to
read *"do not call adjudicate — filing already does."* That was right when
nothing could read a document: a second run saw exactly what the first saw. It is
no longer right. Automatic adjudication fires at **filing**, before any document
exists, so it can never see one.

The document-reading capability is therefore only visible if something
re-adjudicates *after* the upload. Know exactly what that costs on camera:
`adjudicate_claim` is **not** an agent tool — it is deliberately unexposed, and
`agent-definition.ts` says so — there is no button for it in the dashboard, and
`POST /tools/adjudicate-claim` sits behind `requireToolsToken`. So it is a
`curl` with a bearer token, not a click and not something you can ask the agent
for.

Two honest options:

- **Show the curl.** File → upload the PDF → `curl` the endpoint → the
  recommendation now cites the estimate's figures. It is the single strongest
  moment available, and the awkwardness is itself the point: re-assessment is a
  back-office act, off the voice path, exactly like the refund.
- **Don't, and say why.** Keep the demo as rehearsed and state that a document
  the model can read is a capability you can demonstrate but chose not to wire to
  the voice path, because a caller who can trigger re-assessment is a caller who
  can shop for a better answer.

Either is defensible. What is not defensible is the old line "uploading
afterwards doesn't re-run it, and it would see nothing new anyway" — the second
half of that is now false.

---

## 3. Questions you will get — project

`STUDY-GUIDE.md` §12 already answers the nine core ones (what stops it approving,
jailbreaks, was the model really called, is the money real, why not AI for the
payout, Groq down, double payment, tamper-evidence, the dashboard login). Don't
re-learn those here. These are the ones §12 does **not** cover.

### "How much of this did you write, and how much did the AI write?"

Answer it straight and early. The panel is hiring an AI Builder — building with
AI is the job, not a confession. What they are testing is whether you can defend
decisions you did not personally type. So defend one: take the `settle_claim`
refusal-reason fix from `FAILURE.md` and explain why the shallow fix was
rejected. That is the tell they are listening for.

### "This is a team project. What was yours?"

You already drew this line once. Say the boundary out loud, unprompted, in one
sentence, and move on. A panel that discovers an overclaim discards everything
else you said. A panel handed the boundary trusts the rest.

### "Why ElevenLabs and Twilio rather than building the voice loop yourself?"

Because the differentiated part is what happens *after* the words arrive. Turn
detection, barge-in and telephony are solved and bought. Then say what you would
change: the agent config lives in `agent-definition.ts` and is provider-shaped,
so the tools are portable even though the transport is not.

### "Walk me through what happens when a webhook doesn't arrive."

The strongest engineering story in the repo, and it is not in §12.
`policy_renewals.status` was only ever as fresh as the last webhook that landed —
a webhook that never landed left a row saying `created` for a link paid weeks
ago. The fix was not a retry. It was making *"we could not be told"* a value the
type system insists on handling, rather than an exception whose natural `catch`
is "carry on as before." Then `collect_deductible` asks Razorpay whether the link
is already spent before handing it back.

### "How do you know your evaluation isn't just the numbers you liked?"

Three things, and say all three: the journey cases were **pre-registered and
committed before the first claim was filed**; the harness's own defect (it leaks
a claim, and the leak inflates its own denominator) is documented rather than
quietly fixed; and the four-arm ablation was **demoted, not deleted** when it came
out unflattering. Add the reason — deleting an unflattering result is exactly
what got rival repos rejected.

### "What would you do with another week?"

Have three, ranked and costed:

1. **OCR or a vision model for scans and photographs.** PDF text extraction
   landed — a PDF with a text layer is parsed at upload and put in front of the
   model. A *scanned* estimate or a phone photo still stores `null`, so the model
   still escalates on those. That is the honest remaining half of the capability.
2. **Per-user accounts instead of one shared password.** The dashboard is now
   gated and migration `0027` withdrew the anon read grants — but it is one
   password, so nothing records *which* adjuster approved a claim and access
   cannot be revoked for one person. On a claims system the identity of the
   approver is not a nicety.
3. **The journey run in CI** — it was run by hand, once, against production. CI
   has no live credentials, so a push that broke the money loop goes green.

**If they ask what you did in the last few days**, this is the honest answer: the
two weakest items on this list — a model that could never see a document, and an
open PII surface — were the ones worth closing before the panel, so they were.

### "What is the weakest part?"

Pick B or D from §13, not something cosmetic. A candidate whose weakness is "I'd
polish the UI" reads as someone who has not looked.

---

## 4. Questions you will get — Razorpay domain

You built on their rails. Expect at least one payments question, possibly from
someone who wrote the API.

**Know cold:**

- **Minor units.** Amounts are paise, integers. `PaymentLinkRequest` takes
  `amountPaise` for the stated reason: keeping rupee floats out of the boundary
  means a rounding error cannot become a billing error. That answer is already in
  the code — use its words.
- **Idempotency.** `reference_id` is deterministic, so a retried creation
  collides at Razorpay rather than billing twice. The refund `receipt` is a
  deterministic hash, and a repeat is rejected with *"Duplicate receipt found."*
  Idempotency at the provider, not just in your own table — that distinction is
  the point.
- **Webhook signature verification.** HMAC-SHA256 over the **raw body** with the
  webhook secret, compared in constant time — length check first, because
  `timingSafeEqual` throws on a length mismatch. Know why raw body and not parsed
  JSON: re-serialising changes bytes and breaks the MAC.
- **Payment Links vs Orders vs Payouts.** Links and refunds work on ordinary test
  keys. **Payouts need RazorpayX and business KYC** — which is exactly why
  settlement is simulated and `/health` says so unprompted. That is a good
  answer, not an excuse: you drew the line at what you could actually prove.
- **Refunds are paid from merchant balance**, not from the original payment. You
  know this the hard way — it failed twice, both times behind Razorpay's
  misleading `"invalid request sent"` (`FAILURE.md` §8). A genuinely good war
  story for this panel: you found a place their own error message lies.
- **Refund lifecycle.** Issued `pending`, settles later. It is the reason
  `/verify` reports `stored` and `rail` side by side and never merges them —
  merging means at some point telling somebody their money is still pending when
  it has cleared, or cleared when it has not.

**Their published tracks tell you what they care about:** multi-source
reconciliation, a settlement Q&A agent, forward cash forecasting, tax-line
matching. Notice the shape — every one is *ledger truth under ambiguity*.
Reconciliation is the house obsession. Your `/verify` endpoint is structurally a
two-source reconciliation that reports disagreement as loudly as agreement.
**Frame it that way to them.** It is the closest bridge between an open-track
project and the work they actually have open.

---

## 5. What to know for the role itself

Beyond this project. These arrive as "so how would you think about…" questions.

### Agent engineering

- **Tool design is the safety surface.** Your best material: `settle_claim` and
  `collect_deductible` take no amount parameter, and `refund_deductible` is not a
  tool at all — *"a voice tool that refunds on request is a voice tool that
  refunds to whoever asks convincingly."* Generalise it: the defence is not the
  prompt, it is what the tool surface makes unexpressible.
- **Prompt injection is not solved by prompting.** Constrain capability.
- **Escalation as a first-class outcome.** Timeout, malformed JSON, unrecognised
  verdict, no key configured → `escalate`, with the reason recorded verbatim.
  Never a silent default.
- **Determinism where determinism is cheaper.** `max(0, min(claimed, coverage) -
  deductible)` is six characters of arithmetic. A model there spends money to
  make a correct answer uncertain.

### Evals

- Pre-register before you measure. Report the denominator. Keep the unflattering
  arm.
- Distinguish what a labelled verdict set measures (a classifier) from what your
  product is (a workflow). That argument is in `EVALUATION.md` and it is a strong
  thing to be able to make live.
- Know which of your numbers came from an offline scored split, which from a live
  run, and which from a unit test.

### Production LLM concerns

- **Cost and latency per call.** You record token counts, latency, provider and
  model id on every adjudication row. "I instrumented it" beats any opinion about
  model choice.
- **Provider drift.** Your own comment notes Groq deprecates models without
  notice, which is why the default is overridable by `GROQ_MODEL` and validated
  at startup. Exactly the operational scar tissue they test for under failure
  recovery.
- **Model choice.** You ship `openai/gpt-oss-120b` on Groq. **The ablation
  measured Mistral, not the shipped model.** Do not let that slip out under
  questioning — say it first.

### Fintech-shaped judgment

- Audit trail over cleverness. Every decision row is reconstructable.
- Human-in-the-loop is not a weakness of the design; it is the design.
- PII discipline: `/verify` projects Razorpay's payment object rather than
  spreading it, so email, phone, card fingerprint and VPA never reach the
  response. Say that — it shows you thought about data flow, not just endpoints.

---

## 6. Traps — things not to say

| Don't say | Say instead |
| --- | --- |
| "It's fully automated" | "It is deliberately not. A human decides; the agent does the intake." |
| "The blockchain secures it" | "Hashes are attested on Base Sepolia, so tampering is detectable without trusting our DB. Filecoin archival has never succeeded — `last_success_at` is null." |
| "The AI approves claims" | "The AI cannot approve. `approve` is not in `AGENT_TOOLS`." |
| "₹79,000 was paid out" | "₹79,000 collected and ₹71,000 returned, both real on Razorpay's ledger. Settlement payouts are simulated." |
| "We evaluated it and got X%" | Name which number came from which run, and against which model. |
| Overclaiming the team's work | The boundary, in one sentence, unprompted. |
| "I built it with AI" as an apology | "I used AI to build it — here is a decision I overrode, and why." |

**The meta-rule, and it is the one that matters:** every gap in §13 of the study
guide should leave your mouth before it enters their question. A panel that finds
a gap you hid trusts nothing else you said.

---

## 7. Ask them something

You get a slot at the end. Weak candidates ask about the stipend. Good ones ask
something only that panel can answer:

- "Which of the tracks is closest to a problem you have open right now?"
- "Where does an AI Builder sit — inside a product team, or in a central group?"
- "What's the failure mode you see most often in projects like these?"
- "Reconciliation shows up in two of your four tracks. What makes it hard at your
  volume — the sources disagreeing, or the timing?"

---

## Sources

- [Razorpay AI Buildathon](https://razorpay.com/buildathon/)
- [AI Builder jobs at Razorpay](https://razorpay.com/ai-builders/)
- [Buildathon 2026 — tracks, eligibility, selection process](https://velonx.in/blog/razorpay-ai-buildathon-2026-tracks-eligibility-stipend-selection-process)

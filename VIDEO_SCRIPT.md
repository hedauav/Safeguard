# SafeGuard — 5-minute pitch video script

Razorpay AI Buildathon 2026, Open Track. Single live take, cut in edit.

**SAY** lines are read aloud, verbatim. **SHOW** lines are what you do on screen.

---

## Why this script is shaped the way it is

Razorpay scores on four parameters: **Problem Taste**, **Build Quality**,
**AI Judgment**, **Failure Recovery**. Their own guidance says record it
*"like you are explaining the build to an engineer, not a recruiter"*, follow
**Problem → Solution → Architecture → Demo → Technical Decisions → What Broke → What You Learned**,
and warns that *"submissions without measured results are judged harder."*

So the demo is under half the runtime. Architecture, the measured ablation, and the
failure story take the rest — those are three of the four scored parameters, and
they are where most submissions have nothing to show.

| Beat | Rubric parameter |
|---|---|
| 0:00–0:30 The problem | Problem Taste |
| 0:30–0:50 The design property | AI Judgment |
| 0:50–1:20 Architecture | Build Quality |
| 1:20–3:05 Live demo | Working product |
| 3:05–3:35 Technical decisions | AI Judgment |
| 3:35–4:15 Measured results | Metrics / honesty |
| 4:15–4:45 What broke | Failure Recovery |
| 4:45–5:00 Close | — |

---

## Setup

| | |
|---|---|
| Policy | `POL-2026-300001` (auto) |
| Claim | ₹32,000 · Excess ₹1,000 · **Payable ₹31,000** |
| Dashboard | https://safeguard-dashboard-cyan.vercel.app |
| API health | https://safeguard-api-production-7c24.up.railway.app/health |

**Before you roll**

- [ ] Dashboard on the landing page, logged in. Other tabs closed.
- [ ] Four PDFs on the desktop: police report, repair estimate, photos, other driver info.
- [ ] `ARCHITECTURE.md` diagram open in a tab for the 0:50 beat.
- [ ] `backend/eval/results/four-arm-dev.txt` open in a tab for the 3:35 beat.
- [ ] Razorpay checkout: **untick "Save this card"**, or it diverts to an OTP and never completes.
- [ ] Auto or home policy only. Never health — the copay makes model and rules disagree.
- [ ] Do not call adjudicate manually. Filing already adjudicates.

---

## 0:00–0:30 — The problem

**SHOW** — You on camera, or a title card. No product yet.

**SAY**

> Every insurer in India runs a call centre. ICICI Lombard's annual report puts a number on it:
> six hundred and eighty-five call centre executives. A fully-loaded agent costs twenty-two to
> twenty-eight thousand rupees a month, so that function alone is roughly eighteen to twenty-three
> crore a year.
>
> And one agent handles one customer. India settled three point two six crore health claims last
> year, and none of those was a single call — it's a call to file, a call to ask what documents,
> a call to chase, a call to ask where the money went.
>
> The cost isn't the salary. It's the queue.

**— CUT —**

---

## 0:30–0:50 — The one design property

**SHOW** — Landing page, call widget in frame.

**SAY**

> SafeGuard runs that whole workflow with a voice agent. Fourteen tools, no ceiling on concurrent
> callers. But the property I'd want you to judge it on is this: **the model holds no claim facts.**
>
> Every figure it speaks came back from a tool call against Postgres in the same turn. It cannot
> invent a claim number, because it never holds one. That's structural, not a prompt instruction
> that happens to be obeyed.

---

## 0:50–1:20 — Architecture

**SHOW** — The architecture diagram. Trace the path with your cursor as you speak.

**SAY**

> A claim goes: browser voice widget, to ElevenLabs, to a Fastify API on Railway, to Postgres on
> Supabase. Razorpay for money. Base Sepolia for attestation.
>
> The part that matters is the order inside adjudication. Nine deterministic checks run **first** —
> policy in force on the incident date, claim type within cover, amount inside the limit, no
> duplicate, something left after the excess. Pure arithmetic, no network, no model. Any one of
> them can veto, and a veto short-circuits before the model is ever called.
>
> Only if all nine pass does the model see the claim. And it produces a recommendation and an audit
> row — it never writes claim status. A human does that.

**— CUT —**

---

## 1:20–2:00 — Demo: file it

**SHOW** — Click the call widget. Speak, let the agent answer between the two lines.

**SAY TO THE AGENT**

> "Hi — I need to file a claim. My policy is P–O–L, twenty twenty-six, three zero zero zero zero one."

> "I was rear-ended at a signal this morning. Rear bumper, boot lid, left tail lamp. The other
> driver admitted fault. Estimate's about thirty-two thousand."

**SAY TO CAMERA**

> It's looking up the policy, checking the term covers the incident date, and filing. On filing, the
> claim is hashed and attested on Base — a real transaction, and you'll see the hash in a moment.

**SHOW** — The upload card appears in the widget. Drag the four PDFs in.

**SAY**

> Then it names the documents it needs and takes them on the same call. Three phone calls became one.

**— CUT —**

---

## 2:00–2:30 — Demo: the audit trail

**SHOW** — Dashboard → Claims → the new claim. Scroll the nine checks, then the recommendation.

**SAY**

> Here's the working, per claim. Nine checks, each one recorded pass or fail with the reason in
> English.
>
> And the recommendation is **escalate** — because when it ran, no documents existed yet, so the
> model said it couldn't verify the claim. That's the ceiling working. The model's best possible
> output is a recommendation. It has no code path to approve anything.

---

## 2:30–3:05 — Demo: money and the human

**SHOW** — Pay the ₹1,000 Razorpay link (**untick "Save this card"**). Then Review Queue → Approve,
fault = **The other party**. Then settle.

**SAY**

> The excess is a live Razorpay link. Real money, test mode.
>
> The review queue is the only screen that can approve anything. The adjuster sees the checks, the
> recommendation, and the documents — and records who was at fault. That fault finding is the only
> thing in this system that sends money back to a policyholder, and no model can write it.
>
> Settled: thirty-one thousand. Claim minus excess, computed server-side. And because the other
> party was at fault, the excess refunds automatically — that refund is real money on Razorpay's
> ledger. The payout leg is simulated; it needs RazorpayX and business KYC we don't have, and every
> screen says so.

**— CUT —**

---

## 3:05–3:35 — Technical decisions

**SHOW** — `agent-definition.ts` on the tool schema, then `adjudication-rules.ts`.

**SAY**

> Three decisions I'd defend.
>
> One: `settle_claim`, `collect_deductible` and `offer_renewal` take a reference number and **no
> amount parameter**. The model has no slot to name a figure in. You can't prompt-inject a number
> into a field that doesn't exist.
>
> Two: the adjudication prompt is deliberately **not shown** the payable figure we computed — so the
> model's arithmetic can be compared against ours instead of echoing it. There's a test asserting
> that figure never appears in the prompt text.
>
> Three: when they disagree, it escalates and names both numbers. On a health policy the model read
> a twenty percent copay and proposed twenty-two thousand six forty; our code computed twenty-eight
> three hundred. Neither number won. A human got both.

---

## 3:35–4:15 — Measured results

**SHOW** — `four-arm-dev.txt`, on the money table.

**SAY**

> I ran a four-arm ablation over a hundred labelled cases. Rules only, model only, rules plus model,
> and a random control. Scored offline, rules fixed before results.
>
> Rules only pays thirty-six lakh eighty-nine thousand in error and settles nearly seventy lakh
> without review. Rules plus model — what ships — pays **zero** in error and **zero** unreviewed.
> That's the answer to "why is there a model here at all".
>
> It costs something: that arm over-escalates forty-seven cases. And on plain exact-match accuracy
> the harness actually prints "ship rules only" — because exact-match treats a wrong approval and a
> wrong denial as the same loss, and they are not the same loss. So the scoring code ships a
> `blendedCost` function that **throws** rather than combine them into one comforting number.
>
> Two honest caveats. That run used Mistral; production runs GPT-OSS through Groq, so it is not yet
> a result about the model I ship. And the holdout split is sealed — hashed and committed before any
> result was measured — and I haven't spent it.

---

## 4:15–4:45 — What broke

**SHOW** — The `deductible_payments` row still reading `status: created`, `payment_id: null`.

**SAY**

> The one that taught me most. A thousand-rupee link was paid, and Razorpay's ledger says paid and
> captured. My system still shows it as created, payment ID null — because the webhook secret wasn't
> set, so the delivery couldn't be authenticated.
>
> The system declined to record money it could not verify, rather than trusting an unsigned request.
> That's the behaviour you want, and it's visible as a row rather than as a claim in a README.
>
> But it exposed a real gap: capture depended entirely on the webhook arriving. So there's now a
> reconciliation fallback — before re-offering a link, the code asks Razorpay for its status, and a
> capture the webhook never delivered gets discovered and written, under its own ledger event so a
> recovered capture is never mistaken for a webhook that arrived.

---

## 4:45–5:00 — Close

**SHOW** — The settled claim, or the journey timeline. End on a still.

**SAY**

> One agent, one customer, is a hard ceiling. This doesn't have one. But every claim still ends with
> a person — they just spend their time deciding instead of collecting.
>
> AI understands. AI investigates. Rules verify. Humans decide. Razorpay executes.

---

## What is live, and what is not

Checked against the deployed `/health` endpoint. Answer from this table if the panel asks.

| Feature | Status | Note |
|---|---|---|
| Voice agent, 14 tools | **Live** | Filing, lookup, documents, escalation, callbacks, renewal, deductible, settlement. |
| Nine deterministic checks | **Live** | Pure arithmetic, before any model call. Veto short-circuits. |
| Model adjudication | **Live** | `openai/gpt-oss-120b` via Groq. Recommends only. |
| Base Sepolia attestation | **Live** | Real transactions, wallet funded. |
| Deductible collect & refund | **Live** | Real Razorpay money, out and back. |
| Renewal payment links | **Live** | Real links against the five lapsed policies. |
| Settlement payout | **Simulated** | Needs RazorpayX + business KYC. Disclosed on every surface, and in the script at 2:30. |
| Filecoin archival | **Not working** | Configured, but no upload has ever succeeded; claims filed today carry a null CID. **Don't claim it.** The Evidence page's Filecoin column reads empty. |
| EAS attestation | **Off** | Not configured. Don't open it. |

---

## If the panel probes

**"Why does it escalate instead of approving?"** — Filing adjudicates immediately, before any
document exists, so the model can't verify the claim. Uploading afterwards doesn't re-run it, and
the agent has no tool to re-run it: adjudication is a back-office endpoint, deliberately off the
voice path. The model's ceiling is a recommendation.

**"Isn't over-escalating 47 cases bad?"** — It's the price of zero wrong approvals and zero
unreviewed settlements. A wrong approval is money gone; an over-escalation is a person's time.
Those aren't the same loss, which is why the code refuses to add them.

**"Is the AI doing real work?"** — Rules-only pays ₹36,89,100 in error on the same hundred cases.
The model is what removes that, and the ablation is the evidence.

**"What would you build next?"** — Re-run the ablation against the shipped Groq model, and spend the
sealed holdout once. Both are named in `EVALUATION.md` as not done.

---

*Roughly 800 spoken words. Figures: ICICI Lombard FY24 annual report, IRDAI, and the General
Insurance Council. Ablation figures read from `backend/eval/results/four-arm-dev.txt` and
`run-dev.json`; where this document and those files disagree, the files are right.*

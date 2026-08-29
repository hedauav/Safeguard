# SafeGuard — pitch video script

Razorpay AI Buildathon 2026, Open Track. **Demo-first, product cut — 6:09.**
Single live take, cut in edit.

**SAY** lines are read aloud, verbatim. **SHOW** lines are what you do on screen.

Figures are written as numerals so they scan at a glance. Say them naturally —
"six hundred and eighty-five", "thirty-two thousand rupees". Timings were
computed from the spoken form, so do not recompute them from the word count.

---

## What Razorpay asks for, and where this cut sits

Official page (razorpay.com/buildathon): *pick a track, build something real, show
your work — "a public repo, a 5 minute pitch video, the architecture."*

**Open Track bar, verbatim:**

> "Show a real problem, a working product, meaningful use of AI, and evidence
> that it creates value. The same bar for execution, reliability, and depth
> applies here."

*Working product* is second of four, so this cut opens on the problem for twenty
seconds and is inside the product almost immediately. Everything explanatory
comes after the demo, not before it.

> **Scope.** The product and nothing else: the problem, the live demo, the pages
> that are deployed, and — inside the demo, at the moment it settles — which part
> of the Razorpay flow is simulated and why. Evaluation numbers, the four-way
> comparison, the failure story and the on-chain detail are **deliberately not in
> the video**; they live in *If the panel probes* below, so you can answer on them
> without spending runtime.
>
> Runs **6:09**; the demo is 61% of it. One `OPTIONAL CUT` remains — the
> ICICI / IRDAI figures (8s), taking it to **6:01**.

> **Sourcing note.** The four scored parameters — Problem Taste, Build Quality,
> AI Judgment, Failure Recovery — come from third-party writeups of the brief,
> not from razorpay.com. Consistent across sources; if the Google Form says
> otherwise, the form wins.

| Beat | What it satisfies |
|---|---|
| 0:00–0:44 The problem | A real problem |
| 0:44–0:59 Landing page, and straight in | What it is |
| **0:59–4:45 Live demo — file · audit · pay · **decide, settle, refund + why the payout is simulated** | **A working product · honest disclosure** |
| 4:45–5:53 What is deployed | A working, deployed system |
| 5:53–6:09 Conclusion | — |

---

## Setup

| | |
|---|---|
| Policy | `POL-2026-300001` (auto, Devansh Kulkarni) |
| Claim | ₹32,000 · Excess ₹1,000 · **Payable ₹31,000** |
| Dashboard | https://safeguard-dashboard-cyan.vercel.app |
| API health | https://safeguard-api-production-7c24.up.railway.app/health |

**Before you roll**

- [ ] **Check the Razorpay merchant balance.** Refunds pay from the merchant
      balance, not from the original payment — ₹1,000 in and ₹1,000 out is
      break-even and can fail. It has failed twice, both times with Razorpay's
      misleading `"invalid request sent"` (`FAILURE.md` §8). **If the refund does
      not fire on the first take:** pay a second claim's link and its balance
      covers the first refund. Do not mint extra links to build balance — 7 of the
      second account's 30 lifetime links are already spent (`FAILURE.md` §7).
- [ ] **Screenshot the `deductible_payments` row now**, while it still reads
      `status: created`, `payment_id: null` — the "What broke" beat needs it and
      reconciliation may have backfilled it. If it has, show the recovered-capture
      ledger event instead and say so.
- [ ] **Confirm `POL-2026-300001` still has zero claims.** A rehearsal spends it.
      Do not substitute `POL-2026-300010` — that is a **home** policy with a
      **₹5,000** excess, which quintuples the refund you have to fund.
- [ ] Tabs open, in this order, so you never hunt on camera:
      `ARCHITECTURE.md` diagram · `backend/src/config/agent-definition.ts` ·
      `backend/scripts/setup-elevenlabs.mjs` · `/api/agent-config` in a browser ·
      `/health` in a browser · BaseScan on a real attestation tx ·
      `backend/eval/journey/RESULTS.md` · `backend/eval/results/four-arm-dev.txt`
- [ ] Four PDFs on the desktop: police report, repair estimate, photos, other driver info.
- [ ] Razorpay checkout: **untick "Save this card"**, or it diverts to an OTP and never completes.
- [ ] Auto or home policy only. Never health — the copay makes model and rules disagree.
- [ ] Do not call adjudicate manually. Filing already adjudicates.
- [ ] Fault must be set **before** settling.

---

## 0:00–0:44 — The problem

**SHOW** — You on camera or a title card. No product yet, and no introduction of
yourself — the guidance warns against spending the opening on that.

True, and already in `README.md:26-42`. Say it flat and fast — no catch in the
voice, no pause for effect. The line that earns Problem Taste is **separating the
grievance you can fix from the one you cannot**; keep that one whatever else goes.

**SAY**

> A family member needed emergency surgery. We'd held the policy 4 years. It then took **four
> months to file the claim** — not to settle it, to file it.
>
> Four months of calls that each started over. Policy number again. What happened again. Which
> documents — a different answer every time.
>
> Two things went wrong there, and only one is a software problem. About 5% of the bill came back:
> that's underwriting, and nothing I build changes it.
>
> The four months is the software problem. Every call existed because the last one left no trace.
>
> That's what SafeGuard removes.

*OPTIONAL CUT — the two lines below. The story already carries Problem Taste;
these make it a market, not an anecdote.*

> And it isn't one insurer. India settled 3.26 crore health claims last year, and ICICI Lombard
> alone runs 685 call centre executives.

**— CUT —**

---

## 0:44–0:59 — Landing page, and straight in

**SHOW** — Land on the dashboard home. Call widget visible. Do not tour the UI.

**SAY**

> This is SafeGuard. A voice agent that handles the whole claim — filing it, collecting the
> documents, deciding it, taking the excess, settling, refunding. 14 tools. And it doesn't queue.
>
> Let me just file one.

---

## 0:59–1:57 — Demo: file a claim on a phone call

**SHOW** — Click the widget and speak. Let the agent answer between the two lines.
In edit keep its replies audible but tight — do not cut them out entirely, the
panel needs to hear it working.

**SAY TO THE AGENT**

> "Hi — I need to file a claim. My policy is POL — 2026 — 3, 0, 0, 0, 0, 1."

*(Read the digits one at a time. It is `POL-2026-300001` — **not** `...300010`.)*

> "I was rear-ended at a signal this morning. Rear bumper, boot lid, left tail lamp. The other
> driver admitted fault. Estimate's about 32,000."

**SAY TO CAMERA**

> It looked up the policy, checked the cover was active today, and filed the claim. Every number
> it read back came from the database, in that same breath. It remembers nothing on its own.

**SHOW** — Upload card appears. Drag the four PDFs in. Speed this up in edit.

**SAY**

> Now it tells me exactly which documents it needs, and takes them on the same call. Filed and
> documented in one go. That's the repetition gone.

**— CUT —**

---

## 1:57–2:48 — Demo: the audit trail

**SHOW** — Dashboard → Claims → the new claim. Scroll the nine checks, then the recommendation.

**SAY**

> Here's the working, for every claim. 9 fixed checks — was the policy active that day, is this
> kind of damage covered, is the amount inside the limit. Each one passes or fails, and the reason
> is written out in plain English. That's just arithmetic — no AI involved. And they run before
> the AI is called at all: any one of them can stop the claim dead, and then the AI never even
> sees it.
>
> The AI says escalate — send this to a human. When it ran, no documents had arrived yet, so it
> said it couldn't verify the claim. And recommending is the most it can ever do. There is no code
> in this system that lets the AI approve anything.

---

## 2:48–3:16 — Demo: paying the excess

**SHOW** — Open the Razorpay link, pay ₹1,000 (**untick "Save this card"**). Come
back and show the claim row now carrying a real `payment_id`.

**SAY**

> The excess is a real Razorpay payment link. This is real money moving — test mode, but a real
> payment on Razorpay's books. And there's the payment ID, saved against the claim.

---

## 3:16–4:45 — Demo: the human decides, and the refund fires

**SHOW** — Review Queue → Approve, fault = **The other party** → settle. Then the
refund receipt on the claim detail page. **Do not cut the refund confirmation** —
it is the single most important frame in the video.

**SAY**

> This review queue is the only place in the whole system where a claim can be approved. The
> assessor sees the checks, the AI's recommendation and the documents — then records who was at
> fault. The AI cannot touch that field.
>
> Settled: ₹31,000. That's the claim minus the excess, worked out on the server, not by the AI.
>
> Now — that ₹31,000 going out to the customer is **simulated**, and I want to be straight about
> why. Paying money out on Razorpay needs RazorpayX, and RazorpayX needs a registered business
> with KYC. I'm one person, not a company, so I was never able to test it. So it's labelled, not
> hidden — every simulated payout gets an ID with “sim” in it, and every screen that shows one
> says simulated.
>
> But the excess is real money, and it's the proof the payment side genuinely works. Because the
> other driver was at fault, it comes straight back. There's the refund confirmation — a real
> Razorpay refund ID you can look up on their dashboard. Same provider, same webhook, same books,
> money out and money back. Only that last payout step needs a business account I don't have.

**— CUT —**

---

## 4:45–5:53 — What is deployed

**SHOW** — Click through the live dashboard, one page per line, roughly four
seconds each. Do not scroll or explore — land, let it render, move on.
`/claims` · `/review` · `/calls` · `/analytics` · `/blockchain` · `/config`.

**SAY**

> All of this is deployed — browser to ElevenLabs, a Fastify API on Railway, Postgres on Supabase.
> None of it runs on my laptop. Quick tour.
>
> Claims — every claim filed, with its status.
>
> Review queue — the only screen in the system that can approve one.
>
> Call history — every conversation the agent has had.
>
> Analytics — total calls, total claims, average duration, and how many escalated.
>
> Evidence — the hash for each claim and its on-chain record.
>
> And Agent Configuration — the instructions and all 14 tools the voice agent runs on. That comes
> from one file in the repo, so the agent isn't clicked together in somebody else's dashboard. You
> can rebuild the whole thing from a fresh clone.

---

## 5:53–6:09 — Conclusion

**SHOW** — The settled claim with its refund receipt. End on a still.

**SAY**

> One agent, one customer, is a hard ceiling. This doesn't have one.
>
> Money in is real. Money out needs a business account I don't have, and it's labelled simulated
> everywhere rather than quietly faked.
>
> AI understands. AI investigates. Rules verify. Humans decide. Razorpay executes.

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
| Settlement payout | **Simulated** | Needs RazorpayX + business KYC. Disclosed on every surface, and in the script at 2:35, then in full in the Money beat. |
| Filecoin archival | **Not working** | Configured, but no upload has ever succeeded; claims filed today carry a null CID. **Don't claim it.** The Evidence page's Filecoin column reads empty. |
| EAS attestation | **Off** | Not configured. Don't open it. |

---

## If the panel probes

**"Why does it escalate instead of approving?"** — Filing adjudicates immediately, before any
document exists, so the model can't verify the claim. Uploading afterwards doesn't re-run it, and
the agent has no tool to re-run it: adjudication is a back-office endpoint, deliberately off the
voice path. The model's ceiling is a recommendation.

**"Can a caller ask for a refund?"** — No. `refund_deductible` is deliberately not an agent tool. A
voice tool that refunds on request is a voice tool that refunds to whoever asks convincingly. The
refund fires from the adjuster's fault finding, server-side.

**"Isn't over-escalating 47 cases bad?"** — It's the price of zero wrong approvals and zero
unreviewed settlements. A wrong approval is money gone; an over-escalation is a person's time.
Those aren't the same loss, which is why the code refuses to add them. (`EVALUATION.md`, 47/72.)

**"Is the AI doing real work?"** — Answer honestly, because the obvious answer does not hold.
The ablation's rules-only arm approves whenever nothing objects — a default the harness
chose, not something the rules say. Make that default *escalate* instead and it also pays
₹0, agreeing with the shipping system on 99 of 100 cases. So the model's measured
contribution is one case in a hundred. What it genuinely buys is the reading: the nine
checks are blind to documents and cannot notice ambiguity. And verdict accuracy is the
wrong test anyway — this is a workflow, and what it removes is the repetition.

**Do not say "rules-only pays ₹36,89,100 in error."** It is arithmetically true and it
collapses the moment a judge changes one literal in `backend/eval/arms.ts`.

**"What's on chain, and does it matter?"** — Cut from the video for time; answer it here.
Every filed claim anchors its evidence hash in a real Base Sepolia transaction, and `/health`
names the latest one. Anchoring is permissionless but marking a claim *verified* is restricted to
the contract owner — the same bounded authority as the model ceiling, enforced on chain. And
Filecoin archival has never succeeded here, so the contract anchors the hash with an empty
locator: "hashed, not stored" is an honest record, and attesting a storage id that does not
exist would put a false claim on a public ledger.

**"What would you build next?"** — Re-run the ablation against the shipped Groq model, and spend the
sealed holdout once. Both are named in `EVALUATION.md` as not done.

---

*~800 spoken words ≈ 5:20 at pace. Figures: ICICI Lombard FY24 annual report, IRDAI, and the
General Insurance Council. Journey and refusal figures from `EVALUATION.md` and
`backend/eval/journey/`; ablation figures from `backend/eval/results/four-arm-dev.txt` and
`run-dev.json`. Where this document and those files disagree, the files are right.*

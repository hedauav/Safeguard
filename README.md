# SafeGuard

**An AI voice agent for insurance claims, where a person still makes every decision.**

A policyholder speaks to it in a browser. It looks up claims, explains coverage,
names the documents still outstanding, files new claims, takes payment for a
lapsed premium or an excess, and escalates to a human. Behind it, a dashboard
where an adjuster reads the reasoning behind a recommendation and approves or
rejects before any claim moves or any money leaves.

| | |
| --- | --- |
| **Dashboard** | https://safeguard-dashboard-cyan.vercel.app |
| **API health** | https://safeguard-api-production-7c24.up.railway.app/health |

Click **Start a call** in the bottom-right of the dashboard to talk to the agent
in your browser.

![The SafeGuard dashboard with the call widget open in the bottom-right corner, ready to take a browser call.](assets/call-widget.png)

Razorpay AI Buildathon 2026, Open Track.

---

## The problem

My family held a health policy for close to ten years. A family member needed
emergency surgery. It then took **four months to file the claim** — not to settle
it, to file it.

Four months of repeated calls, each one starting over: the policy number again,
what happened again, which documents were needed — a different answer each time,
because the answer lived in whoever picked up. Nothing carried between calls.
What eventually came back was on the order of five or six percent of the bill,
and the remainder is still "under review" with no date attached.

Two grievances sit in that story and **only one of them is a software problem**:

- **The five percent is underwriting.** Policy terms, sub-limits, copays,
  exclusions. Nothing downstream of that decision changes it, and this project
  does not claim to.
- **The four months of repetition is not.** Every one of those calls existed
  because the previous call left no trace a system could read.

**The repetition is what SafeGuard removes.** One interaction files the claim,
names the documents that claim actually requires, takes the upload and collects
the excess — and every step after that is a timestamped row a claimant can be
shown, instead of the word "processing" repeated by a different person each time.

The full problem statement, the sourced numbers behind it, and the boundary
between what this fixes and what it cannot, are in
**[PRODUCT_PRD.md](PRODUCT_PRD.md) §2**.

---

## What it does, and what it refuses to do

The design property worth judging it on: **the model holds no claim facts.**
Every figure it speaks came back from a tool call against Postgres in the same
turn. It cannot invent a claim number because it never holds one.

- **Nine deterministic checks run before any model call**, and any one of them
  can veto. Policy in force on the incident date, claim type within cover, amount
  inside the limit, no near-duplicate, something left after the excess. Pure
  arithmetic — no network, no model.
- **The money tools take no amount parameter.** `settle_claim`,
  `collect_deductible` and `offer_renewal` take a reference number. The model has
  no slot in which to name a figure.
- **The model recommends; it never decides.** It cannot approve anything. A named
  human answers every recommendation before a claim moves.
- **Everything that fails escalates.** A parse failure, an API error, a
  recommendation that could not be recorded — each becomes an escalation, never
  an approval.
- **Where the model's arithmetic disagrees with the code's**, the claim escalates
  with both figures named, rather than the lower one being paid quietly.

How each of these is enforced, and where: **[ARCHITECTURE.md](ARCHITECTURE.md)**
§13 (adjudication), §12 (settlement), §20 (security), §23 (design principles).

**What it does not do.** It does not set payouts, does not model the copays and
sub-limits that produce a settlement figure, does not adjudicate medical
necessity, and does not remove the human decision. Claim settlement payouts are
**simulated** — they need RazorpayX and business KYC this account does not have,
and `/health` says so. Filecoin archival is wired but **has never succeeded**;
the on-chain attestation on Base Sepolia is real. Both are disclosed wherever
they appear.

---

## Try it

Talk to the agent at the dashboard link above.

**1. Check a claim**

> "I'd like to check on my claim, CLM-2026-000456."

Expect: a **collision** claim, **under review**, adjuster **Neha Agarwal**,
**₹8,275** claimed.

**2. Ask what's outstanding**

> "What documents do you still need?"

Expect: **repair estimate** and **photos**. The police report and other driver
info are already on file.

**3. Check coverage**

> "What does policy POL-2024-001234 cover?"

Expect: auto, **active**, **₹50,000** coverage, **₹1,000** deductible,
**₹185.50/month**, a 2023 Honda Accord.

**4. File a new claim**

> "I need to file a claim on POL-2026-100001. Someone backed into my car in a
> parking lot yesterday and dented the rear door."

`POL-2026-100001` is one of the policies held clean for exactly this — it carries
no claims, so the walkthrough starts from nothing.

Expect: a **new claim number** read back, status submitted, plus next steps.

**5. Escalate**

> "My claim CLM-2026-000789 was denied and I'm not happy about it."

Expect: acknowledgement of the denial, then an offer to escalate. Say yes and you
get a **reference number** and an SLA.

Then open **Call History** in the dashboard — your call appears with the full
transcript and every tool the agent invoked.

More walkthroughs, the claims and policies to use, and the cases that **must be
refused**: **[TESTING.md](TESTING.md)**.

### Run the whole journey yourself — the happy path

**This is the product: one claim, filed to refunded, without a second phone
call.** Two policies are held back carrying no claims at all, so a journey
started on either begins from nothing and cannot collide with anything filed
before it.

| Policy | Type | Excess | Claim this much |
| --- | --- | ---: | --- |
| `POL-2026-300010` | home | ₹5,000 | ₹15,000 – ₹40,000 |
| `POL-2026-300011` | home | ₹5,000 | ₹15,000 – ₹40,000 |

Open the dashboard, click **Start a call**, and say this.

**1 — File it**

> "I need to file a claim on policy P-O-L, twenty twenty-six, three zero zero
> zero one zero. A pipe burst in the kitchen and damaged the flooring and the
> lower cabinets. The repair quote is about thirty thousand rupees."

The agent reads back a claim number. Behind it, nine deterministic checks have
already run and the claim has been adjudicated — **do not ask it to adjudicate
again**, filing already did.

**2 — Send the documents it asks for**

It names what the claim actually requires and an upload card appears in the call
widget. Drop any PDFs in. Filing happens before documents exist, so the
recommendation will read **escalate** — the model saying it cannot verify what it
has not seen. That is the design, not a failure.

**3 — Pay the excess**

It offers a real Razorpay link for ₹5,000. Pay it with a test card, and
**untick "Save this card"** — leaving it ticked diverts into an OTP flow that
never completes the payment.

**4 — Decide it, as a human**

Dashboard → **Review Queue** → approve. **Set *Who was at fault* to "The other
party".** This is the step that matters: the refund gate refuses without a fault
finding, because a waiver is a finding of fact and no model may write one.

**5 — Settle**

The claim moves to **paid**, and the excess refunds automatically. Open the claim
page and the refund receipt is there with a real `rfnd_` id and a link to verify
it on Razorpay.

**Two things decide whether it reaches the end.** Fault recorded as *the other
party* before you settle, and a payable figure inside the **₹50,000** settlement
ceiling — the claim range above keeps it under. Payable is
`min(claimed, coverage) − excess`.

The settlement payout itself is **simulated** and every screen says so. The
excess going out and coming back is real money on Razorpay's ledger, and it is
the only money that moves.

Compare what you get against
[the run recorded here](backend/eval/journey/RESULTS.md), which completed
**10 of 10** stages on ten claims and returned ₹29,000.

> **One limit worth knowing.** Razorpay caps test mode at **30 payment links per
> business, for the life of the account** — it is not a daily quota and it does
> not reset. Enough remain for several journeys, but if you see `link_failed` at
> the excess step that is the cap, not a bug: every stage before it still runs,
> and [FAILURE.md](FAILURE.md) §7 records it. A second limit sits behind it —
> refunds are paid from the merchant balance rather than from the original
> payment, so a refund can be refused with a misleading "invalid request sent"
> when the balance is short. That is §8.


### The other paths

Once the journey makes sense, these show what it does when a claim should *not*
proceed:

| Policy | State | What it demonstrates |
| --- | --- | --- |
| `POL-2026-300018` · `300019` · `300020` | lapsed | Refused at intake, then renewable — pay the premium and the same policy accepts the claim |
| `POL-2026-400019` | cancelled | Refused at intake, and **not** renewable: a cancellation is a decision, not a missed payment |
| `POL-2026-400020` | expired | Refused at intake; the renewal path answers it |
| `POL-2026-300012`–`300015` | active, health | The model reads a copay the settlement formula does not, the two amounts disagree, and the claim escalates **naming both figures** |

That last row is worth doing deliberately. It is the clearest thing this system
does: when the model's arithmetic and the code's disagree, neither wins and a
human gets both numbers. It is a refusal demonstration, so do not use those four
for an approval run.

Batch 0026 covers eight further refusals at eight different gates —
[BATCH-0026.md](backend/eval/journey/BATCH-0026.md).

If any policy above already carries a claim when you look, say so: it means this
list is stale and the numbers beside it should be treated as such.


## Running it yourself

```bash
# Database — run backend/database/RUN-IN-SUPABASE.sql in the Supabase SQL editor.
# It is idempotent and creates every table plus the seeded book of business.

cd backend
npm install
cp .env.example .env        # fill in Supabase, ElevenLabs, Groq, Razorpay
npm run dev

cd ../frontend
npm install
cp .env.example .env        # VITE_API_URL, VITE_SUPABASE_URL, agent id
npm run dev
```

```bash
cd backend
npm test                    # the backend suite, src/**/*.test.ts
npx tsc --noEmit            # typecheck
npm run check:setup         # schema, dataset, evidence integrity
npm run check:numbers       # every number in these docs against its source
npm run evaluate            # the deployed agent against the evaluation cases
npm run ablate              # what each safety layer contributes
```

`npm run check:numbers` is the one worth knowing about: it reads the live
database, the test runner and the committed evaluation artifacts, then checks
every numeric claim in this repository's documentation against them. If a figure
here disagrees with its source, that command fails and names the file and line.

Environment variables, deployment targets and how each piece ships:
**[DEPLOYMENT.md](DEPLOYMENT.md)**.

---

## Where everything else is

Each document does one job, so a claim lives in exactly one place and cannot
drift from itself.

| Document | What it is for |
| --- | --- |
| **[PRODUCT_PRD.md](PRODUCT_PRD.md)** | The problem, who it is for, what is in and out of scope |
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | How it is built — 28 sections, one per flow, with the enforcement points |
| **[EVALUATION.md](EVALUATION.md)** | What was measured, how, and what the numbers do **not** support. Leads with the journey completion run — 10 of 10 claims through every stage, ₹29,000 collected and returned on Razorpay's ledger — then the refusal batch. The four-arm ablation is kept but demoted: it scores verdict accuracy, which is the right test for a classifier and the wrong one for a workflow |
| **[eval/journey/](backend/eval/journey/)** | The completion run: its pre-registration, committed before the first claim was filed, and the results rendered from the database |
| **[FAILURE.md](FAILURE.md)** | Six real incidents with a commit or a database row behind each, and what is still open |
| **[TESTING.md](TESTING.md)** | Walkthrough scripts, the dataset, and the cases that must be refused |
| **[TECHSTACK.md](TECHSTACK.md)** | Every dependency and why it is there |
| **[DEPLOYMENT.md](DEPLOYMENT.md)** | Environment, migrations, and how each of the four deploy targets ships |
| **[ENGINEERING_LOG.md](ENGINEERING_LOG.md)** | What broke, what replaced it, and the v1 → v2 rebuild |
| **[SUBMISSION.md](SUBMISSION.md)** | The Open Track write-up: every claim mapped to the file or commit that proves it |

**Read EVALUATION.md before quoting any number from this project.** The results
carry caveats that matter — the ablation measured a model the product does not
ship, the holdout is sealed and unspent, and the arm that wins on plain
exact-match accuracy is not the arm that ships. Those are stated there in full.

---

## Origin

SafeGuard began as a team hackathon prototype that never worked end to end. I
rebuilt everything between the domain logic and the outside world. What was
broken, what replaced it, and how to verify each claim is in
**[ENGINEERING_LOG.md](ENGINEERING_LOG.md)** — every assertion there cites a file
or a commit.

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
| **Verify the payments** | https://safeguard-dashboard-cyan.vercel.app/verify |
| **API health** | https://safeguard-api-production-7c24.up.railway.app/health |

Click **Start a call** in the bottom-right of the dashboard to talk to the agent
in your browser.

![The SafeGuard dashboard with the call widget open in the bottom-right corner, ready to take a browser call.](assets/call-widget.png)

The service says which half of the money loop is real, without you installing
anything:

```bash
curl -s https://safeguard-api-production-7c24.up.railway.app/health | jq .features
# deductible_collection_and_refund: "razorpay"   ← real money, both ways
# claim_settlement_payouts:         "simulated"  ← needs RazorpayX and KYC
```

---

## The numbers

Counted from the database and from Razorpay's ledger. `npm run check:numbers`
re-derives every figure below from its source and fails, naming the file and the
line, if a number in this repository disagrees with the system it describes.

| | |
| --- | --- |
| **Claims carried from a spoken sentence to a real refund** | **24** |
| Collected, then returned, on Razorpay's own ledger | **₹79,000** then **₹71,000** |
| Refund ids resolvable through Razorpay's API, every one `simulated: false` | **24** |
| **Journey completion run — every stage, every claim** | **10 of 10** |
| Refusal gates that behaved exactly as predicted, none of them consulting the model | **6 of 8** |
| Payable figures computed exactly as predicted before the run | **12 of 12** |
| Deterministic checks that run, and can veto, before any model call | **9** |
| Backend tests | **653** |

The completion run was pre-registered and committed **before the first claim was
filed** ([PRE-REGISTRATION.md](backend/eval/journey/PRE-REGISTRATION.md)), and its
results are rendered out of the database rather than typed
([RESULTS.md](backend/eval/journey/RESULTS.md)).

**What they are not.** Not a containment rate — seeded policies, operator as
caller, n = 10 on the completion run. Settlement payouts are simulated; the
excess going out and coming back is the only real money. Every caveat is stated
in full in **[EVALUATION.md](EVALUATION.md)**, which should be read before any
figure here is quoted.

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

The nine checks that run before any model call: policy in force on the incident
date, claim type within cover, amount inside the limit, no near-duplicate,
something left after the excess, and four more. Any one of them can veto. And
everything that fails — a parse error, an API error, a recommendation that could
not be recorded — becomes an escalation, never an approval.

```text
  caller speaks ─►  intake            refuses here, with no model in the path
                      │
                      ▼
                    nine checks       adjudication-rules.ts — pure arithmetic,
                      │               no network, no state. any one vetoes
                      ▼  all nine pass
                    the model         recommends only: approve · escalate · deny.
                      │               holds no claim facts. cannot approve
                      ▼
                    Review Queue      a named human decides, and records fault.
                      │               the only screen that can approve anything
                      ▼
                    settle_claim(ref) payable computed in code — the tool has no
                      │               slot for an amount
                      ▼
                    Razorpay          the refund fires from the fault finding,
                                      never from the asking
```

How each of these is enforced, and where: **[ARCHITECTURE.md](ARCHITECTURE.md)**
§13 (adjudication), §12 (settlement), §20 (security), §23 (design principles).

### Where a model is deliberately not used

The brief scores the right tool in the right place, **and where you chose not to
use one**. The absences are the design:

| Decision point | Model? | Why not |
| --- | :-: | --- |
| Whether a claim may proceed | **No** | Nine checks in `adjudication-rules.ts`, pure arithmetic. A model that can be talked out of a coverage limit has no business holding one. |
| What is payable | **No** | Computed in code. The money tools take a reference number, so the model has no slot in which to name a figure. |
| Who was at fault | **No** | A finding of fact, recorded by a named human. The refund gate reads it later and refuses without it. |
| Whether the refund fires | **No** | It follows from that finding. `refund_deductible` is not an agent tool: *a voice tool that refunds on request refunds to whoever asks convincingly.* |
| Approving anything | **No** | One screen approves. Every failure path escalates rather than approves. |
| What the caller means, and which tool that implies | **Yes** | Speech under a real accent, in a real room, with a policy number said aloud. This is what a model is for. |
| Whether the documents support the claim | **Yes**, as a recommendation | It states its doubts in English and a human answers them. Where its arithmetic disagrees with the code's, the claim escalates with both figures named. |

The model owns **what was said**. Code owns **whether anything moves**.

### The table above, as live rows

Not an assertion — the deployed system, readable without a key:

```bash
curl -s https://safeguard-api-production-7c24.up.railway.app/api/evidence/recent | jq '.adjudication'
```

Snapshot, 2026-08-30:

| Claim           | Verdict  | Model called | Stopped by                |
|-----------------|----------|--------------|---------------------------|
| CLM-2025-011041 | deny     |      no      | policy_not_cancelled      |
| CLM-2025-011032 | escalate |      no      | claim_not_already_decided |
| CLM-2026-000890 | escalate |     yes      | —                         |
| CLM-2024-011011 | escalate |      no      | claim_not_already_decided |
| CLM-2025-011047 | deny     |      no      | policy_not_cancelled      |
| CLM-2026-000456 | escalate |     yes      | —                         |

Four of the six never reached a model. Each was settled by arithmetic — a
cancelled policy, a claim already decided — and the rules layer short-circuits
before any provider call is made. That is the cheaper path and the stricter one:
a lapsed policy is refused by a date comparison, not by a model behaving well
that afternoon.

The two that did reach it carry the provider and the model on the row: `groq`,
`openai/gpt-oss-120b`, `simulated: false`, 594 ms and 1389 ms, confidence 0.95
and 0.90 — and `model_proposed_amount: null` on both. It named no figure. Both
escalated, and both carry the reason in English: "No supporting documents have
been uploaded for this claim." That sentence is what the model is for. The null
beside it is what the model is not for.

The ratio is not a usage statistic and should not be read as one — the review
queue holds the cases awaiting a human, so vetoes and escalations are
over-represented in it by construction. What the rows establish is narrower and
is the whole claim: the model runs, and it runs only where the rules could not
decide.

**What it does not do.** It does not set payouts, does not model the copays and
sub-limits that produce a settlement figure, does not adjudicate medical
necessity, and does not remove the human decision. Claim settlement payouts are
**simulated** — they need RazorpayX and business KYC this account does not have,
and `/health` says so. Filecoin archival is wired but **has never succeeded**;
the on-chain attestation on Base Sepolia is real. Both are disclosed wherever
they appear.

---

## What of Razorpay's this uses

| Razorpay ships | SafeGuard uses it for |
| --- | --- |
| **Payment Links** | the excess a claimant owes before a claim can settle, and a lapsed premium before a claim will be accepted at all. Real links on ordinary test keys. |
| **Refunds API** | returning that excess when the adjuster records the other party at fault. A refund is issued against the *payment*, never the link, with a deterministic `receipt` so a retried call collides at Razorpay rather than paying twice. |
| **Webhooks** | `payment_link.paid`, `payment.failed`, `payment_link.expired`, each HMAC-verified against the raw body before it is allowed to touch state. |
| **RazorpayX Payouts** | **not used — and this is the gap.** Settling the claim itself is a payout, which needs RazorpayX and business KYC this account does not have. Every settlement issues a `pout_sim_` id, and `/health` reports `claim_settlement_payouts: "simulated"` unprompted rather than letting the real refund imply the claim amount was paid. |

The captures and refunds themselves are readable without a key:

```bash
curl -s https://safeguard-api-production-7c24.up.railway.app/api/evidence/recent | jq '.razorpay'
```

The payment and refund ids it returns are the same ids the journey run recorded
in `backend/eval/journey/RESULTS.md`.

### Not our word for it — Razorpay’s

That endpoint reads our own database, which makes it a tidier way of asserting
the same thing. So there is a second one that asks Razorpay instead, payment by
payment, and publishes both answers beside each other:

**https://safeguard-dashboard-cyan.vercel.app/verify** — one page, no login, no
tooling, legible on a phone. Or the endpoint behind it:

```bash
curl -s https://safeguard-api-production-7c24.up.railway.app/api/evidence/verify | jq '.summary'

# and any single payment id, checked live and uncached:
curl -s https://safeguard-api-production-7c24.up.railway.app/api/evidence/verify/pay_XXXXXXXX | jq
```

Each row carries what we recorded, what Razorpay says about that id right now,
and a field-by-field comparison. A disagreement is reported as loudly as a
match; an endpoint that could only ever answer "confirmed" would be worth
nothing. Against the live book today: **26 payments, 18 confirmed by Razorpay,
0 disagreements.**

The remaining 8 are the honest part. They were collected through an earlier
Razorpay test account that has since hit its transaction limit, and a Razorpay
key can only read the account it belongs to — asked about a payment on another,
the API answers `400 "The id provided does not exist"`, which is also what it
answers for an id that never existed. Those two are indistinguishable from
outside, so the endpoint reports `not_on_this_account` and declines to claim
either. Their stored figures render and are excluded from the Razorpay column
rather than quietly folded into it. Setting `RAZORPAY_ARCHIVE_KEY_ID` and
`RAZORPAY_ARCHIVE_KEY_SECRET` adds that account to the lookup and confirms them
too; the code path is wired and tested and activates on its own.

Two caveats the page states rather than buries. This is Razorpay **test mode** —
the integration and the API calls are genuine, the rupees are not. And the
lookup is relayed through this API, because test-mode records need the merchant
key to read: it narrows what has to be trusted from "their database and every
figure in their README" to "their server relayed one API response faithfully",
which is a real reduction and is not zero.

---

## Run the whole journey yourself

**You will play two people.** There is one interface, not two, and that is
deliberate: separate portals would have meant a login, a role switch and two sets
of screens to explain, none of which is the product. The switch below is a change
of hat, not a change of software.

- **As the policyholder**, you speak to the voice agent — file the claim, send
  documents, pay the excess, ask what happened.
- **As the insurer's adjuster**, you open the Review Queue and decide the claim.

Two policies are held back carrying no claims at all, so a journey started on
either begins from nothing:

| Policy | Type | Excess | Claim this much |
| --- | --- | ---: | --- |
| `POL-2026-300010` | home | ₹5,000 | ₹15,000 – ₹40,000 |
| `POL-2026-300011` | home | ₹5,000 | ₹15,000 – ₹40,000 |

---

### 1 · As the policyholder — file the claim

Open the dashboard, click **Start a call**, and say:

> "I need to file a claim on policy P-O-L, twenty twenty-six, three zero zero
> zero one zero. A pipe burst in the kitchen and damaged the flooring and the
> lower cabinets. The repair quote is about thirty thousand rupees."

It reads back a claim number. Nine deterministic checks have already run and the
claim has already been adjudicated — **do not ask it to adjudicate again**,
filing did that.

### 2 · Still the policyholder — send the documents

It names what this claim requires and an upload card appears in the call widget.
Drop PDFs in.

The recommendation will read **escalate**. Adjudication runs the moment the claim
is filed, before any document exists, so the model is saying it cannot verify
what it has not seen. That is the design.

---

### 3 · Now you are the insurer — decide it

Leave the call. Open **Review Queue**.

This is the only screen in the product that can approve anything. Read what the
machine actually produced: the nine checks with their reasons in English, the
model's recommendation and its stated doubts, the documents, and the payable
figure computed in code rather than proposed by the model.

Then decide, and **set *Who was at fault* to "The other party"**.

That fault finding is the step everything downstream depends on. It is a finding
of fact, no model may write it, and without it the refund refuses at its own
gate later — correctly, and by design.

*(Reject instead, and the claim shows as denied on the claim page with the reason
recorded. Worth doing once on a second claim to see it.)*

---

### 4 · Back to the policyholder — pay the excess

Return to the call and ask where the claim has got to:

> "What's happening with my claim? Is there anything I need to pay?"

It offers a real Razorpay link for the ₹5,000 excess. Pay it with a test card and
**untick "Save this card"** — leaving it ticked diverts into an OTP flow that
never completes the payment.

### 5 · Ask it to settle — and the refund happens on its own

> "Can you settle the claim now?"

The claim moves to **paid**, and the excess refunds automatically in the same
step.

**You cannot ask for the refund, and that is the point.** `refund_deductible` is
deliberately not one of the agent's tools: *"a voice tool that refunds on request
is a voice tool that refunds to whoever asks convincingly."* The refund happens
because an adjuster recorded fault in step 3 — not because a caller asked for it.

Open the claim page and the receipt is there: a real `rfnd_` id, Razorpay's own
current status, and a link to verify it against their API.

---

**What is real and what is not.** The excess going out and coming back is real
money on Razorpay's ledger. The settlement payout itself is **simulated** — it
needs RazorpayX and business KYC this account does not have — and every screen
says so rather than letting the refund imply the claim amount was paid.

Compare what you get against
[the run recorded here](backend/eval/journey/RESULTS.md): ten claims, ten of ten
stages, ₹29,000 returned.

> **Two limits worth knowing before you start.** Razorpay caps test mode at
> **30 payment links per business for the life of the account** — not a daily
> quota, and it does not reset. Enough remain for several journeys; if you see
> `link_failed` at the excess step, that is the cap rather than a bug, and every
> stage before it still runs ([FAILURE.md](FAILURE.md) §7). Second: refunds are
> paid from the merchant balance, not from the original payment, so a refund can
> be refused with a misleading *"invalid request sent"* when the balance is short
> (§8).


That is the happy path, and it is the one worth running first.

The refusal paths — a lapsed policy renewed before it will accept a claim, a
cancelled one that never will, and the eight gates a claim can be refused at —
are in **[TESTING.md](TESTING.md)**, along with the scripts for each.

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

## Deployment

Four copies of this project exist. A push to `main` now updates two of them, and
that is stated here because assuming otherwise is how the repository, the docs
and production came to disagree earlier on ([FAILURE.md](FAILURE.md) §5).

- **API** — Railway, from `backend/Dockerfile`, healthcheck `/health`. CI
  typechecks and runs the suite first, stamps the commit into the build, then
  polls `/health` until `git_sha` matches the commit it just shipped — so a
  deploy that silently did not land fails loudly instead.
- **Dashboard** — Vercel, lint and build gated the same way. Its job is
  independent of the API's, so a Railway outage does not hold it back.
- **Database** — Supabase Postgres. **Migrations are not automated**: apply
  `database/RUN-IN-SUPABASE.sql` by hand *before* pushing code that writes a
  column the database does not have yet.
- **Voice agent** — ElevenLabs. Its definition lives in the database rather than
  in this repository, so no push deploys it. **Agent Config → Sync**, or
  `npm run setup:elevenlabs`.

Config: `.github/workflows/deploy.yml`, `backend/railway.json`,
`backend/Dockerfile`, `frontend/vercel.json`. Full walkthrough, including the
credentials each target needs: **[DEPLOYMENT.md](DEPLOYMENT.md)**.

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
| **[FAILURE.md](FAILURE.md)** | Eight real incidents with a commit or a database row behind each, and what is still open |
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

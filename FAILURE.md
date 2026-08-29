# What broke, and how it was found

Razorpay's brief asks for the failure you handled gracefully, and for what broke at
2 AM and how you got out. This is that record.

Every incident below is a real one with a commit or a database row behind it. Nothing
here is a hypothetical, and nothing has been tidied into a cleaner story than it was.
Two of them cost real money. One is still open, and is listed as open.

The pattern worth noticing across all of them: **the first diagnosis was usually one
level too shallow.** The bug that got reported was a symptom of a design decision made
somewhere else, and fixing the reported symptom would have left the real fault in
place. Each entry names the shallow fix that was rejected and why.

---

## 1. A settlement was announced, and the caller's money went unmentioned

**Commit** `0b0f7a3` · **Cost:** real money, held, released by hand

### What happened

A test call filed a claim, paid a ₹1,000 deductible, had it approved, and heard the
settlement announced with no mention of the excess at all. The caller was left assuming
the money was gone.

It was not gone. It was held, waiting for somebody to record who was at fault.

### The shallow fix that was rejected

Write the missing sentence. That would have changed nothing: the sentence was not merely
unspoken, it was **never generated**. `settleClaim` short-circuited on
`faultWaivesDeductible` — which is false both when nobody recorded fault and when the
insured was at fault — and never consulted the refund path at all. There was no log line
either. Fixing the spoken line alone would have left that call exactly as silent.

### The actual fix

The refund is now consulted whenever a payment rail exists, and **its own refusal is the
answer.** The two cases cannot be told apart from the settlement layer without duplicating
a private classification and getting it wrong in the direction that matters: telling
somebody whose fault is recorded as undetermined that their excess "stays applied" reads
as *money is gone*, and it is false.

Each refusal reason gets its own sentence, and the grouping is the point:

| Reason | What the caller hears |
|---|---|
| Fault not yet determined | The money is held, and none of it is lost |
| A finding that does not waive | The excess stands |
| A failure of ours | A failure of ours — never that the caller's money moved |
| Refunded, but our record failed | Exactly that, because the money really did move |
| No captured payment | **Nothing.** Deliberate silence |

That last row is a decision, not an omission. The caller has no money in question, so
every available wording invents one — a neutral "there is nothing to refund" plants a
refund they were never expecting.

### The cause behind the cause

The reviewer had approved without recording fault. That is permitted and must stay
permitted: somebody who genuinely does not know should not have to assert. But nothing
told them what the omission would cost.

It now asks once, and says the part that matters — no refund follows this approval, not
now and not at settlement, and this recommendation cannot be answered a second time to add
one. **That last clause is why the money in the reported call needed a hand-written
`UPDATE` to release.**

---

## 2. A caller was read a link they had already paid, and ₹1,980 was never found

**Commit** `020462f` · **Cost:** ₹1,980 captured on 26 August that the system never knew about

### What happened

A caller asked to renew and was read a payment link that had already been paid. They
tapped it, Razorpay told them it was paid, no new payment happened, so no webhook fired,
and the policy stayed expired. The agent then said the payment might take a while —
untrue, and it had no way to know better.

### Root cause

`paid` was not in `SPENT_LINK_STATUSES`. The comment in the code argued that a paid link
still counts as live so nobody is billed twice. **The conclusion was right and the premise
was backwards.** Razorpay will not take a second payment against a paid link, so reusing
one protects nobody — it just reads out a dead URL. The double-demand guard belongs in the
branches above, which refuse outright when the money is already in.

### Why the obvious fix would have been worse than the bug

Simply marking `paid` as spent would have broken a worse case. A row that is paid but not
yet activated — exactly what a failed policy write leaves behind — would become "spent",
fall through, and issue a **second link to somebody who has already paid.**

So the table is consulted first, and that state routes into reconciliation rather than into
create. A row carrying a `payment_id` is now unreusable whatever its status says: status is
a label a webhook wrote, `payment_id` is money we actually hold, and **where the two
disagree, the money wins.**

### The deeper fault

Trusting a local row at all. It is only as fresh as the last webhook that landed, and one
demonstrably did not. The rail is now asked what the link's state actually is before
anything is offered.

---

## 3. The system refused to record money it could not authenticate

**Evidence** `EVALUATION.md` → *The control, which was an accident* · **Still visible as a row today**

### What happened

A ₹1,000 link (`plink_TU2Zrnt5sYbxvY`) was paid **before the webhook existed**. Razorpay
records it as paid and captured. This system still shows it as `status: created`,
`payment_id: null`, `captured_at: null`.

Same code, same account, the same afternoon. The only variable was whether
`RAZORPAY_WEBHOOK_SECRET` was set, and therefore whether the delivery could be
authenticated.

### Why this is in the "handled gracefully" column

**The system declined to record a capture it could not verify, rather than trusting an
unsigned request.** That is the behaviour you want from anything that touches money, and
it is visible here as a database row rather than as an assurance in a README.

It became an accidental control: the same path, with and without signature verification,
on the same day.

### The real gap it exposed, and the fix

Capture depended *entirely* on the webhook arriving. Razorpay knew about that ₹1,000
payment and this system had no way to find out except by being told.

A reconciliation fallback now exists. `collect_deductible` and `offer_renewal` both query
the provider for a link they are about to re-offer, and a capture the webhook never
delivered is discovered and written through `reconcileDiscoveredCapture`
(`deductible-service.ts`, `renewal-service.ts`) — under its own ledger event
`reconciliation.payment_link.paid`, **so a recovered capture is never mistaken for a
webhook that arrived.**

### Honest status

That row is *still* `status: created` today, and that is the useful part. The fallback only
fires when something calls the tool again on that claim, and nothing has. Razorpay still
answers `status: paid, amount_paid: 100000`. **The recovery path exists and is untriggered**
— which is a different sentence from "we recovered it", and the weaker one is the true one.

---

## 4. A trailing newline in a secret was a hard 401

**Commit** `65ce886`

### What happened

The dashboard's Save and Sync buttons rejected an admin token that was correct.

The guard sliced `Bearer ` off the header and compared **lengths** before `timingSafeEqual`.
A token carrying a trailing space or newline — which is how an environment variable usually
goes wrong — failed the length check and came back "Invalid or missing admin token".

The sibling guard in `tools-token.ts` had always trimmed. These two had diverged because
they were copies.

### Fix

Both admin endpoints now share one implementation rather than a copy each, **so the next fix
cannot land on only one of them.**

### Two things found in the same area

- `saveAgentSettings` used `.update().eq('id', 1)`. If row 1 were absent, the update would
  match nothing, Supabase would report no error, and the caller would be told "Saved" while
  the value reverted — the exact symptom of a save that does nothing. It upserts now.
- Renaming the agent changed nothing a caller could hear: `agent_name` fed only the
  ElevenLabs workspace label, while the prompt and greeting carried the old name as a
  literal. Text an operator edited by hand is still never rewritten — a rename that
  string-substitutes a system prompt is a corruption nobody notices until a call goes wrong
  — so the API reports the conflict and lets a human decide.

---

## 5. The drift checker was itself asserting something untrue

**Commit** `2abf3d5`

The tool built to detect deployment drift claimed the dashboard deploys from GitHub via
Vercel. It does not.

Verified the hard way: four commits were pushed and the deployed bundle re-fetched — still
`index--lCqMktH.js`, still zero occurrences of `/review`. Vercel's git integration is not
connected.

`git push` updates GitHub and nothing else. **There are four copies of this system, and none
of them updates another:**

| Target | How it deploys |
|---|---|
| API | `npm run deploy` → `railway up` |
| Dashboard | `vercel --prod` |
| Voice agent | its own sync from Agent Config |
| GitHub | `git push` |

This one is worth reading twice, because it recurred. During the demo preparation on
28 August the same assumption was made again — a push to `main` was expected to rebuild the
dashboard, and did not. The commit above had already recorded why. **A fact being written
down is not the same as it being remembered**, which is an argument for the check being
executable rather than prose.

---

## 6. The ablation came back a negative result, and was published anyway

**Commit** `d440693` · **Evidence** `backend/eval/results/four-arm-dev.txt`

Scored over 100 labelled cases with the rules fixed before results, the four-arm ablation
does not say what a submission would want it to say.

On plain exact-match accuracy, **the harness prints "ship arm A" — rules only, no model.**

That recommendation was not followed, and the reason is a disagreement about the objective
rather than about the arithmetic. Exact-match treats a wrong approval and a wrong denial as
the same loss. They are not the same loss:

| Arm | Paid in error | Paid unreviewed |
|---|---:|---:|
| A — rules only | ₹36,89,100 | ₹69,55,700 |
| C — rules + model *(ships)* | **₹0** | **₹0** |

Arm C buys that with 47 over-escalations. A wrong approval is money gone; an
over-escalation is a person's time. So `scoring.ts` ships a `blendedCost()` that **throws**
rather than combine the two into one comforting number.

Publishing the arm that loses on the headline metric, and stating why, is the honest form of
the result.


### The part of that result which was wrong, found later

The ₹36,89,100 above is arithmetically correct and the conclusion drawn from it
was not. The nine checks produce only vetoes, so the harness had to invent an
approve verdict for the rules-only arm when nothing objected — one literal,
`source: 'rules_no_objection'` in `backend/eval/arms.ts`. That produced 65 of
that arm's 100 verdicts and every rupee of the figure.

Run the same arm defaulting to `escalate` instead, with no model and no API key,
and it pays **₹0** too, agreeing with the shipping configuration on **99 of 100
cases**. The model's measured contribution over a model-free baseline is one case.

Found by adversarial review on 2026-08-29, after the figure had been written into
the README, the PRD and the pitch script. It has been corrected in all three, and
the control is documented in [EVALUATION.md](EVALUATION.md). The shallow fix —
quietly restating the number — was available and was not taken.

---

## 7. Razorpay refused, and the refusal was correct

**Evidence** `RATE_LIMIT_EXCEEDED` from `POST /v1/payment_links` · **Found** 2026-08-29

### What happened

Seven of twelve claims in the approval batch could not be given a deductible
payment link. `collect_deductible` returned `link_failed` each time.

Asked directly, Razorpay said why:

```json
{"error":{"code":"RATE_LIMIT_EXCEEDED",
 "description":"test mode limit of 30 reached for payment_link"}}
```

Their documentation states it plainly: *"In test mode, you can create up to 30
Payment Links per business."* **A lifetime cap on the account, not a rate over a
window** — it does not reset daily or monthly, and a retry can never succeed.

### Why this is in the "handled gracefully" column

Nothing invented a link. Nothing recorded a capture that had not happened. The
caller was told `"Nothing has been charged, and we can try again"`, which is true
in the first half and optimistic only in the second.

The failure surfaced as `link_failed` — a named refusal reason with its own
sentence — rather than as an exception, a null URL rendered as a button, or a
fabricated `plink_` id. Two submissions surveyed in this same competition
synthesise a plausible-looking Razorpay order on API failure; this one does not,
and this incident is the evidence that it does not.

### The diagnosis that was wrong first

The initial reading was "Razorpay is rate-limiting a burst; wait and retry." Two
retries minutes apart failed identically, which killed that theory. The second
reading was "it resets daily" — stated out loud before it was checked, and also
wrong. Only asking the API directly produced the actual constraint, and only the
documentation established that it is a lifetime cap.

Recorded because the shape recurs: an error named `RATE_LIMIT_EXCEEDED` invites
the assumption that waiting fixes it, and here waiting never fixes it.

### What it costs

Fifteen claims were carried end to end before the cap; the sixteenth cannot be,
on this account. Continuing means either asking Razorpay Support to raise the
limit — which their docs invite — or a second test account, which splits refund
ids across two businesses and is recorded in [EVALUATION.md](EVALUATION.md)
where it affects what a reviewer can verify.

---


## Still open

Listed because a failures document that only contains solved problems is a marketing
document.

### Filecoin archival has never succeeded

`/health` reports `filecoin_uploads.configured: true`, `last_attempt: "failed"`,
**`last_success_at: null`.** Two claims filed during demo preparation on 28 August each
carried a null `filecoin_cid`; both have since been deleted as rehearsal artifacts, so
`/health` is the standing evidence rather than a row.

The evidence-archival path is wired, the error is captured rather than swallowed
(`0022`/`0023` added the `error` column and then fixed its exposure to `anon`), and the
Evidence page renders a Filecoin column that is empty for every recent claim. **It does not
work, and nothing in the product or the video claims that it does.** The on-chain
attestation on Base Sepolia is separate and is real.

### Settlement payouts are simulated

Payouts need RazorpayX and business KYC this account does not have.
`SimulatedPayoutProvider` issues a `pout_sim_` id and a `SIMUTR` reference, every row it
writes says `simulated: true`, and `/health` has always reported it. The spoken line to the
caller did **not** say so until it was fixed — it named the simulated reference as "the
reference for the transfer", which was the one place the omission could mislead a person.

### The ablation measured a model the product does not ship

The scored run used `mistral-large-latest`, because that is the provider whose token budget
the fetch could complete on. Production runs `openai/gpt-oss-120b` through Groq. **It is not
yet a result about the shipped model**, and no line in `EVALUATION.md` is written as though
it were. Re-running the harness against Groq is the work that would change that.

### The holdout is sealed and unspent

`backend/eval/holdout.lock.json` carries the sha256 of the holdout cases and their ground
truth, sealed at `2026-08-25T08:35:01Z` under rulebook v1.0.0, before any result was
measured. It has not been spent. A held-out split is worth exactly one honest measurement,
and spending it to improve a submission is how it stops being one.

---

## What changed structurally

Individual fixes matter less than the constraints that make a class of failure
unrepresentable. These are enforced in the database, not by remembering:

| Constraint | What it makes impossible |
|---|---|
| `adjudications_veto_precludes_model` | A row claiming both a deterministic veto and a model invocation — the short-circuit the whole design rests on |
| `adjudications_parse_failure_escalates` | Any row pairing a parse error with a non-escalate verdict |
| `adjudications_model_fields_match_invocation` | A row saying no model ran while carrying a model's output, latency, tokens, or cost |
| `journey_events`, append-only | A step that failed leaving no trace — a failure is an event |
| No `amount` parameter on money tools | A model naming a figure. It has no slot to name one in |

The prompt for adjudication is also deliberately **not shown** the payable figure computed
in code, so the model's arithmetic can be compared against ours rather than echoing it, and
a test asserts that figure never appears in the prompt text.

---

*Every commit hash in this document is in this repository's history, and every database row
described can be read back from the deployed system. Where this document and the code
disagree, the code is right.*

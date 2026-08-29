# SafeGuard — Test Dataset & Scenarios

The dataset in `backend/database/run-all.sql` is built so every tool and every
branch has data behind it. This is the reference for what exists and what to say
to exercise it.

Load it once into the Supabase SQL editor. It is idempotent — safe to re-run.

---

## The people

| Customer | Phone | Policies | Claims |
|---|---|---|---|
| Arjun Mehta | +1 415 555 0101 | `POL-2024-001234` auto · `POL-2024-005678` home · `POL-2022-000111` **active to 2028-08-26 — renewed twice through the product** | collision (under review), windshield (paid), + more |
| Priya Sharma | +1 415 555 0102 | `POL-2024-002345` auto | windshield (approved), collision (paid) |
| Rohit Kapoor | +1 415 555 0103 | `POL-2023-003456` auto | collision (**denied**), comprehensive (closed) |
| Ananya Iyer | +1 415 555 0104 | `POL-2024-006789` home | theft (submitted), water damage (docs needed) |
| Vikram Singh | +1 415 555 0105 | `POL-2024-007890` health | medical (submitted), medical (docs needed) |
| Kavya Reddy | +1 415 555 0106 | `POL-2025-004567` auto | collision (under review) |
| Rahul Nair | +1 415 555 0107 | `POL-2024-008901` home | fire damage (**docs needed, escalated urgent**) |
| Divya Patel | +1 415 555 0108 | `POL-2024-009012` health · `POL-2024-010123` life | medical (approved) |
| **Meera Joshi** | +1 415 555 0109 | `POL-2025-000333` auto · `POL-2024-000222` **cancelled** | **none** |

Those nine are the customers the first eleven scenarios use. The dataset holds 52
customers, 71 policies and 62 claims in all; the settlement, renewal and document
scenarios below draw on the wider set, and each names the fixture it uses.

The live database now holds **80** claims — 64 of them evaluation data, plus sixteen filed by the journey completion and refusal runs against fixture policies and excluded from it — the 62 seeded ones plus two filed
through the agent on real calls (`CLM-2026-716458`, `CLM-2026-976488`). Forty policies and forty customers are demo fixtures — the journey batch of 2026-08-28 and the refusal batch of 2026-08-29 — and all are excluded from the evaluation. Customers
and policies are still 72 and 91: nothing here creates either.

Phone numbers use the 555-01xx block reserved for fiction. To test the
personalised greeting from your own phone, point one customer row at your real
number:

```sql
UPDATE customers SET phone = '+15551234567' WHERE full_name = 'Arjun Mehta';
```

`GET /api/elevenlabs/conversation-init?phone_number=…` then returns that
customer's name, latest policy, and recent claims as dynamic variables, and the
agent greets them by name.

---

## What a run consumes

**Read this before you start.** Several scenarios below destroy the fixture they
run against, and one of them has already destroyed the fixture this document was
written around. Filing a claim spends a zero-claim policy. Settling a claim
spends the claim. Offering a renewal burns a Razorpay `reference_id` derived from
the policy number, permanently, whether or not anybody pays.

| Scenario | Repeats? | What it costs, and what to use next |
|---|---|---|
| 1–4, 7, 10, 11 | **yes** | Reads only. Run them as often as you like. |
| 5 — file a claim | **no** | Consumes Meera Joshi's clean history on `POL-2025-000333`. Verified still clean today. Once spent, the "no claim history" line in scenario 5 is no longer true; any active policy still files, it just is not a clean start. |
| 6 — refuse on an inactive policy | **yes** | The refusal writes nothing. But the *policy* it names has to still be inactive — see the scenario. |
| 8, 9 — escalate, callback | yes, but accumulates | Each run writes a row. 75 escalations and 69 scheduled callbacks are already on the table, against 3 and 2 seeded. |
| 12 — where to send a document | **yes** | Records nothing at all. |
| 13 — upload and verify | **no**, then yes | The first upload of a given file is 201; the same bytes again are the 409 fixture. Reset with the SQL at the end of this file. |
| 14 — settle a claim | **no** | Consumes the claim. `CLM-2026-011006` is *already spent* — reset it first, or use one of the substitutes named in the scenario. |
| 16 — offer a renewal | **no, and unrecoverably** | Burns the policy's next `reference_id` at Razorpay. Deleting the row does not give it back. Two clean lapsed policies remain; the scenario names them. |
| 18 — escalate to a regulator | yes, but accumulates | Writes an escalation each time. |

The reason this section exists is scenario 6. It was written around
`POL-2022-000111`, the renewal feature was then pointed at that policy and
worked, and the fixture stopped being a fixture. Every "Verified …" and every
count in this file was re-measured against the live database at `3c624c4`; anything
not marked as seeded is what the database holds now, and will move again the next
time somebody uses the product.

---

## Scenario scripts

Each row is a full conversation to run against the agent. "Should hear" is what
correct behaviour sounds like — if you get something else, the tool call failed.

### 1. Claim status — the common case

> "I'd like to check on my claim, `CLM-2026-000456`."

Should hear: a **collision** claim, **under review**, adjuster **Neha Agarwal**,
claimed amount **$8,275**. Exercises `lookup_claim`.

### 2. Missing documents

> "What documents do you still need for `CLM-2026-000456`?"

Should hear: **repair estimate** and **photos** still outstanding (police report
and other driver info already received). Exercises `check_documents`.

### 3. Nothing outstanding

> "Am I missing anything on `CLM-2026-000321`?"

Should hear: all required documents received. Exercises the empty-missing-list
branch, which reads differently from the case above.

### 4. Policy coverage

> "What does policy `POL-2024-001234` cover?"

Should hear: auto, SafeGuard, **active**, **$50,000** coverage, **$1,000**
deductible, **$185.50/month**. Exercises `check_policy`.

### 5. Filing a claim — happy path

> "I need to file a claim on `POL-2025-000333`. Someone backed into my car in a
> parking lot yesterday and dented the rear door."

Should hear: a **new claim number** read back, status submitted, and next steps.
Meera has no claim history, so this starts clean. Exercises `file_claim`, and
kicks off the evidence pipeline in the background.

**One-shot.** Meera is still clean — zero claims, zero claims on
`POL-2025-000333` — but the first run of this scenario ends that. There is no
second customer seeded with no history.

### 6. Filing against an inactive policy — the rejection

> "I want to file a claim on `POL-2022-011016`."

Should hear: that policy is **not active**, so a claim cannot be filed. It must
*not* invent a claim number. `fileClaim` refuses on `policy.status !== 'active'`,
so expired and cancelled land in the same place.

Same with `POL-2024-000222`, which is **cancelled**.

> **`POL-2022-000111` used to be this fixture, and it no longer is.** It was
> Arjun's expired auto policy, and it is now **active through 2028-08-26**. It
> was not edited by hand: it was renewed twice through the product, on
> 2026-08-26 and 2026-08-27, by two real Razorpay payments of ₹1,980 each
> (`pay_TUJsAY1wyNry8n` and `pay_TUhs4GqCdZSKVy`, both captured, both with an
> `activated_at` on the `policy_renewals` row). A windshield claim was then filed
> against the restored policy on a live call, adjudicated, settled and attested
> on Base Sepolia — `CLM-2026-976488`.
>
> That is the renewal feature working end to end, which is the best evidence in
> this repository and worth more than a test fixture. The cost is that the
> refusal it was seeded for now **succeeds**: `file_claim` on `POL-2022-000111`
> today files a real claim, and `offer_renewal` on it returns
> `policy_already_active`. Scenarios 6 and 16 have been moved onto policies that
> are still lapsed. Do not renew it back into a fixture — the point of a renewal
> is that it is not reversible.

The lapsed policies that remain, and who holds them:

| Policy | Holder | Type | Lapsed | Premium | 12-month renewal |
|---|---|---|---|---|---|
| `POL-2022-011016` | Vivek Chandran | auto | 2025-02-15 | 160.00 | **1,920.00** |
| `POL-2023-011033` | Manoj Thakur | health | 2026-03-01 | 455.00 | **5,460.00** |
| `POL-2022-011007` | Sameer Ghosh | auto | 2025-04-01 | 170.00 | 2,040.00 |
| `POL-2023-011022` | Lakshmi Narayanan | health | 2025-12-31 | 470.00 | 5,640.00 |
| `POL-2022-011030` | Ishita Banerjee | home | 2025-09-01 | 163.00 | 1,956.00 |

Any of the five refuses a claim. Only the **first two** are clean for scenario
16 — the other three already carry an open Razorpay link. See scenario 16.

### 7. Policy that does not exist

> "Can you look up policy `POL-9999-999999`?"

Should hear: not found, and a request to re-read the number. It must not
fabricate coverage details.

### 8. Denied claim → escalation

> "My claim `CLM-2026-000789` was denied and I don't accept that."

Should hear: acknowledgement of the denial, then an offer to escalate. Say yes.
Should hear a **reference number** and an SLA (**2 business hours** for high
priority). Exercises `lookup_claim` then `escalate_to_human`.

### 9. Callback scheduling

> "Can someone call me back tomorrow afternoon on 415-555-0101?"

Should hear: a specific confirmed date and time read back. The phrase is parsed
with `chrono-node`, so "next Tuesday morning" and "in two hours" also work.
Exercises `schedule_callback`.

### 10. Water damage

> "What's happening with `CLM-2026-000601`?"

Should hear: **water damage**, **documents needed**, $14,200 claimed, adjuster
**Sanjay Verma**, awaiting contractor estimate and damage photos.

### 11. Urgent open escalation

> "I'm calling about my fire claim, `CLM-2026-000345`."

Rahul Nair's claim has an **urgent** open escalation attached (displaced, hotel
costs). Visible under **Escalations** in the dashboard — and it is still the
**only** urgent row on a table that has grown to 75, so filter rather than scroll.

### 12. Sending in a document

> "I've got the repair estimate for `CLM-2026-000456`. Where do I send it?"

Should hear: what is still outstanding — **repair estimate** and **photos** — and
then the upload URL **read out on the call**. Nothing is sent: there is no SMS
or email sender in this backend, and Razorpay's own notifications are switched
off, so an agent that promises to text or email a link is promising something
that cannot happen. Exercises `attach_document`, which does not accept files
either: it returns the upload URL, the 10 MB ceiling, and the accepted types.
Nothing is recorded by this call.

Naming a document the claim does not ask for should be corrected on the call:

> "I want to send my medical records for `CLM-2026-000456`."

`requested_type_accepted` comes back `false`, and the agent should say the claim
does not ask for that and list what it does need.

On a claim with nothing outstanding — `CLM-2026-000321` — it should say so
instead of offering a link.

### 13. Uploading and verifying the file

The bytes never go through the agent. They go to the upload endpoint, which
hashes what it actually receives:

```bash
curl -X POST $B/api/claims/CLM-2026-000456/documents \
  -F 'document_type=repair_estimate' \
  -F 'file=@estimate.pdf;type=application/pdf'
```

Expect **201** with a `content_hash` (keccak256, `0x`-prefixed), a
`storage_status` of `stored`, `simulated`, or `unarchived`, and an
`evidence_hash` — the claim's bundle is re-anchored so it now commits to this
file. `cid` is null whenever the bytes were not archived; it is never a
placeholder.

Then check the same file back:

```bash
curl -X POST $B/api/claims/CLM-2026-000456/documents/<document_id>/verify \
  -F 'file=@estimate.pdf;type=application/pdf'
```

`match: true`. Change one byte of the file and it returns **200** with
`match: false` and both hashes — a mismatch is a successful check with a
negative answer, not a failed request.

The refusal paths, each with its own status code:

| Try this | Expect |
|---|---|
| Re-upload the identical file | **409** `duplicate_document` |
| `document_type=medical_records` on `CLM-2026-000456` | **422** `document_type_not_required` |
| A `.txt` or `.docx` file | **415** `unsupported_media_type` |
| Anything over 10 MB | **413** `file_too_large` |
| An unknown claim number | **404** `claim_not_found` |

### 14. Settling an approved claim

**`CLM-2026-011006` is already settled — run this SQL first or the scenario does
not start.** The claim carries `payout_id = 'pout_sim_d4c01e2a1b5ad6'` and status
`paid`, so the very first call returns `already_paid` rather than a settlement:

```sql
-- Un-settle CLM-2026-011006 so scenario 14 can be run at all
UPDATE claims SET
  status = 'approved', approved_amount = 5800,
  payout_provider = NULL, payout_id = NULL, payout_status = NULL,
  payout_amount = NULL, payout_utr = NULL, payout_simulated = false,
  paid_at = NULL
WHERE claim_number = 'CLM-2026-011006';
```

Or settle a different claim and leave this one alone. These are approved, unpaid,
and on active policies today — each figure is `claimed − deductible`:

| Claim | Holder | Settles to |
|---|---|---|
| `CLM-2026-000567` | Divya Patel (medical, 8,500 less 2,000) | **6,500.00** |
| `CLM-2026-011040` | Farah Qureshi (comprehensive, 6,800 less 750) | **6,050.00** |
| `CLM-2026-011014` | Anjali Deshmukh (theft, 5,600 less 2,000) | **3,600.00** |

Each of those is one-shot too. Then:

> "My claim `CLM-2026-011006` was approved. Can you pay it out?"

Karthik Subramanian's collision claim: **7,300** claimed against
`POL-2023-011004`, coverage 68,000, deductible 1,500. Should hear a settlement of
**5,800.00** and a transfer reference read back. Exercises `settle_claim`.

The tool takes the claim number and nothing else — there is no amount parameter,
so the agent has no way to name a figure. The amount is
`max(0, min(claimed, coverage) − deductible)`, computed on the server.

**The payout is simulated.** The payout id comes back prefixed `pout_sim_`, the
reference prefixed `SIMUTR`, and the claim row carries `payout_simulated = true`.
No money moves. See [ARCHITECTURE.md](ARCHITECTURE.md#12-claim-settlement-flow)
for why (RazorpayX, which the account does not have).

Ask again immediately:

> "Can you pay out `CLM-2026-011006`?"

Should hear that it has **already been settled**. The idempotency key is derived
from the claim number, so the provider returns the first payout rather than
creating a second. The gate is `status === 'paid' || payout_id` — either alone is
enough, which is why `CLM-2025-000999` in the next section refuses as
`already_paid` on its status despite carrying no `payout_id` at all.

### 15. Settlement refusals

Each of these must refuse, state a reason the caller can act on, and hand back
**no payout id**.

| Say this | Should hear | Reason |
|---|---|---|
| "Pay out `CLM-2026-000456`" | still with an adjuster | `claim_not_approved` |
| "Pay out `CLM-2025-000999`" | already settled | `already_paid` |
| "Pay out `CLM-2026-011003`" | nothing payable once the deductible is applied | `nothing_payable` |
| "Pay out `CLM-2026-011038`" | above what it can release alone; needs a claims manager | `above_auto_approve_limit` |

`CLM-2026-011003` is worth understanding: it is an approved 880 glass claim, and
its note says no deductible applies to glass — but the settlement rule uses the
policy's deductible of 1,000, so it computes to zero and refuses. The rule does
not know about per-peril waivers.

`CLM-2026-011038` is 54,200 claimed less a 1,500 deductible — **52,700**, above
the 50,000 default ceiling (`SETTLEMENT_AUTO_APPROVE_LIMIT`).

The `policy_not_active` gate has no fixture: no seeded claim is approved on a
lapsed or cancelled policy. It is covered by the unit tests instead.

### 16. Renewing a lapsed policy

This follows straight on from scenario 6, and it is the point of that refusal.

> "I want to file a claim on `POL-2022-011016`."
> …
> "Can I get that policy back?"

Should hear: the claim still cannot be filed, **and** a renewal link for
**1,920.00** — Vivek Chandran's lapsed auto policy at 160.00 a month for a
12-month term (`RENEWAL_TERM_MONTHS`). The URL should be read back. Exercises
`offer_renewal`.

`POL-2023-011033`, Manoj Thakur's lapsed health policy at 455.00 a month, is the
larger clean example: **5,460.00**.

**Those two are the only clean ones left, and each is good for one run.** See the
reset section at the end of this file for why a spent policy cannot be reused
even after deleting its row.

**These payment links are real** when `RAZORPAY_KEY_ID` and
`RAZORPAY_KEY_SECRET` are set: a genuine Razorpay short URL that can be paid in
test mode. Without credentials the link is simulated and its host ends in
`.invalid`, so it can never resolve — check `simulated` in the response, or
`renewal_payment_links` at `/health`, before reading a URL out to anyone.

Ask again and the **same link** comes back with `reused: true`. A second call
must never leave a customer holding two demands for the same premium. The reuse
is not taken on trust: the tool asks Razorpay what the link's status is now and
only offers it again if the rail says it is still payable. If the rail cannot be
reached it refuses with `link_status_unknown` rather than reading out a URL it
cannot vouch for.

**`POL-2022-011007`, `POL-2023-011022` and `POL-2022-011030` already have a link
open**, created 2026-08-25. Calling `offer_renewal` on any of them returns
`reused: true` on the *first* call, with the URL and reference already recorded —
which exercises the reuse path but not the create path. Their amounts are the
ones in the scenario 6 table, and they match what is on the rail: 2,040.00,
5,640.00 and 1,956.00.

### 17. Renewal refusals

| Say this | Should hear | Reason |
|---|---|---|
| "Renew `POL-2024-001234`" | already active, nothing to pay | `policy_already_active` |
| "Renew `POL-2022-000111`" | already active — because somebody renewed it | `policy_already_active` |
| "Renew `POL-2024-000222`" | cancelled, not lapsed — needs a representative | `policy_cancelled` |
| "Renew `POL-2026-011034`" | not in a state it can renew | `policy_not_renewable` (pending underwriting) |
| "Renew `POL-9999-999999`" | no such policy | `policy_not_found` |

No refusal returns a payment link or a link id. The cancelled case matters most:
a cancellation is a decision, and no amount of money offered here may reverse it.

### 18. Regulatory escalation

> "I want to file a formal complaint about claim `CLM-2026-000789`."

Should hear: a **reference number**, and — when EAS is configured — that an
on-chain attestation was recorded. The escalation is written before the
attestation is attempted, so a chain failure loses the attestation and not the
complaint. Exercises `escalate_to_regulator`.

**EAS is not configured on the deployed backend.** `/health` reports
`features.eas_attestation: false`, and no claim in the database carries an
`eas_uid`. So today this returns the reference number and nothing else — which is
the path that matters, since it is the one where the complaint survives. Do not
read the absence of an attestation as a failure here.

**`escalate_to_regulator` currently accepts only an internal UUID.** Unlike every
other claim tool, it does not resolve a spoken claim number, so
`"CLM-2026-000789"` returns "Claim not found". To exercise it you need the id:

```bash
curl -X POST $B/api/tools/escalate-to-regulator \
  -H 'Content-Type: application/json' \
  -d '{"claim_id":"13561ee8-304c-4e90-9262-d09a5dd40c27",
       "reason":"Denial disputed under Section 4.2","priority":"high"}'
```

That is Rohit Kapoor's denied pothole claim, `CLM-2026-000789`. On a live call
the id would have to come from a prior `file_claim` result or from the dashboard,
which is a real limitation rather than a test-harness detail.

---

## Dashboard checks

These counts are what the live database holds, not what `run-all.sql` seeds. The
seeded figure is given alongside wherever the two have parted, because the gap is
use rather than drift.

| Page | What should be there |
|---|---|
| **Claims** | **64** claims, spanning all 7 statuses — 62 seeded plus two filed through the agent on live calls |
| **Claim detail** → `CLM-2026-000456` | Policy block, customer, linked call history |
| **Call History** | **26** completed calls with full transcripts (10 seeded). Every call log is `completed`; there is no other status on the table |
| **Call detail** | Tool executions with args, results, and latency — **58** in all, of which **4 failed**. One is seeded: `check_documents` against `CLM-2026-00789`, a digit short, on Rohit's call. The other three came from real calls — two `lookup_claim` misses and an `offer_renewal` the caller talked over |
| **Analytics** | Non-zero totals, duration averages, status breakdowns |
| **Escalations** | **75** (3 seeded). All are `pending` and all unassigned; exactly **one** is **urgent** — Rahul Nair's fire claim. The urgent-and-unassigned state the page is meant to show is still there; it is one row in seventy-five, not one in three |
| **Blockchain** | 2 claims with CIDs; one attested, one stored-but-not-attested. Separately, **4** claims carry an `attestation_tx_hash` — one seeded and simulated, three genuinely written to Base Sepolia |
| **Review Queue** (`/review`) | **37** adjudications, each showing the model's verdict beside the payable figure computed in code |
| **Agent Config** | Live prompt and **14** tools fetched from the API — 12 `toolType: 'webhook'` plus the two client tools, `show_payment_link` and `show_upload_link`. Count them inside the `AGENT_TOOLS` array in `backend/src/config/agent-definition.ts`; a plain grep for `toolType` also catches the two interface declarations above it and reports 16 |

Run these against a dashboard built from the current source. The copy deployed at
`safeguard-dashboard-cyan.vercel.app` **does now carry the `/review` route** — it
was shipped since this section was last written. That is not automatic: Vercel is
not connected to the repository and the frontend goes out only when someone runs
`vercel --prod`, so it can fall behind again at any time. `npm run check:drift`
from `backend/` reports the dashboard's Review Queue route explicitly, along with
how far the API and this machine have diverged.

---

## Evidence integrity

Two claims are *seeded* with evidence bundles. The stored `bundle_hash` is a
genuine keccak256 of the stored `bundle_json`, so the check actually verifies
rather than always reporting a match:

| Claim | State |
|---|---|
| `CLM-2026-000456` | Stored **and** attested on-chain, PDP verified |
| `CLM-2026-000321` | Stored, **not yet attested** — the partial state |

The table now holds **12** bundles across **5** claims, because every claim filed
or amended through the product re-anchors its bundle and writes a new row. The
two seeded ones above are the fixtures; the rest are the trail left by real
calls.

On the claim detail page, **Verify Integrity** on `CLM-2026-000456` should
return `match: true`.

To confirm it can actually detect tampering, corrupt the bundle and re-check:

```sql
UPDATE evidence_bundles
SET bundle_json = jsonb_set(bundle_json, '{claimed_amount}', '"999999"')
WHERE claim_id = (SELECT id FROM claims WHERE claim_number = 'CLM-2026-000456');
```

It should now return `match: false`.

**Re-running `run-all.sql` does not restore it.** That insert is
`ON CONFLICT (id) DO NOTHING` like every other one in the file, so the corrupted
row is left exactly as you left it. Undo the tamper instead — the seeded bundle
has no `claimed_amount` key at all, so `jsonb_set` above *added* one and dropping
it puts the row back byte for byte:

```sql
UPDATE evidence_bundles
SET bundle_json = bundle_json - 'claimed_amount'
WHERE claim_id = (SELECT id FROM claims WHERE claim_number = 'CLM-2026-000456');
```

`match: true` again. If you corrupted it some other way, delete the row by its id
(`76ee01b7-b73d-4a5e-812e-69e859dc8dae`) and *then* re-run `run-all.sql`, which
will insert it fresh.

### The two chains do not behave the same, and only one of them works

This is the single most misread thing about the system, so it is spelled out.

**Filecoin archival has never once succeeded.** Not degraded, not intermittent —
never. `/health` on the deployed backend reports
`features.filecoin_uploads.configured: true` with `last_success_at: null` and
`last_attempt: "failed"`. Of the 12 rows in `filecoin_uploads`, the only two with
`upload_status: 'completed'` are the seeded pair, and both are flagged
`simulated: true`. Every one of the ten real attempts failed, against the
Calibration RPC (`ContractFunctionExecutionError` — `actor not found` on
`getProviderIds`, and `failed to apply on state with gas` on the Multicall
probe). A configured agent is not enough: real archival also needs a funded USDFC
Warm Storage rail, which this account does not have.

So: the seeded CIDs are real CIDv1 content addresses computed from the bundle
bytes, but nothing was ever uploaded to a live network and public IPFS gateways
will not resolve them. Live claim rows carry `filecoin_cid: null`. **Expect no
CID from a claim you file yourself, and do not treat its absence as a bug.**

**Chain attestation, by contrast, genuinely works.** `/health` reports
`chain_attestation.last_success_at` populated with a real transaction hash, and
three claims filed on live calls carry `simulated: false` alongside a Base
Sepolia `attestation_tx_hash`:

| Claim | Attestation tx |
|---|---|
| `CLM-2026-716458` | `0xff966337080a091bcfba1686bce8bcd7731bc3442c314c37b4402991b7c612c8` |
| `CLM-2026-976488` | `0x7f3ef7575b978ae29d22656ff4e884a5119dfb95dc04738db2cc9266d120a532` |
| `CLM-2026-011005` | `0xafbb33a53da4cceef515d4860b5e272aa14f6a139940b26676f43da4a94065ac` |

Those are checkable on a block explorer. The seeded `CLM-2026-000456` hash is
not — that row is `simulated: true`.

The agent wallet is funded (`balance_status: "funded"` at `/health`), which is
what keeps attestation working and is the first thing to check if it stops.

---

## API smoke tests

With the backend running:

```bash
B=http://localhost:3005

curl $B/health
```

`/health` is the first thing to read. It reports `security.tools_authentication`
as `enforced`, `development-bypass`, or `fail-closed`, and
`features.renewal_payment_links` as `razorpay` or `simulated`. On the deployed
backend today those read `enforced` and `razorpay`; alongside them,
`claim_settlement_payouts` reads `simulated`,
`deductible_collection_and_refund` reads `razorpay`, and `eas_attestation` is
`false`. Read all five before deciding a scenario has misbehaved — most surprises
in this file are a feature that is switched off, not a tool that is broken.

**Every tool endpoint is behind a shared token.** With `TOOLS_API_TOKEN` set,
send it on each call below — as `x-tools-token`, the header the ElevenLabs agent
is configured to send, or as `Authorization: Bearer`. Without it they return
**401**. With no `TOOLS_API_TOKEN` configured at all they fall open in
development and refuse with **503** in production, so a 503 here means the
deployment is missing its secret rather than that the endpoint is broken.

```bash
H="-H content-type:application/json -H x-tools-token:$TOOLS_API_TOKEN"

curl -X POST $B/api/tools/check-policy $H -d '{"policy_number":"POL-2024-001234"}'

curl -X POST $B/api/tools/check-documents $H -d '{"claim_number":"CLM-2026-000456"}'

# Must be refused — lapsed policy. NOT POL-2022-000111, which is active again
# and would file a real claim; see scenario 6.
curl -X POST $B/api/tools/file-claim $H \
  -d '{"policy_number":"POL-2022-011016","incident_description":"test"}'

# ...and the renewal that refusal should lead to: 1,920.00 for a 12-month term.
# One shot: this burns the policy's reference id at Razorpay for good.
curl -X POST $B/api/tools/offer-renewal $H -d '{"policy_number":"POL-2022-011016"}'

# Settles to 5,800.00 — but only after the reset SQL in scenario 14. As it
# stands the FIRST call refuses as already_paid, because the claim is paid.
curl -X POST $B/api/tools/settle-claim $H -d '{"claim_number":"CLM-2026-011006"}'

# What is outstanding, and where to upload it. Accepts no file.
curl -X POST $B/api/tools/attach-document $H \
  -d '{"claim_id":"CLM-2026-000456","document_type":"repair_estimate"}'

# Personalised greeting variables
curl "$B/api/elevenlabs/conversation-init?phone_number=%2B14155550101" \
  -H "x-tools-token:$TOOLS_API_TOKEN"
```

The document upload and verify endpoints in scenario 13 are **not** behind the
token — they take no token today. Rate limits apply throughout: 15/minute on the
routes that spend or move money — `file-claim`, `settle-claim`, `offer-renewal`,
`escalate-to-regulator`, `adjudicate-claim`, `collect-deductible` and
`refund-deductible` — 120/minute on the rest, and a 429 carries a `retry-after`.
`/health` reports all three ceilings under `security.rate_limits_per_minute`.

---

## Resetting between runs

Scenarios 5, 13, 14, 16 and 18 write to the database, and `run-all.sql` inserts
with `ON CONFLICT (id) DO NOTHING` — re-running it will **not** undo them. Reset
by hand. Scenario 14's un-settle is repeated here as the canonical copy; it also
appears in the scenario itself, because a reader who meets it only down here
meets it after the step it was meant to save.

```sql
-- Un-settle CLM-2026-011006. It is settled right now, so this is a
-- precondition for scenario 14, not only a reset after it.
UPDATE claims SET
  status = 'approved', approved_amount = 5800,
  payout_provider = NULL, payout_id = NULL, payout_status = NULL,
  payout_amount = NULL, payout_utr = NULL, payout_simulated = false,
  paid_at = NULL
WHERE claim_number = 'CLM-2026-011006';

-- Remove uploaded documents and put the received list back
DELETE FROM claim_documents
WHERE claim_id = (SELECT id FROM claims WHERE claim_number = 'CLM-2026-000456');

UPDATE claims
SET documents_received = ARRAY['police_report', 'other_driver_info']
WHERE claim_number = 'CLM-2026-000456';
```

That document reset is a **no-op today**: `CLM-2026-000456` currently carries no
`claim_documents` rows and its `documents_received` is already
`['police_report', 'other_driver_info']`. Scenario 13 starts clean. The six rows
on the table belong to `CLM-2026-976488` and `CLM-2026-011005`, uploaded on live
calls; all six have `cid: null` and `storage_status: 'unarchived'`, which is the
Filecoin story above showing through.

Renewals are the exception: **deleting a `policy_renewals` row does not let you
re-run the scenario against live Razorpay.** The reference id is derived from the
policy number and the number of links already recorded
(`nextRenewalReferenceId`), so with the row gone the next call computes the same
reference, and Razorpay rejects a reference it has already seen — the tool
refuses with `link_failed`. Use a different lapsed policy instead.

Five policies are lapsed and renewable. **Only two are clean:**

| Policy | Existing `policy_renewals` rows | Good for a fresh link? |
|---|---|---|
| `POL-2022-011016` | none | **yes** — 1,920.00 |
| `POL-2023-011033` | none | **yes** — 5,460.00 |
| `POL-2022-011007` | 1, razorpay, `created` | no — returns `reused: true` |
| `POL-2023-011022` | 1, razorpay, `created` | no — returns `reused: true` |
| `POL-2022-011030` | 1, razorpay, `created` | no — returns `reused: true` |

The bottom three were the clean ones when this list was first written and were
spent on 2026-08-25. Their rows are still `created`, so `offer_renewal` reuses
the link rather than refusing — but delete the row to force a fresh one and you
get `link_failed`, by exactly the reasoning above. That leaves two runs of
scenario 16 in the whole dataset, and no way to make more without a policy nobody
has offered a link on.

`POL-2022-000111` is not on this list any more: it was renewed, twice, for real,
and is active until 2028-08-26. Three rows sit against it — one simulated, two
`paid` and captured — and it is the only worked example in the database of a
renewal that went all the way through.

The service-level gates behind scenarios 12 to 18 also have unit coverage that
needs no database:

```bash
cd backend && npm test        # 620 tests, as the runner reports them today
```

Re-run at `3c624c4` and still 620, unchanged since `8da0356`, up from the 364 the
runner reported at `a4e6938`. Counting `test(` across the test files by hand
gives 573 — that number is wrong and the runner is the authority; every figure in
this section came from the runner.

It is `backend/src` and nothing else — exactly what the glob `src/**/*.test.ts`
reaches, and exactly what CI runs. Eighteen of the twenty test files are in
`src/services/`; the other two are in `src/routes/` — `agent-config.test.ts`
covers the config write path and `adjudication-review.test.ts` the review queue.
`TECHSTACK.md` carries the per-file breakdown.

The evaluation harness carries a further 85 tests of its own under
`backend/eval/tests/`, which are **not** in the 620. `npm test` does **not**
pick them up — its glob is `src/**/*.test.ts` — and neither does CI. Run them
by hand:

```bash
cd backend && npx tsx --test eval/tests/*.test.ts
```

85 at `3c624c4`, all passing, re-measured with the runner rather than counted from
the source.

The frontend has no tests. CI lints and builds it, and that is the whole of its
automated coverage.

---

## Regenerating

```bash
cd backend
npm run build
node database/build-test-dataset.mjs   # recomputes CIDs and evidence hashes
bash database/build-run-all.sh          # rebuilds the combined file
```

`database/dataset-reference.json` holds the generated ids and hashes.

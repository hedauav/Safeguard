# SafeGuard — Test Dataset & Scenarios

The dataset in `backend/database/run-all.sql` is built so every tool and every
branch has data behind it. This is the reference for what exists and what to say
to exercise it.

Load it once into the Supabase SQL editor. It is idempotent — safe to re-run.

---

## The people

| Customer | Phone | Policies | Claims |
|---|---|---|---|
| Arjun Mehta | +1 415 555 0101 | `POL-2024-001234` auto · `POL-2024-005678` home · `POL-2022-000111` **expired** | collision (under review), + more |
| Priya Sharma | +1 415 555 0102 | `POL-2024-002345` auto | windshield (approved), collision (paid) |
| Rohit Kapoor | +1 415 555 0103 | `POL-2023-003456` auto | collision (**denied**), comprehensive (closed) |
| Ananya Iyer | +1 415 555 0104 | `POL-2024-006789` home | theft (submitted), water damage (docs needed) |
| Vikram Singh | +1 415 555 0105 | `POL-2024-007890` health | medical (submitted), medical (docs needed) |
| Kavya Reddy | +1 415 555 0106 | `POL-2025-004567` auto | collision (under review) |
| Rahul Nair | +1 415 555 0107 | `POL-2024-008901` home | fire damage (**docs needed, escalated urgent**) |
| Divya Patel | +1 415 555 0108 | `POL-2024-009012` health · `POL-2024-010123` life | medical (approved) |
| **Meera Joshi** | +1 415 555 0109 | `POL-2025-000333` auto · `POL-2024-000222` **cancelled** | **none** |

Those nine are the customers the first eleven scenarios use. The dataset holds 32
customers, 51 policies and 62 claims in all; the settlement, renewal and document
scenarios below draw on the wider set, and each names the fixture it uses.

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

### 6. Filing against an inactive policy — the rejection

> "I want to file a claim on `POL-2022-000111`."

Should hear: that policy is **not active**, so a claim cannot be filed. It must
*not* invent a claim number. Exercises the guard in `fileClaim`.

Same with `POL-2024-000222`, which is **cancelled**.

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

### 10. Water damage — the newest claim

> "What's happening with `CLM-2026-000601`?"

Should hear: **water damage**, **documents needed**, $14,200 claimed, adjuster
**Sanjay Verma**, awaiting contractor estimate and damage photos.

### 11. Urgent open escalation

> "I'm calling about my fire claim, `CLM-2026-000345`."

Rahul Nair's claim has an **urgent** open escalation attached (displaced, hotel
costs). Visible under **Escalations** in the dashboard.

### 12. Sending in a document

> "I've got the repair estimate for `CLM-2026-000456`. Where do I send it?"

Should hear: what is still outstanding — **repair estimate** and **photos** — and
that a secure upload link is coming. Exercises `attach_document`, which does not
accept files: it returns the upload URL, the 10 MB ceiling, and the accepted
types. Nothing is recorded by this call.

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
creating a second, and the claim's `payout_id` is what the gate reads.

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

> "I want to file a claim on `POL-2022-000111`."
> …
> "Can I get that policy back?"

Should hear: the claim still cannot be filed, **and** a renewal link for
**1,980.00** — Arjun's expired auto policy at 165.00 a month for a 12-month term
(`RENEWAL_TERM_MONTHS`). The URL should be read back. Exercises `offer_renewal`.

**These payment links are real** when `RAZORPAY_KEY_ID` and
`RAZORPAY_KEY_SECRET` are set: a genuine Razorpay short URL that can be paid in
test mode. Without credentials the link is simulated and its host ends in
`.invalid`, so it can never resolve — check `simulated` in the response, or
`renewal_payment_links` at `/health`, before reading a URL out to anyone.

Ask again and the **same link** comes back with `reused: true`. A second call
must never leave a customer holding two demands for the same premium.

`POL-2023-011022`, Lakshmi Narayanan's expired health policy at 470.00 a month,
is the larger example: **5,640.00**.

### 17. Renewal refusals

| Say this | Should hear | Reason |
|---|---|---|
| "Renew `POL-2024-001234`" | already active, nothing to pay | `policy_already_active` |
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

| Page | What should be there |
|---|---|
| **Claims** | 62 claims spanning all 7 statuses |
| **Claim detail** → `CLM-2026-000456` | Policy block, customer, linked call history |
| **Call History** | 10 completed calls with full transcripts |
| **Call detail** | Tool executions with args, results, and latency — including one **failed** execution (a misread claim number on Rohit's call) |
| **Analytics** | Non-zero totals, duration averages, status breakdowns |
| **Escalations** | 3, one **urgent** and unassigned |
| **Blockchain** | 2 claims with CIDs; one attested, one stored-but-not-attested |
| **Agent Config** | Live prompt and 10 tools fetched from the API |

---

## Evidence integrity

Two claims carry real evidence bundles. The stored `bundle_hash` is a genuine
keccak256 of the stored `bundle_json`, so the check actually verifies rather
than always reporting a match:

| Claim | State |
|---|---|
| `CLM-2026-000456` | Stored **and** attested on-chain, PDP verified |
| `CLM-2026-000321` | Stored, **not yet attested** — the partial state |

On the claim detail page, **Verify Integrity** on `CLM-2026-000456` should
return `match: true`.

To confirm it can actually detect tampering, corrupt the bundle and re-check:

```sql
UPDATE evidence_bundles
SET bundle_json = jsonb_set(bundle_json, '{claimed_amount}', '"999999"')
WHERE claim_id = (SELECT id FROM claims WHERE claim_number = 'CLM-2026-000456');
```

It should now return `match: false`. Re-run `run-all.sql` to restore.

> The seeded CIDs are real CIDv1 content addresses computed from the bundle
> bytes, but nothing was uploaded to a live network — public IPFS gateways will
> not resolve them. Claims filed against a configured Filecoin agent get real,
> retrievable CIDs.

---

## API smoke tests

With the backend running:

```bash
B=http://localhost:3005

curl $B/health
```

`/health` is the first thing to read. It reports `security.tools_authentication`
as `enforced`, `development-bypass`, or `fail-closed`, and
`features.renewal_payment_links` as `razorpay` or `simulated`.

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

# Must be refused — inactive policy
curl -X POST $B/api/tools/file-claim $H \
  -d '{"policy_number":"POL-2022-000111","incident_description":"test"}'

# ...and the renewal that refusal should lead to: 1,980.00 for a 12-month term
curl -X POST $B/api/tools/offer-renewal $H -d '{"policy_number":"POL-2022-000111"}'

# Settles to 5,800.00. Run it twice: the second call must refuse as already_paid
curl -X POST $B/api/tools/settle-claim $H -d '{"claim_number":"CLM-2026-011006"}'

# What is outstanding, and where to upload it. Accepts no file.
curl -X POST $B/api/tools/attach-document $H \
  -d '{"claim_id":"CLM-2026-000456","document_type":"repair_estimate"}'

# Personalised greeting variables
curl "$B/api/elevenlabs/conversation-init?phone_number=%2B14155550101" \
  -H "x-tools-token:$TOOLS_API_TOKEN"
```

The document upload and verify endpoints in scenario 13 are **not** behind the
token — they take no token today. Rate limits apply throughout: 15/minute on
`file-claim`, `settle-claim`, `offer-renewal` and `escalate-to-regulator`,
120/minute on the rest, and a 429 carries a `retry-after`.

---

## Resetting between runs

Scenarios 13 to 16 write to the database, and `run-all.sql` inserts with
`ON CONFLICT (id) DO NOTHING` — re-running it will **not** undo them. Reset by
hand:

```sql
-- Un-settle CLM-2026-011006 so scenario 14 can be run again
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

Renewals are the exception: **deleting a `policy_renewals` row does not let you
re-run the scenario against live Razorpay.** The reference id is derived from the
policy number and the number of links already recorded, so with the row gone the
next call computes the same reference, and Razorpay rejects a reference it has
already seen — the tool refuses with `link_failed`. Use a different lapsed policy
instead: `POL-2022-011007`, `POL-2022-011016`, `POL-2023-011022`,
`POL-2022-011030` and `POL-2023-011033` are all expired and renewable.

The service-level gates behind scenarios 12 to 18 also have unit coverage that
needs no database:

```bash
cd backend && npm test
```

---

## Regenerating

```bash
cd backend
npm run build
node database/build-test-dataset.mjs   # recomputes CIDs and evidence hashes
bash database/build-run-all.sh          # rebuilds the combined file
```

`database/dataset-reference.json` holds the generated ids and hashes.

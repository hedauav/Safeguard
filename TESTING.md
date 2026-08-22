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

---

## Dashboard checks

| Page | What should be there |
|---|---|
| **Claims** | 12 claims spanning all 7 statuses |
| **Claim detail** → `CLM-2026-000456` | Policy block, customer, linked call history |
| **Call History** | 10 completed calls with full transcripts |
| **Call detail** | Tool executions with args, results, and latency — including one **failed** execution (a misread claim number on Rohit's call) |
| **Analytics** | Non-zero totals, duration averages, status breakdowns |
| **Escalations** | 3, one **urgent** and unassigned |
| **Blockchain** | 2 claims with CIDs; one attested, one stored-but-not-attested |
| **Agent Config** | Live prompt and 8 tools fetched from the API |

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

curl -X POST $B/api/tools/check-policy \
  -H 'Content-Type: application/json' -d '{"policy_number":"POL-2024-001234"}'

curl -X POST $B/api/tools/check-documents \
  -H 'Content-Type: application/json' -d '{"claim_number":"CLM-2026-000456"}'

# Must be refused — inactive policy
curl -X POST $B/api/tools/file-claim \
  -H 'Content-Type: application/json' \
  -d '{"policy_number":"POL-2022-000111","incident_description":"test"}'

# Personalised greeting variables
curl "$B/api/elevenlabs/conversation-init?phone_number=%2B14155550101"
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

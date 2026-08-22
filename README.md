# SafeGuard

## AI-Powered Insurance Claims Voice Assistant

SafeGuard is an AI-powered voice assistant that handles routine insurance claims support. Instead of navigating phone menus or waiting for a representative, a policyholder speaks naturally with an AI agent that can look up claims, explain coverage, identify missing documents, file new claims, schedule callbacks, and escalate to a human.

The agent never invents claim or policy facts. Every answer comes from a tool call against the live database.

---

## Live

| | |
| --- | --- |
| **Dashboard** | https://safeguard-dashboard-cyan.vercel.app |
| **API** | https://safeguard-api-production-7c24.up.railway.app |
| **Health** | https://safeguard-api-production-7c24.up.railway.app/health |

Click **Start a call** in the bottom-right of the dashboard to talk to the agent in your browser.

---

# Trying the agent

The database holds a full book of business — 12 customers, 16 policies, and 13 claims covering every claim status. The scenarios below use real records, so you can verify the agent is reading live data rather than improvising.

> **Speak naturally.** You can say claim numbers with or without the dashes — "C-L-M 2026 000456" and "CLM-2026-000456" both resolve.

> **End the call properly.** Billing is by connection duration, not speaking time. Closing the tab without ending the call keeps the meter running.

## Quick start — the five-minute walkthrough

**1. Check a claim**

> "I'd like to check on my claim, CLM-2026-000456."

Expect: a **collision** claim, **under review**, adjuster **Neha Agarwal**, **$8,275** claimed.

**2. Ask what's outstanding**

> "What documents do you still need?"

Expect: **repair estimate** and **photos**. The police report and other driver info are already on file.

**3. Check coverage**

> "What does policy POL-2024-001234 cover?"

Expect: auto, **active**, **$50,000** coverage, **$1,000** deductible, **$185.50/month**, a 2023 Honda Accord.

**4. File a new claim**

> "I need to file a claim on POL-2026-100001. Someone backed into my car in a parking lot yesterday and dented the rear door."

Expect: a **new claim number** read back, status submitted, plus next steps.

**5. Escalate**

> "My claim CLM-2026-000789 was denied and I'm not happy about it."

Expect: acknowledgement of the denial, then an offer to escalate. Say yes and you'll get a **reference number** and an SLA.

Then open **Call History** in the dashboard — your call appears with the full transcript and every tool the agent invoked.

## Claims in the database

| Claim | Customer | Type | Status | Amount | Outstanding documents |
| --- | --- | --- | --- | --- | --- |
| `CLM-2026-000456` | Arjun Mehta | collision | under review | $8,275 | repair estimate, photos |
| `CLM-2026-000321` | Priya Sharma | windshield | **approved** | $925 | none — all received |
| `CLM-2026-000789` | Rohit Kapoor | collision | **denied** | $4,180 | police report |
| `CLM-2026-000112` | Ananya Iyer | theft | submitted | $2,785 | police report, proof of purchase, doorbell footage |
| `CLM-2026-000601` | Ananya Iyer | water damage | documents needed | $14,200 | damage photos, contractor estimate |
| `CLM-2026-000345` | Rahul Nair | fire damage | documents needed | $44,800 | contractor estimates, inventory, housing receipts |
| `CLM-2026-000234` | Kavya Reddy | collision | under review | $3,220 | none |
| `CLM-2026-000567` | Divya Patel | medical | **approved** | $8,500 | none |
| `CLM-2026-000678` | Vikram Singh | medical | documents needed | $3,575 | PT records, itemized bills, treatment plan |
| `CLM-2026-000890` | Vikram Singh | medical | submitted | $4,485 | ER records, itemized bill, referral letter |
| `CLM-2025-000999` | Priya Sharma | collision | **paid** | $1,180 | none |
| `CLM-2025-000444` | Rohit Kapoor | comprehensive | **closed** | $6,775 | none |

Claims filed during testing also appear here — the agent creates real records.

## Policies in the database

| Policy | Customer | Type | Status | Coverage | Deductible | Premium |
| --- | --- | --- | --- | --- | --- | --- |
| `POL-2024-001234` | Arjun Mehta | auto | active | $50,000 | $1,000 | $185.50 |
| `POL-2024-005678` | Arjun Mehta | home | active | $450,000 | $2,500 | $210.00 |
| `POL-2024-002345` | Priya Sharma | auto | active | $35,000 | $500 | $145.00 |
| `POL-2023-003456` | Rohit Kapoor | auto | active | $75,000 | $1,500 | $220.00 |
| `POL-2024-006789` | Ananya Iyer | home | active | $320,000 | $2,000 | $175.00 |
| `POL-2024-007890` | Vikram Singh | health | active | $500,000 | $3,000 | $450.00 |
| `POL-2025-004567` | Kavya Reddy | auto | active | $40,000 | $750 | $155.00 |
| `POL-2024-008901` | Rahul Nair | home | active | $780,000 | $5,000 | $340.00 |
| `POL-2024-009012` | Divya Patel | health | active | $750,000 | $2,000 | $520.00 |
| `POL-2024-010123` | Divya Patel | life | active | $1,000,000 | $0 | $85.00 |
| `POL-2025-000333` | Meera Joshi | auto | active | $45,000 | $750 | $172.00 |
| `POL-2022-000111` | Arjun Mehta | auto | **expired** | $40,000 | $1,000 | $165.00 |
| `POL-2024-000222` | Meera Joshi | home | **cancelled** | $300,000 | $2,000 | $160.00 |

## Policies kept clean for a fresh walkthrough

The policies above all carry history, which is what makes lookups worth demonstrating — but it leaves nowhere to show the claim lifecycle from the beginning. These three are held with **no claims attached**, so a walkthrough can start at "file a claim" every time:

| Policy | Customer | Type | Coverage | Deductible | Use for |
| --- | --- | --- | --- | --- | --- |
| `POL-2026-100001` | Neel Kapadia | auto | $55,000 | $1,000 | collision, windshield, theft |
| `POL-2026-100002` | Sara Dsouza | home | $410,000 | $2,000 | water damage, fire, theft |
| `POL-2026-100003` | Imran Sheikh | health | $600,000 | $2,500 | medical |

### The full lifecycle, start to finish

**1 — File it**

> "I'd like to file a claim on policy POL-2026-100001. I was rear-ended at a stoplight yesterday and my back bumper is damaged."

The agent collects the policy number, incident description, and date, then reads back a new claim number. **Write it down** — you need it for the next steps.

**2 — Look it back up**

> "Can you check the status of that claim?"

Expect: status **submitted**, with the incident description you just gave. This is the proof it was genuinely written to the database, not remembered from context.

**3 — Find out what's needed**

> "What documents do you need from me?"

For a collision claim: police report, repair estimate, photos, other driver info — all outstanding, since the claim is new.

**4 — Escalate it**

> "Actually, I'd like to speak to a supervisor about this."

Expect a reference number and an SLA.

**5 — Schedule a follow-up**

> "Can someone call me back tomorrow afternoon?"

Expect a specific date and time read back.

**6 — Check the dashboard**

The new claim appears under **Claims**, the call under **Call History** with the full transcript and every tool invocation, and **Analytics** updates.

### Resetting between walkthroughs

Claims filed during a demo are real records and accumulate. To return the three demo policies to a clean slate:

```sql
DELETE FROM claims WHERE policy_id IN (
  SELECT id FROM policies WHERE policy_number IN (
    'POL-2026-100001', 'POL-2026-100002', 'POL-2026-100003'
  )
);
```

This never touches the seeded book of business.

**Meera Joshi** (`POL-2025-000333`) is also a low-history option if you want a fourth.

## Testing the edges

These are the cases worth trying if you want to see whether the agent actually reasons over real data.

**Refuses an inactive policy**

> "I want to file a claim on POL-2022-000111."

That policy is **expired**. The agent must decline and must not invent a claim number. `POL-2024-000222` is **cancelled** and behaves the same way.

**Admits when something doesn't exist**

> "Can you look up policy POL-9999-999999?"

Expect "not found" and a request to re-read the number — never fabricated coverage.

**Distinguishes complete from incomplete**

`CLM-2026-000321` has every document on file, `CLM-2026-000456` does not. The two answers should read differently.

**Handles a large, sensitive claim**

> "I'm calling about my fire claim, CLM-2026-000345."

$44,800, three outstanding documents, and an **urgent open escalation** — the customer is displaced and incurring hotel costs.

**Schedules a callback in natural language**

> "Can someone call me back tomorrow afternoon on 415-555-0101?"

Times are parsed from free text, so "next Tuesday morning" and "in two hours" work too. The agent reads back a specific date and time.

## Personalised greeting

The agent greets known callers by name. Customers use the 555-01xx range reserved for fiction, so to test this from your own phone, point a record at your number:

```sql
UPDATE customers SET phone = '+15551234567' WHERE full_name = 'Arjun Mehta';
```

`GET /api/elevenlabs/conversation-init?phone_number=…` then returns that customer's name, latest policy, and recent claims.

## Testing without spending voice credits

Every tool is a plain HTTP endpoint, so the data layer can be verified for free:

```bash
B=https://safeguard-api-production-7c24.up.railway.app

curl -X POST $B/api/tools/lookup-claim \
  -H 'Content-Type: application/json' -d '{"claim_number":"CLM-2026-000456"}'

curl -X POST $B/api/tools/check-documents \
  -H 'Content-Type: application/json' -d '{"claim_number":"CLM-2026-000456"}'

curl -X POST $B/api/tools/check-policy \
  -H 'Content-Type: application/json' -d '{"policy_number":"POL-2024-001234"}'

# Must be refused — expired policy
curl -X POST $B/api/tools/file-claim \
  -H 'Content-Type: application/json' \
  -d '{"policy_number":"POL-2022-000111","incident_description":"test"}'
```

Voice only exercises whether the agent picks the *right* tool. The tools themselves can be checked without a single credit.

`TESTING.md` has the full scenario list and dashboard verification steps.

---

---

# Engineering log — the v2 rebuild

Commit [`5bb1d3a`](https://github.com/hedauav/Safeguard/commit/5bb1d3a) · 66 files · +13,149 / −8,277

SafeGuard began as a prototype built during a team hackathon. This section documents the rebuild that took it from a demo that *looked* like it worked to a deployed system that does — what was broken, what replaced it, and how to verify each claim.

## The core problem

Three separate mechanisms were manufacturing the appearance of success. Each is removed.

**Fabricated storage identifiers.** `filecoin-service.ts` caught every upload failure and returned a hardcoded CID:

```ts
// before — any failure produced this
return { rootCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' }
```

That CID was then attested **on-chain** as genuine claim evidence. Uploads now return a discriminated result the type system forces every caller to handle, so a claim that was never stored can no longer be recorded as stored.

**Invented claims.** The post-call webhook created a fake claim against `POL-2024-001234` whenever the agent hadn't filed one, purely so the archival pipeline always had something to run on. Removed; a call where nothing was filed now yields nothing.

**An unauthenticated demo endpoint.** `GET /api/tools/force-demo` created real claims from a browser address bar. Removed.

**A fabricated type definition.** `src/types/filoz-synapse-sdk.d.ts` hand-declared a Synapse SDK API that does not exist (`new Synapse({rpcUrl})`, `createClient`). This is what let incorrect upload code typecheck cleanly. Deleted, so the real SDK types apply.

## The ElevenLabs integration never worked

Verified against ElevenLabs' documentation and a real call transcript. Five independent faults, any one of which breaks the integration:

| Fault | Consequence |
| --- | --- |
| Payload read from the envelope root, not `data` | Every field was `undefined` on every real webhook |
| `call_successful` treated as boolean | It's the string `"success"` — so failed calls were recorded as resolved |
| Duration read from `duration_seconds` | Real field is `metadata.call_duration_secs`; duration was always 0 |
| Tool calls paired within a single turn | Calls and results arrive on *different* turns, so each call split into two orphan rows |
| Signature HMAC'd over the body alone | Must be `${timestamp}.${body}` — verification could never have passed |

Rewritten in `src/services/elevenlabs-webhook.ts` with a replay window and constant-time comparison, covered by 28 tests.

Two of these were caught by inspecting an actual call recording rather than by reading code — including that speech-to-text drops the dashes, so `"CLM-2026-000456"` arrives as `CLM2026000456` and the lookup missed. `src/services/reference-number.ts` normalises spoken reference numbers.

## Built

**Evidence pipeline** — `src/services/evidence-pipeline.ts` replaces three near-duplicate copies. The keccak256 evidence hash is recorded unconditionally, so tamper-evidence survives a storage outage; Filecoin and on-chain attestation degrade independently and record what actually happened.

**Editable agent configuration** — `src/routes/agent-config.ts`, `src/services/agent-settings.ts`, `src/services/elevenlabs-admin.ts`. The backend is the single source of truth for the prompt and tool contracts; the dashboard edits them and pushes to ElevenLabs. Writes are guarded by an admin token that fails closed, with validation preventing states that would silently break the agent (empty prompt, unknown tool, all tools disabled).

**Simulation mode** — demos run without funded testnet wallets. Everything it produces is marked `simulated` and rendered without explorer links, so placeholder data cannot be mistaken for real archival.

**Test dataset** — generated by `database/build-test-dataset.mjs`. Evidence hashes are computed with the backend's own hashing function and CIDs are real CIDv1 content addresses of the actual bundle bytes (encoder verified against the canonical `hello world` vector), so integrity verification genuinely verifies rather than always reporting a match. Covers every claim status, inactive policies, a customer with no history, and three policies held clean for lifecycle walkthroughs.

**Tooling** — `check:setup` verifies connectivity, schema, dataset, and evidence integrity in one command. `deploy:registry` compiles and deploys the contract with solc, no Foundry required. `setup:elevenlabs` creates the agent and all 8 tools from the live backend definition.

## Contract

`verifyClaim()` was callable by **anyone**, which defeats the purpose of an attestation. Now owner-gated, with custom errors, an existence check, and 16 Foundry tests. The ABI is generated from source at deploy time so it cannot drift from what's deployed.

## Correctness fixes found along the way

- `run-all.sql` omitted migrations 0002–0004, so a fresh database was missing every column the evidence pipeline writes to
- The same file was documented as idempotent but had no conflict guards — a second run failed on primary-key violations
- A database outage was reported to callers as "your policy doesn't exist"
- The Agent Config page advertised tools the backend didn't serve
- Row-level security silently returned empty sets to the dashboard, rendering as "no data" rather than an error

## Deployed

Backend on Railway, frontend on Vercel, database on Supabase, agent on ElevenLabs with 8 webhook tools and a signed post-call webhook. Verified end-to-end: a spoken claim lookup returns live database records, and the resulting call appears in the dashboard with its transcript and tool executions.

## Verifying any of this

```bash
cd backend && npm test          # 28 tests
npm run check:setup             # schema, dataset, evidence integrity
git show 5bb1d3a --stat         # the full diff
```

Every fabricated-data claim above is checkable: `git show 5bb1d3a -- backend/src/services/filecoin-service.ts` shows the hardcoded CID being removed.

---

## Architecture

```text
Customer
   │
   ▼  voice (browser or phone)
ElevenLabs Agent  ──────────────┐
   │                            │  post-call webhook (HMAC signed)
   │  tool calls during the call│
   ▼                            ▼
Fastify Backend ──────────► Supabase / PostgreSQL
   │                            ▲
   │  evidence pipeline         │
   ▼                            │
Filecoin + Base Sepolia         │
                                │
                     React Dashboard
```

The conversational layer and the business logic are deliberately separate. The agent decides *what* the customer needs; the backend decides *what is true*.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `lookup_claim` | Retrieve a claim by number |
| `check_policy` | Retrieve policy coverage and status |
| `check_documents` | Identify outstanding documents |
| `file_claim` | Create a new claim against an active policy |
| `attach_document` | Attach a document and archive it as evidence |
| `escalate_to_human` | Create a supervisor escalation with an SLA |
| `schedule_callback` | Schedule a callback from natural-language time |
| `escalate_to_regulator` | Record a regulatory complaint, attested when configured |

The backend serves the canonical definition at `/api/agent-config`, so the agent can never be configured with a capability the API doesn't expose.

## Evidence integrity

Every filed claim is canonicalised and hashed with keccak256. The hash is recorded regardless of whether decentralized storage is reachable, so tamper-evidence survives an outage. **Verify Integrity** on a claim recomputes the hash from the stored bundle and compares.

Filecoin archival and on-chain attestation are optional. When their credentials are absent the features report themselves disabled at `/health` — nothing is simulated silently, and a claim that was never stored is never recorded as stored.

## Dashboard

Claims · Claim detail · Call history · Live call · Analytics · Blockchain · Agent configuration

The Agent Config page is editable: change the system prompt, greeting, or which tools are enabled, then push it to the live ElevenLabs agent. Writes require an admin token.

## Technology

| Layer | Technology |
| --- | --- |
| Frontend | React, TypeScript, Tailwind CSS, Vite |
| Backend | Node.js, TypeScript, Fastify |
| Database | PostgreSQL via Supabase |
| Voice AI | ElevenLabs Agents |
| Telephony | Twilio (optional) |
| Storage | Filecoin via Synapse (optional) |
| Chain | Base Sepolia, EAS (optional) |
| Hosting | Vercel (frontend), Railway (backend) |

## Repository

```text
SafeGuard/
├── backend/      Fastify API, agent tools, evidence pipeline, migrations
├── frontend/     React dashboard
├── contracts/    ClaimRegistry (Solidity, Foundry tests)
├── landing/      Static marketing page
├── DEPLOYMENT.md Setup and deployment guide
└── TESTING.md    Test dataset and scenarios
```

## Running locally

```bash
# Database: run backend/database/run-all.sql in the Supabase SQL editor

cd backend  && cp .env.example .env && npm install && npm run check:setup && npm run dev
cd frontend && cp .env.example .env && npm install && npm run dev
```

`npm run check:setup` verifies connectivity, every table, the dataset, and that seeded evidence hashes still verify. `npm test` runs the backend suite.

See `DEPLOYMENT.md` for the full credential checklist.

## Status

A working prototype demonstrating an end-to-end AI claims workflow.

**Not production-ready.** The API is unauthenticated — every endpoint and all claim data is publicly readable. Before real policyholder data it needs authentication, caller identity verification, narrowed CORS, and per-user row-level security. `DEPLOYMENT.md` lists the specifics.

## Third-party services

SafeGuard uses ElevenLabs, Supabase, Twilio, Railway, Vercel, Filecoin, and Base. Disclosed here for transparency.

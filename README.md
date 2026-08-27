# SafeGuard

## AI-Powered Insurance Claims Voice Assistant

SafeGuard is an AI-powered voice assistant that handles routine insurance claims support. Instead of navigating phone menus or waiting for a representative, a policyholder speaks naturally with an AI agent that can look up claims, explain coverage, identify missing documents, file new claims, schedule callbacks, and escalate to a human.

The agent never invents claim or policy facts. Every answer comes from a tool call against the live database.

**Status: working and deployed.** Call the agent in your browser, ask about a real claim, and watch the call appear in the dashboard with its transcript and every tool it invoked. The links below are live.

---

# What this is, and how to check it

A summary of the argument, with a way to verify each part rather than take it on
trust:

**A real problem.** Routine claim enquiries — status, coverage, what paperwork
is still missing — are handled today by phone menus and queues. They are high
volume, repetitive, answerable from a database, and the caller is usually having
a bad week already.

**A working product.** Deployed and callable right now from the link below. Not
a recording, not a scripted path: ask about any of the 62 claims in the dataset
and the answer is read live from Postgres.

**Meaningful use of AI.** On the phone the model handles conversation and
intent and is given no claim facts at all — every figure it speaks comes back
from a tool call, which is why it cannot invent a claim number: it never holds
one. That split is the right one for a voice line, and it is also the reason two
adversarial reviews called this project's use of AI its weakest part. Routing
intents to CRUD endpoints does not need a model.

**So the model was given work that does.** `adjudicate-claim` reads a policy, a
claim, and the text of the uploaded documents, and reports where they contradict
each other — a repair estimate for 12,000 behind a claim for 80,000. Nine
deterministic checks run first and can veto before the model is called; the
payable figure is computed in code and withheld from the prompt; a human
approves everything. It is deliberately *not* one of the tools the phone agent
can call. [What the model actually does](#what-the-model-actually-does).

**Evidence that it works.** [204 evaluation cases](EVALUATION.md) run against
the deployed system over the seeded dataset, 100% passing, covering every claim
and every policy in the book
— including seven that assert the agent *refuses* rather than guesses. And an
[ablation](EVALUATION.md#ablation-what-each-safety-layer-is-worth) showing what
breaks when each safety layer is removed, because an accuracy figure with no
comparison arm is not evidence. Cost impact is modelled rather than measured,
and is
[labelled as such](EVALUATION.md#modelled-value-arithmetic-not-measurement),
because the agent has never taken a real policyholder call.

**On execution, reliability and depth:**

- **Every action is bounded and gated.** Filing is refused on expired and
  cancelled policies, and refused without a policy number or an incident
  description. Seven evaluation cases assert both that the write failed *and*
  that no claim number came back — a refusal that still hands out an identifier
  is scored as a failure.
- **There is a full audit trail.** Every call stores its transcript and each
  tool invocation with arguments, result, success flag and latency. The **Live
  Call** page renders each invocation as it arrives; **Call History** shows the
  transcript and which tools ran; and `GET /api/calls/:id` returns the full
  per-invocation detail for any completed call.
- **One failure handled gracefully, found in a real recording.** Speech-to-text
  drops the dashes from spoken claim numbers, so `CLM-2026-000456` arrived as
  `CLM2026000456` and the lookup missed. The agent now resolves all three
  spellings; five cases cover it. It was found by pulling a real call and
  reading what the transcript actually contained.
- **Honest about limits.** The tool endpoints are token-guarded, but the read
  endpoints are not — every claim in the database is publicly readable. The
  dataset is synthetic and small, the evaluation exercises the tool layer rather
  than the language model, and tool *selection* by the model is not measured.
  Each is stated where it is relevant rather than collected out of the way.

**Origin, stated plainly.** SafeGuard began as a team hackathon
prototype that never worked end to end. I rebuilt everything between the domain
logic and the outside world. What was broken, what replaced it, and how to
verify each claim is in [Project history](#project-history) and the engineering
log — every assertion there cites a file or a commit.

---

## Live

| | |
| --- | --- |
| **SafeGuard** | https://safeguard-dashboard-cyan.vercel.app |


Click **Start a call** in the bottom-right of the dashboard to talk to the agent in your browser.

---

# What broke, and what I did about it

The most useful section in this repository, so it is near the top. Five failures
that took the system from *looking* like it worked to actually working. Each one
links to the code or the commit that proves it. The three that were bugs are now
covered by tests; the two that were deliberate fabrication mechanisms were deleted.

**Speech-to-text was silently breaking every spoken claim number.** A caller says
"C-L-M 2026 000456"; the transcript arrives as `CLM2026000456` with the dashes
gone; the lookup misses and the agent has to ask again. Nothing errored — the
lookup just returned nothing, so it read as a caller mistake.
Found by pulling a real call recording and reading what the transcript actually
contained, not by reading code.
Fixed in [`reference-number.ts`](backend/src/services/reference-number.ts), which
resolves all three spellings. Five evaluation cases and a unit-test suite cover it.

**The webhook signature check could never have passed.** It computed the HMAC over
the request body alone; ElevenLabs signs `${timestamp}.${body}`. No real webhook
was ever verified, which means no real call had ever completed through the genuine
path — the integration only appeared to work because other things were faking the
result. Rewritten in
[`elevenlabs-webhook.ts`](backend/src/services/elevenlabs-webhook.ts) with a replay
window and constant-time comparison. Its suite is 39 tests, six of them on the
signature check itself.

**Every call was being recorded as one success and one phantom failure.** Tool
calls and their results arrive on *different* transcript turns. The parser paired
them within a single turn, so each invocation split into two orphan rows, one of
them falsely marked failed. Found by reading the stored tool executions of a real
call and noticing the numbers could not be right.

**A failed upload returned a hardcoded identifier, which was then attested
on-chain as genuine claim evidence.** Any storage error produced the same fixed
CID, and the attestation layer wrote it to a public blockchain as if it were real.
Uploads now return a discriminated result the type system forces every caller to
handle, so a claim that was never stored cannot be recorded as stored.

**A fake claim was injected whenever the agent failed to file one** — committed as
[`fd53963`](https://github.com/hedauav/Safeguard/commit/fd53963), *"always inject
mock claim if AI fails so Filecoin pipeline always runs"*. Together with an
unauthenticated `force-demo` endpoint that created claims from a browser address
bar, this is why the demos looked healthy while the real path did not work. Both
removed.

**What the pattern was.** Not one of these crashed. Every one produced a
plausible-looking wrong result instead of an error: a lookup that quietly returned
nothing and read as caller error, a phantom failed row, a fixed identifier standing
in for a real one. That is worse than a crash, because a crash gets noticed and
fixed. Two of them — the hardcoded CID and the injected claim — were failure paths
deliberately written to manufacture success; both are gone, and uploads now return
a result the type system forces every caller to handle.

**How to check any of it:**

```bash
cd backend && npm test                 # 364 tests, built from real payloads
npm run evaluate                       # 204 cases over the seeded dataset
npm run ablate                         # what breaks when each safety layer is removed
git show 5bb1d3a -- backend/src/services/filecoin-service.ts   # the hardcoded CID being removed
```

Full detail, including the other faults and the correctness fixes found along the
way, is in the [engineering log](#engineering-log-the-v2-rebuild).

---

# Trying the agent

The database holds a full book of business — 32 customers, 51 policies, and 62 claims covering every claim status. The scenarios below use real records, so you can verify the agent is reading live data rather than improvising.

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

The new claim appears under **Claims**, the call under **Call History** with the full transcript and the tools it used, and **Analytics** updates. Each invocation with its arguments, result and latency is on **Live Call** while the call is running, and available afterwards from `GET /api/calls/:id`.

### Resetting between walkthroughs

Claims filed during a demo are real records and accumulate. To return the demo policies to a clean slate:

```sql
DELETE FROM claims WHERE policy_id IN (
  SELECT id FROM policies WHERE policy_number IN (
    'POL-2026-100001', 'POL-2026-100002', 'POL-2026-100003',
    'POL-2025-000333'
  )
);
```

`POL-2025-000333` is included because Meera Joshi is the dataset's
no-claim-history customer, and a claim filed against her policy during testing
breaks that. `npm run check:setup` asserts she has none, so run it after a
demo session to catch drift here.

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

The tool endpoints are token-guarded — the same shared secret the ElevenLabs
agent sends on every call — so each request needs an `x-tools-token` header.
Without it the deployment answers `401`.

```bash
B=https://safeguard-api-production-7c24.up.railway.app
TOKEN=$TOOLS_API_TOKEN     # the value configured on the deployment

curl -X POST $B/api/tools/lookup-claim \
  -H "x-tools-token: $TOKEN" \
  -H 'Content-Type: application/json' -d '{"claim_number":"CLM-2026-000456"}'

curl -X POST $B/api/tools/check-documents \
  -H "x-tools-token: $TOKEN" \
  -H 'Content-Type: application/json' -d '{"claim_number":"CLM-2026-000456"}'

curl -X POST $B/api/tools/check-policy \
  -H "x-tools-token: $TOKEN" \
  -H 'Content-Type: application/json' -d '{"policy_number":"POL-2024-001234"}'

# Must be refused — expired policy
curl -X POST $B/api/tools/file-claim \
  -H "x-tools-token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"policy_number":"POL-2022-000111","incident_description":"test"}'
```

The read endpoints need no token: `curl $B/api/claims` answers `200` to anyone.

Voice only exercises whether the agent picks the *right* tool. The tools themselves can be checked without a single credit.

`TESTING.md` has the full scenario list and dashboard verification steps.

---

---

# Project history

SafeGuard was built in two phases.

## v1 — the prototype

Built during a team hackathon by six contributors — `git shortlog -sne` lists Aniruddha (34 commits), me (42 across two identities), Tanmay (15), and three others with one to seven each. It defined the product and produced a substantial amount of code — a Fastify backend, a seven-table schema with seeded data, tool endpoints, a React dashboard, and a claim registry contract.

**It never worked as a system.** The pieces existed; nothing was connected end to end.

- **The deployed dashboard called `localhost`.** `frontend/src/lib/api.ts` resolved its base URL from `VITE_API_URL`, which was committed as `http://localhost:3005`, and no deployed backend URL appeared anywhere in the frontend. Vite inlines that value at build time, so every API request from the hosted dashboard went nowhere.
- **Supabase fell back to a placeholder.** `supabase.ts` defaulted to `https://placeholder.supabase.co` when configuration was missing, and did so silently — the pages querying it directly rendered as empty rather than failing, which hid the problem.
- **The voice integration could not process a real payload.** Five independent faults in the ElevenLabs webhook handler, including a signature check that could never pass. No call was ever recorded through the genuine path.
- **The demo ran on injected data.** A `force-demo` endpoint created claims from a browser address bar, and the webhook auto-injected a mock claim whenever the agent failed to file one ([`fd53963`](https://github.com/hedauav/Safeguard/commit/fd53963) — *"always inject mock claim if AI fails so Filecoin pipeline always runs"*). Those mechanisms existed because the real path did not work.
- **Storage failure produced a fabricated identifier.** Any Filecoin upload error returned a hardcoded CID, which was then attested to a public blockchain as genuine claim evidence.

What v1 contributed was the design: `ARCHITECTURE.md`, `PRODUCT_PRD.md`, and `TECHSTACK.md` set out the layered separation between the conversational layer and the business logic, and the database schema modelled the domain properly. Both survived the rebuild intact. The implementation between that design and the outside world did not.

## v2 — the rebuild

I rebuilt everything between the domain logic and the outside world, and got it running.

This is the first version that works. Not "works in a demo" — a policyholder can call the agent in a browser, ask about a real claim, and get an answer read from the live database, and the call then appears in the dashboard with its transcript and every tool it invoked.

What I did in this phase:

- **Diagnosed it.** Traced why nothing connected, then read the ElevenLabs API contract against the implementation and found five faults in the webhook handler alone. Two more I found only by pulling a real call recording and reading what the transcript actually contained — including that speech-to-text drops the dashes from claim numbers, so every spoken claim number missed.
- **Rebuilt the integration layer.** Webhook handling, signature verification, tool-execution parsing, the evidence pipeline, agent configuration.
- **Removed the fabrication.** Every mechanism that manufactured a successful-looking result now reports what actually happened, and the type system enforces that callers handle failure.
- **Made it verifiable.** The backend suite now stands at 364 tests — the count the runner reported at `a4e6938` — alongside 46 Foundry test functions across the two registry contracts, counted in the source because Foundry is not installed here. Built from real payloads so the same faults cannot return. A one-command setup checker that validates schema, dataset, and evidence integrity.
- **Connected and deployed it.** Provisioned the database, backend, frontend, and voice agent, wired them to each other with real configuration rather than localhost defaults, and verified the whole path end to end. It is running now; the links at the top of this file are live.

The database schema and the layered architecture from v1 survive intact — the design held up under a rewrite, which is the strongest thing that can be said for it. Everything between that design and the outside world is new.

---

# Engineering log: the v2 rebuild

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

Rewritten in `src/services/elevenlabs-webhook.ts` with a replay window and constant-time comparison. Its suite is 39 tests, six of them on the signature check itself; 364 across the backend at `a4e6938`.

Two of these were caught by inspecting an actual call recording rather than by reading code — including that speech-to-text drops the dashes, so `"CLM-2026-000456"` arrives as `CLM2026000456` and the lookup missed. `src/services/reference-number.ts` normalises spoken reference numbers.

## Built

**Evidence pipeline** — `src/services/evidence-pipeline.ts` replaces three near-duplicate copies. The keccak256 evidence hash is recorded unconditionally, so tamper-evidence survives a storage outage; Filecoin and on-chain attestation degrade independently and record what actually happened.

**Editable agent configuration** — `src/routes/agent-config.ts`, `src/services/agent-settings.ts`, `src/services/elevenlabs-admin.ts`. The backend is the single source of truth for the prompt and tool contracts; the dashboard edits them and pushes to ElevenLabs. Writes are guarded by an admin token that fails closed, with validation preventing states that would silently break the agent (empty prompt, unknown tool, all tools disabled).

**Evidence and attestation layer, complete** — canonical hashing, Filecoin archival via Synapse, and on-chain attestation through a registry contract that is written, access-controlled, and covered by Foundry tests: 16 test functions for `ClaimRegistry`, 30 for `ClaimRegistryV2`. The pipeline runs on every filed claim.

**This is now running against live networks.** Two registry contracts are deployed to Base Sepolia, both owned by the agent wallet: [`ClaimRegistry`](https://sepolia.basescan.org/address/0x248522cdd800b2692c757f126b75b8c9f46d4f9d) at `0x248522cdd800b2692c757f126b75b8c9f46d4f9d` and [`ClaimRegistryV2`](https://sepolia.basescan.org/address/0x40e6607d2d6a1cb30b019d448fd6fd9370194281) at `0x40e6607d2d6a1cb30b019d448fd6fd9370194281`. Neither address is hardcoded anywhere — both are read from the environment, and `resolveRegistry` prefers V2 when `CLAIM_REGISTRY_V2_ADDRESS` is set. The production deployment is on V2: `/health` reports `chain_attestation` as a status object whose most recent attempt succeeded, with the transaction hash. Without a funded wallet the same code operates against test-network data instead: evidence hashes are still real, CIDs are still real content addresses computed from the actual bundle bytes, and the records are marked `simulated` so archived and unarchived claims stay distinguishable.

**Why V2 exists.** V1 anchored a Filecoin CID, which conflated the *proof* that a bundle was not altered with the *address* at which its bytes can be fetched. Only the first is a security primitive, and gating attestation on the second meant an archival outage silently destroyed the integrity guarantee for claims that had already been hashed correctly. V2 anchors the keccak256 evidence hash, which is required and immutable, and takes the storage locator as an optional string that may be filled in once, later, by whoever anchored the record — never edited, never removed. That is what lets the deployment keep attesting while Filecoin archival is failing, which is exactly the situation `/health` currently reports.

**Test dataset** — generated by `database/build-test-dataset.mjs`. Evidence hashes are computed with the backend's own hashing function and CIDs are real CIDv1 content addresses of the actual bundle bytes (encoder verified against the canonical `hello world` vector), so integrity verification genuinely verifies rather than always reporting a match. Covers every claim status, inactive policies, a customer with no history, and three policies held clean for lifecycle walkthroughs.

**Tooling** — `check:setup` verifies connectivity, schema, dataset, and evidence integrity in one command. `deploy:registry` and `deploy:registry:v2` compile and deploy the two contracts with solc, no Foundry required. `setup:elevenlabs` creates the agent and all 13 tools from the live backend definition.

## Contract

`verifyClaim()` was callable by **anyone**, which defeats the purpose of an attestation. Now owner-gated, with custom errors, an existence check, and 16 Foundry test functions. `ClaimRegistryV2` — which anchors the evidence hash rather than the storage locator, keeps anchoring permissionless, and keeps verification owner-only — adds 30 more, 46 across the two. The ABI is generated from source at deploy time so it cannot drift from what's deployed.

Those 46 are a count of the test functions in `contracts/test/`. There is no contracts job in CI and Foundry is not part of the backend toolchain, so unlike the backend suite they are not run on every change — `forge test` in `contracts/` is the command, and it needs Foundry installed.

## Correctness fixes found along the way

- `run-all.sql` omitted migrations 0002–0004, so a fresh database was missing every column the evidence pipeline writes to
- The same file was documented as idempotent but had no conflict guards — a second run failed on primary-key violations
- A database outage was reported to callers as "your policy doesn't exist"
- The Agent Config page advertised tools the backend didn't serve
- Row-level security silently returned empty sets to the dashboard, rendering as "no data" rather than an error

## Verifying any of this

```bash
cd backend && npm test          # 364 tests
npm run check:setup             # schema, dataset, evidence integrity
git show 5bb1d3a --stat         # the full diff
```

Every fabricated-data claim above is checkable: `git show 5bb1d3a -- backend/src/services/filecoin-service.ts` shows the hardcoded CID being removed.

The result is deployed and verified end-to-end — a spoken claim lookup returns live database records, and the call appears in the dashboard with its transcript and the tools it used. See **Deployment** below.

---

---

---

---

# Measured performance

204 cases run against the deployed system over the seeded dataset, on 2026-08-27
against commit `020462f`. Reproduce with `cd backend && npm run evaluate`. The
total is a property of the database rather than a constant — it is 27 hand-written
cases plus two per claim and one per policy — so a re-run against a database that
has gained a claim will report more. [EVALUATION.md](EVALUATION.md) explains why,
and records the one time this table was left behind by a run.

| Group | Cases | Accuracy | p50 | p95 |
| --- | ---: | ---: | ---: | ---: |
| Retrieval — returns the correct record | 8 | **100%** | 549 ms | 1366 ms |
| Refusal — declines what it should | 7 | **100%** | 484 ms | 920 ms |
| Normalisation — survives speech-to-text | 5 | **100%** | 1031 ms | 1080 ms |
| Actions — filing, callbacks, escalation | 5 | **100%** | 955 ms | 1159 ms |
| Personalisation — recognises a caller | 2 | **100%** | 517 ms | 936 ms |
| Coverage — every record reports itself faithfully | 177 | **100%** | 503 ms | 616 ms |
| **Overall** | **204** | **100%** | **505 ms** | **851 ms** |

**Coverage is generated, not hand-written.** It reads all 63 claims and all 51
policies from the database and asserts the tool layer reports each one back
unchanged, so the whole book is exercised rather than a chosen sample. That is
63 claims rather than the 62 the seed defines: one more was filed through the
live agent during a real call and deliberately kept. It is
counted separately from the literal-value cases because it is not independent of
them — a bug corrupting database and API identically would pass Coverage and
fail Retrieval.

**And 100% on its own is not a result.** `npm run ablate` removes one safety
layer at a time and reruns the cases that depend on it:

| Layer removed | Cases | Still pass | Broken |
| --- | ---: | ---: | ---: |
| Reference-number normalisation | 4 | 0 | **4** |
| Refusal gates on filing | 2 | 0 | **2** |

Without normalisation, every claim number a caller speaks aloud fails to
resolve. Without the refusal gates, the agent files claims against expired and
cancelled policies. Controls hold in every arm, so the ablation is removing what
it says it removes. Full method in [EVALUATION.md](EVALUATION.md#ablation-what-each-safety-layer-is-worth).

**Refusal is the group that matters most.** An agent that invents a claim number
for an expired policy has actively misinformed a policyholder, which is worse
than failing to answer. Those seven cases assert both that the operation was
refused *and* that no identifier came back.

**What this does not cover:** tool *selection* by the language model. The harness
measures the tool layer — given an intent, does the right tool return the right
data. Measuring whether the agent picks the correct tool from a spoken sentence
requires live calls through ElevenLabs, which consumes voice credits and cannot
be looped. Selection has been verified manually, and that is labelled as anecdote
rather than measurement.

**Nor does it cover adjudication.** These 204 cases do not touch
`adjudicate-claim`. What is known about it — including a measured negative
result about `temperature: 0` — is in
[EVALUATION.md](EVALUATION.md#ai-claim-adjudication) and in the next section.

Full methodology, per-case detail, and limitations: **[EVALUATION.md](EVALUATION.md)**.

---

# What the model actually does

For most of this project the language model did one job: turn a spoken sentence
into a tool call. It looked up a claim, it read a status back, it filed a row.
Two adversarial reviews landed on the same criticism, and both were right —
swap the model for a keyword matcher and the product still works. Nothing the
model did required a model.

`POST /api/tools/adjudicate-claim` is the answer to that. It reads a policy, a
claim, and the text of the documents the claimant uploaded, and reports where
they contradict each other: a repair estimate totalling 12,000 sitting behind a
claim for 80,000, a police report dated three weeks away from the incident, a
document describing a different vehicle. That is what an adjuster looks for and
what a keyword matcher cannot find.

It produces a **recommendation**. It never produces a decision.

Code: [`adjudication-service.ts`](backend/src/services/adjudication-service.ts),
[`adjudication-rules.ts`](backend/src/services/adjudication-rules.ts),
[`llm-provider.ts`](backend/src/services/llm-provider.ts), migration
[`0017_adjudications.sql`](backend/database/0017_adjudications.sql). 65 of the
backend's 364 tests cover it.

## Nine deterministic checks run first, and any of them can veto

`runDeterministicChecks` is pure, synchronous, and reads nothing it was not
handed. It runs before the model, in this order:

| Check | Fails to |
| --- | --- |
| `policy_on_file` | escalate |
| `policy_not_cancelled` | deny |
| `policy_in_force_on_incident_date` | deny (escalate if the dates cannot be compared) |
| `claim_type_covered` | deny (escalate if no schedule exists for that policy type) |
| `claimed_amount_stated` | escalate |
| `claimed_amount_within_coverage` | escalate |
| `claim_not_already_decided` | escalate |
| `no_near_duplicate_claim` | escalate |
| `something_payable` | deny |

`deny` is reserved for matters of record — the policy term did not cover the
date, the deductible exceeds the claim. Everything ambiguous escalates, because
an automated denial on a guess costs a claimant more than an automated
escalation costs us.

**A veto returns before the model is called at all.** A claim on a policy that
had lapsed on the incident date is refused by date comparison, not by a model
behaving well that afternoon. That short-circuit is enforced twice: in the
service, and by a database constraint —
`adjudications_veto_precludes_model` rejects any row that claims both a veto
and a model invocation.

Every check that ran is stored, passes included, not just the failures. "These
seven checks passed" is itself the evidence that the model was only asked what
it was entitled to answer.

## The model never decides money

`payable_amount` is assigned exactly once, from the rules layer, which computes
it as `max(0, min(claimed, coverage) − deductible)` by delegating to
`settlement-service.computeSettlement` — the same function the settlement path
uses. The figure a recommendation carries is therefore, by construction, what
settlement would actually disburse. Two implementations of one rule is how they
drift apart.

The model is asked for an amount as well, and it is stored in a different
column, `model_proposed_amount`. It is never substituted for ours. If the two
disagree by more than a paisa the verdict is **forced to `escalate`** whatever
the model said, and `amount_agreement` records `disagreed`.

**The computed figure is deliberately withheld from the prompt.** Shown our
arithmetic, the model would echo it, and the disagreement check — the thing
that catches a model that has misread the claim — would be comparing our number
against our own number and always agreeing. A test asserts the computed payable
never appears in the prompt text.

So the model is asked for a number precisely so that the number can be thrown
away. A model whose arithmetic differs from ours has misread something, and
that is worth a human's attention rather than a silent correction.

## A human approves everything

The service's only write is the `adjudications` audit row. Nothing in it touches
`claims.status`, `claims.approved_amount`, or the payout path. The response
carries `requires_human_approval: true`, which is not a field any caller can
set.

If the audit row cannot be written, the verdict is downgraded to `escalate` and
the response says so. An `approve` nobody can reconstruct is not a
recommendation.

## Everything that goes wrong escalates

There is no path that reaches a verdict favourable to paying a claim without
having actually reached it:

- Model times out → `escalate`, with the timeout recorded.
- Model unreachable, wrong model id, bad key → `escalate`, with the provider's
  reason recorded.
- Response is not JSON, is a JSON array, or carries a verdict outside
  `approve|deny|escalate` → `escalate`, with the parse failure recorded
  verbatim. An unrecognised verdict is a parse failure, not a value to coerce.
- No `GROQ_API_KEY` configured → `FakeLlmProvider` answers, and its only answer
  is an escalation with zero confidence saying no model read anything. The row
  is flagged `simulated: true` so an unconfigured deployment cannot read back as
  a working one.
- Audit row not written → `escalate`.

The database agrees: `adjudications_parse_failure_escalates` refuses any row
that records a parse error against a verdict other than `escalate`.

## It is deliberately not a voice tool

`adjudicate_claim` is **not** registered in
[`agent-definition.ts`](backend/src/config/agent-definition.ts) and is not one
of the tools the phone agent can call. That is a choice, not an omission.

The agent's prompt already forbids promising a claim outcome. A caller hearing
"your claim looks deniable" — from an automated system, before any adjuster has
read a word — is precisely the harm that instruction exists to prevent. The
endpoint is back-office: an adjuster's queue calls it, and an adjuster reads the
result.

It sits on the on-chain rate-limit tier (15 requests a minute) rather than the
tool tier (120). Nothing here touches a chain, but every call that gets past the
deterministic rules spends metered tokens against a third-party API, and that is
the property the tighter ceiling bounds.

It takes a claim number and nothing else. There is deliberately no parameter for
an amount, a verdict, or a model instruction — anything a caller could name is
something a caller could be talked into naming.

## The documents are untrusted input, and are treated as such

Document text reaches the prompt inside a `<document>` fence. The system prompt
states that everything inside that fence is content and never instruction, and
that anything reading as a direction to the model should be reported as an
inconsistency rather than followed. `sanitiseDocumentText` strips `<document>`
and `</document>` from the claimant's text and replaces each with a visible
`[removed-tag]` marker, so an attempt to close the fence early and issue fresh
instructions is both defused and left legible to the reviewer. Text is capped at
4,000 characters per document in the prompt, and at 20,000 characters at upload.

## Why the text is recorded at upload, not extracted at adjudication time

`claim_documents` has held a keccak256 of the bytes since migration 0013. That
is the right thing for tamper-evidence and useless for adjudication: a hash
cannot tell you the estimate says 12,000. Migration 0017 adds `extracted_text`
and `text_source` beside it, populated at upload.

Extraction at adjudication time was rejected for three reasons, in order of how
much they cost to get wrong:

1. **The bytes may not exist later.** `storage_status` can be `unarchived` — a
   file that was hashed and then not kept anywhere. Adjudication-time
   extraction would be impossible for exactly those documents, and a feature
   that silently skips them is worse than one that admits it has no text.
2. **Text recorded beside the hash is checkable.** A reviewer can ask whether
   this text belongs to the file that was attested. Text extracted later, from
   a copy, cannot answer that.
3. **The upload path must never lose the hash.** Running OCR or PDF parsing
   inside it would add a dependency and a failure mode to the one path that
   cannot afford either.

A document with no text on file is stated plainly in the prompt as not
cross-checked. It is never silently omitted — a document missing from the prompt
is a document the model will assume corroborates the claim.

`text_source` says where the text came from, and is load-bearing: `claimant` is
adversarial input. A database constraint refuses text with no stated source.

## The audit row is the feature

Every recommendation writes one row to `adjudications` holding enough to
reconstruct it: every check with its outcome and its one-line explanation, the
rule that vetoed, the exact system and user prompts, the raw response bytes, the
model id the provider says answered, the latency, the parse error if there was
one, and the two amounts kept apart. The table has row-level security enabled
and no policy at all — `prompt_user` contains the incident description and the
full text of the claimant's documents, and insert rights on it would let anyone
fabricate an audit trail.

## What is measured, and what is not

The model catches the case it was built for: given a 50,000 policy limit, an
80,000 claim, and an uploaded repair estimate totalling 12,000, it returned
`escalate` and flagged both problems, including one nobody had planted. And
`temperature: 0` was measured over repeated runs and does **not** produce stable
verdicts on ambiguous cases — the model's own confidence was inversely useful on
the one case where it mattered. Both are written up, with the numbers, in
[EVALUATION.md](EVALUATION.md#ai-claim-adjudication).

The four-arm ablation has now been run to completion on the 100-case dev split,
and it is a negative result. Deterministic rules alone score **71/100**. Rules
plus the model — the shipping configuration — score **50**. The model alone
scores **33**, and a random control matched to its verdict distribution scores
**23**. Adding a model cost 21 cases.

The per-claim-type breakdown is the part worth reading, because it says the two
layers are complementary rather than redundant: on the judgement categories —
evidence that contradicts the claim, a repair estimate that does not match, a
police report dated wrong — the rules score **0 of 17** and the model **17 of
17**. On policy state and arithmetic the model scores **0 of 18** and the rules
**18 of 18**. Where the 21 cases go is equally specific: arm C answers **0 of
16** straightforward approvals that arm A gets right, because this model
escalates 91 of 100 claims where the truth is 28.

**That run used `mistral-large-latest`; production runs `openai/gpt-oss-120b`.**
So it is a measured result about that model, not yet about the model SafeGuard
ships — a distinction EVALUATION.md makes before it quotes a single number, and
one no figure above should be read past. The 50-case holdout remains sealed by
`holdout.lock.json` and has never been run.

Method, money columns, the full per-category table, and what the result does and
does not settle are in
[EVALUATION.md](EVALUATION.md#3-the-four-arm-ablation-and-it-is-a-negative-result).

**The four-arm structure is not mine.** It follows
[`shivaanshh/razorpay_KHATA`](https://github.com/shivaanshh/razorpay_KHATA) —
the four arms, the discipline of calling the model once and sharing that answer
between arms so the comparison isolates one variable, and the sealed holdout
with a lock file. What was taken and what was deliberately not is set out in
[Prior work](EVALUATION.md#prior-work).

---

# Money movement

Money moves in three directions on the agent's own path, and a fourth sits
behind the review queue. **Only the claim payout is simulated**, and the
difference is not cosmetic, so it is stated here rather than buried.

| Direction | What it does | Provider |
| --- | --- | --- |
| **In** — policy renewal | Issues a payment link for the premium owed on a lapsed policy | **Real Razorpay**, test mode |
| **In** — deductible collection | Issues a payment link for the excess owed on an open claim | **Real Razorpay**, test mode |
| **Out** — deductible refund | Returns a captured excess when another party is found at fault | **Real Razorpay**, test mode |
| **Out** — claim settlement | Pays an approved claim | **Simulated** |

**Money has moved, both directions, verified on Razorpay's ledger rather than
this system's.** On 2026-08-25, ₹2,000 was collected against claim
`CLM-2026-000112` and refunded nineteen minutes later:

```
GET /v1/refunds/rfnd_TU2yKRNmSRP3Ws
  amount: 2000.00 INR | status: processed | payment: pay_TU2uxWmTBwRHoU
GET /v1/payments/pay_TU2uxWmTBwRHoU
  amount: 2000.00 | status: refunded | amount_refunded: 2000.00
```

The chain ran adjudicate → human decision → settle → refund, and **four of its
five steps went through the product**. The fifth did not: the refund waits on a
fault determination, and `fault_determination` is written by no code path in
this repository. The refund logic is real and has now proven it against a real
provider; nothing in production can currently trigger it. Settlement payouts
also remain simulated — money comes in for real, the payout leg does not.

Full transaction record, including a control case that was paid before the
webhook existed and therefore never recorded, in
[Money: collected and refunded, end to end](EVALUATION.md#money-collected-and-refunded-end-to-end).

The refund is deliberately **not** a voice tool. Waiving the excess follows a
fault determination recorded during review, not a caller's request — a voice
tool that refunds on request is a voice tool that refunds to whoever asks
convincingly. `refund_deductible` therefore has an endpoint and no entry in
`agent-definition.ts`. A deductible refund is also not a stand-in for the
settlement, and is never described as one: returning a policyholder's excess
and paying out their claim are two separate movements of money.

One deployment caveat, since this section exists to state them: `/health` on
production currently reports `razorpay_webhook_signature: fail-closed`, meaning
`RAZORPAY_WEBHOOK_SECRET` is unset and the webhook rejects deliveries rather
than trusting them. Captures therefore are not being recorded on the live
deployment until that secret is set.

## Why the payout is simulated, specifically

Razorpay's payout API belongs to **RazorpayX**, which requires a registered
business, a current account, and completed KYC. Standard Razorpay test
credentials return `HTTP 400` on `POST /v1/payouts` — verified directly, not
assumed. Payment Links, which the renewal and deductible paths use, work on the same
credentials.

So the settlement service is complete, tested, and gated, and its provider is a
`SimulatedPayoutProvider` that says so in every result it returns. Swapping in a
real provider is one implementation of one interface. **Nothing in this
repository presents a simulated payout as a real one** — that failure mode is the
whole subject of [What broke](#what-broke-and-what-i-did-about-it).

## What every path has in common

The design constraint is the same for money as it is for claim facts: **the
language model never chooses an amount.**

- `settle_claim`, `collect_deductible` and `offer_renewal` take a reference
  number and nothing else. None of them has an amount parameter, so the model
  has no way to name a figure even if it wanted to.
- Settlement is `max(0, min(claimed, coverage) - deductible)`, computed from the
  stored rows. Renewal is the policy's monthly premium multiplied by the
  configured term. The deductible is read straight off `policies.deductible`,
  and the refund is bounded by what was actually captured.
- Each derives a deterministic idempotency key by hashing the reference number,
  so a retry, a duplicate webhook, or a caller repeating themselves cannot pay
  or charge twice. Settlement is additionally backed by a partial unique index
  on `payout_id`.

## What each refuses

Settlement refuses when the claim is missing, not yet approved, already paid, on
an inactive policy, computes to zero or less, or exceeds the configurable
authorisation ceiling — in which case it asks for a human instead of paying.

Renewal refuses for policies that are active (nothing to renew), **cancelled**
(a termination is a decision, not a missed payment, so it needs a human), or
still pending underwriting.

Deductible collection refuses when the claim is not open, when the policy
carries no excess, when a live link already exists, and above a configurable
ceiling — an automated caller should not be able to demand an unbounded sum of
someone, however correct the arithmetic.

Every refusal returns a distinct machine-readable reason and no identifier — no
payout id, no payment link. A refusal that still hands back something usable is
treated as a failure, the same standard the [refusal evaluation group](EVALUATION.md)
holds the lookup paths to. 58 tests cover settlement and renewal and 64 more
cover the deductible path, one per gate.

## The lapsed-policy path is the interesting one

Filing a claim against an expired policy used to be a dead end: the agent
refused, correctly, and the call ended there. It now refuses **and** offers a
renewal link for the exact premium owed. The refusal is still the first thing
that happens — the caller is told plainly that the claim cannot be filed — but
the call ends with something actionable rather than nothing.

---

# Why blockchain

A fair question for an insurance product, and the answer is narrow and specific: **it removes the need to trust the insurer's database.**

## The problem it solves

Insurance disputes turn on what was reported and when. A claimant says the incident was described one way; the insurer's record says another. Every piece of evidence in that argument lives in a database the insurer controls and can modify. The claimant has no way to demonstrate that a record was altered after filing, and the insurer has no way to prove it wasn't.

That is not a hypothetical concern. Claim denials get appealed, regulators investigate patterns of behaviour, and "the record says X" is only as good as the record's integrity.

## What SafeGuard anchors

When a claim is filed, its details are canonicalised and hashed. That hash is written to a public ledger neither party controls.

```text
Claim filed  ──►  keccak256 of the canonical claim  ──►  Base Sepolia
                                                          (timestamped,
                                                           immutable)
```

Afterwards, anyone holding the claim record can recompute the hash and compare it against the chain. Match means the record is unchanged since filing. Mismatch means it was altered. Neither the insurer nor the claimant has to be believed.

Note what is **not** on-chain: no names, no policy numbers, no incident details, no amounts. Only a hash. The ledger proves the record hasn't changed without publishing anything about the person it concerns.

## Why Filecoin as well

The hash proves a record is unaltered, but it does not preserve the record. If the evidence bundle is deleted, there is nothing left to check the hash against.

Filecoin stores the bundle itself, content-addressed — the identifier is derived from the content, so a CID can only refer to one exact set of bytes. Retrieve it from anywhere, hash it, and you have the original evidence with its integrity self-evident.

## Why an agent needs this more than a human does

A human adjuster leaves a paper trail: notes, emails, a name attached to a decision. An AI agent filing claims autonomously leaves only database rows, written by a system the insurer operates.

Adding an independent, tamper-evident record is how automated decisions stay auditable. The `escalate_to_regulator` tool exists for exactly this reason — a formal complaint that is anchored outside the insurer's own systems cannot be quietly removed from them.

## Why a test network

Base Sepolia rather than mainnet, because the mechanism is identical and the transactions cost nothing. Anchoring a hash needs a public, append-only ledger with timestamps — it does not need mainnet economics. A production deployment would move to a low-cost L2; nothing about the design changes.

---

# Deployment

Live at the URLs at the top of this file. Four services, each independently replaceable.

```text
        Vercel                 Railway                Supabase
    ┌────────────┐         ┌────────────┐         ┌────────────┐
    │  React     │ ──────► │  Fastify   │ ──────► │ PostgreSQL │
    │  dashboard │  HTTPS  │  API       │         │            │
    └────────────┘         └─────┬──────┘         └────────────┘
          ▲                      │  ▲
          │                      │  │ post-call webhook (HMAC)
          │                      ▼  │
          │                ┌────────┴───┐
          └── widget ─────►│ ElevenLabs │
                           │   agent    │
                           └────────────┘
```

## How each piece is deployed

**Backend — Railway.** Multi-stage `Dockerfile` (build with dev dependencies, run with production only). `railway.json` sets `/health` as the healthcheck, so a deploy that boots but can't serve is caught rather than marked live. `railway up` builds and ships.

**Frontend — Vercel.** Vite build, SPA rewrites in `vercel.json` so client-side routes resolve on refresh. Environment variables are inlined at **build** time, so changing one requires a redeploy — not just a restart.

**Database — Supabase.** Schema and dataset apply from a single idempotent file, `backend/database/run-all.sql`, regenerated from the individual migrations by `database/build-run-all.sh`.

**Agent — ElevenLabs.** Created and configured entirely through the API by `npm run setup:elevenlabs`, which reads tool definitions from the live backend's `/api/agent-config`. The agent therefore cannot be configured with a tool the backend doesn't serve.

## Configuration

Only two variables are required. Everything else enables an optional capability and reports itself disabled at `/health` when absent — nothing is silently faked.

| Variable | Required | Enables |
| --- | --- | --- |
| `SUPABASE_URL` | ✅ | — |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | — |
| `ELEVENLABS_WEBHOOK_SECRET` | | Post-call webhook signature verification |
| `TOOLS_API_TOKEN` | | The shared secret guarding `/api/tools/*`; enforced in production, falls open in development when unset |
| `ADMIN_TOKEN` | | Editing the agent config from the dashboard, and deciding items in the review queue |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` | | Pushing config to the live agent |
| `AGENT_PRIVATE_KEY` | | Filecoin evidence archival |
| `CLAIM_REGISTRY_ADDRESS` | | On-chain attestation via `ClaimRegistry` (v1) |
| `CLAIM_REGISTRY_V2_ADDRESS` | | On-chain attestation via `ClaimRegistryV2`; preferred over v1 when both are set, and the only one that can attest while archival is down |
| `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` | | Real payment links for renewals and deductibles |
| `RAZORPAY_WEBHOOK_SECRET` | | Verifying Razorpay capture webhooks; without it the endpoint fails closed |
| `EAS_*` | | EAS attestations |
| `GROQ_API_KEY` | | A real model reading claim documents during adjudication; without it every adjudication still runs every deterministic check and escalates, marked `simulated` |
| `SIMULATE_BLOCKCHAIN` | | Demo mode; output marked `simulated` |

Frontend variables (`VITE_*`) are bundled into the client and are public by definition — the anon/publishable key belongs there, the service role key never does.

## Verifying a deployment

```bash
curl https://safeguard-api-production-7c24.up.railway.app/health
```

Returns liveness plus a truthful report of which integrations are actually
configured *and* whether their last attempt succeeded, so a deployment cannot
look healthy while every optional feature is quietly off — or while a
configured one is failing. Abridged, and this is what production says today:

```json
{
  "status": "ok",
  "mode": "live",
  "features": {
    "filecoin_uploads": {
      "configured": true,
      "last_attempt": "failed",
      "reason": "the most recent upload was recorded as failed"
    },
    "chain_attestation": {
      "configured": true,
      "last_attempt": "succeeded",
      "last_success_tx": "0xff96...12c8"
    },
    "eas_attestation": false,
    "webhook_signature_verification": true,
    "renewal_payment_links": "razorpay",
    "deductible_collection_and_refund": "razorpay",
    "claim_settlement_payouts": "simulated"
  },
  "security": {
    "tools_authentication": "enforced",
    "razorpay_webhook_signature": "fail-closed",
    "cors_allowed_origins": ["https://safeguard-dashboard-cyan.vercel.app"],
    "rate_limits_per_minute": { "global": 300, "tools": 120, "onchain": 15 }
  }
}
```

Read it as written: Filecoin archival is configured and its last attempt
failed; attestation is configured and its last attempt succeeded, which is only
possible because `ClaimRegistryV2` anchors the hash rather than the CID. EAS
attestation is off. The payout rail is simulated and says so.

From a checkout, `npm run check:setup` goes further — connectivity, every table, dataset spot-checks, and recomputing seeded evidence hashes to confirm integrity verification still works.

`DEPLOYMENT.md` has the full credential checklist and step-by-step setup.

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
| `settle_claim` | Pay out a claim an adjuster has already approved |
| `collect_deductible` | Issue a payment link for the excess owed on an open claim |
| `offer_renewal` | Issue a payment link for a lapsed policy's premium |

The backend serves the canonical definition at `/api/agent-config`, so the agent can never be configured with a capability the API doesn't expose.

Eleven tools, and thirteen routes under `/api/tools/`. The two extra routes are deliberately absent from the list above.

`POST /api/tools/adjudicate-claim` recommends whether a claim is payable, and is not registered as a voice tool: a caller hearing an automated opinion on whether their claim looks deniable is exactly what the agent's prompt forbids. It is a back-office endpoint for an adjuster's queue. See [What the model actually does](#what-the-model-actually-does).

`POST /api/tools/refund-deductible` returns a captured excess. It is not a voice tool either, because waiving the excess follows a fault determination made during review rather than a caller's request. See [Money movement](#money-movement).

## Evidence integrity

Every filed claim is canonicalised and hashed with keccak256. The hash is recorded regardless of whether decentralized storage is reachable, so tamper-evidence survives an outage. **Verify Integrity** on a claim recomputes the hash from the stored bundle and compares.

Filecoin archival and on-chain attestation are implemented and run on every filed claim. Both need a funded agent wallet to reach live networks; without one they operate against test-network data, and `/health` reports exactly which mode is active. Nothing is simulated silently, and a claim that was never stored is never recorded as stored.

The two degrade independently, and on the live deployment they currently differ: `/health` reports Filecoin's last upload as `failed` and the last attestation as `succeeded`. That is the design working rather than a contradiction — `ClaimRegistryV2` anchors the evidence hash, so the tamper-evidence survives the archival outage, and the on-chain record carries an empty storage locator that says plainly the bytes were not kept.

## Dashboard

Claims · Claim detail · Review Queue · Call History · Live Call · Analytics · Evidence · Agent Config

**Review Queue** (`/review`) is where an adjudication recommendation stops being an assertion in a code comment and becomes something you can watch happen: a reviewer reads every deterministic check with its outcome, the model's reasoning, and the two amounts kept apart, then approves or rejects — and only then does the claim move. Deciding an item requires the admin token.

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
├── backend/         Fastify API, agent tools, evidence pipeline, migrations
├── frontend/        React dashboard
├── contracts/       ClaimRegistry and ClaimRegistryV2 (Solidity, Foundry tests)
├── ARCHITECTURE.md  System design, tool flows, security posture
├── PRODUCT_PRD.md   Product requirements
├── TECHSTACK.md     Technology choices and versions
├── DEPLOYMENT.md    Setup and deployment guide
├── EVALUATION.md    Measured performance and methodology
└── TESTING.md       Test dataset and scenarios
```

## Running locally

```bash
# Database: run backend/database/run-all.sql in the Supabase SQL editor

cd backend  && cp .env.example .env && npm install && npm run check:setup && npm run dev
cd frontend && cp .env.example .env && npm install && npm run dev
```

`npm run check:setup` verifies connectivity, every table, the dataset, and that seeded evidence hashes still verify. `npm test` runs the backend suite (364 tests at `a4e6938`; its glob is `src/**`, so the 65 harness tests under `backend/eval/tests/` are not included, and neither is CI running them). `npm run evaluate` measures the deployed agent against 204 behavioural cases over the seeded dataset, and `npm run ablate` measures what each safety layer contributes.

See `DEPLOYMENT.md` for the full credential checklist.

## Status

A working prototype demonstrating an end-to-end AI claims workflow.

**Not production-ready.** The `/api/tools/*` endpoints require a shared token and the deployment enforces it, but the read endpoints do not: `GET /api/claims` answers anyone, so all claim data is publicly readable. Before real policyholder data it needs authentication on the read paths, caller identity verification, and per-user row-level security. CORS is already narrowed to the dashboard origin. `DEPLOYMENT.md` lists the specifics.

## Third-party services

SafeGuard uses ElevenLabs, Supabase, Twilio, Railway, Vercel, Filecoin, and Base. Disclosed here for transparency.

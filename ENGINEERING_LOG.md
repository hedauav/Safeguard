# Engineering log

How SafeGuard got from a prototype that did not work to a deployed system that
does. Moved out of `README.md` so that file can be an entry point rather than an
archive; nothing here has been rewritten, only relocated.

Every claim cites a file or a commit. **This file is not one of the eight that
`npm run check:numbers` scans** — that checker reads `ARCHITECTURE.md`,
`DEPLOYMENT.md`, `EVALUATION.md`, `README.md`, `SUBMISSION.md`, `TECHSTACK.md`
and `TESTING.md`. Figures here are therefore hand-maintained, and the ones
pinned to a commit are deliberately frozen: they record what was true at that
point and must not be updated to track the present.

---

## What broke, and what I did about it

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
cd backend && npm test                 # 704 tests today, built from real payloads
npm run evaluate                       # 179 integrity checks + 27 written cases
npm run ablate                         # what breaks when each safety layer is removed
git show 5bb1d3a -- backend/src/services/filecoin-service.ts   # the hardcoded CID being removed
```

Full detail, including the other faults and the correctness fixes found along the
way, is in [The v2 rebuild](#the-v2-rebuild) below.

---


## Project history

SafeGuard was built in two phases.

### v1 — the prototype

Built during a team hackathon by six contributors — `git shortlog -sne 5bb1d3a~1`, the last commit before the rebuild, lists Aniruddha (34 commits), me (22 across two identities), Tanmay (15), and three others with one to seven each, for 81 human commits and two from a Railway bot. It defined the product and produced a substantial amount of code — a Fastify backend, a seven-table schema with seeded data, tool endpoints, a React dashboard, and a claim registry contract.

**It never worked as a system.** The pieces existed; nothing was connected end to end.

- **The deployed dashboard called `localhost`.** `frontend/src/lib/api.ts` resolved its base URL from `VITE_API_URL`, which was committed as `http://localhost:3005`, and no deployed backend URL appeared anywhere in the frontend. Vite inlines that value at build time, so every API request from the hosted dashboard went nowhere.
- **Supabase fell back to a placeholder.** `supabase.ts` defaulted to `https://placeholder.supabase.co` when configuration was missing, and did so silently — the pages querying it directly rendered as empty rather than failing, which hid the problem.
- **The voice integration could not process a real payload.** Five independent faults in the ElevenLabs webhook handler, including a signature check that could never pass. No call was ever recorded through the genuine path.
- **The demo ran on injected data.** A `force-demo` endpoint created claims from a browser address bar, and the webhook auto-injected a mock claim whenever the agent failed to file one ([`fd53963`](https://github.com/hedauav/Safeguard/commit/fd53963) — *"always inject mock claim if AI fails so Filecoin pipeline always runs"*). Those mechanisms existed because the real path did not work.
- **Storage failure produced a fabricated identifier.** Any Filecoin upload error returned a hardcoded CID, which was then attested to a public blockchain as genuine claim evidence.

What v1 contributed was the design: `ARCHITECTURE.md`, `PRODUCT_PRD.md`, and `TECHSTACK.md` set out the layered separation between the conversational layer and the business logic, and the database schema modelled the domain properly. Both survived the rebuild intact. The implementation between that design and the outside world did not.

### v2 — the rebuild

I rebuilt everything between the domain logic and the outside world, and got it running.

This is the first version that works. Not "works in a demo" — a policyholder can call the agent in a browser, ask about a real claim, and get an answer read from the live database, and the call then appears in the dashboard with its transcript and every tool it invoked.

What I did in this phase:

- **Diagnosed it.** Traced why nothing connected, then read the ElevenLabs API contract against the implementation and found five faults in the webhook handler alone. Two more I found only by pulling a real call recording and reading what the transcript actually contained — including that speech-to-text drops the dashes from claim numbers, so every spoken claim number missed.
- **Rebuilt the integration layer.** Webhook handling, signature verification, tool-execution parsing, the evidence pipeline, agent configuration.
- **Removed the fabrication.** Every mechanism that manufactured a successful-looking result now reports what actually happened, and the type system enforces that callers handle failure.
- **Made it verifiable.** The backend suite stood at 620 tests at `3c624c4` — up from 606 at `8da0356` and 364 at `a4e6938`, and 704 today — alongside 46 Foundry test functions across the two registry contracts, counted in the source because Foundry is not installed here. Built from real payloads so the same faults cannot return. A one-command setup checker that validates schema, dataset, and evidence integrity.
- **Connected and deployed it.** Provisioned the database, backend, frontend, and voice agent, wired them to each other with real configuration rather than localhost defaults, and verified the whole path end to end. It is running now; the links at the top of this file are live.

The database schema and the layered architecture from v1 survive intact — the design held up under a rewrite, which is the strongest thing that can be said for it. Everything between that design and the outside world is new.

---

## The v2 rebuild

Commit [`5bb1d3a`](https://github.com/hedauav/Safeguard/commit/5bb1d3a) · 66 files · +13,149 / −8,277

SafeGuard began as a prototype built during a team hackathon. This section documents the rebuild that took it from a demo that *looked* like it worked to a deployed system that does — what was broken, what replaced it, and how to verify each claim.

### The core problem

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

### The ElevenLabs integration never worked

Verified against ElevenLabs' documentation and a real call transcript. Five independent faults, any one of which breaks the integration:

| Fault | Consequence |
| --- | --- |
| Payload read from the envelope root, not `data` | Every field was `undefined` on every real webhook |
| `call_successful` treated as boolean | It's the string `"success"` — so failed calls were recorded as resolved |
| Duration read from `duration_seconds` | Real field is `metadata.call_duration_secs`; duration was always 0 |
| Tool calls paired within a single turn | Calls and results arrive on *different* turns, so each call split into two orphan rows |
| Signature HMAC'd over the body alone | Must be `${timestamp}.${body}` — verification could never have passed |

Rewritten in `src/services/elevenlabs-webhook.ts` with a replay window and constant-time comparison. Its suite is 39 tests, six of them on the signature check itself; 620 across `backend/src`, as the runner reports them today.

Two of these were caught by inspecting an actual call recording rather than by reading code — including that speech-to-text drops the dashes, so `"CLM-2026-000456"` arrives as `CLM2026000456` and the lookup missed. `src/services/reference-number.ts` normalises spoken reference numbers.

### Built

**Evidence pipeline** — `src/services/evidence-pipeline.ts` replaces three near-duplicate copies. The keccak256 evidence hash is recorded unconditionally, so tamper-evidence survives a storage outage; Filecoin and on-chain attestation degrade independently and record what actually happened.

**Editable agent configuration** — `src/routes/agent-config.ts`, `src/services/agent-settings.ts`, `src/services/elevenlabs-admin.ts`. The backend is the single source of truth for the prompt and tool contracts; the dashboard edits them and pushes to ElevenLabs. Writes are guarded by an admin token that fails closed, with validation preventing states that would silently break the agent (empty prompt, unknown tool, all tools disabled).

**Evidence and attestation layer, complete** — canonical hashing, Filecoin archival via Synapse, and on-chain attestation through a registry contract that is written, access-controlled, and covered by Foundry tests: 16 test functions for `ClaimRegistry`, 30 for `ClaimRegistryV2`. The pipeline runs on every filed claim.

**This is now running against live networks.** Two registry contracts are deployed to Base Sepolia, both owned by the agent wallet: [`ClaimRegistry`](https://sepolia.basescan.org/address/0x248522cdd800b2692c757f126b75b8c9f46d4f9d) at `0x248522cdd800b2692c757f126b75b8c9f46d4f9d` and [`ClaimRegistryV2`](https://sepolia.basescan.org/address/0x40e6607d2d6a1cb30b019d448fd6fd9370194281) at `0x40e6607d2d6a1cb30b019d448fd6fd9370194281`. Neither address is hardcoded anywhere — both are read from the environment, and `resolveRegistry` prefers V2 when `CLAIM_REGISTRY_V2_ADDRESS` is set. The production deployment is on V2: `/health` reports `chain_attestation` as a status object whose most recent attempt succeeded, with the transaction hash. Without a funded wallet the same code operates against test-network data instead: evidence hashes are still real, CIDs are still real content addresses computed from the actual bundle bytes, and the records are marked `simulated` so archived and unarchived claims stay distinguishable.

**Why V2 exists.** V1 anchored a Filecoin CID, which conflated the *proof* that a bundle was not altered with the *address* at which its bytes can be fetched. Only the first is a security primitive, and gating attestation on the second meant an archival outage silently destroyed the integrity guarantee for claims that had already been hashed correctly. V2 anchors the keccak256 evidence hash, which is required and immutable, and takes the storage locator as an optional string that may be filled in once, later, by whoever anchored the record — never edited, never removed. That is what lets the deployment keep attesting while Filecoin archival is failing, which is exactly the situation `/health` currently reports.

**Test dataset** — generated by `database/build-test-dataset.mjs`. Evidence hashes are computed with the backend's own hashing function and CIDs are real CIDv1 content addresses of the actual bundle bytes (encoder verified against the canonical `hello world` vector), so integrity verification genuinely verifies rather than always reporting a match. Covers every claim status, inactive policies, a customer with no history, and three policies held clean for lifecycle walkthroughs.

**Tooling** — `check:setup` verifies connectivity, schema, dataset, and evidence integrity in one command. `deploy:registry` and `deploy:registry:v2` compile and deploy the two contracts with solc, no Foundry required. `setup:elevenlabs` creates the agent and all 14 tools from the live backend definition.

### Contract

`verifyClaim()` was callable by **anyone**, which defeats the purpose of an attestation. Now owner-gated, with custom errors, an existence check, and 16 Foundry test functions. `ClaimRegistryV2` — which anchors the evidence hash rather than the storage locator, keeps anchoring permissionless, and keeps verification owner-only — adds 30 more, 46 across the two. The ABI is generated from source at deploy time so it cannot drift from what's deployed.

Those 46 are a count of the test functions in `contracts/test/`. There is no contracts job in CI and Foundry is not part of the backend toolchain, so unlike the backend suite they are not run on every change — `forge test` in `contracts/` is the command, and it needs Foundry installed.

### Correctness fixes found along the way

- `run-all.sql` omitted migrations 0002–0004, so a fresh database was missing every column the evidence pipeline writes to
- The same file was documented as idempotent but had no conflict guards — a second run failed on primary-key violations
- A database outage was reported to callers as "your policy doesn't exist"
- The Agent Config page advertised tools the backend didn't serve
- Row-level security silently returned empty sets to the dashboard, rendering as "no data" rather than an error

### Verifying any of this

```bash
cd backend && npm test          # 704 tests under src/, as of 31 Aug 2026
npm run check:setup             # schema, dataset, evidence integrity
git show 5bb1d3a --stat         # the full diff
```

Every fabricated-data claim above is checkable: `git show 5bb1d3a -- backend/src/services/filecoin-service.ts` shows the hardcoded CID being removed.

The result is deployed and verified end-to-end — a spoken claim lookup returns live database records, and the call appears in the dashboard with its transcript and the tools it used. See **Deployment** below.

---

---

---

---


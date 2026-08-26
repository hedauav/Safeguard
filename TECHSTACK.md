# SafeGuard — Technology Stack

## 1. Overview

SafeGuard uses a web frontend, a Fastify backend, PostgreSQL database, conversational AI, and telephony services.

The main technologies are:

```text id="w4i5s8"
React + TypeScript
        │
        ▼
Fastify + TypeScript
        │
        ▼
Supabase / PostgreSQL
        ▲
        │
ElevenLabs Conversational AI
        ▲
        │
      Twilio
```

---

## 2. Frontend

### React

The SafeGuard dashboard is built using React.

React is responsible for the user interface and dashboard views.

The frontend includes screens for:

* Claims
* Claim details
* Live calls
* Call history
* Analytics
* The adjudication review queue, where an adjuster approves or rejects a recommendation
* Agent configuration

### TypeScript

TypeScript is used for type safety across the frontend application.

It helps define consistent types for:

* Claims
* Policies
* Calls
* Tool executions
* Escalations
* Callbacks
* API responses

### Tailwind CSS

Tailwind CSS is used to build the dashboard interface and reusable UI components.

### Vite

Vite is used as the frontend development and build tool.

---

## 3. Backend

### Node.js

The backend runs on Node.js.

Node.js provides the runtime for the Fastify application and supports the asynchronous API and webhook workflows.

### Fastify

Fastify is used as the backend web framework.

The backend handles:

* REST APIs
* AI tool webhooks
* Claim operations
* Policy lookup
* Document checking, upload, hashing, and verification
* Claim filing
* Claim adjudication, and the human decisions recorded against it
* Claim settlement, deductible collection and refund, and renewal payment links
* Human escalation
* Callback scheduling
* Call logging
* Analytics

### TypeScript

The backend is written in TypeScript.

This provides typed interfaces between API routes, services, database operations, and AI tool requests.

---

## 4. Database

### Supabase

Supabase provides the PostgreSQL database used by SafeGuard.

The database stores the application's core information, including:

* Customers
* Policies
* Claims
* Call logs
* Tool executions
* Escalations
* Scheduled callbacks
* Claim documents, evidence bundles, and Filecoin upload attempts
* Adjudications and the human decisions recorded against them
* Renewal and deductible payment links, and the Razorpay webhook ledger

`database/run-all.sql` creates all 17 tables.

Supabase also provides the infrastructure used by the application to access PostgreSQL.

### PostgreSQL

PostgreSQL is the underlying relational database.

The relational structure allows claims, policies, customers, calls, and other records to be connected through relationships and identifiers.

---

## 5. Conversational AI

### ElevenLabs Conversational AI

ElevenLabs provides the conversational voice interface.

The AI agent handles the natural-language interaction with the customer.

The agent can:

* Understand customer requests
* Ask follow-up questions
* Select available tools
* Receive tool results
* Respond naturally
* Offer human escalation

SafeGuard does not rely on the AI model to invent insurance information.

For claim and policy information, the agent uses backend tools that retrieve data from the application's database.

---

## 6. AI Tool Integration

The AI agent connects to SafeGuard's backend through tool/webhook endpoints.

The current workflows include:

```text id="o9p52v"
lookup_claim
check_policy
check_documents
file_claim
attach_document
escalate_to_human
schedule_callback
escalate_to_regulator
settle_claim
collect_deductible
offer_renewal
```

Each tool represents a specific application capability. The canonical list is
`backend/src/config/agent-definition.ts`; these eleven are what
`GET /api/agent-config` serves and what the dashboard renders.

Two further endpoints live under `/api/tools/` and are deliberately not
registered as voice tools: `adjudicate-claim`, which recommends whether a claim
is payable, and `refund-deductible`, which waives an excess already collected.
Both are back-office. Neither is anything a caller should be able to trigger by
asking.

The general flow is:

```text id="f9h31b"
Customer Request
       │
       ▼
ElevenLabs Agent
       │
       ▼
Select Tool
       │
       ▼
Fastify Endpoint
       │
       ▼
Business Logic
       │
       ▼
Supabase
       │
       ▼
Tool Result
       │
       ▼
ElevenLabs Agent
       │
       ▼
Customer Response
```

This separation keeps the AI conversation layer separate from the application's business logic.

---

## 7. Telephony

### Twilio

Twilio provides phone connectivity for the voice experience.

The phone interaction follows this general flow:

```text id="v8v1ap"
Customer Phone
      │
      ▼
Twilio
      │
      ▼
ElevenLabs Conversational AI
      │
      ▼
SafeGuard Backend
      │
      ▼
Supabase
```

Twilio handles the telephony connection while the conversational logic is handled by the AI agent.

---

## 8. Browser Voice

SafeGuard can also provide a browser-based voice interaction using the ElevenLabs React SDK.

This gives users another way to interact with the same AI workflow without requiring a traditional phone call.

```text id="w5qfqs"
Browser
   │
   ▼
ElevenLabs React SDK
   │
   ▼
AI Agent
   │
   ▼
Fastify Backend
   │
   ▼
Supabase
```

---

## 9. Deployment

### Vercel

Vercel is used for frontend deployment.

The React application is built and served through Vercel.

### Railway

Railway is used for backend deployment.

The Fastify application runs on Railway and exposes the backend endpoints required by the frontend and AI agent.

### Deployment Flow

```text id="6nj8m3"
                 ┌──────────────┐
                 │    Vercel    │
                 │   Frontend   │
                 └──────┬───────┘
                        │
                        ▼
                 ┌──────────────┐
                 │   Railway    │
                 │   Fastify    │
                 │   Backend    │
                 └──────┬───────┘
                        │
                        ▼
                 ┌──────────────┐
                 │   Supabase   │
                 │  PostgreSQL  │
                 └──────────────┘
```

---

## 10. Development Tools

The project uses standard development tooling around the main stack, including:

* Git
* GitHub
* npm
* TypeScript
* Vite
* Docker where required for backend deployment

---

## 11. Environment Configuration

External service credentials are provided through environment variables.

The application uses environment configuration for services such as:

```text id="1pkddv"
Supabase
ElevenLabs
Twilio
Backend server
Frontend URL
```

Secrets such as API keys and service credentials should never be committed to the repository.

Only `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are required. Every other variable enables an optional capability — webhook signature verification, agent configuration editing, Filecoin archival, on-chain attestation — and its absence disables that capability visibly at `/health` rather than being worked around.

---

## 12. Why This Stack

The stack was selected to keep the prototype simple and modular.

### React

Provides a flexible dashboard for claims and call management.

### Fastify

Provides a lightweight backend for APIs and AI tool webhooks.

### PostgreSQL

Provides structured storage for insurance and conversation data.

### Supabase

Provides a managed PostgreSQL environment that is convenient for a prototype.

### ElevenLabs

Provides the conversational voice interface without requiring SafeGuard to build its own complete speech pipeline.

### Twilio

Provides phone connectivity for real voice interactions.

### Vercel + Railway

Provide straightforward deployment for the frontend and backend separately.

---

## 13. Architecture Summary

| Layer             | Technology        | Responsibility                  |
| ----------------- | ----------------- | ------------------------------- |
| UI                | React             | Dashboard                       |
| Styling           | Tailwind CSS      | Interface                       |
| Build             | Vite              | Frontend development/build      |
| Language          | TypeScript        | Type safety                     |
| Backend           | Node.js + Fastify | APIs and business logic         |
| Database          | PostgreSQL        | Application data                |
| Database Platform | Supabase          | Managed database infrastructure |
| Voice AI          | ElevenLabs        | Conversational voice agent      |
| Telephony         | Twilio            | Phone connectivity (optional)   |
| Evidence storage  | Filecoin, Synapse | Claim evidence archival (optional) |
| Attestation       | Base Sepolia, EAS | On-chain claim proof (optional) |
| Contracts         | Solidity, Foundry | ClaimRegistry, ClaimRegistryV2, and their tests |
| Frontend Hosting  | Vercel            | Frontend deployment             |
| Backend Hosting   | Railway           | Backend deployment              |

---

## 14. Current Scope

This technology stack supports the current SafeGuard prototype.

The system demonstrates an end-to-end flow:

```text id="j0u1aw"
Customer
   ↓
Voice AI
   ↓
Backend Tool
   ↓
Business Logic
   ↓
PostgreSQL
   ↓
Result
   ↓
Voice Response
   ↓
Dashboard
```

The architecture can later be extended with additional insurance workflows without replacing the core application structure.

---

## 15. Evidence Storage and Attestation

Optional layer producing tamper-evident proof for filed claims. Every component is optional; absent credentials disable the feature and are reported at `/health` rather than silently substituted.

### viem

Ethereum client used for reading chain state, signing, and sending attestation transactions to Base Sepolia. Chosen over ethers for its TypeScript inference and smaller surface.

### Base Sepolia

Test network hosting both registry contracts, which record a claim's evidence anchor against a submitting address and timestamp. Test network keeps demonstration costs at zero while producing genuinely verifiable transactions. Neither address is hardcoded; both are read from the environment.

### Solidity + Foundry

Two contracts, both Solidity 0.8.20. `ClaimRegistry` anchors a Filecoin CID; `ClaimRegistryV2` anchors the keccak256 evidence hash and treats the storage locator as an optional string, so an archival outage no longer costs the on-chain guarantee. The backend prefers V2 whenever `CLAIM_REGISTRY_V2_ADDRESS` is set and falls back to V1 otherwise. Foundry tests cover access control, ownership transfer, and input validation — 16 cases for V1 and 30 for V2.

Those 46 are counted in the source — `test`-prefixed functions in `contracts/test/` — not read off a run: `forge` is not installed here, CI has no contracts job, and `forge` is not required to work on this repository. They are run by hand, by whoever has Foundry. Deployment compiles with `solc` directly, so contributors do not need Foundry installed to deploy either.

### Filecoin via Synapse

`@filoz/synapse-sdk` uploads evidence bundles to Filecoin Warm Storage, returning a PieceCID. Real uploads require a funded USDFC payment rail; without one the upload is recorded as failed rather than substituted with a placeholder.

### keccak256 hashing

Evidence bundles are canonicalised — object keys sorted recursively — before hashing, so the same claim always produces the same digest regardless of field ordering. This hash is recorded unconditionally and is what `verify-integrity` checks.

### Ethereum Attestation Service

Optional structured attestations for regulatory escalations. Requires a contract address, schema, and schema UID together.

---

## 16. Testing and Tooling

### node:test

The backend test suite runs on Node's built-in runner via `tsx`, avoiding a separate test framework. `npm test` runs 364 tests across fourteen files, all passing — the count the runner reported at `a4e6938`. Thirteen of those files are in `backend/src/services/`; the fourteenth, `src/routes/agent-config.test.ts`, covers the config write path. The weight sits on the paths where a wrong answer costs money or misstates a claim: adjudication (65), the deductible loop (64), claim documents (31), settlement (30), renewals (28). Webhook parsing and signature verification — built from real ElevenLabs and Razorpay payloads — is 60 of the total: 39 for ElevenLabs, whose transcript and tool-pairing parsing carries most of the weight, and 21 for Razorpay.

A further 65 tests live in `backend/eval/tests/` and cover the evaluation harness itself: the dataset, the scoring, the cache, and the seal. `npm test` does not run them — its glob is `src/**/*.test.ts` — and neither does CI. Run them with `npx tsx --test eval/tests/*.test.ts`.

The frontend has no tests. CI lints and builds it.

### solc

The Solidity compiler is invoked directly from `scripts/deploy-registry.mjs`, which compiles the contract, writes the resulting ABI into the backend, and deploys — keeping the interface the backend uses in lockstep with what is on chain.

### Operational scripts

| Script | Purpose |
| --- | --- |
| `npm run check:setup` | Verifies database connectivity, every table, dataset contents, and that seeded evidence hashes still verify |
| `npm run deploy:registry` | Compiles and deploys `ClaimRegistry`, regenerating the ABI |
| `npm run deploy:registry:v2` | The same for `ClaimRegistryV2` |
| `npm run setup:elevenlabs` | Creates the agent and its tools from the live backend definition |
| `database/build-run-all.sh` | Regenerates the combined setup SQL from the individual migrations |

---

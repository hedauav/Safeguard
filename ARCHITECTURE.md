# SafeGuard — System Architecture

## 1. Architecture Overview

SafeGuard connects a conversational AI voice agent with backend insurance workflows, a PostgreSQL database, and a web dashboard.

The architecture separates the conversational layer from application logic. The AI agent handles the conversation and decides when a supported action is required. The Fastify backend performs the actual business operation and communicates with the database.

```text
                         ┌──────────────────────┐
                         │       Customer       │
                         └──────────┬───────────┘
                                    │
                             Voice Conversation
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ ElevenLabs           │
                         │ Conversational AI    │
                         └──────────┬───────────┘
                                    │
                              Tool / Webhook
                                  Calls
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ Fastify Backend      │
                         │                      │
                         │ Claims               │
                         │ Policies             │
                         │ Documents            │
                         │ Settlements          │
                         │ Renewals             │
                         │ Escalations          │
                         │ Callbacks            │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ Supabase             │
                         │ PostgreSQL Database   │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ React Dashboard      │
                         │                      │
                         │ Claims               │
                         │ Call History         │
                         │ Analytics             │
                         │ Agent Configuration  │
                         └──────────────────────┘
```

---

## 2. Voice Interaction Architecture

SafeGuard supports voice interaction through the AI agent.

For phone-based conversations, the call is connected through Twilio to the ElevenLabs conversational agent.

```text
Customer Phone
      │
      ▼
    Twilio
      │
      ▼
ElevenLabs Conversational AI
      │
      │ Tool calls
      ▼
Fastify Backend
      │
      ▼
Supabase PostgreSQL
```

For browser-based interaction, the frontend can provide a voice interface using the ElevenLabs React SDK.

```text
Customer Browser
      │
      ▼
ElevenLabs React SDK
      │
      ▼
ElevenLabs Conversational AI
      │
      ▼
Fastify Backend
      │
      ▼
Supabase PostgreSQL
```

Both interaction paths use the same backend workflows.

---

## 3. Application Layers

SafeGuard is divided into four main layers.

### 3.1 Presentation Layer

The React frontend provides the claims dashboard.

It is responsible for displaying:

* Claims
* Claim details
* Call history
* Active call information
* Analytics
* Escalations
* Agent configuration

The frontend communicates with backend APIs and Supabase where appropriate.

### 3.2 Conversational AI Layer

ElevenLabs Conversational AI provides the voice interaction layer.

The agent is responsible for:

* Understanding the customer's request
* Asking for required information
* Selecting an appropriate backend tool
* Communicating tool results
* Handling conversational follow-up
* Offering human escalation when required

The agent should not invent claim or policy information.

### 3.3 Application Layer

The Fastify backend contains the application's business logic.

It handles:

* API requests
* AI tool requests
* Claim operations
* Policy lookup
* Document checks, uploads, hashing, and verification
* Claim settlement and payout recording
* Policy renewal payment links
* Escalations, including regulatory escalations
* Callback scheduling
* Call logging
* Analytics
* The authentication, rate-limiting, and CORS guards in front of all of it

### 3.4 Data Layer

Supabase provides the PostgreSQL database used by the application.

The database stores:

| Table | Holds |
| --- | --- |
| `customers` | Policyholders |
| `policies` | Policies, their coverage, deductible, premium, and status |
| `claims` | Claims, including the payout columns added by `0010_settlement.sql` |
| `claim_documents` | One row per uploaded file: its keccak256 hash and where the bytes went |
| `policy_renewals` | Payment links issued for lapsed policies |
| `escalations` | Human and regulatory escalations |
| `scheduled_callbacks` | Callbacks the agent has booked |
| `call_logs` | Completed conversations, transcripts, and summaries |
| `call_tool_executions` | The audit trail of what the agent called and what came back |
| `evidence_bundles` | Canonicalised claim bundles and their hashes |
| `filecoin_uploads` | Archival attempts, their status, and proof-of-data-possession state |
| `agent_settings` | Operator overrides on the agent definition |
| `agent_registrations` | ERC-8004 agent identity records |

---

## 4. AI Tool Architecture

The AI agent can call backend tools when it needs to retrieve information or perform an action.

```text
Customer Request
      │
      ▼
AI Agent understands intent
      │
      ▼
Select appropriate tool
      │
      ▼
Backend Tool Endpoint
      │
      ▼
Business Logic
      │
      ▼
Database
      │
      ▼
Tool Result
      │
      ▼
AI Agent
      │
      ▼
Natural Language Response
```

### Available Tools

The canonical list lives in `backend/src/config/agent-definition.ts`, which is
what `GET /api/agent-config` serves and what the dashboard renders. Ten tools are
registered:

| Tool                     | Endpoint                          | Purpose                                                     |
| ------------------------ | --------------------------------- | ----------------------------------------------------------- |
| `lookup_claim`           | `/api/tools/lookup-claim`         | Retrieve an existing claim by claim number                   |
| `check_policy`           | `/api/tools/check-policy`         | Retrieve policy information by policy number                 |
| `check_documents`        | `/api/tools/check-documents`      | Identify which required documents are missing                |
| `file_claim`             | `/api/tools/file-claim`           | Create a new claim against an active policy                  |
| `attach_document`        | `/api/tools/attach-document`      | Report what is outstanding and where to upload it            |
| `escalate_to_human`      | `/api/tools/escalate-to-human`    | Create a human escalation                                    |
| `schedule_callback`      | `/api/tools/schedule-callback`    | Schedule a customer callback                                 |
| `escalate_to_regulator`  | `/api/tools/escalate-to-regulator`| Record a formal regulatory complaint, attested when possible |
| `settle_claim`           | `/api/tools/settle-claim`         | Pay out a claim an adjuster has already approved             |
| `offer_renewal`          | `/api/tools/offer-renewal`        | Issue a payment link for a lapsed policy's premium           |

The backend remains responsible for validating requests and performing database
operations. Two of these tools move money, and neither takes an amount:
`settle_claim` takes a claim number and `offer_renewal` takes a policy number,
because a figure the model could name is a figure it could be talked into naming.

Every one of these endpoints is behind the shared-token guard described in
[section 19](#19-security-considerations).

---

## 5. Claim Lookup Flow

```text
Customer:
"Can you check my claim?"

        │
        ▼

AI Agent asks for claim number

        │
        ▼

Customer provides claim number

        │
        ▼

ElevenLabs calls lookup_claim

        │
        ▼

Fastify validates the request

        │
        ▼

Supabase retrieves claim

        │
        ▼

Backend returns claim information

        │
        ▼

AI Agent explains the result
```

The response can include information such as:

* Claim status
* Claim type
* Incident date
* Claimed amount
* Assigned adjuster
* Required documents
* Documents already received

---

## 6. Policy Lookup Flow

```text
Customer
   │
   ▼
Provides policy number
   │
   ▼
AI Agent
   │
   ▼
check_policy
   │
   ▼
Fastify Backend
   │
   ▼
Supabase
   │
   ▼
Policy information
   │
   ▼
AI Agent explains coverage
```

The backend can return supported policy information such as:

* Policy type
* Provider
* Status
* Coverage amount
* Deductible
* Premium
* Coverage details

---

## 7. Document Checking Flow

```text
Customer asks about missing documents
                │
                ▼
        AI Agent identifies claim
                │
                ▼
        check_documents tool
                │
                ▼
          Fastify Backend
                │
                ▼
             Database
                │
                ▼
      Required vs received
                │
                ▼
         Missing documents
                │
                ▼
          AI Agent response
```

This allows the customer to understand what is still required without manually checking the claim.

---

## 8. Claim Filing Flow

```text
Customer provides claim information
                │
                ▼
          AI Agent collects
          required information
                │
                ▼
             file_claim
                │
                ▼
          Fastify Backend
                │
                ▼
          Validate request
                │
                ▼
       Create claim in database
                │
                ▼
       Return claim number
                │
                ▼
          AI Agent confirms
```

The backend creates the claim record and returns the resulting claim number and status.

---

## 9. Human Escalation Flow

SafeGuard keeps a human escalation path for cases that should not be resolved automatically.

```text
Customer Request
      │
      ▼
AI Agent determines that
human assistance is required
      │
      ▼
escalate_to_human
      │
      ▼
Fastify Backend
      │
      ▼
Create escalation record
      │
      ▼
Return reference information
      │
      ▼
AI Agent informs customer
```

The escalation record can contain:

* Reason
* Priority
* Customer
* Claim
* Call
* Notes
* Status

---

## 10. Callback Scheduling Flow

```text
Customer requests callback
          │
          ▼
AI Agent collects:
phone + preferred time + reason
          │
          ▼
schedule_callback
          │
          ▼
Fastify Backend
          │
          ▼
Create callback record
          │
          ▼
Return scheduled time
          │
          ▼
AI Agent confirms
```

---

## 11. Document Attachment Flow

The agent never handles a file. `attach_document` reports what a claim is still
waiting on and where to send it; the bytes go to a separate upload endpoint that
hashes what it actually receives.

```text
Customer offers a document
            │
            ▼
      attach_document
            │
            ▼
      Fastify Backend
            │
      Resolve the claim by
      number or internal id
            │
            ▼
  Compare documents_required
  against documents_received
  and the files already held
            │
            ▼
  Missing list + upload URL
  + size and type limits
            │
            ▼
      AI Agent reads it back
```

The tool response carries the claim number, `documents_required`,
`documents_missing`, the documents whose bytes have actually been received and
hashed, the upload URL (derived from the request host), the size ceiling, and the
accepted media types. If the caller names a document the claim does not ask for,
`requested_type_accepted` is `false` and the agent can correct them on the call
rather than at upload time. A `file_url` passed by an older caller is reported
back as `file_url_ignored` — a URL nobody has fetched is not evidence.

### Upload

```text
POST /api/claims/:claimNumber/documents   (multipart/form-data)
            │
            ▼
   Buffer one file part + document_type
            │
            ▼
   Gates: type named · bytes present · within 10 MB ·
   allowed media type · claim exists · the claim asks
   for this document · not already recorded
            │
            ▼
   keccak256 of the exact bytes  ──► content_hash
            │
            ▼
   Archive to Filecoin (optional)  ──► cid / no cid
            │
            ▼
   Insert into claim_documents
            │
            ▼
   Re-run the evidence pipeline so the bundle
   covers this hash
```

The hash is computed before archival is attempted, so a storage failure never
costs the fact that makes the file checkable. `storage_status` records what
genuinely happened — `stored`, `simulated`, or `unarchived` — and `cid` is null
whenever the bytes were not stored. Nothing in this path substitutes a
placeholder identifier.

Accepted media types are `image/jpeg`, `image/png`, `image/webp` and
`application/pdf`; the ceiling is 10 MB. Each refusal has its own reason and
status code: 400 for a missing type or an empty file, 413 for oversize, 415 for
an unsupported type, 404 for an unknown claim, 422 when the claim does not ask
for that document, 409 for a file already recorded against the claim, 503 when
the records are unreachable.

The upload path never writes `claims.documents_received`. That write belongs to
the evidence pipeline, which runs afterwards, so a claim cannot show a document
as received before its hash is part of the anchored bundle.

### Verification

`POST /api/claims/:claimNumber/documents/:id/verify` re-hashes a supplied file
and compares it against the stored hash. A mismatch is a successful check with a
negative answer, so both outcomes return 200. The lookup is scoped to the claim,
so a document id from elsewhere cannot be verified against a claim it does not
belong to.

### Data recorded

`claim_documents` holds one row per file received:

| Field | Meaning |
| --- | --- |
| `document_type` | One of the claim's `documents_required` entries |
| `original_filename` / `mime_type` / `size_bytes` | The claimant's metadata and the bytes actually read |
| `content_hash` | keccak256 of those bytes, `0x`-prefixed |
| `cid` | Content address of the archived copy, null when nothing was stored |
| `storage_status` | `stored`, `simulated`, or `unarchived` |
| `simulated` | True when the CID came from simulation mode |

Database constraints carry the same rules as the service: a unique index on
`(claim_id, content_hash)` so the same bytes cannot be recorded twice against one
claim, a check that `storage_status` and `cid` agree, a format check on the hash,
and a positive-size check.

---

## 12. Claim Settlement Flow

`settle_claim` pays a claim an adjuster has already approved. It takes a claim
number and nothing else — the amount is derived on the server, because the only
caller is a language model on a phone line.

```text
Customer asks about payment
            │
            ▼
        settle_claim
      (claim number only)
            │
            ▼
  1. Claim exists?
  2. Not already paid?      ── status 'paid', or a payout id present
  3. Approved by an adjuster?
  4. Policy active?
  5. Anything payable?
  6. Within the automated ceiling?
            │
            ▼
  amount = max(0, min(claimed, coverage) − deductible)
            │
            ▼
  PayoutProvider.createPayout
  (idempotency key derived from the claim number)
            │
            ▼
  Record payout id, status, reference and amount
  on the claim
            │
            ▼
  AI Agent reads back the amount and the reference
```

Each gate returns a distinct machine-readable reason — `claim_not_found`,
`already_paid`, `claim_not_approved`, `policy_not_active`, `nothing_payable`,
`above_auto_approve_limit`, `payout_failed`, `settlement_not_recorded` — and a
refusal never hands back a payout id. The already-paid check runs before the
approved check so a second attempt says the useful thing rather than the
misleading one, and it inspects `payout_id` as well as status: a claim carrying a
payment id has been paid even if the status write was lost.

The automated ceiling is 50,000 by default and configurable through
`SETTLEMENT_AUTO_APPROVE_LIMIT`. Above it the claim is refused and routed for
human authorisation rather than paid.

### Idempotency

The key is `sha256("safeguard:settlement:v1:" + claim_number)`, so a retried tool
call, a redelivered webhook and a fresh attempt tomorrow all produce the same key
and the provider sees one payout rather than three. A partial unique index on
`claims.payout_id` is the database half of the same guard.

### Failure ordering

A payout the rail reports as `failed` or `reversed` leaves the claim `approved`,
because a transfer that did not land must not be recorded as paid. If the payout
succeeds but the claim row cannot be updated, the tool refuses with
`settlement_not_recorded` and passes the caller to a human — reporting success
there would bury a reconciliation, and the idempotency key means a retry returns
the same payout rather than a second one.

### The payout rail is simulated

`PayoutProvider` is the seam a real rail would drop into, but only
`SimulatedPayoutProvider` is wired. Razorpay's payouts API belongs to RazorpayX,
which requires a registered business with a current account and completed KYC,
and the credentials this project holds are refused by that endpoint. Payment
Links, which the renewal path uses, work on those same credentials — so one
direction of money movement is real and the other is not, and the code says which
throughout: simulated payout ids are prefixed `pout_sim_`, the transfer reference
is prefixed `SIMUTR`, and `payout_simulated` is persisted on the claim so a row
can never read back as a real disbursement. The simulated provider honours the
idempotency key rather than merely accepting it, because that is the property the
settlement path depends on.

### Data recorded

`0010_settlement.sql` adds to `claims`:

| Field | Meaning |
| --- | --- |
| `payout_provider` | The rail that produced the payout |
| `payout_id` | The provider's payout id |
| `payout_status` | `queued`, `processing`, `processed`, `reversed`, or `failed` |
| `payout_amount` | The amount actually disbursed |
| `payout_utr` | Bank reference for the transfer |
| `payout_simulated` | True when no money moved |
| `paid_at` | When the payout was created |

---

## 13. Policy Renewal Flow

A claim on a lapsed policy is refused — that does not change. `offer_renewal` is
the one bounded thing the agent may do instead: issue a payment link for the
premium owed. It takes a policy number and nothing else; the amount and the term
come from the policy and from configuration.

```text
Caller acts on a lapsed policy
            │
            ▼
     Claim filing refused
            │
            ▼
       offer_renewal
     (policy number only)
            │
            ▼
  1. Policy exists?
  2. Not already active?   ── nothing to renew
  3. Not cancelled?        ── a termination needs a human
  4. Expired, not pending?
  5. Premium adds up to something?
  6. Within the ceiling for an unattended offer?
            │
            ▼
  amount = premium_monthly × term_months
            │
            ▼
  A live link already recorded for this policy?
        │                         │
        │ yes                     │ no
        ▼                         ▼
  Return that link     PaymentLinkProvider.createPaymentLink
                                  │
                                  ▼
                        Insert into policy_renewals
            │
            ▼
  AI Agent reads back the amount and the URL
```

The term is 12 months by default (`RENEWAL_TERM_MONTHS`) and the ceiling on an
unattended offer is 200,000 (`RENEWAL_MAX_LINK_AMOUNT`). Refusal reasons are
`policy_not_found`, `policy_already_active`, `policy_cancelled`,
`policy_not_renewable`, `nothing_payable`, `above_link_limit`, `link_failed` and
`renewal_not_recorded`, and a refusal never returns a payment link.

A cancelled policy is refused whatever is offered for it: a cancellation is a
decision — non-payment, fraud, or the customer's own request — and reinstating it
is not a payment.

### Idempotency

Before issuing anything, the service looks for a link already recorded against
the policy. Any status other than `expired` or `cancelled` counts as live —
`paid` included — and that link is returned again rather than a second demand for
the same premium being created. Only when every prior link is spent does the
reference id move on, because the provider rejects one it has already seen. The
reference is `sha256("safeguard:renewal:v1:" + policy_number)`, with an attempt
suffix for those later links.

If the link is created but the row cannot be written, the tool refuses with
`renewal_not_recorded` rather than reading out a link that no record could match
a payment to.

### The payment links are real

When `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are configured, renewals go
through `RazorpayPaymentLinkProvider`, which calls the live Razorpay API
(`POST https://api.razorpay.com/v1/payment_links`) over HTTP Basic auth and
returns a genuine payable short URL. SMS and email notification are disabled and
reminders are off: no verified contact details are held for the caller, so
nothing is sent on their behalf — the agent reads the URL out on the call.

With no credentials, `SimulatedPaymentLinkProvider` is used instead. Its URLs sit
under the reserved `.invalid` TLD so they can never resolve, and `simulated` is
persisted on the renewal row. `/health` reports `renewal_payment_links` as
`razorpay` or `simulated`, so which of the two a deployment is handing to callers
is visible from outside.

### Data recorded

`0012_policy_renewals.sql` creates `policy_renewals`:

| Field | Meaning |
| --- | --- |
| `policy_id` | The policy being renewed |
| `provider` | `razorpay` or `simulated` |
| `payment_link_id` / `short_url` | The provider's link and the URL read out |
| `amount_paise` | The premium, in minor units, as sent to the provider |
| `term_months` | The term the premium covers |
| `status` | `created`, `partially_paid`, `paid`, `expired`, or `cancelled` |
| `reference_id` | The deterministic per-renewal reference |
| `simulated` | True when the link leads nowhere |

Unique indexes on `reference_id` and `payment_link_id` are the database half of
the double-billing guard, and a check constraint refuses a link for zero.

---

## 14. Regulatory Escalation Flow

`escalate_to_regulator` records a formal complaint about a claim and, where EAS
is configured, attests it on-chain.

```text
Caller wants a formal complaint recorded
                │
                ▼
      escalate_to_regulator
      (claim id, reason, priority)
                │
                ▼
         Fastify Backend
                │
      Compute an evidence hash over the
      claim and the stated reason
                │
                ▼
      Create the escalation record  ◄── the customer-facing
                │                        outcome, recorded first
                ▼
      EAS attestation, when configured
                │
                ▼
      Reference number + evidence hash
      + attestation UID when there is one
```

The escalation is written before the attestation is attempted, so a chain failure
loses the attestation and not the complaint. An attestation error is logged and
the tool still returns the reference number, with `eas_uid` null.

**A known limitation:** this tool resolves the claim by internal UUID only. Every
other claim tool accepts the number a caller reads out and tries it with and
without dashes; this one does not, so a spoken claim number returns "Claim not
found". In practice the id has to come from a prior `file_claim` result or from
the dashboard.

---

## 15. Call Logging

SafeGuard records important information about AI conversations.

A completed conversation can contain:

* ElevenLabs conversation ID
* Customer
* Phone number
* Call direction
* Call status
* Duration
* Transcript
* Summary
* Outcome
* Tools used
* Timestamps

Tool execution records can additionally contain:

* Tool name
* Arguments
* Result
* Success status
* Execution latency
* Execution time

This information supports the dashboard and helps with debugging.

---

## 16. Dashboard Data Flow

```text
                     Supabase
                        │
          ┌─────────────┼─────────────┐
          │             │             │
          ▼             ▼             ▼
       Claims         Calls       Escalations
          │             │             │
          └─────────────┼─────────────┘
                        │
                        ▼
                 React Dashboard
                        │
             ┌──────────┼──────────┐
             ▼          ▼          ▼
          Claims     Call History Analytics
```

The dashboard provides visibility into both insurance workflows and AI interactions.

---

## 17. Post-Call Flow

When a conversation ends, the backend can receive a conversation-ended webhook.

```text
Conversation Ends
       │
       ▼
ElevenLabs Webhook
       │
       ▼
Fastify Backend
       │
       ├── Record call information
       │
       ├── Store transcript information
       │
       ├── Record tool usage
       │
       └── Update call status
                │
                ▼
             Supabase
                │
                ▼
        Dashboard visibility
```

---

## 18. Error Handling

The backend should handle failures without exposing technical details to customers.

Examples include:

* Claim not found
* Policy not found
* Missing required input
* Invalid input
* Tool execution failure
* Database failure
* Unsupported request

The AI agent should communicate these situations in a simple way.

For cases that cannot be resolved automatically, the system should provide a human escalation path.

---

## 19. Security Considerations

Four guards are in the code today. Each is described here as it behaves, along
with what it does not cover.

### Shared-token guard on agent-facing endpoints

Everything the voice agent calls sits behind `requireToolsToken`
(`backend/src/plugins/tools-auth.ts`), with the decision itself in
`backend/src/services/tools-token.ts` so it can be unit tested without booting
the server. It covers every route in `webhook-tools.ts` — registered as a
scope-wide `preHandler` so a tool added later inherits it rather than needing to
be remembered — plus `GET /api/elevenlabs/conversation-init` and
`POST /api/calls/:id/tool-executions`.

These are not merely reads. `file-claim` spends testnet ETH on an attestation and
pays for a Filecoin upload, `settle-claim` releases a payout, `offer-renewal`
creates a real payment link, and `conversation-init` returns a customer's name,
policy number, and claim history for any phone number handed to it. The
tool-execution endpoint writes the audit trail the dashboard presents as the
record of what the agent did.

The token arrives as `x-tools-token` — the header the ElevenLabs agent is
configured to send — or as `Authorization: Bearer`, which is what curl and the
evaluation harness reach for. Comparison is `crypto.timingSafeEqual` with a
length check first, because `timingSafeEqual` throws on mismatched lengths and a
thrown error would leak the secret's length as surely as an early return.

With no `TOOLS_API_TOKEN` configured the behaviour is deliberately asymmetric:
development falls open so `npm run dev` works out of the box, production
**fails closed** with 503 — the endpoints are disabled rather than open, so a
misconfigured production deployment cannot quietly behave like the old
unauthenticated one. `/health` reports which of `enforced`,
`development-bypass`, or `fail-closed` is in effect, and the server logs a
warning or an error at startup to match.

### Rate limiting, in three tiers

`backend/src/plugins/rate-limit.ts` registers per-IP ceilings, all per minute:

| Tier | Default | Applies to |
| --- | ---: | --- |
| Global | 300 (`RATE_LIMIT_MAX`) | Every route without its own tier |
| Tools | 120 (`RATE_LIMIT_TOOLS_MAX`) | Read-shaped tool endpoints, `conversation-init`, the tool-execution write |
| On-chain | 15 (`RATE_LIMIT_ONCHAIN_MAX`) | `file-claim`, `settle-claim`, `offer-renewal`, `escalate-to-regulator` |

The tools tier is generous on purpose: ElevenLabs calls out from shared egress
addresses, so one IP legitimately carries every concurrent conversation. The
on-chain tier is tight because those four routes spend money — a Filecoin upload
and a Base Sepolia write on filing, a payout on settlement, a payment link on
renewal, an EAS attestation on a regulatory escalation — and no phone
conversation reaches that rate.

`/health` and `/version` are allow-listed, so a burst of traffic cannot turn into
a reported outage. Rejections return 429 with a `retry-after` header and a
`statusCode` of their own, rather than the 500 Fastify would otherwise produce
for an unclassified throw. The server runs with `trustProxy: true`, so the
counter keys on the forwarded client address rather than the platform proxy's.

Per-route tiers are named explicitly on every route, because
`@fastify/rate-limit` reads `route.config.rateLimit` in its own `onRoute` hook —
a default injected by a later hook is read too late and the route silently falls
back to the global ceiling.

### CORS allowlist

`backend/src/plugins/cors.ts` allows the configured `FRONTEND_URL` origin and,
outside production only, any localhost port — Vite moves off 5173 when the port
is taken. Origins are compared as origins, not URLs, so a trailing slash cannot
cause a silent mismatch. Requests carrying no `Origin` header at all are allowed:
that is the agent's webhooks, the evaluation harness, curl, and health checks,
none of which CORS ever protected — the shared-token guard does.

This replaced `origin: true` with `credentials: true`, which is the combination
browsers treat as "this API trusts every site on the internet with the visitor's
cookies".

### Admin token on agent-config writes

`GET /api/agent-config` is open; the write endpoints are not. They require
`Authorization: Bearer $ADMIN_TOKEN`, compared timing-safely, and fail closed
with 503 when no `ADMIN_TOKEN` is set — an unauthenticated write here would let
anyone rewrite the agent's prompt or re-point its tools at a server they control.
Validation additionally rejects states that would silently disable the agent: an
empty prompt, an unknown tool name, or every tool disabled.

### Webhook signature verification

Post-call webhooks from ElevenLabs carry `ElevenLabs-Signature` in the form
`t=<unix_seconds>,v0=<hex_hmac>`, where the HMAC-SHA256 is taken over
`${timestamp}.${rawBody}` — signing the body alone never validates. The raw body
is preserved by `fastify-raw-body` for exactly this. Deliveries older than 30
minutes are refused as replays, and the digest comparison is timing-safe.

The same asymmetry applies as for the tools token: with no
`ELEVENLABS_WEBHOOK_SECRET`, development accepts the delivery unverified and
production refuses it with 503, because an accepted-unverified webhook writes the
compliance record.

### What this does not cover

* **Rate-limit counters live in process memory.** They are correct for a
  single-instance deployment. Run more than one replica and each enforces its own
  share of the limit, so the effective ceiling multiplies by the replica count.
  A shared store (Redis) would be needed for a real limit across instances.
* **The API's read endpoints are unauthenticated.** Claims, calls, analytics,
  escalations, agent identity, and `GET /api/agent-config` are readable by anyone
  with the URL, as are the document upload and verification endpoints — which are
  also the only agent-adjacent routes with no rate-limit tier of their own, so
  they fall under the global ceiling.
* **There is no caller identity verification.** The agent trusts the claim or
  policy number read out to it. Anyone who knows a claim number can hear its
  status.
* **The data is demonstration data.** Before real policyholder records this needs
  customer authentication, per-user row-level security, audit retention, and a
  compliance review. `DEPLOYMENT.md` lists the specifics.

API keys and other secrets are read from environment variables and must not be
committed to the repository. The Razorpay secret is folded into a Basic-auth
header once at construction and never logged.

---

## 20. Deployment Architecture

The current deployment model separates the frontend and backend.

```text
                  Internet
                     │
          ┌──────────┴──────────┐
          │                     │
          ▼                     ▼
       Vercel                 Railway
          │                     │
     React App              Fastify API
                                │
                                ▼
                           Supabase
                          PostgreSQL
```

The AI voice layer communicates with the backend through the configured integration and tool endpoints.

---

## 21. Technology Summary

| Layer            | Technology                        |
| ---------------- | --------------------------------- |
| Frontend         | React + TypeScript + Tailwind CSS |
| Backend          | Node.js + TypeScript + Fastify    |
| Database         | PostgreSQL + Supabase             |
| Voice AI         | ElevenLabs Agents                 |
| Telephony        | Twilio (optional)                 |
| Browser Voice    | ElevenLabs embedded widget        |
| Evidence storage | Filecoin via Synapse (optional)   |
| Attestation      | Base Sepolia, EAS (optional)      |
| Payments in      | Razorpay Payment Links (real; simulated with no credentials) |
| Payments out     | Simulated payout rail — RazorpayX not available |
| Frontend Hosting | Vercel                            |
| Backend Hosting  | Railway                           |

---

## 22. Design Principles

SafeGuard follows a few important design principles:

### AI handles conversation, backend handles business logic

The AI agent decides what the customer needs. The backend performs the actual application operation.

### Tools over hallucination

Claim and policy information should come from backend tools and the database rather than from the model's generated knowledge.

### Human escalation

Automation should have a clear path to human assistance.

### Modular workflows

Each major insurance workflow is exposed through a separate backend capability.

### Observable interactions

Calls and tool executions are recorded so the system can be monitored and debugged.

---

## 23. Current Scope

The current prototype demonstrates:

* AI voice conversations
* Claim lookup
* Policy lookup
* Missing document checking
* Claim filing
* Document upload, hashing, and byte-level verification
* Claim settlement against an approved claim, on a simulated payout rail
* Renewal payment links for lapsed policies, through the live Razorpay API
* Human escalation
* Regulatory escalation, attested on-chain when EAS is configured
* Callback scheduling
* Backend tool execution
* Database integration
* Call logging
* Claims dashboard
* Analytics
* Agent configuration, editable and pushed to the live agent
* Tamper-evident claim evidence
* Optional Filecoin archival and on-chain attestation
* Shared-token authentication, tiered rate limiting, and a CORS allowlist

The architecture is intentionally modular so additional insurance workflows can be added later.

---

## 24. Evidence and Attestation

Beyond recording claims in the database, SafeGuard produces tamper-evident proof that a claim's details have not been altered since it was filed.

```text
Claim filed, or a document uploaded
     │
     ▼
Canonicalise the claim into an evidence bundle
     │   (keys sorted, so the same claim always
     │    serialises to the same bytes; the content
     │    hash of every uploaded document is folded in,
     │    sorted by hash so row order cannot change it)
     ▼
keccak256  ──────────────► evidence_hash  (always recorded)
     │
     ▼
Upload bundle to Filecoin ──► CID          (optional)
     │
     ▼
Attest CID on Base Sepolia ─► tx hash      (optional)
```

### Independent degradation

Each stage can fail without losing the stages before it. This ordering is deliberate:

* The **evidence hash is recorded unconditionally**. It is the primitive that makes tampering detectable, and it requires no external service, so a storage outage never costs the guarantee.
* **Filecoin upload** is attempted only when an agent wallet is configured. Failure is recorded as `upload_status: 'failed'` with the reason.
* **On-chain attestation** runs only when there is a real CID to attest. Attesting a storage identifier that does not exist would put a false claim on a public ledger, so a failed upload stops the chain.

A claim that was never stored is never recorded as stored. There is no fallback identifier.

### Verification

`POST /api/claims/:id/verify-integrity` re-canonicalises the stored bundle, recomputes the hash, and compares it against the recorded value. A mismatch means the stored claim data has changed since filing.

Because each document's content hash is part of the bundle, the bundle hash
commits transitively to the files themselves: altering one byte of an uploaded
document changes its hash, which changes the bundle hash, which no longer matches
what was anchored. The per-file check in
[section 11](#11-document-attachment-flow) is the direct version of the same
question.

### Data recorded

| Field | Meaning |
| --- | --- |
| `evidence_hash` | keccak256 of the canonical bundle |
| `filecoin_cid` / `piece_cid` | Content identifier, when the upload succeeded |
| `dataset_id` | Warm Storage data set holding the piece |
| `attestation_tx_hash` | Base Sepolia transaction recording the CID |
| `eas_uid` | EAS attestation, when configured |
| `pdp_proof_status` | Proof-of-data-possession state |
| `simulated` | True when the values came from simulation rather than real infrastructure |

### On-chain registry

`ClaimRegistry` on Base Sepolia stores a claim id, the submitting address, the CID, and a timestamp. Filing is permissionless and records who filed. **Verification is restricted to the contract owner** — a claim anyone could mark verified would carry no attestation value.

---

## 25. Agent Configuration

The backend is the single source of truth for the voice agent's definition. `GET /api/agent-config` returns the system prompt, greeting, and the full tool contract, with URLs derived from the request host.

```text
agent_settings table          agent-definition.ts
   (operator overrides)          (shipped defaults)
            │                          │
            └──────────┬───────────────┘
                       ▼
              GET /api/agent-config
                       │
        ┌──────────────┴──────────────┐
        ▼                             ▼
   Dashboard                  POST /agent-config/sync
   (renders + edits)                  │
                                      ▼
                            ElevenLabs agent
                       (prompt, greeting, tool_ids)
```

Because tool URLs are generated from the live backend rather than stored, the agent cannot be configured with an endpoint the API does not serve — the failure mode that left the earlier build pointing at `localhost`.

Write endpoints require an admin token and fail closed: with no token configured they refuse rather than falling open. Validation rejects states that would silently disable the agent, including a system prompt too short to instruct anything, an unknown tool name, or disabling every tool.

---

## 26. Simulation Mode

Filecoin storage requires a funded payment rail, which is not always available for demonstrations. With `SIMULATE_BLOCKCHAIN=true` and no agent wallet, the pipeline produces a real CIDv1 content address computed from the actual bundle bytes, plus a deterministic placeholder transaction hash.

Everything it writes is marked `simulated = true`, and the dashboard renders those rows without explorer links, because the referenced data was never published and the links would not resolve.

`/health` reports these features as `"simulated"` rather than `true`. Real credentials always take precedence; simulation only applies where nothing real is configured.

---

## 27. Architecture Summary

SafeGuard is built around a simple separation of responsibilities:

```text
┌─────────────────────────────────────────────┐
│              Customer Experience            │
│       Voice conversation / Dashboard        │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│             Conversational AI               │
│          ElevenLabs Voice Agent              │
└──────────────────────┬──────────────────────┘
                       │
                  Tool Calls
                       │
                       ▼
┌─────────────────────────────────────────────┐
│              Application Logic              │
│               Fastify Backend               │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│                   Data                      │
│            Supabase / PostgreSQL            │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│                Operations                   │
│            Claims & Call Dashboard          │
└─────────────────────────────────────────────┘
```

This architecture allows SafeGuard to use conversational AI for the customer interaction while keeping business logic and data operations within the application's backend.

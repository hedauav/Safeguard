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
* The adjudication review queue, where a person approves or rejects a recommendation
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

A second model runs elsewhere and does a different job. Adjudication
([section 13](#13-ai-claim-adjudication-flow)) calls Groq server-side to read a
claim's documents against its policy. It is not part of the conversation, it is
not reachable from the voice agent, and its output is a recommendation an
adjuster reads — never something a caller hears.

### 3.3 Application Layer

The Fastify backend contains the application's business logic.

It handles:

* API requests
* AI tool requests
* Claim operations
* Policy lookup
* Document checks, uploads, hashing, and verification
* Claim adjudication: deterministic rules, the model call, and the audit record
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
| `journey_events` | The append-only history of what happened to a claim or a policy, failures included (`0021_journey_events.sql`) |
| `claim_documents` | One row per uploaded file: its keccak256 hash, where the bytes went, and any text read out of it |
| `adjudications` | One row per AI adjudication: the checks, the exact prompt, the raw response, and the two amounts kept apart |
| `adjudication_reviews` | One row per human decision on a recommendation: who decided, what they decided, and the claim status either side of it |
| `policy_renewals` | Payment links issued for lapsed policies |
| `deductible_payments` | Payment links issued for a claim's excess, the capture the webhook recorded, and any refund against it |
| `razorpay_webhook_events` | Every Razorpay delivery, recorded once under its event id so a retry cannot be applied twice |
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
what `GET /api/agent-config` serves and what the dashboard renders. Fourteen
tools are registered: twelve served by this backend, and two that run in the
caller's browser and touch no endpoint at all. The twelve with an endpoint:

| Tool                     | Endpoint                          | Purpose                                                     |
| ------------------------ | --------------------------------- | ----------------------------------------------------------- |
| `lookup_claim`           | `/api/tools/lookup-claim`         | Retrieve an existing claim by claim number                   |
| `check_policy`           | `/api/tools/check-policy`         | Retrieve policy information by policy number                 |
| `check_documents`        | `/api/tools/check-documents`      | Identify which required documents are missing                |
| `explain_claim_assessment` | `/api/tools/explain-claim-assessment` | Explain what a filed claim is worth under its policy — never whether it will be approved |
| `file_claim`             | `/api/tools/file-claim`           | Create a new claim against an active policy                  |
| `attach_document`        | `/api/tools/attach-document`      | Report what is outstanding and where to upload it            |
| `escalate_to_human`      | `/api/tools/escalate-to-human`    | Create a human escalation                                    |
| `schedule_callback`      | `/api/tools/schedule-callback`    | Schedule a customer callback                                 |
| `escalate_to_regulator`  | `/api/tools/escalate-to-regulator`| Record a formal regulatory complaint, attested when possible |
| `settle_claim`           | `/api/tools/settle-claim`         | Pay out a claim an adjuster has already approved             |
| `collect_deductible`     | `/api/tools/collect-deductible`   | Issue a payment link for the excess owed on a claim          |
| `offer_renewal`          | `/api/tools/offer-renewal`        | Issue a payment link for a lapsed policy's premium           |

The backend remains responsible for validating requests and performing database
operations. Three of these tools move money, in two directions — `offer_renewal`
and `collect_deductible` bring it in, `settle_claim` sends it out — and not one
of them takes an amount. `settle_claim` and `collect_deductible` take a claim
number, `offer_renewal` takes a policy number, and every figure is read
server-side from the policy, because a figure the model could name is a figure it
could be talked into naming.

Fourteen tools are registered — twelve webhook tools and two client tools —
against fourteen routes under `/api/tools/`. The two totals matching is a
coincidence: neither set is a subset of the other, for two separate reasons, and
both are deliberate.

`show_payment_link` and `show_upload_link` are **client** tools
(`toolType: 'client'` in `backend/src/config/agent-definition.ts`): they run in
the caller's browser and the agent hands them their arguments directly, so they
have no endpoint and no route. They exist because ElevenLabs does not ship
server-tool results to the client — `AgentToolResponse` carries no payload — so
the payment link returned by `offer_renewal` or `collect_deductible`, and the
upload address returned by `attach_document`, cannot otherwise be put on screen
while the caller is still on the line. Both work on web calls only; on a phone
call the agent reads the URL out as it always has.

And two endpoints under `/api/tools/` are deliberately **not** registered as
tools at all.
`POST /api/tools/adjudicate-claim` recommends whether a claim is payable: a
caller hearing an automated opinion that their claim looks deniable, before an
adjuster has read a word, is exactly what the agent's prompt forbids. It is a
back-office endpoint, described in
[section 13](#13-ai-claim-adjudication-flow).
`POST /api/tools/refund-deductible` waives an excess already collected. Waiving
follows a fault determination made during review, not a caller's request — a
voice tool that refunds on request is a voice tool that refunds to whoever asks
convincingly.

Every one of these endpoints is behind the shared-token guard described in
[section 20](#20-security-considerations).

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
| `extracted_text` | Text read out of the document, recorded here at upload beside the hash of the bytes it came from. Null means nothing has been read out of it |
| `text_source` | Where that text came from — `claimant`, `ocr`, `pdf_text`, or `adjuster`. `claimant` is adversarial input, and it reaches a model prompt |

`extracted_text` and `text_source` are added by `0017_adjudications.sql` and
exist for [section 13](#13-ai-claim-adjudication-flow), which explains why the
text is captured here rather than extracted later.

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

## 13. AI Claim Adjudication Flow

Every other flow in this document uses the language model to choose a tool.
This one uses it to read. `POST /api/tools/adjudicate-claim` puts a policy, a
claim, and the text of the documents attached to the claim in front of a model
and asks where they contradict each other — a repair estimate totalling 12,000
behind a claim for 80,000, a police report dated three weeks from the incident,
a document describing a different vehicle. That is the work a keyword matcher
cannot do, and it is why there is a model in this part of the system at all.

The output is a **recommendation**. It is never a decision.

```text
Adjuster's queue calls adjudicate-claim
        (claim number only)
                │
                ▼
  1. Claim exists?          ── else claim_not_found
  2. Policy readable?       ── a fault is records_unavailable
  3. Sibling claims read    ── a fault is a recorded warning,
                               never a silent clean check
                │
                ▼
  ┌───────────────────────────────────────────┐
  │  Nine deterministic checks, in order      │
  │  policy_on_file                           │
  │  policy_not_cancelled                     │
  │  policy_in_force_on_incident_date         │
  │  claim_type_covered                       │
  │  claimed_amount_stated                    │
  │  claimed_amount_within_coverage           │
  │  claim_not_already_decided                │
  │  no_near_duplicate_claim                  │
  │  something_payable                        │
  └───────────────────────────────────────────┘
                │
      veto? ────┴──── yes ──►  verdict from the rule
        │                      confidence 1
        no                     model NOT called
        │                            │
        ▼                            │
  payable = max(0, min(claimed,      │
        coverage) − deductible)      │
  via settlement-service             │
                │                    │
                ▼                    │
  Build the prompt: policy, claim,   │
  and each document's text inside    │
  a <document> fence.                │
  The payable figure is WITHHELD.    │
                │                    │
                ▼                    │
  LlmProvider.complete               │
  (temperature 0, JSON object,       │
   20 s ceiling, AbortSignal)        │
                │                    │
     ┌──────────┴──────────┐         │
  answer               no answer     │
     │                     │         │
     ▼                     ▼         │
  Parse to the closed   escalate,    │
  schema, or escalate   reason       │
  with the failure      recorded     │
     │                     │         │
     ▼                     │         │
  Model's amount vs ours:  │         │
  differ → escalate,       │         │
  amount_agreement=        │         │
  'disagreed'              │         │
     └──────────┬──────────┘         │
                ▼                    │
        ┌───────────────┐◄───────────┘
        │  finalise()   │
        └───────┬───────┘
                ▼
  INSERT INTO adjudications  ── the only write this
                │               service performs
       insert failed? ── yes ──► verdict downgraded
                │                 to escalate
                ▼
  Recommendation returned with
  requires_human_approval: true
```

Nothing in this flow writes `claims.status`, `claims.approved_amount`, or
anything on the payout path. A human reads the row and decides, through the
review queue below.

### The deterministic layer runs first and can veto

`adjudication-rules.ts` is pure, synchronous, and reads nothing it was not
handed — arithmetic and date comparison over already-fetched facts. The answers
a reviewer most needs to trust are the answers no model participated in.

| Check | Failure forces | Why |
| --- | --- | --- |
| `policy_on_file` | escalate | A missing row is far more likely our problem than the claimant's |
| `policy_not_cancelled` | deny | A cancellation is deliberate termination, and unlike a lapse is not undone by the incident falling inside the printed term |
| `policy_in_force_on_incident_date` | deny | The question is the date, not today's status: a since-expired policy still covers an incident inside its term. Dates that cannot be parsed escalate instead |
| `claim_type_covered` | deny | `COVERED_CLAIM_TYPES` is a schedule stated in code, widenable by `coverage_details.covered_claim_types` and narrowable by nothing. A policy type with no schedule escalates — unknown is not "not covered" |
| `claimed_amount_stated` | escalate | Nothing to assess |
| `claimed_amount_within_coverage` | escalate | Settlement caps the payout anyway, so nothing is at risk of overpayment; what this needs is somebody telling the claimant, which is a conversation and not a denial |
| `claim_not_already_decided` | escalate | A recommendation on a decided claim could only invite a second decision |
| `no_near_duplicate_claim` | escalate | Another open claim of the same type on the same policy within seven days may be one incident claimed twice |
| `something_payable` | deny | The deductible swallows the claim |

`deny` is reserved for matters of record. Everything ambiguous escalates,
because an automated denial on a guess costs a claimant more than an automated
escalation costs us.

Only the first failure is acted on: once the policy did not cover the incident
date, whether the amount sits inside a limit that never applied is not a
finding worth reporting. All nine outcomes are stored regardless — "these seven
checks passed" is itself the evidence that the model was only asked what it was
entitled to answer.

**A veto returns before the model is called.** That is enforced in the service
and again in the schema: `adjudications_veto_precludes_model` rejects any row
carrying both `vetoed_by` and `model_invoked = true`.

### The model never decides money

`payable_amount` is assigned exactly once, from the rules layer, which delegates
to `settlement-service.computeSettlement`. The figure a recommendation carries
is therefore by construction the figure the settlement path would disburse; two
implementations of one rule is how they drift apart.

The model is asked for an amount as well. It is stored in a separate column and
never substituted for ours. A gap larger than 0.01 sets
`amount_agreement = 'disagreed'`, appends an explanation to the inconsistencies,
and **forces the verdict to `escalate`** whatever the model said. A proposed
amount below zero or above the coverage is additionally flagged as out of range.

**The computed figure is withheld from the prompt.** Shown our arithmetic the
model would echo it, and the disagreement check would be comparing our number
with our own number and always agreeing. A test asserts the figure never appears
in the prompt text.

The model is therefore asked for a number precisely so that the number can be
discarded. A model whose arithmetic differs from ours has misread something,
and that is worth a human's attention rather than a silent correction.

### Everything that goes wrong escalates

There is no path to a verdict favourable to paying a claim that has not
actually reached one.

| Situation | Result |
| --- | --- |
| Timeout (`ADJUDICATION_TIMEOUT_MS`, default 20 s) | `escalate`, the timeout recorded in `parse_error` |
| Provider unreachable, bad key, retired model id | `escalate`, the provider's reason recorded |
| Response is not JSON, or is a JSON array | `escalate` — picking the first object out of a list would be us choosing between answers the model declined to choose between |
| Verdict outside `approve\|deny\|escalate` | `escalate`; an unrecognised verdict is a parse failure, not a value to coerce |
| No `GROQ_API_KEY` | `FakeLlmProvider` answers, and its only answer is an escalation with zero confidence stating that no model read anything. The row is marked `simulated` |
| The `adjudications` insert fails | `escalate`, with a warning saying the reasoning could not be saved |
| Any unhandled throw in the route | `records_unavailable`, no verdict |

`adjudications_parse_failure_escalates` states the same rule in the schema, so a
future caller cannot record a parse failure as an approval.
`adjudications_model_fields_match_invocation` refuses a row that says no model
ran while carrying a model's output.

### Claimant text is content, never instruction

`extracted_text` on a document is claimant-supplied and reaches the prompt
verbatim, so it is prompt-injectable by construction. Three things bound it:

- The system prompt contains no claimant text at all. Everything the claimant
  wrote goes in the user message.
- Each document's text sits inside a `<document>` fence, and the system prompt
  states that anything inside it is content and never instruction, and that
  anything reading as a direction should be reported as an inconsistency rather
  than followed.
- `sanitiseDocumentText` replaces every `<document>` and `</document>` in the
  claimant's text with a visible `[removed-tag]`, so the fence is the one thing
  the text cannot forge — and the attempt itself is preserved for the reviewer
  rather than quietly deleted. Text is then truncated at 4,000 characters per
  document.

A document with no text on file is stated in the prompt as received, hashed, and
not cross-checkable. It is never silently omitted: a document missing from the
prompt is a document the model will assume corroborates the claim.

### Why the text is captured at upload

`claim_documents` has recorded the keccak256 of the bytes since 0013. A hash
cannot tell you the estimate says 12,000, so 0017 adds `extracted_text` and
`text_source` beside it, written at upload rather than extracted later:

1. `storage_status` can be `unarchived` — the bytes were hashed and not kept.
   Adjudication-time extraction would be impossible for exactly those
   documents, and a feature that silently skips them is worse than one that
   admits it has no text.
2. Text recorded beside the hash is checkable against the file that was
   attested. Text extracted later, from a copy, is not.
3. OCR or PDF parsing inside the upload path would add a dependency and a
   failure mode to the one path that must never lose the hash.

`text_source` is load-bearing: `claimant` is adversarial input, `ocr` and
`pdf_text` are machine-read from the stored bytes, `adjuster` was typed by
staff. A constraint refuses text with no stated source. Today the upload
endpoint accepts an optional `extracted_text` form field, capped at 20,000
characters, and records it as `claimant`.

### Not a voice tool, on purpose

`adjudicate_claim` is absent from `AGENT_TOOLS` in `agent-definition.ts` and
cannot be called by the phone agent. The agent's prompt already forbids
promising a claim outcome; a caller hearing an automated opinion that their
claim looks deniable, before any adjuster has read a word, is the harm that
instruction exists to prevent. The endpoint is back-office.

It sits on the on-chain rate-limit tier (15/min) rather than the tool tier
(120/min). Nothing here touches a chain, but every call past the deterministic
rules spends metered tokens against a third-party API, and that is the property
the tighter ceiling bounds.

It takes a claim number and nothing else — no amount, no verdict, no model
instruction. Anything a caller could name is something a caller could be talked
into naming.

### The provider boundary

`LlmProvider` is one method: a system string and a user string in, a completion
out. Everything that makes the model useful here — the schema it must answer in,
what happens when it does not, and what its answer is allowed to influence —
lives above that boundary, so swapping Groq for anything else changes nothing
about how a recommendation is reached.

`GroqProvider` posts to Groq's OpenAI-compatible endpoint with `temperature: 0`,
`response_format: {"type":"json_object"}`, and an `AbortSignal` rather than a
`Promise.race` — racing leaves the request running and its tokens billed after
we have stopped caring about the answer. Both the temperature and the response
format are requests, not guarantees, and nothing downstream is built on either:
the parser treats anything unparseable as a parse failure regardless of the
flag, and [EVALUATION.md](EVALUATION.md#ai-claim-adjudication) records what
`temperature: 0` actually delivers when the same case is run five times.

The model id is passed through unvalidated. We do not maintain a list of Groq's
current models, and a wrong id fails the call loudly — and escalates with the
reason recorded — rather than silently downgrading. The provider echoes back the
model id the API says answered, not the one we asked for.

### Data recorded

`0017_adjudications.sql` creates `adjudications`, one row per recommendation:

| Field | Meaning |
| --- | --- |
| `claim_id` / `claim_number` | The claim, and its number denormalised so the row stays readable after a renumber |
| `verdict` | `approve`, `deny`, or `escalate`. A recommendation, never a decision |
| `confidence` | 0–1. Exactly 1 on a deterministic veto, because that came from arithmetic |
| `computed_payable_amount` | Computed in code by the settlement path's own function. The only figure with authority |
| `model_proposed_amount` | What the model calculated. Recorded to be compared, never to be paid |
| `amount_agreement` | `agreed`, `disagreed`, `not_proposed`, `not_asked` |
| `policy_clauses` / `inconsistencies` | What the model reported |
| `checks` | All nine outcomes with ids, pass flags and one-line explanations |
| `vetoed_by` | The rule that short-circuited before the model, or null |
| `model_invoked` / `model_provider` / `model_id` / `model_latency_ms` | The model, exactly as it happened |
| `simulated` | True when `FakeLlmProvider` answered and no model read anything |
| `prompt_system` / `prompt_user` / `raw_response` | The exact prompt and the raw bytes returned. This is what makes the row an audit record rather than a summary |
| `parse_error` | Why the response could not be reduced to the schema. Always paired with `escalate` |

Constraints carry the same rules as the service: the verdict and agreement
enums, confidence within 0–1, a non-negative computed amount, no model fields
without an invocation, no veto alongside an invocation, and no parse error
without an escalation.

Row-level security is enabled with **no policy at all**, following 0016 rather
than 0007. `prompt_user` contains the incident description and the full text of
the claimant's documents, and insert rights on the table would let anyone
fabricate an audit trail — a row saying a model recommended approval, with a
prompt and a response nobody ever sent. The backend holds the service role key
and bypasses RLS; the anon key shipped in the frontend bundle gets nothing. The
table is also kept out of the realtime publication.

`0017` additionally adds `extracted_text` and `text_source` to
`claim_documents`, with a constraint that text is never stored without a stated
source.

### The human half: the review queue

A recommendation nobody can answer is a dead end. `backend/src/routes/adjudication-review.ts`
is where a person's answer goes, and the React page at `/review`
(`frontend/src/pages/ReviewQueue.tsx`, reached from the sidebar as **Review
Queue**) is where they give it.

| Endpoint | Does |
| --- | --- |
| `GET /api/adjudications/queue` | The recommendations awaiting an answer, newest first, one per claim. `state` is `pending`, `decided`, or `all` |
| `POST /api/adjudications/:id/decision` | Records one human decision — `approve` or `reject` — and moves the claim |

`approve` sets the claim to `approved`, which is the one status `settle_claim`
will disburse from. It deliberately does **not** write `approved_amount`: the
settlement path computes that figure at payout time, and a second copy of the
arithmetic here is how the two drift apart. `reject` sets `denied`. A claim
already `paid` or `closed` is not moved at all — the decision is still recorded,
with a warning saying the claim stayed where it was.

Everything on this page is arranged so the screen cannot show a state that is not
true:

- **The queue reports its own limits.** It scans a bounded window of the newest
  adjudications (500 by default, 2,000 maximum) rather than pretending to have
  read the table. When the window fills, `truncated` says so and the counts that
  cannot be exact — `claims_never_adjudicated` in particular — come back null
  instead of approximate.
- **An unapplied migration is a state, not a swallowed error.** 0019 is applied
  by hand like every other migration here. Until it is, `reviews_available` is
  false and the queue says plainly that decisions cannot be read or recorded,
  rather than rendering every recommendation as though it were awaiting review.
  `decisions_enabled` reports the same thing for a missing `ADMIN_TOKEN`.
- **The decision is recorded before the claim is moved.** The audit row goes in
  first; if the status update then fails, `claim_status_after` stays null and
  both the response and the queue show a decision that did not move the claim.
  The opposite order can change a claim with no record of who changed it.
- **Only the current recommendation is answerable.** A re-adjudicated claim
  supersedes its earlier runs; those are counted as `superseded_count` and not
  listed, and deciding one returns 409.
- **One decision per recommendation.** A unique index on `adjudication_id` makes
  a double-clicked button a 409 rather than a second row. A reviewer who wants a
  different answer needs a fresh adjudication, not a quiet overwrite.

Writes require `Authorization: Bearer $ADMIN_TOKEN`, compared timing-safely, and
fail closed with 503 when no token is set — an unauthenticated write here would
let anyone record a human approval naming an adjuster who never saw the claim and
then move the claim into the status settlement disburses from. `reviewer` is
required and free text: this system has no user accounts, so it is an
attribution, not an authentication. The token is what authorises; the field
records who says they used it.

`prompt_system`, `prompt_user`, and `raw_response` are deliberately absent from
what the queue serves. `prompt_user` carries the incident description and the
full text of the claimant's documents, and none of it is needed to decide a
claim, so it does not cross the wire. The audit row keeps it either way.

The response also states `overrode_recommendation` outright rather than leaving a
reader to work it out, because a human going against the recommendation is the
case worth counting.

### Coverage

65 tests in `backend/src/services/adjudication-service.test.ts`, covering every
veto, the payable figure surviving a model that insists otherwise, each parse
failure, the timeout, the unreachable provider, the unrecorded row, the fence
that claimant text cannot forge, and the assertion that the computed amount
never reaches the prompt.

---

## 14. Policy Renewal Flow

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
unattended offer is 200,000 (`RENEWAL_MAX_LINK_AMOUNT`). `RenewalRefusalReason`
in `backend/src/services/renewal-service.ts` has twelve members:
`policy_not_found`, `records_unavailable`, `policy_already_active`,
`policy_cancelled`, `policy_not_renewable`, `nothing_payable`,
`above_link_limit`, `link_failed`, `renewal_not_recorded`,
`link_status_unknown`, `renewal_already_paid` and `renewal_needs_review`. A
refusal never returns a payment link.

The last three are the ones a real call turned up, and all three exist to stop a
second demand for money already taken. `link_status_unknown` is the rail failing
to answer whether an existing link is still payable — unknown is not "unpaid", so
nothing is re-offered on a guess. `renewal_already_paid` and
`renewal_needs_review` both mean the premium has already been paid: the first
when the policy is back in force, the second when finishing the record needs a
human.

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

### The deductible side, which has no flow section of its own

`collect_deductible` is the same shape pointed at a claim rather than a policy:
it takes a claim number, reads the excess off the policy, and issues a link for
it, with the ceiling on an unattended demand at 100,000
(`DEDUCTIBLE_MAX_LINK_AMOUNT`, defaulted by
`DEFAULT_DEDUCTIBLE_MAX_LINK_AMOUNT` in
`backend/src/services/deductible-service.ts`).
`DeductibleCollectionRefusalReason` in the same file has ten members:
`claim_not_found`, `records_unavailable`, `claim_not_open`, `policy_not_found`,
`nothing_payable`, `above_link_limit`, `link_failed`,
`deductible_not_recorded`, `link_status_unknown` and
`deductible_needs_review`. The last two are the deductible half of the fix
described above — the rail could not be asked whether an existing link is still
payable, and the rail says the excess was paid but that could not be written
down. Neither hands back a link.

`refund-deductible` waives an excess already collected, and is deliberately not
a voice tool (see [section 4](#4-ai-tool-architecture)).
`DeductibleRefundRefusalReason` has eleven members: `claim_not_found`,
`records_unavailable`, `no_captured_payment`, `already_refunded`,
`claim_not_settled`, `fault_not_determined`, `insured_at_fault`,
`refund_exceeds_capture`, `provider_mismatch`, `refund_failed` and
`refund_not_recorded`. There is no `link_status_unknown` among them because a
refund never consults a payment link: it runs against a capture already recorded
against the claim, and with no such capture it refuses with
`no_captured_payment` rather than asking the rail.

---

## 15. Regulatory Escalation Flow

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

## 16. Call Logging

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

## 17. Dashboard Data Flow

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

## 18. Post-Call Flow

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

## 19. Error Handling

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

## 20. Security Considerations

The guards in the code today are described here as they behave, along with what
they do not cover.

### Shared-token guard on agent-facing endpoints

Everything the voice agent calls sits behind `requireToolsToken`
(`backend/src/plugins/tools-auth.ts`), with the decision itself in
`backend/src/services/tools-token.ts` so it can be unit tested without booting
the server. It covers every route in `webhook-tools.ts` and every route in
`deductible-tools.ts` — registered in each as a scope-wide `preHandler` so a tool
added later inherits it rather than needing to be remembered — plus
`GET /api/elevenlabs/conversation-init` and
`POST /api/calls/:id/tool-executions`.

These are not merely reads. `file-claim` spends testnet ETH on an attestation and
pays for a Filecoin upload, `settle-claim` releases a payout, `offer-renewal` and
`collect-deductible` create real payment links, `refund-deductible` returns money
already captured, and `conversation-init` returns a customer's name,
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
| On-chain | 15 (`RATE_LIMIT_ONCHAIN_MAX`) | `file-claim`, `settle-claim`, `offer-renewal`, `collect-deductible`, `refund-deductible`, `escalate-to-regulator`, `adjudicate-claim` |

The tools tier is generous on purpose: ElevenLabs calls out from shared egress
addresses, so one IP legitimately carries every concurrent conversation. The
on-chain tier is tight because those seven routes each spend something — a
Filecoin upload and a Base Sepolia write on filing, a payout on settlement,
payment links on renewal and deductible collection, a refund against a capture,
an EAS attestation on a regulatory escalation, and metered third-party tokens on
adjudication — and no phone conversation reaches that rate.

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

### Untrusted text in a model prompt

Adjudication is the one place where text a claimant controls reaches a language
model, so it is treated as an injection surface rather than as data.

The system prompt carries no claimant text at all; everything the claimant wrote
goes in the user message, inside a `<document>` fence that the system prompt
declares to be content and never instruction, with any apparent direction to be
reported as an inconsistency rather than followed. `sanitiseDocumentText`
replaces every `<document>` and `</document>` occurring inside that text with a
visible `[removed-tag]`, so the fence is the one thing the claimant cannot
forge, and the attempt survives in the audit row for a reviewer to see. Text is
truncated at 4,000 characters per document in the prompt and at 20,000 at
upload.

The defence that matters most is not in the prompt at all: the model's answer
cannot move money. The payable figure is computed in code, the model's own
figure is only ever compared against it, and a successful injection producing
`{"verdict":"approve"}` still yields a row that no human has approved and that
changes nothing about the claim. See
[section 13](#13-ai-claim-adjudication-flow).

### What this does not cover

* **Prompt injection is bounded, not solved.** A crafted document can still
  steer what the model *reports* — it cannot approve, pay, or alter a claim, and
  it cannot conceal itself from the stored prompt, but a reviewer reading the
  inconsistencies is reading text an attacker influenced.
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

## 21. Deployment Architecture

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

## 22. Technology Summary

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
| Adjudication model | Groq (`openai/gpt-oss-120b` by default); a labelled fake with no key |
| Payments in      | Razorpay Payment Links (real; simulated with no credentials) |
| Payments out     | Simulated payout rail — RazorpayX not available |
| Frontend Hosting | Vercel                            |
| Backend Hosting  | Railway                           |

---

## 23. Design Principles

SafeGuard follows a few important design principles:

### AI handles conversation, backend handles business logic

The AI agent decides what the customer needs. The backend performs the actual application operation.

### Tools over hallucination

Claim and policy information should come from backend tools and the database rather than from the model's generated knowledge.

### The model reports, code decides

Where a model is used for judgement rather than conversation, the parts that can
be computed are computed. Deterministic rules run first and can veto before the
model is called; money is arithmetic in code; anything the model returns that
cannot be reduced to a closed schema escalates rather than defaulting. The
model's job is the part code cannot do — reading documents and reporting where
they contradict the claim.

### Human escalation

Automation should have a clear path to human assistance. A recommendation is not
a decision: adjudication writes an audit row and nothing else, and a person
decides from it.

### Modular workflows

Each major insurance workflow is exposed through a separate backend capability.

### Observable interactions

Calls and tool executions are recorded so the system can be monitored and debugged.

---

## 24. Current Scope

The current prototype demonstrates:

* AI voice conversations
* Claim lookup
* Policy lookup
* Missing document checking
* Claim filing
* Document upload, hashing, and byte-level verification
* AI claim adjudication: deterministic rules, then a model cross-checking uploaded document text against the claim, recorded as a recommendation a human must approve
* A review queue where an adjuster answers that recommendation, and their decision — not the model's — moves the claim
* Deductible collection through a real Razorpay payment link, and a refund when fault is determined to lie with the other party
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

## 25. Evidence and Attestation

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
Anchor on Base Sepolia ─────► tx hash      (optional)
  V2: the hash, with the CID as an optional locator
  V1: the CID only, so a failed upload stops the chain
```

### Independent degradation

Each stage can fail without losing the stages before it. This ordering is deliberate:

* The **evidence hash is recorded unconditionally**. It is the primitive that makes tampering detectable, and it requires no external service, so a storage outage never costs the guarantee.
* **Filecoin upload** is attempted only when an agent wallet is configured. Failure is recorded as `upload_status: 'failed'` with the reason. This degradation is not hypothetical: in the deployed environment Filecoin archival has never once succeeded. `/health` reports `filecoin_uploads.last_attempt` as `"failed"` with `last_success_at: null`, and live claim rows carry `filecoin_cid: null`. Production has been running in exactly the degraded state this ordering was designed to survive.
* **On-chain attestation** depends on which registry is configured. Against `ClaimRegistryV2` it anchors the evidence hash and passes the CID as an optional locator, so archival being down no longer costs the on-chain guarantee — an empty locator is an honest record of "hashed, not stored". Against V1 it runs only when there is a real CID to attest, because V1 has no way to express that: attesting a storage identifier that does not exist would put a false claim on a public ledger, so a failed upload stops the chain and the skip is recorded as a warning naming `CLAIM_REGISTRY_V2_ADDRESS`. This half does work in the deployed environment, and it is what the split bought: `/health` reports `chain_attestation.last_attempt` as `"succeeded"`, against a real Base Sepolia transaction, `0x7f3ef7575b978ae29d22656ff4e884a5119dfb95dc04738db2cc9266d120a532`.

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

There are two registry contracts, both on Base Sepolia, and the backend prefers
the newer one. `resolveRegistry` in `backend/src/services/ethereum-service.ts`
returns V2 whenever `CLAIM_REGISTRY_V2_ADDRESS` holds a valid address, and falls
back to `CLAIM_REGISTRY_ADDRESS` otherwise, so a deployment that has not set the
new value keeps working unchanged.

| | `ClaimRegistry` (V1) | `ClaimRegistryV2` |
| --- | --- | --- |
| Anchors | A Filecoin CID | The keccak256 evidence hash, required and immutable |
| Storage locator | Same field as the anchor | A separate, optional, opaque string — empty is valid |
| Write | `fileClaim(string filecoinCid)` | `anchorClaim(bytes32 evidenceHash, string storageLocator)` |
| Ids | 0-based | 1-based, so a zero in `claimIdByEvidenceHash` means "never anchored" rather than "claim 0" |
| Address | `0x248522cdd800b2692c757f126b75b8c9f46d4f9d` | `0x40e6607d2d6a1cb30b019d448fd6fd9370194281` |

V1 conflated two different things: the *proof* that a bundle was not altered and
the *address* at which its bytes can be fetched. Only the first is a security
primitive, and gating attestation on the second meant an archival outage
destroyed the integrity guarantee for claims that had already been hashed
correctly. V2 splits them. `setStorageLocator` lets the original claimant attach
a recovered upload later, once, so a locator can be filled in without
re-anchoring the proof — and never edited or removed, because a mutable pointer
beside an immutable hash would let an operator redirect verifiers at bytes the
hash does not cover.

In both contracts anchoring is permissionless and records who filed, and
**verification is restricted to the contract owner** — a claim anyone could mark
verified would carry no attestation value.

Neither address is hardcoded anywhere; both are read from the environment. Note
one wrinkle: `CLAIM_REGISTRY_V2_ADDRESS` is read directly from `process.env`
inside `ethereum-service.ts` rather than through the central `environment.ts`
config module, deliberately, so that `features.attestation` — which is derived
from `CLAIM_REGISTRY_ADDRESS` and drives what `/health` reports — keeps its
existing meaning.

---

## 26. Agent Configuration

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

## 27. Simulation Mode

Filecoin storage requires a funded payment rail, which is not always available for demonstrations. With `SIMULATE_BLOCKCHAIN=true` and no agent wallet, the pipeline produces a real CIDv1 content address computed from the actual bundle bytes, plus a deterministic placeholder transaction hash.

Everything it writes is marked `simulated = true`, and the dashboard renders those rows without explorer links, because the referenced data was never published and the links would not resolve.

`/health` reports these features as `"simulated"` rather than `true`. Real credentials always take precedence; simulation only applies where nothing real is configured.

---

## 28. Architecture Summary

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

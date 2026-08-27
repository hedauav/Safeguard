# SafeGuard — Product Requirements Document

## 1. Product Overview

### Product Name

**SafeGuard — AI-Powered Insurance Claims Voice Assistant**

### One-Liner

SafeGuard is an AI-powered voice assistant that helps policyholders handle routine insurance claims tasks through natural conversation.

### Product Vision

Insurance customers often need support for simple tasks such as checking claim status, understanding policy coverage, identifying missing documents, filing claims, or requesting a callback.

SafeGuard turns these repetitive interactions into a conversational workflow. Instead of navigating phone menus or waiting for a support representative, a customer can speak naturally with an AI assistant.

The AI agent can retrieve relevant information, call backend tools to perform supported actions, and escalate complex cases to a human representative.

The goal is not to replace human support completely. The goal is to automate routine work while keeping human assistance available when it is needed.

---

## 2. Problem

Insurance claims support involves many repetitive conversations.

Common customer requests include:

* What is the current status of my claim?
* What does my policy cover?
* Which documents are still missing?
* How can I file a new claim?
* Can someone call me back?
* I need help with a complex claim issue.

Handling these requests manually can take time for both customers and support teams.

Traditional phone systems can also create unnecessary friction through:

* Long waiting times
* Menu-based navigation
* Repeated information collection
* Limited availability
* Manual lookup of claim information
* Manual escalation and follow-up

SafeGuard addresses these problems with a conversational AI interface connected to real application data and backend workflows.

---

## 3. Target Users

### Policyholders

Customers who need quick answers or assistance with routine insurance claims tasks.

### Insurance Support Teams

Support teams that handle a large number of repetitive claims-related conversations and need better visibility into customer interactions.

### Claims Representatives

Human representatives who receive escalated cases and need access to the customer's claim and conversation context.

---

## 4. Core User Workflows

SafeGuard supports six main workflows. Four more were added after this section was written and are described in their own sections rather than here: claim settlement and policy renewal (section 8), deductible collection (section 8), document upload and integrity verification (section 21), and AI claim adjudication with a human decision (section 22).

### 4.1 Claim Lookup

A customer provides a claim number.

The AI agent calls the claim lookup backend tool and retrieves information such as:

* Claim status
* Claim type
* Incident date
* Claimed amount
* Assigned adjuster
* Required documents
* Documents already received

The result is returned to the customer in a natural conversational response.

### 4.2 Policy Lookup

A customer provides a policy number.

The system retrieves supported policy information such as:

* Policy type
* Provider
* Policy status
* Coverage amount
* Deductible
* Premium
* Coverage details

### 4.3 Document Checking

The customer asks which documents are still required.

The AI agent checks the claim and identifies:

* Required documents
* Documents already received
* Missing documents

### 4.4 Claim Filing

The customer provides the information required to start a new claim.

The backend creates the claim and returns:

* Claim number
* Claim status
* Confirmation message
* Next steps

### 4.5 Human Escalation

If the AI cannot appropriately resolve a request, the customer can be escalated to a human representative.

The system records:

* Reason for escalation
* Priority
* Customer
* Claim
* Call context
* Escalation status

### 4.6 Callback Scheduling

A customer can request a callback.

The system records:

* Phone number
* Preferred time
* Reason
* Callback status

---

## 5. Product Architecture

```text
                         ┌──────────────────┐
                         │     Customer     │
                         └────────┬─────────┘
                                  │
                         Voice Conversation
                                  │
                                  ▼
                    ┌─────────────────────────┐
                    │ ElevenLabs AI Agent     │
                    │                         │
                    │ Speech + Conversation   │
                    │ Tool Selection          │
                    └───────────┬─────────────┘
                                │
                         Tool/Webhook Calls
                                │
                                ▼
                    ┌─────────────────────────┐
                    │ Fastify Backend         │
                    │                         │
                    │ Claims                  │
                    │ Policies                │
                    │ Documents               │
                    │ Adjudication            │
                    │ Settlements             │
                    │ Renewals                │
                    │ Deductibles             │
                    │ Escalations             │
                    │ Callbacks               │
                    └───────────┬─────────────┘
                                │
                                ▼
                    ┌─────────────────────────┐
                    │ Supabase / PostgreSQL   │
                    └───────────┬─────────────┘
                                │
                                ▼
                    ┌─────────────────────────┐
                    │ React Dashboard         │
                    │                         │
                    │ Claims                  │
                    │ Review Queue            │
                    │ Calls                   │
                    │ Analytics               │
                    │ Escalations             │
                    │ Blockchain              │
                    │ Agent Configuration     │
                    └─────────────────────────┘
```

### Phone Conversation

```text
Customer
   │
   ▼
Twilio
   │
   ▼
ElevenLabs Conversational AI
   │
   ├── AI conversation
   │
   ├── Tool calls
   │
   └── Human escalation
          │
          ▼
     Fastify Backend
          │
          ▼
    Supabase PostgreSQL
```

### Browser Conversation

```text
Browser
   │
   ▼
ElevenLabs React SDK
   │
   ▼
Same AI Agent
   │
   ▼
Fastify Backend
   │
   ▼
Supabase PostgreSQL
```

### Dashboard

```text
React Dashboard
      │
      ├── Supabase
      │
      └── Fastify API
```

---

## 6. Technology Stack

| Component           | Technology                      |
| ------------------- | ------------------------------- |
| Frontend            | React, TypeScript, Tailwind CSS |
| Backend             | Node.js, TypeScript, Fastify    |
| Database            | PostgreSQL through Supabase     |
| Voice AI            | ElevenLabs Agents               |
| Adjudication model  | Groq — `openai/gpt-oss-120b` by default, optional |
| Payment links       | Razorpay (payouts simulated)    |
| Phone Connectivity  | Twilio (optional)               |
| Browser Voice       | ElevenLabs embedded widget      |
| Evidence storage    | Filecoin via Synapse (optional) |
| Attestation         | Base Sepolia, EAS (optional)    |
| Contracts           | Solidity, Foundry               |
| Frontend Deployment | Vercel                          |
| Backend Deployment  | Railway                         |

---

## 7. AI Agent

SafeGuard uses ElevenLabs Conversational AI as the voice interaction layer.

The AI agent is responsible for understanding the customer's conversation and selecting the appropriate backend tool.

The backend remains responsible for application logic and data operations.

### Agent Responsibilities

The agent should:

* Understand natural language requests
* Identify the required workflow
* Ask for required information
* Call the appropriate backend tool
* Communicate the result clearly
* Avoid inventing claim or policy information
* Escalate cases that require human assistance

### Agent Rules

These are the instructions actually carried in the shipped system prompt
(`backend/src/config/agent-definition.ts`), not an aspiration:

1. Never state a claim or policy fact from memory — call the matching tool and read back what it returns. This covers what a caller is *allowed* to do, not only what is on file.
2. Read critical values back for confirmation: claim numbers, policy numbers, dates, and amounts.
3. Keep voice responses concise and easy to understand, and ask for one piece of information at a time.
4. Be professional and empathetic.
5. Never promise a claim outcome, payout amount, or approval, and never state or estimate a settlement or renewal figure — both are computed from the policy by the tool.
6. Never claim to send anything. There is no SMS or email sender in the system, so a link is read out on the call.
7. Offer human escalation when the request cannot be appropriately resolved, or when the caller is unhappy with the automated handling.

**The agent does not authenticate the caller.** It is handed what the records say
about the dialling number and is told to treat a placeholder as not-a-fact and to
believe the caller over the record when the two disagree — but there is no
identity check anywhere in the flow. Anyone who knows a claim number can hear its
status. Customer authentication is listed among the controls a production
deployment would need, in section 16.

---

## 8. Backend Tools

The AI agent communicates with the application through dedicated backend endpoints.

### Available Tools

| Tool                     | Purpose                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `lookup_claim`           | Retrieve an existing claim                                           |
| `file_claim`             | Create a new claim                                                   |
| `check_policy`           | Retrieve policy information                                          |
| `check_documents`        | Identify missing claim documents                                     |
| `explain_claim_assessment` | Explain what a filed claim is worth under its policy — never whether it will be approved |
| `attach_document`        | Read out where to upload a document, and what the claim still needs  |
| `escalate_to_human`      | Create a human escalation                                            |
| `escalate_to_regulator`  | File a regulatory complaint, attested on chain when EAS is configured |
| `schedule_callback`      | Schedule a customer callback                                         |
| `settle_claim`           | Release the payout on an approved claim                              |
| `collect_deductible`     | Put the excess owed on a claim behind a payment link                 |
| `offer_renewal`          | Offer a payment link for a lapsed policy's premium                   |

Twelve backend tools, each with its own refusal conditions. Two further tools — `show_payment_link` and `show_upload_link` — run in the caller's browser rather than on the backend, putting a payment link or an upload address on screen during a web call instead of leaving it to be read aloud; they have no endpoint, issue nothing, and change no record. Fourteen in all, as registered in `backend/src/config/agent-definition.ts`. Together they allow the AI agent to perform application actions instead of functioning only as a question-and-answer chatbot.

---

## 9. Database Design

SafeGuard uses PostgreSQL through Supabase. `backend/database/run-all.sql` creates **18 tables**; the seven below are the core the product is built around. The other eleven support features described later in this document: `agent_registrations` and `agent_settings` (agent identity and the editable configuration), `filecoin_uploads`, `evidence_bundles` and `claim_documents` (evidence integrity, section 21), `policy_renewals`, `deductible_payments` and `razorpay_webhook_events` (payment links and their confirmations), `adjudications` and `adjudication_reviews` (AI adjudication and the human decision on it), and `journey_events`, the append-only record of what happened to a claim or a policy and when — failures included, which the per-step tables cannot show (`0021_journey_events.sql`).

### Customers

Stores customer information required by the application.

```sql
customers
- id
- full_name
- email
- phone
- date_of_birth
- address
- created_at
```

### Policies

Stores policy information.

```sql
policies
- id
- policy_number
- customer_id
- policy_type
- provider
- coverage_amount
- deductible
- premium_monthly
- start_date
- end_date
- status
- coverage_details
- created_at
```

### Claims

Stores insurance claim information.

```sql
claims
- id
- claim_number
- policy_id
- customer_id
- claim_type
- status
- incident_date
- incident_description
- claimed_amount
- approved_amount
- assigned_adjuster
- documents_required
- documents_received
- notes
- filed_at
- updated_at
```

### Call Logs

Stores information about AI conversations.

```sql
call_logs
- id
- elevenlabs_conversation_id
- customer_id
- direction
- phone_number
- status
- duration_seconds
- transcript
- summary
- outcome
- tools_used
- recording_url
- started_at
- ended_at
```

### Tool Executions

Records backend tools used during conversations.

```sql
call_tool_executions
- id
- call_log_id
- tool_name
- tool_args
- tool_result
- success
- latency_ms
- executed_at
```

### Escalations

Stores cases that require human assistance.

```sql
escalations
- id
- call_log_id
- claim_id
- customer_id
- reason
- priority
- status
- assigned_to
- notes
- created_at
- resolved_at
```

### Scheduled Callbacks

Stores requested customer callbacks.

```sql
scheduled_callbacks
- id
- call_log_id
- customer_id
- phone_number
- scheduled_time
- reason
- status
- created_at
```

---

## 10. Backend API

The Fastify backend exposes APIs for the AI agent and dashboard.

### AI Tool Endpoints

Fourteen routes: the twelve backend tools above, plus adjudication and the deductible refund, which are called by the system rather than named on a call. The two client tools have no route — nothing about them is served from here.

```text
POST /api/tools/lookup-claim
POST /api/tools/file-claim
POST /api/tools/check-policy
POST /api/tools/check-documents
POST /api/tools/explain-claim-assessment
POST /api/tools/attach-document
POST /api/tools/escalate-to-human
POST /api/tools/escalate-to-regulator
POST /api/tools/schedule-callback
POST /api/tools/settle-claim
POST /api/tools/offer-renewal
POST /api/tools/collect-deductible
POST /api/tools/refund-deductible
POST /api/tools/adjudicate-claim
```

All fourteen sit behind a shared token (`TOOLS_API_TOKEN`); without one configured they refuse rather than fall open in production.

### Dashboard Endpoints

```text
GET  /health
GET  /version
GET  /api/calls
GET  /api/calls/:id
GET  /api/claims
GET  /api/claims/:id
GET  /api/escalations
GET  /api/analytics
GET  /api/agent-config
GET  /api/agent-identity
GET  /api/adjudications/queue
PUT  /api/agent-config
POST /api/agent-config/sync
POST /api/agent-config/reset
POST /api/adjudications/:id/decision
POST /api/claims/:id/verify-integrity
POST /api/claims/:claimNumber/documents
POST /api/claims/:claimNumber/documents/:id/verify
POST /api/webhooks/elevenlabs/conversation-ended
POST /api/webhooks/razorpay
```

The backend handles application logic, database operations, tool execution, and post-call logging.

### Where the authentication line falls

Three different secrets guard three different things, and the boundary is worth stating plainly because it is not the one a reader would assume.

| | Guarded by | Covers |
| --- | --- | --- |
| Agent tool calls | `TOOLS_API_TOKEN` | All fourteen `/api/tools/*` routes, plus `GET /api/elevenlabs/conversation-init` and `POST /api/calls/:id/tool-executions` |
| Operator writes | `ADMIN_TOKEN` | `PUT /api/agent-config`, `POST /api/agent-config/sync`, `POST /api/agent-config/reset`, and `POST /api/adjudications/:id/decision` |
| Webhook deliveries | `ELEVENLABS_WEBHOOK_SECRET` / `RAZORPAY_WEBHOOK_SECRET` | Signature verification on the two webhook routes |

**Every read is open. Deciding is gated.** Nothing in the `GET` list above carries a guard — `GET /api/adjudications/queue` included, which means the recommendation queue, the rules that vetoed, and the model's verdict on every claim are readable by anyone holding the URL. What is gated is the write that acts on them: recording a human decision needs `ADMIN_TOKEN`, and refuses with 503 rather than falling open when none is configured. The document upload and verification routes are the deliberate exception on the write side — the browser posts to them, and a shared token cannot be shipped in a browser bundle, so they are bounded by rate limit rather than by a secret.

Closing the read side is the first item under Future Improvements in section 18.

---

## 11. Frontend Dashboard

The dashboard provides visibility into the claims and AI interaction workflow.

### Main Pages

The routes below are the complete set registered in `frontend/src/App.tsx`.

| Page                | Route         | Sidebar label  | Purpose                                                   |
| ------------------- | ------------- | -------------- | --------------------------------------------------------- |
| Landing             | `/`           | — (logo links here) | The public entry page, outside the dashboard layout   |
| Claims              | `/claims`     | Claims         | View and filter claims                                     |
| Claim Detail        | `/claims/:id` | —              | View individual claim information, and verify its evidence |
| Review Queue        | `/review`     | Review Queue   | Decide the adjudications waiting on a human                |
| Call History        | `/calls`      | Call History   | Review previous calls                                      |
| Analytics           | `/analytics`  | Analytics      | View call and workflow metrics                             |
| Blockchain          | `/blockchain` | Evidence       | See which claims are archived and attested                 |
| Agent Configuration | `/config`     | Agent Config   | Manage supported AI agent settings                         |

There is no separate live-call page. A live conversation is carried by the
`CallWidget` component mounted in the dashboard layout, so it is available from
every page above rather than from a route of its own.

### Important Components

* AI voice interaction widget (`CallWidget`, mounted in the layout on every dashboard page)
* Conversation transcript
* Tool execution information
* Claim status indicators
* Analytics cards
* Call charts
* Periodic refresh on the review queue — a 30-second poll that pauses while the
  tab is hidden and re-reads on the way back in. It is the only page that
  refreshes itself; nothing in the dashboard subscribes to Supabase realtime,
  so every other page shows what it read when it loaded.

---

## 12. Seed Data

The prototype uses realistic sample insurance data to demonstrate the product.

The seed dataset includes examples covering different scenarios such as:

* Active claims
* Missing documents
* Approved claims
* Denied claims
* Recently filed claims
* Multiple claims for a customer
* Different insurance policy types
* Historical calls
* Pending escalations
* Scheduled callbacks

The data is intended for demonstration and testing.

---

## 13. Example Conversation

### Customer

"I want to know what's happening with my claim."

### AI Agent

"Sure. I can check that for you. Could you provide your claim number?"

### Customer

"My claim number is CLM-2026-000456."

### AI Agent

The agent calls:

```text
lookup_claim
```

The backend retrieves the claim from the database.

### Backend Result

```text
Status: Under Review
Missing Documents:
- Repair estimate
- Photos
```

### AI Agent

"Your claim is currently under review. We still need your repair estimate and photos of the damage before the review can continue."

The customer can then ask another question, file a claim, schedule a callback, or request human assistance.

---

## 14. Error Handling

The system should handle situations such as:

* Invalid claim number
* Invalid policy number
* Missing required information
* Claim not found
* Policy not found
* Unsupported requests
* Backend failures
* Tool execution failures

The AI should provide a useful response instead of exposing technical errors to the customer.

When an issue cannot be resolved automatically, the system should provide a human escalation path.

---

## 15. Observability

SafeGuard records information about AI conversations and backend tool execution to make the system easier to understand and debug.

The system can track:

* Conversation ID
* Call status
* Call duration
* Transcript
* Conversation outcome
* Tools used
* Tool arguments
* Tool results
* Tool success/failure
* Tool latency
* Escalations
* Callback requests

This information is surfaced through the dashboard.

---

## 16. Security and Privacy Considerations

SafeGuard is a prototype and uses demonstration data.

A production deployment would require additional controls, including:

* Strong customer authentication
* Authorization checks for claim and policy access
* Secure handling of personal information
* Secrets stored only in environment variables
* Audit logging
* Encryption in transit and at rest
* Data retention policies
* Access controls
* Production-grade compliance review

The current demonstration should not be treated as a production insurance system.

### What is enforced today

Not everything above is absent. Four controls are live: the shared token in front
of every agent tool call, the admin token in front of the operator writes and the
human decision (section 10), signature verification on both webhooks, and per-IP
rate ceilings in three tiers. What is genuinely missing is the customer half —
there is no caller identity verification, so the agent trusts the claim or policy
number read out to it, and there is no authentication on any read endpoint.

### One column the browser cannot read

`filecoin_uploads.error` records the raw provider failure from an archival
attempt, which for a Synapse error carries the agent wallet address and the
Calibration RPC URL. Migration `0023_filecoin_error_column_grant_fix.sql` puts it
out of reach of the publishable key compiled into the browser bundle — the
table-wide `SELECT` grant on that table is revoked and re-issued naming the
eleven columns that stay readable, with `error` left out.

Two consequences worth knowing before touching that table:

* A `select=*` on `filecoin_uploads` from the browser key now **fails outright**
  rather than returning the readable columns, because the expansion includes a
  column the role has no privilege on.
* **A column added to this table in future is invisible to the browser until it
  is explicitly granted.** Before this migration a new column was public the
  instant it existed. This is the reverse of that default, and it is the safe
  direction to fail in.

The backend's service key is unaffected and still reads the column, so the health
endpoint and the evidence pipeline see failures in full.

---

## 17. Environment Configuration

The application uses environment variables for external services and deployment configuration.

Example:

```bash
# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# ElevenLabs
ELEVENLABS_API_KEY=
ELEVENLABS_AGENT_ID=

# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=

# Server
PORT=3005
NODE_ENV=production
FRONTEND_URL=
```

Actual credentials must never be committed to the repository.

---

## 18. Project Scope

### Included

* AI-powered voice conversation
* Insurance claims workflows
* Policy lookup
* Document checking
* Claim filing
* Human escalation
* Callback scheduling
* Backend tool execution
* PostgreSQL database
* Claims dashboard
* Call history
* Analytics
* AI agent configuration
* Document upload, content hashing and integrity verification (section 21)
* Claim settlement, policy renewal and deductible payment links
* AI claim adjudication with a human decision on every verdict (section 22)

### Future Improvements

Potential future improvements include:

* Authentication on the dashboard and the read endpoints, which are open today
* More insurance workflows
* Automated document analysis — no OCR or PDF extraction runs today, so document text is whatever the uploader supplied and is recorded as such
* Real settlement payouts, which need RazorpayX and business KYC
* Better fraud detection
* More advanced analytics
* Notification systems — there is no SMS or email sender in the backend today, so every link the agent offers is read out on the call
* Integration with real insurer systems
* Multi-language voice support
* Improved human-agent handoff

---

## 19. Current Status

SafeGuard is a working prototype demonstrating an end-to-end AI-powered insurance claims support workflow.

The project connects a conversational voice interface with backend tools, a database, and a dashboard.

The main product idea is to move beyond a simple AI chatbot by allowing the AI agent to interact with real application workflows and escalate cases when human support is required.

---

## 20. Product Goal

The long-term goal of SafeGuard is to make insurance claims support faster and easier for customers while reducing repetitive work for support teams.

The product focuses on one simple principle:

> **Let AI handle routine claims conversations and actions, while keeping humans in control of complex cases.**

---

## 21. Evidence Integrity

### Why it exists

A claims record is only useful to a regulator or an adjuster if it can be shown not to have changed since it was filed. Insurance disputes turn on what was reported and when, and a database row alone carries no proof of that.

### What the product does

When a claim is filed, its details are canonicalised into an evidence bundle and hashed with keccak256. The hash is recorded against the claim. Anyone can later re-derive it from the stored bundle and confirm the two match — a mismatch means the record was altered.

Optionally, the bundle is archived to Filecoin and its content identifier attested on Base Sepolia, placing an independent, timestamped record outside the application's own database.

The two halves have not fared equally. Chain attestation works: `/health` reports `chain_attestation.last_attempt` as `"succeeded"`, against a real Base Sepolia transaction — `0xafbb33a53da4cceef515d4860b5e272aa14f6a139940b26676f43da4a94065ac` at `3c624c4`, up from `0x7f3ef7575b978ae29d22656ff4e884a5119dfb95dc04738db2cc9266d120a532` when this line was written at `8e41be6`. The hash moves because `/health` names whichever attestation is newest, not because the older one stopped existing. Filecoin archival, by contrast, has never once succeeded in the deployed environment: every one of the ten non-simulated upload attempts on record is `failed`, `/health` reports `filecoin_uploads.last_success_at: null`, and every claim filed through the API carries `filecoin_cid: null` — the only two claims holding a CID are simulated seed rows from the demo dataset. Neither costs the guarantee this section is about: the evidence hash, which is the thing that makes tampering detectable, is recorded unconditionally, and `ClaimRegistryV2` anchors that hash whether or not the bytes were ever stored.

### User-facing behaviour

| Capability | Where |
| --- | --- |
| Verify a claim's evidence has not changed | **Verify Integrity** on the claim detail page |
| See which claims are archived and attested | **Blockchain** page |
| Attach a document and archive it as evidence | `attach_document` tool, during a call |
| File a regulatory complaint with attestation | `escalate_to_regulator` tool |

### Product principle

**Never record an outcome that did not happen.** If archival or attestation fails, the claim shows that it failed. The alternative — substituting a placeholder so the interface looks complete — produces a record that asserts evidence exists when it does not, which is worse than showing nothing. The evidence hash is always recorded, so the core guarantee survives any outage of the optional layers.

---

## 22. AI Claim Adjudication

### Why it exists

Every other use of a language model in this product is conversational: the agent
hears what a caller wants and picks a tool. Adjudication is the one place a model
is asked to *read*. It puts a policy, a claim, and the text of the documents
attached to that claim side by side and asks where they contradict each other —
a repair estimate for 12,000 sitting behind a claim for 80,000, a police report
dated three weeks after the incident, a document describing a different vehicle.
That is the work a keyword matcher cannot do, and it is the only reason there is
a model in this part of the system.

### What the product does

`POST /api/tools/adjudicate-claim` takes a claim number and nothing else — no
amount, no verdict, no instruction — and produces a **recommendation**. It is
never a decision. Nothing in that path writes `claims.status`,
`claims.approved_amount`, or anything on the payout path; the single write it
performs is one row in `adjudications`.

Nine deterministic checks run first, in code, before the model is consulted:
the policy is on file, is not cancelled, and was in force on the incident date;
the claim type is covered; an amount was stated and sits inside the coverage;
the claim has not already been decided; there is no near-duplicate claim within
seven days; and something is actually payable after the deductible. Any one of
them failing **vetoes**, and a veto returns before the model is called at all —
a claim on a lapsed policy costs nothing and depends on nothing but the dates.
Ambiguity escalates rather than denying: `deny` is reserved for matters of
record.

When the checks pass without objecting, the model is called and **its verdict is
what the recommendation carries.** The rules gate the model; they do not replace
it. That is the shipped behaviour, and it is worth stating explicitly because
the evaluation harness also contains a rules-only variant used for comparison —
that variant is harness code and is not what the product runs.

### What the model is not allowed to decide

The payable figure is computed in code, once, by the same function the
settlement path uses to disburse. The model is asked for an amount too, but its
answer is stored in a separate column purely to be compared: if the two differ
by more than a hundredth of a unit, the disagreement is recorded and the verdict
is **forced to escalate** whatever the model said. The computed figure is
deliberately withheld from the prompt, so that the comparison is a real check
rather than the model echoing our arithmetic back at us.

The consequence is that a successful prompt injection in a claimant's document
still cannot move money. It can influence what the model *reports*; it cannot
approve, pay, or alter a claim, and it cannot hide from the stored prompt.

### A human decides, on every one

The recommendation lands in the **Review Queue** page (`/review`), where an
adjuster approves or rejects it. Their answer, not the model's, is what moves
the claim: approving sets it to the one status settlement will disburse from,
rejecting denies it, and a claim already paid or closed is not moved at all
while the decision is still recorded. One decision per recommendation, enforced
by a unique constraint. The response states outright whether the human went
against the recommendation, because that is the case worth counting.

Recording a decision requires the admin token; reading the queue does not. See
section 10.

### Degradation

Everything that goes wrong escalates. A timeout, an unreachable provider, a
response that is not JSON, a verdict outside the three allowed values, or a
failure to record the row all produce `escalate` with the reason preserved. With
no `GROQ_API_KEY` configured a labelled fake answers, and its only answer is an
escalation stating that no model read anything. There is no path to a verdict
favourable to paying a claim that was not actually reached.

The full mechanism, including the prompt construction and the audit record, is
in `ARCHITECTURE.md` section 13.

---

## 23. Agent Configuration

### Why it exists

Prompt wording determines how the agent behaves on a live call, and it needs adjusting after hearing real conversations. Requiring a code change and redeploy for each edit makes that loop too slow to be useful.

### What the product does

The Agent Configuration page presents the live definition — system prompt, greeting, agent name, and the fourteen tools — and allows editing. Changes save to the database, then a separate action pushes them to the live voice agent.

### Save and publish are separate

An operator can revise the prompt repeatedly without affecting anyone currently on a call. Nothing reaches the agent until **Sync to ElevenLabs** is pressed. This matters when editing while the system is in use.

### Constraints

The API rejects configurations that would leave the agent unable to function: an empty prompt, an unknown tool name, or every tool disabled. Editing requires an admin token, and the endpoints refuse to operate when no token is configured rather than allowing unauthenticated writes.

---

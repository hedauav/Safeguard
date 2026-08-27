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
                    │ Tool Selection           │
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

The agent should:

1. Verify the relevant claim or policy information before accessing protected data.
2. Use backend tools rather than inventing claim or policy details.
3. Keep voice responses concise and easy to understand.
4. Be professional and empathetic.
5. Ask follow-up questions when required information is missing.
6. Offer human escalation when the request cannot be appropriately resolved.

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
POST /api/adjudications/:id/decision
POST /api/claims/:id/verify-integrity
POST /api/claims/:claimNumber/documents
POST /api/webhooks/elevenlabs/conversation-ended
POST /api/webhooks/razorpay
```

The backend handles application logic, database operations, tool execution, and post-call logging.

---

## 11. Frontend Dashboard

The dashboard provides visibility into the claims and AI interaction workflow.

### Main Pages

| Page                | Route         | Purpose                                                      |
| ------------------- | ------------- | ------------------------------------------------------------ |
| Claims              | `/claims`     | View and filter claims                                        |
| Claim Detail        | `/claims/:id` | View individual claim information, and verify its evidence    |
| Review Queue        | `/review`     | Decide the adjudications waiting on a human                   |
| Live Call           | `/live`       | View active conversation information                          |
| Call History        | `/calls`      | Review previous calls                                         |
| Analytics           | `/analytics`  | View call and workflow metrics                                |
| Blockchain          | `/blockchain` | See which claims are archived and attested                    |
| Agent Configuration | `/config`     | Manage supported AI agent settings                            |

### Important Components

* AI voice interaction widget
* Conversation transcript
* Tool execution information
* Claim status indicators
* Analytics cards
* Call charts
* Real-time updates

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

The two halves have not fared equally. Chain attestation works: `/health` reports `chain_attestation.last_attempt` as `"succeeded"`, against a real Base Sepolia transaction, `0x7f3ef7575b978ae29d22656ff4e884a5119dfb95dc04738db2cc9266d120a532`. Filecoin archival has never once succeeded in the deployed environment — `/health` reports `filecoin_uploads.last_success_at: null`, and live claim rows carry `filecoin_cid: null`. Neither costs the guarantee this section is about: the evidence hash, which is the thing that makes tampering detectable, is recorded unconditionally, and `ClaimRegistryV2` anchors that hash whether or not the bytes were ever stored.

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

## 22. Agent Configuration

### Why it exists

Prompt wording determines how the agent behaves on a live call, and it needs adjusting after hearing real conversations. Requiring a code change and redeploy for each edit makes that loop too slow to be useful.

### What the product does

The Agent Configuration page presents the live definition — system prompt, greeting, agent name, and the fourteen tools — and allows editing. Changes save to the database, then a separate action pushes them to the live voice agent.

### Save and publish are separate

An operator can revise the prompt repeatedly without affecting anyone currently on a call. Nothing reaches the agent until **Sync to ElevenLabs** is pressed. This matters when editing while the system is in use.

### Constraints

The API rejects configurations that would leave the agent unable to function: an empty prompt, an unknown tool name, or every tool disabled. Editing requires an admin token, and the endpoints refuse to operate when no token is configured rather than allowing unauthenticated writes.

---

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
                         │ Escalations          │
                         │ Callbacks             │
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
* Document checks
* Escalations
* Callback scheduling
* Call logging
* Analytics

### 3.4 Data Layer

Supabase provides the PostgreSQL database used by the application.

The database stores:

* Customers
* Policies
* Claims
* Call logs
* Tool executions
* Escalations
* Scheduled callbacks

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

| Tool                | Purpose                      |
| ------------------- | ---------------------------- |
| `lookup_claim`      | Retrieve an existing claim   |
| `check_policy`      | Retrieve policy information  |
| `check_documents`   | Identify missing documents   |
| `file_claim`        | Create a new claim           |
| `escalate_to_human` | Create a human escalation    |
| `schedule_callback` | Schedule a customer callback |

The backend remains responsible for validating requests and performing database operations.

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

## 11. Call Logging

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

## 12. Dashboard Data Flow

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

## 13. Post-Call Flow

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

## 14. Error Handling

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

## 15. Security Considerations

The current project is a prototype and uses demonstration data.

A production deployment would require additional controls including:

* Strong customer authentication
* Authorization before accessing claim information
* Secure API authentication
* Input validation
* Secret management
* Encryption
* Audit logging
* Data retention policies
* Role-based access control
* Production compliance review

API keys and other secrets must be stored in environment variables and must not be committed to the repository.

---

## 16. Deployment Architecture

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

## 17. Technology Summary

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
| Frontend Hosting | Vercel                            |
| Backend Hosting  | Railway                           |

---

## 18. Design Principles

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

## 19. Current Scope

The current prototype demonstrates:

* AI voice conversations
* Claim lookup
* Policy lookup
* Missing document checking
* Claim filing
* Human escalation
* Callback scheduling
* Backend tool execution
* Database integration
* Call logging
* Claims dashboard
* Analytics
* Agent configuration, editable and pushed to the live agent
* Tamper-evident claim evidence
* Optional Filecoin archival and on-chain attestation

The architecture is intentionally modular so additional insurance workflows can be added later.

---

## 20. Evidence and Attestation

Beyond recording claims in the database, SafeGuard produces tamper-evident proof that a claim's details have not been altered since it was filed.

```text
Claim filed
     │
     ▼
Canonicalise the claim into an evidence bundle
     │   (keys sorted, so the same claim always
     │    serialises to the same bytes)
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

## 21. Agent Configuration

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

Write endpoints require an admin token and fail closed: with no token configured they refuse rather than falling open. Validation rejects states that would silently disable the agent, including an empty prompt, an unknown tool name, or disabling every tool.

---

## 22. Simulation Mode

Filecoin storage requires a funded payment rail, which is not always available for demonstrations. With `SIMULATE_BLOCKCHAIN=true` and no agent wallet, the pipeline produces a real CIDv1 content address computed from the actual bundle bytes, plus a deterministic placeholder transaction hash.

Everything it writes is marked `simulated = true`, and the dashboard renders those rows without explorer links, because the referenced data was never published and the links would not resolve.

`/health` reports these features as `"simulated"` rather than `true`. Real credentials always take precedence; simulation only applies where nothing real is configured.

---

## 23. Architecture Summary

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

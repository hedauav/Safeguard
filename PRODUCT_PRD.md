# AI Insurance Claims Call Agent — Hackathon PRD

> Loops Hacker House Shanghai | April 10–23, 2026
> Team Size: 4 | Demo: Live phone call

---

## 1. Product Vision

**One-liner:** AI-powered voice agent that handles insurance claims calls end-to-end — for consumers filing claims and for insurers replacing call center agents.

**B2C (Consumer Advocate):** A policyholder calls our number (or uses browser widget), speaks naturally about their claim, and the AI looks up their policy, checks claim status, identifies missing documents, files new claims, and schedules callbacks — no hold music, no "press 1 for..."

**B2B (Call Center Replacement):** Insurance companies deploy our AI agent on their phone line. It handles 80% of routine claims inquiries autonomously, escalates complex cases to human adjusters, and logs every interaction to a real-time dashboard.

**Why ElevenLabs:** ElevenLabs Conversational AI (hackathon sponsor) handles the entire STT→LLM→TTS pipeline, VAD, interruption handling, and knowledge base RAG. We configure their platform and build the surrounding infrastructure: webhook tools, database, dashboard, and demo.

---

## 2. Market Context (China Focus for Pitch)

| Metric | Number |
|--------|--------|
| China insurance premiums (annual) | $840 billion (world's 2nd largest) |
| Claims payouts (annual) | $335 billion |
| Call center industry (China) | $78 billion, 4.4M agent seats |
| Insurance complaints growth (2025) | +368% year-over-year |
| Customer satisfaction with insurers | Only 28% |
| Call center agent turnover | 30-45% annually |
| Cost per agent in Shanghai | $27K-$38K/year fully loaded |
| Consumer AI trust in China | 68% (4th highest globally) |

**The #1 consumer complaint:** "Easy to buy, hard to claim" (投保容易, 理赔难)

**Our gap:** Nobody builds a consumer-side voice advocate that works across ALL insurers AND a platform that serves both B2B and B2C.

---

## 3. Architecture

```
PHONE PATH:
  Caller ──► Twilio ──► ElevenLabs Conversational AI
                              │ (STT + LLM + TTS all managed)
                              │
                              ├── Knowledge Base RAG (PDF upload to ElevenLabs)
                              │
                              ├── Tool call webhooks ──► Fastify on Railway
                              │                              │
                              │                         Supabase (Postgres)
                              │
                              └── Agent transfer / escalation

BROWSER PATH:
  Browser ──► ElevenLabs React SDK (WebRTC) ──► Same AI Agent
                                                      │
                                                      └──► Same Fastify ──► Same Supabase

DASHBOARD:
  React on Vercel ──► Supabase (real-time subscriptions)
                  ──► Fastify API (analytics, call history)
```

### Tech Stack

| Component | Service | Cost |
|-----------|---------|------|
| Frontend | React + Tailwind on **Vercel** | $0 |
| Backend | Fastify on **Railway** (always-on, no cold starts) | $0 ($5 credit) |
| Database + Auth | **Supabase** (Postgres) | $0 |
| Voice AI | **ElevenLabs** Conversational AI | $0-5 (sponsor) |
| Phone Calls | **Twilio** | $0 ($15 credit) |
| Fallback | WebRTC via ElevenLabs React SDK | $0 |

### What ElevenLabs Handles (We Do NOT Build)
- Speech-to-Text (Scribe)
- LLM orchestration (GPT-4o-mini or Claude)
- Text-to-Speech (Flash v2.5)
- WebSocket audio streaming
- Voice Activity Detection + interruption handling
- Knowledge base RAG
- Agent-to-agent transfer
- Twilio phone integration (native)

### What We Build
1. Backend API — 6 webhook tool endpoints + dashboard APIs
2. Database schema — 7 tables in Supabase
3. Frontend dashboard — 6 pages + WebRTC widget
4. ElevenLabs agent config — prompts, tools, knowledge base, voice
5. Seed data — realistic insurance scenarios
6. Twilio + ElevenLabs phone setup

---

## 4. Database Schema

### Table: `customers`
```sql
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT NOT NULL,
  date_of_birth DATE,
  address TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Table: `policies`
```sql
CREATE TABLE policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_number TEXT UNIQUE NOT NULL,
  customer_id UUID NOT NULL REFERENCES customers(id),
  policy_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  coverage_amount NUMERIC NOT NULL,
  deductible NUMERIC NOT NULL,
  premium_monthly NUMERIC NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled', 'pending')),
  coverage_details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Table: `claims`
```sql
CREATE TABLE claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_number TEXT UNIQUE NOT NULL,
  policy_id UUID NOT NULL REFERENCES policies(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  claim_type TEXT NOT NULL,
  status TEXT DEFAULT 'submitted' CHECK (status IN (
    'submitted', 'under_review', 'documents_needed',
    'approved', 'denied', 'paid', 'closed'
  )),
  incident_date DATE NOT NULL,
  incident_description TEXT NOT NULL,
  claimed_amount NUMERIC,
  approved_amount NUMERIC,
  assigned_adjuster TEXT,
  documents_required TEXT[],
  documents_received TEXT[],
  notes TEXT,
  filed_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### Table: `call_logs`
```sql
CREATE TABLE call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  elevenlabs_conversation_id TEXT,
  customer_id UUID REFERENCES customers(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'webrtc')),
  phone_number TEXT,
  status TEXT DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'failed')),
  duration_seconds INT,
  transcript JSONB,
  summary TEXT,
  outcome TEXT,
  tools_used TEXT[],
  recording_url TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ
);
```

### Table: `call_tool_executions`
```sql
CREATE TABLE call_tool_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_log_id UUID NOT NULL REFERENCES call_logs(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  tool_args JSONB,
  tool_result JSONB,
  success BOOLEAN DEFAULT true,
  latency_ms INT,
  executed_at TIMESTAMPTZ DEFAULT now()
);
```

### Table: `escalations`
```sql
CREATE TABLE escalations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_log_id UUID NOT NULL REFERENCES call_logs(id),
  claim_id UUID REFERENCES claims(id),
  customer_id UUID REFERENCES customers(id),
  reason TEXT NOT NULL,
  priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'resolved')),
  assigned_to TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
```

### Table: `scheduled_callbacks`
```sql
CREATE TABLE scheduled_callbacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_log_id UUID REFERENCES call_logs(id),
  customer_id UUID REFERENCES customers(id),
  phone_number TEXT NOT NULL,
  scheduled_time TIMESTAMPTZ NOT NULL,
  reason TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Indexes
```sql
CREATE INDEX idx_claims_customer ON claims(customer_id);
CREATE INDEX idx_claims_policy ON claims(policy_id);
CREATE INDEX idx_claims_number ON claims(claim_number);
CREATE INDEX idx_policies_number ON policies(policy_number);
CREATE INDEX idx_policies_customer ON policies(customer_id);
CREATE INDEX idx_call_logs_customer ON call_logs(customer_id);
CREATE INDEX idx_call_logs_conversation ON call_logs(elevenlabs_conversation_id);
CREATE INDEX idx_escalations_status ON escalations(status);
CREATE INDEX idx_callbacks_status ON scheduled_callbacks(status, scheduled_time);
```

---

## 5. Backend API (Fastify on Railway)

### Project Structure
```
backend/
  src/
    server.ts
    config/
      environment.ts
    plugins/
      supabase.ts
      cors.ts
    routes/
      webhook-tools.ts
      calls.ts
      claims.ts
      analytics.ts
    services/
      claims-service.ts
      policy-service.ts
      escalation-service.ts
      callback-service.ts
      call-log-service.ts
    types/
      index.ts
  database/
    migration.sql
    seed.sql
  package.json
  tsconfig.json
  Dockerfile
```

### Tool Endpoints (Called by ElevenLabs During Conversation)

Base URL: `https://<app>.railway.app/api/tools`

#### POST /api/tools/lookup-claim
```typescript
// Request
{ "claim_id": "CLM-2026-000456" }

// Response
{
  "found": true,
  "claim": {
    "claim_number": "CLM-2026-000456",
    "status": "under_review",
    "claim_type": "collision",
    "incident_date": "2026-03-15",
    "incident_description": "Rear-ended at intersection of 5th and Main",
    "claimed_amount": 8500,
    "assigned_adjuster": "Sarah Chen",
    "documents_required": ["police_report", "repair_estimate", "photos"],
    "documents_received": ["police_report"],
    "customer_name": "James Wilson"
  }
}
```

#### POST /api/tools/file-claim
```typescript
// Request
{
  "policy_number": "POL-2024-001234",
  "claim_type": "collision",
  "incident_date": "2026-04-10",
  "incident_description": "Tree fell on car during storm"
}

// Response
{
  "success": true,
  "claim_number": "CLM-2026-000789",
  "status": "submitted",
  "message": "Claim filed successfully. An adjuster will be assigned within 24-48 hours.",
  "next_steps": ["Upload photos of damage", "Get repair estimate", "Keep all receipts"]
}
```

#### POST /api/tools/check-policy
```typescript
// Request
{ "policy_number": "POL-2024-001234" }

// Response
{
  "found": true,
  "policy": {
    "policy_number": "POL-2024-001234",
    "policy_type": "auto",
    "provider": "SafeGuard Insurance",
    "status": "active",
    "coverage_amount": 50000,
    "deductible": 500,
    "premium_monthly": 125,
    "coverage_details": {
      "collision": true,
      "comprehensive": true,
      "liability": "100/300/100",
      "rental_car": true,
      "roadside_assistance": true
    },
    "customer_name": "James Wilson"
  }
}
```

#### POST /api/tools/check-documents
```typescript
// Request
{ "claim_id": "CLM-2026-000456" }

// Response
{
  "claim_number": "CLM-2026-000456",
  "documents_required": ["police_report", "repair_estimate", "photos"],
  "documents_received": ["police_report"],
  "documents_missing": ["repair_estimate", "photos"],
  "message": "You still need to submit a repair estimate and photos of the damage."
}
```

#### POST /api/tools/escalate-to-human
```typescript
// Request
{ "reason": "Customer disputing claim denial", "priority": "high" }

// Response
{
  "success": true,
  "reference_number": "ESC-2026-0042",
  "message": "Flagged for priority review. Someone will contact you within 2 business hours."
}
```

#### POST /api/tools/schedule-callback
```typescript
// Request
{ "phone_number": "+14155551234", "preferred_time": "tomorrow afternoon", "reason": "Follow up on claim" }

// Response
{
  "success": true,
  "scheduled_time": "2026-04-17T14:00:00Z",
  "message": "Callback scheduled for tomorrow at 2:00 PM."
}
```

### Dashboard API Endpoints

```
GET  /api/calls                              -- list call logs
GET  /api/calls/:id                          -- single call + tool executions
GET  /api/claims                             -- list claims
GET  /api/claims/:id                         -- single claim detail
GET  /api/escalations                        -- list escalations
GET  /api/analytics                          -- aggregated stats
POST /api/webhooks/elevenlabs/conversation-ended  -- post-call logging
```

---

## 6. ElevenLabs Agent Configuration

### Agent: "ClaimsBot"

**System Prompt:**
```
You are a friendly, professional insurance claims assistant. Your name is Alex.
You help policyholders check claim status, file new claims, understand their
coverage, and identify missing documents.

RULES:
- Always verify the caller by asking for their claim number or policy number first.
- Be empathetic — people calling about claims are often stressed.
- Keep responses concise (2-3 sentences max) since this is a phone conversation.
- If you can't resolve something, offer to escalate to a human agent.
- Never make up policy details or claim info — always use tools to look things up.
- If the caller asks about something outside insurance claims, politely redirect.
- After resolving the main issue, always ask "Is there anything else I can help with?"

AVAILABLE TOOLS:
- lookup_claim: Look up an existing claim by claim number
- file_claim: File a new insurance claim
- check_policy: Check policy coverage details
- check_documents: See what documents are missing for a claim
- escalate_to_human: Transfer to a human agent when needed
- schedule_callback: Book a follow-up call
```

**First Message:**
```
Hello, thank you for calling SafeGuard Insurance claims. My name is Alex.
I can help you check on a claim, file a new one, or answer questions about
your coverage. How can I help you today?
```

**Voice:** Professional, warm tone (e.g., "Rachel" or "Drew" from ElevenLabs library)

**Knowledge Base (upload to ElevenLabs):**
- `insurance_faq.pdf` — common questions about claims, deductibles, coverage
- `safeguard_policies.pdf` — fake company policy documents
- `claims_process.pdf` — step-by-step claims guide

---

## 7. Frontend Dashboard (React + Tailwind on Vercel)

### Project Structure
```
frontend/
  src/
    App.tsx
    main.tsx
    lib/
      supabase.ts
      api.ts
    pages/
      ClaimsList.tsx
      ClaimDetail.tsx
      LiveCallView.tsx
      CallHistory.tsx
      Analytics.tsx
      AgentConfig.tsx
    components/
      Layout.tsx
      Sidebar.tsx
      CallWidget.tsx
      ClaimStatusBadge.tsx
      TranscriptViewer.tsx
      ToolExecutionCard.tsx
      StatsCard.tsx
      CallChart.tsx
    hooks/
      useRealtimeCalls.ts
      useRealtimeClaims.ts
    types/
      index.ts
  tailwind.config.ts
  vite.config.ts
  package.json
```

### Pages

| Page | What It Shows |
|------|---------------|
| **ClaimsList** | Table of all claims with status filters, real-time updates |
| **ClaimDetail** | Single claim info + associated calls + documents |
| **LiveCallView** | Real-time transcript + tool execution cards during active call |
| **CallHistory** | Past calls with duration, outcome, transcript |
| **Analytics** | Stats cards + charts (calls/day, resolution rate, avg duration) |
| **AgentConfig** | System prompt editor, voice selector, tool toggles |

### Key Components

| Component | Purpose |
|-----------|---------|
| **CallWidget** | ElevenLabs React SDK — floating "Talk to AI" button for WebRTC |
| **TranscriptViewer** | Scrolling message bubbles with role labels |
| **ToolExecutionCard** | Shows tool name, args, result, latency |
| **StatsCard** | Single metric (number + label + trend arrow) |
| **CallChart** | Recharts bar/line chart for calls over time |

---

## 8. Seed Data Plan

File: `backend/database/seed.sql`

### 8 Customers
| Name | Scenario |
|------|----------|
| James Wilson | Active auto claim, missing documents (PRIMARY DEMO) |
| Maria Garcia | Home claim approved, awaiting payment |
| Robert Chen | Health claim denied, wants to escalate |
| Sarah Johnson | New auto accident, needs to file claim |
| David Kim | Life policy, checking coverage details |
| Lisa Thompson | Two claims: one closed, one active |
| Michael Brown | Auto claim, all documents submitted |
| Emily Davis | Home damage, just filed yesterday |

### 10 Policies (4 auto, 3 home, 2 health, 1 life)
### 12 Claims (2 submitted, 2 under_review, 3 documents_needed, 2 approved, 1 denied, 1 paid, 1 closed)
### 15 Historical Call Logs (mix of inbound, outbound, webrtc)
### 3 Pending Escalations
### 2 Scheduled Callbacks

---

## 9. Environment Variables

```bash
# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# ElevenLabs
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_AGENT_ID=agent_...

# Twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...

# Server
PORT=3005
NODE_ENV=production
FRONTEND_URL=https://xxx.vercel.app
```

---

## 10. Regulatory Compliance (For Pitch)

| Rule | Our Approach |
|------|-------------|
| AI disclosure | "You're speaking with an AI assistant" at call start |
| Consent (PIPL) | User initiates call or clicks "I agree" |
| Data localization | Production: Alibaba Cloud Shanghai region |
| Voice = biometric | Impact assessment, separate consent |
| New July 2026 anthropomorphic AI rule | Full compliance from day 1 |
| Shanghai FTZ | Relaxed cross-border data rules for fintech |

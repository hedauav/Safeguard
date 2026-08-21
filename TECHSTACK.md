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
* Document checking
* Claim filing
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
escalate_to_human
schedule_callback
```

Each tool represents a specific application capability.

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
| Telephony         | Twilio            | Phone connectivity              |
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

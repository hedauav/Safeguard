# SafeGuard

## AI-Powered Insurance Claims Voice Assistant

SafeGuard is an AI-powered voice assistant designed to simplify routine insurance claims support.

Instead of requiring customers to navigate menus or wait for a support representative, SafeGuard lets them interact naturally with an AI agent through a voice conversation.

The agent can check claim status, verify policy information, identify missing documents, file supported claims, schedule callbacks, and escalate complex cases to a human representative.

## Problem

Insurance customers often need to contact support for simple tasks such as:

* Checking the status of an existing claim
* Understanding policy coverage
* Finding missing claim documents
* Filing a new claim
* Requesting a callback
* Speaking with a human representative

These interactions can be repetitive and time-consuming for both customers and support teams.

SafeGuard uses conversational AI to automate these routine workflows while keeping a human escalation path for cases that require additional assistance.

## How It Works

```text
Customer
   │
   ▼
Voice Conversation
   │
   ▼
AI Claims Assistant
   │
   ├── Check Claim
   ├── Check Policy
   ├── Check Documents
   ├── File Claim
   ├── Schedule Callback
   └── Escalate to Human
            │
            ▼
       Backend APIs
            │
            ▼
      PostgreSQL Database
            │
            ▼
     Claims Dashboard
```

## Key Features

### AI Voice Agent

Customers can interact with SafeGuard using natural conversation instead of navigating traditional phone menus.

### Claim Lookup

The agent can retrieve information about an existing claim and communicate its current status.

### Policy Lookup

The system can retrieve policy information and supported coverage details.

### Document Tracking

SafeGuard can identify documents that are still required for a claim.

### Claim Filing

The AI agent can collect the required information and submit a new claim through the backend.

### Human Escalation

When the AI cannot appropriately resolve an issue, the conversation can be escalated to a human representative.

### Callback Scheduling

Customers can request a follow-up callback.

### Real-Time Dashboard

The dashboard provides visibility into claims, calls, transcripts, tool executions, and analytics.

## Architecture

SafeGuard uses a modular architecture consisting of:

* React + Tailwind frontend
* Fastify + TypeScript backend
* PostgreSQL database through Supabase
* ElevenLabs Conversational AI
* Twilio for phone connectivity
* Railway for backend deployment
* Vercel for frontend deployment

The AI agent communicates with the backend through dedicated tool endpoints. The backend handles business logic and database operations.

## AI Tool Workflows

The agent currently supports six backend workflows:

1. Claim lookup
2. Policy lookup
3. Document checking
4. Claim filing
5. Human escalation
6. Callback scheduling

This allows the AI to perform actions instead of simply generating conversational responses.

## Project Structure

```text
SafeGuard/
├── backend/
├── frontend/
├── landing/
├── contracts/
└── documentation
```

## Technology

| Layer            | Technology                            |
| ---------------- | ------------------------------------- |
| Frontend         | React, TypeScript, Tailwind CSS, Vite |
| Backend          | Node.js, TypeScript, Fastify          |
| Database         | PostgreSQL / Supabase                 |
| Voice AI         | ElevenLabs Conversational AI          |
| Telephony        | Twilio                                |
| Backend Hosting  | Railway                               |
| Frontend Hosting | Vercel                                |

## Demo

The demo shows a complete customer journey from voice interaction to backend tool execution and dashboard updates.

The demonstration covers:

1. Starting a conversation with the AI agent
2. Looking up a claim
3. Checking policy information
4. Identifying missing documents
5. Performing a supported claim workflow
6. Escalating a request when required
7. Viewing the resulting activity in the dashboard

## Important Note

SafeGuard uses third-party services and APIs including ElevenLabs, Twilio, Supabase, Railway, and Vercel. These services are used for specific infrastructure and product capabilities and are disclosed here for transparency.

## Status

SafeGuard is a working prototype demonstrating an end-to-end AI-powered insurance claims workflow.

The project is designed as a foundation that can be extended with additional insurance workflows, stronger authentication, production-grade integrations, and additional compliance and security controls.

/**
 * Canonical definition of the SafeGuard voice agent.
 *
 * This is the source of truth for the system prompt and the tool contracts.
 * The dashboard renders it, and it is what should be configured on the
 * ElevenLabs agent — keeping one definition rather than a hardcoded copy in
 * the UI that drifts from the endpoints the backend actually serves.
 */

export interface AgentToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  description: string;
}

export interface AgentToolDefinition {
  /** Tool name as the agent should call it. */
  name: string;
  description: string;
  method: 'POST';
  /** Path relative to the API base URL. */
  path: string;
  parameters: AgentToolParameter[];
}

export const SYSTEM_PROMPT = `You are Anish, a voice assistant for SafeGuard Insurance. You help policyholders with claims and policy questions over the phone.

## What you can do
- Look up an existing claim and explain its status
- Explain policy coverage, deductibles, and premiums
- Tell a caller which documents are still outstanding on a claim
- File a new claim
- Attach a document or photo to a claim
- Escalate to a human supervisor
- Escalate a formal complaint to a regulator
- Schedule a callback

## How to behave
- Never state claim or policy facts from memory. Call the matching tool and read back what it returns. If a tool reports nothing found, say so plainly rather than guessing.
- Callers are often stressed. Be brief, warm, and concrete.
- Keep turns short — this is a phone call, not a document.
- Read critical values back for confirmation: claim numbers, policy numbers, dates, and amounts.
- Ask for one piece of information at a time.
- If you are uncertain, or the caller is unhappy with the automated handling, offer a human supervisor rather than improvising.
- Never promise a claim outcome, payout amount, or approval. Those are decided by an adjuster.

## Filing a claim
Before calling file_claim you need a policy number and a description of the incident. Ask for the incident date if the caller has not given it. After filing, read back the claim number returned by the tool.`;

export const AGENT_TOOLS: AgentToolDefinition[] = [
  {
    name: 'lookup_claim',
    description: 'Retrieve an existing claim by its claim number, including status, type, amount, adjuster, and documents.',
    method: 'POST',
    path: '/api/tools/lookup-claim',
    parameters: [
      { name: 'claim_number', type: 'string', required: true, description: 'The claim number, e.g. CLM-2024-001234.' },
    ],
  },
  {
    name: 'check_policy',
    description: 'Retrieve policy details by policy number: type, provider, status, coverage amount, deductible, and premium.',
    method: 'POST',
    path: '/api/tools/check-policy',
    parameters: [
      { name: 'policy_number', type: 'string', required: true, description: 'The policy number, e.g. POL-2024-001234.' },
    ],
  },
  {
    name: 'check_documents',
    description: 'List which required documents have been received for a claim and which are still missing.',
    method: 'POST',
    path: '/api/tools/check-documents',
    parameters: [
      { name: 'claim_number', type: 'string', required: true, description: 'The claim number to check documents for.' },
    ],
  },
  {
    name: 'file_claim',
    description: 'File a new insurance claim against an active policy. Returns the new claim number.',
    method: 'POST',
    path: '/api/tools/file-claim',
    parameters: [
      { name: 'policy_number', type: 'string', required: true, description: 'The policy the claim is filed against.' },
      { name: 'incident_description', type: 'string', required: true, description: "The caller's description of what happened." },
      { name: 'claim_type', type: 'string', required: false, description: 'One of: collision, windshield, theft, water_damage, fire_damage, medical, comprehensive. Defaults to auto.' },
      { name: 'incident_date', type: 'string', required: false, description: 'Date of the incident in YYYY-MM-DD form. Defaults to today.' },
    ],
  },
  {
    name: 'attach_document',
    description: 'Attach a document or photo to an existing claim and archive it as claim evidence.',
    method: 'POST',
    path: '/api/tools/attach-document',
    parameters: [
      { name: 'claim_id', type: 'string', required: true, description: 'The internal claim id returned by file_claim or lookup_claim.' },
      { name: 'file_url', type: 'string', required: true, description: 'URL of the uploaded file.' },
      { name: 'file_type', type: 'string', required: true, description: 'Document type, e.g. police_report, photos, repair_estimate.' },
    ],
  },
  {
    name: 'escalate_to_human',
    description: 'Hand the conversation to a human supervisor and record why. Returns a reference number and an SLA.',
    method: 'POST',
    path: '/api/tools/escalate-to-human',
    parameters: [
      { name: 'reason', type: 'string', required: true, description: 'Why the caller needs a human.' },
      { name: 'priority', type: 'string', required: false, description: 'One of: low, normal, high, urgent. Defaults to normal.' },
    ],
  },
  {
    name: 'schedule_callback',
    description: 'Schedule a callback for the customer at a requested time.',
    method: 'POST',
    path: '/api/tools/schedule-callback',
    parameters: [
      { name: 'phone_number', type: 'string', required: true, description: 'Number to call back.' },
      { name: 'preferred_time', type: 'string', required: true, description: 'Natural language time, e.g. "tomorrow at 2pm".' },
      { name: 'reason', type: 'string', required: false, description: 'What the callback is about.' },
    ],
  },
  {
    name: 'escalate_to_regulator',
    description: 'Record a formal regulatory complaint about a claim, attested on-chain when attestation is configured.',
    method: 'POST',
    path: '/api/tools/escalate-to-regulator',
    parameters: [
      { name: 'claim_id', type: 'string', required: true, description: 'The internal claim id the complaint concerns.' },
      { name: 'reason', type: 'string', required: true, description: 'The nature of the complaint.' },
      { name: 'priority', type: 'string', required: false, description: 'One of: low, normal, high, urgent.' },
    ],
  },
];

// Matches the greeting configured on the live ElevenLabs agent.
export const FIRST_MESSAGE =
  'Hi, this is Anish from SafeGuard Insurance claims. How can I help you today?';

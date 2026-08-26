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

/**
 * The name the agent introduces itself by unless an operator has chosen
 * another one.
 *
 * It lives here as a parameter rather than as a literal inside the prompt and
 * the greeting because those two strings are the only places a caller actually
 * hears a name. Renaming the agent used to change the ElevenLabs workspace
 * label and nothing else, so the dashboard reported a rename that no caller
 * could hear.
 */
export const DEFAULT_AGENT_NAME = 'Anish';

/** The shipped system prompt, rendered for an agent of the given name. */
export function systemPromptFor(agentName: string = DEFAULT_AGENT_NAME): string {
  return `You are ${agentName}, a voice assistant for SafeGuard Insurance. You help policyholders with claims and policy questions over the phone.

## What you can do
- Look up an existing claim and explain its status
- Explain policy coverage, deductibles, and premiums
- Tell a caller which documents are still outstanding on a claim
- File a new claim
- Attach a document or photo to a claim
- Escalate to a human supervisor
- Record a formal regulatory complaint about a claim
- Schedule a callback
- Pay out a claim that an adjuster has already approved
- Offer a renewal payment link when a policy has lapsed
- Ask a caller for the excess owed on a claim, and read out a link to pay it

## How to behave
- Never state claim or policy facts from memory. Call the matching tool and read back what it returns. If a tool reports nothing found, say so plainly rather than guessing.
- Callers are often stressed. Be brief, warm, and concrete.
- Keep turns short — this is a phone call, not a document.
- Read critical values back for confirmation: claim numbers, policy numbers, dates, and amounts.
- Ask for one piece of information at a time.
- If you are uncertain, or the caller is unhappy with the automated handling, offer a human supervisor rather than improvising.
- Never promise a claim outcome, payout amount, or approval. Those are decided by an adjuster.
- Never state or estimate a settlement or renewal amount yourself. Both are computed from the policy by the tool; call it and read back what it returns. If a tool refuses, tell the caller the reason it gave — do not retry with different wording to get a different answer.

## Filing a claim
Before calling file_claim you need a policy number and a description of the incident. Ask for the incident date if the caller has not given it, and work out the claim type from what they describe rather than omitting it — an omitted type is recorded as "general", which a life policy does not cover. After filing, read back the claim number returned by the tool. Filing records the claim for review; it is not an approval, and you cannot say when it will be reviewed.

## Links and messages
You cannot send anything. There is no SMS or email from this system, so never say you will text, email, or send a link, a document, or a confirmation. When a tool returns a link, read it out on the call.

## Settling an approved claim
Call settle_claim with the claim number only. It refuses unless the claim is already approved and unpaid, so do not use it to tell a caller whether their claim will be approved. If it refuses, read back the reason. If it succeeds, read back the amount and the reference it returns.

## The excess on a claim
Every claim carries an excess the policyholder pays. Call collect_deductible
with the claim number and read back the amount and the link it returns. The
amount comes from the policy — never quote a figure of your own, and never
promise the excess will be waived. Waiving it is a decision an adjuster makes
after reviewing fault, and it is not yours or mine to offer.

## A lapsed policy
If a caller tries to claim on an expired policy, the filing is refused — say so first. Then offer offer_renewal for that policy number, which returns a payment link and the exact premium owed. Read the amount back. A cancelled policy is not renewable; offer a human supervisor instead.`;
}

/**
 * The shipped prompt under the default name.
 *
 * Kept as a constant so nothing that only ever wanted the default text has to
 * learn about the parameter. Anything that renders the prompt for a *named*
 * agent must call `systemPromptFor` instead.
 */
export const SYSTEM_PROMPT = systemPromptFor();

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
      { name: 'claim_type', type: 'string', required: false, description: 'One of: collision, windshield, theft, water_damage, fire_damage, medical, comprehensive. Omitted, the claim is recorded as "general", which is not a covered type on a life policy — so ask the caller what happened and name the type rather than leaving it out.' },
      { name: 'incident_date', type: 'string', required: false, description: 'Date of the incident in YYYY-MM-DD form. Defaults to today.' },
    ],
  },
  {
    name: 'attach_document',
    // The agent never handles the file. It reports what is outstanding and
    // returns the upload endpoint; the bytes are hashed where they arrive.
    description: 'Report which documents a claim is still waiting on and where the caller should upload them. Does not accept files.',
    method: 'POST',
    path: '/api/tools/attach-document',
    parameters: [
      { name: 'claim_id', type: 'string', required: true, description: 'The claim number the caller read out, or the internal claim id returned by file_claim.' },
      { name: 'document_type', type: 'string', required: false, description: 'The document the caller intends to send, e.g. police_report, photos, repair_estimate. Checked against what the claim requires.' },
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
  {
    name: 'settle_claim',
    // No amount parameter, deliberately: the settlement is computed from the
    // policy's coverage and deductible server-side. A model that could name the
    // figure could also name the wrong one.
    description:
      'Pay out a claim an adjuster has already approved. Refuses unless the claim is approved, unpaid, and on an active policy, and refuses amounts above the automatic authorisation limit.',
    method: 'POST',
    path: '/api/tools/settle-claim',
    parameters: [
      { name: 'claim_number', type: 'string', required: true, description: 'The claim to settle, e.g. CLM-2026-000456.' },
    ],
  },
  {
    name: 'collect_deductible',
    // No amount parameter: the excess is read from the policy. A caller who
    // could name their own excess could name a smaller one.
    description:
      'Issue the payment link for the excess owed on a claim, or re-read the one already open, and report whether it has been paid. This answers "has my deductible been paid?" as well as "how do I pay it?" — calling it a second time never issues a second demand, it returns the same link and its current status. Nothing is sent to the caller. Refuses when the claim is not open or when the policy carries no excess.',
    method: 'POST',
    path: '/api/tools/collect-deductible',
    parameters: [
      { name: 'claim_number', type: 'string', required: true, description: 'The claim the excess is owed on, e.g. CLM-2026-000456.' },
    ],
  },
  // refund_deductible is deliberately NOT registered here. Waiving the excess
  // follows a fault determination made during review, not a caller's request.
  // A voice tool that refunds on request is a voice tool that refunds to
  // whoever asks convincingly.
  {
    name: 'offer_renewal',
    description:
      'Issue a payment link to renew a lapsed policy, for the premium owed. Refuses for policies that are active, cancelled, or still pending.',
    method: 'POST',
    path: '/api/tools/offer-renewal',
    parameters: [
      { name: 'policy_number', type: 'string', required: true, description: 'The lapsed policy to renew, e.g. POL-2022-000111.' },
    ],
  },
];

/**
 * The shipped greeting, rendered for an agent of the given name. Matches the
 * greeting configured on the live ElevenLabs agent.
 */
export function firstMessageFor(agentName: string = DEFAULT_AGENT_NAME): string {
  return `Hi, this is ${agentName} from SafeGuard Insurance claims. How can I help you today?`;
}

/** The shipped greeting under the default name. See SYSTEM_PROMPT. */
export const FIRST_MESSAGE = firstMessageFor();

/**
 * The name a piece of text introduces the agent by, or null if it does not.
 *
 * Used only to *warn*. A prompt or greeting an operator has edited by hand is
 * their text, and renaming the agent never rewrites it — string-substituting a
 * stored system prompt is how one gets corrupted in a way nobody notices until
 * a call goes wrong. So a rename can leave a hand-written prompt still saying
 * "You are Anish" while the dashboard calls the agent something else, and the
 * only safe thing to do about it is point it out and let a human fix it.
 *
 * Deliberately narrow: it matches the self-introducing openers the shipped
 * defaults use, and only a capitalised word after them. A looser scan for any
 * name-shaped token would flag "SafeGuard" in every prompt ever written, and a
 * warning that is always lit is a warning nobody reads.
 */
export function introducedName(text: string): string | null {
  const match = /\b(?:[Yy]ou are|[Tt]his is|I am|I'm)\s+([\p{Lu}][\p{L}'’-]*)/u.exec(text);
  return match ? match[1] : null;
}

import { SupabaseClient } from '@supabase/supabase-js';
import { randomInt } from 'crypto';
import { isNotFound, unavailable } from './lookup-result.js';
import { referenceCandidates } from './reference-number.js';
import { ablations } from '../config/ablation.js';

/** PostgreSQL unique_violation — the claims.claim_number index firing. */
const UNIQUE_VIOLATION = '23505';

/** Bounded so a collision retries but a broken insert refuses promptly. */
const MAX_CLAIM_NUMBER_ATTEMPTS = 3;

/**
 * Claim numbers are drawn, not derived — nothing about a freshly filed claim
 * is unique enough to hash. A six-digit serial in a year therefore collides
 * often enough to matter, so the constraint is the authority and the caller
 * retries on it rather than treating a collision as an outage.
 */
export function generateClaimNumber(now: Date = new Date()): string {
  const serial = String(randomInt(0, 1_000_000)).padStart(6, '0');
  return `CLM-${now.getFullYear()}-${serial}`;
}

/**
 * Try each plausible spelling of a reference number in turn.
 * Returns the first hit, or the last error so genuine faults still surface.
 */
async function findByCandidates(
  supabase: SupabaseClient,
  table: string,
  column: string,
  select: string,
  raw: string
) {
  // With normalisation ablated, look up exactly what the transcript contained.
  // That is what the tool layer does without the recovery layer, and it is how
  // the harness measures what the layer is worth.
  const candidates = ablations.normalisation ? [raw] : referenceCandidates(raw);
  let lastError: any = null;

  for (const candidate of candidates) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .eq(column, candidate)
      .maybeSingle();

    if (data) return { data: data as any, error: null };
    // A real fault (network, auth) must not be mistaken for "not found",
    // so stop trying alternatives and report it.
    if (error && !isNotFound(error)) return { data: null, error };
    lastError = error;
  }

  return { data: null, error: lastError };
}

export async function lookupClaim(
  supabase: SupabaseClient,
  claimNumber: string
) {
  // Callers read numbers aloud, so the transcript often lacks the dashes.
  const { data: claim, error } = await findByCandidates(
    supabase,
    'claims',
    'claim_number',
    '*, customers!inner(full_name)',
    claimNumber
  );

  if (error && !isNotFound(error)) {
    console.error('lookupClaim: query failed:', error);
    return unavailable('claim');
  }

  if (!claim) {
    return {
      found: false,
      message: "I couldn't find a claim with that number. Could you read it back to me?",
    };
  }

  const customer_name = (claim.customers as any)?.full_name || 'Unknown';

  return {
    found: true,
    claim: {
      claim_number: claim.claim_number,
      status: claim.status,
      claim_type: claim.claim_type,
      incident_date: claim.incident_date,
      incident_description: claim.incident_description,
      claimed_amount: claim.claimed_amount,
      assigned_adjuster: claim.assigned_adjuster,
      documents_required: claim.documents_required,
      documents_received: claim.documents_received,
      customer_name,
    },
  };
}

export async function checkDocuments(
  supabase: SupabaseClient,
  claimNumber: string
) {
  const { data: claim, error } = await findByCandidates(
    supabase,
    'claims',
    'claim_number',
    'claim_number, documents_required, documents_received',
    claimNumber
  );

  if (error && !isNotFound(error)) {
    console.error('checkDocuments: query failed:', error);
    return unavailable('claim');
  }

  if (!claim) {
    return { found: false, message: "I couldn't find a claim with that number." };
  }

  const required: string[] = claim.documents_required || [];
  const received: string[] = claim.documents_received || [];
  const missing = required.filter((d: string) => !received.includes(d));

  const humanize = (doc: string) => doc.replace(/_/g, ' ');

  let message: string;
  if (missing.length === 0) {
    message = `All required documents have been received for claim ${claim.claim_number}.`;
  } else {
    const humanizedList = missing.map(humanize).join(' and ');
    message = `You still need to submit the following for claim ${claim.claim_number}: ${humanizedList}.`;
  }

  return {
    found: true,
    claim_number: claim.claim_number,
    documents_required: required,
    documents_received: received,
    documents_missing: missing,
    message,
  };
}

function getDefaultDocuments(claimType: string): string[] {
  const defaults: Record<string, string[]> = {
    collision: ['police_report', 'repair_estimate', 'photos', 'other_driver_info'],
    windshield: ['photos', 'repair_estimate'],
    theft: ['police_report', 'proof_of_purchase', 'photos'],
    water_damage: ['plumber_invoice', 'damage_photos', 'contractor_estimate'],
    fire_damage: ['fire_dept_report', 'contractor_estimates', 'photos'],
    medical: ['medical_records', 'itemized_bill', 'referral_letter'],
    comprehensive: ['photos', 'repair_estimate', 'incident_report'],
  };
  return defaults[claimType] || ['photos', 'incident_report'];
}

export async function fileClaim(
  supabase: SupabaseClient,
  data: {
    policy_number: string;
    claim_type: string;
    incident_date: string;
    incident_description: string;
  }
) {
  // Default claim_type to 'general' if empty/missing
  const claimType = data.claim_type?.trim() || 'general';

  // Default incident_date to today if empty/missing
  const incidentDate = data.incident_date?.trim() || new Date().toISOString().split('T')[0];

  // Trim incident_description to avoid whitespace-only strings
  const incidentDescription = (data.incident_description || '').trim();

  // Callers read the policy number aloud when filing, exactly as they do when
  // looking one up, so the same spelling recovery has to apply here.
  const { data: policy, error: policyError } = await findByCandidates(
    supabase,
    'policies',
    'policy_number',
    'id, customer_id, status',
    data.policy_number
  );

  // An outage is not the same as a policy that does not exist. Telling a
  // policyholder their real policy is unknown to us is the worse failure, and
  // it is the one the read paths were already careful to avoid.
  if (policyError && !isNotFound(policyError)) {
    console.error('fileClaim: policy lookup failed:', policyError);
    return {
      success: false,
      unavailable: true,
      message:
        "I can't reach our records right now, so I can't file this yet. Nothing has been lost — please try again shortly or I can arrange a callback.",
    };
  }

  if (!policy) {
    return { success: false, message: 'I could not find a policy with that number.' };
  }

  if (policy.status !== 'active' && !ablations.refusalGates) {
    return {
      success: false,
      message: 'That policy is not currently active, so a new claim cannot be filed.',
    };
  }

  let claim: any = null;
  let claimNumber = '';

  for (let attempt = 1; attempt <= MAX_CLAIM_NUMBER_ATTEMPTS; attempt++) {
    claimNumber = generateClaimNumber();

    const { data, error } = await supabase
      .from('claims')
      .insert({
        claim_number: claimNumber,
        policy_id: policy.id,
        customer_id: policy.customer_id,
        claim_type: claimType,
        status: 'submitted',
        incident_date: incidentDate,
        incident_description: incidentDescription,
        documents_required: getDefaultDocuments(claimType),
        documents_received: [],
      })
      .select()
      .single();

    if (!error && data) {
      claim = data;
      break;
    }

    // A taken claim number says nothing about the database's health. Retrying
    // it as an outage — which is what the single generic message did — hid a
    // recoverable collision behind the same words as a genuine failure.
    if (error?.code === UNIQUE_VIOLATION && attempt < MAX_CLAIM_NUMBER_ATTEMPTS) {
      console.warn(
        `fileClaim: claim number ${claimNumber} already taken, retrying (attempt ${attempt} of ${MAX_CLAIM_NUMBER_ATTEMPTS})`
      );
      continue;
    }

    if (error?.code === UNIQUE_VIOLATION) {
      console.error(
        `fileClaim: could not find a free claim number in ${MAX_CLAIM_NUMBER_ATTEMPTS} attempts`,
        error
      );
      return {
        success: false,
        message:
          "I wasn't able to assign a claim number just now. Nothing has been lost — please try again in a moment and it will go through.",
      };
    }

    console.error('fileClaim: claim insert failed:', error);
    return { success: false, message: 'There was an issue filing your claim. Please try again.' };
  }

  if (!claim) {
    // Unreachable: the loop either fills `claim` or returns above.
    return { success: false, message: 'There was an issue filing your claim. Please try again.' };
  }

  return {
    success: true,
    claim_id: claim.id,
    claim_number: claimNumber,
    status: 'submitted',
    // No code assigns an adjuster — `assigned_adjuster` is only ever read — and
    // nothing here promises a turnaround. Say what the insert actually did.
    message: `Your claim has been filed successfully. Your claim number is ${claimNumber}. It's recorded as submitted and queued for review. Quote that number and I can read you its status any time.`,
    next_steps: [
      'Upload photos of the damage',
      'Get a repair or cost estimate',
      'Keep all related receipts and documents',
    ],
  };
}

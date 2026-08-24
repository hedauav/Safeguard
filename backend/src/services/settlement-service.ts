import { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { isNotFound } from './lookup-result.js';
import { referenceCandidates } from './reference-number.js';
import type { Payout, PayoutProvider, PayoutStatus } from './payout-provider.js';

/**
 * Claim settlement.
 *
 * The amount is never an input. It is derived from the claim and the policy on
 * the server, because the only caller is a language model on a phone line and
 * a figure it could name is a figure it could be talked into naming. The tool
 * takes a claim number; everything else is computed and gated here.
 */

/**
 * Largest settlement releasable without a human. Above it the claim is refused
 * and routed for authorisation — an automated caller should not be able to
 * move an unbounded amount of money, however correct the arithmetic is.
 */
export const DEFAULT_SETTLEMENT_AUTO_APPROVE_LIMIT = 50_000;

/** Why a settlement was refused. Distinct per gate so callers can branch. */
export type SettlementRefusalReason =
  | 'claim_not_found'
  | 'records_unavailable'
  | 'claim_not_approved'
  | 'already_paid'
  | 'policy_not_active'
  | 'nothing_payable'
  | 'above_auto_approve_limit'
  | 'payout_failed'
  | 'settlement_not_recorded';

export interface SettlementRefused {
  success: false;
  reason: SettlementRefusalReason;
  /** Always null on a refusal: no refusal path may hand back a payment id. */
  payout_id: null;
  claim_number: string | null;
  /** Present when the refusal happened after the amount was worked out. */
  settlement_amount: number | null;
  message: string;
}

export interface SettlementPaid {
  success: true;
  reason: null;
  claim_number: string;
  payout_id: string;
  payout_status: PayoutStatus;
  settlement_amount: number;
  utr: string | null;
  /** Mirrors Payout.simulated — never presented as a real disbursement. */
  simulated: boolean;
  message: string;
}

export type SettlementResult = SettlementPaid | SettlementRefused;

export interface SettleClaimOptions {
  autoApproveLimit?: number;
}

/**
 * Postgres NUMERIC arrives over PostgREST as a string, so arithmetic on the
 * raw column silently concatenates. Everything monetary goes through here.
 */
function toAmount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function toCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The settlement rule: the claim is capped at the policy's coverage, the
 * deductible comes off, and the result never goes negative.
 */
export function computeSettlement(input: {
  claimedAmount: unknown;
  coverageAmount: unknown;
  deductible: unknown;
}): number {
  const payable =
    Math.min(toAmount(input.claimedAmount), toAmount(input.coverageAmount)) -
    toAmount(input.deductible);
  return payable > 0 ? toCurrency(payable) : 0;
}

/**
 * Idempotency key for a claim's settlement.
 *
 * Derived from the stored claim number alone, so a retried tool call, a
 * redelivered webhook, and a fresh attempt tomorrow all produce the same key
 * and the provider sees one payout rather than three.
 */
export function settlementIdempotencyKey(claimNumber: string): string {
  const digest = createHash('sha256')
    .update(`safeguard:settlement:v1:${claimNumber}`)
    .digest('hex');
  return `stl_${digest.slice(0, 32)}`;
}

function refuse(
  reason: SettlementRefusalReason,
  message: string,
  claimNumber: string | null = null,
  settlementAmount: number | null = null
): SettlementRefused {
  return {
    success: false,
    reason,
    payout_id: null,
    claim_number: claimNumber,
    settlement_amount: settlementAmount,
    message,
  };
}

/** Statuses other than 'approved' and 'paid', phrased for a caller on the phone. */
const STATUS_EXPLANATION: Record<string, string> = {
  submitted: 'still awaiting review',
  under_review: 'still with an adjuster',
  documents_needed: 'waiting on outstanding documents',
  denied: 'denied',
  closed: 'closed',
};

export async function settleClaim(
  supabase: SupabaseClient,
  provider: PayoutProvider,
  claimNumber: string,
  options: SettleClaimOptions = {}
): Promise<SettlementResult> {
  const autoApproveLimit = options.autoApproveLimit ?? DEFAULT_SETTLEMENT_AUTO_APPROVE_LIMIT;

  // --- Gate 1: the claim must exist ---------------------------------------
  let claim: any = null;
  let claimError: any = null;

  // Claim numbers reach us through speech-to-text, usually without the dashes.
  for (const candidate of referenceCandidates(claimNumber)) {
    const attempt = await supabase
      .from('claims')
      .select('id, claim_number, status, claimed_amount, policy_id, payout_id')
      .eq('claim_number', candidate)
      .maybeSingle();
    if (attempt.data) { claim = attempt.data; claimError = null; break; }
    if (attempt.error && !isNotFound(attempt.error)) { claimError = attempt.error; break; }
    claimError = attempt.error;
  }

  if (claimError && !isNotFound(claimError)) {
    console.error('settleClaim: claim lookup failed:', claimError);
    return refuse(
      'records_unavailable',
      "I'm having trouble reaching our claim records right now, so I can't release a payment. Let me connect you with a representative."
    );
  }

  if (!claim) {
    return refuse(
      'claim_not_found',
      "I couldn't find a claim with that number, so there is nothing to pay out. Could you read it back to me?"
    );
  }

  // --- Gate 2: not already settled ----------------------------------------
  // Checked before the status gate so a second attempt says "already paid"
  // rather than the misleading "not approved". payout_id is inspected too: a
  // claim carrying a payment id has been paid even if the status write was lost.
  if (claim.status === 'paid' || claim.payout_id) {
    return refuse(
      'already_paid',
      `Claim ${claim.claim_number} has already been settled, so I can't release a second payment.`,
      claim.claim_number
    );
  }

  // --- Gate 3: an adjuster must have approved it --------------------------
  if (claim.status !== 'approved') {
    const explanation = STATUS_EXPLANATION[claim.status] ?? `in ${claim.status} status`;
    return refuse(
      'claim_not_approved',
      `Claim ${claim.claim_number} is ${explanation}, so no payment can be released yet.`,
      claim.claim_number
    );
  }

  // --- Gate 4: the policy must be active ----------------------------------
  const { data: policy, error: policyError } = await supabase
    .from('policies')
    .select('policy_number, status, coverage_amount, deductible')
    .eq('id', claim.policy_id)
    .maybeSingle();

  if (policyError && !isNotFound(policyError)) {
    console.error('settleClaim: policy lookup failed:', policyError);
    return refuse(
      'records_unavailable',
      "I'm having trouble reaching our policy records right now, so I can't release a payment.",
      claim.claim_number
    );
  }

  // A missing policy row is not an active policy, and guessing in the paying
  // direction is the expensive way to be wrong.
  if (!policy || policy.status !== 'active') {
    return refuse(
      'policy_not_active',
      `The policy behind claim ${claim.claim_number} is not currently active, so I can't release a payment against it.`,
      claim.claim_number
    );
  }

  // --- Gate 5: there must be something to pay -----------------------------
  const settlement = computeSettlement({
    claimedAmount: claim.claimed_amount,
    coverageAmount: policy.coverage_amount,
    deductible: policy.deductible,
  });

  if (settlement <= 0) {
    return refuse(
      'nothing_payable',
      `Once the deductible is applied there is nothing payable on claim ${claim.claim_number}.`,
      claim.claim_number,
      settlement
    );
  }

  // --- Gate 6: within the automated ceiling -------------------------------
  if (settlement > autoApproveLimit) {
    return refuse(
      'above_auto_approve_limit',
      `The settlement on claim ${claim.claim_number} is above what I can release on my own. It needs authorisation from a claims manager, and I'll pass it on now.`,
      claim.claim_number,
      settlement
    );
  }

  // --- Disburse ------------------------------------------------------------
  const idempotencyKey = settlementIdempotencyKey(claim.claim_number);

  let payout: Payout;
  try {
    payout = await provider.createPayout({
      amountPaise: Math.round(settlement * 100),
      currency: 'INR',
      mode: 'IMPS',
      purpose: 'payout',
      idempotencyKey,
      referenceId: claim.claim_number,
      narration: `SafeGuard claim ${claim.claim_number}`,
    });
  } catch (error) {
    console.error('settleClaim: payout provider threw:', error);
    return refuse(
      'payout_failed',
      `I wasn't able to release the payment on claim ${claim.claim_number}. The claim is unchanged and we can try again.`,
      claim.claim_number,
      settlement
    );
  }

  if (payout.status === 'failed' || payout.status === 'reversed') {
    // The claim stays approved. A transfer that did not land must never be
    // recorded as paid, or the retry would hit the already-paid gate instead.
    return refuse(
      'payout_failed',
      `The payment on claim ${claim.claim_number} did not go through. The claim remains approved and we can try again.`,
      claim.claim_number,
      settlement
    );
  }

  const { error: updateError } = await supabase
    .from('claims')
    .update({
      status: 'paid',
      approved_amount: settlement,
      payout_provider: provider.name,
      payout_id: payout.id,
      payout_status: payout.status,
      payout_amount: settlement,
      payout_utr: payout.utr,
      payout_simulated: payout.simulated,
      paid_at: payout.createdAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', claim.id);

  if (updateError) {
    // The payout exists but the claim does not say so. Reporting success would
    // bury a reconciliation job; reporting failure is safe because the
    // idempotency key means a retry returns this payout, not a second one.
    console.error(
      `settleClaim: payout ${payout.id} succeeded but claim ${claim.claim_number} was not updated:`,
      updateError
    );
    return refuse(
      'settlement_not_recorded',
      `The payment on claim ${claim.claim_number} went through, but I couldn't update the claim record. I'm passing this to a representative to confirm.`,
      claim.claim_number,
      settlement
    );
  }

  return {
    success: true,
    reason: null,
    claim_number: claim.claim_number,
    payout_id: payout.id,
    payout_status: payout.status,
    settlement_amount: settlement,
    utr: payout.utr,
    simulated: payout.simulated,
    message: `Claim ${claim.claim_number} has been settled for ${settlement.toFixed(2)}. The reference for the transfer is ${payout.utr ?? payout.id}.`,
  };
}

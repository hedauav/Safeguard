import { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { isNotFound } from './lookup-result.js';
import { recordJourneyEvent } from './journey-events-service.js';
import { referenceCandidates } from './reference-number.js';
import {
  SETTLEMENT_STAND_IN_DISCLOSURE,
  faultWaivesDeductible,
  refundDeductible,
  type DeductibleRefundResult,
} from './deductible-service.js';
import type { Payout, PayoutProvider, PayoutStatus } from './payout-provider.js';
import type { PaymentRailProvider } from './payment-link-provider.js';

/**
 * Claim settlement.
 *
 * The amount is never an input. It is derived from the claim and the policy on
 * the server, because the only caller is a language model on a phone line and
 * a figure it could name is a figure it could be talked into naming. The tool
 * takes a claim number; everything else is computed and gated here.
 *
 * THE PAYOUT HERE IS SIMULATED, AND EVERY SURFACE MUST SAY SO. Payouts need
 * RazorpayX and business KYC, which this account does not have, so
 * `SimulatedPayoutProvider` issues a `pout_sim_` id and a `SIMUTR` reference
 * and no money leaves anywhere. `/health` has always reported this honestly.
 * The sentence read out to a caller did not: it named the simulated reference
 * as "the reference for the transfer", which is the one place the omission
 * could actually mislead a person. It now discloses the simulation in the same
 * breath as the amount, and `simulated_disclosure` carries the same words in a
 * field for anything reading the result as JSON.
 *
 * The real money on a settled claim, where there is any, is the deductible
 * refund — see deductible-service.ts. When a rail is supplied and the reviewer
 * recorded the other party at fault, it is attempted here, immediately after
 * the claim is recorded as paid, and reported as standing in for the payout.
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
  /**
   * The line above in words, for anything that renders this result without
   * re-deriving what a boolean means. Null when the payout was real.
   */
  simulated_disclosure: string | null;
  /**
   * The deductible refund attempted straight after this settlement, or null
   * when none was attempted — `deductible_refund_skipped` then says why.
   *
   * The full refusal shape is carried through rather than flattened to a
   * boolean, because "the refund did not happen" is not one outcome: a claim
   * that never had a deductible captured and a claim whose refund the rail
   * rejected need to be told apart by whoever is reading this.
   */
  deductible_refund: DeductibleRefundResult | null;
  /** Why no refund was attempted at all. Null when one was. */
  deductible_refund_skipped: 'no_refund_rail' | 'fault_does_not_waive' | null;
  message: string;
}

export type SettlementResult = SettlementPaid | SettlementRefused;

export interface SettleClaimOptions {
  autoApproveLimit?: number;
  /**
   * The rail a waived deductible is refunded on, once this settlement has been
   * recorded. Omit it and no refund is attempted.
   *
   * Injected rather than constructed here, and deliberately so:
   * `config/environment.ts` imports this module for
   * DEFAULT_SETTLEMENT_AUTO_APPROVE_LIMIT, so importing the config back would
   * close an import cycle, and payment-link-provider.ts says in as many words
   * that it takes credentials as arguments to avoid exactly that. The route
   * that owns the rail passes it in.
   */
  paymentRail?: PaymentRailProvider | null;
}

/**
 * Said out loud, and in a field, wherever a simulated payout is reported.
 *
 * One constant for one claim of fact: a caller and a JSON consumer must not be
 * able to come away with different impressions of whether money moved.
 */
export const SIMULATED_PAYOUT_DISCLOSURE =
  'This settlement payout is simulated: no money has left any account and the reference is not a bank UTR. Real payouts need RazorpayX, which requires business KYC this account does not have.';

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
      // fault_determination is read here so the refund below can be decided
      // without a second lookup. It is written by a human in the review queue
      // at decision time; nothing on the agent path can set it.
      .select('id, claim_number, status, claimed_amount, policy_id, payout_id, fault_determination')
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

  const reference = payout.utr ?? payout.id;

  await recordJourneyEvent(supabase, {
    claimId: claim.id,
    eventType: 'settled',
    actor: 'agent',
    detail: {
      claim_number: claim.claim_number,
      settlement_amount: settlement,
      payout_id: payout.id,
      payout_status: payout.status,
      utr: payout.utr,
      // On the timeline as on the phone: a simulated transfer that renders
      // identically to a real one is the whole problem being fixed here.
      simulated: payout.simulated,
    },
  });

  // --- The deductible refund, where fault waives it ------------------------
  //
  // Attempted only after the claim is recorded as paid, because that is the
  // gate refundDeductible itself enforces — the waiver follows the outcome,
  // and refunding before settlement would return the excess on a claim that
  // might yet be denied. Every other gate over there is enforced over there
  // too; nothing is pre-empted or duplicated here beyond asking, with the
  // shared predicate, whether it is worth the round trip at all.
  let deductibleRefund: DeductibleRefundResult | null = null;
  let refundSkipped: 'no_refund_rail' | 'fault_does_not_waive' | null = null;

  if (!faultWaivesDeductible(claim.fault_determination)) {
    // Includes the ordinary case: nobody has recorded fault, so nothing is
    // waived. Not an error and not a warning — most claims end here.
    refundSkipped = 'fault_does_not_waive';
  } else if (!options.paymentRail) {
    refundSkipped = 'no_refund_rail';
  } else {
    // No amount is passed. refundDeductible defaults to the full captured
    // deductible and bounds it against the capture, so no figure computed on
    // this side of the call can widen what goes back out.
    deductibleRefund = await refundDeductible(
      supabase,
      options.paymentRail,
      claim.claim_number
    );
    if (!deductibleRefund.success) {
      console.error(
        `settleClaim: claim ${claim.claim_number} settled but the waived deductible was not refunded (${deductibleRefund.reason})`
      );
    }
  }

  // --- What the caller actually hears --------------------------------------
  //
  // A simulated payout said the quiet part out loud, in the same sentence as
  // the amount. Reading "the reference for the transfer is SIMUTR…" to a
  // person is the most embarrassing thing this system could be made to say,
  // and it was saying it on every settlement.
  const settledLine = `Claim ${claim.claim_number} has been settled for ${settlement.toFixed(2)}.`;
  const transferLine = payout.simulated
    ? ` I have to be straight with you about this one: that transfer is simulated, so no money has actually moved, and the reference ${reference} is a simulated reference rather than a bank UTR.`
    : ` The reference for the transfer is ${reference}.`;
  // The refund is the real money, where there is any, so it is stated after
  // the simulation is admitted rather than used to soften it.
  const refundLine =
    deductibleRefund?.success && deductibleRefund.stands_in_for_settlement
      ? ` What has genuinely moved is your deductible: ${deductibleRefund.refund_amount.toFixed(2)} has been refunded to the account you paid it from, and that refund is standing in for the settlement payout. A real insurer would keep the deductible and pay the settlement separately.`
      : deductibleRefund?.success
        ? ` The ${deductibleRefund.refund_amount.toFixed(2)} deductible has also been refunded to the account you paid it from.`
        : '';

  return {
    success: true,
    reason: null,
    claim_number: claim.claim_number,
    payout_id: payout.id,
    payout_status: payout.status,
    settlement_amount: settlement,
    utr: payout.utr,
    simulated: payout.simulated,
    simulated_disclosure: payout.simulated
      ? deductibleRefund?.success && deductibleRefund.stands_in_for_settlement
        ? `${SIMULATED_PAYOUT_DISCLOSURE} ${SETTLEMENT_STAND_IN_DISCLOSURE}`
        : SIMULATED_PAYOUT_DISCLOSURE
      : null,
    deductible_refund: deductibleRefund,
    deductible_refund_skipped: refundSkipped,
    message: `${settledLine}${transferLine}${refundLine}`,
  };
}

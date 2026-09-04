import { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { isNotFound } from './lookup-result.js';
import { recordJourneyEvent } from './journey-events-service.js';
import { referenceCandidates } from './reference-number.js';
import {
  SETTLEMENT_STAND_IN_DISCLOSURE,
  faultWaivesDeductible,
  refundDeductible,
  type DeductibleRefundRefusalReason,
  type DeductibleRefundResult,
} from './deductible-service.js';
import type { Payout, PayoutProvider, PayoutStatus } from './payout-provider.js';
import type { PaymentRailProvider } from './payment-link-provider.js';
import { toAmount, toCurrency } from './money.js';

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
   * What became of the caller's deductible on this claim, whenever there was a
   * rail to ask. Null only when no rail was supplied and the question could
   * not be put at all.
   *
   * The full refusal shape is carried through rather than flattened to a
   * boolean, because "the refund did not happen" is not one outcome: a claim
   * that never had a deductible captured and a claim whose refund the rail
   * rejected need to be told apart by whoever is reading this.
   *
   * It is populated for refusals that were never going to move money either —
   * the fault-does-not-waive case below — because a refusal is the answer to
   * "where is my deductible", and a reader of this JSON must not come away
   * with a different impression from the caller who heard `message`. Whether
   * money actually moved is `deductible_refund.success`, never the presence of
   * this field.
   */
  deductible_refund: DeductibleRefundResult | null;
  /**
   * Why no refund was performed. Null when one was.
   *
   * `fault_does_not_waive` and a populated `deductible_refund` are not a
   * contradiction: the refund was asked for and refused at a gate in
   * deductible-service.ts, which is the only thing that may classify a fault
   * finding. Nothing here duplicates that rule.
   */
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

/**
 * A refusal carries an amount only when the gate fired after one was worked
 * out, so a figure is spoken only where there genuinely is one.
 */
function spokenAmount(amount: number | null): string {
  return amount !== null && amount > 0 ? ` of ${amount.toFixed(2)}` : '';
}

/**
 * What the caller is told about their deductible, once the settlement itself
 * has been announced.
 *
 * THE RULE THIS ENFORCES, in both directions, because they are not symmetric:
 * never say or imply money is coming back when it is not, and never say or
 * imply money is gone when it is merely held. A caller who paid a deductible
 * and heard nothing at all assumed the second, which is the failure this
 * exists to stop.
 *
 * Refusal prose is reused from refundDeductible wherever it survives the
 * change of context, because two wordings for one fact is how a caller and a
 * dashboard come to disagree. It is reworded only where a sentence written for
 * "the caller asked about their refund" reads wrongly after "your claim has
 * been settled" — a defensive "I can't return it a second time" answers a
 * question nobody asked here.
 *
 * Exported so every reason's spoken output can be pinned in a test without
 * building a fixture that reaches each gate through the whole settlement path.
 */
export function deductibleOutcomeLine(refund: DeductibleRefundResult | null): string {
  // No rail, so the question was never put. Nothing is known and nothing is
  // claimed — see the `no_refund_rail` branch in settleClaim.
  if (!refund) return '';

  if (refund.success) {
    return refund.stands_in_for_settlement
      ? ` What has genuinely moved is your deductible: ${refund.refund_amount.toFixed(2)} has been refunded to the account you paid it from, and that refund is standing in for the settlement payout. A real insurer would keep the deductible and pay the settlement separately.`
      : ` The ${refund.refund_amount.toFixed(2)} deductible has also been refunded to the account you paid it from.`;
  }

  // Switched on a local rather than on `refund.reason` directly, so the
  // exhaustiveness check below still has a value to reject when a new reason
  // appears; narrowing `refund` itself leaves `never` and nothing to name.
  const reason: DeductibleRefundRefusalReason = refund.reason;

  switch (reason) {
    // --- Silence, and the only case that earns it --------------------------
    case 'no_captured_payment':
      // No deductible was ever collected on this claim, so the caller has no
      // money in question and there is no fact about theirs to report. Every
      // available wording introduces one: "your deductible could not be
      // returned" is false and alarming, and even a neutral "there is nothing
      // to refund" plants a refund the caller was not expecting and invites
      // them to wonder what happened to it. This is also the ordinary shape of
      // most settlements — a claim with no deductible captured — so speaking
      // here would put a line about money on nearly every call that has none.
      return '';

    // --- Answers about the caller's money ----------------------------------
    case 'fault_not_determined':
      // The case that prompted all of this. The money is held, a person has to
      // record fault, and the refund then follows without the caller chasing
      // it. Reassuring and true, and it must be said.
      return ` Your deductible on this claim is still held, and none of it has been lost. ${refund.message}`;

    case 'insured_at_fault':
      // A finding exists and it does not waive. The excess stands, and the
      // caller is entitled to hear that plainly rather than infer it from
      // silence — but nothing here may hint that a refund is still coming.
      return ` I should also cover the deductible you paid. ${refund.message}`;

    case 'already_refunded':
      return ` The deductible on this claim${spokenAmount(refund.refund_amount)} was refunded to the account you paid it from earlier, so it is not owed back again.`;

    case 'refund_not_recorded':
      // The refund reached the rail; only our write of it failed. The money is
      // genuinely on its way back, and saying otherwise to protect ourselves
      // would be the same lie in the opposite direction.
      return ` Your deductible${spokenAmount(refund.refund_amount)} has been returned to the account you paid it from. Our own record of that did not save, so I am passing this to a representative to confirm — the refund itself has gone through.`;

    // --- Failures of ours, which are not answers about the caller's money ---
    // One line, deliberately: to the caller these are the same event — we
    // could not finish, through no doing of theirs, and their money has not
    // moved. None of these branches reached the rail, so "nothing has moved"
    // is true of every one. It promises no refund, because on some of them the
    // eventual answer may still be that the excess stands.
    case 'claim_not_found':
    case 'records_unavailable':
    case 'claim_not_settled':
    case 'refund_exceeds_capture':
    case 'provider_mismatch':
    case 'refund_failed':
      return ` I also wasn't able to finish handling the deductible on this claim. That is a fault on our side rather than anything to do with your money — none of it has moved. I'm flagging it now so a person can pick it up with you.`;

    default: {
      // A reason added over there and not answered here would otherwise fall
      // back to silence, which is exactly the failure being fixed.
      const unanswered: never = reason;
      console.error(`deductibleOutcomeLine: unhandled refusal reason ${String(unanswered)}`);
      return ` I also wasn't able to finish handling the deductible on this claim. That is a fault on our side rather than anything to do with your money — none of it has moved. I'm flagging it now so a person can pick it up with you.`;
    }
  }
}

/**
 * The same outcome, where an operator can see it.
 *
 * Split by severity rather than logged uniformly: a deductible held pending a
 * fault determination is the system working, and burying it in `error` next to
 * a refund the rail rejected is how the ones that need somebody stop being
 * noticed. `no_captured_payment` is not logged at all — it is the ordinary
 * shape of a claim that never had a deductible.
 */
function logDeductibleOutcome(claimNumber: string, refund: DeductibleRefundResult): void {
  if (refund.success || refund.reason === 'no_captured_payment') return;

  const expected = refund.reason === 'fault_not_determined' || refund.reason === 'insured_at_fault';
  const log = expected ? console.warn : console.error;
  log(
    `settleClaim: claim ${claimNumber} settled and the deductible was not refunded (${refund.reason})`
  );
}

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
  // might yet be denied. Every gate over there is enforced over there; nothing
  // is pre-empted or duplicated here.
  //
  // WHY THE CALL IS MADE EVEN WHEN FAULT DOES NOT WAIVE. It used to be
  // short-circuited on `faultWaivesDeductible` alone, and a caller who had
  // genuinely paid a deductible was then told nothing whatsoever about it —
  // the settlement was announced, the simulation was admitted, and the money
  // they had actually parted with went unmentioned. Saying something requires
  // knowing which of several very different facts is true: nobody has recorded
  // fault and the money is held pending that, or a recorded finding leaves the
  // excess applied, or there was never a deductible on this claim at all.
  // Only refundDeductible may classify a fault finding — a second copy of that
  // rule here is how the two come to disagree — so it is asked, and its answer
  // is the answer. It cannot move money in this branch: the fault gate refuses
  // before the rail is ever touched.
  let deductibleRefund: DeductibleRefundResult | null = null;
  let refundSkipped: 'no_refund_rail' | 'fault_does_not_waive' | null = null;

  const faultWaives = faultWaivesDeductible(claim.fault_determination);

  if (!options.paymentRail) {
    // Nothing can be asked and nothing can be returned. The fault case keeps
    // precedence it has always had, so the reported reason does not move.
    refundSkipped = faultWaives ? 'no_refund_rail' : 'fault_does_not_waive';
  } else {
    // No amount is passed. refundDeductible defaults to the full captured
    // deductible and bounds it against the capture, so no figure computed on
    // this side of the call can widen what goes back out.
    deductibleRefund = await refundDeductible(
      supabase,
      options.paymentRail,
      claim.claim_number
    );

    if (!faultWaives && !deductibleRefund.success) {
      refundSkipped = 'fault_does_not_waive';
    }
    // A success here with `faultWaives` false means a reviewer recorded the
    // finding between this function's read of the claim and refundDeductible's
    // own. The refund is real and recorded; it is reported as what it is
    // rather than filed under a skip that did not happen.

    logDeductibleOutcome(claim.claim_number, deductibleRefund);
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
  // the simulation is admitted rather than used to soften it — and where there
  // is none, why there is none is stated too. See deductibleOutcomeLine.
  const refundLine = deductibleOutcomeLine(deductibleRefund);

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

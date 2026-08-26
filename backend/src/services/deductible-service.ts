import { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { isNotFound } from './lookup-result.js';
import { recordJourneyEvent } from './journey-events-service.js';
import { referenceCandidates } from './reference-number.js';
import type {
  PaymentLink,
  PaymentLinkStatus,
  PaymentRailProvider,
  Refund,
  RefundStatus,
} from './payment-link-provider.js';
import type { RazorpayCapture } from './razorpay-webhook.js';

/**
 * The deductible: real money in, and — when the claim turns out not to be the
 * policyholder's fault — real money back out.
 *
 * WHAT IS REAL AND WHAT IS NOT, because the distinction is the point:
 *
 *   REAL      Collecting the deductible. A Razorpay payment link, a real
 *             capture, recorded here from a signed webhook.
 *   REAL      Refunding the deductible. POST /v1/payments/:id/refund against
 *             that capture. The money genuinely goes back to the payer.
 *   SIMULATED Settling the claim itself. That is a payout, payouts need
 *             RazorpayX and business KYC, and this account has neither. See
 *             payout-provider.ts, which says so on every row it writes.
 *
 * WHAT THE REFUND IS, AND WHAT IT IS STANDING IN FOR.
 *
 * Waiving the deductible on a claim where another party is at fault is an
 * ordinary insurance operation in its own right: the policyholder's excess is
 * not theirs to bear when the loss was not theirs to cause, so it is returned.
 * That is what this code performs, and on a real payout rail it would be the
 * whole of it.
 *
 * This deployment has no real payout rail. When the settlement payout on a
 * claim was simulated — `claims.payout_simulated` — the deductible refund is
 * the ONLY money that has actually moved on that claim, and it is therefore
 * standing in for the settlement whether we like the arrangement or not. An
 * earlier version of this comment forbade describing it that way. That was the
 * wrong fix for the right instinct: the danger is not the description, it is a
 * description that hides it. So the refund result carries
 * `stands_in_for_settlement` and a disclosure sentence, derived from the
 * claim's own payout row rather than from whatever the caller asserts, and
 * every message built from it says plainly that a real insurer would keep the
 * deductible and pay the settlement separately.
 *
 * As everywhere else here, no amount is ever an input. The deductible comes
 * from `policies.deductible`; the refund is bounded by what was actually
 * captured. The only caller is a language model on a phone line, and a figure
 * it could name is a figure it could be talked into naming.
 */

/**
 * Largest deductible the agent may put behind a link unaided. Above it the
 * demand is refused and routed to a human — an automated caller should not be
 * able to ask an unbounded amount of money of someone, however correct the
 * arithmetic is.
 */
export const DEFAULT_DEDUCTIBLE_MAX_LINK_AMOUNT = 100_000;

/**
 * A link in one of these states is spent: it can never be paid, so a claim
 * carrying only these has no live demand and may be given a fresh one. Every
 * other state — `paid` included — counts as live, because re-issuing against
 * one would be asking for the deductible a second time.
 */
const SPENT_LINK_STATUSES = new Set<string>(['expired', 'cancelled']);

/** Claim states where there is no longer a deductible to collect. */
const CLOSED_CLAIM_STATUSES = new Set<string>(['denied', 'closed', 'paid']);

/**
 * Fault findings under which the deductible is waived. Recorded by a human in
 * the review queue at decision time; nothing on the agent path writes it.
 * `shared` is absent deliberately — a shared-fault claim keeps its deductible.
 */
const WAIVING_FAULT = new Set<string>(['other_party']);

/** Fault values that mean nobody has actually decided yet. */
const UNDETERMINED_FAULT = new Set<string>(['', 'undetermined', 'unknown', 'pending']);

/**
 * Does this fault finding waive the deductible?
 *
 * Exported because the settlement path has to ask the same question before it
 * attempts a refund, and a second copy of the rule over there is how the two
 * come to disagree about who gets their excess back. One set, one predicate,
 * asked from both sides.
 */
export function faultWaivesDeductible(fault: unknown): boolean {
  return WAIVING_FAULT.has(String(fault ?? '').trim().toLowerCase());
}

/**
 * The sentence that has to be said out loud wherever a deductible refund is
 * carrying a simulated settlement.
 *
 * Kept as one exported constant rather than reworded per call site, because a
 * disclosure that drifts between two surfaces is a disclosure a reader stops
 * trusting on either.
 */
export const SETTLEMENT_STAND_IN_DISCLOSURE =
  'The settlement payout on this claim was simulated, not actually transferred, so this refund of the deductible is the only real movement of money on it and is standing in for that payout. A real insurer would keep the deductible and pay the settlement separately.';

// --- Money ------------------------------------------------------------------

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

/** Paise as an integer, or 0 when the column is absent or unparseable. */
function toPaise(value: unknown): number {
  const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

/**
 * The deductible owed on a claim: the policy's figure, never negative and
 * never rounded into existence out of nothing.
 */
export function computeDeductible(input: { deductible: unknown }): number {
  const amount = toAmount(input.deductible);
  return amount > 0 ? toCurrency(amount) : 0;
}

// --- Deterministic references -----------------------------------------------

/**
 * Reference id for a claim's deductible link.
 *
 * Derived from the stored claim number alone, so a retried tool call and a
 * fresh attempt tomorrow produce the same id and Razorpay sees one link rather
 * than two demands. `attempt` rises only when every earlier link for the claim
 * expired or was cancelled unpaid: Razorpay rejects a repeated reference id,
 * so a genuinely new link needs a new one.
 */
export function deductibleReferenceId(claimNumber: string, attempt = 1): string {
  const suffix = attempt > 1 ? `:${attempt}` : '';
  const digest = createHash('sha256')
    .update(`safeguard:deductible:v1:${claimNumber}${suffix}`)
    .digest('hex');
  return `ded_${digest.slice(0, 32)}`;
}

/**
 * Receipt for a claim's deductible refund.
 *
 * Razorpay documents `receipt` as an idempotency key scoped to the payment: a
 * repeat is answered "Duplicate receipt found for this refund request" rather
 * than carried out. Deriving it from the claim number and the payment id means
 * a retry — ours or a redelivered webhook's — collides at the rail even if
 * every check in this file were somehow bypassed.
 */
export function deductibleRefundReceipt(claimNumber: string, paymentId: string): string {
  const digest = createHash('sha256')
    .update(`safeguard:deductible-refund:v1:${claimNumber}:${paymentId}`)
    .digest('hex');
  return `dedrf_${digest.slice(0, 26)}`;
}

// --- Collection -------------------------------------------------------------

/** Why a deductible demand was refused. Distinct per gate so callers branch. */
export type DeductibleCollectionRefusalReason =
  | 'claim_not_found'
  | 'records_unavailable'
  | 'claim_not_open'
  | 'policy_not_found'
  | 'nothing_payable'
  | 'above_link_limit'
  | 'link_failed'
  | 'deductible_not_recorded';

export interface DeductibleCollectionRefused {
  success: false;
  reason: DeductibleCollectionRefusalReason;
  /** Always null on a refusal: no refusal path may hand back a payable link. */
  payment_link_id: null;
  payment_link_url: null;
  claim_number: string | null;
  /** Present when the refusal happened after the amount was worked out. */
  deductible_amount: number | null;
  message: string;
}

export interface DeductibleCollectionOffered {
  success: true;
  reason: null;
  claim_number: string;
  policy_number: string;
  payment_link_id: string;
  payment_link_url: string;
  payment_link_status: PaymentLinkStatus;
  deductible_amount: number;
  reference_id: string;
  /** Mirrors PaymentLink.simulated — never presented as a payable link. */
  simulated: boolean;
  /** True when an existing link was returned rather than a new one created. */
  reused: boolean;
  /** True once a signed webhook has recorded a capture against this link. */
  paid: boolean;
  message: string;
}

export type DeductibleCollectionResult =
  | DeductibleCollectionOffered
  | DeductibleCollectionRefused;

export interface CollectDeductibleOptions {
  maxLinkAmount?: number;
}

function refuseCollection(
  reason: DeductibleCollectionRefusalReason,
  message: string,
  claimNumber: string | null = null,
  deductibleAmount: number | null = null
): DeductibleCollectionRefused {
  return {
    success: false,
    reason,
    payment_link_id: null,
    payment_link_url: null,
    claim_number: claimNumber,
    deductible_amount: deductibleAmount,
    message,
  };
}

const CLAIM_STATE_EXPLANATION: Record<string, string> = {
  denied: 'has been denied',
  closed: 'is closed',
  paid: 'has already been settled',
};

/** Claim lookup shared by both halves of the loop. */
async function findClaim(
  supabase: SupabaseClient,
  claimReference: string,
  columns: string
): Promise<{ claim: any | null; unavailable: boolean }> {
  let claim: any = null;
  let error: any = null;

  // Claim numbers reach us through speech-to-text, usually without the dashes.
  for (const candidate of referenceCandidates(claimReference)) {
    const attempt = await supabase
      .from('claims')
      .select(columns)
      .eq('claim_number', candidate)
      .maybeSingle();
    if (attempt.data) return { claim: attempt.data, unavailable: false };
    if (attempt.error && !isNotFound(attempt.error)) { error = attempt.error; break; }
    error = attempt.error;
  }

  if (error && !isNotFound(error)) {
    console.error('deductible: claim lookup failed:', error);
    return { claim: null, unavailable: true };
  }
  return { claim, unavailable: false };
}

function collectionMessage(
  claimNumber: string,
  amount: number,
  url: string,
  reused: boolean,
  paid: boolean
): string {
  if (paid) {
    return `The ${amount.toFixed(2)} deductible on claim ${claimNumber} has already been paid, so there's nothing further for you to pay.`;
  }
  const opening = reused
    ? `Claim ${claimNumber} already has a deductible payment link open`
    : `Claim ${claimNumber} carries a deductible under your policy`;
  // No promise about a later waiver. Refunding the excess requires a fault
  // determination that nothing in this system performs, and the refund tool is
  // deliberately not reachable from a call — so "is waived and refunded to you
  // in full" committed the company to an outcome no code here can deliver.
  return `${opening}. The amount due is ${amount.toFixed(2)}, and the link to pay it is ${url}. If an adjuster later finds the other party at fault, the excess can be refunded — that is their decision to make, not something I can promise on this call.`;
}

/**
 * Issue — or return — the payment link for a claim's deductible.
 *
 * Idempotent per claim: a second call returns the link the first one created
 * rather than a second demand for the same money.
 */
export async function collectDeductible(
  supabase: SupabaseClient,
  provider: PaymentRailProvider,
  claimReference: string,
  options: CollectDeductibleOptions = {}
): Promise<DeductibleCollectionResult> {
  const maxLinkAmount = options.maxLinkAmount ?? DEFAULT_DEDUCTIBLE_MAX_LINK_AMOUNT;

  // --- Gate 1: the claim must exist ---------------------------------------
  const { claim, unavailable } = await findClaim(
    supabase,
    claimReference,
    'id, claim_number, status, policy_id'
  );

  if (unavailable) {
    return refuseCollection(
      'records_unavailable',
      "I'm having trouble reaching our claim records right now, so I can't set up a deductible payment. Let me connect you with a representative."
    );
  }

  if (!claim) {
    return refuseCollection(
      'claim_not_found',
      "I couldn't find a claim with that number, so there's no deductible for me to collect. Could you read it back to me?"
    );
  }

  // --- Gate 2: the claim must still be open -------------------------------
  // A denied, closed or already-settled claim has no deductible left to take.
  // Demanding one anyway would be taking money for nothing.
  if (CLOSED_CLAIM_STATUSES.has(claim.status)) {
    const explanation = CLAIM_STATE_EXPLANATION[claim.status] ?? `is in ${claim.status} status`;
    return refuseCollection(
      'claim_not_open',
      `Claim ${claim.claim_number} ${explanation}, so there's no deductible to collect on it.`,
      claim.claim_number
    );
  }

  // --- Gate 3: the policy must be there to read the deductible off --------
  const { data: policy, error: policyError } = await supabase
    .from('policies')
    .select('id, policy_number, deductible')
    .eq('id', claim.policy_id)
    .maybeSingle();

  if (policyError && !isNotFound(policyError)) {
    console.error('collectDeductible: policy lookup failed:', policyError);
    return refuseCollection(
      'records_unavailable',
      "I'm having trouble reaching our policy records right now, so I can't set up a deductible payment.",
      claim.claim_number
    );
  }

  if (!policy) {
    return refuseCollection(
      'policy_not_found',
      `I couldn't find the policy behind claim ${claim.claim_number}, so I can't work out the deductible. Let me pass you to a representative.`,
      claim.claim_number
    );
  }

  // --- Gate 4: there must be a deductible to collect ----------------------
  // Straight off the policy. Not from the request body, not from the model.
  const amount = computeDeductible({ deductible: policy.deductible });

  if (amount <= 0) {
    return refuseCollection(
      'nothing_payable',
      `There's no deductible on the policy behind claim ${claim.claim_number}, so there's nothing for you to pay.`,
      claim.claim_number,
      amount
    );
  }

  // --- Gate 5: within the ceiling for an unattended demand ----------------
  if (amount > maxLinkAmount) {
    return refuseCollection(
      'above_link_limit',
      `The deductible on claim ${claim.claim_number} is above what I can take payment for on my own. It needs to go through a representative, and I'll pass it on now.`,
      claim.claim_number,
      amount
    );
  }

  // --- Idempotency: reuse a live link rather than issue a second demand ---
  const { data: existingRows, error: existingError } = await supabase
    .from('deductible_payments')
    .select(
      'payment_link_id, short_url, amount_paise, status, reference_id, simulated, payment_id, captured_amount_paise'
    )
    .eq('claim_id', claim.id);

  if (existingError && !isNotFound(existingError)) {
    console.error('collectDeductible: deductible lookup failed:', existingError);
    return refuseCollection(
      'records_unavailable',
      "I'm having trouble reaching our payment records right now, so I can't set up a deductible payment. Let me connect you with a representative.",
      claim.claim_number,
      amount
    );
  }

  const priorLinks: any[] = existingRows ?? [];
  const live = priorLinks.find((row) => !SPENT_LINK_STATUSES.has(row.status));

  if (live) {
    // Returning the link we already issued is the whole point: a second call
    // must not leave the claimant holding two demands for one deductible.
    const liveAmount = toCurrency(toPaise(live.amount_paise) / 100);
    const paid = Boolean(live.payment_id);
    return {
      success: true,
      reason: null,
      claim_number: claim.claim_number,
      policy_number: policy.policy_number,
      payment_link_id: live.payment_link_id,
      payment_link_url: live.short_url,
      payment_link_status: live.status,
      deductible_amount: liveAmount,
      reference_id: live.reference_id,
      simulated: Boolean(live.simulated),
      reused: true,
      paid,
      message: collectionMessage(claim.claim_number, liveAmount, live.short_url, true, paid),
    };
  }

  // Only reached when every prior link is spent, so the reference has to move
  // on: Razorpay treats the old one as taken.
  const referenceId = deductibleReferenceId(claim.claim_number, priorLinks.length + 1);
  const amountPaise = Math.round(amount * 100);

  let link: PaymentLink;
  try {
    link = await provider.createPaymentLink({
      amountPaise,
      currency: 'INR',
      referenceId,
      description: `SafeGuard deductible - claim ${claim.claim_number}`,
    });
  } catch (error) {
    console.error('collectDeductible: payment link provider threw:', error);
    return refuseCollection(
      'link_failed',
      `I wasn't able to set up a deductible payment for claim ${claim.claim_number}. Nothing has been charged, and we can try again.`,
      claim.claim_number,
      amount
    );
  }

  if (SPENT_LINK_STATUSES.has(link.status) || !link.shortUrl) {
    // A link nobody can pay must never be read out as one they can.
    return refuseCollection(
      'link_failed',
      `The deductible payment link for claim ${claim.claim_number} didn't come back usable. Nothing has been charged, and we can try again.`,
      claim.claim_number,
      amount
    );
  }

  const { error: insertError } = await supabase.from('deductible_payments').insert({
    claim_id: claim.id,
    policy_id: policy.id,
    provider: provider.name,
    payment_link_id: link.id,
    short_url: link.shortUrl,
    amount_paise: link.amountPaise,
    status: link.status,
    reference_id: link.referenceId,
    simulated: link.simulated,
    created_at: link.createdAt,
  });

  if (insertError) {
    // The link exists and is payable, but nothing here records it. Reading it
    // out anyway would mean a payment arriving against a deductible we hold no
    // row for — and therefore one that could never be refunded, because a
    // refund is made against a capture we have recorded.
    console.error(
      `collectDeductible: payment link ${link.id} was created but claim ${claim.claim_number} has no deductible row:`,
      insertError
    );
    return refuseCollection(
      'deductible_not_recorded',
      `I set up a deductible payment for claim ${claim.claim_number} but couldn't save it against your record. I'm passing this to a representative rather than send you a link we can't track.`,
      claim.claim_number,
      amount
    );
  }

  // Recorded only for a link that was actually created. Returning the live
  // link a previous call issued is not a second demand for the deductible, and
  // writing it down as one would put a step on the timeline that never
  // happened — the append-only table cannot take it back afterwards.
  await recordJourneyEvent(supabase, {
    claimId: claim.id,
    policyId: policy.id,
    eventType: 'deductible_requested',
    actor: 'agent',
    detail: {
      claim_number: claim.claim_number,
      deductible_amount: amount,
      payment_link_id: link.id,
      reference_id: link.referenceId,
      // Carried onto the timeline, because a simulated link on a rendered
      // journey is otherwise indistinguishable from one somebody could pay.
      simulated: link.simulated,
    },
  });

  return {
    success: true,
    reason: null,
    claim_number: claim.claim_number,
    policy_number: policy.policy_number,
    payment_link_id: link.id,
    payment_link_url: link.shortUrl,
    payment_link_status: link.status,
    deductible_amount: amount,
    reference_id: link.referenceId,
    simulated: link.simulated,
    reused: false,
    paid: false,
    message: collectionMessage(claim.claim_number, amount, link.shortUrl, false, false),
  };
}

// --- Recording a capture ----------------------------------------------------

export type CaptureRecordOutcome =
  | 'recorded'
  | 'replayed'
  | 'unknown_link'
  | 'simulated_link'
  | 'amount_mismatch'
  | 'already_captured'
  | 'write_failed';

export interface CaptureRecordResult {
  outcome: CaptureRecordOutcome;
  claim_id: string | null;
  payment_link_id: string;
  payment_id: string;
  detail: string;
}

/**
 * Record a captured deductible payment against its claim.
 *
 * Called only from the webhook route, and only after the signature has been
 * verified — an unverified delivery is a stranger telling us money arrived.
 *
 * Everything here is idempotent by construction. The ledger row keyed on
 * Razorpay's event id short-circuits a redelivery; the update is conditioned
 * on the row not already carrying a payment id; and the database holds a
 * unique index on `payment_id`, so two claims can never point at one capture
 * even if this function were bypassed entirely.
 */
export async function recordDeductibleCapture(
  supabase: SupabaseClient,
  capture: RazorpayCapture,
  ledgerId: string,
  rawEvent: unknown
): Promise<CaptureRecordResult> {
  const base = {
    claim_id: null as string | null,
    payment_link_id: capture.paymentLinkId,
    payment_id: capture.paymentId,
  };

  // --- Replay: has this exact delivery already been applied? --------------
  const { data: seen, error: seenError } = await supabase
    .from('razorpay_webhook_events')
    .select('id, event')
    .eq('id', ledgerId)
    .maybeSingle();

  if (seenError && !isNotFound(seenError)) {
    console.error('recordDeductibleCapture: event ledger read failed:', seenError);
    return { ...base, outcome: 'write_failed', detail: 'event ledger unreadable' };
  }

  if (seen) {
    return { ...base, outcome: 'replayed', detail: `event ${ledgerId} already applied` };
  }

  // --- The link must be one we issued -------------------------------------
  const { data: row, error: rowError } = await supabase
    .from('deductible_payments')
    .select('id, claim_id, amount_paise, simulated, payment_id, captured_amount_paise, status')
    .eq('payment_link_id', capture.paymentLinkId)
    .maybeSingle();

  if (rowError && !isNotFound(rowError)) {
    console.error('recordDeductibleCapture: deductible lookup failed:', rowError);
    return { ...base, outcome: 'write_failed', detail: 'deductible records unreadable' };
  }

  if (!row) {
    // Renewal links live in the same Razorpay account and produce the same
    // events. Acknowledging without recording is correct: this handler owns
    // deductibles and nothing else, and inventing a row for a link we did not
    // issue would be worse than ignoring it.
    return { ...base, outcome: 'unknown_link', detail: 'no deductible row for this payment link' };
  }

  base.claim_id = row.claim_id;

  // --- A simulated link can never have been paid --------------------------
  // Its URL resolves nowhere. A capture claiming otherwise is not a capture.
  if (row.simulated) {
    console.error(
      `recordDeductibleCapture: capture ${capture.paymentId} arrived for simulated link ${capture.paymentLinkId}`
    );
    return {
      ...base,
      outcome: 'simulated_link',
      detail: 'the link was simulated and cannot have been paid',
    };
  }

  // --- Already captured ---------------------------------------------------
  if (row.payment_id) {
    return {
      ...base,
      outcome: row.payment_id === capture.paymentId ? 'already_captured' : 'amount_mismatch',
      detail:
        row.payment_id === capture.paymentId
          ? 'this capture is already recorded'
          : `claim already carries payment ${row.payment_id}`,
    };
  }

  // --- The money that arrived must be the money we asked for --------------
  // A short payment is not a paid deductible, and recording it as one would
  // set up a refund larger than the capture behind it.
  const expected = toPaise(row.amount_paise);
  if (capture.capturedAmountPaise < expected) {
    console.error(
      `recordDeductibleCapture: capture ${capture.paymentId} was ${capture.capturedAmountPaise} paise against ${expected} demanded`
    );
    return {
      ...base,
      outcome: 'amount_mismatch',
      detail: `captured ${capture.capturedAmountPaise} paise against ${expected} demanded`,
    };
  }

  const { error: updateError } = await supabase
    .from('deductible_payments')
    .update({
      status: 'paid',
      payment_id: capture.paymentId,
      // The rail's figure, not ours. It is what a refund will be bounded by.
      captured_amount_paise: capture.capturedAmountPaise,
      captured_at: capture.createdAt,
      capture_event_id: ledgerId,
    })
    .eq('id', row.id)
    // Conditional so two deliveries racing each other cannot both apply. The
    // loser writes nothing and the ledger stops it coming back.
    .is('payment_id', null);

  if (updateError) {
    console.error('recordDeductibleCapture: capture write failed:', updateError);
    return { ...base, outcome: 'write_failed', detail: 'could not record the capture' };
  }

  // Written last, and deliberately: if the update above failed we want
  // Razorpay's retry to find no ledger row and try again. The update is
  // idempotent, so applying it twice costs nothing; losing a capture costs a
  // refund that can never be made.
  const { error: ledgerError } = await supabase.from('razorpay_webhook_events').insert({
    id: ledgerId,
    event: capture.event,
    payment_id: capture.paymentId,
    payment_link_id: capture.paymentLinkId,
    payload: rawEvent as any,
  });

  if (ledgerError) {
    // The capture is recorded, which is the part that matters. A retry will
    // hit the payment_id guard above and report already_captured.
    console.error('recordDeductibleCapture: event ledger write failed:', ledgerError);
  }

  // Actor 'provider': we did not observe this payment, Razorpay told us about
  // it. `occurredAt` is the rail's timestamp rather than ours, so a delivery
  // retried an hour later still lands on the timeline where the money did.
  await recordJourneyEvent(supabase, {
    claimId: row.claim_id,
    eventType: 'deductible_paid',
    actor: 'provider',
    occurredAt: capture.createdAt,
    detail: {
      payment_id: capture.paymentId,
      payment_link_id: capture.paymentLinkId,
      captured_amount_paise: capture.capturedAmountPaise,
      event: capture.event,
    },
  });

  return { ...base, outcome: 'recorded', detail: 'capture recorded against the claim' };
}

// --- Refund -----------------------------------------------------------------

/** Why a deductible waiver was refused. Distinct per gate so callers branch. */
export type DeductibleRefundRefusalReason =
  | 'claim_not_found'
  | 'records_unavailable'
  | 'no_captured_payment'
  | 'already_refunded'
  | 'claim_not_settled'
  | 'fault_not_determined'
  | 'insured_at_fault'
  | 'refund_exceeds_capture'
  | 'provider_mismatch'
  | 'refund_failed'
  | 'refund_not_recorded';

export interface DeductibleRefundRefused {
  success: false;
  reason: DeductibleRefundRefusalReason;
  /** Always null on a refusal: no refusal path may hand back a refund id. */
  refund_id: null;
  claim_number: string | null;
  /** Present when the refusal happened after the amount was worked out. */
  refund_amount: number | null;
  message: string;
}

export interface DeductibleRefunded {
  success: true;
  reason: null;
  claim_number: string;
  refund_id: string;
  refund_status: RefundStatus;
  refund_amount: number;
  payment_id: string;
  /** Mirrors Refund.simulated — never presented as a real refund. */
  simulated: boolean;
  /**
   * True when the claim's settlement payout was simulated, which makes this
   * refund the only real money-out on the claim and therefore the thing
   * standing in for that payout.
   *
   * Read off `claims.payout_simulated`, never off an argument. A caller that
   * could assert this could also assert its opposite, and the one direction
   * that matters is the one nobody would choose to declare.
   */
  stands_in_for_settlement: boolean;
  /**
   * The disclosure in words, so a dashboard, a JSON consumer or a log line can
   * show it without re-deriving it from the flag. Null when it does not apply.
   */
  settlement_disclosure: string | null;
  message: string;
}

export type DeductibleRefundResult = DeductibleRefunded | DeductibleRefundRefused;

export interface RefundDeductibleOptions {
  /**
   * Paise to return, for the rare partial waiver an operator authorises. Not
   * reachable from the agent tool: the route never passes it, so the only
   * figure a phone call can produce is the full captured amount. Whatever is
   * passed is still gated against the capture below.
   */
  amountPaise?: number;
}

function refuseRefund(
  reason: DeductibleRefundRefusalReason,
  message: string,
  claimNumber: string | null = null,
  refundAmount: number | null = null
): DeductibleRefundRefused {
  return {
    success: false,
    reason,
    refund_id: null,
    claim_number: claimNumber,
    refund_amount: refundAmount,
    message,
  };
}

/**
 * Waive and refund the deductible on a claim settled with the other party at
 * fault.
 *
 * This is a deductible waiver. It is not the settlement, and it does not
 * complete one: the claim's settlement is a separate movement of money on a
 * separate rail. Where that rail is simulated — which, in this deployment, is
 * everywhere — this refund is nonetheless the only real money the claimant
 * receives, and the result says so rather than leaving the reader to work it
 * out. See `stands_in_for_settlement` above.
 *
 * Idempotent: a retry returns the refund already on record and never asks the
 * rail for a second one.
 */
export async function refundDeductible(
  supabase: SupabaseClient,
  provider: PaymentRailProvider,
  claimReference: string,
  options: RefundDeductibleOptions = {}
): Promise<DeductibleRefundResult> {
  // --- Gate 1: the claim must exist ---------------------------------------
  const { claim, unavailable } = await findClaim(
    supabase,
    claimReference,
    // payout_simulated comes back too, because whether this refund is standing
    // in for the settlement is a fact about the claim's payout, not about who
    // asked for the refund.
    'id, claim_number, status, fault_determination, payout_id, payout_simulated'
  );

  if (unavailable) {
    return refuseRefund(
      'records_unavailable',
      "I'm having trouble reaching our claim records right now, so I can't process a deductible refund. Let me connect you with a representative."
    );
  }

  if (!claim) {
    return refuseRefund(
      'claim_not_found',
      "I couldn't find a claim with that number, so there's no deductible for me to refund. Could you read it back to me?"
    );
  }

  // --- Gate 2: there must be a captured deductible to give back -----------
  const { data: rows, error: rowsError } = await supabase
    .from('deductible_payments')
    .select(
      'id, provider, payment_id, captured_amount_paise, refund_id, refund_status, refund_amount_paise, simulated'
    )
    .eq('claim_id', claim.id);

  if (rowsError && !isNotFound(rowsError)) {
    console.error('refundDeductible: deductible lookup failed:', rowsError);
    return refuseRefund(
      'records_unavailable',
      "I'm having trouble reaching our payment records right now, so I can't process a deductible refund.",
      claim.claim_number
    );
  }

  const captured = (rows ?? []).find(
    (row: any) => row.payment_id && toPaise(row.captured_amount_paise) > 0
  );

  if (!captured) {
    // No capture means no refund is even possible: Razorpay refunds against a
    // payment, and there is no payment. Said plainly rather than as a failure.
    return refuseRefund(
      'no_captured_payment',
      `No deductible payment has been received on claim ${claim.claim_number}, so there's nothing to refund.`,
      claim.claim_number
    );
  }

  const capturedPaise = toPaise(captured.captured_amount_paise);

  // --- Gate 3: not already refunded ---------------------------------------
  // Checked before the settlement and fault gates so a retry says "already
  // refunded" rather than something misleading, and — more importantly — so
  // the money can never go back twice.
  if (captured.refund_id) {
    const already = toCurrency(toPaise(captured.refund_amount_paise) / 100);
    return refuseRefund(
      'already_refunded',
      `The deductible on claim ${claim.claim_number} was already refunded${already > 0 ? ` (${already.toFixed(2)})` : ''}, so I can't return it a second time.`,
      claim.claim_number,
      already > 0 ? already : null
    );
  }

  // --- Gate 4: the claim must be settled ----------------------------------
  // The waiver follows the outcome. Refunding before the claim is settled
  // would be returning the excess on a claim that might yet be denied.
  if (claim.status !== 'paid') {
    return refuseRefund(
      'claim_not_settled',
      `Claim ${claim.claim_number} hasn't been settled yet, so the deductible can't be waived. Once it's settled, if the other party is found at fault, the deductible is returned to you.`,
      claim.claim_number
    );
  }

  // --- Gate 5: somebody must have recorded who was at fault ---------------
  const fault = String(claim.fault_determination ?? '').trim().toLowerCase();

  if (!fault || UNDETERMINED_FAULT.has(fault)) {
    // Nobody has decided. Not "the other party was probably at fault" — the
    // waiver is a finding of fact, and this file does not make findings.
    return refuseRefund(
      'fault_not_determined',
      `Fault hasn't been determined on claim ${claim.claim_number} yet, so I can't waive the deductible. An adjuster records that, and the refund follows automatically once they have.`,
      claim.claim_number
    );
  }

  if (!faultWaivesDeductible(fault)) {
    // Recorded, and it does not waive: the policyholder's own fault, or shared.
    return refuseRefund(
      'insured_at_fault',
      `The fault determination on claim ${claim.claim_number} doesn't waive the deductible, so it stays applied. A representative can talk you through that finding.`,
      claim.claim_number
    );
  }

  // --- Gate 6: never more than what actually came in ----------------------
  const requestedPaise = options.amountPaise ?? capturedPaise;
  const requestedAmount = toCurrency(requestedPaise / 100);

  if (!Number.isFinite(requestedPaise) || requestedPaise <= 0) {
    return refuseRefund(
      'refund_exceeds_capture',
      `I can't work out a refund amount for claim ${claim.claim_number}, so I'm not going to guess at one. Let me pass you to a representative.`,
      claim.claim_number,
      requestedAmount
    );
  }

  if (requestedPaise > capturedPaise) {
    // Razorpay would refuse this too, but its 400 is a worse place to find out
    // than our own gate: by then the intent to over-refund has already left.
    console.error(
      `refundDeductible: refused ${requestedPaise} paise against a ${capturedPaise} paise capture on claim ${claim.claim_number}`
    );
    return refuseRefund(
      'refund_exceeds_capture',
      `The refund worked out to more than the deductible actually paid on claim ${claim.claim_number}, so I've stopped rather than return money that never came in. Let me pass you to a representative.`,
      claim.claim_number,
      requestedAmount
    );
  }

  // --- Gate 7: the rail that took the money must be the one giving it back -
  // A real capture refunded through the simulation would be recorded as
  // returned while the payer is still out of pocket; a simulated capture
  // pushed at Razorpay would be a refund of a payment it never took.
  if (captured.provider !== provider.name) {
    console.error(
      `refundDeductible: claim ${claim.claim_number} was captured on ${captured.provider} but the configured rail is ${provider.name}`
    );
    return refuseRefund(
      'provider_mismatch',
      `I can't refund the deductible on claim ${claim.claim_number} through the payment rail configured here. I'm passing this to a representative rather than record a refund that didn't happen.`,
      claim.claim_number,
      requestedAmount
    );
  }

  // --- Refund --------------------------------------------------------------
  const receipt = deductibleRefundReceipt(claim.claim_number, captured.payment_id);

  let refund: Refund;
  try {
    refund = await provider.createRefund({
      paymentId: captured.payment_id,
      amountPaise: requestedPaise,
      receipt,
      notes: {
        claim_number: claim.claim_number,
        reason: 'deductible_waived_other_party_at_fault',
      },
    });
  } catch (error) {
    console.error('refundDeductible: refund provider threw:', error);
    return refuseRefund(
      'refund_failed',
      `I wasn't able to return the deductible on claim ${claim.claim_number}. Nothing has changed, and we can try again.`,
      claim.claim_number,
      requestedAmount
    );
  }

  if (refund.status === 'failed') {
    // Nothing is recorded. A refund that did not happen must never read as one
    // that did, or the retry would hit the already-refunded gate instead.
    return refuseRefund(
      'refund_failed',
      `The refund of the deductible on claim ${claim.claim_number} didn't go through. Nothing has changed, and we can try again.`,
      claim.claim_number,
      requestedAmount
    );
  }

  const refundedAmount = toCurrency(refund.amountPaise / 100);

  const { error: updateError } = await supabase
    .from('deductible_payments')
    .update({
      refund_id: refund.id,
      refund_status: refund.status,
      refund_amount_paise: refund.amountPaise,
      refund_receipt: refund.receipt,
      refund_simulated: refund.simulated,
      refunded_at: refund.createdAt,
    })
    .eq('id', captured.id)
    // Conditional, so a concurrent retry cannot overwrite a recorded refund
    // with a second one.
    .is('refund_id', null);

  if (updateError) {
    // The refund happened but the row does not say so. Reporting success would
    // bury a reconciliation job; reporting failure is safe because the receipt
    // is deterministic, so a retry collides at Razorpay rather than refunding
    // a second time.
    console.error(
      `refundDeductible: refund ${refund.id} succeeded but claim ${claim.claim_number} was not updated:`,
      updateError
    );
    return refuseRefund(
      'refund_not_recorded',
      `The deductible on claim ${claim.claim_number} was returned, but I couldn't update the record. I'm passing this to a representative to confirm.`,
      claim.claim_number,
      refundedAmount
    );
  }

  // Whether this refund is carrying the settlement is decided here, from the
  // claim's own payout row. `payout_simulated` is written by settleClaim and
  // is true for every settlement this deployment can produce; the flag is read
  // rather than assumed so that the day a real payout rail exists, the
  // disclosure disappears on its own instead of having to be remembered.
  const standsInForSettlement = Boolean(claim.payout_simulated);

  // Actor 'system': a refund is carried out unattended once a human has
  // recorded fault. The person is on the `decided` event; this is its
  // consequence, and attributing it to them would overstate what they did.
  await recordJourneyEvent(supabase, {
    claimId: claim.id,
    eventType: 'refunded',
    actor: 'system',
    detail: {
      claim_number: claim.claim_number,
      refund_id: refund.id,
      refund_status: refund.status,
      refund_amount: refundedAmount,
      payment_id: refund.paymentId,
      fault_determination: fault,
      simulated: refund.simulated,
      stands_in_for_settlement: standsInForSettlement,
    },
  });

  return {
    success: true,
    reason: null,
    claim_number: claim.claim_number,
    refund_id: refund.id,
    refund_status: refund.status,
    refund_amount: refundedAmount,
    payment_id: refund.paymentId,
    simulated: refund.simulated,
    stands_in_for_settlement: standsInForSettlement,
    settlement_disclosure: standsInForSettlement ? SETTLEMENT_STAND_IN_DISCLOSURE : null,
    // The refund itself is real. The settlement timeline was not: five to
    // seven working days was asserted with no source, and the bank's schedule
    // is not ours to quote. And where the settlement payout was simulated, the
    // caller is told that here rather than in a field they will never read.
    message:
      `The other party was found at fault on claim ${claim.claim_number}, so the ${refundedAmount.toFixed(2)} deductible is waived. The refund has been issued to the account it was paid from; how long it takes to appear is up to your bank.` +
      (standsInForSettlement
        ? ` I should be straight with you about one thing: the settlement payment on this claim was simulated rather than actually transferred, so this refund is the only money that has really moved, and it is standing in for that payout. A real insurer would keep your deductible and pay the settlement separately.`
        : ''),
  };
}

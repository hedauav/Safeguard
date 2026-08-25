import { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { isNotFound } from './lookup-result.js';
import { referenceCandidates } from './reference-number.js';
import type {
  PaymentLink,
  PaymentLinkProvider,
  PaymentLinkStatus,
} from './payment-link-provider.js';

/**
 * Policy renewal.
 *
 * When a caller acts on a lapsed policy the claim is refused — that part is not
 * negotiable. What this adds is the one bounded thing the agent may do instead:
 * offer a payment link for the exact premium owed. The amount and the term are
 * never inputs. They are derived from the policy and from configuration on the
 * server, because the only caller is a language model on a phone line and a
 * figure it could name is a figure it could be talked into naming. The tool
 * takes a policy number; everything else is computed and gated here.
 */

/** Policy term a renewal covers, in months, when nothing else is configured. */
export const DEFAULT_RENEWAL_TERM_MONTHS = 12;

/**
 * Largest renewal the agent may put behind a link unaided. Above it the offer
 * is refused and routed to a human — an automated caller should not be able to
 * ask an unbounded amount of money of someone, however correct the arithmetic.
 */
export const DEFAULT_RENEWAL_MAX_LINK_AMOUNT = 200_000;

/** Why a renewal offer was refused. Distinct per gate so callers can branch. */
export type RenewalRefusalReason =
  | 'policy_not_found'
  | 'records_unavailable'
  | 'policy_already_active'
  | 'policy_cancelled'
  | 'policy_not_renewable'
  | 'nothing_payable'
  | 'above_link_limit'
  | 'link_failed'
  | 'renewal_not_recorded';

export interface RenewalRefused {
  success: false;
  reason: RenewalRefusalReason;
  /** Always null on a refusal: no refusal path may hand back a payable link. */
  payment_link_id: null;
  payment_link_url: null;
  policy_number: string | null;
  /** Present when the refusal happened after the amount was worked out. */
  renewal_amount: number | null;
  message: string;
}

export interface RenewalOffered {
  success: true;
  reason: null;
  policy_number: string;
  payment_link_id: string;
  payment_link_url: string;
  payment_link_status: PaymentLinkStatus;
  renewal_amount: number;
  term_months: number;
  reference_id: string;
  /** Mirrors PaymentLink.simulated — never presented as a payable link. */
  simulated: boolean;
  /** True when an existing link was returned rather than a new one created. */
  reused: boolean;
  message: string;
}

export type RenewalResult = RenewalOffered | RenewalRefused;

export interface OfferRenewalOptions {
  termMonths?: number;
  maxLinkAmount?: number;
}

/**
 * A link in one of these states is spent: it can never be paid, so a policy
 * carrying only these has no live offer and may be given a fresh one. Every
 * other state — including `paid` — counts as live, because re-issuing against
 * one would be asking for the premium a second time.
 */
const SPENT_LINK_STATUSES = new Set<string>(['expired', 'cancelled']);

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
 * The renewal rule: the monthly premium for the whole term, never negative.
 * A term of zero or a missing premium produces nothing payable rather than a
 * link for zero rupees.
 */
export function computeRenewalAmount(input: {
  premiumMonthly: unknown;
  termMonths: unknown;
}): number {
  const months = Math.floor(toAmount(input.termMonths));
  const premium = toAmount(input.premiumMonthly);
  const payable = premium * months;
  return payable > 0 ? toCurrency(payable) : 0;
}

/**
 * Reference id for a policy's renewal.
 *
 * Derived from the stored policy number alone, so a retried tool call, a
 * redelivered webhook, and a fresh attempt tomorrow all produce the same id
 * and the provider sees one link rather than three. `attempt` is only ever
 * above 1 when every earlier link for the policy expired unpaid: Razorpay
 * rejects a repeated reference id, so a genuinely new link needs a new one.
 */
export function renewalReferenceId(policyNumber: string, attempt = 1): string {
  const suffix = attempt > 1 ? `:${attempt}` : '';
  const digest = createHash('sha256')
    .update(`safeguard:renewal:v1:${policyNumber}${suffix}`)
    .digest('hex');
  return `rnw_${digest.slice(0, 32)}`;
}

function refuse(
  reason: RenewalRefusalReason,
  message: string,
  policyNumber: string | null = null,
  renewalAmount: number | null = null
): RenewalRefused {
  return {
    success: false,
    reason,
    payment_link_id: null,
    payment_link_url: null,
    policy_number: policyNumber,
    renewal_amount: renewalAmount,
    message,
  };
}

function offerMessage(policyNumber: string, amount: number, url: string, reused: boolean): string {
  const opening = reused
    ? `Policy ${policyNumber} already has a renewal payment link open`
    : `I can't act on policy ${policyNumber} while it's lapsed, but I can get it back in force`;
  // Nothing in this system writes policies.status, so a cleared payment does
  // not reinstate the policy on its own. Say what was actually done — a link
  // issued and a renewal row written — and leave reinstatement to the people
  // who perform it.
  return `${opening}. The premium due is ${amount.toFixed(2)}, and the link to pay it is ${url}. I've recorded the renewal against your policy. Paying it doesn't switch the policy back on by itself — reinstatement is confirmed separately, so please don't treat the policy as in force until you've heard that it is.`;
}

export async function offerRenewal(
  supabase: SupabaseClient,
  provider: PaymentLinkProvider,
  policyNumber: string,
  options: OfferRenewalOptions = {}
): Promise<RenewalResult> {
  const termMonths = options.termMonths ?? DEFAULT_RENEWAL_TERM_MONTHS;
  const maxLinkAmount = options.maxLinkAmount ?? DEFAULT_RENEWAL_MAX_LINK_AMOUNT;

  // --- Gate 1: the policy must exist --------------------------------------
  let policy: any = null;
  let policyError: any = null;

  // Policy numbers reach us through speech-to-text, usually without the dashes.
  for (const candidate of referenceCandidates(policyNumber)) {
    const attempt = await supabase
      .from('policies')
      .select('id, policy_number, policy_type, status, premium_monthly, end_date')
      .eq('policy_number', candidate)
      .maybeSingle();
    if (attempt.data) { policy = attempt.data; policyError = null; break; }
    if (attempt.error && !isNotFound(attempt.error)) { policyError = attempt.error; break; }
    policyError = attempt.error;
  }

  if (policyError && !isNotFound(policyError)) {
    console.error('offerRenewal: policy lookup failed:', policyError);
    return refuse(
      'records_unavailable',
      "I'm having trouble reaching our policy records right now, so I can't set up a renewal. Let me connect you with a representative."
    );
  }

  if (!policy) {
    return refuse(
      'policy_not_found',
      "I couldn't find a policy with that number, so there's nothing for me to renew. Could you read it back to me?"
    );
  }

  // --- Gate 2: there must be something to renew ---------------------------
  if (policy.status === 'active') {
    return refuse(
      'policy_already_active',
      `Policy ${policy.policy_number} is already active, so there's nothing to renew and nothing for you to pay.`,
      policy.policy_number
    );
  }

  // A cancelled policy was deliberately terminated — for non-payment, fraud, or
  // at the customer's request. Reinstating it is a decision, not a payment, so
  // no amount of money offered here may put it back in force.
  if (policy.status === 'cancelled') {
    return refuse(
      'policy_cancelled',
      `Policy ${policy.policy_number} was cancelled rather than lapsed, so it can't be reinstated by paying a premium. I'll pass you to a representative who can review it.`,
      policy.policy_number
    );
  }

  // Anything that is not 'expired' by this point — 'pending' today, whatever a
  // later migration adds — has no lapsed term to buy back.
  if (policy.status !== 'expired') {
    return refuse(
      'policy_not_renewable',
      `Policy ${policy.policy_number} isn't in a state I can renew. Let me pass you to a representative who can look at it properly.`,
      policy.policy_number
    );
  }

  // --- Gate 3: the premium must add up to something -----------------------
  const amount = computeRenewalAmount({
    premiumMonthly: policy.premium_monthly,
    termMonths,
  });

  if (amount <= 0) {
    return refuse(
      'nothing_payable',
      `I can't work out a premium for policy ${policy.policy_number}, so I won't send you a payment link. Let me pass you to a representative.`,
      policy.policy_number,
      amount
    );
  }

  // --- Gate 4: within the ceiling for an unattended offer ------------------
  if (amount > maxLinkAmount) {
    return refuse(
      'above_link_limit',
      `The renewal premium on policy ${policy.policy_number} is above what I can take payment for on my own. It needs to go through a representative, and I'll pass it on now.`,
      policy.policy_number,
      amount
    );
  }

  // --- Idempotency: reuse a live link rather than issue a second one -------
  const { data: existingRows, error: existingError } = await supabase
    .from('policy_renewals')
    .select('payment_link_id, short_url, amount_paise, status, reference_id, simulated')
    .eq('policy_id', policy.id);

  if (existingError && !isNotFound(existingError)) {
    console.error('offerRenewal: renewal lookup failed:', existingError);
    return refuse(
      'records_unavailable',
      "I'm having trouble reaching our renewal records right now, so I can't set up a payment. Let me connect you with a representative.",
      policy.policy_number,
      amount
    );
  }

  const priorLinks: any[] = existingRows ?? [];
  const live = priorLinks.find((row) => !SPENT_LINK_STATUSES.has(row.status));

  if (live) {
    // Returning the link we already sent is the whole point: a second call must
    // not leave the customer holding two demands for the same premium.
    return {
      success: true,
      reason: null,
      policy_number: policy.policy_number,
      payment_link_id: live.payment_link_id,
      payment_link_url: live.short_url,
      payment_link_status: live.status,
      renewal_amount: toCurrency(toAmount(live.amount_paise) / 100),
      term_months: termMonths,
      reference_id: live.reference_id,
      simulated: Boolean(live.simulated),
      reused: true,
      message: offerMessage(
        policy.policy_number,
        toCurrency(toAmount(live.amount_paise) / 100),
        live.short_url,
        true
      ),
    };
  }

  // Only reached when every prior link is spent, so the reference has to move
  // on: the provider treats the old one as taken.
  const referenceId = renewalReferenceId(policy.policy_number, priorLinks.length + 1);
  const amountPaise = Math.round(amount * 100);

  let link: PaymentLink;
  try {
    link = await provider.createPaymentLink({
      amountPaise,
      currency: 'INR',
      referenceId,
      description: `SafeGuard renewal - policy ${policy.policy_number} (${termMonths} months)`,
    });
  } catch (error) {
    console.error('offerRenewal: payment link provider threw:', error);
    return refuse(
      'link_failed',
      `I wasn't able to set up a payment link for policy ${policy.policy_number}. Nothing has been charged, and we can try again.`,
      policy.policy_number,
      amount
    );
  }

  if (SPENT_LINK_STATUSES.has(link.status) || !link.shortUrl) {
    // A link nobody can pay must never be read out as one they can.
    return refuse(
      'link_failed',
      `The payment link for policy ${policy.policy_number} didn't come back usable. Nothing has been charged, and we can try again.`,
      policy.policy_number,
      amount
    );
  }

  const { error: insertError } = await supabase.from('policy_renewals').insert({
    policy_id: policy.id,
    provider: provider.name,
    payment_link_id: link.id,
    short_url: link.shortUrl,
    amount_paise: link.amountPaise,
    term_months: termMonths,
    status: link.status,
    reference_id: link.referenceId,
    simulated: link.simulated,
    created_at: link.createdAt,
  });

  if (insertError) {
    // The link exists and is payable, but nothing here records it. Reading it
    // out anyway would mean a payment arriving against a renewal we have no row
    // for, so refuse and let a human reconcile the one open link.
    console.error(
      `offerRenewal: payment link ${link.id} was created but policy ${policy.policy_number} has no renewal row:`,
      insertError
    );
    return refuse(
      'renewal_not_recorded',
      `I set up a renewal for policy ${policy.policy_number} but couldn't save it against your record. I'm passing this to a representative rather than send you a link we can't track.`,
      policy.policy_number,
      amount
    );
  }

  return {
    success: true,
    reason: null,
    policy_number: policy.policy_number,
    payment_link_id: link.id,
    payment_link_url: link.shortUrl,
    payment_link_status: link.status,
    renewal_amount: amount,
    term_months: termMonths,
    reference_id: link.referenceId,
    simulated: link.simulated,
    reused: false,
    message: offerMessage(policy.policy_number, amount, link.shortUrl, false),
  };
}

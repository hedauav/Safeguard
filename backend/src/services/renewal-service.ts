import { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { isNotFound } from './lookup-result.js';
import { referenceCandidates } from './reference-number.js';
import type {
  PaymentLink,
  PaymentLinkProvider,
  PaymentLinkStatus,
} from './payment-link-provider.js';
import type { RazorpayCapture, RazorpayPaymentFailure } from './razorpay-webhook.js';
import { recordJourneyEvent } from './journey-events-service.js';

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
 * The name `SimulatedPaymentLinkProvider` reports, and the value written to
 * `policy_renewals.provider` for every row it produced.
 *
 * It is the only signal available here for "is the rail behind us real": the
 * `PaymentLinkProvider` interface exposes a name and a method, and nothing on
 * it says whether a link will be payable until one has been created. The name
 * is also what the stored row already records, so comparing the two compares
 * like with like rather than guessing the rail from the shape of a URL.
 */
const SIMULATED_PROVIDER_NAME = 'simulated';

/**
 * May a prior renewal row be handed back, rather than a new link issued?
 *
 * Two separate things disqualify a row, and conflating them is how the bug
 * this guard exists for got in.
 *
 * The first is a spent link — `SPENT_LINK_STATUSES` above. Nothing can ever be
 * paid against it, so the policy has no live offer and deserves a fresh one.
 *
 * The second is a simulated link on a policy whose rail has since become real.
 * A row written while no Razorpay credentials were configured carries a URL on
 * the reserved `.invalid` TLD: it cannot resolve, by construction, and no
 * payment can ever be made against it. That was honest when it was written. It
 * stops being honest the moment credentials land — every new link would now be
 * payable — and nothing ever moves such a row out of 'created', because the
 * expiry that would spend it arrives on a webhook from a provider that never
 * heard of the link. So the reuse path went on returning the dead URL forever,
 * and it was read out to a caller on a live call before anyone noticed.
 *
 * The reverse case is deliberately NOT symmetrical, and the asymmetry is the
 * point. A real prior link stays reusable even when the provider has since
 * fallen back to the simulation, because that link is genuinely payable and
 * the only thing available to replace it with is one that is not. Losing a
 * rail is a reason to keep the good link we already have; it is never a reason
 * to swap a payable URL for a `.invalid` one behind the customer's back.
 */
function isReusableLink(row: any, providerSimulated: boolean): boolean {
  if (SPENT_LINK_STATUSES.has(row.status)) return false;
  if (Boolean(row.simulated) && !providerSimulated) return false;
  return true;
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

/**
 * The reference id for the next link on a policy, given every row it already
 * has.
 *
 * The attempt suffix on `renewalReferenceId` already exists for exactly this
 * situation, so this picks an attempt number rather than inventing a second
 * scheme. It has to pick one that is genuinely free: a provider treats a
 * reference id as taken forever, and 0012's `idx_policy_renewals_reference_id`
 * is unique across the whole table, so a colliding reference is not a
 * duplicate link — it is a row that cannot be written at all, which lands on
 * the caller as `renewal_not_recorded` after the money link has been created.
 *
 * Counting the rows gets the ordinary case right on its own, and did so for as
 * long as a new row only ever followed an expired one. It stopped being enough
 * when a live rail began superseding simulated rows, because the count says
 * how many rows exist and not how those rows are numbered. Any history where
 * the two have drifted — a row archived by hand, a policy renewed across a gap
 * — can hand back a reference a surviving row still holds. Walking forward
 * past every reference in use costs one hash per prior row and removes the
 * case rather than narrowing it.
 */
function nextRenewalReferenceId(policyNumber: string, priorRows: any[]): string {
  const taken = new Set(priorRows.map((row) => String(row.reference_id ?? '')));
  let attempt = priorRows.length + 1;
  let candidate = renewalReferenceId(policyNumber, attempt);
  while (taken.has(candidate)) {
    attempt += 1;
    candidate = renewalReferenceId(policyNumber, attempt);
  }
  return candidate;
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

function offerMessage(
  policyNumber: string,
  amount: number,
  url: string,
  reused: boolean,
  termMonths: number
): string {
  const opening = reused
    ? `Policy ${policyNumber} already has a renewal payment link open`
    : `I can't act on policy ${policyNumber} while it's lapsed, but I can get it back in force`;
  // This wording changed when `recordRenewalCapture` landed, and the change is
  // the point of that work. It used to say reinstatement was confirmed
  // separately, because nothing in this system wrote policies.status and a
  // cleared payment genuinely did nothing. Now a signature-verified
  // `payment_link.paid` puts the policy back in force and extends the term, so
  // saying otherwise would be the lie.
  //
  // What it still does not promise is *instant*: the webhook is Razorpay's to
  // deliver and the caller will usually have hung up before it lands.
  return `${opening}. The premium due is ${amount.toFixed(2)}, and the link to pay it is ${url}. Once the payment clears, the policy goes back to active and the cover runs for another ${termMonths} months. That happens when our payment provider confirms it rather than the moment you tap pay, so give it a minute before you rely on the policy being live.`;
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
  const providerSimulated = provider.name === SIMULATED_PROVIDER_NAME;
  const reusable = priorLinks.filter((row) => isReusableLink(row, providerSimulated));

  // A real link outranks a simulated one whenever both survive the filter.
  // That pairing is precisely what a policy looks like once a simulated row
  // has been superseded: the dead row stays on the table, and if the rail
  // later falls back to the simulation both rows become reusable again. The
  // order PostgREST returns rows in is not defined, so taking whichever came
  // first would let the `.invalid` URL win a coin toss against a payable one.
  const live = reusable.find((row) => !Boolean(row.simulated)) ?? reusable[0] ?? null;

  if (live) {
    // Returning the link we already sent is the whole point: a second call must
    // not leave the customer holding two demands for the same premium.
    await recordJourneyEvent(supabase, {
      policyId: policy.id,
      eventType: 'renewal_offered',
      actor: 'agent',
      detail: {
        policy_number: policy.policy_number,
        payment_link_id: live.payment_link_id,
        amount_paise: toAmount(live.amount_paise),
        term_months: termMonths,
        simulated: Boolean(live.simulated),
        // Recorded rather than suppressed: a caller being handed the same link
        // three times is a story worth being able to read back.
        reused: true,
      },
    });

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
        true,
        termMonths
      ),
    };
  }

  // Reached when no prior row may be reused: every link is spent, or the only
  // ones left are simulated and the rail is now real. Either way the reference
  // has to move on, because the provider treats the old one as taken and the
  // unique index means a repeat could not be written down anyway.
  const referenceId = nextRenewalReferenceId(policy.policy_number, priorLinks);
  const amountPaise = Math.round(amount * 100);

  // The rows this new link supersedes: unspent by status, and skipped only
  // because they are simulated and the rail is now real.
  //
  // Nothing is written to them, and that is a decision rather than an
  // omission. Moving one to 'cancelled' would make it inert for every future
  // read, which is tempting — but it would erase the only record that a dead
  // URL was issued against this policy and read out to somebody, and the house
  // rule in this module is that a row states what happened while a journey
  // event carries the consequence (see the cancelled-policy branch in
  // `recordRenewalCapture`, which leaves its row untouched for the same
  // reason). It would also be a lie about the rail: nothing was cancelled at a
  // provider, because nothing was ever created at one. Leaving the row costs
  // nothing — `isReusableLink` skips it on every later call, and both webhook
  // paths key on `payment_link_id`, which it holds alone.
  const superseded = priorLinks.filter(
    (row) => !SPENT_LINK_STATUSES.has(row.status) && !isReusableLink(row, providerSimulated)
  );

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

  await recordJourneyEvent(supabase, {
    policyId: policy.id,
    eventType: 'renewal_offered',
    actor: 'agent',
    detail: {
      policy_number: policy.policy_number,
      payment_link_id: link.id,
      amount_paise: link.amountPaise,
      term_months: termMonths,
      simulated: link.simulated,
      reused: false,
      // Named rather than inferred: a timeline showing two open links on one
      // policy is alarming until it says why the first one stopped counting.
      ...(superseded.length > 0
        ? { superseded_simulated_link_ids: superseded.map((row) => row.payment_link_id) }
        : {}),
    },
  });

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
    message: offerMessage(policy.policy_number, amount, link.shortUrl, false, termMonths),
  };
}

// --- Dates ------------------------------------------------------------------

/**
 * Postgres BIGINT also arrives as a string. Paise are whole minor units, so
 * anything fractional or non-positive is not an amount we will compare against.
 */
function toPaise(value: unknown): number {
  const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

/**
 * Parse a DATE or an ISO timestamp down to a UTC calendar day.
 *
 * Deliberately not `new Date(value)`: that parses `'2023-01-31'` as UTC
 * midnight but `'2023/01/31'` as local midnight, and a policy that expires a
 * day early because the server moved timezone is exactly the kind of state
 * nobody could justify afterwards. Only the `YYYY-MM-DD` prefix is read.
 */
function parseCalendarDay(value: unknown): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? '').trim());
  if (!match) return null;
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(day.getTime()) ? null : day;
}

function formatCalendarDay(day: Date): string {
  return day.toISOString().slice(0, 10);
}

/**
 * Add whole months to a day, clamping the day-of-month rather than rolling
 * over. 31 August plus six months is 28 February, not 3 March: a renewal that
 * silently gains days is a renewal nobody can reconcile against the premium
 * charged for it.
 */
function addMonths(base: Date, months: number): Date {
  const target = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, 1)
  );
  const lastDayOfTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(Math.min(base.getUTCDate(), lastDayOfTargetMonth));
  return target;
}

/**
 * The end date a paid renewal buys.
 *
 * Measured from the day the money actually arrived, which is what the customer
 * gets: a policy that lapsed in January and is renewed in June is covered for
 * a full term from June, not for five months that already went by.
 *
 * The one exception is a policy whose recorded end date is still ahead of the
 * payment — an early renewal, or a second term bought before the first ran
 * out. There the term is added to the existing end date, because a renewal
 * extends cover and must never shorten it. The database agrees: 0020's
 * `policy_renewals_extension_moves_forward` CHECK refuses a new end date that
 * is not strictly later than the previous one, so computing it the other way
 * would not merely be unfair, it would fail to write.
 *
 * Returns null when there is nothing defensible to compute — no term, or a
 * paid date we cannot parse. The caller must refuse rather than pick a date.
 */
export function computeRenewedEndDate(input: {
  previousEndDate: unknown;
  paidAt: unknown;
  termMonths: unknown;
}): string | null {
  const months = Math.floor(toAmount(input.termMonths));
  if (months <= 0) return null;

  const paidDay = parseCalendarDay(input.paidAt);
  if (!paidDay) return null;

  const previousEnd = parseCalendarDay(input.previousEndDate);
  const base = previousEnd && previousEnd.getTime() > paidDay.getTime() ? previousEnd : paidDay;

  return formatCalendarDay(addMonths(base, months));
}

// --- Recording a capture ----------------------------------------------------

export type RenewalCaptureOutcome =
  | 'recorded'
  | 'replayed'
  | 'unknown_link'
  | 'simulated_link'
  | 'amount_mismatch'
  | 'already_captured'
  | 'policy_cancelled'
  | 'term_unknown'
  | 'activation_failed'
  | 'write_failed';

export interface RenewalCaptureResult {
  outcome: RenewalCaptureOutcome;
  policy_id: string | null;
  renewal_id: string | null;
  payment_link_id: string;
  payment_id: string;
  /** The end date this capture put on the policy, when it extended one. */
  new_end_date: string | null;
  /** True only when `policies` was actually written by this delivery. */
  policy_activated: boolean;
  detail: string;
}

type ActivationOutcome = 'activated' | 'policy_cancelled' | 'write_failed';

/**
 * The one write to `policies` in this codebase.
 *
 * Everything else that touches the table reads it. That is worth saying out
 * loud, because a policy's status is what every claim gate in this system
 * checks first: get this wrong and cover appears, or disappears, for reasons
 * nobody can trace.
 *
 * The `.neq('status', 'cancelled')` is not decoration. The caller has already
 * read the policy and refused if it was cancelled, but between that read and
 * this write somebody may have cancelled it — for fraud, most likely, which is
 * precisely the case where a payment arriving must not undo the decision. The
 * guard makes the refusal atomic instead of advisory, and `.select()` is what
 * lets us tell "the guard stopped it" from "it was written": PostgREST returns
 * the rows it actually changed, and zero rows means the policy was cancelled
 * under us.
 */
async function activatePolicy(
  supabase: SupabaseClient,
  policyId: string,
  newEndDate: string
): Promise<ActivationOutcome> {
  const { data, error } = await supabase
    .from('policies')
    .update({ status: 'active', end_date: newEndDate })
    .eq('id', policyId)
    .neq('status', 'cancelled')
    .select('id, status, end_date');

  if (error) {
    console.error('activatePolicy: policy write failed:', error);
    return 'write_failed';
  }

  if (!data || data.length === 0) {
    console.error(
      `activatePolicy: policy ${policyId} was not activated — it is cancelled, and a cancellation is not reversed by a payment`
    );
    return 'policy_cancelled';
  }

  return 'activated';
}

/**
 * Record a captured renewal premium, put the policy back in force, and extend
 * its term.
 *
 * Called only from the webhook route, and only after the signature has been
 * verified — an unverified delivery is a stranger telling us money arrived.
 *
 * The gates mirror `recordDeductibleCapture` one for one, because the failure
 * modes are the same and a second, subtly different implementation of an
 * idempotent capture is how a system ends up charging twice. What this adds is
 * the half a deductible does not have: recording the capture changes a policy,
 * so the write order matters and each step has to be re-appliable on its own.
 *
 * Order, and why:
 *   1. ledger replay check      — a redelivery is recognised, not re-applied
 *   2. row lookup by link id    — a link we did not issue is not ours to touch
 *   3. refuse simulated         — a link resolving nowhere cannot have been paid
 *   4. refuse already-captured  — with a repair branch, see below
 *   5. refuse a short capture   — a part-paid premium does not buy a term
 *   6. refuse a cancelled policy — money does not reverse a decision
 *   7. write the capture        — guarded by `.is('payment_id', null)`
 *   8. write the policy         — guarded by `.neq('status', 'cancelled')`
 *   9. write the ledger LAST    — so a failure anywhere above is retried
 *
 * Step 9 is the load-bearing one. If the ledger row went first, a failure at
 * step 7 or 8 would be permanent: Razorpay's retry would see the ledger, call
 * it a replay, and the customer would have paid for a policy that stayed
 * expired forever. Written last, every retry re-enters at step 1 and finds
 * nothing, and steps 7 and 8 are both idempotent, so re-applying costs
 * nothing.
 */
export async function recordRenewalCapture(
  supabase: SupabaseClient,
  capture: RazorpayCapture,
  ledgerId: string,
  rawEvent: unknown
): Promise<RenewalCaptureResult> {
  const base = {
    policy_id: null as string | null,
    renewal_id: null as string | null,
    payment_link_id: capture.paymentLinkId,
    payment_id: capture.paymentId,
    new_end_date: null as string | null,
    policy_activated: false,
  };

  // --- Replay: has this exact delivery already been applied? --------------
  const { data: seen, error: seenError } = await supabase
    .from('razorpay_webhook_events')
    .select('id, event')
    .eq('id', ledgerId)
    .maybeSingle();

  if (seenError && !isNotFound(seenError)) {
    console.error('recordRenewalCapture: event ledger read failed:', seenError);
    return { ...base, outcome: 'write_failed', detail: 'event ledger unreadable' };
  }

  if (seen) {
    return { ...base, outcome: 'replayed', detail: `event ${ledgerId} already applied` };
  }

  // --- The link must be one we issued -------------------------------------
  const { data: row, error: rowError } = await supabase
    .from('policy_renewals')
    .select(
      'id, policy_id, amount_paise, term_months, simulated, status, payment_id, captured_amount_paise, previous_end_date, new_end_date, activated_at'
    )
    .eq('payment_link_id', capture.paymentLinkId)
    .maybeSingle();

  if (rowError && !isNotFound(rowError)) {
    console.error('recordRenewalCapture: renewal lookup failed:', rowError);
    return { ...base, outcome: 'write_failed', detail: 'renewal records unreadable' };
  }

  if (!row) {
    // Deductible links live in the same Razorpay account and produce the same
    // events. This handler owns renewals and nothing else; inventing a row for
    // a link we did not issue would be worse than ignoring it.
    return { ...base, outcome: 'unknown_link', detail: 'no renewal row for this payment link' };
  }

  base.policy_id = row.policy_id;
  base.renewal_id = row.id;

  // --- A simulated link can never have been paid --------------------------
  // Its URL resolves nowhere. A capture claiming otherwise is not a capture,
  // and acting on it would put a policy back in force for imaginary money.
  if (row.simulated) {
    console.error(
      `recordRenewalCapture: capture ${capture.paymentId} arrived for simulated link ${capture.paymentLinkId}`
    );
    await recordJourneyEvent(supabase, {
      policyId: row.policy_id,
      eventType: 'renewal_failed',
      actor: 'system',
      detail: {
        reason: 'simulated_link',
        payment_link_id: capture.paymentLinkId,
        payment_id: capture.paymentId,
      },
    });
    return {
      ...base,
      outcome: 'simulated_link',
      detail: 'the link was simulated and cannot have been paid',
    };
  }

  // --- Already captured ---------------------------------------------------
  if (row.payment_id) {
    if (row.payment_id !== capture.paymentId) {
      return {
        ...base,
        outcome: 'amount_mismatch',
        detail: `renewal already carries payment ${row.payment_id}`,
      };
    }

    // Same payment, already on the row. Usually a fresh delivery id for a
    // capture we have finished with — but it is also how the repair arrives.
    //
    // If the capture was written and the write to `policies` then failed, this
    // row carries `new_end_date` with no `activated_at`, and the customer has
    // paid for a policy that is still expired. 0020 stores the target date for
    // exactly this: re-apply it, rather than recompute "term_months from
    // today", because recomputing on a retry would push the end date out a
    // second time and hand out cover nobody paid for.
    if (row.new_end_date && !row.activated_at) {
      base.new_end_date = String(row.new_end_date);
      const repaired = await finishActivation(supabase, row, String(row.new_end_date), capture);
      if (repaired.outcome === 'activated') {
        return {
          ...base,
          outcome: 'recorded',
          policy_activated: true,
          detail: 'the capture was already recorded; the policy extension was re-applied',
        };
      }
      return {
        ...base,
        outcome: repaired.outcome === 'policy_cancelled' ? 'policy_cancelled' : 'activation_failed',
        detail: repaired.detail,
      };
    }

    return { ...base, outcome: 'already_captured', detail: 'this capture is already recorded' };
  }

  // --- The money that arrived must be the money we asked for --------------
  // A part-paid premium does not buy a term. Recording it as one would extend
  // cover by twelve months for whatever the customer felt like paying.
  const expected = toPaise(row.amount_paise);
  if (capture.capturedAmountPaise < expected) {
    console.error(
      `recordRenewalCapture: capture ${capture.paymentId} was ${capture.capturedAmountPaise} paise against ${expected} demanded`
    );
    await recordJourneyEvent(supabase, {
      policyId: row.policy_id,
      eventType: 'renewal_failed',
      actor: 'system',
      detail: {
        reason: 'amount_mismatch',
        payment_link_id: capture.paymentLinkId,
        payment_id: capture.paymentId,
        captured_amount_paise: capture.capturedAmountPaise,
        expected_amount_paise: expected,
      },
    });
    return {
      ...base,
      outcome: 'amount_mismatch',
      detail: `captured ${capture.capturedAmountPaise} paise against ${expected} demanded`,
    };
  }

  // --- The policy this renewal belongs to ---------------------------------
  const { data: policy, error: policyError } = await supabase
    .from('policies')
    .select('id, policy_number, status, end_date')
    .eq('id', row.policy_id)
    .maybeSingle();

  if (policyError && !isNotFound(policyError)) {
    console.error('recordRenewalCapture: policy lookup failed:', policyError);
    return { ...base, outcome: 'write_failed', detail: 'policy records unreadable' };
  }

  if (!policy) {
    // A renewal row holds a foreign key to policies, so this cannot happen
    // through the database. If it does, something is wrong that guessing an
    // end date will not fix — ask for a retry and leave the row alone.
    console.error(
      `recordRenewalCapture: renewal ${row.id} points at policy ${row.policy_id}, which was not found`
    );
    return { ...base, outcome: 'write_failed', detail: 'the policy behind this renewal is missing' };
  }

  // --- A cancellation is a decision, and money does not reverse it --------
  //
  // A lapse is the absence of payment and paying cures it. A cancellation is
  // something a person decided — for non-payment, for fraud, or at the
  // customer's own request — and a card being charged is not an appeal against
  // it. `offerRenewal` refuses cancelled policies before a link is ever
  // issued, so reaching here means the policy was cancelled after the link
  // went out, which is the fraud case almost exactly.
  //
  // The row is left completely untouched, deliberately, so that a human
  // reconciling this sees an unpaid renewal and a cancelled policy rather than
  // a paid renewal that mysteriously bought nothing. The payment id and the
  // amount are not lost — they are on the journey event below, which is what
  // the refund will be made from.
  if (policy.status === 'cancelled') {
    console.error(
      `recordRenewalCapture: capture ${capture.paymentId} (${capture.capturedAmountPaise} paise) arrived for policy ${policy.policy_number}, which is CANCELLED. Nothing has been recorded and the policy has not been reinstated. This money needs refunding by hand.`
    );
    await recordJourneyEvent(supabase, {
      policyId: policy.id,
      eventType: 'renewal_failed',
      actor: 'system',
      detail: {
        reason: 'policy_cancelled',
        policy_number: policy.policy_number,
        payment_link_id: capture.paymentLinkId,
        payment_id: capture.paymentId,
        captured_amount_paise: capture.capturedAmountPaise,
        needs_manual_refund: true,
      },
    });
    return {
      ...base,
      outcome: 'policy_cancelled',
      detail: 'the policy was cancelled; a payment does not reinstate it',
    };
  }

  // --- The term the premium bought ----------------------------------------
  const newEndDate = computeRenewedEndDate({
    previousEndDate: policy.end_date,
    paidAt: capture.createdAt,
    termMonths: row.term_months,
  });

  if (!newEndDate) {
    // `offerRenewal` always writes term_months, so a missing one is corrupt
    // data. There is no defensible end date to compute from it, and picking a
    // default here would be inventing cover. Refuse loudly and leave the row.
    console.error(
      `recordRenewalCapture: renewal ${row.id} has no usable term (term_months=${row.term_months}), so capture ${capture.paymentId} cannot be turned into an end date`
    );
    await recordJourneyEvent(supabase, {
      policyId: policy.id,
      eventType: 'renewal_failed',
      actor: 'system',
      detail: {
        reason: 'term_unknown',
        policy_number: policy.policy_number,
        payment_link_id: capture.paymentLinkId,
        payment_id: capture.paymentId,
        term_months: row.term_months ?? null,
        needs_manual_refund: true,
      },
    });
    return {
      ...base,
      outcome: 'term_unknown',
      detail: 'the renewal carries no term, so no end date can be justified',
    };
  }

  base.new_end_date = newEndDate;

  // --- Write the capture --------------------------------------------------
  //
  // `activated_at` is deliberately NOT set here. It means "the policy was put
  // back in force", and at this instant it has not been. Setting it alongside
  // the capture would make every failed policy write look like a success in
  // the audit trail, and would disarm the repair branch above.
  const { error: updateError } = await supabase
    .from('policy_renewals')
    .update({
      status: 'paid',
      payment_id: capture.paymentId,
      // The rail's figure, not ours.
      captured_amount_paise: capture.capturedAmountPaise,
      captured_at: capture.createdAt,
      capture_event_id: ledgerId,
      previous_end_date: policy.end_date,
      new_end_date: newEndDate,
    })
    .eq('id', row.id)
    // Conditional so two deliveries racing each other cannot both apply. The
    // loser writes nothing, and the ledger stops it coming back.
    .is('payment_id', null);

  if (updateError) {
    console.error('recordRenewalCapture: capture write failed:', updateError);
    return { ...base, outcome: 'write_failed', detail: 'could not record the capture' };
  }

  await recordJourneyEvent(supabase, {
    policyId: policy.id,
    eventType: 'renewal_paid',
    actor: 'provider',
    // The rail's timestamp, not ours: a retry hours later must not order the
    // payment after the reactivation it caused.
    occurredAt: capture.createdAt,
    detail: {
      policy_number: policy.policy_number,
      payment_link_id: capture.paymentLinkId,
      payment_id: capture.paymentId,
      captured_amount_paise: capture.capturedAmountPaise,
      currency: capture.currency,
      captured_at: capture.createdAt,
    },
  });

  // --- Put the policy back in force ---------------------------------------
  const activation = await finishActivation(supabase, row, newEndDate, capture, policy);

  if (activation.outcome !== 'activated') {
    // No ledger row. Razorpay retries, the retry finds the capture already
    // recorded with no `activated_at`, and the repair branch re-applies the
    // same stored end date.
    return {
      ...base,
      outcome: activation.outcome === 'policy_cancelled' ? 'policy_cancelled' : 'activation_failed',
      detail: activation.detail,
    };
  }

  base.policy_activated = true;

  // Written last, and deliberately: everything above is idempotent, so a retry
  // costs nothing, while a ledger row written too early costs a policy that
  // stays expired after a real premium was paid.
  const { error: ledgerError } = await supabase.from('razorpay_webhook_events').insert({
    id: ledgerId,
    event: capture.event,
    payment_id: capture.paymentId,
    payment_link_id: capture.paymentLinkId,
    payload: rawEvent as any,
  });

  if (ledgerError) {
    // The capture is recorded and the policy is active, which is the part that
    // matters. A retry will hit the payment_id guard and report already
    // captured.
    console.error('recordRenewalCapture: event ledger write failed:', ledgerError);
  }

  return {
    ...base,
    outcome: 'recorded',
    detail: `renewal recorded and policy extended to ${newEndDate}`,
  };
}

/**
 * Activate the policy and stamp the renewal row to say it happened.
 *
 * Split out because it is reached twice: once on the first delivery, and once
 * on a retry repairing a capture whose policy write failed. Both must produce
 * the same end state from the same stored target date.
 */
async function finishActivation(
  supabase: SupabaseClient,
  row: { id: string; policy_id: string },
  newEndDate: string,
  capture: RazorpayCapture,
  knownPolicy?: { policy_number?: string }
): Promise<{ outcome: ActivationOutcome; detail: string }> {
  const activation = await activatePolicy(supabase, row.policy_id, newEndDate);

  if (activation === 'policy_cancelled') {
    await recordJourneyEvent(supabase, {
      policyId: row.policy_id,
      eventType: 'renewal_failed',
      actor: 'system',
      detail: {
        reason: 'policy_cancelled',
        payment_id: capture.paymentId,
        captured_amount_paise: capture.capturedAmountPaise,
        needs_manual_refund: true,
      },
    });
    return {
      outcome: 'policy_cancelled',
      detail: 'the policy was cancelled before the extension could be applied',
    };
  }

  if (activation === 'write_failed') {
    return {
      outcome: 'write_failed',
      detail: 'the capture is recorded but the policy could not be extended; retry',
    };
  }

  const activatedAt = new Date().toISOString();
  const { error: stampError } = await supabase
    .from('policy_renewals')
    .update({ activated_at: activatedAt })
    .eq('id', row.id);

  if (stampError) {
    // The policy really is active — that write returned its row. But the audit
    // trail would say otherwise, and an extension nobody can justify after the
    // fact is the state this codebase exists to avoid. Ask for the retry: the
    // repair branch re-applies the same end date, which changes nothing, and
    // tries this stamp again.
    console.error('finishActivation: activated_at stamp failed:', stampError);
    return {
      outcome: 'write_failed',
      detail: 'the policy was extended but the renewal row could not record it; retry',
    };
  }

  await recordJourneyEvent(supabase, {
    policyId: row.policy_id,
    eventType: 'policy_reactivated',
    actor: 'system',
    detail: {
      policy_number: knownPolicy?.policy_number ?? null,
      new_end_date: newEndDate,
      payment_id: capture.paymentId,
      activated_at: activatedAt,
    },
  });

  return { outcome: 'activated', detail: `policy extended to ${newEndDate}` };
}

// --- Recording a failure ----------------------------------------------------

export type RenewalFailureOutcome =
  | 'recorded'
  | 'replayed'
  | 'unknown_link'
  | 'already_captured'
  | 'write_failed';

export interface RenewalFailureResult {
  outcome: RenewalFailureOutcome;
  policy_id: string | null;
  renewal_id: string | null;
  payment_link_id: string;
  /** Razorpay's reason, passed through unedited, or null when it gave none. */
  reason: string | null;
  detail: string;
}

/**
 * Record a failed or expired renewal payment.
 *
 * Before this, both events were acknowledged and dropped: the route answered
 * 200 and wrote nothing, so "nobody has paid yet" and "the card was declined
 * three times" were the same row in our database. They are not the same fact.
 *
 * What this deliberately does NOT do is touch `policies`. A failed payment
 * leaves the policy exactly as it was — expired, and expired is already what
 * it says. There is no state to change, and changing one would be inventing a
 * consequence the money never had.
 */
export async function recordRenewalFailure(
  supabase: SupabaseClient,
  failure: RazorpayPaymentFailure,
  ledgerId: string,
  rawEvent: unknown
): Promise<RenewalFailureResult> {
  const reason =
    failure.errorDescription ??
    failure.errorCode ??
    (failure.kind === 'link_expired' ? 'the payment link expired unpaid' : null);

  const base = {
    policy_id: null as string | null,
    renewal_id: null as string | null,
    payment_link_id: failure.paymentLinkId,
    reason,
  };

  const { data: seen, error: seenError } = await supabase
    .from('razorpay_webhook_events')
    .select('id, event')
    .eq('id', ledgerId)
    .maybeSingle();

  if (seenError && !isNotFound(seenError)) {
    console.error('recordRenewalFailure: event ledger read failed:', seenError);
    return { ...base, outcome: 'write_failed', detail: 'event ledger unreadable' };
  }

  if (seen) {
    return { ...base, outcome: 'replayed', detail: `event ${ledgerId} already applied` };
  }

  const { data: row, error: rowError } = await supabase
    .from('policy_renewals')
    .select('id, policy_id, status, payment_id')
    .eq('payment_link_id', failure.paymentLinkId)
    .maybeSingle();

  if (rowError && !isNotFound(rowError)) {
    console.error('recordRenewalFailure: renewal lookup failed:', rowError);
    return { ...base, outcome: 'write_failed', detail: 'renewal records unreadable' };
  }

  if (!row) {
    // A deductible link, or a link for something else on the same Razorpay
    // account. No ledger row is written here on purpose: writing one would
    // make this delivery look applied, and a handler added later for the
    // deductible side would skip it as a replay.
    return { ...base, outcome: 'unknown_link', detail: 'no renewal row for this payment link' };
  }

  base.policy_id = row.policy_id;
  base.renewal_id = row.id;

  if (row.payment_id) {
    // The link was paid. A later failure or expiry event against it says
    // nothing about the money already captured, and moving a paid renewal to
    // expired would erase a real payment from the record.
    return {
      ...base,
      outcome: 'already_captured',
      detail: 'this renewal was already paid; the failure event changes nothing',
    };
  }

  // Only an expiry changes the row's state, and only because the link is
  // genuinely spent — `offerRenewal` reads exactly this to decide it may issue
  // a fresh one. A `payment.failed` is a declined attempt against a link that
  // is still perfectly payable, so the status stays as it is and the customer
  // can simply try again.
  if (failure.kind === 'link_expired') {
    const { error: updateError } = await supabase
      .from('policy_renewals')
      .update({ status: 'expired' })
      .eq('id', row.id)
      // Same guard as the capture path: never move a row that took money.
      .is('payment_id', null);

    if (updateError) {
      console.error('recordRenewalFailure: expiry write failed:', updateError);
      return { ...base, outcome: 'write_failed', detail: 'could not record the expiry' };
    }
  }

  await recordJourneyEvent(supabase, {
    policyId: row.policy_id,
    eventType: 'renewal_failed',
    actor: 'provider',
    occurredAt: failure.createdAt,
    detail: {
      reason: failure.kind,
      event: failure.event,
      payment_link_id: failure.paymentLinkId,
      payment_id: failure.paymentId,
      error_code: failure.errorCode,
      error_description: failure.errorDescription,
      error_reason: failure.errorReason,
      occurred_at: failure.createdAt,
      // Said explicitly so nobody reading the timeline has to infer it.
      policy_unchanged: true,
    },
  });

  const { error: ledgerError } = await supabase.from('razorpay_webhook_events').insert({
    id: ledgerId,
    event: failure.event,
    payment_id: failure.paymentId,
    payment_link_id: failure.paymentLinkId,
    payload: rawEvent as any,
  });

  if (ledgerError) {
    console.error('recordRenewalFailure: event ledger write failed:', ledgerError);
  }

  return {
    ...base,
    outcome: 'recorded',
    detail:
      failure.kind === 'link_expired'
        ? 'the renewal link expired unpaid; the policy is unchanged'
        : 'the renewal payment failed; the link is still payable and the policy is unchanged',
  };
}

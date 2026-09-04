import { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { isNotFound } from './lookup-result.js';
import { referenceCandidates } from './reference-number.js';
import type {
  PaymentLink,
  PaymentLinkProvider,
  PaymentLinkStatus,
  PaymentLinkStatusReport,
} from './payment-link-provider.js';
import type { RazorpayCapture, RazorpayPaymentFailure } from './razorpay-webhook.js';
import { recordJourneyEvent } from './journey-events-service.js';
import { toAmount, toCurrency } from './money.js';

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

/**
 * How long the whole of the "is this link actually still payable" check may
 * take, across every prior link on the policy.
 *
 * A budget rather than a per-call timeout, because a policy can carry more
 * than one unspent-looking row and checking them one at a time would multiply
 * the wait. The number is small on purpose: the caller is on a phone line, and
 * three seconds of silence is a caller who thinks the line dropped.
 */
export const DEFAULT_RENEWAL_LINK_STATUS_BUDGET_MS = 2_500;

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
  | 'renewal_not_recorded'
  /** The rail could not be asked whether an existing link is still payable. */
  | 'link_status_unknown'
  /** The premium was already paid, and the policy is back in force. */
  | 'renewal_already_paid'
  /** The premium was already paid, and finishing it needs a human. */
  | 'renewal_needs_review';

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
  /** Total time allowed for asking the rail about existing links. */
  linkStatusBudgetMs?: number;
}

/**
 * A link in one of these states is spent: it can never be paid again, so a
 * policy carrying only these has no live offer.
 *
 * `paid` belongs here and its absence was a real fault, not a subtlety. The
 * comment that used to sit here argued the opposite — that a paid link counts
 * as live because re-issuing against one would ask for the premium a second
 * time — and the conclusion was right while the premise was exactly backwards.
 * A paid link is the most spent a link can possibly be: Razorpay will not take
 * a second payment against it, so handing it back does not protect anyone from
 * being billed twice. It just reads a dead URL out to somebody, who taps it,
 * is told it is already paid, pays nothing, and therefore triggers no webhook
 * and no reactivation. That happened, on a live call, to a real caller.
 *
 * Protection against a second demand does not come from this set. It comes
 * from the branches above the reuse path, which refuse the offer outright when
 * the premium has already been paid — because when the money is already in,
 * the right answer is never another link.
 *
 * `partially_paid` is deliberately absent: Razorpay will still take the
 * balance on such a link, so it is genuinely payable and genuinely ours to
 * hand back.
 */
const SPENT_LINK_STATUSES = new Set<string>(['paid', 'expired', 'cancelled']);

/**
 * Statuses a provider can report that mean the link is still payable. Stated
 * as its own set rather than as "not spent", so that a status neither set
 * recognises is treated as payable by nobody.
 */
const PAYABLE_LINK_STATUSES = new Set<string>(['created', 'partially_paid']);

/**
 * The `event` recorded for a capture this service discovered by asking the
 * rail, rather than being told about by a signed webhook.
 *
 * Deliberately not 'payment_link.paid'. That string means "Razorpay delivered
 * us this event", and no such delivery happened here — the whole reason this
 * path exists is that it did not. A ledger row claiming otherwise would put a
 * fiction in the one table whose job is to say what actually arrived.
 */
const RECONCILED_CAPTURE_EVENT = 'reconciliation.payment_link.paid';

/**
 * The ledger id for a reconciled capture.
 *
 * Derived from the payment id, so the guarantees the webhook path relies on
 * still hold. Two calls that discover the same capture produce the same id and
 * the second is recognised as a replay; and because it is nothing like a
 * Razorpay delivery id, a genuine `payment_link.paid` that turns up late is
 * NOT mistaken for a replay of this — it re-enters the capture path, finds the
 * payment already on the row, and reports `already_captured` without applying
 * anything twice.
 */
function reconciledLedgerId(paymentId: string): string {
  return `recon_${paymentId}`;
}

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
 *
 * The third disqualifier is a payment id. It is nearly always redundant with
 * the status check — the capture path writes both together — but it is not
 * derived from it, and that matters: `status` is a label a webhook set, while
 * `payment_id` is the identifier of money we actually hold. If the two ever
 * disagree, the money is the one telling the truth.
 */
function isReusableLink(row: any, providerSimulated: boolean): boolean {
  if (row.payment_id) return false;
  if (SPENT_LINK_STATUSES.has(row.status)) return false;
  if (Boolean(row.simulated) && !providerSimulated) return false;
  return true;
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

/**
 * Ask the rail what a link's status actually is, within a bounded time.
 *
 * Two bounds, not one, and the second is not paranoia. The provider is asked
 * to honour `timeoutMs` and the real one does — but `provider` here is an
 * interface, and an implementation that hangs would hang a phone call. The
 * race is the guarantee this function makes on its own behalf, independent of
 * anyone's cooperation.
 *
 * Every way of failing to get an answer produces the same value: a provider
 * that has no such method, one that throws, one that never resolves, one that
 * resolves with `reachable: false`. They are one case to the caller — nobody
 * established anything — and flattening them here keeps that decision in one
 * place rather than three.
 */
async function askLinkStatus(
  provider: PaymentLinkProvider,
  paymentLinkId: string,
  budgetMs: number
): Promise<PaymentLinkStatusReport> {
  if (typeof provider.getPaymentLinkStatus !== 'function') {
    return {
      reachable: false,
      reason: `the ${provider.name} rail cannot be asked about existing payment links`,
    };
  }

  if (budgetMs <= 0) {
    return {
      reachable: false,
      reason: 'the time allowed for checking existing payment links was already spent',
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  // The provider promise is made non-rejecting BEFORE the race rather than
  // wrapped in a try/catch around it: whichever branch loses stays alive, and
  // a rejection arriving after the race has settled would otherwise surface as
  // an unhandled rejection with no caller left to blame it on.
  const asked = provider.getPaymentLinkStatus(paymentLinkId, { timeoutMs: budgetMs }).catch(
    (error): PaymentLinkStatusReport => ({
      reachable: false,
      reason: `the ${provider.name} rail threw while reporting on ${paymentLinkId}: ${error instanceof Error ? error.message : String(error)}`,
    })
  );

  const bounded = new Promise<PaymentLinkStatusReport>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          reachable: false,
          reason: `the ${provider.name} rail did not answer about ${paymentLinkId} within ${budgetMs}ms`,
        }),
      budgetMs
    );
  });

  try {
    return await Promise.race([asked, bounded]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Record on the row what the provider says, when the provider says a link is
 * spent and our row still says otherwise.
 *
 * This is a write on what is otherwise a read path, and it is the one write
 * here that needs no argument: `recordRenewalFailure` already does exactly
 * this when an expiry webhook arrives, so all that is happening is the same
 * fact reaching us by a different road.
 *
 * It is also load-bearing rather than tidy-minded. Without it the stale row
 * stays unspent forever, and since PostgREST returns rows in no defined order,
 * the very next call could pick the stale row over the fresh link we are about
 * to create, discover it is dead again, and issue a third. A missed webhook
 * would become an unbounded supply of payment links.
 *
 * A failure to write is logged and swallowed. The important half of this call
 * — not handing the dead link to the customer — has already happened, and the
 * discovery repeats harmlessly on the next call.
 */
async function markLinkSpent(
  supabase: SupabaseClient,
  row: any,
  status: PaymentLinkStatus
): Promise<void> {
  const { error } = await supabase
    .from('policy_renewals')
    .update({ status })
    .eq('id', row.id)
    // The same guard the webhook path uses: never move a row that took money.
    .is('payment_id', null);

  if (error) {
    console.error(
      `offerRenewal: link ${row.payment_link_id} is ${status} at the provider but the row could not be updated:`,
      error
    );
    return;
  }

  // Kept in step so the rest of this call reasons about the row as it now is,
  // rather than as it was read a moment ago.
  row.status = status;
}

/**
 * A capture we have just discovered: act on it, or merely report it?
 *
 * ## The decision, and why it went this way
 *
 * When the rail says a link is paid and our row does not, we are holding proof
 * of a payment this system missed. There are two honest things to do with it.
 * Report it — log loudly, write a journey event, leave the money unrecorded
 * until somebody reads the log. Or act — record the capture and put the policy
 * back in force, here, on a read path, while the caller is still on the line.
 *
 * This acts. Four reasons, in the order they carried weight.
 *
 * FIRST, the evidence is not weaker than a webhook's. It is stronger. The
 * webhook path insists on a verified signature because an inbound POST is a
 * stranger's claim until proven otherwise, and this codebase already declined
 * to record an unverified one — correctly. But this is not an inbound claim.
 * It is the rail answering a question we asked, over TLS, against a certificate
 * we checked, authenticated with a secret only we hold. The property the
 * signature exists to establish — that Razorpay, and nobody else, said this —
 * is established here by construction. Refusing to act on it would not be
 * consistency with that principle; it would be mistaking the mechanism for the
 * principle.
 *
 * SECOND, acting adds no new risk surface, because it adds no new code path.
 * Everything goes through `recordRenewalCapture`, which already refuses a
 * simulated link, refuses a short capture, refuses a cancelled policy, guards
 * its writes on `payment_id IS NULL` and `status <> 'cancelled'`, and is
 * idempotent from the ledger down. Writing a second, lighter capture path for
 * "captures we found ourselves" is the thing that would be dangerous, and it
 * is what a report-only design eventually grows once somebody has to clear the
 * backlog by hand.
 *
 * THIRD, reporting only is not neutral, and the phrase "a lookup should not
 * write" hides that. The caller in front of us has already paid. Report-only
 * means the only thing we can say to them is the sentence that started all
 * this — pay again, or wait for something that is never coming. There is no
 * option where the read stays pure AND the customer is dealt with properly;
 * the purity is bought with their money.
 *
 * FOURTH, the write only ever happens in a state that is already broken. A
 * healthy renewal never reaches here: the webhook lands, the row is paid, the
 * policy is active, and Gate 2 refuses the offer long before this. Reaching
 * this code at all means money arrived and we lost it.
 *
 * ## What acting does not license
 *
 * The offer is still refused. Discovering a payment is a reason to stop asking
 * for one, never a reason to hand out another link, so every branch below
 * returns a refusal with no payable URL on it.
 *
 * And the discovery is recorded before anything is attempted, so it survives
 * every outcome. If the capture write fails, if the policy turns out to be
 * cancelled, if this process dies mid-way — the journey still carries the fact
 * that the rail told us about money on this date, which is what a human needs
 * in order to finish by hand.
 */
async function reconcileDiscoveredCapture(
  supabase: SupabaseClient,
  policy: any,
  row: any,
  capture: RazorpayCapture,
  source: 'provider' | 'local_row'
): Promise<RenewalRefused> {
  await recordJourneyEvent(supabase, {
    policyId: policy.id,
    eventType: 'renewal_capture_discovered',
    actor: 'system',
    // The rail's timestamp, so the timeline puts the payment where it actually
    // happened rather than on the day we noticed.
    occurredAt: capture.createdAt,
    detail: {
      policy_number: policy.policy_number,
      payment_link_id: capture.paymentLinkId,
      payment_id: capture.paymentId,
      captured_amount_paise: capture.capturedAmountPaise,
      captured_at: capture.createdAt,
      // 'provider' — the rail reported a capture no webhook ever delivered.
      // 'local_row' — the capture was recorded here but never reached the
      // policy, and the delivery that would have repaired it never came back.
      discovered_via: source,
      // Said plainly, because a timeline showing a payment against a policy
      // that stayed expired is otherwise unreadable.
      missed_webhook: source === 'provider',
    },
  });

  console.error(
    `offerRenewal: capture ${capture.paymentId} (${capture.capturedAmountPaise} paise) on link ${capture.paymentLinkId} was not recorded against policy ${policy.policy_number}; reconciling it now (discovered via ${source})`
  );

  const result = await recordRenewalCapture(
    supabase,
    capture,
    reconciledLedgerId(capture.paymentId),
    {
      // Not a Razorpay delivery, and the payload says so in its own words. The
      // ledger's whole purpose is to record what arrived; a row here that
      // looked like a webhook body would be the one lie in the table.
      source: 'offer_renewal_reconciliation',
      note: 'Discovered by asking the payment provider for a link status during offerRenewal. No webhook delivered this capture.',
      discovered_via: source,
      payment_link_id: capture.paymentLinkId,
      payment_id: capture.paymentId,
      captured_amount_paise: capture.capturedAmountPaise,
      captured_at: capture.createdAt,
      discovered_at: new Date().toISOString(),
    }
  );

  if (result.outcome === 'recorded') {
    const until = result.new_end_date ? ` and the cover runs to ${result.new_end_date}` : '';
    return refuse(
      'renewal_already_paid',
      `Good news — the renewal premium on policy ${policy.policy_number} has already been paid. Our records hadn't caught up with it, so I've applied that payment now: the policy is back to active${until}. There's nothing further for you to pay.`,
      policy.policy_number
    );
  }

  if (result.outcome === 'policy_cancelled') {
    // `recordRenewalCapture` has already flagged the money for a manual refund
    // on its own journey event. Nothing is added here beyond saying it out loud
    // to the person on the phone.
    return refuse(
      'policy_cancelled',
      `Policy ${policy.policy_number} was cancelled, so paying the premium can't put it back in force. A payment was taken and it needs returning to you — I'm passing this to a representative to arrange that now.`,
      policy.policy_number
    );
  }

  // Everything else: the money is real and recorded somewhere, and finishing
  // it is beyond what this path can do unaided. What must NOT happen is a
  // fresh link, so this refuses rather than falling through.
  console.error(
    `offerRenewal: reconciliation of capture ${capture.paymentId} on policy ${policy.policy_number} ended as ${result.outcome} (${result.detail})`
  );
  return refuse(
    'renewal_needs_review',
    `The renewal premium on policy ${policy.policy_number} has already been paid — I can see the payment — but I can't finish putting the policy back in force from here. Nothing more is owed. Let me pass you to a representative who can complete it.`,
    policy.policy_number
  );
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
  //
  // The capture columns are read as well as the link ones, and not for
  // display. A row's `payment_id` and `activated_at` are what separate "this
  // link is still waiting to be paid" from "this link was paid and we never
  // finished with it", and the second of those must never be handed another
  // demand for the same premium.
  const { data: existingRows, error: existingError } = await supabase
    .from('policy_renewals')
    .select(
      'id, payment_link_id, short_url, amount_paise, status, reference_id, simulated, payment_id, captured_amount_paise, captured_at, activated_at'
    )
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

  // --- A premium already paid, sitting in our own records unfinished ------
  //
  // Asked before the rail is, because the answer is already here. A row with a
  // payment id and no `activated_at` is a capture that was recorded and then
  // failed to reach `policies` — the exact state `recordRenewalCapture` leaves
  // behind when the policy write fails, and the exact state its repair branch
  // exists to clear on the next delivery. When that delivery never comes, the
  // row sits there and the customer stays uncovered for a policy they paid for.
  //
  // This must run BEFORE the reuse filter, not after it. That filter now counts
  // a paid row as spent, which is right, and the code immediately after it
  // creates a fresh link — so without this branch, fixing the reuse bug would
  // have handed a second demand to somebody who had already paid. That is a
  // worse fault than the one being fixed, and it would have been introduced by
  // the fix.
  const unfinished = priorLinks.find((row) => row.payment_id && !row.activated_at);

  if (unfinished) {
    return reconcileDiscoveredCapture(
      supabase,
      policy,
      unfinished,
      {
        event: RECONCILED_CAPTURE_EVENT,
        paymentLinkId: String(unfinished.payment_link_id),
        referenceId: unfinished.reference_id != null ? String(unfinished.reference_id) : null,
        paymentId: String(unfinished.payment_id),
        // What the rail said arrived, falling back to what was demanded. The
        // fallback only matters for a row written before 0020's capture
        // columns existed; the amount gate downstream re-checks it either way.
        capturedAmountPaise:
          toPaise(unfinished.captured_amount_paise) || toPaise(unfinished.amount_paise),
        currency: 'INR',
        linkStatus: 'paid',
        createdAt: String(unfinished.captured_at ?? new Date().toISOString()),
      },
      'local_row'
    );
  }

  // A real link outranks a simulated one whenever both survive the filter.
  // That pairing is precisely what a policy looks like once a simulated row
  // has been superseded: the dead row stays on the table, and if the rail
  // later falls back to the simulation both rows become reusable again. The
  // order PostgREST returns rows in is not defined, so taking whichever came
  // first would let the `.invalid` URL win a coin toss against a payable one.
  const reusable = priorLinks
    .filter((row) => isReusableLink(row, providerSimulated))
    .sort((a, b) => Number(Boolean(a.simulated)) - Number(Boolean(b.simulated)));

  // --- Do not trust a stale local status ----------------------------------
  //
  // `policy_renewals.status` is only as fresh as the last webhook that landed,
  // and a webhook that never landed leaves the row saying 'created' forever.
  // That is not hypothetical: a link Razorpay had recorded as paid and captured
  // was reused for weeks and read out to a caller who could not pay it, because
  // the row still said 'created' and nothing here ever asked otherwise.
  //
  // So no link is offered a second time on the strength of our own record. The
  // rail is asked what it currently says, and the row is believed only where
  // the two agree.
  //
  // One budget covers every candidate rather than one timeout each: a policy
  // can carry more than one unspent-looking row, and a caller should not wait
  // longer because our table is untidy.
  const statusDeadline =
    Date.now() + (options.linkStatusBudgetMs ?? DEFAULT_RENEWAL_LINK_STATUS_BUDGET_MS);

  for (const candidate of reusable) {
    const report = await askLinkStatus(
      provider,
      String(candidate.payment_link_id),
      statusDeadline - Date.now()
    );

    // --- The rail could not be asked --------------------------------------
    //
    // The judgement call in this change, so here is the argument.
    //
    // Reusing the link anyway is what the code did before, and it is how a
    // caller came to be read a URL that had been paid a fortnight earlier. It
    // fails in the one direction that reaches the customer.
    //
    // Issuing a fresh link instead fails in the worse direction: if the old
    // link is in fact still payable, the customer now holds two live demands
    // for one premium and can be charged twice. It is also mostly incoherent —
    // a new link comes from the same rail that just failed to answer, so in a
    // real outage the create fails too and we arrive at a refusal by a longer
    // road, having spent the caller's time to get there.
    //
    // What is left is to refuse, and refusing is not merely the least bad
    // option — it is the only one that is actually true. Razorpay's API and
    // Razorpay's hosted checkout are the same service to us; when we cannot
    // reach one, we have no basis for telling somebody "tap this and your
    // policy comes back". Reading out a link is a promise, and this is the
    // state in which we cannot keep it.
    //
    // A timeout arrives here as well, deliberately: not being answered in time
    // and not being answered are the same state of knowledge.
    if (!report.reachable) {
      console.error(
        `offerRenewal: could not confirm payment link ${candidate.payment_link_id} for policy ${policy.policy_number}: ${report.reason}`
      );
      await recordJourneyEvent(supabase, {
        policyId: policy.id,
        eventType: 'renewal_failed',
        actor: 'system',
        detail: {
          reason: 'link_status_unknown',
          policy_number: policy.policy_number,
          payment_link_id: candidate.payment_link_id,
          provider: provider.name,
          detail: report.reason,
          // Nothing was offered and nothing was created: the policy is exactly
          // as it was, and the caller can be tried again in a minute.
          policy_unchanged: true,
        },
      });
      return refuse(
        'link_status_unknown',
        `I can't reach our payment provider to check the renewal link that's already open on policy ${policy.policy_number}, so I won't read out a link I can't confirm is live. Let me pass you to a representative.`,
        policy.policy_number,
        amount
      );
    }

    // --- Still payable: reuse, exactly as before ---------------------------
    if (PAYABLE_LINK_STATUSES.has(report.status)) {
      // Returning the link we already sent is the whole point: a second call
      // must not leave the customer holding two demands for the same premium.
      await recordJourneyEvent(supabase, {
        policyId: policy.id,
        eventType: 'renewal_offered',
        actor: 'agent',
        detail: {
          policy_number: policy.policy_number,
          payment_link_id: candidate.payment_link_id,
          amount_paise: toAmount(candidate.amount_paise),
          term_months: termMonths,
          simulated: Boolean(candidate.simulated),
          // Recorded rather than suppressed: a caller being handed the same
          // link three times is a story worth being able to read back.
          reused: true,
          // What the rail said when we checked, so a later reader can tell a
          // link that was confirmed live from one that was merely assumed.
          provider_status: report.status,
        },
      });

      return {
        success: true,
        reason: null,
        policy_number: policy.policy_number,
        payment_link_id: candidate.payment_link_id,
        payment_link_url: candidate.short_url,
        // The rail's word, not the row's. They are usually the same; when they
        // are not, the row is the one that is out of date.
        payment_link_status: report.status,
        renewal_amount: toCurrency(toAmount(candidate.amount_paise) / 100),
        term_months: termMonths,
        reference_id: candidate.reference_id,
        simulated: Boolean(candidate.simulated),
        reused: true,
        message: offerMessage(
          policy.policy_number,
          toCurrency(toAmount(candidate.amount_paise) / 100),
          candidate.short_url,
          true,
          termMonths
        ),
      };
    }

    // --- The rail says it was paid ----------------------------------------
    //
    // A capture nobody told us about. See `reconcileDiscoveredCapture` for why
    // this acts on it rather than only reporting it.
    if (report.status === 'paid') {
      if (!report.capture) {
        // Paid, but the rail names no payment. There is nothing to record a
        // capture against — `policy_renewals.payment_id` is what a refund and
        // every idempotency guard in the capture path key on — and inventing
        // an identifier for real money is not a thing this code will do. Say
        // so as loudly as possible and leave it for a human.
        console.error(
          `offerRenewal: ${provider.name} reports link ${candidate.payment_link_id} on policy ${policy.policy_number} as PAID (${report.amountPaidPaise} paise) but names no payment; this capture cannot be recorded automatically`
        );
        await recordJourneyEvent(supabase, {
          policyId: policy.id,
          eventType: 'renewal_capture_discovered',
          actor: 'system',
          detail: {
            policy_number: policy.policy_number,
            payment_link_id: candidate.payment_link_id,
            payment_id: null,
            captured_amount_paise: report.amountPaidPaise,
            discovered_via: 'provider',
            missed_webhook: true,
            // The reason a human has to finish this one by hand.
            unrecordable: 'the provider reported the link as paid but named no payment',
            needs_manual_refund: false,
          },
        });
        return refuse(
          'renewal_needs_review',
          `The renewal premium on policy ${policy.policy_number} has already been paid — I can see the payment — but I can't finish putting the policy back in force from here. Nothing more is owed. Let me pass you to a representative who can complete it.`,
          policy.policy_number,
          amount
        );
      }

      return reconcileDiscoveredCapture(
        supabase,
        policy,
        candidate,
        {
          event: RECONCILED_CAPTURE_EVENT,
          paymentLinkId: String(candidate.payment_link_id),
          referenceId: report.referenceId ?? candidate.reference_id ?? null,
          paymentId: report.capture.paymentId,
          // The rail's figure for what arrived, never the one we demanded.
          capturedAmountPaise: report.capture.amountPaise || report.amountPaidPaise,
          currency: 'INR',
          linkStatus: report.status,
          createdAt: report.capture.paidAt,
        },
        'provider'
      );
    }

    // --- Expired or cancelled at the rail, still open in our record --------
    // A missed expiry rather than a missed capture: no money involved, and the
    // only thing owed is that the row stop claiming to be an open offer. Write
    // that down and carry on to the next candidate, or to a fresh link.
    await markLinkSpent(supabase, candidate, report.status);
  }

  // Reached when no prior row may be reused: every link is spent by our own
  // record, or spent according to the rail when we asked it, or the only ones
  // left are simulated and the rail is now real. Either way the reference has
  // to move on, because the provider treats the old one as taken and the
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

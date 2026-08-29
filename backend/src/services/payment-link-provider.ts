import { createHash } from 'crypto';

/**
 * Provider-agnostic payment-rail surface: links in, refunds out.
 *
 * The shape mirrors Razorpay's Payment Links and Refunds APIs — minor units,
 * INR, a caller-supplied reference the provider treats as unique — so the
 * rules above never learn which rail is behind them. Unlike payouts, which
 * need RazorpayX, both payment links and refunds work on ordinary test keys,
 * so the real implementation here is wired whenever credentials are present.
 *
 * There is exactly one Razorpay client in this codebase and it is the class
 * below. Refunds were added to it rather than beside it, because a second
 * client would mean a second place credentials are assembled and a second
 * place they could be logged.
 */

/** Razorpay's payment-link lifecycle, mirrored so a real provider maps on 1:1. */
export type PaymentLinkStatus = 'created' | 'partially_paid' | 'paid' | 'expired' | 'cancelled';

export interface PaymentLinkRequest {
  /**
   * Amount in paise. Providers price in minor units, and keeping rupee floats
   * out of the boundary means a rounding error cannot become a billing error.
   */
  amountPaise: number;
  currency: 'INR';
  /**
   * Deterministic key for this renewal. Razorpay rejects a reference id it has
   * already seen, so a retried tool call collides at the provider instead of
   * quietly billing the customer for a second policy term.
   */
  referenceId: string;
  /** Shown to the payer on the hosted page. */
  description: string;
}

export interface PaymentLink {
  id: string;
  status: PaymentLinkStatus;
  amountPaise: number;
  currency: 'INR';
  /** The URL to read out or send to the caller. */
  shortUrl: string;
  referenceId: string;
  /**
   * True when this came from SimulatedPaymentLinkProvider: the URL leads
   * nowhere and no payment can ever be made against it. Callers must persist
   * the flag, because a renewal recorded without it reads back as collectable.
   */
  simulated: boolean;
  createdAt: string;
}

/**
 * A capture the provider says happened against a link.
 *
 * Present only when the rail names a payment — the identifier a refund would
 * later be made against, and the identifier our own capture path keys on. A
 * provider that says "paid" without naming one has told us something true and
 * something unusable, and callers must be able to tell those apart.
 */
export interface PaymentLinkCapture {
  paymentId: string;
  /** Paise the rail says actually arrived. Its figure, never ours. */
  amountPaise: number;
  /** ISO timestamp of the capture, per the rail. */
  paidAt: string;
}

/**
 * What a provider says about a link that already exists.
 *
 * Deliberately a union on `reachable` rather than a status plus a nullable
 * error, and deliberately never thrown. `createPaymentLink` throws because
 * there is only one sane response to a failure there — refuse — but a status
 * read has three outcomes that matter and they are not interchangeable:
 *
 *   the link is payable        → it may still be handed to a customer
 *   the link is spent          → it must not be, and a new one is due
 *   we could not be told       → neither of the above has been established
 *
 * A thrown error collapses the third into whatever the `catch` decides, and
 * the overwhelmingly natural `catch` is "carry on as before" — which is the
 * precise behaviour that put an already-paid link in front of a caller. Making
 * the unreachable case a value the type system insists on handling is the
 * point of this shape.
 */
export type PaymentLinkStatusReport =
  | {
      reachable: true;
      id: string;
      /** The provider's own word for the link's state, never inferred. */
      status: PaymentLinkStatus;
      /** The link's face amount, in paise. */
      amountPaise: number;
      /** How much has been paid against it so far, in paise. */
      amountPaidPaise: number;
      referenceId: string | null;
      /** The capture behind a paid link, when the provider names one. */
      capture: PaymentLinkCapture | null;
      /** Mirrors PaymentLink.simulated: no money can have moved on a true. */
      simulated: boolean;
    }
  | {
      reachable: false;
      /** Why we could not be told — a timeout, a 5xx, a refused connection. */
      reason: string;
    };

export interface PaymentLinkStatusOptions {
  /**
   * Hard bound on how long the provider may take. The only caller is a rule
   * running while somebody is holding a phone, so an unbounded read is a
   * caller listening to silence.
   */
  timeoutMs?: number;
}

export interface PaymentLinkProvider {
  /** Recorded on the renewal row, so it states which rail issued the link. */
  readonly name: string;
  createPaymentLink(request: PaymentLinkRequest): Promise<PaymentLink>;
  /**
   * What the provider currently says about a link it already issued.
   *
   * OPTIONAL, and that is a compatibility decision rather than a statement
   * that the check is optional in practice. Both providers in this file
   * implement it, and `offerRenewal` treats a provider that does not as
   * indistinguishable from one that cannot be reached — so nothing gets a
   * softer answer by declining to implement it. It stays optional only so
   * that adding it does not break every existing implementation of this
   * interface at once.
   *
   * Implementations must resolve rather than throw wherever they can, and must
   * honour `timeoutMs`.
   */
  getPaymentLinkStatus?(
    paymentLinkId: string,
    options?: PaymentLinkStatusOptions
  ): Promise<PaymentLinkStatusReport>;
}

/** Razorpay's refund lifecycle, mirrored so a real provider maps on 1:1. */
export type RefundStatus = 'pending' | 'processed' | 'failed';

export interface RefundRequest {
  /**
   * The captured payment being refunded. Razorpay refunds against a payment,
   * never against the link that produced it, so a refund is only ever possible
   * once a capture has actually been recorded.
   */
  paymentId: string;
  /**
   * Amount in paise. Razorpay rejects anything above the captured amount, but
   * the caller is expected to have refused first: a rail's 400 is a worse
   * place to discover an over-refund than our own gate.
   */
  amountPaise: number;
  /**
   * Deterministic per-refund reference. Razorpay documents `receipt` as an
   * idempotency key scoped to the payment — a repeat comes back as
   * "Duplicate receipt found for this refund request" rather than as a second
   * refund — so a retried call collides at the provider instead of paying the
   * money back twice.
   */
  receipt: string;
  /** Free-form key/value pairs echoed back on the refund. */
  notes?: Record<string, string>;
}

export interface Refund {
  id: string;
  status: RefundStatus;
  amountPaise: number;
  currency: 'INR';
  paymentId: string;
  receipt: string;
  /**
   * True when this came from SimulatedPaymentLinkProvider: no money moved and
   * no card was credited. Callers must persist the flag, because a refund
   * recorded without it reads back as a real one.
   */
  simulated: boolean;
  createdAt: string;
}

export interface RefundProvider {
  /** Recorded on the row, so it states which rail carried the refund. */
  readonly name: string;
  createRefund(request: RefundRequest): Promise<Refund>;
  /**
   * What the rail says about a refund now, as opposed to what we wrote down
   * when we asked for it.
   *
   * A refund is issued `pending` and settles minutes to days later, so the
   * status stored at creation is a snapshot that goes stale. Anything showing a
   * claimant their refund should show the rail's current answer, not ours —
   * telling somebody their money is still pending when it cleared yesterday is
   * a small lie that costs trust, and the opposite is worse.
   *
   * Returns null when the refund is unknown to the rail rather than throwing:
   * a receipt that cannot be enriched should still render what we hold.
   */
  fetchRefund(refundId: string): Promise<Refund | null>;
}

/**
 * Both halves of the rail. The deductible loop needs the same provider to
 * issue the link money comes in on and to carry the refund it goes back out
 * on, because a refund can only be made against a payment that rail captured.
 */
export interface PaymentRailProvider extends PaymentLinkProvider, RefundProvider {}

const RAZORPAY_API_BASE = 'https://api.razorpay.com/v1';

/** Statuses Razorpay can return. Anything unrecognised is treated as created. */
const KNOWN_STATUSES = new Set<PaymentLinkStatus>([
  'created',
  'partially_paid',
  'paid',
  'expired',
  'cancelled',
]);

function toStatus(value: unknown): PaymentLinkStatus {
  return KNOWN_STATUSES.has(value as PaymentLinkStatus) ? (value as PaymentLinkStatus) : 'created';
}

/**
 * The same mapping for a *status read*, where the fallback above would be the
 * dangerous direction.
 *
 * On creation, treating an unrecognised status as 'created' is harmless: the
 * link was just made and the caller checks `short_url` anyway. On a read,
 * 'created' means "still payable", so guessing it would let a status Razorpay
 * adds tomorrow — some future terminal state — read back as a live offer and
 * be handed to a customer. Returning null instead lets the caller route an
 * unrecognised answer into the same branch as no answer at all.
 */
function toKnownStatus(value: unknown): PaymentLinkStatus | null {
  return KNOWN_STATUSES.has(value as PaymentLinkStatus) ? (value as PaymentLinkStatus) : null;
}

/** How long a status read may take before it is abandoned as unreachable. */
const RAZORPAY_STATUS_TIMEOUT_MS = 2_500;

/** Statuses Razorpay can return on a refund. */
const KNOWN_REFUND_STATUSES = new Set<RefundStatus>(['pending', 'processed', 'failed']);

/**
 * An unrecognised refund status becomes 'pending', never 'processed'. Guessing
 * upward would let a refund that never happened be recorded as one that did.
 */
function toRefundStatus(value: unknown): RefundStatus {
  return KNOWN_REFUND_STATUSES.has(value as RefundStatus) ? (value as RefundStatus) : 'pending';
}

export interface RazorpayPaymentLinkProviderOptions {
  baseUrl?: string;
  /** Injected in tests so the provider can be exercised without a network. */
  fetchImpl?: typeof fetch;
  /** Default bound on a status read. Per-call `timeoutMs` overrides it. */
  statusTimeoutMs?: number;
}

/**
 * Razorpay Payment Links and Refunds over HTTP Basic auth.
 *
 * Verified against the live test API: POST /v1/payment_links returns
 * `{ id, status: "created", amount, short_url }`. Failures throw rather than
 * returning a half-built link, so the caller refuses instead of reading out a
 * URL that does not exist. POST /v1/payments/:id/refund behaves the same way.
 *
 * Both are real money on ordinary test keys. Payouts are not — those need
 * RazorpayX and business KYC, which is why claim settlement still goes through
 * the simulated payout rail in payout-provider.ts and says so.
 */
export class RazorpayPaymentLinkProvider implements PaymentRailProvider {
  readonly name = 'razorpay';

  private readonly authorization: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly statusTimeoutMs: number;

  constructor(keyId: string, keySecret: string, options: RazorpayPaymentLinkProviderOptions = {}) {
    // Built once and never logged. The secret must not reach a log line, an
    // error message, or a stack trace that gets shipped somewhere.
    this.authorization = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
    this.baseUrl = options.baseUrl ?? RAZORPAY_API_BASE;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.statusTimeoutMs = options.statusTimeoutMs ?? RAZORPAY_STATUS_TIMEOUT_MS;
  }

  async createPaymentLink(request: PaymentLinkRequest): Promise<PaymentLink> {
    const response = await this.fetchImpl(`${this.baseUrl}/payment_links`, {
      method: 'POST',
      headers: {
        Authorization: this.authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: request.amountPaise,
        currency: request.currency,
        description: request.description,
        reference_id: request.referenceId,
        // We hold no verified contact details for the caller, and Razorpay
        // would otherwise message whatever we passed. The agent reads the URL
        // out on the call; nothing is sent on the customer's behalf.
        notify: { sms: false, email: false },
        reminder_enable: false,
      }),
    });

    if (!response.ok) {
      // The body is Razorpay's error envelope, not our credentials.
      const detail = await response.text().catch(() => '');
      throw new Error(`Razorpay payment link failed (${response.status}): ${detail.slice(0, 300)}`);
    }

    const body = (await response.json()) as Record<string, any>;

    if (!body?.id || !body?.short_url) {
      throw new Error('Razorpay payment link response was missing an id or short_url');
    }

    return {
      id: String(body.id),
      status: toStatus(body.status),
      // Echo the provider's figure rather than our own: if they disagree, the
      // one the payer will actually be charged is the one worth recording.
      amountPaise: Number(body.amount ?? request.amountPaise),
      currency: 'INR',
      shortUrl: String(body.short_url),
      referenceId: String(body.reference_id ?? request.referenceId),
      simulated: false,
      createdAt: body.created_at
        ? new Date(Number(body.created_at) * 1000).toISOString()
        : new Date().toISOString(),
    };
  }

  /**
   * GET /v1/payment_links/:id — what Razorpay currently says about a link.
   *
   * This exists because `policy_renewals.status` is only ever as fresh as the
   * last webhook that landed, and a webhook that never landed leaves a row
   * saying 'created' for a link that was paid weeks ago. Razorpay knew; we did
   * not; and the reuse path went on handing the dead URL to callers. Asking the
   * rail is the only way to hold the truth rather than a cached rumour.
   *
   * Nothing here throws. Every failure — a 4xx, a 5xx, a timeout, a socket
   * reset, a body that does not parse — comes back as `reachable: false` with
   * a reason, because the caller has a genuine decision to make in that case
   * and an exception is the wrong shape for a decision.
   *
   * A 404 is deliberately folded into unreachable rather than treated as a
   * spent link. Razorpay returns one for a link id it does not recognise, and
   * by far the likeliest cause is our own misconfiguration — keys pointing at
   * a different account from the one that issued the link. Concluding "this
   * link is dead" from what is really "we are asking the wrong place" would
   * re-issue a live demand and bill somebody twice.
   */
  async getPaymentLinkStatus(
    paymentLinkId: string,
    options: PaymentLinkStatusOptions = {}
  ): Promise<PaymentLinkStatusReport> {
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.statusTimeoutMs);

    // The bound is on the socket, not merely on how long we wait for it: an
    // abandoned request left running against a rail that is already struggling
    // is a second problem on top of the first.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/payment_links/${encodeURIComponent(paymentLinkId)}`,
        {
          method: 'GET',
          headers: { Authorization: this.authorization },
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        // The body is Razorpay's error envelope, not our credentials.
        const detail = await response.text().catch(() => '');
        return {
          reachable: false,
          reason: `Razorpay answered ${response.status} for payment link ${paymentLinkId}: ${detail.slice(0, 200)}`,
        };
      }

      const body = (await response.json()) as Record<string, any>;
      const status = toKnownStatus(body?.status);

      if (!status) {
        return {
          reachable: false,
          reason: `Razorpay reported an unrecognised status ${JSON.stringify(body?.status ?? null)} for payment link ${paymentLinkId}`,
        };
      }

      // Razorpay reports the captures on the link as `payments[]`. Only a
      // captured one is money we actually hold; an 'authorized' or 'failed'
      // entry is an attempt, and treating an attempt as a capture would put a
      // policy back in force for money that never settled.
      const payments: any[] = Array.isArray(body?.payments) ? body.payments : [];
      const captured = payments.find(
        (payment) => payment?.status === 'captured' && payment?.payment_id
      );

      return {
        reachable: true,
        id: String(body?.id ?? paymentLinkId),
        status,
        amountPaise: Number(body?.amount ?? 0),
        amountPaidPaise: Number(body?.amount_paid ?? 0),
        referenceId: body?.reference_id != null ? String(body.reference_id) : null,
        capture: captured
          ? {
              paymentId: String(captured.payment_id),
              // The rail's figure for this payment, falling back to what it
              // says the link has taken overall.
              amountPaise: Number(captured.amount ?? body?.amount_paid ?? 0),
              paidAt: captured.created_at
                ? new Date(Number(captured.created_at) * 1000).toISOString()
                : new Date().toISOString(),
            }
          : null,
        simulated: false,
      };
    } catch (error) {
      // An abort lands here too, and reads as exactly what it is: we ran out
      // of time and were not told.
      return {
        reachable: false,
        reason: `Razorpay could not be asked about payment link ${paymentLinkId}: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * POST /v1/payments/:id/refund.
   *
   * `speed: 'normal'` is stated rather than left to the default, because the
   * instant rail ('optimum') carries a fee and is not always available; a
   * refund that quietly costs more than expected is not an improvement.
   */
  async createRefund(request: RefundRequest): Promise<Refund> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/payments/${encodeURIComponent(request.paymentId)}/refund`,
      {
        method: 'POST',
        headers: {
          Authorization: this.authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: request.amountPaise,
          speed: 'normal',
          receipt: request.receipt,
          ...(request.notes ? { notes: request.notes } : {}),
        }),
      }
    );

    if (!response.ok) {
      // The body is Razorpay's error envelope, not our credentials. A repeated
      // receipt lands here as a 400 rather than as a second refund, which is
      // the provider-side half of the idempotency guarantee.
      const detail = await response.text().catch(() => '');
      throw new Error(`Razorpay refund failed (${response.status}): ${detail.slice(0, 300)}`);
    }

    const body = (await response.json()) as Record<string, any>;

    if (!body?.id) {
      throw new Error('Razorpay refund response was missing an id');
    }

    return {
      id: String(body.id),
      status: toRefundStatus(body.status),
      // Echo the provider's figure rather than our own: if they disagree, the
      // one actually credited back is the one worth recording.
      amountPaise: Number(body.amount ?? request.amountPaise),
      currency: 'INR',
      paymentId: String(body.payment_id ?? request.paymentId),
      receipt: String(body.receipt ?? request.receipt),
      simulated: false,
      createdAt: body.created_at
        ? new Date(Number(body.created_at) * 1000).toISOString()
        : new Date().toISOString(),
    };
  }

  /**
   * GET /v1/refunds/:id — the rail's current word on a refund we already made.
   *
   * Read-only, and it never throws for an unknown id. The caller is rendering a
   * receipt; failing the whole page because the rail is briefly unreachable
   * would be a worse answer than showing the figures already on record and
   * saying they are ours rather than the rail's.
   */
  async fetchRefund(refundId: string): Promise<Refund | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/refunds/${encodeURIComponent(refundId)}`, {
        headers: { Authorization: this.authorization },
      });
    } catch {
      return null;
    }

    if (!response.ok) return null;

    const body = (await response.json().catch(() => null)) as Record<string, any> | null;
    if (!body?.id) return null;

    return {
      id: String(body.id),
      status: toRefundStatus(body.status),
      amountPaise: Number(body.amount ?? 0),
      currency: 'INR',
      paymentId: String(body.payment_id ?? ''),
      receipt: String(body.receipt ?? ''),
      simulated: false,
      createdAt: body.created_at
        ? new Date(Number(body.created_at) * 1000).toISOString()
        : new Date().toISOString(),
    };
  }
}

/**
 * In-process stand-in used when no Razorpay credentials are configured.
 *
 * It honours the reference id rather than merely accepting it: replaying one
 * returns the first link and creates nothing new. That is the property the
 * renewal path depends on, so it has to hold in the simulation too. The URL
 * uses the reserved `.invalid` TLD so it can never resolve — a simulated link
 * that looked plausible is a simulated link somebody will try to pay.
 */
export class SimulatedPaymentLinkProvider implements PaymentRailProvider {
  readonly name = 'simulated';

  private readonly byReference = new Map<string, PaymentLink>();
  private readonly refundsByReceipt = new Map<string, Refund>();

  async createPaymentLink(request: PaymentLinkRequest): Promise<PaymentLink> {
    const existing = this.byReference.get(request.referenceId);
    if (existing) return existing;

    // Derived from the reference so the same renewal always carries the same
    // identifiers, even across a restart that empties the map.
    const fingerprint = createHash('sha256').update(request.referenceId).digest('hex');

    const link: PaymentLink = {
      // Prefixed so a simulated link is obvious in logs and on the renewal row
      // without having to look up the accompanying flag.
      id: `plink_sim_${fingerprint.slice(0, 14)}`,
      status: 'created',
      amountPaise: request.amountPaise,
      currency: request.currency,
      shortUrl: `https://simulated-payments.safeguard.invalid/l/${fingerprint.slice(0, 12)}`,
      referenceId: request.referenceId,
      simulated: true,
      createdAt: new Date().toISOString(),
    };

    this.byReference.set(request.referenceId, link);
    return link;
  }

  /**
   * What this simulation holds for a link, which is the whole truth about it.
   *
   * Two cases, and the second is the interesting one.
   *
   * A link still in the map answers with the status it holds — 'created',
   * always, because nothing in this class ever moves one. That is not a gap:
   * a simulated link's URL is on the reserved `.invalid` TLD, so it can never
   * be paid, and there is no provider anywhere to expire it.
   *
   * A link NOT in the map answers 'created' as well, rather than reporting
   * itself unreachable. The map is per-process and empties on every restart,
   * while the rows that name these links outlive it, so "not in the map" is
   * the ordinary state of an old simulated link and says nothing about it.
   * Reporting unreachable there would mean that with no credentials configured
   * — the default for local work and for the demo — every renewal on a policy
   * that already has a link is refused after a restart. The honest answer is
   * the one that is true of every simulated link ever issued: nobody paid it,
   * nobody could have, and it is exactly as payable as it was on day one.
   */
  async getPaymentLinkStatus(paymentLinkId: string): Promise<PaymentLinkStatusReport> {
    const held = [...this.byReference.values()].find((link) => link.id === paymentLinkId);

    return {
      reachable: true,
      id: paymentLinkId,
      status: held?.status ?? 'created',
      amountPaise: held?.amountPaise ?? 0,
      // Never anything else. No money has moved, and a simulation that hinted
      // otherwise would be a simulation somebody acts on.
      amountPaidPaise: 0,
      referenceId: held?.referenceId ?? null,
      capture: null,
      simulated: true,
    };
  }

  /**
   * A simulated refund of a payment that was never really captured.
   *
   * It honours the receipt the same way Razorpay does: replaying one returns
   * the first refund and creates nothing new.
   */
  async createRefund(request: RefundRequest): Promise<Refund> {
    const existing = this.refundsByReceipt.get(request.receipt);
    if (existing) return existing;

    const fingerprint = createHash('sha256').update(request.receipt).digest('hex');

    const refund: Refund = {
      // Prefixed so a simulated refund is obvious in logs and on the row
      // without having to look up the accompanying flag.
      id: `rfnd_sim_${fingerprint.slice(0, 14)}`,
      status: 'processed',
      amountPaise: request.amountPaise,
      currency: 'INR',
      paymentId: request.paymentId,
      receipt: request.receipt,
      simulated: true,
      createdAt: new Date().toISOString(),
    };

    this.refundsByReceipt.set(request.receipt, refund);
    return refund;
  }

  /**
   * The simulated rail answers only for refunds it issued itself.
   *
   * It does not invent a record for an unknown id, because a stand-in that
   * answers for a refund it never made would let a receipt render for money
   * that never moved — which is the one thing this whole file is careful about.
   */
  async fetchRefund(refundId: string): Promise<Refund | null> {
    for (const refund of this.refundsByReceipt.values()) {
      if (refund.id === refundId) return refund;
    }
    return null;
  }

  /** Every distinct link this provider has created, in creation order. */
  issued(): PaymentLink[] {
    return [...this.byReference.values()];
  }

  /** Every distinct refund this provider has carried, in creation order. */
  refunded(): Refund[] {
    return [...this.refundsByReceipt.values()];
  }
}

/**
 * Real when credentials exist, simulated otherwise — never both, and never a
 * simulated link presented as real. Credentials are passed in rather than read
 * from config here, so this module stays free of the environment and of the
 * import cycle that would create.
 */
export function createPaymentLinkProvider(credentials: {
  keyId: string | null;
  keySecret: string | null;
}): PaymentRailProvider {
  if (credentials.keyId && credentials.keySecret) {
    return new RazorpayPaymentLinkProvider(credentials.keyId, credentials.keySecret);
  }
  return new SimulatedPaymentLinkProvider();
}

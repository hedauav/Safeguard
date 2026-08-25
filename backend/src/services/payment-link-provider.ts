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

export interface PaymentLinkProvider {
  /** Recorded on the renewal row, so it states which rail issued the link. */
  readonly name: string;
  createPaymentLink(request: PaymentLinkRequest): Promise<PaymentLink>;
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

  constructor(keyId: string, keySecret: string, options: RazorpayPaymentLinkProviderOptions = {}) {
    // Built once and never logged. The secret must not reach a log line, an
    // error message, or a stack trace that gets shipped somewhere.
    this.authorization = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
    this.baseUrl = options.baseUrl ?? RAZORPAY_API_BASE;
    this.fetchImpl = options.fetchImpl ?? fetch;
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

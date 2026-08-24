import { createHash } from 'crypto';

/**
 * Provider-agnostic payment-link surface.
 *
 * The shape mirrors Razorpay's Payment Links API — minor units, INR, a
 * caller-supplied reference id that the provider treats as unique — so the
 * renewal rules never learn which rail is behind them. Unlike payouts, which
 * need RazorpayX, payment links work on ordinary test keys, so the real
 * implementation here is wired whenever credentials are present.
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

export interface RazorpayPaymentLinkProviderOptions {
  baseUrl?: string;
  /** Injected in tests so the provider can be exercised without a network. */
  fetchImpl?: typeof fetch;
}

/**
 * Razorpay Payment Links over HTTP Basic auth.
 *
 * Verified against the live test API: POST /v1/payment_links returns
 * `{ id, status: "created", amount, short_url }`. Failures throw rather than
 * returning a half-built link, so the caller refuses instead of reading out a
 * URL that does not exist.
 */
export class RazorpayPaymentLinkProvider implements PaymentLinkProvider {
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
export class SimulatedPaymentLinkProvider implements PaymentLinkProvider {
  readonly name = 'simulated';

  private readonly byReference = new Map<string, PaymentLink>();

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

  /** Every distinct link this provider has created, in creation order. */
  issued(): PaymentLink[] {
    return [...this.byReference.values()];
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
}): PaymentLinkProvider {
  if (credentials.keyId && credentials.keySecret) {
    return new RazorpayPaymentLinkProvider(credentials.keyId, credentials.keySecret);
  }
  return new SimulatedPaymentLinkProvider();
}

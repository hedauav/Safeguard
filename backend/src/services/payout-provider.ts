import { createHash } from 'crypto';

/**
 * Provider-agnostic payout surface.
 *
 * The shape mirrors Razorpay's Payouts API — minor units, INR, a transfer
 * mode, a purpose, and an idempotency key — so a real provider can be dropped
 * in behind `PayoutProvider` without the settlement rules changing. Only a
 * simulated provider is wired today.
 */

/** Razorpay's payout lifecycle, mirrored so a real provider maps on to it 1:1. */
export type PayoutStatus = 'queued' | 'processing' | 'processed' | 'reversed' | 'failed';

/** Transfer rail. Razorpay picks the rail per payout; we ask for one. */
export type PayoutMode = 'IMPS' | 'NEFT' | 'RTGS' | 'UPI';

export interface PayoutRequest {
  /**
   * Amount in paise. Providers settle in minor units, and keeping rupee floats
   * out of the boundary means a rounding error cannot become a payment error.
   */
  amountPaise: number;
  currency: 'INR';
  mode: PayoutMode;
  /** Razorpay's `purpose` field. */
  purpose: string;
  /**
   * Deterministic key for this settlement. A retried tool call or a redelivered
   * webhook must present the same key, so the provider recognises the request
   * as one it has already carried out instead of paying a second time.
   */
  idempotencyKey: string;
  /** Our own reference, echoed back by the provider — the claim number. */
  referenceId: string;
  narration: string;
}

export interface Payout {
  id: string;
  status: PayoutStatus;
  amountPaise: number;
  currency: 'INR';
  mode: PayoutMode;
  /** Bank reference for the transfer, once the rail has assigned one. */
  utr: string | null;
  /**
   * True when this came from SimulatedPayoutProvider: no money moved and no
   * bank saw it. Callers must persist the flag, because a settlement recorded
   * without it would read back as a real disbursement.
   */
  simulated: boolean;
  idempotencyKey: string;
  createdAt: string;
}

export interface PayoutProvider {
  /** Recorded on the claim, so the row states which rail produced the payout. */
  readonly name: string;
  createPayout(request: PayoutRequest): Promise<Payout>;
}

/**
 * In-process stand-in for a real payout rail.
 *
 * It honours the idempotency key rather than merely accepting it: replaying a
 * key returns the first payout and creates nothing new. That is the property
 * the settlement path depends on, so it has to hold in the simulation too.
 */
export class SimulatedPayoutProvider implements PayoutProvider {
  readonly name = 'simulated';

  private readonly byKey = new Map<string, Payout>();

  async createPayout(request: PayoutRequest): Promise<Payout> {
    const existing = this.byKey.get(request.idempotencyKey);
    if (existing) return existing;

    // Derived from the key so the same settlement always carries the same
    // identifiers, even across a restart that empties the map.
    const fingerprint = createHash('sha256').update(request.idempotencyKey).digest('hex');

    const payout: Payout = {
      // Prefixed so a simulated payout is obvious in logs and on the claim row
      // without having to look up the accompanying flag.
      id: `pout_sim_${fingerprint.slice(0, 14)}`,
      status: 'processed',
      amountPaise: request.amountPaise,
      currency: request.currency,
      mode: request.mode,
      utr: `SIMUTR${fingerprint.slice(0, 12).toUpperCase()}`,
      simulated: true,
      idempotencyKey: request.idempotencyKey,
      createdAt: new Date().toISOString(),
    };

    this.byKey.set(request.idempotencyKey, payout);
    return payout;
  }

  /** Every distinct payout this provider has created, in creation order. */
  issued(): Payout[] {
    return [...this.byKey.values()];
  }
}

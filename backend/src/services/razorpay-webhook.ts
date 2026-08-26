import crypto from 'crypto';

/**
 * Parsing and verification for Razorpay webhooks.
 *
 * Reference: https://razorpay.com/docs/webhooks/validate-test/
 *            https://razorpay.com/docs/webhooks/payloads/payment-links/
 *
 * Razorpay's construction is NOT the one ElevenLabs uses. ElevenLabs signs
 * `${timestamp}.${body}` and puts the timestamp in the header, which gives a
 * replay window for free. Razorpay signs the raw body and nothing else:
 *
 *     X-Razorpay-Signature: <hex hmac-sha256(rawBody, webhookSecret)>
 *
 * There is no timestamp in the header and no id in the body, so a captured
 * delivery stays valid forever and replays identically. The replay guard here
 * is therefore not a tolerance window — it is the event ledger the caller
 * keeps: every delivery is recorded under `x-razorpay-event-id` and a second
 * arrival of the same id is skipped. `MAX_EVENT_AGE_SECONDS` below only bounds
 * how ancient a delivery may be, and is deliberately generous because Razorpay
 * retries a failed webhook for up to 24 hours and those retries are real.
 *
 * Razorpay's own docs are emphatic on one point, and getting it wrong is the
 * usual reason verification fails: the HMAC must be taken over the raw request
 * body, byte for byte. A parsed-and-restringified body is a different message.
 */

/** Razorpay's header carrying the hex HMAC. */
export const RAZORPAY_SIGNATURE_HEADER = 'x-razorpay-signature';

/**
 * Razorpay's per-delivery id. Not part of the signed body — it is the handle
 * the ledger dedupes on, so a redelivery is recognised rather than re-applied.
 */
export const RAZORPAY_EVENT_ID_HEADER = 'x-razorpay-event-id';

/**
 * Oldest delivery we will act on, measured against the event's own
 * `created_at`. Generous on purpose: Razorpay's retry schedule runs for about
 * 24 hours, and rejecting a genuine retry loses the capture. Anything older is
 * not a retry, it is a replay of a recording, and the ledger would catch it
 * anyway — this is the belt to that pair of braces.
 */
export const MAX_EVENT_AGE_SECONDS = 48 * 60 * 60;

export type RazorpaySignatureVerdict =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Verify the `X-Razorpay-Signature` header against the raw body.
 *
 * Constant-time, with the length check first because `timingSafeEqual` throws
 * on mismatched buffer lengths and a thrown error leaks the length as surely
 * as an early return would.
 */
export function verifyRazorpaySignature(
  headerValue: string | undefined,
  rawBody: string,
  secret: string
): RazorpaySignatureVerdict {
  if (!headerValue) {
    return { valid: false, reason: 'Missing X-Razorpay-Signature header' };
  }
  if (!secret) {
    // Never reached in the route — it fails closed before calling here — but
    // an empty key would otherwise produce a perfectly valid-looking HMAC that
    // any attacker could also compute.
    return { valid: false, reason: 'No webhook secret configured' };
  }

  const provided = headerValue.trim();

  // Razorpay sends lowercase hex. Anything else cannot be a signature, and
  // rejecting it here keeps non-hex out of the comparison below.
  if (!/^[0-9a-f]+$/i.test(provided)) {
    return { valid: false, reason: 'Signature is not hexadecimal' };
  }

  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');

  const providedBuf = Buffer.from(provided.toLowerCase(), 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');

  if (providedBuf.length !== expectedBuf.length) {
    return { valid: false, reason: 'Signature mismatch' };
  }
  if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return { valid: false, reason: 'Signature mismatch' };
  }

  return { valid: true };
}

/** The Razorpay event envelope, narrowed to the fields this server reads. */
export interface RazorpayEventEnvelope {
  entity?: string;
  account_id?: string;
  event?: string;
  contains?: string[];
  /** Unix seconds. The only time reference Razorpay gives us. */
  created_at?: number;
  payload?: {
    payment?: { entity?: Record<string, any> };
    payment_link?: { entity?: Record<string, any> };
    order?: { entity?: Record<string, any> };
    refund?: { entity?: Record<string, any> };
  };
}

/**
 * A capture we can act on: a payment link was paid and the payment behind it
 * is genuinely in `captured` state.
 */
export interface RazorpayCapture {
  event: string;
  paymentLinkId: string;
  /** Our own reference id, echoed back — how the row is found. */
  referenceId: string | null;
  paymentId: string;
  /** Paise actually captured, taken from the payment, not from the link. */
  capturedAmountPaise: number;
  currency: string;
  /** The link's status as Razorpay reports it: 'paid' or 'partially_paid'. */
  linkStatus: string;
  createdAt: string;
}

export type CaptureExtraction =
  | { kind: 'capture'; capture: RazorpayCapture }
  | { kind: 'ignored'; reason: string };

/**
 * Events that carry a capture worth recording. `payment_link.partially_paid`
 * is deliberately absent: a part payment does not settle a deductible, and
 * treating it as one would let someone pay a rupee and be recorded as square.
 */
const CAPTURE_EVENTS = new Set(['payment_link.paid']);

/**
 * Pull a capture out of an event, or say why there is nothing to act on.
 *
 * Every rejection here is an *acknowledged* one: the delivery was authentic,
 * it just carries no capture. The caller answers 200 so Razorpay stops
 * retrying, and records nothing.
 *
 * Note what this does NOT decide: whether the capture is a deductible or a
 * renewal. Both live in the same Razorpay account and produce byte-identical
 * event shapes; only the payment link id tells them apart, and that lookup
 * belongs to the handlers, not to the parser.
 */
export function extractCapture(envelope: RazorpayEventEnvelope): CaptureExtraction {
  const event = envelope.event ?? '';

  if (!CAPTURE_EVENTS.has(event)) {
    return { kind: 'ignored', reason: `event ${event || '(none)'} carries no capture` };
  }

  const link = envelope.payload?.payment_link?.entity;
  const payment = envelope.payload?.payment?.entity;

  if (!link?.id) {
    return { kind: 'ignored', reason: 'payload has no payment_link entity' };
  }
  if (!payment?.id) {
    return { kind: 'ignored', reason: 'payload has no payment entity' };
  }

  // The payment, not the link, is the authority on whether money moved — and
  // only a captured payment can ever be refunded, which is the whole point of
  // recording it.
  if (payment.status !== 'captured') {
    return { kind: 'ignored', reason: `payment status is ${payment.status ?? '(none)'}` };
  }

  // `amount_captured` is the figure the rail will let us refund against.
  // Falling back to `amount` covers older payload shapes; a zero or absent
  // figure is not a capture.
  const capturedAmountPaise = Number(payment.amount_captured ?? payment.amount ?? 0);
  if (!Number.isFinite(capturedAmountPaise) || capturedAmountPaise <= 0) {
    return { kind: 'ignored', reason: 'payment carries no captured amount' };
  }

  return {
    kind: 'capture',
    capture: {
      event,
      paymentLinkId: String(link.id),
      referenceId: link.reference_id != null ? String(link.reference_id) : null,
      paymentId: String(payment.id),
      capturedAmountPaise: Math.round(capturedAmountPaise),
      currency: String(payment.currency ?? 'INR'),
      linkStatus: String(link.status ?? 'paid'),
      createdAt: payment.created_at
        ? new Date(Number(payment.created_at) * 1000).toISOString()
        : new Date().toISOString(),
    },
  };
}

/**
 * A delivery saying the money did NOT arrive.
 *
 * Until this existed both of these were dropped on the floor: `extractCapture`
 * returned `ignored`, the route answered 200, and nobody — not the customer,
 * not the dashboard, not a reconciler — could tell "nobody has paid yet" apart
 * from "the payment was attempted and the bank declined it". Those are
 * different facts and a customer waiting for a policy to come back in force
 * deserves the second one.
 *
 * `paymentId` is nullable because the two events are not the same shape: a
 * `payment.failed` has a payment behind it, an expired link never had one.
 */
export interface RazorpayPaymentFailure {
  event: string;
  /** Which of the two happened, so a handler can branch without re-parsing. */
  kind: 'payment_failed' | 'link_expired';
  paymentLinkId: string;
  /** Our own reference id, echoed back, when the payload carries the link. */
  referenceId: string | null;
  paymentId: string | null;
  /** Razorpay's own words for why. Never ours, and never a guess. */
  errorCode: string | null;
  errorDescription: string | null;
  errorReason: string | null;
  createdAt: string;
}

export type FailureExtraction =
  | { kind: 'failure'; failure: RazorpayPaymentFailure }
  | { kind: 'ignored'; reason: string };

/**
 * Events that say a payment will not be arriving from this attempt.
 *
 * `payment_link.cancelled` is deliberately absent: nothing in this system
 * cancels a link, so a cancellation is somebody acting in the Razorpay
 * dashboard and the right response is to leave our row alone and let them say
 * what they did.
 */
const FAILURE_EVENTS = new Set(['payment.failed', 'payment_link.expired']);

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

/**
 * Pull a failure out of an event, or say why there is nothing to act on.
 *
 * The hard part is the link id. `payment_link.expired` carries the link
 * entity, so it is direct. `payment.failed` carries only the payment, and
 * whether that payment names its link depends on the API version Razorpay
 * sends — so we look in every place it has been seen and, finding none,
 * *ignore the event* rather than attribute the failure to a guess. An
 * unattributable failure recorded against the wrong renewal would be worse
 * than one not recorded at all.
 */
export function extractFailure(envelope: RazorpayEventEnvelope): FailureExtraction {
  const event = envelope.event ?? '';

  if (!FAILURE_EVENTS.has(event)) {
    return { kind: 'ignored', reason: `event ${event || '(none)'} carries no failure` };
  }

  const link = envelope.payload?.payment_link?.entity;
  const payment = envelope.payload?.payment?.entity;

  const paymentLinkId = firstString(
    link?.id,
    payment?.payment_link_id,
    payment?.notes?.payment_link_id
  );

  if (!paymentLinkId) {
    return {
      kind: 'ignored',
      reason: `${event} names no payment link, so it cannot be attributed`,
    };
  }

  // A `payment.failed` for a payment that is not actually failed is somebody
  // else's event shape. Only the payment is authoritative about the payment.
  if (event === 'payment.failed' && payment && payment.status && payment.status !== 'failed') {
    return { kind: 'ignored', reason: `payment status is ${payment.status}` };
  }

  const createdAtSeconds = payment?.created_at ?? link?.expired_at ?? link?.updated_at;

  return {
    kind: 'failure',
    failure: {
      event,
      kind: event === 'payment.failed' ? 'payment_failed' : 'link_expired',
      paymentLinkId,
      referenceId: firstString(link?.reference_id),
      paymentId: firstString(payment?.id),
      errorCode: firstString(payment?.error_code),
      errorDescription: firstString(payment?.error_description),
      errorReason: firstString(payment?.error_reason, payment?.error_source),
      createdAt: createdAtSeconds
        ? new Date(Number(createdAtSeconds) * 1000).toISOString()
        : new Date().toISOString(),
    },
  };
}

export type PaymentEventExtraction =
  | { kind: 'capture'; capture: RazorpayCapture }
  | { kind: 'failure'; failure: RazorpayPaymentFailure }
  | { kind: 'ignored'; reason: string };

/**
 * The one entry point the route uses: capture, failure, or neither.
 *
 * Capture is tried first because it is the only branch that moves money into
 * our records, and `extractCapture` stays untouched and separately tested — a
 * paid link must not start behaving differently because failure handling was
 * added beside it.
 *
 * An `ignored` result here still means *authentic*. It is an event for another
 * product on the same Razorpay account, or a shape we deliberately do not act
 * on, and the caller answers 200 so Razorpay stops retrying it.
 */
export function extractPaymentEvent(envelope: RazorpayEventEnvelope): PaymentEventExtraction {
  const capture = extractCapture(envelope);
  if (capture.kind === 'capture') return capture;

  const failure = extractFailure(envelope);
  if (failure.kind === 'failure') return failure;

  // Both said no. Report the more specific of the two reasons: if the event
  // was a capture event that failed a later gate ("payment status is
  // authorized"), that is what an operator needs to read, not the generic
  // "carries no failure" the failure parser produced for the same envelope.
  const reason = CAPTURE_EVENTS.has(envelope.event ?? '') ? capture.reason : failure.reason;
  return { kind: 'ignored', reason };
}

/**
 * Whether an event is recent enough to act on. See MAX_EVENT_AGE_SECONDS —
 * this bounds ancient replays, it does not provide replay protection.
 * An envelope with no `created_at` is accepted: Razorpay always sends one, and
 * refusing on its absence would be a guess dressed as a check.
 */
export function withinAgeLimit(
  envelope: RazorpayEventEnvelope,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  maxAgeSeconds: number = MAX_EVENT_AGE_SECONDS
): boolean {
  const createdAt = envelope.created_at;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return true;
  return nowSeconds - createdAt <= maxAgeSeconds;
}

/**
 * Stable id for a delivery.
 *
 * Razorpay's own per-delivery id when the header is present, which is what
 * makes a retry recognisable. When it is absent the digest of the raw body
 * stands in: two byte-identical deliveries are the same event, and that is the
 * property the ledger needs. Prefixed differently so a row's provenance is
 * legible without a second column.
 */
export function eventLedgerId(headerValue: string | undefined, rawBody: string): string {
  const provided = (headerValue ?? '').trim();
  if (provided) return `evt_${provided}`;
  return `bdy_${crypto.createHash('sha256').update(rawBody, 'utf8').digest('hex').slice(0, 40)}`;
}

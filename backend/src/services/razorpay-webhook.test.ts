import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  MAX_EVENT_AGE_SECONDS,
  eventLedgerId,
  extractCapture,
  verifyRazorpaySignature,
  withinAgeLimit,
  type RazorpayEventEnvelope,
} from './razorpay-webhook.js';

const SECRET = 'whsec_razorpay_test';

/** Sign a body the way Razorpay does: hex HMAC-SHA256 over the raw bytes. */
function sign(rawBody: string, secret = SECRET): string {
  return crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * The `payment_link.paid` envelope, trimmed to the fields this server reads
 * but keeping Razorpay's real nesting — `payload.payment_link.entity` and
 * `payload.payment.entity`. Reading fields off the payload root, as is easy to
 * do, yields undefined for every one of them.
 */
function paidEvent(overrides: {
  linkId?: string;
  referenceId?: string;
  paymentId?: string;
  amount?: number;
  paymentStatus?: string;
  linkStatus?: string;
  event?: string;
  createdAt?: number;
} = {}): RazorpayEventEnvelope {
  const amount = overrides.amount ?? 50000;
  return {
    entity: 'event',
    account_id: 'acc_TEST',
    event: overrides.event ?? 'payment_link.paid',
    contains: ['payment_link', 'order', 'payment'],
    created_at: overrides.createdAt ?? Math.floor(Date.now() / 1000),
    payload: {
      payment: {
        entity: {
          id: overrides.paymentId ?? 'pay_TESTCAPTURE01',
          entity: 'payment',
          amount,
          amount_captured: amount,
          amount_refunded: 0,
          currency: 'INR',
          status: overrides.paymentStatus ?? 'captured',
          captured: true,
          method: 'upi',
          created_at: 1749809938,
        },
      },
      payment_link: {
        entity: {
          id: overrides.linkId ?? 'plink_TESTLINK01',
          amount,
          amount_paid: amount,
          currency: 'INR',
          reference_id: overrides.referenceId ?? 'ded_abc123',
          short_url: 'https://rzp.io/i/testlink',
          status: overrides.linkStatus ?? 'paid',
        },
      },
    },
  };
}

// --- Signature verification -------------------------------------------------

test('a correctly signed body verifies', () => {
  const body = JSON.stringify(paidEvent());
  assert.deepEqual(verifyRazorpaySignature(sign(body), body, SECRET), { valid: true });
});

test('a bad signature is rejected', () => {
  const body = JSON.stringify(paidEvent());
  // Same length, same alphabet, wrong value — so this exercises the HMAC
  // comparison itself rather than the length or shape guards above it.
  const bad = sign(body).replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));

  const verdict = verifyRazorpaySignature(bad, body, SECRET);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.valid === false && verdict.reason, 'Signature mismatch');
});

test('a signature made with the wrong secret is rejected', () => {
  const body = JSON.stringify(paidEvent());
  const verdict = verifyRazorpaySignature(sign(body, 'someone-elses-secret'), body, SECRET);
  assert.equal(verdict.valid, false);
});

test('a body tampered with after signing is rejected', () => {
  // The attack the signature exists to stop: a real delivery, replayed with
  // the amount raised so a bigger refund could be made against it.
  const original = JSON.stringify(paidEvent({ amount: 50000 }));
  const signature = sign(original);
  const tampered = JSON.stringify(paidEvent({ amount: 5000000 }));

  assert.equal(verifyRazorpaySignature(signature, original, SECRET).valid, true);
  assert.equal(verifyRazorpaySignature(signature, tampered, SECRET).valid, false);
});

test('a missing signature header is rejected, not treated as absent-and-fine', () => {
  const body = JSON.stringify(paidEvent());
  const verdict = verifyRazorpaySignature(undefined, body, SECRET);
  assert.equal(verdict.valid, false);
  assert.match(verdict.valid === false ? verdict.reason : '', /Missing/);
});

test('a non-hexadecimal signature is rejected before the comparison', () => {
  const body = JSON.stringify(paidEvent());
  const verdict = verifyRazorpaySignature('not-a-signature!!', body, SECRET);
  assert.equal(verdict.valid, false);
  assert.match(verdict.valid === false ? verdict.reason : '', /hexadecimal/);
});

test('an empty secret verifies nothing, however well-formed the signature', () => {
  // An empty key still produces a valid HMAC — one anybody could compute. This
  // must never read as a pass.
  const body = JSON.stringify(paidEvent());
  const verdict = verifyRazorpaySignature(sign(body, ''), body, '');
  assert.equal(verdict.valid, false);
});

test('a signature of a length other than the digest is rejected without throwing', () => {
  // timingSafeEqual throws on mismatched buffer lengths; the length check has
  // to come first or a short signature becomes a 500 instead of a 401.
  const body = JSON.stringify(paidEvent());
  assert.equal(verifyRazorpaySignature('abcdef', body, SECRET).valid, false);
});

test('the signature covers the raw bytes, not a re-serialised object', () => {
  // Razorpay is emphatic about this and it is the usual reason integrations
  // fail: JSON.stringify(JSON.parse(body)) is a different message whenever key
  // order or whitespace differs.
  const raw = '{"event":"payment_link.paid",  "created_at":123}';
  const signature = sign(raw);
  const reserialised = JSON.stringify(JSON.parse(raw));

  assert.equal(verifyRazorpaySignature(signature, raw, SECRET).valid, true);
  assert.notEqual(raw, reserialised);
  assert.equal(verifyRazorpaySignature(signature, reserialised, SECRET).valid, false);
});

// --- Age bound --------------------------------------------------------------

test('a fresh event is within the age limit', () => {
  const now = 1_700_000_000;
  assert.equal(withinAgeLimit(paidEvent({ createdAt: now - 30 }), now), true);
});

test("Razorpay's own day-long retries are still within the limit", () => {
  // The limit bounds ancient replays; the event ledger is what stops a replay.
  // Sizing this window tightly would throw away genuine retries and lose
  // captures, which is the more expensive mistake.
  const now = 1_700_000_000;
  assert.equal(withinAgeLimit(paidEvent({ createdAt: now - 23 * 60 * 60 }), now), true);
});

test('an event older than the limit is outside it', () => {
  const now = 1_700_000_000;
  assert.equal(withinAgeLimit(paidEvent({ createdAt: now - MAX_EVENT_AGE_SECONDS - 1 }), now), false);
});

test('an envelope with no created_at is not refused on a guess', () => {
  assert.equal(withinAgeLimit({ event: 'payment_link.paid' }, 1_700_000_000), true);
});

// --- Capture extraction -----------------------------------------------------

test('a paid link yields the capture, read from the payment not the link', () => {
  const extraction = extractCapture(
    paidEvent({ linkId: 'plink_X', paymentId: 'pay_X', referenceId: 'ded_ref', amount: 150000 })
  );

  assert.equal(extraction.kind, 'capture');
  if (extraction.kind !== 'capture') return;
  assert.equal(extraction.capture.paymentLinkId, 'plink_X');
  assert.equal(extraction.capture.paymentId, 'pay_X');
  assert.equal(extraction.capture.referenceId, 'ded_ref');
  assert.equal(extraction.capture.capturedAmountPaise, 150000);
  assert.equal(extraction.capture.linkStatus, 'paid');
});

test('a partially paid link carries no capture', () => {
  // A rupee against a 1,500 deductible is not a paid deductible, and recording
  // it as one would set up a refund larger than the money behind it.
  const extraction = extractCapture(
    paidEvent({ event: 'payment_link.partially_paid', linkStatus: 'partially_paid' })
  );
  assert.equal(extraction.kind, 'ignored');
});

test('a payment that is authorized but not captured carries no capture', () => {
  const extraction = extractCapture(paidEvent({ paymentStatus: 'authorized' }));
  assert.equal(extraction.kind, 'ignored');
  assert.match(extraction.kind === 'ignored' ? extraction.reason : '', /authorized/);
});

test('a cancellation or expiry is acknowledged, never recorded as money', () => {
  assert.equal(extractCapture(paidEvent({ event: 'payment_link.cancelled' })).kind, 'ignored');
  assert.equal(extractCapture(paidEvent({ event: 'payment_link.expired' })).kind, 'ignored');
  assert.equal(extractCapture({ event: 'refund.processed' }).kind, 'ignored');
});

test('an envelope missing either entity carries no capture', () => {
  assert.equal(
    extractCapture({ event: 'payment_link.paid', payload: { payment: { entity: { id: 'pay_1' } } } })
      .kind,
    'ignored'
  );
  assert.equal(
    extractCapture({
      event: 'payment_link.paid',
      payload: { payment_link: { entity: { id: 'plink_1' } } },
    }).kind,
    'ignored'
  );
});

test('a zero captured amount is not a capture', () => {
  const extraction = extractCapture(paidEvent({ amount: 0 }));
  assert.equal(extraction.kind, 'ignored');
});

// --- Delivery ledger id -----------------------------------------------------

test("Razorpay's event id is the ledger key when it is sent", () => {
  const body = JSON.stringify(paidEvent());
  assert.equal(eventLedgerId('Qge1CG0YA4ydIP', body), 'evt_Qge1CG0YA4ydIP');
  assert.equal(
    eventLedgerId('Qge1CG0YA4ydIP', body),
    eventLedgerId('Qge1CG0YA4ydIP', 'a completely different body'),
    'the same delivery id is the same delivery, whatever else changed'
  );
});

test('without the header, byte-identical bodies share a ledger key', () => {
  const body = JSON.stringify(paidEvent({ paymentId: 'pay_SAME' }));
  assert.equal(eventLedgerId(undefined, body), eventLedgerId('', body));
  assert.notEqual(
    eventLedgerId(undefined, body),
    eventLedgerId(undefined, JSON.stringify(paidEvent({ paymentId: 'pay_OTHER' })))
  );
});

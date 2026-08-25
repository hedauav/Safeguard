import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  collectDeductible,
  computeDeductible,
  deductibleReferenceId,
  deductibleRefundReceipt,
  recordDeductibleCapture,
  refundDeductible,
  type DeductibleCollectionOffered,
  type DeductibleCollectionRefusalReason,
  type DeductibleCollectionRefused,
  type DeductibleCollectionResult,
  type DeductibleRefundRefusalReason,
  type DeductibleRefundRefused,
  type DeductibleRefundResult,
  type DeductibleRefunded,
} from './deductible-service.js';
import {
  RazorpayPaymentLinkProvider,
  SimulatedPaymentLinkProvider,
  type PaymentLink,
  type PaymentLinkRequest,
  type PaymentRailProvider,
  type Refund,
  type RefundRequest,
} from './payment-link-provider.js';
import type { RazorpayCapture } from './razorpay-webhook.js';

// --- Test doubles -----------------------------------------------------------

interface FakeState {
  claims: Record<string, any>[];
  policies: Record<string, any>[];
  deductible_payments: Record<string, any>[];
  razorpay_webhook_events: Record<string, any>[];
  /** Injected faults, so a genuine outage can be told apart from "not found". */
  errors: Record<string, any>;
  insertError: any;
  updateError: any;
}

/**
 * Minimal PostgREST stand-in covering only the shapes these services use:
 * `.select().eq().maybeSingle()`, `.select().eq()` awaited for a list,
 * `.insert()`, and `.update().eq().is()`. Rows are mutated in place so a
 * second call sees what the first one wrote.
 */
function fakeSupabase(state: FakeState) {
  return {
    from(table: string) {
      const rows: Record<string, any>[] = (state as any)[table] ?? ((state as any)[table] = []);
      const error = state.errors[table] ?? null;

      return {
        select() {
          return {
            eq(column: string, value: unknown) {
              const matches = () => rows.filter((row) => row[column] === value);
              return {
                async maybeSingle() {
                  if (error) return { data: null, error };
                  return { data: matches()[0] ?? null, error: null };
                },
                // PostgREST builders are thenable, so an un-terminated query
                // awaits straight to a list.
                then(resolve: (value: any) => unknown, reject?: (reason: any) => unknown) {
                  const payload = error ? { data: null, error } : { data: matches(), error: null };
                  return Promise.resolve(payload).then(resolve, reject);
                },
              };
            },
          };
        },

        async insert(row: Record<string, unknown>) {
          if (state.insertError) return { error: state.insertError };
          rows.push({ id: `${table}-${rows.length + 1}`, ...row });
          return { error: null };
        },

        update(patch: Record<string, unknown>) {
          return {
            eq(column: string, value: unknown) {
              const write = (extra?: { column: string; value: unknown }) => {
                if (state.updateError) return { error: state.updateError };
                const targets = rows.filter(
                  (row) =>
                    row[column] === value &&
                    (!extra || (row[extra.column] ?? null) === extra.value)
                );
                for (const row of targets) Object.assign(row, patch);
                return { error: null };
              };
              return {
                /** The conditional half of the write: `.is('payment_id', null)`. */
                is(isColumn: string, isValue: unknown) {
                  return {
                    then(resolve: (value: any) => unknown, reject?: (reason: any) => unknown) {
                      return Promise.resolve(
                        write({ column: isColumn, value: isValue })
                      ).then(resolve, reject);
                    },
                  };
                },
                then(resolve: (value: any) => unknown, reject?: (reason: any) => unknown) {
                  return Promise.resolve(write()).then(resolve, reject);
                },
              };
            },
          };
        },
      };
    },
  };
}

// PostgREST's "no rows" code. Anything else is a real fault.
const NOT_FOUND = { code: 'PGRST116', message: 'no rows' };
const OUTAGE = { code: '08006', message: 'connection failure' };
const TIMEOUT = { code: '57014', message: 'statement timeout' };

const CLAIM_ID = 'claim-1';
const CLAIM_NUMBER = 'CLM-2026-000234';
const POLICY_ID = 'policy-1';
const POLICY_NUMBER = 'POL-2024-000555';

/** 1,500 rupees of deductible — 150,000 paise. */
const DEDUCTIBLE_PAISE = 150_000;

function state(
  overrides: { claim?: Record<string, any>; policy?: Record<string, any> } = {}
): FakeState {
  return {
    claims: [
      {
        id: CLAIM_ID,
        claim_number: CLAIM_NUMBER,
        status: 'under_review',
        policy_id: POLICY_ID,
        // The figure the claimant asked for. Deliberately nothing like the
        // deductible, so a test that read the wrong column would fail loudly.
        claimed_amount: '84000.00',
        fault_determination: null,
        ...overrides.claim,
      },
    ],
    policies: [
      {
        id: POLICY_ID,
        policy_number: POLICY_NUMBER,
        status: 'active',
        coverage_amount: '500000.00',
        deductible: '1500.00',
        ...overrides.policy,
      },
    ],
    deductible_payments: [],
    razorpay_webhook_events: [],
    errors: {},
    insertError: null,
    updateError: null,
  };
}

function collect(
  fixture: FakeState,
  provider: PaymentRailProvider = new SimulatedPaymentLinkProvider(),
  claimReference = CLAIM_NUMBER,
  options: { maxLinkAmount?: number } = {}
): Promise<DeductibleCollectionResult> {
  return collectDeductible(
    fakeSupabase(fixture) as unknown as SupabaseClient,
    provider,
    claimReference,
    options
  );
}

function refund(
  fixture: FakeState,
  provider: PaymentRailProvider = new SimulatedPaymentLinkProvider(),
  claimReference = CLAIM_NUMBER,
  options: { amountPaise?: number } = {}
): Promise<DeductibleRefundResult> {
  return refundDeductible(
    fakeSupabase(fixture) as unknown as SupabaseClient,
    provider,
    claimReference,
    options
  );
}

/** Every refusal must be inert: a reason to branch on and no payable link. */
function assertCollectionRefused(
  result: DeductibleCollectionResult,
  reason: DeductibleCollectionRefusalReason
): asserts result is DeductibleCollectionRefused {
  assert.equal(result.success, false, `expected a refusal, got ${JSON.stringify(result)}`);
  assert.equal(result.reason, reason);
  assert.equal(result.payment_link_id, null);
  assert.equal(result.payment_link_url, null);
}

function assertCollected(
  result: DeductibleCollectionResult
): asserts result is DeductibleCollectionOffered {
  assert.equal(result.success, true, `expected an offer, got ${JSON.stringify(result)}`);
}

/** Every refusal must be inert: a reason to branch on and no refund id. */
function assertRefundRefused(
  result: DeductibleRefundResult,
  reason: DeductibleRefundRefusalReason
): asserts result is DeductibleRefundRefused {
  assert.equal(result.success, false, `expected a refusal, got ${JSON.stringify(result)}`);
  assert.equal(result.reason, reason);
  assert.equal(result.refund_id, null);
}

function assertRefunded(result: DeductibleRefundResult): asserts result is DeductibleRefunded {
  assert.equal(result.success, true, `expected a refund, got ${JSON.stringify(result)}`);
}

/**
 * A claim whose deductible has been collected and captured, ready to refund.
 * Written the way the webhook would leave it.
 */
function capturedFixture(
  overrides: {
    claim?: Record<string, any>;
    row?: Record<string, any>;
  } = {}
): FakeState {
  const fixture = state({ claim: { status: 'paid', fault_determination: 'other_party', ...overrides.claim } });
  fixture.deductible_payments.push({
    id: 'dp-1',
    claim_id: CLAIM_ID,
    policy_id: POLICY_ID,
    provider: 'simulated',
    payment_link_id: 'plink_sim_captured',
    short_url: 'https://simulated-payments.safeguard.invalid/l/abc',
    amount_paise: DEDUCTIBLE_PAISE,
    status: 'paid',
    reference_id: deductibleReferenceId(CLAIM_NUMBER),
    simulated: true,
    payment_id: 'pay_CAPTURED01',
    captured_amount_paise: DEDUCTIBLE_PAISE,
    captured_at: '2026-04-01T00:00:00.000Z',
    refund_id: null,
    refund_status: null,
    refund_amount_paise: null,
    ...overrides.row,
  });
  return fixture;
}

// ============================================================================
// The amount is read from the policy, never supplied
// ============================================================================

test('the deductible is the policy figure', () => {
  assert.equal(computeDeductible({ deductible: 1500 }), 1500);
});

test('NUMERIC columns arriving as strings are still arithmetic', () => {
  // PostgREST serialises NUMERIC as a string; '1500.00' must not become NaN.
  assert.equal(computeDeductible({ deductible: '1500.00' }), 1500);
});

test('a missing or negative deductible is zero, never NaN and never a demand', () => {
  assert.equal(computeDeductible({ deductible: null }), 0);
  assert.equal(computeDeductible({ deductible: undefined }), 0);
  assert.equal(computeDeductible({ deductible: 'not a number' }), 0);
  assert.equal(computeDeductible({ deductible: '-500.00' }), 0);
});

test('the demand is the policy deductible, not the amount claimed', async () => {
  // The claim asks for 84,000. If this ever billed the claimed amount instead
  // of the excess, that is the number that would appear.
  const fixture = state();
  const provider = new SimulatedPaymentLinkProvider();
  const result = await collect(fixture, provider);

  assertCollected(result);
  assert.equal(result.deductible_amount, 1500);
  assert.equal(provider.issued()[0].amountPaise, DEDUCTIBLE_PAISE, 'paise, never rupees');
  assert.equal(provider.issued()[0].currency, 'INR');
});

// ============================================================================
// Collection — happy path
// ============================================================================

test('an open claim is offered a link for the exact deductible owed', async () => {
  const fixture = state();
  const provider = new SimulatedPaymentLinkProvider();
  const result = await collect(fixture, provider);

  assertCollected(result);
  assert.equal(result.claim_number, CLAIM_NUMBER);
  assert.equal(result.policy_number, POLICY_NUMBER);
  assert.equal(result.deductible_amount, 1500);
  assert.match(result.payment_link_id, /^plink_sim_/);
  assert.match(result.payment_link_url, /^https:\/\//);
  assert.equal(result.payment_link_status, 'created');
  assert.equal(result.simulated, true, 'a simulated link must never read as a payable one');
  assert.equal(result.reused, false);
  assert.equal(result.paid, false);

  const row = fixture.deductible_payments[0];
  assert.equal(row.claim_id, CLAIM_ID);
  assert.equal(row.policy_id, POLICY_ID);
  assert.equal(row.amount_paise, DEDUCTIBLE_PAISE);
  assert.equal(row.status, 'created');
  assert.equal(row.simulated, true);
  assert.equal(row.reference_id, deductibleReferenceId(CLAIM_NUMBER));
  assert.equal(row.provider, 'simulated');
});

test('the message names the amount, the link, and the waiver that may follow', async () => {
  const result = await collect(state());
  assertCollected(result);
  assert.ok(result.message.includes('1500.00'));
  assert.ok(result.message.includes(result.payment_link_url));
  assert.match(result.message, /waived and refunded/i);
});

test('nothing in the collection message calls the waiver a settlement', async () => {
  const result = await collect(state());
  assertCollected(result);
  assert.doesNotMatch(result.message, /settlement|payout/i);
});

test('a claim number spoken without dashes still gets a link', async () => {
  const result = await collect(state(), new SimulatedPaymentLinkProvider(), 'clm2026000234');
  assertCollected(result);
  assert.equal(result.claim_number, CLAIM_NUMBER);
});

// ============================================================================
// Collection gates
// ============================================================================

test('GATE claim_not_found: refuses when the claim does not exist', async () => {
  const fixture = state();
  fixture.claims = [];
  fixture.errors.claims = NOT_FOUND;
  const provider = new SimulatedPaymentLinkProvider();

  assertCollectionRefused(await collect(fixture, provider), 'claim_not_found');
  assert.equal(provider.issued().length, 0, 'nothing may reach the payment rail');
});

test('GATE records_unavailable: a claim-lookup fault is not a missing claim', async () => {
  const fixture = state();
  fixture.errors.claims = OUTAGE;
  const result = await collect(fixture);
  assertCollectionRefused(result, 'records_unavailable');
  assert.notEqual(result.reason, 'claim_not_found');
});

test('GATE records_unavailable: a fault reading prior links refuses rather than duplicating', async () => {
  // The dangerous read: failing open here would hide the link already issued
  // and demand the same deductible twice.
  const fixture = state();
  fixture.errors.deductible_payments = TIMEOUT;
  const provider = new SimulatedPaymentLinkProvider();
  assertCollectionRefused(await collect(fixture, provider), 'records_unavailable');
  assert.equal(provider.issued().length, 0);
});

test('GATE claim_not_open: a denied claim carries no deductible', async () => {
  const fixture = state({ claim: { status: 'denied' } });
  const provider = new SimulatedPaymentLinkProvider();
  const result = await collect(fixture, provider);

  assertCollectionRefused(result, 'claim_not_open');
  assert.equal(provider.issued().length, 0, 'a denied claim must never reach the payment rail');
  assert.equal(fixture.deductible_payments.length, 0);
});

test('GATE claim_not_open: a closed or already-settled claim is refused too', async () => {
  for (const status of ['closed', 'paid']) {
    const fixture = state({ claim: { status } });
    const provider = new SimulatedPaymentLinkProvider();
    assertCollectionRefused(await collect(fixture, provider), 'claim_not_open');
    assert.equal(provider.issued().length, 0);
  }
});

test('GATE policy_not_found: no policy means no deductible to read', async () => {
  const fixture = state();
  fixture.policies = [];
  const provider = new SimulatedPaymentLinkProvider();

  assertCollectionRefused(await collect(fixture, provider), 'policy_not_found');
  assert.equal(provider.issued().length, 0);
});

test('GATE nothing_payable: a zero deductible produces no link', async () => {
  const fixture = state({ policy: { deductible: '0.00' } });
  const provider = new SimulatedPaymentLinkProvider();
  const result = await collect(fixture, provider);

  assertCollectionRefused(result, 'nothing_payable');
  assert.equal(result.deductible_amount, 0);
  assert.equal(provider.issued().length, 0, 'no zero-rupee link is ever created');
  assert.equal(fixture.deductible_payments.length, 0);
});

test('GATE above_link_limit: a deductible over the ceiling goes to a human', async () => {
  const fixture = state({ policy: { deductible: '250000.00' } });
  const provider = new SimulatedPaymentLinkProvider();
  const result = await collect(fixture, provider);

  assertCollectionRefused(result, 'above_link_limit');
  assert.equal(result.deductible_amount, 250000);
  assert.match(result.message, /representative/i);
  assert.equal(provider.issued().length, 0);
  assert.equal(fixture.deductible_payments.length, 0);
});

test('GATE above_link_limit: the ceiling is configurable and applied at the boundary', async () => {
  const atLimit = await collect(state(), new SimulatedPaymentLinkProvider(), CLAIM_NUMBER, {
    maxLinkAmount: 1500,
  });
  assertCollected(atLimit);

  const below = await collect(state(), new SimulatedPaymentLinkProvider(), CLAIM_NUMBER, {
    maxLinkAmount: 1499,
  });
  assertCollectionRefused(below, 'above_link_limit');
});

test('GATE link_failed: a provider that throws refuses rather than propagating', async () => {
  const throwing: PaymentRailProvider = {
    name: 'throwing',
    async createPaymentLink(): Promise<PaymentLink> {
      throw new Error('provider unreachable');
    },
    async createRefund(): Promise<Refund> {
      throw new Error('not reached');
    },
  };

  const fixture = state();
  assertCollectionRefused(await collect(fixture, throwing), 'link_failed');
  assert.equal(fixture.deductible_payments.length, 0, 'nothing unpayable may be recorded');
});

test('GATE link_failed: a link that comes back already expired is never read out', async () => {
  const dead: PaymentRailProvider = {
    name: 'dead',
    async createPaymentLink(request: PaymentLinkRequest): Promise<PaymentLink> {
      return {
        id: 'plink_dead',
        status: 'expired',
        amountPaise: request.amountPaise,
        currency: 'INR',
        shortUrl: 'https://example.invalid/dead',
        referenceId: request.referenceId,
        simulated: true,
        createdAt: new Date().toISOString(),
      };
    },
    async createRefund(): Promise<Refund> {
      throw new Error('not reached');
    },
  };

  const fixture = state();
  assertCollectionRefused(await collect(fixture, dead), 'link_failed');
  assert.equal(fixture.deductible_payments.length, 0);
});

test('GATE deductible_not_recorded: an untrackable link is refused, not read out', async () => {
  // A link with no row behind it is a payment that could never be refunded,
  // because a refund is made against a capture we have recorded.
  const fixture = state();
  fixture.insertError = TIMEOUT;
  const result = await collect(fixture);

  assertCollectionRefused(result, 'deductible_not_recorded');
  assert.equal(result.deductible_amount, 1500);
  assert.equal(fixture.deductible_payments.length, 0);
});

// ============================================================================
// Collection idempotency
// ============================================================================

test('the reference id is derived from the claim number alone', () => {
  assert.equal(deductibleReferenceId(CLAIM_NUMBER), deductibleReferenceId(CLAIM_NUMBER));
  assert.notEqual(deductibleReferenceId(CLAIM_NUMBER), deductibleReferenceId('CLM-2026-000999'));
  assert.notEqual(
    deductibleReferenceId(CLAIM_NUMBER),
    deductibleReferenceId(CLAIM_NUMBER, 2),
    're-issuing after an expired link needs a reference Razorpay has not seen'
  );
});

test('the reference id is distinct from the renewal namespace', () => {
  // Both are sha256 over a versioned string; a shared prefix would collide the
  // two products' references at the provider.
  assert.match(deductibleReferenceId(CLAIM_NUMBER), /^ded_/);
});

test('IDEMPOTENCY collecting twice yields one link, not two demands', async () => {
  const fixture = state();
  const provider = new SimulatedPaymentLinkProvider();

  const first = await collect(fixture, provider);
  assertCollected(first);
  assert.equal(first.reused, false);

  const second = await collect(fixture, provider);
  assertCollected(second);

  assert.equal(second.payment_link_id, first.payment_link_id);
  assert.equal(second.payment_link_url, first.payment_link_url);
  assert.equal(second.deductible_amount, first.deductible_amount);
  assert.equal(second.reused, true, 'the second call returns the existing link');
  assert.equal(provider.issued().length, 1, 'the rail is asked once');
  assert.equal(fixture.deductible_payments.length, 1, 'one row, not two');
});

test('IDEMPOTENCY an already-paid deductible is reported, never billed again', async () => {
  const fixture = state();
  const provider = new SimulatedPaymentLinkProvider();
  assertCollected(await collect(fixture, provider));

  fixture.deductible_payments[0].status = 'paid';
  fixture.deductible_payments[0].payment_id = 'pay_ALREADY';
  const second = await collect(fixture, provider);

  assertCollected(second);
  assert.equal(second.reused, true);
  assert.equal(second.paid, true);
  assert.match(second.message, /already been paid/i);
  assert.equal(fixture.deductible_payments.length, 1);
  assert.equal(provider.issued().length, 1);
});

test('IDEMPOTENCY a spent link is replaced with a reference the rail has not seen', async () => {
  const fixture = state();
  const provider = new SimulatedPaymentLinkProvider();
  assertCollected(await collect(fixture, provider));

  // Nobody paid before it lapsed, so there is no live demand left to return.
  fixture.deductible_payments[0].status = 'expired';
  const reissued = await collect(fixture, provider);

  assertCollected(reissued);
  assert.equal(reissued.reused, false);
  assert.equal(reissued.reference_id, deductibleReferenceId(CLAIM_NUMBER, 2));
  assert.notEqual(reissued.payment_link_id, fixture.deductible_payments[0].payment_link_id);
  assert.equal(provider.issued().length, 2);
});

test('IDEMPOTENCY the simulated rail returns the first link for a repeated reference', async () => {
  const provider = new SimulatedPaymentLinkProvider();
  const request: PaymentLinkRequest = {
    amountPaise: DEDUCTIBLE_PAISE,
    currency: 'INR',
    referenceId: deductibleReferenceId(CLAIM_NUMBER),
    description: `SafeGuard deductible - claim ${CLAIM_NUMBER}`,
  };

  const first = await provider.createPaymentLink(request);
  const second = await provider.createPaymentLink(request);

  assert.equal(second.id, first.id);
  assert.equal(provider.issued().length, 1, 'a replayed reference must not create a second link');
});

// ============================================================================
// Recording a capture from the webhook
// ============================================================================

function capture(overrides: Partial<RazorpayCapture> = {}): RazorpayCapture {
  return {
    event: 'payment_link.paid',
    paymentLinkId: 'plink_REAL01',
    referenceId: deductibleReferenceId(CLAIM_NUMBER),
    paymentId: 'pay_REAL01',
    capturedAmountPaise: DEDUCTIBLE_PAISE,
    currency: 'INR',
    linkStatus: 'paid',
    createdAt: '2026-04-01T10:00:00.000Z',
    ...overrides,
  };
}

/** A real (non-simulated) collected link, awaiting its capture. */
function realLinkFixture(overrides: Record<string, any> = {}): FakeState {
  const fixture = state();
  fixture.deductible_payments.push({
    id: 'dp-real',
    claim_id: CLAIM_ID,
    policy_id: POLICY_ID,
    provider: 'razorpay',
    payment_link_id: 'plink_REAL01',
    short_url: 'https://rzp.io/i/real01',
    amount_paise: DEDUCTIBLE_PAISE,
    status: 'created',
    reference_id: deductibleReferenceId(CLAIM_NUMBER),
    simulated: false,
    payment_id: null,
    captured_amount_paise: null,
    refund_id: null,
    ...overrides,
  });
  return fixture;
}

function record(fixture: FakeState, cap = capture(), ledgerId = 'evt_ONE') {
  return recordDeductibleCapture(
    fakeSupabase(fixture) as unknown as SupabaseClient,
    cap,
    ledgerId,
    { event: cap.event }
  );
}

test('a capture is recorded against the claim and its link', async () => {
  const fixture = realLinkFixture();
  const result = await record(fixture);

  assert.equal(result.outcome, 'recorded');
  assert.equal(result.claim_id, CLAIM_ID);

  const row = fixture.deductible_payments[0];
  assert.equal(row.payment_id, 'pay_REAL01');
  assert.equal(row.captured_amount_paise, DEDUCTIBLE_PAISE);
  assert.equal(row.status, 'paid');
  assert.equal(row.captured_at, '2026-04-01T10:00:00.000Z');
  assert.equal(fixture.razorpay_webhook_events.length, 1, 'the delivery is on the ledger');
});

test('IDEMPOTENCY a redelivered webhook is skipped by the event ledger', async () => {
  const fixture = realLinkFixture();
  assert.equal((await record(fixture)).outcome, 'recorded');

  // Razorpay retries the identical delivery. The ledger row is what stops it,
  // because Razorpay's signature carries no timestamp and replays verify.
  const replay = await record(fixture, capture({ paymentId: 'pay_DIFFERENT' }), 'evt_ONE');
  assert.equal(replay.outcome, 'replayed');
  assert.equal(
    fixture.deductible_payments[0].payment_id,
    'pay_REAL01',
    'the replay changed nothing'
  );
  assert.equal(fixture.razorpay_webhook_events.length, 1);
});

test('IDEMPOTENCY a fresh delivery for an already-captured link is refused', async () => {
  // A different event id but the same link. The ledger cannot help here; the
  // payment_id guard on the row is what stops a second capture.
  const fixture = realLinkFixture();
  assert.equal((await record(fixture, capture(), 'evt_ONE')).outcome, 'recorded');

  const again = await record(fixture, capture(), 'evt_TWO');
  assert.equal(again.outcome, 'already_captured');
  assert.equal(fixture.deductible_payments[0].payment_id, 'pay_REAL01');
});

test('a second, different payment against a captured link is not overwritten', async () => {
  const fixture = realLinkFixture();
  await record(fixture, capture(), 'evt_ONE');

  const other = await record(fixture, capture({ paymentId: 'pay_OTHER' }), 'evt_TWO');
  assert.equal(other.outcome, 'amount_mismatch');
  assert.equal(fixture.deductible_payments[0].payment_id, 'pay_REAL01');
});

test('a capture for a link we never issued is acknowledged, not invented', async () => {
  // Renewal links live in the same Razorpay account and fire the same events.
  const fixture = realLinkFixture();
  const result = await record(fixture, capture({ paymentLinkId: 'plink_SOMEONE_ELSE' }));

  assert.equal(result.outcome, 'unknown_link');
  assert.equal(fixture.deductible_payments[0].payment_id, null);
});

test('a capture claimed against a simulated link is refused', async () => {
  // A simulated link resolves nowhere and can never be paid. A webhook saying
  // otherwise is not a capture, and recording it would create a refundable
  // balance out of nothing.
  const fixture = realLinkFixture({ simulated: true, provider: 'simulated' });
  const result = await record(fixture);

  assert.equal(result.outcome, 'simulated_link');
  assert.equal(fixture.deductible_payments[0].payment_id, null);
  assert.equal(fixture.razorpay_webhook_events.length, 0);
});

test('a short payment is not recorded as a paid deductible', async () => {
  // Recording 1 rupee against a 1,500 deductible would leave the claim looking
  // square and set up a refund far larger than the money behind it.
  const fixture = realLinkFixture();
  const result = await record(fixture, capture({ capturedAmountPaise: 100 }));

  assert.equal(result.outcome, 'amount_mismatch');
  assert.equal(fixture.deductible_payments[0].payment_id, null);
});

test('an overpayment is recorded at the figure the rail actually captured', async () => {
  const fixture = realLinkFixture();
  await record(fixture, capture({ capturedAmountPaise: DEDUCTIBLE_PAISE + 500 }));
  assert.equal(fixture.deductible_payments[0].captured_amount_paise, DEDUCTIBLE_PAISE + 500);
});

test('a write failure asks for a retry rather than claiming the capture', async () => {
  const fixture = realLinkFixture();
  fixture.updateError = TIMEOUT;
  const result = await record(fixture);

  assert.equal(result.outcome, 'write_failed');
  assert.equal(
    fixture.razorpay_webhook_events.length,
    0,
    'no ledger row, so Razorpay retry re-applies rather than being skipped'
  );
});

// ============================================================================
// Refund gates
// ============================================================================

test('GATE claim_not_found: refuses when the claim does not exist', async () => {
  const fixture = capturedFixture();
  fixture.claims = [];
  fixture.errors.claims = NOT_FOUND;
  const provider = new SimulatedPaymentLinkProvider();

  assertRefundRefused(await refund(fixture, provider), 'claim_not_found');
  assert.equal(provider.refunded().length, 0, 'nothing may reach the payment rail');
});

test('GATE records_unavailable: a lookup fault is not a missing claim', async () => {
  const fixture = capturedFixture();
  fixture.errors.claims = OUTAGE;
  assertRefundRefused(await refund(fixture), 'records_unavailable');
});

test('GATE records_unavailable: a fault reading payments refuses rather than guessing', async () => {
  const fixture = capturedFixture();
  fixture.errors.deductible_payments = TIMEOUT;
  const provider = new SimulatedPaymentLinkProvider();
  assertRefundRefused(await refund(fixture, provider), 'records_unavailable');
  assert.equal(provider.refunded().length, 0);
});

test('GATE no_captured_payment: nothing was ever paid, so nothing can come back', async () => {
  const fixture = state({ claim: { status: 'paid', fault_determination: 'other_party' } });
  const provider = new SimulatedPaymentLinkProvider();
  const result = await refund(fixture, provider);

  assertRefundRefused(result, 'no_captured_payment');
  assert.equal(provider.refunded().length, 0);
});

test('GATE no_captured_payment: a link exists but no webhook ever confirmed payment', async () => {
  const fixture = capturedFixture({ row: { payment_id: null, captured_amount_paise: null } });
  const provider = new SimulatedPaymentLinkProvider();
  const result = await refund(fixture, provider);

  assertRefundRefused(result, 'no_captured_payment');
  assert.equal(provider.refunded().length, 0, 'an unpaid link must never reach the refund rail');
});

test('GATE already_refunded: the money never goes back twice', async () => {
  const fixture = capturedFixture({
    row: {
      refund_id: 'rfnd_ALREADY',
      refund_status: 'processed',
      refund_amount_paise: DEDUCTIBLE_PAISE,
    },
  });
  const provider = new SimulatedPaymentLinkProvider();
  const result = await refund(fixture, provider);

  assertRefundRefused(result, 'already_refunded');
  assert.equal(result.refund_amount, 1500, 'the refusal states what was already returned');
  assert.equal(provider.refunded().length, 0);
});

test('GATE claim_not_settled: the waiver follows the outcome, it does not precede it', async () => {
  const fixture = capturedFixture({ claim: { status: 'under_review' } });
  const provider = new SimulatedPaymentLinkProvider();
  const result = await refund(fixture, provider);

  assertRefundRefused(result, 'claim_not_settled');
  assert.equal(provider.refunded().length, 0);
});

test('GATE claim_not_settled: an approved-but-unpaid claim is not settled', async () => {
  const fixture = capturedFixture({ claim: { status: 'approved' } });
  assertRefundRefused(await refund(fixture), 'claim_not_settled');
});

test('GATE fault_not_determined: nobody has decided, so nothing is waived', async () => {
  const fixture = capturedFixture({ claim: { fault_determination: null } });
  const provider = new SimulatedPaymentLinkProvider();
  const result = await refund(fixture, provider);

  assertRefundRefused(result, 'fault_not_determined');
  assert.match(result.message, /adjuster/i);
  assert.equal(provider.refunded().length, 0);
});

test('GATE fault_not_determined: an explicit "undetermined" is still undetermined', async () => {
  const fixture = capturedFixture({ claim: { fault_determination: 'undetermined' } });
  assertRefundRefused(await refund(fixture), 'fault_not_determined');
});

test('GATE insured_at_fault: the policyholder bears their own excess', async () => {
  const fixture = capturedFixture({ claim: { fault_determination: 'insured' } });
  const provider = new SimulatedPaymentLinkProvider();
  const result = await refund(fixture, provider);

  assertRefundRefused(result, 'insured_at_fault');
  assert.notEqual(result.reason, 'fault_not_determined', 'a finding is not the absence of one');
  assert.equal(provider.refunded().length, 0);
});

test('GATE insured_at_fault: shared fault does not waive the deductible', async () => {
  const fixture = capturedFixture({ claim: { fault_determination: 'shared' } });
  assertRefundRefused(await refund(fixture), 'insured_at_fault');
});

test('GATE refund_exceeds_capture: never more than the money that came in', async () => {
  const fixture = capturedFixture();
  const provider = new SimulatedPaymentLinkProvider();
  const result = await refund(fixture, provider, CLAIM_NUMBER, {
    amountPaise: DEDUCTIBLE_PAISE + 1,
  });

  assertRefundRefused(result, 'refund_exceeds_capture');
  assert.equal(provider.refunded().length, 0, 'the rail is never even asked');
  assert.equal(fixture.deductible_payments[0].refund_id, null);
});

test('GATE refund_exceeds_capture: applied at the boundary', async () => {
  const exact = await refund(capturedFixture(), new SimulatedPaymentLinkProvider(), CLAIM_NUMBER, {
    amountPaise: DEDUCTIBLE_PAISE,
  });
  assertRefunded(exact);

  const over = await refund(capturedFixture(), new SimulatedPaymentLinkProvider(), CLAIM_NUMBER, {
    amountPaise: DEDUCTIBLE_PAISE + 1,
  });
  assertRefundRefused(over, 'refund_exceeds_capture');
});

test('GATE refund_exceeds_capture: a zero or negative amount is refused, not guessed at', async () => {
  const zero = await refund(capturedFixture(), new SimulatedPaymentLinkProvider(), CLAIM_NUMBER, {
    amountPaise: 0,
  });
  assertRefundRefused(zero, 'refund_exceeds_capture');

  const negative = await refund(
    capturedFixture(),
    new SimulatedPaymentLinkProvider(),
    CLAIM_NUMBER,
    { amountPaise: -100 }
  );
  assertRefundRefused(negative, 'refund_exceeds_capture');
});

test('GATE provider_mismatch: a real capture is never refunded by the simulation', async () => {
  // The dishonest case this exists to stop: the row says Razorpay took 1,500
  // and the simulation reports it returned. The payer would still be out of
  // pocket with the record saying otherwise.
  const fixture = capturedFixture({ row: { provider: 'razorpay', simulated: false } });
  const provider = new SimulatedPaymentLinkProvider();
  const result = await refund(fixture, provider);

  assertRefundRefused(result, 'provider_mismatch');
  assert.equal(provider.refunded().length, 0);
  assert.equal(fixture.deductible_payments[0].refund_id, null);
});

test('GATE refund_failed: a rail that throws refuses rather than propagating', async () => {
  const throwing: PaymentRailProvider = {
    name: 'simulated',
    async createPaymentLink(): Promise<PaymentLink> {
      throw new Error('not reached');
    },
    async createRefund(): Promise<Refund> {
      throw new Error('rail unreachable');
    },
  };

  const fixture = capturedFixture();
  assertRefundRefused(await refund(fixture, throwing), 'refund_failed');
  assert.equal(fixture.deductible_payments[0].refund_id, null, 'nothing is recorded');
});

test('GATE refund_failed: a refund that comes back failed is never recorded as done', async () => {
  const failing: PaymentRailProvider = {
    name: 'simulated',
    async createPaymentLink(): Promise<PaymentLink> {
      throw new Error('not reached');
    },
    async createRefund(request: RefundRequest): Promise<Refund> {
      return {
        id: 'rfnd_FAILED',
        status: 'failed',
        amountPaise: request.amountPaise,
        currency: 'INR',
        paymentId: request.paymentId,
        receipt: request.receipt,
        simulated: true,
        createdAt: new Date().toISOString(),
      };
    },
  };

  const fixture = capturedFixture();
  assertRefundRefused(await refund(fixture, failing), 'refund_failed');
  assert.equal(
    fixture.deductible_payments[0].refund_id,
    null,
    'a failed refund must leave the retry path open, not the already-refunded gate'
  );
});

test('GATE refund_not_recorded: a refund that happened but could not be saved', async () => {
  const fixture = capturedFixture();
  fixture.updateError = TIMEOUT;
  const provider = new SimulatedPaymentLinkProvider();
  const result = await refund(fixture, provider);

  assertRefundRefused(result, 'refund_not_recorded');
  assert.equal(result.refund_amount, 1500);
  assert.match(result.message, /representative/i);
  assert.equal(provider.refunded().length, 1, 'the money genuinely went back');
});

// ============================================================================
// Refund — happy path and idempotency
// ============================================================================

test('a settled, not-at-fault claim has its deductible waived and refunded', async () => {
  const fixture = capturedFixture();
  const provider = new SimulatedPaymentLinkProvider();
  const result = await refund(fixture, provider);

  assertRefunded(result);
  assert.equal(result.claim_number, CLAIM_NUMBER);
  assert.equal(result.refund_amount, 1500);
  assert.equal(result.refund_status, 'processed');
  assert.equal(result.payment_id, 'pay_CAPTURED01');
  assert.match(result.refund_id, /^rfnd_sim_/);
  assert.equal(result.simulated, true, 'a simulated refund must never read as a real one');

  const row = fixture.deductible_payments[0];
  assert.equal(row.refund_id, result.refund_id);
  assert.equal(row.refund_amount_paise, DEDUCTIBLE_PAISE);
  assert.equal(row.refund_status, 'processed');
  assert.equal(row.refund_simulated, true);
});

test('the refund defaults to the whole captured deductible', async () => {
  const fixture = capturedFixture({ row: { captured_amount_paise: 123400 } });
  const provider = new SimulatedPaymentLinkProvider();
  const result = await refund(fixture, provider);

  assertRefunded(result);
  assert.equal(result.refund_amount, 1234);
  assert.equal(provider.refunded()[0].amountPaise, 123400);
});

test('the refund message describes a waiver and never a settlement', async () => {
  const result = await refund(capturedFixture());
  assertRefunded(result);
  assert.match(result.message, /deductible is waived/i);
  assert.match(result.message, /at fault/i);
  assert.doesNotMatch(
    result.message,
    /settlement|payout|claim has been settled for/i,
    'the claim settlement is a separate, simulated movement of money'
  );
});

test('IDEMPOTENCY refunding twice returns the money once', async () => {
  const fixture = capturedFixture();
  const provider = new SimulatedPaymentLinkProvider();

  const first = await refund(fixture, provider);
  assertRefunded(first);

  const second = await refund(fixture, provider);
  assertRefundRefused(second, 'already_refunded');

  assert.equal(provider.refunded().length, 1, 'the rail is asked once');
  assert.equal(fixture.deductible_payments[0].refund_id, first.refund_id);
});

test('IDEMPOTENCY the receipt is deterministic, so a bypassed retry collides at the rail', () => {
  // Razorpay treats `receipt` as an idempotency key scoped to the payment.
  assert.equal(
    deductibleRefundReceipt(CLAIM_NUMBER, 'pay_X'),
    deductibleRefundReceipt(CLAIM_NUMBER, 'pay_X')
  );
  assert.notEqual(
    deductibleRefundReceipt(CLAIM_NUMBER, 'pay_X'),
    deductibleRefundReceipt(CLAIM_NUMBER, 'pay_Y')
  );
  assert.notEqual(
    deductibleRefundReceipt(CLAIM_NUMBER, 'pay_X'),
    deductibleRefundReceipt('CLM-2026-000999', 'pay_X')
  );
  // Razorpay caps `receipt` at 40 characters.
  assert.ok(deductibleRefundReceipt(CLAIM_NUMBER, 'pay_X').length <= 40);
});

test('IDEMPOTENCY the simulated rail returns the first refund for a repeated receipt', async () => {
  const provider = new SimulatedPaymentLinkProvider();
  const request: RefundRequest = {
    paymentId: 'pay_X',
    amountPaise: DEDUCTIBLE_PAISE,
    receipt: deductibleRefundReceipt(CLAIM_NUMBER, 'pay_X'),
  };

  const first = await provider.createRefund(request);
  const second = await provider.createRefund(request);

  assert.equal(second.id, first.id);
  assert.equal(provider.refunded().length, 1, 'a replayed receipt must not refund twice');
});

// ============================================================================
// The Razorpay refund wire format — pinned without touching the network
// ============================================================================

test('the Razorpay rail posts paise and a receipt under Basic auth', async () => {
  let seenUrl = '';
  let seenInit: any = null;

  const provider = new RazorpayPaymentLinkProvider('rzp_test_key', 'secret', {
    baseUrl: 'https://api.example.invalid/v1',
    fetchImpl: (async (url: any, init: any) => {
      seenUrl = String(url);
      seenInit = init;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: 'rfnd_FP8QHiV938haTz',
            entity: 'refund',
            amount: DEDUCTIBLE_PAISE,
            currency: 'INR',
            payment_id: 'pay_CAPTURED01',
            receipt: JSON.parse(init.body).receipt,
            status: 'processed',
            created_at: 1700000000,
          };
        },
      };
    }) as unknown as typeof fetch,
  });

  const receipt = deductibleRefundReceipt(CLAIM_NUMBER, 'pay_CAPTURED01');
  const result = await provider.createRefund({
    paymentId: 'pay_CAPTURED01',
    amountPaise: DEDUCTIBLE_PAISE,
    receipt,
    notes: { claim_number: CLAIM_NUMBER },
  });

  assert.equal(seenUrl, 'https://api.example.invalid/v1/payments/pay_CAPTURED01/refund');
  assert.equal(seenInit.method, 'POST');
  assert.equal(
    seenInit.headers.Authorization,
    `Basic ${Buffer.from('rzp_test_key:secret').toString('base64')}`
  );

  const body = JSON.parse(seenInit.body);
  assert.equal(body.amount, DEDUCTIBLE_PAISE, 'minor units, never rupees');
  assert.equal(body.speed, 'normal');
  assert.equal(body.receipt, receipt);
  assert.equal(body.notes.claim_number, CLAIM_NUMBER);

  assert.equal(result.id, 'rfnd_FP8QHiV938haTz');
  assert.equal(result.status, 'processed');
  assert.equal(result.simulated, false, 'a real refund must never be flagged simulated');
});

test('a Razorpay refund error throws instead of returning a half-built refund', async () => {
  const provider = new RazorpayPaymentLinkProvider('rzp_test_key', 'secret', {
    fetchImpl: (async () => ({
      ok: false,
      status: 400,
      async text() {
        return '{"error":{"description":"The refund amount provided is greater than amount captured."}}';
      },
    })) as unknown as typeof fetch,
  });

  await assert.rejects(
    provider.createRefund({
      paymentId: 'pay_CAPTURED01',
      amountPaise: DEDUCTIBLE_PAISE * 10,
      receipt: 'dedrf_over',
    }),
    /400/
  );
});

test('an unrecognised refund status is pending, never processed', async () => {
  // Guessing upward would record a refund that has not happened as one that has.
  const provider = new RazorpayPaymentLinkProvider('rzp_test_key', 'secret', {
    fetchImpl: (async () => ({
      ok: true,
      status: 200,
      async json() {
        return { id: 'rfnd_X', status: 'something_new', amount: 100, payment_id: 'pay_X' };
      },
    })) as unknown as typeof fetch,
  });

  const result = await provider.createRefund({
    paymentId: 'pay_X',
    amountPaise: 100,
    receipt: 'dedrf_x',
  });
  assert.equal(result.status, 'pending');
});

// ============================================================================
// The whole loop, end to end
// ============================================================================

test('collect, capture, settle, waive — one deductible in and the same one out', async () => {
  const fixture = state();
  const rail = new SimulatedPaymentLinkProvider();

  // 1. The deductible is demanded when the claim is filed.
  const offered = await collect(fixture, rail);
  assertCollected(offered);
  assert.equal(offered.deductible_amount, 1500);

  // 2. Razorpay reports it paid. Rewritten as a real link first, because the
  //    webhook refuses to record a capture against a simulated one.
  fixture.deductible_payments[0].simulated = false;
  fixture.deductible_payments[0].provider = 'simulated';
  const recorded = await record(
    fixture,
    capture({ paymentLinkId: offered.payment_link_id, paymentId: 'pay_LOOP' })
  );
  assert.equal(recorded.outcome, 'recorded');

  // 3. The claim settles — separately, on the simulated payout rail — and an
  //    adjuster records that the other driver was at fault.
  fixture.claims[0].status = 'paid';
  fixture.claims[0].fault_determination = 'other_party';

  // 4. The deductible is waived and genuinely returned.
  const waived = await refund(fixture, rail);
  assertRefunded(waived);
  assert.equal(waived.refund_amount, 1500);
  assert.equal(waived.payment_id, 'pay_LOOP');
  assert.equal(rail.refunded().length, 1);

  // 5. And it cannot happen again.
  assertRefundRefused(await refund(fixture, rail), 'already_refunded');
  assert.equal(rail.refunded().length, 1);
});

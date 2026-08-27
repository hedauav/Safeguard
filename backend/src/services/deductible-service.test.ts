import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  SETTLEMENT_STAND_IN_DISCLOSURE,
  collectDeductible,
  computeDeductible,
  deductibleReferenceId,
  deductibleRefundReceipt,
  faultWaivesDeductible,
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
  type PaymentLinkStatus,
  type PaymentLinkStatusReport,
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
  /** Written by recordJourneyEvent, so a missing step is visible here. */
  journey_events: Record<string, any>[];
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
    journey_events: [],
    errors: {},
    insertError: null,
    updateError: null,
  };
}

function collect(
  fixture: FakeState,
  provider: PaymentRailProvider = new SimulatedPaymentLinkProvider(),
  claimReference = CLAIM_NUMBER,
  options: { maxLinkAmount?: number; linkStatusBudgetMs?: number } = {}
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

test('the message names the amount and the link, and does not promise the waiver', async () => {
  const result = await collect(state());
  assertCollected(result);
  assert.ok(result.message.includes('1500.00'));
  assert.ok(result.message.includes(result.payment_link_url));
  // It used to assert /waived and refunded/ — a flat promise that the excess
  // comes back if the other party is at fault. Refunding requires a fault
  // determination nothing here performs, and refund_deductible is deliberately
  // unreachable from a call, so the caller was being promised an outcome no
  // code can deliver. The refund must still be mentioned as possible, but as
  // an adjuster's decision rather than a commitment.
  assert.match(result.message, /refunded/i);
  assert.match(result.message, /adjuster/i);
  assert.doesNotMatch(result.message, /is waived and refunded to you in full/i);
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
// A paid link is spent, and the rail is the authority on which links are
// ============================================================================
//
// `deductible_payments.status` is only ever as fresh as the last webhook that
// landed. When one is missed the row says 'created' forever, `payment_id` stays
// null, and the reuse path reads the dead URL out to a claimant who has already
// paid. The renewal side carried the identical fault — `paid` missing from
// SPENT_LINK_STATUSES, plus a reuse path that never asked the rail — and it
// reached a real caller on a live call before anyone noticed.

/** The link id every `railLinkFixture` row carries. */
const REAL_LINK_ID = 'plink_REAL_DED';

/** The capture nobody told us about, as the rail reports it. */
const MISSED_PAYMENT_ID = 'pay_MISSED01';
const MISSED_PAID_AT = '2026-08-26T07:41:45.000Z';

/** A provider report saying the link is exactly as we last believed. */
function reachableReport(
  status: PaymentLinkStatus,
  overrides: Partial<Extract<PaymentLinkStatusReport, { reachable: true }>> = {}
): PaymentLinkStatusReport {
  return {
    reachable: true,
    id: REAL_LINK_ID,
    status,
    amountPaise: DEDUCTIBLE_PAISE,
    amountPaidPaise: status === 'paid' ? DEDUCTIBLE_PAISE : 0,
    referenceId: null,
    capture:
      status === 'paid'
        ? {
            paymentId: MISSED_PAYMENT_ID,
            amountPaise: DEDUCTIBLE_PAISE,
            paidAt: MISSED_PAID_AT,
          }
        : null,
    simulated: false,
    ...overrides,
  };
}

/**
 * A rail that issues real, payable links and answers for the ones it holds.
 *
 * It reports the name the Razorpay provider reports, because that name is the
 * only thing `collectDeductible` can read to tell a live rail from the
 * simulation. `statuses` is what it says about links it did not issue in this
 * test — the rows already sitting in the fixture — and defaults to "still
 * payable", the case that must keep behaving exactly as it always did.
 */
function liveProvider(
  statuses: Record<string, PaymentLinkStatusReport> = {}
): PaymentRailProvider & { issued(): PaymentLink[]; asked(): string[] } {
  const links: PaymentLink[] = [];
  const asked: string[] = [];
  return {
    name: 'razorpay',
    async createPaymentLink(request: PaymentLinkRequest): Promise<PaymentLink> {
      const link: PaymentLink = {
        id: `plink_REAL_${links.length + 1}`,
        status: 'created',
        amountPaise: request.amountPaise,
        currency: 'INR',
        shortUrl: `https://rzp.io/i/realded${links.length + 1}`,
        referenceId: request.referenceId,
        simulated: false,
        createdAt: new Date().toISOString(),
      };
      links.push(link);
      return link;
    },
    async getPaymentLinkStatus(paymentLinkId: string): Promise<PaymentLinkStatusReport> {
      asked.push(paymentLinkId);
      if (statuses[paymentLinkId]) return statuses[paymentLinkId];
      const own = links.find((link) => link.id === paymentLinkId);
      return reachableReport(own?.status ?? 'created', { id: paymentLinkId });
    },
    async createRefund(): Promise<Refund> {
      throw new Error('no refund is expected on the collection path');
    },
    issued: () => links,
    asked: () => asked,
  };
}

/** A real (non-simulated) deductible link, issued and awaiting its capture. */
function railLinkFixture(
  overrides: Record<string, any> = {},
  claimOverrides: Record<string, any> = {}
): FakeState {
  const fixture = state({ claim: claimOverrides });
  fixture.deductible_payments.push({
    id: 'dp-real',
    claim_id: CLAIM_ID,
    policy_id: POLICY_ID,
    provider: 'razorpay',
    payment_link_id: REAL_LINK_ID,
    short_url: 'https://rzp.io/i/realded',
    amount_paise: DEDUCTIBLE_PAISE,
    status: 'created',
    reference_id: deductibleReferenceId(CLAIM_NUMBER),
    simulated: false,
    payment_id: null,
    captured_amount_paise: null,
    captured_at: null,
    ...overrides,
  });
  return fixture;
}

function journeyTypes(fixture: FakeState): string[] {
  return fixture.journey_events.map((row) => row.event_type);
}

// --- `paid` belongs in SPENT_LINK_STATUSES ----------------------------------

test('a paid link is never handed back — it is the most spent a link can be', async () => {
  // The production fault. `paid` was missing from SPENT_LINK_STATUSES, so a
  // link Razorpay had already captured against stayed eligible for reuse
  // forever. The comment above the set argued FOR that, on the theory that
  // handing back a paid link protects the claimant from a second demand. It
  // does the opposite: Razorpay takes no second payment against a paid link,
  // so all that happens is a dead URL is read out, tapped, and nothing occurs.
  //
  // Here the status column says paid while no capture was ever recorded — the
  // two halves of a webhook that half-landed. The row must play no part in the
  // call whatever else is true, and the rail is not even asked about it: it is
  // spent by our own record.
  const fixture = railLinkFixture({ status: 'paid' });
  const provider = liveProvider();

  const result = await collect(fixture, provider);

  assertCollected(result);
  assert.equal(result.reused, false, 'a paid link is spent, not open');
  assert.notEqual(result.payment_link_id, REAL_LINK_ID);
  assert.notEqual(result.payment_link_url, 'https://rzp.io/i/realded');
  assert.equal(result.reference_id, deductibleReferenceId(CLAIM_NUMBER, 2));
  assert.deepEqual(provider.asked(), [], 'a spent link is not worth a question');
  assert.equal(fixture.deductible_payments.length, 2);
});

test('a captured deductible ends the call, whatever the status column says', async () => {
  // `status` is a label a webhook wrote; `payment_id` is the identifier of
  // money we actually hold. Where they disagree the money wins — and because
  // the money is in, the answer is a report, never another link.
  const fixture = railLinkFixture({
    status: 'created',
    payment_id: 'pay_ALREADY',
    captured_amount_paise: DEDUCTIBLE_PAISE,
    captured_at: '2026-04-01T00:00:00.000Z',
  });
  const provider = liveProvider();

  const result = await collect(fixture, provider);

  assertCollected(result);
  assert.equal(result.paid, true);
  assert.equal(result.reused, true);
  assert.equal(result.deductible_amount, 1500);
  assert.match(result.message, /already been paid/i);
  assert.equal(provider.issued().length, 0, 'a paid deductible is never demanded again');
  assert.deepEqual(provider.asked(), [], 'the money is on the record; there is nothing to ask');
  assert.equal(fixture.deductible_payments.length, 1);
});

// --- Still payable: nothing changes -----------------------------------------

test('a link the rail still calls payable is reused, exactly as before', async () => {
  const fixture = railLinkFixture();
  const provider = liveProvider();

  const result = await collect(fixture, provider);

  assertCollected(result);
  assert.equal(result.reused, true);
  assert.equal(result.paid, false);
  assert.equal(result.payment_link_url, 'https://rzp.io/i/realded');
  assert.equal(result.payment_link_status, 'created');
  assert.deepEqual(provider.asked(), [REAL_LINK_ID], 'the row is believed only after asking');
  assert.equal(provider.issued().length, 0, 'no second demand for the same deductible');
  assert.equal(fixture.deductible_payments.length, 1);
});

test('a partially paid link is still payable and is still reused', async () => {
  // Razorpay will take the balance on one of these, so it is a live demand.
  const fixture = railLinkFixture();
  const provider = liveProvider({
    [REAL_LINK_ID]: reachableReport('partially_paid', { amountPaidPaise: 50_000 }),
  });

  const result = await collect(fixture, provider);

  assertCollected(result);
  assert.equal(result.reused, true);
  assert.equal(result.payment_link_status, 'partially_paid');
  assert.equal(provider.issued().length, 0);
});

// --- Spent at the rail, open in our record ----------------------------------

test('a link the rail calls expired is replaced, and the row stops claiming to be open', async () => {
  const fixture = railLinkFixture();
  const provider = liveProvider({ [REAL_LINK_ID]: reachableReport('expired') });

  const result = await collect(fixture, provider);

  assertCollected(result);
  assert.equal(result.reused, false);
  assert.equal(result.reference_id, deductibleReferenceId(CLAIM_NUMBER, 2));
  assert.equal(
    fixture.deductible_payments[0].status,
    'expired',
    'the expiry we were never told about is written down'
  );
  assert.equal(fixture.deductible_payments.length, 2);
});

test('a rail-confirmed expiry is not rediscovered into a third demand', async () => {
  // Without persisting what the rail said, the stale row stays unspent, and
  // since PostgREST returns rows in no defined order the next call could pick
  // it again and issue another link. A missed webhook would become an
  // unbounded supply of demands for one deductible.
  const fixture = railLinkFixture();
  const provider = liveProvider({ [REAL_LINK_ID]: reachableReport('expired') });

  assertCollected(await collect(fixture, provider));
  const second = await collect(fixture, provider);

  assertCollected(second);
  assert.equal(second.reused, true, 'the link just created is the live one');
  assert.equal(provider.issued().length, 1, 'exactly one replacement, ever');
  assert.equal(fixture.deductible_payments.length, 2);
});

test('a simulated row on a claim whose rail is now real is replaced, not asked about', async () => {
  // Razorpay has never heard of a `plink_sim_` id and answers 404, which this
  // file reads as "we could not be told". Asking would therefore refuse every
  // future collection on the claim rather than merely reusing a dead URL, so
  // the row is dropped before the question is put.
  const fixture = railLinkFixture({
    id: 'dp-sim',
    provider: 'simulated',
    payment_link_id: 'plink_sim_08b1f617addf',
    short_url: 'https://simulated-payments.safeguard.invalid/l/08b1f617addf',
    simulated: true,
  });
  const provider = liveProvider();

  const result = await collect(fixture, provider);

  assertCollected(result);
  assert.equal(result.reused, false);
  assert.equal(result.simulated, false, 'the replacement is a URL somebody can actually pay');
  assert.deepEqual(provider.asked(), [], 'a link this rail never issued is not worth a question');
  assert.equal(provider.issued().length, 1);
});

// --- The rail cannot be reached ---------------------------------------------

test('an unreachable rail refuses rather than reading out a link it cannot confirm', async () => {
  // The judgement call. Reusing is what produced the incident; creating a
  // second link risks two live demands for one deductible and mostly cannot
  // work anyway, since the create goes to the same rail that just failed to
  // answer. Refusing is the only branch that is actually true.
  const fixture = railLinkFixture();
  const provider = liveProvider({
    [REAL_LINK_ID]: { reachable: false, reason: 'connect ETIMEDOUT 104.18.0.1:443' },
  });

  const result = await collect(fixture, provider);

  assertCollectionRefused(result, 'link_status_unknown');
  assert.equal(result.deductible_amount, 1500);
  assert.match(result.message, /representative/i);
  assert.equal(provider.issued().length, 0, 'and no second demand is created either');
  assert.equal(fixture.deductible_payments.length, 1, 'the row is left exactly as it was');
  assert.equal(fixture.deductible_payments[0].status, 'created');

  const event = fixture.journey_events.at(-1) as any;
  assert.equal(event.event_type, 'deductible_request_failed');
  assert.equal(event.detail.reason, 'link_status_unknown');
  assert.equal(event.detail.claim_unchanged, true);
});

test('a provider that cannot be asked at all is treated as unreachable', async () => {
  // The status read is optional on the interface for compatibility, not
  // because the check is optional. Nothing gets a softer answer by declining
  // to implement it.
  const mute: PaymentRailProvider = {
    name: 'razorpay',
    async createPaymentLink(): Promise<PaymentLink> {
      throw new Error('no link should be created while an unconfirmed one exists');
    },
    async createRefund(): Promise<Refund> {
      throw new Error('not reached');
    },
  };

  const fixture = railLinkFixture();
  assertCollectionRefused(await collect(fixture, mute), 'link_status_unknown');
  assert.equal(fixture.deductible_payments.length, 1);
});

test('a provider that throws while reporting is unreachable, not fatal', async () => {
  const angry: PaymentRailProvider = {
    name: 'razorpay',
    async createPaymentLink(): Promise<PaymentLink> {
      throw new Error('no link should be created');
    },
    async createRefund(): Promise<Refund> {
      throw new Error('not reached');
    },
    async getPaymentLinkStatus(): Promise<PaymentLinkStatusReport> {
      throw new Error('socket hang up');
    },
  };

  assertCollectionRefused(await collect(railLinkFixture(), angry), 'link_status_unknown');
});

test('a rail that never answers is abandoned inside the budget', async () => {
  // The caller is on a phone line. A provider is asked to honour the timeout
  // and the real one does, but `provider` is an interface and an
  // implementation that hangs would hang the call.
  const silent: PaymentRailProvider = {
    name: 'razorpay',
    async createPaymentLink(): Promise<PaymentLink> {
      throw new Error('no link should be created');
    },
    async createRefund(): Promise<Refund> {
      throw new Error('not reached');
    },
    getPaymentLinkStatus(): Promise<PaymentLinkStatusReport> {
      return new Promise<PaymentLinkStatusReport>(() => {});
    },
  };

  const started = Date.now();
  const result = await collect(railLinkFixture(), silent, CLAIM_NUMBER, {
    linkStatusBudgetMs: 25,
  });

  assertCollectionRefused(result, 'link_status_unknown');
  assert.ok(Date.now() - started < 2_000, 'nobody is left listening to silence');
});

// --- Reconciliation: a capture nobody told us about --------------------------

test('a rail reporting paid overrides a stale local created, and the money is recorded', async () => {
  // The whole point. Razorpay says paid and captured; our row says 'created'
  // with a null payment_id because the webhook never landed. Before this, the
  // row won, `paid` came back false, and the claimant was asked to pay a
  // deductible they had already paid.
  const fixture = railLinkFixture();
  const provider = liveProvider({ [REAL_LINK_ID]: reachableReport('paid') });

  const result = await collect(fixture, provider);

  assertCollected(result);
  assert.equal(result.paid, true);
  assert.equal(result.reused, true);
  assert.equal(result.payment_link_status, 'paid');
  assert.equal(result.deductible_amount, 1500);
  assert.match(result.message, /already been paid/i);
  assert.match(result.message, /hadn't caught up/i);
  assert.equal(provider.issued().length, 0, 'a paid deductible is never answered with a link');

  const row = fixture.deductible_payments[0];
  assert.equal(row.status, 'paid');
  assert.equal(row.payment_id, MISSED_PAYMENT_ID);
  assert.equal(row.captured_amount_paise, DEDUCTIBLE_PAISE, "the rail's figure, not ours");
  assert.equal(row.captured_at, MISSED_PAID_AT);
  assert.equal(fixture.deductible_payments.length, 1, 'no second row, and no second demand');
});

test('the discovery is on the record, and it goes through the one capture path', async () => {
  const fixture = railLinkFixture();
  const provider = liveProvider({ [REAL_LINK_ID]: reachableReport('paid') });

  await collect(fixture, provider);

  assert.deepEqual(journeyTypes(fixture), ['deductible_capture_discovered', 'deductible_paid']);

  const discovery = fixture.journey_events[0] as any;
  assert.equal(discovery.actor, 'system');
  assert.equal(discovery.detail.discovered_via, 'provider');
  assert.equal(discovery.detail.missed_webhook, true);
  assert.equal(discovery.detail.payment_id, MISSED_PAYMENT_ID);
  assert.equal(
    discovery.occurred_at,
    MISSED_PAID_AT,
    'the timeline puts the payment where it happened, not where we noticed'
  );

  // The ledger row says plainly that no webhook delivered this, and its id is
  // out of the renewal side's `recon_` namespace — one table serves both.
  const ledger = fixture.razorpay_webhook_events[0] as any;
  assert.equal(ledger.id, `recon_ded_${MISSED_PAYMENT_ID}`);
  assert.notEqual(ledger.event, 'payment_link.paid', 'no fiction about a delivery that never came');
  assert.equal(ledger.payload.source, 'collect_deductible_reconciliation');
});

test('a rediscovered capture is applied once, and the second call just reports it', async () => {
  const fixture = railLinkFixture();
  const provider = liveProvider({ [REAL_LINK_ID]: reachableReport('paid') });

  assertCollected(await collect(fixture, provider));
  const second = await collect(fixture, provider);

  assertCollected(second);
  assert.equal(second.paid, true);
  assert.equal(second.reused, true);
  assert.equal(provider.issued().length, 0);
  assert.equal(fixture.razorpay_webhook_events.length, 1, 'one ledger row, not two');
  assert.equal(
    fixture.journey_events.filter((row) => row.event_type === 'deductible_paid').length,
    1,
    'the money is recorded once'
  );
});

test('a rail that says paid but names no payment is routed to a human, never billed again', async () => {
  // Inventing a payment id for real money is not a thing this code will do:
  // `payment_id` is what a refund and every idempotency guard key on. Nothing
  // more is owed, and no link may be handed out, so say both.
  const fixture = railLinkFixture();
  const provider = liveProvider({
    [REAL_LINK_ID]: reachableReport('paid', { capture: null }),
  });

  const result = await collect(fixture, provider);

  assertCollectionRefused(result, 'deductible_needs_review');
  assert.match(result.message, /already been paid/i);
  assert.match(result.message, /representative/i);
  assert.equal(provider.issued().length, 0);
  assert.equal(fixture.deductible_payments[0].payment_id, null, 'no identifier was invented');

  const discovery = fixture.journey_events.at(-1) as any;
  assert.equal(discovery.event_type, 'deductible_capture_discovered');
  assert.equal(discovery.detail.payment_id, null);
  assert.match(discovery.detail.unrecordable, /named no payment/i);
});

test('a discovered capture that cannot be filed refuses rather than demanding again', async () => {
  // A short capture: the rail says paid, but for less than we asked. Recording
  // it would set up a refund larger than the money behind it, so the capture
  // path refuses — and this must not fall through to a fresh demand.
  const fixture = railLinkFixture();
  const provider = liveProvider({
    [REAL_LINK_ID]: reachableReport('paid', {
      amountPaidPaise: 50_000,
      capture: { paymentId: MISSED_PAYMENT_ID, amountPaise: 50_000, paidAt: MISSED_PAID_AT },
    }),
  });

  const result = await collect(fixture, provider);

  assertCollectionRefused(result, 'deductible_needs_review');
  assert.equal(provider.issued().length, 0);
  assert.equal(fixture.deductible_payments[0].payment_id, null);
  assert.equal(fixture.deductible_payments.length, 1);
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

// ============================================================================
// The waiver rule, asked from both sides
// ============================================================================

test('only the other party being at fault waives the deductible', () => {
  assert.equal(faultWaivesDeductible('other_party'), true);
  // Shared fault is a finding, and it does not waive. The settlement path asks
  // this same predicate before it attempts a refund, so a second copy of the
  // rule over there cannot come to a different answer.
  assert.equal(faultWaivesDeductible('shared'), false);
  assert.equal(faultWaivesDeductible('insured'), false);
  assert.equal(faultWaivesDeductible('undetermined'), false);
  assert.equal(faultWaivesDeductible(null), false);
  assert.equal(faultWaivesDeductible(undefined), false);
  assert.equal(faultWaivesDeductible(''), false);
});

test('a finding recorded with stray case or spacing is still the same finding', () => {
  assert.equal(faultWaivesDeductible('  Other_Party '), true);
});

// ============================================================================
// Labelling the compromise: a refund that is carrying a simulated settlement
// ============================================================================

test('a refund on a claim whose payout was simulated says it is standing in for it', async () => {
  // Every settlement this deployment can produce is simulated, so on the
  // demonstrable path this refund IS the settlement as far as the money is
  // concerned. It says so rather than leaving a reader to infer it.
  const fixture = capturedFixture({ claim: { payout_id: 'pout_sim_abc', payout_simulated: true } });
  const result = await refund(fixture, new SimulatedPaymentLinkProvider());

  assertRefunded(result);
  assert.equal(result.stands_in_for_settlement, true);
  assert.equal(result.settlement_disclosure, SETTLEMENT_STAND_IN_DISCLOSURE);
  assert.match(result.message, /simulated/i);
  assert.match(result.message, /standing in for that payout/i);
  assert.match(
    result.message,
    /keep your deductible and pay the settlement separately/i,
    'what a real insurer would have done is part of the disclosure, not a footnote'
  );
});

test('a refund on a claim with a real payout is an ordinary waiver, and says nothing more', async () => {
  // Derived from the claim's own payout row, so the disclosure disappears by
  // itself on the day a real payout rail exists.
  const fixture = capturedFixture({ claim: { payout_id: 'pout_real_1', payout_simulated: false } });
  const result = await refund(fixture, new SimulatedPaymentLinkProvider());

  assertRefunded(result);
  assert.equal(result.stands_in_for_settlement, false);
  assert.equal(result.settlement_disclosure, null);
  assert.doesNotMatch(result.message, /standing in/i);
});

test('the label is read off the claim, never off the caller', async () => {
  // There is no option, flag or argument that can turn the disclosure off: the
  // only input is the payout row, and a caller who could assert this could
  // assert its opposite.
  const fixture = capturedFixture({ claim: { payout_simulated: true } });
  const result = await refund(fixture, new SimulatedPaymentLinkProvider(), CLAIM_NUMBER, {
    amountPaise: DEDUCTIBLE_PAISE,
  });
  assertRefunded(result);
  assert.equal(result.stands_in_for_settlement, true);
});

// ============================================================================
// The journey, as each step is taken
// ============================================================================

test('a deductible link that is created is recorded on the journey', async () => {
  const fixture = state();
  assertCollected(await collect(fixture));

  assert.equal(fixture.journey_events.length, 1);
  const [event] = fixture.journey_events;
  assert.equal(event.event_type, 'deductible_requested');
  assert.equal(event.actor, 'agent');
  assert.equal(event.claim_id, CLAIM_ID);
  assert.equal(event.policy_id, POLICY_ID);
  assert.equal(event.detail.deductible_amount, 1500);
  assert.equal(event.detail.simulated, true, 'a simulated link must not render as a payable one');
});

test('re-reading an open link is not a second request, and adds no second event', async () => {
  const fixture = state();
  assertCollected(await collect(fixture));
  const reused = await collect(fixture);
  assertCollected(reused);
  assert.equal(reused.reused, true);

  // The table is append-only. An event written here could never be taken back,
  // and it would put a demand on the timeline that was never made.
  assert.equal(fixture.journey_events.length, 1);
});

test('a captured deductible is recorded on the journey at the rail\'s own timestamp', async () => {
  const fixture = state();
  fixture.deductible_payments.push({
    id: 'dp-1',
    claim_id: CLAIM_ID,
    policy_id: POLICY_ID,
    provider: 'simulated',
    payment_link_id: 'plink_REAL01',
    amount_paise: DEDUCTIBLE_PAISE,
    status: 'created',
    simulated: false,
    payment_id: null,
    captured_amount_paise: null,
  });

  assert.equal((await record(fixture)).outcome, 'recorded');

  const paid = fixture.journey_events.filter((row) => row.event_type === 'deductible_paid');
  assert.equal(paid.length, 1);
  // 'provider', not 'agent' and not 'system': Razorpay told us this happened.
  assert.equal(paid[0].actor, 'provider');
  assert.equal(paid[0].detail.payment_id, 'pay_REAL01');
  assert.equal(
    paid[0].occurred_at,
    '2026-04-01T10:00:00.000Z',
    'a delivery retried an hour later still belongs where the money moved'
  );
});

test('a capture that was refused writes nothing to the journey', async () => {
  // The simulated-link refusal: no money can have arrived, so no step happened.
  const fixture = state();
  fixture.deductible_payments.push({
    id: 'dp-1',
    claim_id: CLAIM_ID,
    payment_link_id: 'plink_REAL01',
    amount_paise: DEDUCTIBLE_PAISE,
    simulated: true,
    payment_id: null,
  });

  assert.equal((await record(fixture)).outcome, 'simulated_link');
  assert.equal(fixture.journey_events.length, 0);
});

test('a refund is recorded on the journey, with the finding that authorised it', async () => {
  const fixture = capturedFixture({ claim: { payout_simulated: true } });
  assertRefunded(await refund(fixture, new SimulatedPaymentLinkProvider()));

  const refunded = fixture.journey_events.filter((row) => row.event_type === 'refunded');
  assert.equal(refunded.length, 1);
  // 'system': the person is on the `decided` event. This is its consequence,
  // and attributing it to them would overstate what they did.
  assert.equal(refunded[0].actor, 'system');
  assert.equal(refunded[0].detail.fault_determination, 'other_party');
  assert.equal(refunded[0].detail.refund_amount, 1500);
  assert.equal(refunded[0].detail.stands_in_for_settlement, true);
});

test('a refused refund writes nothing to the journey', async () => {
  const fixture = capturedFixture({ claim: { fault_determination: 'insured' } });
  assertRefundRefused(await refund(fixture), 'insured_at_fault');
  assert.equal(fixture.journey_events.length, 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  SIMULATED_PAYOUT_DISCLOSURE,
  computeSettlement,
  settleClaim,
  settlementIdempotencyKey,
  type SettleClaimOptions,
  type SettlementPaid,
  type SettlementRefusalReason,
  type SettlementRefused,
  type SettlementResult,
} from './settlement-service.js';
import {
  SimulatedPayoutProvider,
  type Payout,
  type PayoutProvider,
  type PayoutRequest,
} from './payout-provider.js';
import { SimulatedPaymentLinkProvider } from './payment-link-provider.js';

// --- Test doubles -----------------------------------------------------------

interface FakeState {
  claims: Record<string, any>[];
  policies: Record<string, any>[];
  /** Read by the deductible refund the settlement path fires on its way out. */
  deductible_payments: Record<string, any>[];
  /** Written by recordJourneyEvent. Present so a lost event is visible here. */
  journey_events: Record<string, any>[];
  /** Injected faults, so a genuine outage can be told apart from "not found". */
  claimLookupError: any;
  policyLookupError: any;
  updateError: any;
}

/**
 * Minimal PostgREST stand-in covering the shapes this path uses:
 * `.select().eq().maybeSingle()`, `.select().eq()` awaited straight to a list,
 * `.insert()`, and `.update().eq()` with or without a trailing `.is()`. Rows
 * are mutated in place so a second settleClaim call — and the refund fired
 * after the first one — see what the settlement wrote.
 */
function fakeSupabase(state: FakeState) {
  return {
    from(table: string) {
      const rows: Record<string, any>[] = (state as any)[table] ?? ((state as any)[table] = []);
      const error =
        table === 'claims'
          ? state.claimLookupError
          : table === 'policies'
            ? state.policyLookupError
            : null;

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
                // awaits straight to a list — how the refund reads its rows.
                then(resolve: (value: any) => unknown, reject?: (reason: any) => unknown) {
                  const payload = error ? { data: null, error } : { data: matches(), error: null };
                  return Promise.resolve(payload).then(resolve, reject);
                },
              };
            },
          };
        },

        async insert(row: Record<string, unknown>) {
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
                /** The conditional half of the write: `.is('refund_id', null)`. */
                is(isColumn: string, isValue: unknown) {
                  return {
                    then(resolve: (value: any) => unknown, reject?: (reason: any) => unknown) {
                      return Promise.resolve(write({ column: isColumn, value: isValue })).then(
                        resolve,
                        reject
                      );
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

const POLICY_ID = 'policy-1';
const CLAIM_ID = 'claim-1';

function state(overrides: { claim?: Record<string, any>; policy?: Record<string, any> } = {}): FakeState {
  return {
    claims: [
      {
        id: CLAIM_ID,
        claim_number: 'CLM-2026-000321',
        status: 'approved',
        claimed_amount: '3000.00',
        policy_id: POLICY_ID,
        payout_id: null,
        // Nobody has recorded fault. The ordinary case, and the one where no
        // deductible refund is due.
        fault_determination: null,
        ...overrides.claim,
      },
    ],
    policies: [
      {
        id: POLICY_ID,
        policy_number: 'POL-2024-002345',
        status: 'active',
        coverage_amount: '10000.00',
        deductible: '500.00',
        ...overrides.policy,
      },
    ],
    deductible_payments: [],
    journey_events: [],
    claimLookupError: null,
    policyLookupError: null,
    updateError: null,
  };
}

/** The policy's 500.00 deductible, in the minor units the rail deals in. */
const DEDUCTIBLE_PAISE = 50_000;

/**
 * The claim's deductible, collected and captured, as the webhook would have
 * left it. Only a captured payment can be refunded.
 */
function withCapturedDeductible(
  fixture: FakeState,
  overrides: Record<string, any> = {}
): FakeState {
  fixture.deductible_payments.push({
    id: 'dp-1',
    claim_id: CLAIM_ID,
    policy_id: POLICY_ID,
    provider: 'simulated',
    payment_link_id: 'plink_sim_deductible',
    short_url: 'https://simulated-payments.safeguard.invalid/l/abc',
    amount_paise: DEDUCTIBLE_PAISE,
    status: 'paid',
    reference_id: 'ded_test',
    simulated: true,
    payment_id: 'pay_DEDUCTIBLE1',
    captured_amount_paise: DEDUCTIBLE_PAISE,
    captured_at: '2026-04-01T00:00:00.000Z',
    refund_id: null,
    refund_status: null,
    refund_amount_paise: null,
    ...overrides,
  });
  return fixture;
}

function settle(
  fixture: FakeState,
  provider: PayoutProvider = new SimulatedPayoutProvider(),
  claimNumber = 'CLM-2026-000321',
  options: SettleClaimOptions = {}
): Promise<SettlementResult> {
  return settleClaim(
    fakeSupabase(fixture) as unknown as SupabaseClient,
    provider,
    claimNumber,
    options
  );
}

/** A rail that reports real transfers, for the contrast the disclosure draws. */
function realPayoutProvider(): PayoutProvider {
  return {
    name: 'razorpayx',
    async createPayout(request: PayoutRequest): Promise<Payout> {
      return {
        id: 'pout_real_1',
        status: 'processed',
        amountPaise: request.amountPaise,
        currency: 'INR',
        mode: request.mode,
        utr: 'UTR2026041500001',
        simulated: false,
        idempotencyKey: request.idempotencyKey,
        createdAt: new Date().toISOString(),
      };
    },
  };
}

/** Every refusal must be inert: a reason to branch on and nothing disbursed. */
function assertRefused(
  result: SettlementResult,
  reason: SettlementRefusalReason
): asserts result is SettlementRefused {
  assert.equal(result.success, false, `expected a refusal, got ${JSON.stringify(result)}`);
  assert.equal(result.reason, reason);
  assert.equal(result.payout_id, null);
}

function assertPaid(result: SettlementResult): asserts result is SettlementPaid {
  assert.equal(result.success, true, `expected a settlement, got ${JSON.stringify(result)}`);
}

// --- The amount is computed, never supplied ---------------------------------

test('settlement is the claim capped at coverage, less the deductible', () => {
  assert.equal(computeSettlement({ claimedAmount: 3000, coverageAmount: 10000, deductible: 500 }), 2500);
});

test('coverage caps a claim larger than the policy', () => {
  assert.equal(computeSettlement({ claimedAmount: 90000, coverageAmount: 10000, deductible: 500 }), 9500);
});

test('a deductible larger than the claim yields nothing, never a negative payout', () => {
  assert.equal(computeSettlement({ claimedAmount: 400, coverageAmount: 10000, deductible: 500 }), 0);
});

test('NUMERIC columns arriving as strings are still arithmetic', () => {
  // PostgREST serialises NUMERIC as a string; '3000.00' - '500.00' would be NaN.
  assert.equal(computeSettlement({ claimedAmount: '3000.00', coverageAmount: '10000.00', deductible: '500.00' }), 2500);
});

test('missing amounts settle to zero rather than NaN', () => {
  assert.equal(computeSettlement({ claimedAmount: null, coverageAmount: '10000', deductible: '500' }), 0);
});

// --- Happy path -------------------------------------------------------------

test('an approved claim on an active policy is paid the computed amount', async () => {
  const fixture = state();
  const provider = new SimulatedPayoutProvider();
  const result = await settle(fixture, provider);

  assertPaid(result);
  assert.equal(result.settlement_amount, 2500);
  assert.match(result.payout_id, /^pout_sim_/);
  assert.equal(result.payout_status, 'processed');
  assert.equal(result.simulated, true, 'a simulated payout must never read as a real one');

  // The provider is asked for paise, not rupees.
  assert.equal(provider.issued()[0].amountPaise, 250000);
  assert.equal(provider.issued()[0].currency, 'INR');

  const claim = fixture.claims[0];
  assert.equal(claim.status, 'paid');
  assert.equal(claim.approved_amount, 2500);
  assert.equal(claim.payout_amount, 2500);
  assert.equal(claim.payout_simulated, true);
  assert.equal(claim.payout_id, result.payout_id);
  assert.ok(claim.paid_at);
});

test('a claim number spoken without dashes still settles', async () => {
  const fixture = state();
  const result = await settle(fixture, new SimulatedPayoutProvider(), 'clm2026000321');
  assertPaid(result);
  assert.equal(result.claim_number, 'CLM-2026-000321');
});

// --- Gate: claim not found --------------------------------------------------

test('refuses when the claim does not exist', async () => {
  const fixture = state();
  fixture.claims = [];
  fixture.claimLookupError = NOT_FOUND;
  assertRefused(await settle(fixture), 'claim_not_found');
});

test('a database fault refuses as unavailable, not as a missing claim', async () => {
  const fixture = state();
  fixture.claimLookupError = { code: '08006', message: 'connection failure' };
  assertRefused(await settle(fixture), 'records_unavailable');
});

// --- Gate: claim not approved -----------------------------------------------

for (const status of ['submitted', 'under_review', 'documents_needed', 'denied', 'closed']) {
  test(`refuses to pay a claim in ${status} status`, async () => {
    const fixture = state({ claim: { status } });
    const provider = new SimulatedPayoutProvider();
    assertRefused(await settle(fixture, provider), 'claim_not_approved');
    assert.equal(provider.issued().length, 0, 'nothing may reach the payout rail');
    assert.equal(fixture.claims[0].status, status, 'the claim is left untouched');
  });
}

// --- Gate: already paid -----------------------------------------------------

test('refuses a claim already marked paid', async () => {
  const fixture = state({ claim: { status: 'paid' } });
  const provider = new SimulatedPayoutProvider();
  assertRefused(await settle(fixture, provider), 'already_paid');
  assert.equal(provider.issued().length, 0);
});

test('refuses a claim that carries a payout id even if the status write was lost', async () => {
  // The status says approved, but a payout id means money already moved. The
  // payout id is the authority here, not the status.
  const fixture = state({ claim: { status: 'approved', payout_id: 'pout_sim_abc' } });
  assertRefused(await settle(fixture), 'already_paid');
});

// --- Gate: policy not active ------------------------------------------------

for (const status of ['expired', 'cancelled', 'pending']) {
  test(`refuses when the policy is ${status}`, async () => {
    const fixture = state({ policy: { status } });
    assertRefused(await settle(fixture), 'policy_not_active');
  });
}

test('a claim whose policy row is missing is refused, not assumed active', async () => {
  const fixture = state();
  fixture.policies = [];
  fixture.policyLookupError = NOT_FOUND;
  assertRefused(await settle(fixture), 'policy_not_active');
});

// --- Gate: nothing payable --------------------------------------------------

test('refuses when the deductible swallows the claim', async () => {
  const fixture = state({ claim: { claimed_amount: '400.00' } });
  const provider = new SimulatedPayoutProvider();
  const result = await settle(fixture, provider);
  assertRefused(result, 'nothing_payable');
  assert.equal(result.settlement_amount, 0);
  assert.equal(provider.issued().length, 0);
});

test('refuses a claim with no claimed amount at all', async () => {
  assertRefused(await settle(state({ claim: { claimed_amount: null } })), 'nothing_payable');
});

// --- Gate: above the auto-approve ceiling -----------------------------------

test('refuses a settlement above the default ceiling and asks for a human', async () => {
  const fixture = state({
    claim: { claimed_amount: '60000.00' },
    policy: { coverage_amount: '100000.00' },
  });
  const provider = new SimulatedPayoutProvider();
  const result = await settle(fixture, provider);

  assertRefused(result, 'above_auto_approve_limit');
  assert.equal(result.settlement_amount, 59500);
  assert.match(result.message, /authorisation|manager/i);
  assert.equal(provider.issued().length, 0);
  assert.equal(fixture.claims[0].status, 'approved');
});

test('the ceiling is configurable and applied at the boundary', async () => {
  const provider = new SimulatedPayoutProvider();
  const fixture = state();

  // Settlement is exactly 2500: at the limit it pays, a rupee under it refuses.
  const atLimit = await settleClaim(
    fakeSupabase(fixture) as unknown as SupabaseClient,
    provider,
    'CLM-2026-000321',
    { autoApproveLimit: 2500 }
  );
  assertPaid(atLimit);

  const below = await settleClaim(
    fakeSupabase(state()) as unknown as SupabaseClient,
    new SimulatedPayoutProvider(),
    'CLM-2026-000321',
    { autoApproveLimit: 2499 }
  );
  assertRefused(below, 'above_auto_approve_limit');
});

// --- Idempotency ------------------------------------------------------------

test('the idempotency key is derived from the claim number alone', () => {
  assert.equal(
    settlementIdempotencyKey('CLM-2026-000321'),
    settlementIdempotencyKey('CLM-2026-000321'),
    'the same claim must always produce the same key'
  );
  assert.notEqual(
    settlementIdempotencyKey('CLM-2026-000321'),
    settlementIdempotencyKey('CLM-2026-000456')
  );
});

test('the simulated provider returns the first payout for a repeated key', async () => {
  const provider = new SimulatedPayoutProvider();
  const request: PayoutRequest = {
    amountPaise: 250000,
    currency: 'INR',
    mode: 'IMPS',
    purpose: 'payout',
    idempotencyKey: settlementIdempotencyKey('CLM-2026-000321'),
    referenceId: 'CLM-2026-000321',
    narration: 'SafeGuard claim CLM-2026-000321',
  };

  const first = await provider.createPayout(request);
  const second = await provider.createPayout(request);

  assert.equal(second.id, first.id);
  assert.equal(second.utr, first.utr);
  assert.equal(provider.issued().length, 1, 'a replayed key must not create a second payout');
});

test('a second settle attempt pays nothing more', async () => {
  const fixture = state();
  const provider = new SimulatedPayoutProvider();

  assertPaid(await settle(fixture, provider));

  const second = await settle(fixture, provider);
  assertRefused(second, 'already_paid');
  assert.equal(provider.issued().length, 1);
});

test('a retry after a failed record write reuses the same payout', async () => {
  // The dangerous replay: the transfer succeeded but the claim update did not,
  // so the already-paid gate cannot help. The deterministic key does.
  const fixture = state();
  const provider = new SimulatedPayoutProvider();

  fixture.updateError = { code: '57014', message: 'statement timeout' };
  const first = await settle(fixture, provider);
  assertRefused(first, 'settlement_not_recorded');
  assert.equal(fixture.claims[0].status, 'approved');

  fixture.updateError = null;
  const retry = await settle(fixture, provider);

  assertPaid(retry);
  assert.equal(provider.issued().length, 1, 'the retry must reuse the payout, not create one');
  assert.equal(fixture.claims[0].payout_id, provider.issued()[0].id);
});

// --- Provider failures ------------------------------------------------------

test('a payout the rail rejects leaves the claim approved', async () => {
  const failing: PayoutProvider = {
    name: 'failing',
    async createPayout(request: PayoutRequest): Promise<Payout> {
      return {
        id: 'pout_rejected',
        status: 'failed',
        amountPaise: request.amountPaise,
        currency: 'INR',
        mode: request.mode,
        utr: null,
        simulated: true,
        idempotencyKey: request.idempotencyKey,
        createdAt: new Date().toISOString(),
      };
    },
  };

  const fixture = state();
  assertRefused(await settle(fixture, failing), 'payout_failed');
  assert.equal(fixture.claims[0].status, 'approved', 'a transfer that did not land is not "paid"');
});

test('a provider that throws refuses rather than propagating', async () => {
  const throwing: PayoutProvider = {
    name: 'throwing',
    async createPayout(): Promise<Payout> {
      throw new Error('provider unreachable');
    },
  };

  const fixture = state();
  assertRefused(await settle(fixture, throwing), 'payout_failed');
  assert.equal(fixture.claims[0].status, 'approved');
});

// --- What the caller is actually told ---------------------------------------

test('a simulated transfer is disclosed in the sentence the caller hears', async () => {
  // The defect: "The reference for the transfer is SIMUTR…" read out to a
  // person on the phone. /health had always been honest about the simulation;
  // the one surface a human actually consumed was not.
  const fixture = state();
  const result = await settle(fixture);
  assertPaid(result);

  assert.equal(result.simulated, true);
  assert.match(result.message, /simulated/i, 'the spoken sentence must say so itself');
  assert.match(result.message, /no money has actually moved/i);
  assert.doesNotMatch(
    result.message,
    /The reference for the transfer is/,
    'a simulated reference must never be offered as the reference for a transfer'
  );
  // And in a field, for anything reading this as JSON rather than speech.
  assert.equal(result.simulated_disclosure, SIMULATED_PAYOUT_DISCLOSURE);
});

test('a real transfer keeps the plain reference sentence and carries no disclosure', async () => {
  const result = await settle(state(), realPayoutProvider());
  assertPaid(result);

  assert.equal(result.simulated, false);
  assert.equal(result.simulated_disclosure, null);
  assert.match(result.message, /The reference for the transfer is UTR2026041500001\./);
  assert.doesNotMatch(result.message, /simulated/i);
});

test('the settlement is written to the journey, simulation and all', async () => {
  const fixture = state();
  assertPaid(await settle(fixture));

  const settled = fixture.journey_events.filter((row) => row.event_type === 'settled');
  assert.equal(settled.length, 1);
  assert.equal(settled[0].claim_id, CLAIM_ID);
  assert.equal(settled[0].detail.settlement_amount, 2500);
  assert.equal(settled[0].detail.simulated, true);
});

// --- The deductible refund fired on the way out -----------------------------

test('no fault recorded means no refund is attempted at all', async () => {
  const fixture = withCapturedDeductible(state());
  const rail = new SimulatedPaymentLinkProvider();
  const result = await settle(fixture, new SimulatedPayoutProvider(), 'CLM-2026-000321', {
    paymentRail: rail,
  });

  assertPaid(result);
  assert.equal(result.deductible_refund, null);
  assert.equal(result.deductible_refund_skipped, 'fault_does_not_waive');
  assert.equal(rail.refunded().length, 0, 'the rail is never even asked');
  assert.equal(fixture.deductible_payments[0].refund_id, null);
});

for (const fault of ['insured', 'shared', 'undetermined']) {
  test(`fault of '${fault}' does not waive the deductible`, async () => {
    const fixture = withCapturedDeductible(state({ claim: { fault_determination: fault } }));
    const rail = new SimulatedPaymentLinkProvider();
    const result = await settle(fixture, new SimulatedPayoutProvider(), 'CLM-2026-000321', {
      paymentRail: rail,
    });

    assertPaid(result);
    assert.equal(result.deductible_refund_skipped, 'fault_does_not_waive');
    assert.equal(rail.refunded().length, 0);
  });
}

test('with no rail supplied, the settlement says so rather than silently skipping', async () => {
  const fixture = withCapturedDeductible(state({ claim: { fault_determination: 'other_party' } }));
  const result = await settle(fixture);

  assertPaid(result);
  assert.equal(result.deductible_refund, null);
  assert.equal(result.deductible_refund_skipped, 'no_refund_rail');
});

test('the other party at fault: the captured deductible goes back, and is labelled', async () => {
  const fixture = withCapturedDeductible(state({ claim: { fault_determination: 'other_party' } }));
  const rail = new SimulatedPaymentLinkProvider();
  const result = await settle(fixture, new SimulatedPayoutProvider(), 'CLM-2026-000321', {
    paymentRail: rail,
  });

  assertPaid(result);
  assert.equal(result.deductible_refund_skipped, null);
  const refund = result.deductible_refund;
  assert.ok(refund, 'a refund should have been attempted');
  assert.equal(refund.success, true, `expected a refund, got ${JSON.stringify(refund)}`);
  if (!refund.success) return;

  assert.equal(refund.refund_amount, 500);
  assert.equal(refund.payment_id, 'pay_DEDUCTIBLE1');
  assert.equal(rail.refunded().length, 1);
  assert.equal(fixture.deductible_payments[0].refund_id, refund.refund_id);

  // The compromise, stated where a caller and a reader both meet it.
  assert.equal(refund.stands_in_for_settlement, true);
  assert.match(result.message, /standing in for the settlement payout/i);
  assert.match(result.message, /keep the deductible and pay the settlement separately/i);
  assert.match(result.simulated_disclosure ?? '', /standing in for that payout/i);
});

test('a real payout means the refund is an ordinary waiver, not a stand-in', async () => {
  // The label is derived from the claim's own payout row, so the day a real
  // payout rail exists the disclosure disappears without anyone editing it.
  const fixture = withCapturedDeductible(state({ claim: { fault_determination: 'other_party' } }));
  const rail = new SimulatedPaymentLinkProvider();
  const result = await settle(fixture, realPayoutProvider(), 'CLM-2026-000321', {
    paymentRail: rail,
  });

  assertPaid(result);
  const refund = result.deductible_refund;
  assert.ok(refund && refund.success);
  if (!refund.success) return;
  assert.equal(refund.stands_in_for_settlement, false);
  assert.equal(refund.settlement_disclosure, null);
  assert.doesNotMatch(result.message, /standing in for/i);
  assert.match(result.message, /deductible has also been refunded/i);
});

test('the refund never exceeds what was actually captured', async () => {
  // The capture is short of the amount demanded — which the webhook would have
  // refused to record, but if it ever were, the refund follows the capture.
  const fixture = withCapturedDeductible(state({ claim: { fault_determination: 'other_party' } }), {
    captured_amount_paise: 30_000,
  });
  const rail = new SimulatedPaymentLinkProvider();
  const result = await settle(fixture, new SimulatedPayoutProvider(), 'CLM-2026-000321', {
    paymentRail: rail,
  });

  assertPaid(result);
  const refund = result.deductible_refund;
  assert.ok(refund && refund.success);
  if (!refund.success) return;
  assert.equal(refund.refund_amount, 300, 'the capture bounds the refund, not the demand');
  assert.equal(rail.refunded()[0].amountPaise, 30_000);
});

test('a settled claim with no captured deductible refuses the refund and stays settled', async () => {
  const fixture = state({ claim: { fault_determination: 'other_party' } });
  const rail = new SimulatedPaymentLinkProvider();
  const result = await settle(fixture, new SimulatedPayoutProvider(), 'CLM-2026-000321', {
    paymentRail: rail,
  });

  assertPaid(result);
  const refund = result.deductible_refund;
  assert.ok(refund);
  assert.equal(refund.success, false);
  assert.equal(refund.reason, 'no_captured_payment');
  assert.equal(rail.refunded().length, 0);
  // The settlement itself stands. A refusal on the refund is not a failed
  // settlement, and the claim must not be dragged back out of 'paid'.
  assert.equal(fixture.claims[0].status, 'paid');
});

test('a retried settlement does not refund the deductible twice', async () => {
  const fixture = withCapturedDeductible(state({ claim: { fault_determination: 'other_party' } }));
  const rail = new SimulatedPaymentLinkProvider();
  const payouts = new SimulatedPayoutProvider();

  assertPaid(await settle(fixture, payouts, 'CLM-2026-000321', { paymentRail: rail }));
  assert.equal(rail.refunded().length, 1);

  // The second attempt never gets past the already-paid gate, so the refund is
  // never reconsidered; and were it reconsidered, refundDeductible's own
  // already-refunded gate stands behind it.
  assertRefused(
    await settle(fixture, payouts, 'CLM-2026-000321', { paymentRail: rail }),
    'already_paid'
  );
  assert.equal(rail.refunded().length, 1, 'the money goes back exactly once');
});

test('the refund is written to the journey as its own step', async () => {
  const fixture = withCapturedDeductible(state({ claim: { fault_determination: 'other_party' } }));
  await settle(fixture, new SimulatedPayoutProvider(), 'CLM-2026-000321', {
    paymentRail: new SimulatedPaymentLinkProvider(),
  });

  const types = fixture.journey_events.map((row) => row.event_type);
  assert.deepEqual(types, ['settled', 'refunded'], 'in the order the money moved');
  const refunded = fixture.journey_events[1];
  assert.equal(refunded.actor, 'system');
  assert.equal(refunded.detail.stands_in_for_settlement, true);
  assert.equal(refunded.detail.fault_determination, 'other_party');
});

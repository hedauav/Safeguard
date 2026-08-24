import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeSettlement,
  settleClaim,
  settlementIdempotencyKey,
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

// --- Test doubles -----------------------------------------------------------

interface FakeState {
  claims: Record<string, any>[];
  policies: Record<string, any>[];
  /** Injected faults, so a genuine outage can be told apart from "not found". */
  claimLookupError: any;
  policyLookupError: any;
  updateError: any;
}

/**
 * Minimal PostgREST stand-in covering only the two shapes the service uses:
 * `.select().eq().maybeSingle()` and `.update().eq()`. Rows are mutated in
 * place so a second settleClaim call sees what the first one wrote.
 */
function fakeSupabase(state: FakeState) {
  return {
    from(table: string) {
      const rows: Record<string, any>[] = (state as any)[table];
      return {
        select() {
          return {
            eq(column: string, value: unknown) {
              return {
                async maybeSingle() {
                  const error = table === 'claims' ? state.claimLookupError : state.policyLookupError;
                  if (error) return { data: null, error };
                  return { data: rows.find((row) => row[column] === value) ?? null, error: null };
                },
              };
            },
          };
        },
        update(patch: Record<string, unknown>) {
          return {
            async eq(column: string, value: unknown) {
              if (state.updateError) return { error: state.updateError };
              const row = rows.find((r) => r[column] === value);
              if (row) Object.assign(row, patch);
              return { error: null };
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
    claimLookupError: null,
    policyLookupError: null,
    updateError: null,
  };
}

function settle(
  fixture: FakeState,
  provider: PayoutProvider = new SimulatedPayoutProvider(),
  claimNumber = 'CLM-2026-000321'
): Promise<SettlementResult> {
  return settleClaim(fakeSupabase(fixture) as unknown as SupabaseClient, provider, claimNumber);
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeRenewalAmount,
  offerRenewal,
  renewalReferenceId,
  type RenewalOffered,
  type RenewalRefusalReason,
  type RenewalRefused,
  type RenewalResult,
} from './renewal-service.js';
import {
  RazorpayPaymentLinkProvider,
  SimulatedPaymentLinkProvider,
  createPaymentLinkProvider,
  type PaymentLink,
  type PaymentLinkProvider,
  type PaymentLinkRequest,
} from './payment-link-provider.js';

// --- Test doubles -----------------------------------------------------------

interface FakeState {
  policies: Record<string, any>[];
  policy_renewals: Record<string, any>[];
  /** Injected faults, so a genuine outage can be told apart from "not found". */
  policyLookupError: any;
  renewalLookupError: any;
  insertError: any;
}

/**
 * Minimal PostgREST stand-in covering only the three shapes the service uses:
 * `.select().eq().maybeSingle()`, `.select().eq()` awaited for a list, and
 * `.insert()`. Rows are mutated in place so a second offerRenewal call sees
 * what the first one wrote.
 */
function fakeSupabase(state: FakeState) {
  return {
    from(table: string) {
      const rows: Record<string, any>[] = (state as any)[table];
      const error = table === 'policies' ? state.policyLookupError : state.renewalLookupError;
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
                  const payload = error
                    ? { data: null, error }
                    : { data: matches(), error: null };
                  return Promise.resolve(payload).then(resolve, reject);
                },
              };
            },
          };
        },
        async insert(row: Record<string, unknown>) {
          if (state.insertError) return { error: state.insertError };
          rows.push({ id: `renewal-${rows.length + 1}`, ...row });
          return { error: null };
        },
      };
    },
  };
}

// PostgREST's "no rows" code. Anything else is a real fault.
const NOT_FOUND = { code: 'PGRST116', message: 'no rows' };

const POLICY_ID = 'policy-1';
const POLICY_NUMBER = 'POL-2022-000111';

function state(overrides: { policy?: Record<string, any> } = {}): FakeState {
  return {
    policies: [
      {
        id: POLICY_ID,
        policy_number: POLICY_NUMBER,
        policy_type: 'auto',
        status: 'expired',
        premium_monthly: '165.00',
        end_date: '2023-01-31',
        ...overrides.policy,
      },
    ],
    policy_renewals: [],
    policyLookupError: null,
    renewalLookupError: null,
    insertError: null,
  };
}

function offer(
  fixture: FakeState,
  provider: PaymentLinkProvider = new SimulatedPaymentLinkProvider(),
  policyNumber = POLICY_NUMBER
): Promise<RenewalResult> {
  return offerRenewal(fakeSupabase(fixture) as unknown as SupabaseClient, provider, policyNumber);
}

/** Every refusal must be inert: a reason to branch on and no payable link. */
function assertRefused(
  result: RenewalResult,
  reason: RenewalRefusalReason
): asserts result is RenewalRefused {
  assert.equal(result.success, false, `expected a refusal, got ${JSON.stringify(result)}`);
  assert.equal(result.reason, reason);
  assert.equal(result.payment_link_id, null);
  assert.equal(result.payment_link_url, null);
}

function assertOffered(result: RenewalResult): asserts result is RenewalOffered {
  assert.equal(result.success, true, `expected an offer, got ${JSON.stringify(result)}`);
}

// --- The amount is computed, never supplied ---------------------------------

test('the renewal is the monthly premium for the whole term', () => {
  assert.equal(computeRenewalAmount({ premiumMonthly: 165, termMonths: 12 }), 1980);
});

test('NUMERIC columns arriving as strings are still arithmetic', () => {
  // PostgREST serialises NUMERIC as a string; '165.00' * 12 must not be NaN.
  assert.equal(computeRenewalAmount({ premiumMonthly: '165.00', termMonths: 12 }), 1980);
});

test('a missing premium renews to zero rather than NaN', () => {
  assert.equal(computeRenewalAmount({ premiumMonthly: null, termMonths: 12 }), 0);
});

test('a zero or negative term yields nothing, never a negative demand', () => {
  assert.equal(computeRenewalAmount({ premiumMonthly: '165.00', termMonths: 0 }), 0);
  assert.equal(computeRenewalAmount({ premiumMonthly: '165.00', termMonths: -6 }), 0);
});

// --- Happy path -------------------------------------------------------------

test('an expired policy is offered a link for the exact premium owed', async () => {
  const fixture = state();
  const provider = new SimulatedPaymentLinkProvider();
  const result = await offer(fixture, provider);

  assertOffered(result);
  assert.equal(result.policy_number, POLICY_NUMBER);
  assert.equal(result.renewal_amount, 1980); // 165.00 x 12
  assert.equal(result.term_months, 12);
  assert.match(result.payment_link_id, /^plink_sim_/);
  assert.match(result.payment_link_url, /^https:\/\//);
  assert.equal(result.payment_link_status, 'created');
  assert.equal(result.simulated, true, 'a simulated link must never read as a payable one');
  assert.equal(result.reused, false);

  // The provider is asked for paise, not rupees.
  assert.equal(provider.issued()[0].amountPaise, 198000);
  assert.equal(provider.issued()[0].currency, 'INR');

  const row = fixture.policy_renewals[0];
  assert.equal(row.policy_id, POLICY_ID);
  assert.equal(row.amount_paise, 198000);
  assert.equal(row.term_months, 12);
  assert.equal(row.status, 'created');
  assert.equal(row.simulated, true);
  assert.equal(row.reference_id, renewalReferenceId(POLICY_NUMBER));
  assert.equal(row.provider, 'simulated');
});

test('the message refuses the claim and names the amount and the link', async () => {
  const result = await offer(state());
  assertOffered(result);
  assert.match(result.message, /lapsed/i);
  assert.ok(result.message.includes('1980.00'));
  assert.ok(result.message.includes(result.payment_link_url));
});

test('a policy number spoken without dashes still gets an offer', async () => {
  const result = await offer(state(), new SimulatedPaymentLinkProvider(), 'pol2022000111');
  assertOffered(result);
  assert.equal(result.policy_number, POLICY_NUMBER);
});

// --- Gate: policy not found -------------------------------------------------

test('refuses when the policy does not exist', async () => {
  const fixture = state();
  fixture.policies = [];
  fixture.policyLookupError = NOT_FOUND;
  const provider = new SimulatedPaymentLinkProvider();
  assertRefused(await offer(fixture, provider), 'policy_not_found');
  assert.equal(provider.issued().length, 0, 'nothing may reach the payment rail');
});

// --- Gate: records unavailable ----------------------------------------------

test('a database fault refuses as unavailable, not as a missing policy', async () => {
  const fixture = state();
  fixture.policyLookupError = { code: '08006', message: 'connection failure' };
  const result = await offer(fixture);
  assertRefused(result, 'records_unavailable');
  assert.notEqual(result.reason, 'policy_not_found');
});

test('a fault reading existing renewals refuses rather than issuing a duplicate', async () => {
  // The dangerous read: if this failed open we could not see the link already
  // sent, and would bill the same premium twice.
  const fixture = state();
  fixture.renewalLookupError = { code: '57014', message: 'statement timeout' };
  const provider = new SimulatedPaymentLinkProvider();
  assertRefused(await offer(fixture, provider), 'records_unavailable');
  assert.equal(provider.issued().length, 0);
});

// --- Gate: policy already active --------------------------------------------

test('refuses an active policy — there is nothing to renew', async () => {
  const fixture = state({ policy: { status: 'active' } });
  const provider = new SimulatedPaymentLinkProvider();
  const result = await offer(fixture, provider);
  assertRefused(result, 'policy_already_active');
  assert.equal(provider.issued().length, 0);
  assert.equal(fixture.policy_renewals.length, 0);
});

// --- Gate: policy cancelled -------------------------------------------------

test('refuses a cancelled policy: termination is a decision, not a payment', async () => {
  const fixture = state({ policy: { status: 'cancelled' } });
  const provider = new SimulatedPaymentLinkProvider();
  const result = await offer(fixture, provider);

  assertRefused(result, 'policy_cancelled');
  assert.notEqual(result.reason, 'policy_not_renewable', 'cancellation needs its own reason');
  assert.match(result.message, /representative/i);
  assert.equal(provider.issued().length, 0, 'a cancelled policy must never reach the payment rail');
  assert.equal(fixture.policy_renewals.length, 0);
});

// --- Gate: policy not renewable ---------------------------------------------

test('refuses a pending policy — no lapsed term to buy back', async () => {
  const fixture = state({ policy: { status: 'pending' } });
  const provider = new SimulatedPaymentLinkProvider();
  assertRefused(await offer(fixture, provider), 'policy_not_renewable');
  assert.equal(provider.issued().length, 0);
});

// --- Gate: nothing payable --------------------------------------------------

test('refuses when the policy carries no premium', async () => {
  const fixture = state({ policy: { premium_monthly: null } });
  const provider = new SimulatedPaymentLinkProvider();
  const result = await offer(fixture, provider);
  assertRefused(result, 'nothing_payable');
  assert.equal(result.renewal_amount, 0);
  assert.equal(provider.issued().length, 0);
});

test('refuses when the configured term is zero', async () => {
  const provider = new SimulatedPaymentLinkProvider();
  const result = await offerRenewal(
    fakeSupabase(state()) as unknown as SupabaseClient,
    provider,
    POLICY_NUMBER,
    { termMonths: 0 }
  );
  assertRefused(result, 'nothing_payable');
  assert.equal(provider.issued().length, 0);
});

// --- Gate: above the link ceiling -------------------------------------------

test('refuses a premium above the default ceiling and asks for a human', async () => {
  // 20000 x 12 = 240000, over the 200000 default.
  const fixture = state({ policy: { premium_monthly: '20000.00' } });
  const provider = new SimulatedPaymentLinkProvider();
  const result = await offer(fixture, provider);

  assertRefused(result, 'above_link_limit');
  assert.equal(result.renewal_amount, 240000);
  assert.match(result.message, /representative/i);
  assert.equal(provider.issued().length, 0);
  assert.equal(fixture.policy_renewals.length, 0);
});

test('the ceiling is configurable and applied at the boundary', async () => {
  // The renewal is exactly 1980: at the limit it offers, a rupee under refuses.
  const atLimit = await offerRenewal(
    fakeSupabase(state()) as unknown as SupabaseClient,
    new SimulatedPaymentLinkProvider(),
    POLICY_NUMBER,
    { maxLinkAmount: 1980 }
  );
  assertOffered(atLimit);

  const below = await offerRenewal(
    fakeSupabase(state()) as unknown as SupabaseClient,
    new SimulatedPaymentLinkProvider(),
    POLICY_NUMBER,
    { maxLinkAmount: 1979 }
  );
  assertRefused(below, 'above_link_limit');
});

// --- Idempotency ------------------------------------------------------------

test('the reference id is derived from the policy number alone', () => {
  assert.equal(
    renewalReferenceId(POLICY_NUMBER),
    renewalReferenceId(POLICY_NUMBER),
    'the same policy must always produce the same reference'
  );
  assert.notEqual(renewalReferenceId(POLICY_NUMBER), renewalReferenceId('POL-2024-000222'));
  assert.notEqual(
    renewalReferenceId(POLICY_NUMBER),
    renewalReferenceId(POLICY_NUMBER, 2),
    're-issuing after an expired link needs a reference the provider has not seen'
  );
});

test('the simulated provider returns the first link for a repeated reference', async () => {
  const provider = new SimulatedPaymentLinkProvider();
  const request: PaymentLinkRequest = {
    amountPaise: 198000,
    currency: 'INR',
    referenceId: renewalReferenceId(POLICY_NUMBER),
    description: `SafeGuard renewal - policy ${POLICY_NUMBER} (12 months)`,
  };

  const first = await provider.createPaymentLink(request);
  const second = await provider.createPaymentLink(request);

  assert.equal(second.id, first.id);
  assert.equal(second.shortUrl, first.shortUrl);
  assert.equal(provider.issued().length, 1, 'a replayed reference must not create a second link');
});

test('offering twice yields one link, not two demands for the same premium', async () => {
  const fixture = state();
  const provider = new SimulatedPaymentLinkProvider();

  const first = await offer(fixture, provider);
  assertOffered(first);
  assert.equal(first.reused, false);

  const second = await offer(fixture, provider);
  assertOffered(second);

  assert.equal(second.payment_link_id, first.payment_link_id);
  assert.equal(second.payment_link_url, first.payment_link_url);
  assert.equal(second.renewal_amount, first.renewal_amount);
  assert.equal(second.reused, true, 'the second call returns the existing link');
  assert.equal(provider.issued().length, 1, 'the rail is asked once');
  assert.equal(fixture.policy_renewals.length, 1, 'one row, not two');
});

test('an already-paid link is returned rather than re-issued', async () => {
  const fixture = state();
  const provider = new SimulatedPaymentLinkProvider();
  assertOffered(await offer(fixture, provider));

  fixture.policy_renewals[0].status = 'paid';
  const second = await offer(fixture, provider);

  assertOffered(second);
  assert.equal(second.reused, true, 'a paid renewal must not be billed again');
  assert.equal(fixture.policy_renewals.length, 1);
});

test('a spent link is replaced with a fresh reference the provider has not seen', async () => {
  const fixture = state();
  const provider = new SimulatedPaymentLinkProvider();
  assertOffered(await offer(fixture, provider));

  // Nobody paid before it lapsed, so there is no live offer left to return.
  fixture.policy_renewals[0].status = 'expired';
  const reissued = await offer(fixture, provider);

  assertOffered(reissued);
  assert.equal(reissued.reused, false);
  assert.equal(reissued.reference_id, renewalReferenceId(POLICY_NUMBER, 2));
  assert.notEqual(reissued.payment_link_id, fixture.policy_renewals[0].payment_link_id);
  assert.equal(provider.issued().length, 2);
});

// --- Provider and record failures -------------------------------------------

test('a provider that throws refuses rather than propagating', async () => {
  const throwing: PaymentLinkProvider = {
    name: 'throwing',
    async createPaymentLink(): Promise<PaymentLink> {
      throw new Error('provider unreachable');
    },
  };

  const fixture = state();
  assertRefused(await offer(fixture, throwing), 'link_failed');
  assert.equal(fixture.policy_renewals.length, 0, 'nothing unpayable may be recorded');
});

test('a link that comes back already expired is never read out', async () => {
  const dead: PaymentLinkProvider = {
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
  };

  const fixture = state();
  assertRefused(await offer(fixture, dead), 'link_failed');
  assert.equal(fixture.policy_renewals.length, 0);
});

test('a link that cannot be recorded is refused rather than read out untracked', async () => {
  const fixture = state();
  fixture.insertError = { code: '57014', message: 'statement timeout' };
  const result = await offer(fixture);

  assertRefused(result, 'renewal_not_recorded');
  assert.equal(result.renewal_amount, 1980);
  assert.equal(fixture.policy_renewals.length, 0);
});

// --- Provider selection and the Razorpay wire format ------------------------

test('credentials select the real provider; their absence selects the simulation', () => {
  assert.equal(createPaymentLinkProvider({ keyId: null, keySecret: null }).name, 'simulated');
  assert.equal(createPaymentLinkProvider({ keyId: 'rzp_test_x', keySecret: null }).name, 'simulated');
  assert.equal(
    createPaymentLinkProvider({ keyId: 'rzp_test_x', keySecret: 'shh' }).name,
    'razorpay',
    'a real provider wins whenever both credentials are present'
  );
});

test('the Razorpay provider sends paise under Basic auth and maps the response', async () => {
  // A stub fetch, so the wire format is pinned without touching the network.
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
            id: 'plink_ABC123',
            status: 'created',
            amount: 198000,
            short_url: 'https://rzp.io/i/abc123',
            reference_id: JSON.parse(init.body).reference_id,
            created_at: 1700000000,
          };
        },
      };
    }) as unknown as typeof fetch,
  });

  const link = await provider.createPaymentLink({
    amountPaise: 198000,
    currency: 'INR',
    referenceId: renewalReferenceId(POLICY_NUMBER),
    description: 'SafeGuard renewal',
  });

  assert.equal(seenUrl, 'https://api.example.invalid/v1/payment_links');
  assert.equal(seenInit.method, 'POST');
  assert.equal(
    seenInit.headers.Authorization,
    `Basic ${Buffer.from('rzp_test_key:secret').toString('base64')}`
  );

  const body = JSON.parse(seenInit.body);
  assert.equal(body.amount, 198000, 'minor units, never rupees');
  assert.equal(body.currency, 'INR');
  assert.equal(body.reference_id, renewalReferenceId(POLICY_NUMBER));
  assert.deepEqual(body.notify, { sms: false, email: false }, 'nothing is sent on the customer\'s behalf');

  assert.equal(link.id, 'plink_ABC123');
  assert.equal(link.shortUrl, 'https://rzp.io/i/abc123');
  assert.equal(link.status, 'created');
  assert.equal(link.simulated, false, 'a real link must never be flagged simulated');
});

test('a Razorpay error throws instead of returning a half-built link', async () => {
  const provider = new RazorpayPaymentLinkProvider('rzp_test_key', 'secret', {
    fetchImpl: (async () => ({
      ok: false,
      status: 400,
      async text() {
        return '{"error":{"description":"reference_id already exists"}}';
      },
    })) as unknown as typeof fetch,
  });

  await assert.rejects(
    provider.createPaymentLink({
      amountPaise: 198000,
      currency: 'INR',
      referenceId: 'rnw_dup',
      description: 'SafeGuard renewal',
    }),
    /400/
  );
});

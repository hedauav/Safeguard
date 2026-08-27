import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeRenewalAmount,
  computeRenewedEndDate,
  offerRenewal,
  recordRenewalCapture,
  recordRenewalFailure,
  renewalReferenceId,
  type RenewalOffered,
  type RenewalRefusalReason,
  type RenewalRefused,
  type RenewalResult,
} from './renewal-service.js';
import type {
  RazorpayCapture,
  RazorpayPaymentFailure,
} from './razorpay-webhook.js';
import {
  RazorpayPaymentLinkProvider,
  SimulatedPaymentLinkProvider,
  createPaymentLinkProvider,
  type PaymentLink,
  type PaymentLinkProvider,
  type PaymentLinkRequest,
  type PaymentLinkStatus,
  type PaymentLinkStatusReport,
} from './payment-link-provider.js';

// --- Test doubles -----------------------------------------------------------

interface FakeState {
  policies: Record<string, any>[];
  policy_renewals: Record<string, any>[];
  razorpay_webhook_events: Record<string, any>[];
  journey_events: Record<string, any>[];
  /** Injected faults, so a genuine outage can be told apart from "not found". */
  policyLookupError: any;
  renewalLookupError: any;
  insertError: any;
  /** Per-table insert faults, for the ones the global switch is too blunt for. */
  insertErrors: Record<string, any>;
  /** A failed write to policy_renewals. */
  updateError: any;
  /** A failed write to policies — the one table this service mutates. */
  policyUpdateError: any;
}

/**
 * Minimal PostgREST stand-in covering only the shapes this service uses:
 * `.select().eq().maybeSingle()`, `.select().eq()` awaited for a list,
 * `.insert()`, and an update chain of `.eq()` / `.is()` / `.neq()` either
 * awaited directly or terminated with `.select()`. Rows are mutated in place
 * so a second call sees what the first one wrote.
 *
 * `.select()` after an update matters here rather than being decoration: it is
 * how `activatePolicy` tells "the cancellation guard stopped the write" from
 * "the write happened", so the double has to return the rows it changed and
 * an empty list when it changed none.
 */
function fakeSupabase(state: FakeState) {
  return {
    from(table: string) {
      const rows: Record<string, any>[] =
        (state as any)[table] ?? ((state as any)[table] = []);
      const readError =
        table === 'policies'
          ? state.policyLookupError
          : table === 'policy_renewals'
            ? state.renewalLookupError
            : null;
      const writeError = table === 'policies' ? state.policyUpdateError : state.updateError;

      return {
        select() {
          return {
            eq(column: string, value: unknown) {
              const matches = () => rows.filter((row) => row[column] === value);
              return {
                async maybeSingle() {
                  if (readError) return { data: null, error: readError };
                  return { data: matches()[0] ?? null, error: null };
                },
                // PostgREST builders are thenable, so an un-terminated query
                // awaits straight to a list.
                then(resolve: (value: any) => unknown, reject?: (reason: any) => unknown) {
                  const payload = readError
                    ? { data: null, error: readError }
                    : { data: matches(), error: null };
                  return Promise.resolve(payload).then(resolve, reject);
                },
              };
            },
          };
        },

        async insert(row: Record<string, unknown>) {
          const failure = state.insertErrors[table] ?? state.insertError;
          if (failure) return { error: failure };
          rows.push({ id: `${table}-${rows.length + 1}`, ...row });
          return { error: null };
        },

        update(patch: Record<string, unknown>) {
          const filters: ((row: Record<string, any>) => boolean)[] = [];
          const run = () => {
            if (writeError) return { data: null, error: writeError };
            const targets = rows.filter((row) => filters.every((match) => match(row)));
            for (const row of targets) Object.assign(row, patch);
            // A copy, as PostgREST returns: the caller must not be handed a
            // live reference it could mutate the fixture through.
            return { data: targets.map((row) => ({ ...row })), error: null };
          };
          const chain: any = {
            eq(column: string, value: unknown) {
              filters.push((row) => row[column] === value);
              return chain;
            },
            /** `.is(column, null)` — the "not yet captured" guard. */
            is(column: string, value: unknown) {
              filters.push((row) => (row[column] ?? null) === value);
              return chain;
            },
            /** `.neq('status', 'cancelled')` — the never-reactivate guard. */
            neq(column: string, value: unknown) {
              filters.push((row) => row[column] !== value);
              return chain;
            },
            select() {
              return {
                then(resolve: (value: any) => unknown, reject?: (reason: any) => unknown) {
                  return Promise.resolve(run()).then(resolve, reject);
                },
              };
            },
            then(resolve: (value: any) => unknown, reject?: (reason: any) => unknown) {
              return Promise.resolve(run()).then(resolve, reject);
            },
          };
          return chain;
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
    razorpay_webhook_events: [],
    journey_events: [],
    policyLookupError: null,
    renewalLookupError: null,
    insertError: null,
    insertErrors: {},
    updateError: null,
    policyUpdateError: null,
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

test('a paid link is never handed back — it is the most spent a link can be', async () => {
  // The production fault. `paid` was missing from SPENT_LINK_STATUSES, so a
  // link Razorpay had already captured against stayed eligible for reuse
  // forever. A caller was read one out, tapped it, was told it was already
  // paid, and nothing happened — no payment, therefore no webhook, therefore
  // no reactivation.
  //
  // The row here is a finished renewal: paid, captured, and applied to the
  // policy, which has since run its term and lapsed again. That is a policy
  // genuinely owed a NEW link, and the old one must play no part in it.
  const fixture = state();
  const provider = new SimulatedPaymentLinkProvider();
  assertOffered(await offer(fixture, provider));

  const settled = fixture.policy_renewals[0];
  settled.status = 'paid';
  settled.payment_id = 'pay_LASTYEAR';
  settled.captured_amount_paise = 198_000;
  settled.captured_at = '2025-08-01T00:00:00.000Z';
  settled.activated_at = '2025-08-01T00:00:05.000Z';

  const second = await offer(fixture, provider);

  assertOffered(second);
  assert.equal(second.reused, false, 'a paid link is spent, not open');
  assert.notEqual(second.payment_link_id, settled.payment_link_id);
  assert.notEqual(second.payment_link_url, settled.short_url);
  assert.equal(fixture.policy_renewals.length, 2, 'the new term gets its own row');
});

test('a paid row is not offered even when its own status says otherwise', async () => {
  // `status` is a label a webhook wrote; `payment_id` is the identifier of
  // money we actually hold. Where they disagree the money wins.
  const fixture = state();
  fixture.policy_renewals.push(
    priorRow({
      ...REAL_ROW,
      status: 'created',
      payment_id: 'pay_LASTYEAR',
      captured_amount_paise: 198_000,
      captured_at: '2025-08-01T00:00:00.000Z',
      activated_at: '2025-08-01T00:00:05.000Z',
    })
  );

  const result = await offer(fixture, liveProvider());

  assertOffered(result);
  assert.equal(result.reused, false);
  assert.notEqual(result.payment_link_url, REAL_ROW.short_url);
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

// --- A dead link must not survive a provider upgrade ------------------------

/** A provider report saying the link is exactly as we last believed. */
function reachableReport(
  status: PaymentLinkStatus,
  overrides: Partial<Extract<PaymentLinkStatusReport, { reachable: true }>> = {}
): PaymentLinkStatusReport {
  return {
    reachable: true,
    id: 'plink_REAL_RNW',
    status,
    amountPaise: 198_000,
    amountPaidPaise: status === 'paid' ? 198_000 : 0,
    referenceId: null,
    capture:
      status === 'paid'
        ? { paymentId: 'pay_MISSED01', amountPaise: 198_000, paidAt: '2026-08-26T07:41:45.000Z' }
        : null,
    simulated: false,
    ...overrides,
  };
}

/**
 * A rail that issues real, payable links, and answers for the ones it holds.
 *
 * It reports the name the Razorpay provider reports, because that name is the
 * only thing `offerRenewal` can read to tell a live rail from the simulation:
 * the provider interface exposes a name and a method, and nothing on it says
 * whether a link will be payable until one has been created.
 *
 * `statuses` is what the rail says about links it did not issue in this test —
 * the rows already sitting in the fixture. It defaults to "still payable",
 * which is the case that must keep behaving exactly as it always did.
 */
function liveProvider(
  statuses: Record<string, PaymentLinkStatusReport> = {}
): PaymentLinkProvider & { issued(): PaymentLink[]; asked(): string[] } {
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
        shortUrl: `https://rzp.io/i/real${links.length + 1}`,
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
    issued: () => links,
    asked: () => asked,
  };
}

/** A URL the customer could actually pay, and the row that would carry it. */
const REAL_ROW = {
  provider: 'razorpay',
  payment_link_id: 'plink_REAL_RNW',
  short_url: 'https://rzp.io/i/realrnw',
  simulated: false,
};

/**
 * A renewal row already on the policy, as PostgREST would hand it back.
 *
 * Simulated by default, because that is the row this whole section is about:
 * one written back when no Razorpay credentials were configured, carrying a
 * URL on the reserved `.invalid` TLD that can never resolve.
 */
function priorRow(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'rnw-prior',
    policy_id: POLICY_ID,
    provider: 'simulated',
    payment_link_id: 'plink_sim_08b1f617addf',
    short_url: 'https://simulated-payments.safeguard.invalid/l/08b1f617addf',
    amount_paise: 198_000, // 1,980 rupees, matching the policy above
    term_months: 12,
    status: 'created',
    reference_id: renewalReferenceId(POLICY_NUMBER),
    simulated: true,
    ...overrides,
  };
}

test('a simulated link is not reused once the rail is real', async () => {
  // The production fault, reproduced: the row was written before any Razorpay
  // keys existed, nothing ever moves a simulated row out of 'created', and the
  // reuse path handed its unpayable URL back on every call thereafter. One of
  // them was read out to a caller on a live call.
  const fixture = state();
  fixture.policy_renewals.push(priorRow());
  const provider = liveProvider();

  const result = await offer(fixture, provider);

  assertOffered(result);
  assert.equal(result.reused, false, 'a link nobody can pay is not an open offer');
  assert.equal(result.simulated, false);
  assert.ok(
    !result.payment_link_url.includes('.invalid'),
    'the caller must never be read a host that cannot resolve'
  );
  assert.equal(result.renewal_amount, 1980, 'the premium is recomputed, not carried over');
  assert.equal(provider.issued().length, 1, 'the real rail was actually asked for a link');
  assert.equal(fixture.policy_renewals.length, 2, 'the new link is recorded beside the old row');
});

test('the superseded row is left exactly as it was, and the timeline says why', async () => {
  const fixture = state();
  fixture.policy_renewals.push(priorRow());
  const before = { ...fixture.policy_renewals[0] };

  assertOffered(await offer(fixture, liveProvider()));

  assert.deepEqual(
    fixture.policy_renewals[0],
    before,
    'the row states what happened; it is not rewritten to tidy the query up'
  );
  const offered = fixture.journey_events.at(-1) as any;
  assert.equal(offered.event_type, 'renewal_offered');
  assert.deepEqual(offered.detail.superseded_simulated_link_ids, [before.payment_link_id]);
});

test('a real link is still reused when the rail is real', async () => {
  const fixture = state();
  fixture.policy_renewals.push(priorRow(REAL_ROW));
  const provider = liveProvider();

  const result = await offer(fixture, provider);

  assertOffered(result);
  assert.equal(result.reused, true);
  assert.equal(result.payment_link_url, REAL_ROW.short_url);
  assert.equal(provider.issued().length, 0, 'no second demand for the same premium');
  assert.equal(fixture.policy_renewals.length, 1, 'one row, not two');
});

test('a simulated link is still reused when the rail is also simulated', async () => {
  // The rule is about a dead link surviving a provider upgrade, not about
  // simulation being wrong. With no credentials configured the simulated row
  // is the best link there is, and re-issuing would just make a second one.
  const fixture = state();
  fixture.policy_renewals.push(priorRow());
  const provider = new SimulatedPaymentLinkProvider();

  const result = await offer(fixture, provider);

  assertOffered(result);
  assert.equal(result.reused, true);
  assert.equal(result.simulated, true);
  assert.equal(result.payment_link_url, priorRow().short_url);
  assert.equal(provider.issued().length, 0);
  assert.equal(fixture.policy_renewals.length, 1);
});

test('a real link is never replaced by a simulated one when the rail falls back', async () => {
  // The reverse of the bug, and deliberately not symmetrical: the prior link
  // is genuinely payable, and the only thing available to replace it with is
  // one that is not. Losing the rail is no reason to hand back a worse link.
  const fixture = state();
  fixture.policy_renewals.push(priorRow(REAL_ROW));

  const result = await offer(fixture, new SimulatedPaymentLinkProvider());

  assertOffered(result);
  assert.equal(result.reused, true);
  assert.equal(result.simulated, false, 'the payable link survives the downgrade');
  assert.equal(result.payment_link_url, REAL_ROW.short_url);
  assert.equal(fixture.policy_renewals.length, 1);
});

test('a payable link outranks a superseded simulated one', async () => {
  // What a policy looks like after the upgrade if the keys later go away:
  // both rows pass the reuse filter, and only one of them can be paid. Row
  // order out of PostgREST is undefined, so this must not be a coin toss.
  const fixture = state();
  fixture.policy_renewals.push(priorRow());
  fixture.policy_renewals.push(
    priorRow({ ...REAL_ROW, id: 'rnw-real', reference_id: renewalReferenceId(POLICY_NUMBER, 2) })
  );

  const result = await offer(fixture, new SimulatedPaymentLinkProvider());

  assertOffered(result);
  assert.equal(result.reused, true);
  assert.equal(result.payment_link_url, REAL_ROW.short_url);
});

test('the superseding link takes a reference the stale row does not hold', async () => {
  // 0012's unique index on reference_id is table-wide, so a repeat is not a
  // duplicate link — it is a row that cannot be written at all.
  const fixture = state();
  fixture.policy_renewals.push(priorRow());

  const result = await offer(fixture, liveProvider());

  assertOffered(result);
  assert.equal(result.reference_id, renewalReferenceId(POLICY_NUMBER, 2));
  assert.notEqual(result.reference_id, fixture.policy_renewals[0].reference_id);
});

test('a reference the row count would collide with is walked past', async () => {
  // One row, so counting says attempt 2 — which is the reference this row
  // already holds. The count says how many rows exist, not how they are
  // numbered, and the two drift whenever a row is archived by hand.
  const fixture = state();
  fixture.policy_renewals.push(priorRow({ reference_id: renewalReferenceId(POLICY_NUMBER, 2) }));

  const result = await offer(fixture, liveProvider());

  assertOffered(result);
  assert.equal(result.reference_id, renewalReferenceId(POLICY_NUMBER, 3));
  const references = fixture.policy_renewals.map((row) => row.reference_id);
  assert.equal(new Set(references).size, references.length, 'no two rows share a reference');
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

// ============================================================================
// The paid half: capture, activation, and failure
// ============================================================================

// --- The term a premium buys ------------------------------------------------

test('a renewal runs a full term from the day the money arrived', () => {
  // The policy lapsed in January 2023 and is paid for in April 2026. The
  // customer buys twelve months from April, not twelve months from a date
  // three years gone.
  assert.equal(
    computeRenewedEndDate({
      previousEndDate: '2023-01-31',
      paidAt: '2026-04-01T10:00:00.000Z',
      termMonths: 12,
    }),
    '2027-04-01'
  );
});

test('an early renewal is added to the existing end date, never subtracted from it', () => {
  // Cover already runs to 2027. Measuring from today would shorten the policy,
  // and 0020's extension_moves_forward CHECK would refuse the write outright.
  assert.equal(
    computeRenewedEndDate({
      previousEndDate: '2027-06-30',
      paidAt: '2026-04-01T10:00:00.000Z',
      termMonths: 12,
    }),
    '2028-06-30'
  );
});

test('the day of the month is clamped rather than rolled into the next month', () => {
  // 31 August plus six months is 28 February. Rolling over to 3 March would
  // hand out days nobody paid for, every time, forever.
  assert.equal(
    computeRenewedEndDate({
      previousEndDate: '2020-01-01',
      paidAt: '2026-08-31T00:00:00.000Z',
      termMonths: 6,
    }),
    '2027-02-28'
  );
});

test('no term yields no end date — a default here would be inventing cover', () => {
  const paidAt = '2026-04-01T10:00:00.000Z';
  assert.equal(
    computeRenewedEndDate({ previousEndDate: '2023-01-31', paidAt, termMonths: null }),
    null
  );
  assert.equal(computeRenewedEndDate({ previousEndDate: '2023-01-31', paidAt, termMonths: 0 }), null);
  assert.equal(
    computeRenewedEndDate({ previousEndDate: '2023-01-31', paidAt: 'not a date', termMonths: 12 }),
    null
  );
});

// --- Capture fixtures -------------------------------------------------------

/** 1,980 rupees of premium — 198,000 paise, matching the policy above. */
const PREMIUM_PAISE = 198_000;
const PAID_AT = '2026-04-01T10:00:00.000Z';
/** 2026-04-01 plus the twelve months the link was issued for. */
const RENEWED_END_DATE = '2027-04-01';

function capture(overrides: Partial<RazorpayCapture> = {}): RazorpayCapture {
  return {
    event: 'payment_link.paid',
    paymentLinkId: 'plink_REAL_RNW',
    referenceId: renewalReferenceId(POLICY_NUMBER),
    paymentId: 'pay_RNW01',
    capturedAmountPaise: PREMIUM_PAISE,
    currency: 'INR',
    linkStatus: 'paid',
    createdAt: PAID_AT,
    ...overrides,
  };
}

function failure(overrides: Partial<RazorpayPaymentFailure> = {}): RazorpayPaymentFailure {
  return {
    event: 'payment.failed',
    kind: 'payment_failed',
    paymentLinkId: 'plink_REAL_RNW',
    referenceId: renewalReferenceId(POLICY_NUMBER),
    paymentId: 'pay_RNW_DECLINED',
    errorCode: 'BAD_REQUEST_ERROR',
    errorDescription: 'Your payment was declined by the bank.',
    errorReason: 'payment_failed',
    createdAt: PAID_AT,
    ...overrides,
  };
}

/** A real (non-simulated) renewal link, issued and awaiting its capture. */
function realLinkFixture(
  overrides: Record<string, any> = {},
  policyOverrides: Record<string, any> = {}
): FakeState {
  const fixture = state({ policy: policyOverrides });
  fixture.policy_renewals.push({
    id: 'rnw-real',
    policy_id: POLICY_ID,
    provider: 'razorpay',
    payment_link_id: 'plink_REAL_RNW',
    short_url: 'https://rzp.io/i/realrnw',
    amount_paise: PREMIUM_PAISE,
    term_months: 12,
    status: 'created',
    reference_id: renewalReferenceId(POLICY_NUMBER),
    simulated: false,
    payment_id: null,
    captured_amount_paise: null,
    previous_end_date: null,
    new_end_date: null,
    activated_at: null,
    ...overrides,
  });
  return fixture;
}

function record(fixture: FakeState, cap = capture(), ledgerId = 'evt_ONE') {
  return recordRenewalCapture(fakeSupabase(fixture) as unknown as SupabaseClient, cap, ledgerId, {
    event: cap.event,
  });
}

function recordFailure(fixture: FakeState, fail = failure(), ledgerId = 'evt_FAIL') {
  return recordRenewalFailure(fakeSupabase(fixture) as unknown as SupabaseClient, fail, ledgerId, {
    event: fail.event,
  });
}

/** The journey events written, in order, as `event_type` strings. */
function journeyTypes(fixture: FakeState): string[] {
  return fixture.journey_events.map((row) => String(row.event_type));
}

// --- The happy path ---------------------------------------------------------

test('a captured premium puts the policy back in force and extends the term', async () => {
  const fixture = realLinkFixture();
  const result = await record(fixture);

  assert.equal(result.outcome, 'recorded');
  assert.equal(result.policy_id, POLICY_ID);
  assert.equal(result.policy_activated, true);
  assert.equal(result.new_end_date, RENEWED_END_DATE);

  const renewal = fixture.policy_renewals[0];
  assert.equal(renewal.status, 'paid');
  assert.equal(renewal.payment_id, 'pay_RNW01');
  assert.equal(renewal.captured_amount_paise, PREMIUM_PAISE);
  assert.equal(renewal.captured_at, PAID_AT);
  assert.equal(renewal.capture_event_id, 'evt_ONE');
  assert.equal(renewal.previous_end_date, '2023-01-31', 'the extension must be justifiable later');
  assert.equal(renewal.new_end_date, RENEWED_END_DATE);
  assert.ok(renewal.activated_at, 'the policy write is stamped, not assumed');

  const policy = fixture.policies[0];
  assert.equal(policy.status, 'active');
  assert.equal(policy.end_date, RENEWED_END_DATE);

  assert.equal(fixture.razorpay_webhook_events.length, 1, 'the delivery is on the ledger');
  assert.deepEqual(journeyTypes(fixture), ['renewal_paid', 'policy_reactivated']);
  assert.equal(
    fixture.journey_events[0].occurred_at,
    PAID_AT,
    'the timeline records the moment the rail says the money moved, not ours'
  );
});

// --- Idempotency ------------------------------------------------------------

test('IDEMPOTENCY a redelivered webhook neither pays twice nor extends twice', async () => {
  const fixture = realLinkFixture();
  assert.equal((await record(fixture)).outcome, 'recorded');

  // Razorpay retries the identical delivery. The ledger row is what stops it,
  // because Razorpay's signature carries no timestamp and replays verify.
  const replay = await record(fixture, capture(), 'evt_ONE');
  assert.equal(replay.outcome, 'replayed');

  assert.equal(fixture.policies[0].end_date, RENEWED_END_DATE, 'the term moved once, not twice');
  assert.equal(fixture.policy_renewals[0].payment_id, 'pay_RNW01');
  assert.equal(fixture.razorpay_webhook_events.length, 1);
  assert.deepEqual(journeyTypes(fixture), ['renewal_paid', 'policy_reactivated']);
});

test('IDEMPOTENCY a fresh delivery id for a capture already applied extends nothing', async () => {
  // A different event id but the same payment. The ledger cannot help here;
  // the payment_id on the row is what stops a second extension.
  const fixture = realLinkFixture();
  assert.equal((await record(fixture, capture(), 'evt_ONE')).outcome, 'recorded');

  const again = await record(fixture, capture(), 'evt_TWO');
  assert.equal(again.outcome, 'already_captured');
  assert.equal(fixture.policies[0].end_date, RENEWED_END_DATE, 'still one term, not two');
});

test('a second, different payment against a captured link is not applied', async () => {
  const fixture = realLinkFixture();
  await record(fixture, capture(), 'evt_ONE');

  const other = await record(fixture, capture({ paymentId: 'pay_OTHER' }), 'evt_TWO');
  assert.equal(other.outcome, 'amount_mismatch');
  assert.equal(fixture.policy_renewals[0].payment_id, 'pay_RNW01');
  assert.equal(fixture.policies[0].end_date, RENEWED_END_DATE);
});

// --- Links that are not ours ------------------------------------------------

test('a capture matching neither a deductible nor a renewal is acknowledged, not invented', async () => {
  // The route tries the deductible handler first; when it says unknown_link it
  // tries this one. Both saying so means the link belongs to something else on
  // the same Razorpay account, and the answer is 200 and an untouched database.
  const fixture = realLinkFixture();
  const result = await record(fixture, capture({ paymentLinkId: 'plink_SOMEONE_ELSE' }));

  assert.equal(result.outcome, 'unknown_link');
  assert.notEqual(
    result.outcome,
    'write_failed',
    'write_failed is the only capture outcome the route turns into a retry'
  );
  assert.equal(fixture.policy_renewals[0].payment_id, null);
  assert.equal(fixture.policies[0].status, 'expired', 'no policy was touched');
  assert.equal(fixture.razorpay_webhook_events.length, 0);
  assert.deepEqual(journeyTypes(fixture), []);
});

test('a capture claimed against a simulated link never reaches the policy', async () => {
  // A simulated link resolves nowhere and can never be paid. Believing this
  // would put a policy back in force for imaginary money.
  const fixture = realLinkFixture({ simulated: true, provider: 'simulated' });
  const result = await record(fixture);

  assert.equal(result.outcome, 'simulated_link');
  assert.equal(fixture.policy_renewals[0].payment_id, null);
  assert.equal(fixture.policies[0].status, 'expired');
  assert.equal(fixture.policies[0].end_date, '2023-01-31');
  assert.equal(fixture.razorpay_webhook_events.length, 0);
  assert.deepEqual(journeyTypes(fixture), ['renewal_failed']);
});

// --- Short payment ----------------------------------------------------------

test('a short capture is refused rather than recorded, and buys no term', async () => {
  // One rupee against a 1,980 premium. Recording it would extend the policy by
  // a year for the price of a phone call.
  const fixture = realLinkFixture();
  const result = await record(fixture, capture({ capturedAmountPaise: 100 }));

  assert.equal(result.outcome, 'amount_mismatch');
  assert.equal(result.policy_activated, false);
  assert.equal(fixture.policy_renewals[0].payment_id, null);
  assert.equal(fixture.policy_renewals[0].status, 'created');
  assert.equal(fixture.policies[0].status, 'expired');
  assert.equal(fixture.policies[0].end_date, '2023-01-31');
  assert.equal(fixture.razorpay_webhook_events.length, 0);
  assert.deepEqual(journeyTypes(fixture), ['renewal_failed']);
});

test('an overpayment is recorded at the figure the rail actually captured', async () => {
  const fixture = realLinkFixture();
  await record(fixture, capture({ capturedAmountPaise: PREMIUM_PAISE + 500 }));
  assert.equal(fixture.policy_renewals[0].captured_amount_paise, PREMIUM_PAISE + 500);
  assert.equal(fixture.policies[0].end_date, RENEWED_END_DATE, 'paying more does not buy longer');
});

// --- A cancellation is a decision, and money does not reverse it -------------

test('a cancelled policy is never reactivated, whatever arrives on the rail', async () => {
  const fixture = realLinkFixture({}, { status: 'cancelled' });
  const result = await record(fixture);

  assert.equal(result.outcome, 'policy_cancelled');
  assert.equal(result.policy_activated, false);

  const policy = fixture.policies[0];
  assert.equal(policy.status, 'cancelled', 'the decision stands');
  assert.equal(policy.end_date, '2023-01-31', 'and the term did not move');

  // The row is left completely untouched, so a human reconciling this sees an
  // unpaid renewal against a cancelled policy rather than a paid one that
  // mysteriously bought nothing.
  const renewal = fixture.policy_renewals[0];
  assert.equal(renewal.payment_id, null);
  assert.equal(renewal.captured_amount_paise, null);
  assert.equal(renewal.new_end_date, null);
  assert.equal(renewal.activated_at, null);
  assert.equal(fixture.razorpay_webhook_events.length, 0);

  // The money is not lost from the record: the refund a human has to make is
  // made from this event.
  assert.deepEqual(journeyTypes(fixture), ['renewal_failed']);
  const detail = fixture.journey_events[0].detail as any;
  assert.equal(detail.reason, 'policy_cancelled');
  assert.equal(detail.payment_id, 'pay_RNW01');
  assert.equal(detail.captured_amount_paise, PREMIUM_PAISE);
  assert.equal(detail.needs_manual_refund, true);
});

test('a policy cancelled after the capture is still not reactivated by the repair', async () => {
  // The capture landed, the policy write failed, and in between somebody
  // cancelled the policy — the fraud case almost exactly. The repair has to be
  // stopped by the guard on the write, not merely by the read preceding it.
  const fixture = realLinkFixture(
    {
      status: 'paid',
      payment_id: 'pay_RNW01',
      captured_amount_paise: PREMIUM_PAISE,
      previous_end_date: '2023-01-31',
      new_end_date: RENEWED_END_DATE,
      activated_at: null,
    },
    { status: 'cancelled' }
  );

  const result = await record(fixture, capture(), 'evt_RETRY');
  assert.equal(result.outcome, 'policy_cancelled');
  assert.equal(result.policy_activated, false);
  assert.equal(fixture.policies[0].status, 'cancelled');
  assert.equal(fixture.policies[0].end_date, '2023-01-31');
  assert.equal(fixture.policy_renewals[0].activated_at, null);
});

// --- Nothing defensible to compute ------------------------------------------

test('a renewal with no term refuses rather than picking a default', async () => {
  const fixture = realLinkFixture({ term_months: null });
  const result = await record(fixture);

  assert.equal(result.outcome, 'term_unknown');
  assert.equal(fixture.policies[0].status, 'expired');
  assert.equal(fixture.policy_renewals[0].payment_id, null);
  assert.deepEqual(journeyTypes(fixture), ['renewal_failed']);
});

// --- Write failures leave a retryable state ---------------------------------

test('a failed capture write leaves no ledger row, so the retry re-applies', async () => {
  const fixture = realLinkFixture();
  fixture.updateError = { code: '57014', message: 'statement timeout' };
  const result = await record(fixture);

  assert.equal(result.outcome, 'write_failed');
  assert.equal(fixture.policies[0].status, 'expired', 'no policy moved on a failed capture');
  assert.equal(
    fixture.razorpay_webhook_events.length,
    0,
    'no ledger row, so Razorpay retry re-applies rather than being skipped'
  );
});

test('a failed policy write is reported so the retry can repair it', async () => {
  const fixture = realLinkFixture();
  fixture.policyUpdateError = { code: '08006', message: 'connection failure' };
  const result = await record(fixture);

  assert.equal(result.outcome, 'activation_failed');
  assert.equal(result.policy_activated, false);

  // The capture IS recorded — losing it would lose real money — and the target
  // end date is stored so the repair re-applies that date rather than a freshly
  // computed one, which would push the term out a second time.
  const renewal = fixture.policy_renewals[0];
  assert.equal(renewal.payment_id, 'pay_RNW01');
  assert.equal(renewal.new_end_date, RENEWED_END_DATE);
  assert.equal(renewal.activated_at, null, 'nothing claims an activation that did not happen');
  assert.equal(fixture.razorpay_webhook_events.length, 0, 'the retry is not skipped as a replay');
});

test('the retry repairs the policy against the stored date, not a fresh one', async () => {
  const fixture = realLinkFixture();
  fixture.policyUpdateError = { code: '08006', message: 'connection failure' };
  assert.equal((await record(fixture)).outcome, 'activation_failed');

  // Razorpay retries with a new delivery id, days later. The end date must be
  // the one the premium bought, not twelve months from the retry.
  fixture.policyUpdateError = null;
  const repaired = await record(fixture, capture(), 'evt_RETRY');

  assert.equal(repaired.outcome, 'recorded');
  assert.equal(repaired.policy_activated, true);
  assert.equal(fixture.policies[0].status, 'active');
  assert.equal(fixture.policies[0].end_date, RENEWED_END_DATE);
  assert.ok(fixture.policy_renewals[0].activated_at);
});

// --- Failures: the money that did not arrive --------------------------------

test('a failed payment is recorded and changes no policy state', async () => {
  const fixture = realLinkFixture();
  const result = await recordFailure(fixture);

  assert.equal(result.outcome, 'recorded');
  assert.equal(result.policy_id, POLICY_ID);
  assert.equal(result.reason, 'Your payment was declined by the bank.');

  const policy = fixture.policies[0];
  assert.equal(policy.status, 'expired', 'a decline changes nothing — it was already expired');
  assert.equal(policy.end_date, '2023-01-31');

  // The link is still perfectly payable: the customer can try another card.
  assert.equal(fixture.policy_renewals[0].status, 'created');
  assert.equal(fixture.policy_renewals[0].payment_id, null);

  assert.equal(fixture.razorpay_webhook_events.length, 1);
  assert.deepEqual(journeyTypes(fixture), ['renewal_failed']);
  const detail = fixture.journey_events[0].detail as any;
  assert.equal(detail.reason, 'payment_failed');
  assert.equal(detail.error_description, 'Your payment was declined by the bank.');
  assert.equal(detail.policy_unchanged, true);
});

test('an expired link is marked spent so a fresh one can be issued', async () => {
  const fixture = realLinkFixture();
  const result = await recordFailure(
    fixture,
    failure({ event: 'payment_link.expired', kind: 'link_expired', paymentId: null }),
    'evt_EXPIRED'
  );

  assert.equal(result.outcome, 'recorded');
  assert.equal(fixture.policy_renewals[0].status, 'expired');
  assert.equal(fixture.policies[0].status, 'expired', 'the policy is untouched either way');
  assert.deepEqual(journeyTypes(fixture), ['renewal_failed']);
});

test('a failure event against an already-paid link never unwinds the payment', async () => {
  const fixture = realLinkFixture();
  await record(fixture);

  const result = await recordFailure(
    fixture,
    failure({ event: 'payment_link.expired', kind: 'link_expired', paymentId: null }),
    'evt_LATE_EXPIRY'
  );

  assert.equal(result.outcome, 'already_captured');
  assert.equal(fixture.policy_renewals[0].status, 'paid');
  assert.equal(fixture.policies[0].status, 'active');
  assert.equal(fixture.policies[0].end_date, RENEWED_END_DATE);
});

test('a failure for a link we did not issue writes no ledger row', async () => {
  // A deductible link, or something else on the same account. Writing a ledger
  // row would make the delivery look applied, and a handler added later for
  // the deductible side would skip it as a replay.
  const fixture = realLinkFixture();
  const result = await recordFailure(fixture, failure({ paymentLinkId: 'plink_NOT_OURS' }));

  assert.equal(result.outcome, 'unknown_link');
  assert.equal(fixture.razorpay_webhook_events.length, 0);
  assert.deepEqual(journeyTypes(fixture), []);
});

test('a redelivered failure is skipped by the same ledger the captures use', async () => {
  const fixture = realLinkFixture();
  assert.equal((await recordFailure(fixture)).outcome, 'recorded');
  assert.equal((await recordFailure(fixture)).outcome, 'replayed');
  assert.equal(fixture.journey_events.length, 1, 'one decline, one event');
});

// ============================================================================
// The rail is the authority on a link, not our copy of what it last said
// ============================================================================
//
// `policy_renewals.status` is only ever as fresh as the last webhook that
// landed. When one is missed the row says 'created' forever, so the link is
// reused forever — which is how a caller came to be handed a URL Razorpay had
// recorded as paid and captured a fortnight earlier.

/** The link id every `realLinkFixture` row carries. */
const REAL_LINK_ID = 'plink_REAL_RNW';

function assertReachable(
  report: PaymentLinkStatusReport
): asserts report is Extract<PaymentLinkStatusReport, { reachable: true }> {
  assert.equal(report.reachable, true, `expected a reachable report, got ${JSON.stringify(report)}`);
}

// --- Still payable: nothing changes -----------------------------------------

test('a link the rail still calls payable is reused, exactly as before', async () => {
  const fixture = realLinkFixture();
  const provider = liveProvider();

  const result = await offer(fixture, provider);

  assertOffered(result);
  assert.equal(result.reused, true);
  assert.equal(result.payment_link_url, 'https://rzp.io/i/realrnw');
  assert.equal(result.payment_link_status, 'created');
  assert.deepEqual(provider.asked(), [REAL_LINK_ID], 'the row is believed only after asking');
  assert.equal(provider.issued().length, 0, 'no second demand for the same premium');

  const offered = fixture.journey_events.at(-1) as any;
  assert.equal(offered.event_type, 'renewal_offered');
  assert.equal(
    offered.detail.provider_status,
    'created',
    'a later reader can tell a confirmed link from an assumed one'
  );
});

test('a partially paid link is still payable and is still reused', async () => {
  // Razorpay will take the balance on one of these, so it is a live offer.
  const fixture = realLinkFixture();
  const provider = liveProvider({
    [REAL_LINK_ID]: reachableReport('partially_paid', { amountPaidPaise: 50_000 }),
  });

  const result = await offer(fixture, provider);

  assertOffered(result);
  assert.equal(result.reused, true);
  assert.equal(result.payment_link_status, 'partially_paid');
  assert.equal(provider.issued().length, 0);
});

// --- Spent at the rail, open in our record ----------------------------------

test('a link the rail calls expired is replaced, and the row stops claiming to be open', async () => {
  const fixture = realLinkFixture();
  const provider = liveProvider({ [REAL_LINK_ID]: reachableReport('expired') });

  const result = await offer(fixture, provider);

  assertOffered(result);
  assert.equal(result.reused, false);
  assert.equal(result.reference_id, renewalReferenceId(POLICY_NUMBER, 2));
  assert.equal(
    fixture.policy_renewals[0].status,
    'expired',
    'the expiry we were never told about is written down'
  );
  assert.equal(fixture.policy_renewals.length, 2);
});

test('a rail-confirmed expiry is not rediscovered into a third link', async () => {
  // Without persisting what the rail said, the stale row stays unspent, and
  // since PostgREST returns rows in no defined order the next call could pick
  // it again and issue another link. A missed webhook would become an
  // unbounded supply of payment links.
  const fixture = realLinkFixture();
  const provider = liveProvider({ [REAL_LINK_ID]: reachableReport('expired') });

  assertOffered(await offer(fixture, provider));
  const second = await offer(fixture, provider);

  assertOffered(second);
  assert.equal(second.reused, true, 'the link just created is the live one');
  assert.equal(provider.issued().length, 1, 'exactly one replacement, ever');
  assert.equal(fixture.policy_renewals.length, 2);
});

// --- The rail cannot be reached ---------------------------------------------

test('an unreachable rail refuses rather than reading out a link it cannot confirm', async () => {
  // The judgement call. Reusing is what produced the incident; creating a
  // second link risks two live demands for one premium and mostly cannot work
  // anyway, since the create goes to the same rail that just failed to answer.
  // Refusing is the only branch that is actually true: Razorpay's API and
  // Razorpay's checkout page are one service to us, and while we cannot reach
  // it we cannot promise anybody that tapping a link will bring their policy
  // back.
  const fixture = realLinkFixture();
  const provider = liveProvider({
    [REAL_LINK_ID]: { reachable: false, reason: 'connect ETIMEDOUT 104.18.0.1:443' },
  });

  const result = await offer(fixture, provider);

  assertRefused(result, 'link_status_unknown');
  assert.equal(result.renewal_amount, 1980);
  assert.match(result.message, /representative/i);
  assert.equal(provider.issued().length, 0, 'and no second demand is created either');
  assert.equal(fixture.policy_renewals.length, 1, 'the row is left exactly as it was');
  assert.equal(fixture.policy_renewals[0].status, 'created');
  assert.equal(fixture.policies[0].status, 'expired', 'nothing about the policy moved');

  const event = fixture.journey_events.at(-1) as any;
  assert.equal(event.event_type, 'renewal_failed');
  assert.equal(event.detail.reason, 'link_status_unknown');
  assert.equal(event.detail.policy_unchanged, true);
});

test('a provider that cannot be asked at all is treated as unreachable', async () => {
  // The status read is optional on the interface for compatibility, not
  // because the check is optional. Nothing gets a softer answer by declining
  // to implement it.
  const mute: PaymentLinkProvider = {
    name: 'razorpay',
    async createPaymentLink(): Promise<PaymentLink> {
      throw new Error('no link should be created while an unconfirmed one exists');
    },
  };

  const fixture = realLinkFixture();
  assertRefused(await offer(fixture, mute), 'link_status_unknown');
  assert.equal(fixture.policy_renewals.length, 1);
});

test('a provider that throws while reporting is unreachable, not fatal', async () => {
  const angry: PaymentLinkProvider = {
    name: 'razorpay',
    async createPaymentLink(): Promise<PaymentLink> {
      throw new Error('no link should be created');
    },
    async getPaymentLinkStatus(): Promise<PaymentLinkStatusReport> {
      throw new Error('socket hang up');
    },
  };

  assertRefused(await offer(realLinkFixture(), angry), 'link_status_unknown');
});

test('a rail that never answers is abandoned inside the budget', async () => {
  // The caller is on a phone line. A provider is asked to honour the timeout
  // and the real one does, but `provider` is an interface and an
  // implementation that hangs would hang the call.
  const silent: PaymentLinkProvider = {
    name: 'razorpay',
    async createPaymentLink(): Promise<PaymentLink> {
      throw new Error('no link should be created');
    },
    getPaymentLinkStatus(): Promise<PaymentLinkStatusReport> {
      return new Promise<PaymentLinkStatusReport>(() => {});
    },
  };

  const started = Date.now();
  const result = await offerRenewal(
    fakeSupabase(realLinkFixture()) as unknown as SupabaseClient,
    silent,
    POLICY_NUMBER,
    { linkStatusBudgetMs: 25 }
  );

  assertRefused(result, 'link_status_unknown');
  assert.ok(Date.now() - started < 2_000, 'nobody is left listening to silence');
});

// --- Reconciliation: a capture nobody told us about --------------------------

test('a rail reporting paid overrides a stale local created, and the money is recorded', async () => {
  // The whole point. Razorpay says paid and captured; our row says 'created'
  // because the webhook never landed. Before this, the row won and the link
  // was handed out again.
  const fixture = realLinkFixture();
  const provider = liveProvider({ [REAL_LINK_ID]: reachableReport('paid') });

  const result = await offer(fixture, provider);

  assertRefused(result, 'renewal_already_paid');
  assert.equal(provider.issued().length, 0, 'a paid premium is never answered with another link');

  const row = fixture.policy_renewals[0];
  assert.equal(row.status, 'paid');
  assert.equal(row.payment_id, 'pay_MISSED01');
  assert.equal(row.captured_amount_paise, 198_000, "the rail's figure, not ours");
  assert.equal(row.captured_at, '2026-08-26T07:41:45.000Z');
  assert.equal(row.previous_end_date, '2023-01-31');
  assert.ok(row.activated_at, 'the reactivation is stamped, not assumed');

  const policy = fixture.policies[0];
  assert.equal(policy.status, 'active');
  assert.equal(policy.end_date, '2027-08-26', 'a full term from the day the money arrived');

  assert.ok(result.message.includes('2027-08-26'));
  assert.match(result.message, /already been paid/i);
});

test('the discovery is on the record, and it goes through the one capture path', async () => {
  const fixture = realLinkFixture();
  const provider = liveProvider({ [REAL_LINK_ID]: reachableReport('paid') });

  await offer(fixture, provider);

  assert.deepEqual(journeyTypes(fixture), [
    'renewal_capture_discovered',
    'renewal_paid',
    'policy_reactivated',
  ]);

  const discovery = fixture.journey_events[0] as any;
  assert.equal(discovery.actor, 'system');
  assert.equal(discovery.detail.discovered_via, 'provider');
  assert.equal(discovery.detail.missed_webhook, true);
  assert.equal(discovery.detail.payment_id, 'pay_MISSED01');
  assert.equal(
    discovery.occurred_at,
    '2026-08-26T07:41:45.000Z',
    'the timeline puts the payment where it happened, not where we noticed'
  );

  // The ledger row says plainly that no webhook delivered this.
  const ledger = fixture.razorpay_webhook_events[0] as any;
  assert.equal(ledger.id, 'recon_pay_MISSED01');
  assert.notEqual(ledger.event, 'payment_link.paid', 'no fiction about a delivery that never came');
  assert.equal(ledger.payload.source, 'offer_renewal_reconciliation');
});

test('a genuine webhook arriving after the reconciliation applies nothing twice', async () => {
  const fixture = realLinkFixture();
  await offer(fixture, liveProvider({ [REAL_LINK_ID]: reachableReport('paid') }));

  // Razorpay finally delivers, under its own event id. The synthetic ledger id
  // deliberately looks nothing like one, so this is not skipped as a replay —
  // it re-enters the capture path and is stopped by the payment on the row.
  const late = await record(
    fixture,
    capture({ paymentId: 'pay_MISSED01', createdAt: '2026-08-26T07:41:45.000Z' }),
    'evt_LATE_BUT_REAL'
  );

  assert.equal(late.outcome, 'already_captured');
  assert.equal(fixture.policies[0].end_date, '2027-08-26', 'the term moved once, not twice');
});

test('a second call after reconciling finds an active policy and asks for nothing', async () => {
  const fixture = realLinkFixture();
  const provider = liveProvider({ [REAL_LINK_ID]: reachableReport('paid') });

  await offer(fixture, provider);
  const second = await offer(fixture, provider);

  assertRefused(second, 'policy_already_active');
  assert.equal(provider.issued().length, 0);
  assert.equal(fixture.policy_renewals.length, 1);
});

test('paid, but the rail names no payment: reported loudly and never invented', async () => {
  // There is nothing to record a capture against — payment_id is what refunds
  // and every idempotency guard key on — and an identifier for real money is
  // not something this code will make up.
  const fixture = realLinkFixture();
  const provider = liveProvider({
    [REAL_LINK_ID]: reachableReport('paid', { capture: null }),
  });

  const result = await offer(fixture, provider);

  assertRefused(result, 'renewal_needs_review');
  assert.equal(provider.issued().length, 0, 'still no second demand');
  assert.equal(fixture.policy_renewals[0].payment_id, null, 'nothing was invented on the row');
  assert.equal(fixture.policies[0].status, 'expired');

  const discovery = fixture.journey_events.at(-1) as any;
  assert.equal(discovery.event_type, 'renewal_capture_discovered');
  assert.equal(discovery.detail.payment_id, null);
  assert.equal(discovery.detail.captured_amount_paise, 198_000);
});

test('a policy cancelled while the rail was being asked is not reactivated', async () => {
  // The gate above refused every cancelled policy before we got here, so
  // reaching this means somebody cancelled it in between — the fraud case
  // almost exactly. The refusal has to come from the guard on the write, not
  // merely from the read that preceded it.
  const fixture = realLinkFixture();
  const provider: PaymentLinkProvider = {
    name: 'razorpay',
    async createPaymentLink(): Promise<PaymentLink> {
      throw new Error('no link should be created for a paid premium');
    },
    async getPaymentLinkStatus(): Promise<PaymentLinkStatusReport> {
      fixture.policies[0].status = 'cancelled';
      return reachableReport('paid');
    },
  };

  const result = await offer(fixture, provider);

  assertRefused(result, 'policy_cancelled');
  assert.equal(fixture.policies[0].status, 'cancelled', 'the decision stands');
  assert.equal(fixture.policies[0].end_date, '2023-01-31', 'and the term did not move');

  // Untouched, so a human sees an unpaid renewal against a cancelled policy
  // rather than a paid one that mysteriously bought nothing.
  const row = fixture.policy_renewals[0];
  assert.equal(row.payment_id, null);
  assert.equal(row.activated_at, null);

  // The money is not lost from the record: the refund is made from this.
  assert.deepEqual(journeyTypes(fixture), ['renewal_capture_discovered', 'renewal_failed']);
  const failed = fixture.journey_events.at(-1) as any;
  assert.equal(failed.detail.reason, 'policy_cancelled');
  assert.equal(failed.detail.needs_manual_refund, true);
  assert.match(result.message, /returning to you|return it|arrange/i);
});

test('a reconciliation that cannot finish refuses rather than billing again', async () => {
  const fixture = realLinkFixture();
  fixture.policyUpdateError = { code: '08006', message: 'connection failure' };
  const provider = liveProvider({ [REAL_LINK_ID]: reachableReport('paid') });

  const result = await offer(fixture, provider);

  assertRefused(result, 'renewal_needs_review');
  assert.equal(provider.issued().length, 0, 'the premium is in; another link would be theft');
  assert.equal(fixture.policies[0].status, 'expired');
  // The capture IS recorded — losing it would lose real money — and the stored
  // target date is what the next attempt re-applies.
  assert.equal(fixture.policy_renewals[0].payment_id, 'pay_MISSED01');
  assert.equal(fixture.policy_renewals[0].new_end_date, '2027-08-26');
  assert.equal(fixture.policy_renewals[0].activated_at, null);
});

// --- Reconciliation from our own records ------------------------------------

test('a capture recorded but never applied is repaired without asking the rail', async () => {
  // `recordRenewalCapture` leaves exactly this behind when the write to
  // `policies` fails: a paid row with no activated_at, waiting for a redelivery
  // that may never come. The answer is not a second link.
  const fixture = realLinkFixture({
    status: 'paid',
    payment_id: 'pay_RNW01',
    captured_amount_paise: PREMIUM_PAISE,
    captured_at: PAID_AT,
    previous_end_date: '2023-01-31',
    new_end_date: RENEWED_END_DATE,
    activated_at: null,
  });
  const provider = liveProvider();

  const result = await offer(fixture, provider);

  assertRefused(result, 'renewal_already_paid');
  assert.equal(provider.asked().length, 0, 'our own records already answered this');
  assert.equal(provider.issued().length, 0);
  assert.equal(fixture.policies[0].status, 'active');
  assert.equal(
    fixture.policies[0].end_date,
    RENEWED_END_DATE,
    'the date the premium bought, not twelve months from today'
  );
  assert.ok(fixture.policy_renewals[0].activated_at);
  assert.deepEqual(journeyTypes(fixture), ['renewal_capture_discovered', 'policy_reactivated']);
  assert.equal((fixture.journey_events[0] as any).detail.discovered_via, 'local_row');
});

test('an unapplied capture on a cancelled policy is refused at the gate, untouched', async () => {
  const fixture = realLinkFixture(
    {
      status: 'paid',
      payment_id: 'pay_RNW01',
      captured_amount_paise: PREMIUM_PAISE,
      captured_at: PAID_AT,
      previous_end_date: '2023-01-31',
      new_end_date: RENEWED_END_DATE,
      activated_at: null,
    },
    { status: 'cancelled' }
  );
  const provider = liveProvider();

  const result = await offer(fixture, provider);

  assertRefused(result, 'policy_cancelled');
  assert.equal(provider.asked().length, 0, 'a cancelled policy never reaches the rail');
  assert.equal(provider.issued().length, 0);
  assert.equal(fixture.policies[0].status, 'cancelled');
  assert.equal(fixture.policy_renewals[0].activated_at, null, 'money does not reverse a decision');
  assert.deepEqual(journeyTypes(fixture), []);
});

// --- The Razorpay status read over the wire ---------------------------------

test('the Razorpay provider reads a link status and maps the capture behind it', async () => {
  let seenUrl = '';
  let seenInit: any = null;
  const capturedAt = 1_787_125_305;

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
            id: 'plink_TUJi5wzZba5mAu',
            status: 'paid',
            amount: 198000,
            amount_paid: 198000,
            reference_id: renewalReferenceId(POLICY_NUMBER),
            payments: [
              // An attempt that never settled, first, so a handler that took
              // `payments[0]` would record money that does not exist.
              { payment_id: 'pay_FAILED', status: 'failed', amount: 198000 },
              {
                payment_id: 'pay_TUJiFn9k',
                status: 'captured',
                amount: 198000,
                created_at: capturedAt,
              },
            ],
          };
        },
      };
    }) as unknown as typeof fetch,
  });

  const report = await provider.getPaymentLinkStatus('plink_TUJi5wzZba5mAu');

  assert.equal(seenUrl, 'https://api.example.invalid/v1/payment_links/plink_TUJi5wzZba5mAu');
  assert.equal(seenInit.method, 'GET');
  assert.equal(
    seenInit.headers.Authorization,
    `Basic ${Buffer.from('rzp_test_key:secret').toString('base64')}`
  );

  assertReachable(report);
  assert.equal(report.status, 'paid');
  assert.equal(report.amountPaidPaise, 198000);
  assert.equal(report.capture?.paymentId, 'pay_TUJiFn9k');
  assert.equal(report.capture?.amountPaise, 198000);
  assert.equal(report.capture?.paidAt, new Date(capturedAt * 1000).toISOString());
  assert.equal(report.simulated, false);
});

test('a link with no captured payment reports paid nothing rather than a capture', async () => {
  const provider = new RazorpayPaymentLinkProvider('rzp_test_key', 'secret', {
    fetchImpl: (async () => ({
      ok: true,
      status: 200,
      async json() {
        return { id: 'plink_X', status: 'created', amount: 198000, amount_paid: 0, payments: [] };
      },
    })) as unknown as typeof fetch,
  });

  const report = await provider.getPaymentLinkStatus('plink_X');
  assertReachable(report);
  assert.equal(report.status, 'created');
  assert.equal(report.capture, null);
});

test('a 404 reads as unreachable, never as a spent link', async () => {
  // By far the likeliest cause is our own keys pointing at a different account
  // from the one that issued the link. Concluding "this link is dead" from
  // "we are asking the wrong place" would re-issue a live demand.
  const provider = new RazorpayPaymentLinkProvider('rzp_test_key', 'secret', {
    fetchImpl: (async () => ({
      ok: false,
      status: 404,
      async text() {
        return '{"error":{"description":"payment link not found"}}';
      },
    })) as unknown as typeof fetch,
  });

  const report = await provider.getPaymentLinkStatus('plink_NOT_OURS');
  assert.equal(report.reachable, false);
});

test('a status Razorpay has not documented yet is unreachable, not payable', async () => {
  // The fallback used on creation — treat the unknown as 'created' — would mean
  // "still payable" here, and a future terminal state would be read out to a
  // customer as a live link.
  const provider = new RazorpayPaymentLinkProvider('rzp_test_key', 'secret', {
    fetchImpl: (async () => ({
      ok: true,
      status: 200,
      async json() {
        return { id: 'plink_X', status: 'voided_by_merchant', amount: 198000 };
      },
    })) as unknown as typeof fetch,
  });

  const report = await provider.getPaymentLinkStatus('plink_X');
  assert.equal(report.reachable, false);
});

test('the status read is aborted on its own timeout rather than left running', async () => {
  const provider = new RazorpayPaymentLinkProvider('rzp_test_key', 'secret', {
    statusTimeoutMs: 20,
    fetchImpl: ((_url: any, init: any) =>
      new Promise((_resolve, reject) => {
        // A real fetch rejects when the signal fires; a stub that ignores it
        // would prove nothing, so this asserts the signal is actually passed.
        init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
      })) as unknown as typeof fetch,
  });

  const report = await provider.getPaymentLinkStatus('plink_SLOW');
  assert.equal(report.reachable, false);
  if (!report.reachable) assert.match(report.reason, /abort/i);
});

test('the simulated rail answers for the links it holds, and calls the rest payable', async () => {
  const provider = new SimulatedPaymentLinkProvider();
  const link = await provider.createPaymentLink({
    amountPaise: 198000,
    currency: 'INR',
    referenceId: renewalReferenceId(POLICY_NUMBER),
    description: 'SafeGuard renewal',
  });

  const held = await provider.getPaymentLinkStatus(link.id);
  assertReachable(held);
  assert.equal(held.status, 'created');
  assert.equal(held.simulated, true);
  assert.equal(held.amountPaidPaise, 0, 'no money has moved, and none can');
  assert.equal(held.capture, null);

  // The map is per-process and rows outlive it, so "not in the map" is the
  // ordinary state of an old simulated link. Reporting it unreachable would
  // refuse every renewal on a policy with a link after a restart, with no
  // credentials configured — which is the default for local work.
  const forgotten = await provider.getPaymentLinkStatus('plink_sim_frompreviousboot');
  assertReachable(forgotten);
  assert.equal(forgotten.status, 'created');
  assert.equal(forgotten.amountPaidPaise, 0);
});

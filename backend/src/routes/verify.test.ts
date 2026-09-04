import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';

// environment.ts calls requireEnv() at import time and verify.ts imports it, so
// the module graph refuses to load without database credentials. `||=` rather
// than `??=`: an empty string is as absent as undefined to requireEnv.
process.env.SUPABASE_URL ||= 'https://stub.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'stub-service-role-key';

// AND THE RAZORPAY KEYS ARE EMPTIED, DELIBERATELY AND BEFORE THE IMPORT BELOW.
// verify.ts builds its default provider from `config`, which is computed once
// at module load. A developer's .env holds real test-mode credentials that
// dotenv would otherwise load here — and the first version of this file did
// exactly that, so the "no credentials configured" test made a live outbound
// call to Razorpay's API and was answered by the real rail. A unit test must
// not reach a payment processor. Set to '' rather than deleted, because dotenv
// only fills in keys absent from process.env and optionalEnv reads '' as unset.
process.env.RAZORPAY_KEY_ID = '';
process.env.RAZORPAY_KEY_SECRET = '';

const Fastify = (await import('fastify')).default;
const verifyRoutes = (await import('./verify.js')).default;
const { SimulatedPaymentLinkProvider } = await import('../services/payment-link-provider.js');
type PaymentRailProvider = import('../services/payment-link-provider.js').PaymentRailProvider;
type RailPayment = import('../services/payment-link-provider.js').RailPayment;
type RailPaymentReport = import('../services/payment-link-provider.js').RailPaymentReport;
type Refund = import('../services/payment-link-provider.js').Refund;

// --- Test doubles -----------------------------------------------------------

interface FakeState {
  deductible_payments: Record<string, any>[];
  claims: Record<string, any>[];
  /** Injected read faults, keyed by table name. */
  errors: Record<string, any>;
}

function emptyState(overrides: Partial<FakeState> = {}): FakeState {
  return { deductible_payments: [], claims: [], errors: {}, ...overrides };
}

/**
 * Minimal PostgREST stand-in, in the shape evidence.test.ts uses.
 *
 * Rows come back whole, ignoring the column list. That makes the PII test
 * stronger rather than weaker: anything the route spreads instead of picking
 * would leak into the response here and be caught.
 */
function fakeSupabase(state: FakeState): SupabaseClient {
  return {
    from(table: string) {
      const error = state.errors[table] ?? null;
      let rows: Record<string, any>[] = [...((state as any)[table] ?? [])];

      const builder: any = {
        select: () => builder,
        eq(column: string, value: unknown) {
          rows = rows.filter((row) => row[column] === value);
          return builder;
        },
        in(column: string, values: unknown[]) {
          rows = rows.filter((row) => values.includes(row[column]));
          return builder;
        },
        not(column: string, operator: string, value: unknown) {
          assert.equal(operator, 'is');
          assert.equal(value, null);
          rows = rows.filter((row) => row[column] !== null && row[column] !== undefined);
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          const ascending = options?.ascending !== false;
          rows.sort((a, b) => {
            const left = String(a[column] ?? '');
            const right = String(b[column] ?? '');
            return ascending ? left.localeCompare(right) : right.localeCompare(left);
          });
          return builder;
        },
        then(resolve: (v: any) => unknown, reject?: (r: any) => unknown) {
          const payload = error ? { data: null, error } : { data: rows, error: null };
          return Promise.resolve(payload).then(resolve, reject);
        },
      };

      return builder;
    },
  } as unknown as SupabaseClient;
}

/**
 * A rail that answers from a script and counts what it was asked.
 *
 * The counts are load-bearing in two tests. One asserts a simulated row causes
 * no outbound call at all; the other asserts an unknown payment id is refused
 * before the rail is reached, which is the gate that stops this public endpoint
 * being an oracle over the merchant account.
 */
class ScriptedRail implements PaymentRailProvider {
  readonly name = 'razorpay';
  paymentsAsked: string[] = [];
  refundsAsked: string[] = [];

  constructor(
    private readonly payments: Record<string, RailPayment>,
    private readonly refunds: Record<string, Refund> = {},
    /**
     * When true, an id this rail does not hold comes back as unreachable
     * rather than as a denial. Both are "no payment", and the endpoint has to
     * tell them apart: one is a network fault, the other is the rail saying
     * the id is not on this account.
     */
    private readonly down = false
  ) {}

  async fetchPayment(paymentId: string): Promise<RailPaymentReport> {
    this.paymentsAsked.push(paymentId);
    const payment = this.payments[paymentId];
    if (payment) return { known: true, payment };
    if (this.down) {
      return { known: false, reachable: false, reason: 'the rail is down in this test' };
    }
    return { known: false, reachable: true };
  }

  async fetchRefund(refundId: string): Promise<Refund | null> {
    this.refundsAsked.push(refundId);
    return this.refunds[refundId] ?? null;
  }

  async createPaymentLink(): Promise<never> {
    throw new Error('the verification routes must never create a payment link');
  }

  async createRefund(): Promise<never> {
    throw new Error('the verification routes must never create a refund');
  }
}

async function buildServer(
  state: FakeState,
  provider: PaymentRailProvider,
  archiveProvider?: PaymentRailProvider
) {
  const app = Fastify();
  app.decorate('supabase', fakeSupabase(state));
  await app.register(verifyRoutes, { prefix: '/api', provider, archiveProvider });
  await app.ready();
  return app;
}

// --- Fixtures ---------------------------------------------------------------

/**
 * Carries the PII columns alongside the ones the endpoint reads. A production
 * row holds all of these; the fixture must too, or the PII test proves only
 * that the fixture was thin.
 */
const CLAIM_ROW = {
  id: 'claim-1',
  claim_number: 'CLM-2026-964201',
  customer_id: 'customer-1',
  incident_description: 'A pipe burst in the kitchen and damaged the flooring.',
  notes: 'Spoke to Priya Raghunathan on the twelfth.',
  assigned_adjuster: 'Neha Agarwal',
};

const PAID_ROW = {
  claim_id: 'claim-1',
  provider: 'razorpay',
  payment_link_id: 'plink_QxHk1',
  short_url: 'https://rzp.io/i/abc123',
  reference_id: 'DED-CLM-2026-964201',
  payment_id: 'pay_QxHkTESTONE',
  amount_paise: 500000,
  captured_amount_paise: 500000,
  captured_at: '2026-04-11T10:02:00.000Z',
  refund_id: 'rfnd_QxHkTESTONE',
  refund_status: 'processed',
  refund_amount_paise: 500000,
  refund_receipt: 'RFD-CLM-2026-964201',
  refunded_at: '2026-04-11T11:14:00.000Z',
  simulated: false,
  refund_simulated: false,
};

function railPayment(overrides: Partial<RailPayment> = {}): RailPayment {
  return {
    id: 'pay_QxHkTESTONE',
    status: 'refunded',
    captured: true,
    amountPaise: 500000,
    amountRefundedPaise: 500000,
    refundStatus: 'full',
    currency: 'INR',
    method: 'card',
    createdAt: '2026-04-11T10:02:00.000Z',
    ...overrides,
  };
}

function railRefund(overrides: Partial<Refund> = {}): Refund {
  return {
    id: 'rfnd_QxHkTESTONE',
    status: 'processed',
    amountPaise: 500000,
    currency: 'INR',
    paymentId: 'pay_QxHkTESTONE',
    receipt: 'RFD-CLM-2026-964201',
    simulated: false,
    createdAt: '2026-04-11T11:14:00.000Z',
    ...overrides,
  };
}

// --- The agreeing case ------------------------------------------------------

test('a payment the rail confirms is reported as confirmed, with both answers', async () => {
  const rail = new ScriptedRail(
    { pay_QxHkTESTONE: railPayment() },
    { rfnd_QxHkTESTONE: railRefund() }
  );
  const app = await buildServer(
    emptyState({ deductible_payments: [PAID_ROW], claims: [CLAIM_ROW] }),
    rail
  );

  const response = await app.inject({ method: 'GET', url: '/api/evidence/verify' });
  assert.equal(response.statusCode, 200);
  const body = response.json();

  assert.equal(body.checked_against.provider, 'razorpay');
  assert.equal(body.checked_against.mode, 'test');
  assert.equal(body.summary.payments_checked, 1);
  assert.equal(body.summary.confirmed, 1);
  assert.equal(body.summary.disagrees, 0);
  assert.equal(body.summary.totals_agree, true);

  const [payment] = body.payments;
  assert.equal(payment.verdict, 'confirmed');
  assert.equal(payment.stored.claim_number, 'CLM-2026-964201');
  assert.equal(payment.stored.payment_id, 'pay_QxHkTESTONE');
  assert.equal(payment.rail.payment.captured, true);
  assert.equal(payment.rail.refund.id, 'rfnd_QxHkTESTONE');
  assert.deepEqual(payment.agreement, {
    rail_confirms_capture: true,
    capture_amount_matches: true,
    rail_confirms_refund: true,
    refund_amount_matches: true,
    refund_status_matches: true,
  });

  // The two answers are kept apart. A response that merged them would still
  // pass every assertion above, so the separation is asserted directly.
  assert.ok('stored' in payment && 'rail' in payment);

  await app.close();
});

test('the rail totals are summed from the rail, not copied from the stored figures', async () => {
  // The rail says a smaller amount than we recorded. A response that summed our
  // figures into a total labelled theirs would report 500000 here.
  const rail = new ScriptedRail({ pay_QxHkTESTONE: railPayment({ amountPaise: 400000 }) });
  const app = await buildServer(
    emptyState({ deductible_payments: [PAID_ROW], claims: [CLAIM_ROW] }),
    rail
  );

  const body = (await app.inject({ method: 'GET', url: '/api/evidence/verify' })).json();
  assert.equal(body.summary.stored_collected_paise, 500000);
  assert.equal(body.summary.rail_collected_paise, 400000);

  await app.close();
});

// --- The disagreeing case, which must be as loud as the agreeing one --------

test('a rail that reports a different amount produces disagrees, not confirmed', async () => {
  const rail = new ScriptedRail({ pay_QxHkTESTONE: railPayment({ amountPaise: 499900 }) });
  const app = await buildServer(
    emptyState({ deductible_payments: [PAID_ROW], claims: [CLAIM_ROW] }),
    rail
  );

  const body = (await app.inject({ method: 'GET', url: '/api/evidence/verify' })).json();
  assert.equal(body.payments[0].verdict, 'disagrees');
  assert.equal(body.payments[0].agreement.capture_amount_matches, false);
  assert.equal(body.summary.disagrees, 1);
  assert.equal(body.summary.confirmed, 0);
  assert.equal(body.summary.totals_agree, false);

  await app.close();
});

test('a rail that says the payment was never captured produces disagrees', async () => {
  const rail = new ScriptedRail({
    pay_QxHkTESTONE: railPayment({ captured: false, status: 'authorized' }),
  });
  const app = await buildServer(
    emptyState({ deductible_payments: [PAID_ROW], claims: [CLAIM_ROW] }),
    rail
  );

  const body = (await app.inject({ method: 'GET', url: '/api/evidence/verify' })).json();
  assert.equal(body.payments[0].agreement.rail_confirms_capture, false);
  assert.equal(body.payments[0].verdict, 'disagrees');

  await app.close();
});

test('a refund status the rail has since moved on from produces disagrees', async () => {
  // The live shape of this defect. The refund status is written once, guarded
  // by `.is('refund_id', null)`, so it keeps whatever Razorpay said when the
  // refund was created; Razorpay then moves the refund from pending to
  // processed on its own schedule and never tells us. Twenty-four of the
  // twenty-six rows on the live book look exactly like this row.
  const row = { ...PAID_ROW, refund_status: 'pending' };
  const rail = new ScriptedRail(
    { pay_QxHkTESTONE: railPayment() },
    { rfnd_QxHkTESTONE: railRefund({ status: 'processed' }) }
  );
  const app = await buildServer(
    emptyState({ deductible_payments: [row], claims: [CLAIM_ROW] }),
    rail
  );

  const body = (await app.inject({ method: 'GET', url: '/api/evidence/verify' })).json();
  const [payment] = body.payments;

  assert.equal(payment.agreement.refund_status_matches, false);
  assert.equal(payment.verdict, 'disagrees');
  assert.equal(body.summary.disagrees, 1);
  assert.equal(body.summary.confirmed, 0);

  // And the reason it is only a stale label rather than missing money is
  // legible in the same object: every figure still reconciles. A reader who
  // sees the disagreement can see its size.
  assert.equal(payment.agreement.refund_amount_matches, true);
  assert.equal(payment.agreement.capture_amount_matches, true);
  assert.equal(body.summary.stored_refunded_paise, body.summary.rail_refunded_paise);
  assert.equal(body.summary.stored_collected_paise, body.summary.rail_collected_paise);
  // `totals_agree` still goes false, because it is derived from the
  // disagreement count rather than from the paise. Asserted rather than
  // wished away: a row that disagrees about anything makes it false, and a
  // reader comparing the two totals above can see that the money is not what
  // disagreed.
  assert.equal(body.summary.totals_agree, false);
  // Both statuses are rendered, so the disagreement can be checked rather than
  // taken on trust.
  assert.equal(payment.stored.refund_status, 'pending');
  assert.equal(payment.rail.refund.status, 'processed');

  await app.close();
});

test('a stored refund status ahead of the rail is a disagreement too, not just staleness', async () => {
  // The direction a staleness-only rule would have gone quiet on, and the worse
  // of the two: this system says the money is back with the customer while the
  // rail says it is still on its way. Equality catches it; "are we behind the
  // rail's terminal state" would have passed it in silence.
  const row = { ...PAID_ROW, refund_status: 'processed' };
  const rail = new ScriptedRail(
    { pay_QxHkTESTONE: railPayment() },
    { rfnd_QxHkTESTONE: railRefund({ status: 'pending' }) }
  );
  const app = await buildServer(
    emptyState({ deductible_payments: [row], claims: [CLAIM_ROW] }),
    rail
  );

  const body = (await app.inject({ method: 'GET', url: '/api/evidence/verify' })).json();
  assert.equal(body.payments[0].agreement.refund_status_matches, false);
  assert.equal(body.payments[0].verdict, 'disagrees');

  await app.close();
});

test('a payment with no refund has a null refund status answer, never false', async () => {
  // A refund we never made cannot have a status that disagrees with anything.
  // The whole three-valued convention rests on this case: `false` here would
  // turn every unrefunded payment in the book into a reported disagreement.
  const row = {
    ...PAID_ROW,
    refund_id: null,
    refund_status: null,
    refund_amount_paise: null,
    refund_receipt: null,
    refunded_at: null,
  };
  const rail = new ScriptedRail({
    pay_QxHkTESTONE: railPayment({
      status: 'captured',
      amountRefundedPaise: 0,
      refundStatus: null,
    }),
  });
  const app = await buildServer(
    emptyState({ deductible_payments: [row], claims: [CLAIM_ROW] }),
    rail
  );

  const body = (await app.inject({ method: 'GET', url: '/api/evidence/verify' })).json();
  const [payment] = body.payments;

  assert.equal(payment.agreement.refund_status_matches, null);
  assert.equal(payment.verdict, 'confirmed');
  assert.equal(body.summary.disagrees, 0);
  // Alongside the two refund fields that were already null for this row, so
  // the new one is held to the same convention rather than a looser one.
  assert.equal(payment.agreement.rail_confirms_refund, null);
  assert.equal(payment.agreement.refund_amount_matches, null);
  // Nothing was asked of the rail about a refund that does not exist.
  assert.deepEqual(rail.refundsAsked, []);

  await app.close();
});

test('a simulated refund leaves the status unanswered rather than disagreeing', async () => {
  // The refund is never looked up, so there is no rail status to compare. A
  // row whose stored status came from the simulated rail must not be reported
  // as the real rail contradicting us.
  const row = { ...PAID_ROW, refund_simulated: true, refund_id: 'rfnd_sim_0003' };
  const rail = new ScriptedRail({ pay_QxHkTESTONE: railPayment() });
  const app = await buildServer(
    emptyState({ deductible_payments: [row], claims: [CLAIM_ROW] }),
    rail
  );

  const body = (await app.inject({ method: 'GET', url: '/api/evidence/verify' })).json();
  assert.equal(body.payments[0].agreement.refund_status_matches, null);
  assert.equal(body.payments[0].verdict, 'confirmed');
  assert.deepEqual(rail.refundsAsked, []);

  await app.close();
});

// --- "We could not ask" is not "the rail disagrees" -------------------------

test('an unreachable rail produces unavailable with nulls, never a disagreement', async () => {
  // `down` — the rail could not be asked at all. Distinct from the rail
  // answering that it does not hold the id, which is the test below.
  const rail = new ScriptedRail({}, {}, true);
  const app = await buildServer(
    emptyState({ deductible_payments: [PAID_ROW], claims: [CLAIM_ROW] }),
    rail
  );

  const body = (await app.inject({ method: 'GET', url: '/api/evidence/verify' })).json();
  const [payment] = body.payments;

  assert.equal(payment.verdict, 'unavailable');
  assert.equal(payment.rail, null);
  assert.match(payment.rail_error, /could not be asked/);
  assert.match(payment.rail_error, /unconfirmed/);
  // Every field null, and specifically not false: the rail said nothing, and
  // "we could not establish this" must never render as "this is untrue".
  assert.deepEqual(payment.agreement, {
    rail_confirms_capture: null,
    capture_amount_matches: null,
    rail_confirms_refund: null,
    refund_amount_matches: null,
    refund_status_matches: null,
  });
  // The stored figures still render, labelled as ours.
  assert.equal(payment.stored.captured_amount_paise, 500000);
  assert.equal(body.summary.unavailable, 1);
  assert.equal(body.summary.confirmed, 0);
  // Nothing the rail never answered for reaches a total labelled as the rail's.
  assert.equal(body.summary.rail_collected_paise, 0);
  assert.equal(body.summary.rail_totals_cover, 0);

  await app.close();
});

test('a payment the rail denies holding is not_on_this_account, never a disagreement', async () => {
  // The rail is reachable and answers; it simply has no such payment under
  // these credentials. On the live book this is eight of twenty-six payments,
  // collected through a second test account that has since hit its limit.
  const rail = new ScriptedRail({});
  const app = await buildServer(
    emptyState({ deductible_payments: [PAID_ROW], claims: [CLAIM_ROW] }),
    rail
  );

  const body = (await app.inject({ method: 'GET', url: '/api/evidence/verify' })).json();
  const [payment] = body.payments;

  assert.equal(payment.verdict, 'not_on_this_account');
  assert.equal(body.summary.not_on_this_account, 1);
  // The distinction the whole split exists for. A real payment on another of
  // our own accounts looks exactly like this, so it must never be counted as
  // the rail contradicting us about the money.
  assert.equal(body.summary.disagrees, 0);
  assert.equal(body.summary.unavailable, 0);
  // And the wording must point at the credentials rather than at the payment.
  assert.match(payment.rail_error, /credentials/);
  assert.deepEqual(payment.agreement, {
    rail_confirms_capture: null,
    capture_amount_matches: null,
    rail_confirms_refund: null,
    refund_amount_matches: null,
    refund_status_matches: null,
  });

  await app.close();
});

test('a payment the rail denies holding does not have its refund looked up either', async () => {
  const rail = new ScriptedRail({});
  const app = await buildServer(
    emptyState({ deductible_payments: [PAID_ROW], claims: [CLAIM_ROW] }),
    rail
  );

  await app.inject({ method: 'GET', url: '/api/evidence/verify' });
  // Credentials that cannot see the payment cannot see the refund made
  // against it. Asking would spend a round trip to be told so a second time.
  assert.deepEqual(rail.paymentsAsked, ['pay_QxHkTESTONE']);
  assert.deepEqual(rail.refundsAsked, []);

  await app.close();
});

// --- The second, archived account ------------------------------------------

test('a payment the primary denies but the archive holds is confirmed by the archive', async () => {
  // The shape of the real book: part of it was collected on an earlier test
  // account that has since hit its limit. The current key cannot see those
  // payments, and the archived key can.
  const primary = new ScriptedRail({});
  const archive = new ScriptedRail(
    { pay_QxHkTESTONE: railPayment() },
    { rfnd_QxHkTESTONE: railRefund() }
  );
  const app = await buildServer(
    emptyState({ deductible_payments: [PAID_ROW], claims: [CLAIM_ROW] }),
    primary,
    archive
  );

  const body = (await app.inject({ method: 'GET', url: '/api/evidence/verify' })).json();
  const [payment] = body.payments;

  assert.equal(payment.verdict, 'confirmed');
  assert.equal(payment.answered_by, 'archive');
  assert.equal(body.summary.confirmed, 1);
  assert.equal(body.summary.not_on_this_account, 0);
  assert.deepEqual(body.checked_against.accounts, ['primary', 'archive']);

  // Both were asked about the payment, in order. The refund was asked of the
  // account that turned out to hold it, and of that one only — a refund lives
  // on the same account as the payment it was made against.
  assert.deepEqual(primary.paymentsAsked, ['pay_QxHkTESTONE']);
  assert.deepEqual(archive.paymentsAsked, ['pay_QxHkTESTONE']);
  assert.deepEqual(primary.refundsAsked, []);
  assert.deepEqual(archive.refundsAsked, ['rfnd_QxHkTESTONE']);

  await app.close();
});

test('the archive is not consulted for a payment the primary already holds', async () => {
  const primary = new ScriptedRail({ pay_QxHkTESTONE: railPayment() });
  const archive = new ScriptedRail({ pay_QxHkTESTONE: railPayment() });
  const app = await buildServer(
    emptyState({ deductible_payments: [PAID_ROW], claims: [CLAIM_ROW] }),
    primary,
    archive
  );

  const body = (await app.inject({ method: 'GET', url: '/api/evidence/verify' })).json();
  assert.equal(body.payments[0].answered_by, 'primary');
  // The second account is a fallback, not a second opinion. Asking it anyway
  // would double the outbound traffic for an answer already in hand.
  assert.deepEqual(archive.paymentsAsked, []);

  await app.close();
});

test('a payment both accounts deny is not_on_this_account, and says both were asked', async () => {
  const app = await buildServer(
    emptyState({ deductible_payments: [PAID_ROW], claims: [CLAIM_ROW] }),
    new ScriptedRail({}),
    new ScriptedRail({})
  );

  const body = (await app.inject({ method: 'GET', url: '/api/evidence/verify' })).json();
  assert.equal(body.payments[0].verdict, 'not_on_this_account');
  // The wording has to reflect that more than one account was asked, or a
  // reader is left thinking one lookup settled it.
  assert.match(body.payments[0].rail_error, /any of the accounts/);

  await app.close();
});

test('an archive that cannot be reached downgrades a denial to unavailable', async () => {
  // The primary denies; the archive never answers. "No account has it" is a
  // conclusion drawn from a complete set of answers, and this set is not
  // complete — the archive is exactly where the payment would be. Reporting
  // not_on_this_account here would state a finding the data does not support.
  const app = await buildServer(
    emptyState({ deductible_payments: [PAID_ROW], claims: [CLAIM_ROW] }),
    new ScriptedRail({}),
    new ScriptedRail({}, {}, true)
  );

  const body = (await app.inject({ method: 'GET', url: '/api/evidence/verify' })).json();
  assert.equal(body.payments[0].verdict, 'unavailable');
  assert.equal(body.summary.not_on_this_account, 0);
  assert.equal(body.summary.unavailable, 1);

  await app.close();
});

test('with no archive configured the envelope names the one account it asked', async () => {
  const app = await buildServer(
    emptyState({ deductible_payments: [PAID_ROW], claims: [CLAIM_ROW] }),
    new ScriptedRail({})
  );

  const body = (await app.inject({ method: 'GET', url: '/api/evidence/verify' })).json();
  assert.deepEqual(body.checked_against.accounts, ['primary']);
  assert.match(body.payments[0].rail_error, /the account these credentials open/);

  await app.close();
});

test('a payment the rail answers for but a refund it does not says so in rail_error', async () => {
  const rail = new ScriptedRail({ pay_QxHkTESTONE: railPayment() }, {});
  const app = await buildServer(
    emptyState({ deductible_payments: [PAID_ROW], claims: [CLAIM_ROW] }),
    rail
  );

  const body = (await app.inject({ method: 'GET', url: '/api/evidence/verify' })).json();
  assert.equal(body.payments[0].rail.refund, null);
  assert.match(body.payments[0].rail_error, /not for the refund id/);
  // No status came back, so there is no status to compare. Null, not false:
  // the rail declining to answer for the refund is not the rail contradicting
  // the status we hold.
  assert.equal(body.payments[0].agreement.refund_status_matches, null);
  assert.equal(body.payments[0].verdict, 'confirmed');

  await app.close();
});

// --- Simulated rows must never be presented as rail-confirmed ---------------

test('a simulated row is reported as simulated and the rail is never asked', async () => {
  const simulatedRow = {
    ...PAID_ROW,
    provider: 'simulated',
    payment_id: 'pay_sim_0001',
    simulated: true,
    refund_simulated: true,
    refund_id: 'rfnd_sim_0001',
  };
  const rail = new ScriptedRail({});
  const app = await buildServer(
    emptyState({ deductible_payments: [simulatedRow], claims: [CLAIM_ROW] }),
    rail
  );

  const body = (await app.inject({ method: 'GET', url: '/api/evidence/verify' })).json();
  assert.equal(body.payments[0].verdict, 'simulated');
  assert.equal(body.payments[0].rail, null);
  assert.match(body.payments[0].rail_error, /no money moved/);
  assert.equal(body.summary.simulated, 1);
  assert.equal(body.summary.confirmed, 0);
  // Not one outbound call. A simulated row has no counterpart to look up, and
  // asking would produce a 404 indistinguishable from an outage.
  assert.deepEqual(rail.paymentsAsked, []);
  assert.deepEqual(rail.refundsAsked, []);

  await app.close();
});

test('a real capture with a simulated refund does not have that refund looked up', async () => {
  const row = { ...PAID_ROW, refund_simulated: true, refund_id: 'rfnd_sim_0002' };
  const rail = new ScriptedRail({ pay_QxHkTESTONE: railPayment() });
  const app = await buildServer(
    emptyState({ deductible_payments: [row], claims: [CLAIM_ROW] }),
    rail
  );

  const body = (await app.inject({ method: 'GET', url: '/api/evidence/verify' })).json();
  assert.deepEqual(rail.paymentsAsked, ['pay_QxHkTESTONE']);
  assert.deepEqual(rail.refundsAsked, []);
  assert.equal(body.payments[0].rail.refund, null);

  await app.close();
});

// --- The single-payment route ----------------------------------------------

test('a known payment id is checked live and returns the same comparison', async () => {
  const rail = new ScriptedRail(
    { pay_QxHkTESTONE: railPayment() },
    { rfnd_QxHkTESTONE: railRefund() }
  );
  const app = await buildServer(
    emptyState({ deductible_payments: [PAID_ROW], claims: [CLAIM_ROW] }),
    rail
  );

  const response = await app.inject({
    method: 'GET',
    url: '/api/evidence/verify/pay_QxHkTESTONE',
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.verdict, 'confirmed');
  assert.equal(body.stored.payment_id, 'pay_QxHkTESTONE');
  assert.equal(body.rail.payment.amountPaise, 500000);
  assert.equal(body.checked_against.provider, 'razorpay');

  await app.close();
});

test('an unknown payment id is refused before the rail is ever asked', async () => {
  const rail = new ScriptedRail({ pay_SOMEONEELSES: railPayment() });
  const app = await buildServer(
    emptyState({ deductible_payments: [PAID_ROW], claims: [CLAIM_ROW] }),
    rail
  );

  const response = await app.inject({
    method: 'GET',
    url: '/api/evidence/verify/pay_SOMEONEELSES',
  });

  assert.equal(response.statusCode, 404);
  // The gate, and the reason it exists: an id this deployment never handled
  // must not become a lookup against the merchant account. A public endpoint
  // that forwarded arbitrary ids would let anybody enumerate it.
  assert.deepEqual(rail.paymentsAsked, []);
  assert.match(response.json().error, /no record of that payment id/);

  await app.close();
});

// --- Rule 1: no personal data, on either route ------------------------------

const PII_MARKERS = [
  'incident_description',
  'customer_id',
  'assigned_adjuster',
  'Priya Raghunathan',
  'Neha Agarwal',
  'pipe burst',
  'short_url',
  'rzp.io',
];

test('neither route serves any personal data, even though the rows carry it', async () => {
  const rail = new ScriptedRail(
    { pay_QxHkTESTONE: railPayment() },
    { rfnd_QxHkTESTONE: railRefund() }
  );
  const app = await buildServer(
    emptyState({ deductible_payments: [PAID_ROW], claims: [CLAIM_ROW] }),
    rail
  );

  for (const url of ['/api/evidence/verify', '/api/evidence/verify/pay_QxHkTESTONE']) {
    const payload = (await app.inject({ method: 'GET', url })).payload;
    for (const marker of PII_MARKERS) {
      assert.ok(
        !payload.includes(marker),
        `${url} leaked ${marker}. Every column this route selects is named in readStored; ` +
          'a row must be picked from, never spread.'
      );
    }
    // What it is allowed to carry, so the test above cannot pass by returning
    // nothing at all.
    assert.ok(payload.includes('CLM-2026-964201'));
    assert.ok(payload.includes('pay_QxHkTESTONE'));
  }

  await app.close();
});

// --- Rule 2: no key material ------------------------------------------------

test('the real provider is constructed from config without the response naming a key', async () => {
  // The route builds its own provider when none is injected. The credentials
  // are cleared at the top of this file, before the import that freezes
  // `config` — clearing them here would be too late, and the route would reach
  // the real rail. With none configured the provider is the simulated one,
  // which must report what it actually knows rather than confirmations.
  const app = Fastify();
  app.decorate(
    'supabase',
    fakeSupabase(emptyState({ deductible_payments: [PAID_ROW], claims: [CLAIM_ROW] }))
  );
  await app.register(verifyRoutes, { prefix: '/api' });
  await app.ready();

  const response = await app.inject({ method: 'GET', url: '/api/evidence/verify' });
  const body = response.json();
  assert.equal(body.checked_against.provider, 'simulated');
  // A simulated rail knows nothing about a real payment id, so the honest
  // verdict is unavailable — never confirmed, and specifically never
  // not_on_this_account. A stand-in is not entitled to state that a payment
  // is absent from a merchant account it has never spoken to.
  assert.equal(body.payments[0].verdict, 'unavailable');
  assert.equal(body.summary.confirmed, 0);
  assert.equal(body.summary.not_on_this_account, 0);

  await app.close();
});

test('the simulated provider reports unreachable, not a denial, for a payment', async () => {
  const provider = new SimulatedPaymentLinkProvider();
  const report = await provider.fetchPayment('pay_anything');
  assert.equal(report.known, false);
  // `reachable: true` would mean "a rail looked and it is not there", which
  // is the single most serious thing this endpoint can report and is not a
  // claim an unconfigured stand-in may make.
  assert.equal(report.known === false && report.reachable, false);
});

// --- Rule 3: derived, never hardcoded ---------------------------------------

test('an empty book reports zeroes rather than a figure from somewhere else', async () => {
  const app = await buildServer(emptyState(), new ScriptedRail({}));

  const body = (await app.inject({ method: 'GET', url: '/api/evidence/verify' })).json();
  assert.equal(body.summary.payments_checked, 0);
  assert.equal(body.summary.confirmed, 0);
  assert.equal(body.summary.stored_collected_paise, 0);
  assert.equal(body.summary.rail_collected_paise, 0);
  assert.deepEqual(body.payments, []);

  await app.close();
});

test('a link that was issued but never paid is not listed as something to verify', async () => {
  const unpaid = {
    ...PAID_ROW,
    payment_id: null,
    captured_amount_paise: null,
    captured_at: null,
    refund_id: null,
  };
  const app = await buildServer(
    emptyState({ deductible_payments: [unpaid], claims: [CLAIM_ROW] }),
    new ScriptedRail({})
  );

  const body = (await app.inject({ method: 'GET', url: '/api/evidence/verify' })).json();
  // A demand is not a collection. Listing it would put a row on the
  // verification page that no rail could ever confirm.
  assert.equal(body.summary.payments_checked, 0);

  await app.close();
});

// --- A read fault is a 503, never a clean zero ------------------------------

test('a database fault answers 503 rather than an empty, agreeing book', async () => {
  const app = await buildServer(
    emptyState({ errors: { deductible_payments: { message: 'connection reset' } } }),
    new ScriptedRail({})
  );

  const response = await app.inject({ method: 'GET', url: '/api/evidence/verify' });
  assert.equal(response.statusCode, 503);
  // The failure mode this guards: "0 payments, 0 disagreements, totals agree"
  // is what an outage would otherwise look like, and it reads as good news.
  assert.ok(!response.payload.includes('"totals_agree":true'));

  await app.close();
});

test('a database fault on the single-payment route answers 503 rather than 404', async () => {
  const app = await buildServer(
    emptyState({ errors: { deductible_payments: { message: 'connection reset' } } }),
    new ScriptedRail({})
  );

  const response = await app.inject({
    method: 'GET',
    url: '/api/evidence/verify/pay_QxHkTESTONE',
  });
  // 404 would say "this deployment never handled that payment", which is a
  // claim about the book. An unreadable book supports no claim about it.
  assert.equal(response.statusCode, 503);

  await app.close();
});

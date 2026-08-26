import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';

// environment.ts calls requireEnv() at import time and this route imports it,
// so the module graph refuses to load without database credentials. These
// placeholders let the decision endpoint be exercised without the environment
// the server needs to boot. `||=` rather than `??=`: an empty string is as
// absent as undefined to requireEnv.
process.env.SUPABASE_URL ||= 'https://stub.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'stub-service-role-key';
process.env.ADMIN_TOKEN ||= 'an-admin-token-long-enough-to-matter';

// AND THE RAZORPAY KEYS ARE EMPTIED, DELIBERATELY AND BEFORE THE IMPORT BELOW.
// This route builds its payment rail at module load from whatever credentials
// the environment holds, and a developer's .env holds live ones — dotenv would
// load them here and a passing test would issue real refunds against a real
// account. Set to '' rather than deleted, because dotenv only fills in keys
// that are absent from process.env, and optionalEnv reads '' as unset. The
// rail is therefore the simulation, which is what a captured row marked
// `provider: 'simulated'` must be refunded on anyway; the mismatch gate that
// keeps a real capture off the simulation is covered in
// deductible-service.test.ts.
process.env.RAZORPAY_KEY_ID = '';
process.env.RAZORPAY_KEY_SECRET = '';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const Fastify = (await import('fastify')).default;
const adjudicationReviewRoutes = (await import('./adjudication-review.js')).default;

// --- Test doubles -----------------------------------------------------------

interface FakeState {
  adjudications: Record<string, any>[];
  adjudication_reviews: Record<string, any>[];
  claims: Record<string, any>[];
  deductible_payments: Record<string, any>[];
  journey_events: Record<string, any>[];
  /**
   * Injected faults, keyed `table` for reads and `table:insert` / `table:update`
   * for writes — so an outage on one write can be told apart from an outage on
   * everything, which is the difference between "the claim moved but the
   * finding was lost" and "nothing happened at all".
   */
  errors: Record<string, any>;
}

/** PostgREST's "no rows" code. Anything else is a real fault. */
const NOT_FOUND = { code: 'PGRST116', message: 'no rows' };

/**
 * Minimal PostgREST stand-in covering the shapes this route and the refund it
 * fires actually use: `.select().eq()` terminated by `.single()`,
 * `.maybeSingle()`, `.order().limit()` or nothing at all; `.insert()` awaited
 * or followed by `.select().single()`; and `.update().eq()` with or without a
 * trailing `.is()`. Rows are mutated in place so the refund sees what the
 * decision wrote.
 */
function fakeSupabase(state: FakeState) {
  return {
    from(table: string) {
      const rows: Record<string, any>[] = (state as any)[table] ?? ((state as any)[table] = []);
      const readError = state.errors[table] ?? null;

      return {
        select(_columns?: string) {
          return {
            eq(column: string, value: unknown) {
              const matches = () => rows.filter((row) => row[column] === value);
              const list = () =>
                readError ? { data: null, error: readError } : { data: matches(), error: null };
              return {
                async single() {
                  if (readError) return { data: null, error: readError };
                  const row = matches()[0];
                  return row ? { data: row, error: null } : { data: null, error: NOT_FOUND };
                },
                async maybeSingle() {
                  if (readError) return { data: null, error: readError };
                  return { data: matches()[0] ?? null, error: null };
                },
                order() {
                  return {
                    limit(count: number) {
                      return {
                        then(resolve: (v: any) => unknown, reject?: (r: any) => unknown) {
                          const payload = readError
                            ? { data: null, error: readError }
                            : { data: matches().slice(0, count), error: null };
                          return Promise.resolve(payload).then(resolve, reject);
                        },
                      };
                    },
                  };
                },
                then(resolve: (v: any) => unknown, reject?: (r: any) => unknown) {
                  return Promise.resolve(list()).then(resolve, reject);
                },
              };
            },
          };
        },

        insert(row: Record<string, unknown>) {
          const error = state.errors[`${table}:insert`] ?? null;
          const inserted = {
            id: `${table}-${rows.length + 1}`,
            decided_at: '2026-05-01T09:00:00.000Z',
            ...row,
          };
          if (!error) rows.push(inserted);
          return {
            select() {
              return {
                async single() {
                  return error ? { data: null, error } : { data: inserted, error: null };
                },
              };
            },
            then(resolve: (v: any) => unknown, reject?: (r: any) => unknown) {
              return Promise.resolve({ error }).then(resolve, reject);
            },
          };
        },

        update(patch: Record<string, unknown>) {
          return {
            eq(column: string, value: unknown) {
              const write = (extra?: { column: string; value: unknown }) => {
                const error = state.errors[`${table}:update`] ?? null;
                if (error) return { error };
                const targets = rows.filter(
                  (row) =>
                    row[column] === value &&
                    (!extra || (row[extra.column] ?? null) === extra.value)
                );
                for (const row of targets) Object.assign(row, patch);
                return { error: null };
              };
              return {
                is(isColumn: string, isValue: unknown) {
                  return {
                    then(resolve: (v: any) => unknown, reject?: (r: any) => unknown) {
                      return Promise.resolve(write({ column: isColumn, value: isValue })).then(
                        resolve,
                        reject
                      );
                    },
                  };
                },
                then(resolve: (v: any) => unknown, reject?: (r: any) => unknown) {
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

const ADJUDICATION_ID = 'adj-1';
const CLAIM_ID = 'claim-1';
const CLAIM_NUMBER = 'CLM-2026-000321';
/** 1,500 rupees of deductible, in the minor units the rail deals in. */
const DEDUCTIBLE_PAISE = 150_000;

function state(overrides: { claim?: Record<string, any> } = {}): FakeState {
  return {
    adjudications: [
      {
        id: ADJUDICATION_ID,
        claim_id: CLAIM_ID,
        claim_number: CLAIM_NUMBER,
        verdict: 'approve',
        model_invoked: true,
        created_at: '2026-05-01T08:00:00.000Z',
      },
    ],
    adjudication_reviews: [],
    claims: [
      {
        id: CLAIM_ID,
        claim_number: CLAIM_NUMBER,
        status: 'under_review',
        fault_determination: null,
        fault_determined_at: null,
        fault_determined_by: null,
        payout_id: null,
        payout_simulated: null,
        ...overrides.claim,
      },
    ],
    deductible_payments: [],
    journey_events: [],
    errors: {},
  };
}

/** A settled claim whose deductible was collected and captured. */
function withCapturedDeductible(fixture: FakeState, overrides: Record<string, any> = {}): FakeState {
  fixture.deductible_payments.push({
    id: 'dp-1',
    claim_id: CLAIM_ID,
    provider: 'simulated',
    payment_link_id: 'plink_sim_deductible',
    amount_paise: DEDUCTIBLE_PAISE,
    status: 'paid',
    simulated: true,
    payment_id: 'pay_DEDUCTIBLE1',
    captured_amount_paise: DEDUCTIBLE_PAISE,
    refund_id: null,
    refund_status: null,
    refund_amount_paise: null,
    ...overrides,
  });
  return fixture;
}

/**
 * The route under an app carrying nothing but the fake client. Built per call
 * so no test can leak state into the next one.
 */
async function decide(
  fixture: FakeState,
  body: Record<string, unknown>,
  options: { token?: string | null; id?: string } = {}
) {
  const app = Fastify();
  app.decorate('supabase', fakeSupabase(fixture) as unknown as SupabaseClient);
  await app.register(adjudicationReviewRoutes);

  const token = options.token === undefined ? ADMIN_TOKEN : options.token;
  const response = await app.inject({
    method: 'POST',
    url: `/adjudications/${options.id ?? ADJUDICATION_ID}/decision`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body,
  });
  await app.close();

  return { status: response.statusCode, body: response.json() as any };
}

// ============================================================================
// The guard
// ============================================================================

test('a decision without the admin token records nothing', async () => {
  const fixture = state();
  const { status } = await decide(fixture, { decision: 'approve', reviewer: 'A. Adjuster' }, {
    token: null,
  });

  assert.equal(status, 401);
  assert.equal(fixture.adjudication_reviews.length, 0);
  assert.equal(fixture.claims[0].status, 'under_review');
});

// ============================================================================
// Fault is recorded by the person deciding
// ============================================================================

test('an approval records who was at fault, when, and by whom', async () => {
  const fixture = state();
  const { status, body } = await decide(fixture, {
    decision: 'approve',
    reviewer: 'A. Adjuster',
    fault_determination: 'other_party',
  });

  assert.equal(status, 200);
  const claim = fixture.claims[0];
  assert.equal(claim.status, 'approved');
  assert.equal(claim.fault_determination, 'other_party');
  assert.equal(claim.fault_determined_by, 'A. Adjuster', 'the reviewer, not a service account');
  assert.ok(claim.fault_determined_at, 'a finding with no timestamp is not an audit record');

  // And reported back, so the screen can show what was actually written.
  assert.equal(body.data.fault_determination, 'other_party');
  assert.equal(body.data.fault_determined_by, 'A. Adjuster');
});

test('the audit row still goes in before the claim is touched', async () => {
  // The ordering this file has always kept: if the claim update fails, the
  // decision is on record and says the claim did not move.
  const fixture = state();
  fixture.errors['claims:update'] = { code: '57014', message: 'statement timeout' };

  const { status, body } = await decide(fixture, {
    decision: 'approve',
    reviewer: 'A. Adjuster',
    fault_determination: 'other_party',
  });

  assert.equal(status, 200);
  assert.equal(fixture.adjudication_reviews.length, 1, 'the decision is recorded regardless');
  assert.equal(fixture.claims[0].status, 'under_review');
  assert.equal(fixture.claims[0].fault_determination, null);
  assert.equal(body.data.claim_status_after, null);
  // Both losses are named. A finding that was not saved cannot waive anything,
  // and a reviewer who is not told will assume it did.
  assert.equal(body.data.fault_determination, null);
  assert.ok(body.data.warnings.some((w: string) => /status could not be changed/i.test(w)));
  assert.ok(body.data.warnings.some((w: string) => /fault determination .* was not saved/i.test(w)));
});

test('an unrecognised finding is refused by name, not coerced', async () => {
  // Coercing to 'undetermined' would record a finding nobody made; coercing
  // the other way could waive money.
  const fixture = state();
  const { status, body } = await decide(fixture, {
    decision: 'approve',
    reviewer: 'A. Adjuster',
    fault_determination: 'the other driver',
  });

  assert.equal(status, 400);
  assert.match(body.error, /insured, other_party, shared, undetermined/);
  assert.equal(fixture.adjudication_reviews.length, 0, 'nothing is recorded on a refused body');
  assert.equal(fixture.claims[0].status, 'under_review');
});

test('an approval with no finding is allowed, and says what that costs', async () => {
  const fixture = state();
  const { status, body } = await decide(fixture, { decision: 'approve', reviewer: 'A. Adjuster' });

  assert.equal(status, 200, 'a reviewer who does not yet know must still be able to approve');
  assert.equal(fixture.claims[0].status, 'approved');
  assert.equal(fixture.claims[0].fault_determination, null);
  assert.equal(fixture.claims[0].fault_determined_by, null);
  assert.ok(
    body.data.warnings.some((w: string) => /deductible on this claim cannot be waived/i.test(w)),
    'the screen must say that the excess can never come back until fault is recorded'
  );
});

test('a rejection carries a finding too, and moves the claim to denied', async () => {
  // Fault is a finding of fact about the incident, not a verdict on the claim.
  const fixture = state();
  const { status } = await decide(fixture, {
    decision: 'reject',
    reviewer: 'A. Adjuster',
    fault_determination: 'insured',
  });

  assert.equal(status, 200);
  assert.equal(fixture.claims[0].status, 'denied');
  assert.equal(fixture.claims[0].fault_determination, 'insured');
});

test('the finding reaches the journey, attributed to the person who made it', async () => {
  const fixture = state();
  await decide(fixture, {
    decision: 'approve',
    reviewer: 'A. Adjuster',
    fault_determination: 'other_party',
  });

  const decided = fixture.journey_events.filter((row) => row.event_type === 'decided');
  assert.equal(decided.length, 1);
  // 'human', and it matters: this is the one step a person performed.
  assert.equal(decided[0].actor, 'human');
  assert.equal(decided[0].claim_id, CLAIM_ID);
  assert.equal(decided[0].detail.reviewer, 'A. Adjuster');
  assert.equal(decided[0].detail.fault_determination, 'other_party');
  assert.equal(decided[0].detail.claim_status_after, 'approved');
});

test('a finding the claim update lost is not put on the journey either', async () => {
  const fixture = state();
  fixture.errors['claims:update'] = { code: '57014', message: 'statement timeout' };
  await decide(fixture, {
    decision: 'approve',
    reviewer: 'A. Adjuster',
    fault_determination: 'other_party',
  });

  // The table is append-only, so an event claiming a finding the claim row does
  // not carry could never be corrected.
  assert.equal(fixture.journey_events[0].detail.fault_determination, null);
});

// ============================================================================
// The refund a finding sets off
// ============================================================================

test('a not-yet-settled claim refunds nothing, and says why not', async () => {
  const fixture = withCapturedDeductible(state());
  const { body } = await decide(fixture, {
    decision: 'approve',
    reviewer: 'A. Adjuster',
    fault_determination: 'other_party',
  });

  assert.equal(body.data.deductible_refund, null);
  assert.match(body.data.deductible_refund_note, /once the claim has been settled/i);
  assert.equal(fixture.deductible_payments[0].refund_id, null, 'nothing may reach the rail');
});

test('fault determined on an already-settled claim refunds the deductible there and then', async () => {
  // The ordering the settlement path cannot cover: the claim was settled
  // yesterday and the adjuster records fault today, so nothing else would ever
  // fire this refund.
  const fixture = withCapturedDeductible(
    state({ claim: { status: 'paid', payout_id: 'pout_sim_abc', payout_simulated: true } })
  );

  const { status, body } = await decide(fixture, {
    decision: 'approve',
    reviewer: 'A. Adjuster',
    fault_determination: 'other_party',
  });

  assert.equal(status, 200);
  assert.equal(body.data.deductible_refund.success, true);
  assert.equal(body.data.deductible_refund.refund_amount, 1500);
  assert.equal(fixture.deductible_payments[0].refund_id, body.data.deductible_refund.refund_id);

  // Labelled, in a field a caller can read rather than only in a comment.
  assert.equal(body.data.deductible_refund.stands_in_for_settlement, true);
  assert.match(
    body.data.deductible_refund.settlement_disclosure,
    /standing in for that payout/i
  );

  // A paid claim is not un-paid by a review.
  assert.equal(fixture.claims[0].status, 'paid');
  assert.ok(body.data.warnings.some((w: string) => /already paid/i.test(w)));
});

test('shared fault on a settled claim refunds nothing', async () => {
  const fixture = withCapturedDeductible(
    state({ claim: { status: 'paid', payout_simulated: true } })
  );
  const { body } = await decide(fixture, {
    decision: 'approve',
    reviewer: 'A. Adjuster',
    fault_determination: 'shared',
  });

  assert.equal(fixture.claims[0].fault_determination, 'shared', 'the finding is still recorded');
  assert.equal(body.data.deductible_refund, null);
  assert.equal(body.data.deductible_refund_note, null);
  assert.equal(fixture.deductible_payments[0].refund_id, null);
});

test('a settled claim with nothing captured refuses the refund rather than inventing one', async () => {
  const fixture = state({ claim: { status: 'paid', payout_simulated: true } });
  const { body } = await decide(fixture, {
    decision: 'approve',
    reviewer: 'A. Adjuster',
    fault_determination: 'other_party',
  });

  assert.equal(body.data.deductible_refund.success, false);
  assert.equal(body.data.deductible_refund.reason, 'no_captured_payment');
  assert.equal(body.data.deductible_refund.refund_id, null);
});

test('a deductible already refunded is never refunded a second time', async () => {
  const fixture = withCapturedDeductible(
    state({ claim: { status: 'paid', payout_simulated: true } }),
    { refund_id: 'rfnd_ALREADY', refund_status: 'processed', refund_amount_paise: DEDUCTIBLE_PAISE }
  );

  const { body } = await decide(fixture, {
    decision: 'approve',
    reviewer: 'A. Adjuster',
    fault_determination: 'other_party',
  });

  assert.equal(body.data.deductible_refund.success, false);
  assert.equal(body.data.deductible_refund.reason, 'already_refunded');
  assert.equal(fixture.deductible_payments[0].refund_id, 'rfnd_ALREADY', 'untouched');
});

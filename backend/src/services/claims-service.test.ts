import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AUTO_TRIAGE_IMMOVABLE_STATUSES,
  autoTriageFiledClaim,
  fileClaim,
  readEstimatedAmount,
} from './claims-service.js';
import type {
  AdjudicationRecommendation,
  AdjudicationRefused,
  AdjudicationResult,
} from './adjudication-service.js';

// --- Test doubles -----------------------------------------------------------

/** One write this file's code attempted, applied or not. */
interface RecordedWrite {
  table: string;
  patch: Record<string, unknown>;
  filters: [string, unknown][];
  applied: boolean;
}

interface FakeState {
  policies: Record<string, any>[];
  claims: Record<string, any>[];
  adjudications: Record<string, any>[];
  /**
   * Injected faults keyed by `table.column`, so an outage on the duplicate
   * check can be told apart from one on the claim read even though the two
   * differ only in which table they name.
   */
  errors: Record<string, any>;
  insertError: any;
  updateError: any;
  /**
   * Every update attempted, in order, whether or not its filters matched.
   * Recorded rather than inferred from the rows so a forbidden status can be
   * caught at the moment it is asked for, not only when it lands.
   */
  writes: RecordedWrite[];
}

/**
 * Minimal PostgREST stand-in covering exactly the shapes claims-service uses:
 * `.select().eq().maybeSingle()`, `.select().eq()` awaited for a list,
 * `.insert().select().single()`, and `.update().eq().eq().select()` awaited.
 * The builders are thenable because PostgREST's are — a list query and an
 * update are both awaited without a terminator.
 */
function fakeSupabase(state: FakeState): SupabaseClient {
  return {
    from(table: string) {
      const rows: Record<string, any>[] = (state as any)[table] ?? [];
      return {
        select(_columns?: string) {
          return {
            eq(column: string, value: unknown) {
              const error = state.errors[`${table}.${column}`] ?? null;
              const matched = error ? [] : rows.filter((row) => row[column] === value);
              return {
                async maybeSingle() {
                  if (error) return { data: null, error };
                  return { data: matched[0] ?? null, error: null };
                },
                then(onFulfilled: any, onRejected?: any) {
                  return Promise.resolve({ data: error ? null : matched, error }).then(
                    onFulfilled,
                    onRejected
                  );
                },
              };
            },
          };
        },
        insert(row: Record<string, unknown>) {
          return {
            select(_columns?: string) {
              return {
                async single() {
                  if (state.insertError) return { data: null, error: state.insertError };
                  const stored = { id: `claim-${rows.length + 1}`, ...row };
                  rows.push(stored);
                  return { data: stored, error: null };
                },
              };
            },
          };
        },
        update(patch: Record<string, unknown>) {
          const filters: [string, unknown][] = [];
          const builder: any = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return builder;
            },
            select(_columns?: string) {
              return {
                then(onFulfilled: any, onRejected?: any) {
                  const error = state.updateError ?? null;
                  let matched: Record<string, any>[] = [];
                  if (!error) {
                    matched = rows.filter((row) =>
                      filters.every(([column, value]) => row[column] === value)
                    );
                    for (const row of matched) Object.assign(row, patch);
                  }
                  state.writes.push({
                    table,
                    patch,
                    filters: [...filters],
                    applied: !error && matched.length > 0,
                  });
                  return Promise.resolve({
                    data: error ? null : matched.map((row) => ({ id: row.id })),
                    error,
                  }).then(onFulfilled, onRejected);
                },
              };
            },
          };
          return builder;
        },
      };
    },
  } as unknown as SupabaseClient;
}

/** PostgREST's "no rows" code. Anything else is a real fault. */
const NOT_FOUND = { code: 'PGRST116', message: 'no rows' };
const OUTAGE = { code: '08006', message: 'connection failure' };

const POLICY_ID = 'policy-1';
const POLICY_NUMBER = 'POL-2024-001234';
const CUSTOMER_ID = 'customer-1';

function state(overrides: Partial<FakeState> = {}): FakeState {
  return {
    policies: [
      { id: POLICY_ID, policy_number: POLICY_NUMBER, customer_id: CUSTOMER_ID, status: 'active' },
    ],
    claims: [],
    adjudications: [],
    errors: {},
    insertError: null,
    updateError: null,
    writes: [],
    ...overrides,
  };
}

function filing(overrides: Record<string, unknown> = {}) {
  return {
    policy_number: POLICY_NUMBER,
    incident_description: 'Rear-ended at a junction; bumper and boot damaged.',
    claim_type: 'collision',
    incident_date: '2026-04-17',
    ...overrides,
  };
}

/** A well-formed recommendation, in whatever shape the test needs. */
function recommends(overrides: Partial<AdjudicationRecommendation> = {}): AdjudicationRecommendation {
  return {
    success: true,
    reason: null,
    claim_number: 'CLM-2026-000000',
    adjudication_id: 'adj-1',
    verdict: 'approve',
    payable_amount: 79500,
    model_proposed_amount: 79500,
    amount_agreement: 'agreed',
    policy_clauses: [],
    inconsistencies: [],
    confidence: 0.88,
    checks: [],
    vetoed_by: null,
    model_invoked: true,
    model_provider: 'groq',
    model_id: 'test-model',
    model_latency_ms: 12,
    simulated: false,
    requires_human_approval: true,
    warnings: [],
    message: 'Recommendation recorded.',
    ...overrides,
  };
}

const REFUSED: AdjudicationRefused = {
  success: false,
  reason: 'records_unavailable',
  verdict: null,
  adjudication_id: null,
  claim_number: null,
  message: 'Records are unreachable.',
};

/** An adjudicator that remembers what it was asked about. */
function spyAdjudicator(answer: AdjudicationResult | ((n: string) => AdjudicationResult)) {
  const calls: string[] = [];
  return {
    calls,
    adjudicate: async (claimNumber: string) => {
      calls.push(claimNumber);
      return typeof answer === 'function' ? answer(claimNumber) : answer;
    },
  };
}

/** A journey recorder that remembers what it was handed. */
function spyRecorder() {
  const events: { eventType: string; detail: Record<string, unknown> }[] = [];
  return {
    events,
    recordEvent: async (event: { eventType: string; detail: Record<string, unknown> }) => {
      events.push(event);
    },
  };
}

// --- 3a. The claimed amount -------------------------------------------------

test('an estimated amount reaches claims.claimed_amount', async () => {
  // The defect this covers: `claimed_amount` was inserted as NULL and only ever
  // read, so adjudication-rules vetoed every agent-filed claim to `escalate`
  // before the model was called, for want of anything to assess.
  const fixture = state();
  const result: any = await fileClaim(
    fakeSupabase(fixture),
    filing({ estimated_amount: 80000 })
  );

  assert.equal(result.success, true);
  assert.equal(fixture.claims[0].claimed_amount, 80000);
  assert.equal(result.claimed_amount, 80000);
  assert.equal(result.estimated_amount_recorded, true);
});

test('a figure spoken with commas or a currency symbol is still a figure', async () => {
  const fixture = state();
  const result: any = await fileClaim(
    fakeSupabase(fixture),
    filing({ estimated_amount: '₹80,000' })
  );

  assert.equal(result.success, true);
  assert.equal(fixture.claims[0].claimed_amount, 80000);
});

test('filing without an estimate still succeeds, and stores no figure', async () => {
  // Optional means optional. A caller who genuinely does not know what the
  // repair will cost still gets a claim filed; it escalates honestly for the
  // stated reason rather than being refused at the door.
  const fixture = state();
  const result: any = await fileClaim(fakeSupabase(fixture), filing());

  assert.equal(result.success, true);
  assert.equal(fixture.claims[0].claimed_amount, null);
  assert.equal(result.estimated_amount_recorded, false);
  // Nothing was supplied, so there is nothing to apologise for.
  assert.equal(result.message.includes("couldn't make out an amount"), false);
});

test('nonsense is never coerced into a figure, and the caller is told', async () => {
  // `Number('a lot')` is NaN and `Number('')` is 0. Either one written to
  // claimed_amount would be a claim stating a cost nobody gave.
  const fixture = state();
  const result: any = await fileClaim(
    fakeSupabase(fixture),
    filing({ estimated_amount: 'about fifty thousand' })
  );

  assert.equal(result.success, true);
  assert.equal(fixture.claims[0].claimed_amount, null);
  assert.equal(result.estimated_amount_recorded, false);
  assert.ok(result.message.includes("couldn't make out an amount"));
});

test('readEstimatedAmount separates "not stated" from "not a figure"', () => {
  // Nothing was supplied. The claim is filed and the agent does not re-ask.
  for (const absent of [undefined, null, '', '   ']) {
    assert.deepEqual(
      readEstimatedAmount(absent),
      { amount: null, rejected: false },
      `${JSON.stringify(absent)} should read as "not stated"`
    );
  }

  assert.deepEqual(readEstimatedAmount(1250.5), { amount: 1250.5, rejected: false });
  assert.deepEqual(readEstimatedAmount('1250.50'), { amount: 1250.5, rejected: false });

  // Something was supplied and is not a figure. Every one of these is something
  // JavaScript would gladly convert: Number('a lot') is NaN, Number(true) is 1,
  // Number([]) is 0, and Number([80000]) is 80000.
  for (const nonsense of ['a lot', 'NaN', 0, -1, true, false, {}, [], [80000], Infinity]) {
    assert.deepEqual(
      readEstimatedAmount(nonsense),
      { amount: null, rejected: true },
      `${JSON.stringify(nonsense)} should be rejected, not converted`
    );
  }
});

test('the route no longer overrides the service defaults', async () => {
  // Both defaults used to be applied on the way past in webhook-tools.ts —
  // 'auto' for the type, a full ISO timestamp for the date — which made the
  // service's own defaults dead code and the documented behaviour wrong.
  const fixture = state();
  await fileClaim(
    fakeSupabase(fixture),
    filing({ claim_type: undefined, incident_date: undefined })
  );

  assert.equal(fixture.claims[0].claim_type, 'general');
  assert.match(fixture.claims[0].incident_date, /^\d{4}-\d{2}-\d{2}$/);
});

// --- 3b. Auto-triage --------------------------------------------------------

test('filing hands the new claim straight to adjudication', async () => {
  const fixture = state();
  const filed: any = await fileClaim(
    fakeSupabase(fixture),
    filing({ estimated_amount: 80000 })
  );
  const spy = spyAdjudicator(recommends({ claim_number: filed.claim_number }));

  await autoTriageFiledClaim(fakeSupabase(fixture), { adjudicate: spy.adjudicate }, filed.claim_id);

  // Adjudicated exactly once, and by the number the caller was read back —
  // adjudicateClaim takes a claim number, not the internal id.
  assert.deepEqual(spy.calls, [filed.claim_number]);
});

test('a filed claim with a complete file reaches under_review', async () => {
  const fixture = state({
    claims: [
      {
        id: 'claim-1',
        claim_number: 'CLM-2026-000456',
        status: 'submitted',
        documents_required: ['photos'],
        documents_received: ['photos'],
      },
    ],
  });
  const recorder = spyRecorder();

  const triage = await autoTriageFiledClaim(
    fakeSupabase(fixture),
    { adjudicate: spyAdjudicator(recommends()).adjudicate, recordEvent: recorder.recordEvent },
    'claim-1'
  );

  assert.equal(triage.triaged, true);
  assert.equal(triage.status_after, 'under_review');
  assert.equal(fixture.claims[0].status, 'under_review');
  assert.deepEqual(
    recorder.events.map((e) => e.eventType),
    ['adjudicated']
  );
});

test('missing documents send the claim to documents_needed, and say which', async () => {
  const fixture = state({
    claims: [
      {
        id: 'claim-1',
        claim_number: 'CLM-2026-000456',
        status: 'submitted',
        documents_required: ['police_report', 'photos'],
        documents_received: ['photos'],
      },
    ],
  });
  const recorder = spyRecorder();

  const triage = await autoTriageFiledClaim(
    fakeSupabase(fixture),
    { adjudicate: spyAdjudicator(recommends()).adjudicate, recordEvent: recorder.recordEvent },
    'claim-1'
  );

  assert.equal(triage.status_after, 'documents_needed');
  assert.deepEqual(triage.documents_missing, ['police_report']);
  assert.equal(fixture.claims[0].status, 'documents_needed');
  assert.deepEqual(
    recorder.events.map((e) => e.eventType),
    ['adjudicated', 'documents_requested']
  );
});

test('an adjudication failure leaves the claim filed and untouched', async () => {
  // The caller has already been told their claim number. A model that times
  // out, or records that cannot be reached, must not take the claim with it.
  const fixture = state({
    claims: [
      {
        id: 'claim-1',
        claim_number: 'CLM-2026-000456',
        status: 'submitted',
        documents_required: [],
        documents_received: [],
      },
    ],
  });

  const triage = await autoTriageFiledClaim(
    fakeSupabase(fixture),
    { adjudicate: spyAdjudicator(REFUSED).adjudicate },
    'claim-1'
  );

  assert.equal(triage.triaged, false);
  assert.equal(triage.reason, 'adjudication_refused');
  assert.equal(fixture.claims[0].status, 'submitted');
  assert.equal(fixture.writes.length, 0);
});

test('a status write that fails reports itself rather than lying', async () => {
  const fixture = state({
    claims: [
      {
        id: 'claim-1',
        claim_number: 'CLM-2026-000456',
        status: 'submitted',
        documents_required: [],
        documents_received: [],
      },
    ],
    updateError: OUTAGE,
  });

  const triage = await autoTriageFiledClaim(
    fakeSupabase(fixture),
    { adjudicate: spyAdjudicator(recommends()).adjudicate },
    'claim-1'
  );

  assert.equal(triage.triaged, false);
  assert.equal(triage.reason, 'status_write_failed');
  assert.equal(triage.status_after, null);
  assert.equal(fixture.claims[0].status, 'submitted');
});

test('an unreachable claim record triages nothing', async () => {
  const fixture = state({ errors: { 'claims.id': OUTAGE } });
  const spy = spyAdjudicator(recommends());

  const triage = await autoTriageFiledClaim(
    fakeSupabase(fixture),
    { adjudicate: spy.adjudicate },
    'claim-1'
  );

  assert.equal(triage.reason, 'records_unavailable');
  // No model was called, so no metered tokens were spent guessing.
  assert.deepEqual(spy.calls, []);
});

// --- The line triage may not cross ------------------------------------------

test('a decided or paid claim is never regressed', async () => {
  for (const status of [...AUTO_TRIAGE_IMMOVABLE_STATUSES]) {
    const fixture = state({
      claims: [
        {
          id: 'claim-1',
          claim_number: 'CLM-2026-000456',
          status,
          documents_required: ['photos'],
          documents_received: [],
        },
      ],
    });
    const spy = spyAdjudicator(recommends());

    const triage = await autoTriageFiledClaim(
      fakeSupabase(fixture),
      { adjudicate: spy.adjudicate },
      'claim-1'
    );

    assert.equal(triage.triaged, false, `${status} was moved`);
    assert.equal(triage.reason, 'claim_already_decided');
    assert.equal(fixture.claims[0].status, status, `${status} did not survive triage`);
    // Not even adjudicated: a decided claim is finished with the model.
    assert.deepEqual(spy.calls, [], `${status} was re-adjudicated`);
    assert.equal(fixture.writes.length, 0);
  }
});

test('auto-triage never writes approved or denied, whatever the model recommends', async () => {
  // The load-bearing test. `approved` and `denied` are human acts recorded by a
  // named reviewer, and the landing page makes that claim on the product's
  // behalf. A model recommending `approve` must move the claim no differently
  // from one recommending `deny`.
  for (const verdict of ['approve', 'deny', 'escalate'] as const) {
    for (const required of [[], ['police_report']]) {
      const fixture = state({
        claims: [
          {
            id: 'claim-1',
            claim_number: 'CLM-2026-000456',
            status: 'submitted',
            documents_required: required,
            documents_received: [],
          },
        ],
      });

      const triage = await autoTriageFiledClaim(
        fakeSupabase(fixture),
        { adjudicate: spyAdjudicator(recommends({ verdict })).adjudicate },
        'claim-1'
      );

      assert.ok(
        triage.status_after === 'under_review' || triage.status_after === 'documents_needed',
        `verdict ${verdict} produced status ${triage.status_after}`
      );
      assert.notEqual(fixture.claims[0].status, 'approved');
      assert.notEqual(fixture.claims[0].status, 'denied');
      // Checked at the point of asking, not only at the point of landing: a
      // forbidden status must never even be requested.
      for (const write of fixture.writes) {
        assert.notEqual(write.patch.status, 'approved');
        assert.notEqual(write.patch.status, 'denied');
      }
    }
  }
});

test('the status write is a compare-and-set, so a reviewer always wins', async () => {
  const fixture = state({
    claims: [
      {
        id: 'claim-1',
        claim_number: 'CLM-2026-000456',
        status: 'submitted',
        documents_required: [],
        documents_received: [],
      },
    ],
  });

  // A human decision lands while the model is thinking.
  const triage = await autoTriageFiledClaim(
    fakeSupabase(fixture),
    {
      adjudicate: async () => {
        fixture.claims[0].status = 'approved';
        return recommends();
      },
    },
    'claim-1'
  );

  assert.equal(triage.triaged, false);
  assert.equal(triage.reason, 'status_superseded');
  assert.equal(fixture.claims[0].status, 'approved');
  // The write was attempted and matched nothing — the reviewer's decision
  // stands rather than being stamped over.
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.writes[0].applied, false);
});

test('a retry does not produce a second adjudication', async () => {
  const fixture = state({
    claims: [
      {
        id: 'claim-1',
        claim_number: 'CLM-2026-000456',
        status: 'submitted',
        documents_required: [],
        documents_received: [],
      },
    ],
  });
  const spy = spyAdjudicator(recommends());
  const supabase = fakeSupabase(fixture);

  const first = await autoTriageFiledClaim(supabase, { adjudicate: spy.adjudicate }, 'claim-1');
  assert.equal(first.status_after, 'under_review');

  // The audit row the real adjudicateClaim would have written.
  fixture.adjudications.push({ id: 'adj-1', claim_id: 'claim-1' });

  const second = await autoTriageFiledClaim(supabase, { adjudicate: spy.adjudicate }, 'claim-1');
  assert.equal(second.reason, 'already_adjudicated');
  assert.deepEqual(spy.calls, ['CLM-2026-000456']);
});

test('a claim already in the right waiting room is not written to again', async () => {
  const fixture = state({
    claims: [
      {
        id: 'claim-1',
        claim_number: 'CLM-2026-000456',
        status: 'under_review',
        documents_required: [],
        documents_received: [],
      },
    ],
  });

  const triage = await autoTriageFiledClaim(
    fakeSupabase(fixture),
    { adjudicate: spyAdjudicator(recommends()).adjudicate },
    'claim-1'
  );

  assert.equal(triage.triaged, true);
  assert.equal(triage.status_after, 'under_review');
  assert.equal(fixture.writes.length, 0);
});

test('an unreadable adjudications table does not strand the claim as submitted', async () => {
  // A claim that never reaches the review queue is the failure this whole
  // change exists to fix, and it is worse than a duplicate audit row.
  const fixture = state({
    claims: [
      {
        id: 'claim-1',
        claim_number: 'CLM-2026-000456',
        status: 'submitted',
        documents_required: [],
        documents_received: [],
      },
    ],
    errors: { 'adjudications.claim_id': OUTAGE },
  });

  const triage = await autoTriageFiledClaim(
    fakeSupabase(fixture),
    { adjudicate: spyAdjudicator(recommends()).adjudicate },
    'claim-1'
  );

  assert.equal(triage.triaged, true);
  assert.equal(fixture.claims[0].status, 'under_review');
});

test('a journey recorder that throws does not lose the step it describes', async () => {
  const fixture = state({
    claims: [
      {
        id: 'claim-1',
        claim_number: 'CLM-2026-000456',
        status: 'submitted',
        documents_required: [],
        documents_received: [],
      },
    ],
  });

  const triage = await autoTriageFiledClaim(
    fakeSupabase(fixture),
    {
      adjudicate: spyAdjudicator(recommends()).adjudicate,
      recordEvent: async () => {
        throw new Error('journey_events table is not there');
      },
    },
    'claim-1'
  );

  assert.equal(triage.triaged, true);
  assert.equal(fixture.claims[0].status, 'under_review');
});

test('a claim that no longer exists is reported, not invented', async () => {
  const fixture = state({ claims: [] });
  const triage = await autoTriageFiledClaim(
    fakeSupabase(fixture),
    { adjudicate: spyAdjudicator(recommends()).adjudicate },
    'claim-gone'
  );

  assert.equal(triage.reason, 'claim_not_found');
  assert.equal(fixture.writes.length, 0);
});

test('a filing refused for an inactive policy stores nothing at all', async () => {
  const fixture = state({
    policies: [
      { id: POLICY_ID, policy_number: POLICY_NUMBER, customer_id: CUSTOMER_ID, status: 'expired' },
    ],
  });
  const result: any = await fileClaim(
    fakeSupabase(fixture),
    filing({ estimated_amount: 80000 })
  );

  assert.equal(result.success, false);
  assert.equal(fixture.claims.length, 0);
});

test('an unreachable policy record is an outage, not a missing policy', async () => {
  const fixture = state({ errors: { 'policies.policy_number': OUTAGE } });
  const result: any = await fileClaim(fakeSupabase(fixture), filing());

  assert.equal(result.success, false);
  assert.equal(result.unavailable, true);
  assert.equal(fixture.claims.length, 0);
  assert.equal(NOT_FOUND.code, 'PGRST116');
});

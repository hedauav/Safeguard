import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AUTO_TRIAGE_IMMOVABLE_STATUSES,
  OPEN_CLAIM_STATUSES,
  SETTLED_CLAIM_STATUSES,
  advanceClaimOnDocumentsComplete,
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

// --- 3b-ii. One open claim at a time ----------------------------------------
//
// The defect these cover: `fileClaim` had no duplicate check at all. A caller
// could file, be read a claim number, ring back and describe the same dent, and
// be read a second number for the same damage. `no_near_duplicate_claim` in
// adjudication-rules only fires during adjudication — after the row exists and
// after the number has been spoken — so it caught the duplicate as history
// rather than preventing it.

const SECOND_POLICY_ID = 'policy-2';
const SECOND_POLICY_NUMBER = 'POL-2024-009999';

/** A claim already sitting on POLICY_ID, in whatever state the test needs. */
function sibling(overrides: Record<string, unknown> = {}) {
  return {
    id: 'claim-existing',
    claim_number: 'CLM-2026-000456',
    policy_id: POLICY_ID,
    status: 'under_review',
    ...overrides,
  };
}

test('a second claim on a policy with an open one is refused, and names it', async () => {
  const fixture = state({ claims: [sibling({ status: 'under_review' })] });
  const result: any = await fileClaim(fakeSupabase(fixture), filing({ estimated_amount: 80000 }));

  assert.equal(result.success, false);
  // Nothing was written. The refusal happens at the door, before the insert,
  // which is the whole difference between this and the adjudication-time rule.
  assert.equal(fixture.claims.length, 1);

  // The agent must be able to read the existing claim back to the caller, so
  // both the number and a sayable status have to be in the message itself.
  assert.ok(
    result.message.includes('CLM-2026-000456'),
    `refusal should name the open claim: ${result.message}`
  );
  assert.ok(
    result.message.includes('under review'),
    `refusal should say what state it is in: ${result.message}`
  );
  assert.equal(result.open_claim_number, 'CLM-2026-000456');
  assert.equal(result.open_claim_status, 'under_review');
});

test('the refusal is recoverable on the call, not a dead end', async () => {
  // This rule knowingly refuses a genuine second incident — a windscreen chip
  // and a collision on one policy is ordinary motor insurance. That is the
  // accepted cost of not keying the check to an incident date the caller may
  // never have given us. It is only acceptable because the caller is told a
  // representative can still file it.
  const fixture = state({ claims: [sibling()] });
  const result: any = await fileClaim(fakeSupabase(fixture), filing());

  assert.equal(result.success, false);
  assert.ok(
    result.message.includes('representative'),
    `refusal must offer a way through: ${result.message}`
  );
  assert.ok(
    result.message.includes('separate incident'),
    `refusal must acknowledge the genuine-second-incident case: ${result.message}`
  );
});

test('the refusal carries its own reason, not an overloaded one', async () => {
  // The agent branches on `reason`; the wording is written to be read aloud and
  // will be rewritten. A reason shared with the outage path or the missing
  // policy path would make the two indistinguishable to the caller.
  const fixture = state({ claims: [sibling()] });
  const duplicate: any = await fileClaim(fakeSupabase(fixture), filing());
  const missing: any = await fileClaim(fakeSupabase(state()), filing({ policy_number: 'POL-0000-000000' }));
  const outage: any = await fileClaim(
    fakeSupabase(state({ errors: { 'policies.policy_number': OUTAGE } })),
    filing()
  );

  assert.equal(duplicate.reason, 'policy_has_open_claim');
  assert.equal(missing.reason, 'policy_not_found');
  assert.equal(outage.reason, 'records_unavailable');
  assert.notEqual(duplicate.reason, missing.reason);
  assert.notEqual(duplicate.reason, outage.reason);
  // Not an outage. The records answered; the answer was no.
  assert.equal(duplicate.unavailable, undefined);
});

test('every open status blocks a second filing', async () => {
  for (const status of ['submitted', 'under_review', 'documents_needed', 'approved']) {
    const fixture = state({ claims: [sibling({ status })] });
    const result: any = await fileClaim(fakeSupabase(fixture), filing());

    assert.equal(result.success, false, `${status} should block a second filing`);
    assert.equal(result.reason, 'policy_has_open_claim');
    assert.equal(fixture.claims.length, 1, `${status} should have prevented the insert`);
  }
});

test('an approved but unpaid claim still counts as open', async () => {
  // The interesting one, and the reason the open set is not just the inverse of
  // AUTO_TRIAGE_IMMOVABLE_STATUSES. `approved` is immovable because a person
  // decided it; it is also still live, because the money has not moved. "Has my
  // payout gone out yet?" is exactly the call that must not become a second
  // claim on the same loss — and, at worst, a second settlement.
  assert.ok(AUTO_TRIAGE_IMMOVABLE_STATUSES.has('approved'));
  assert.ok(OPEN_CLAIM_STATUSES.has('approved'));

  const fixture = state({ claims: [sibling({ status: 'approved' })] });
  const result: any = await fileClaim(fakeSupabase(fixture), filing());

  assert.equal(result.success, false);
  assert.equal(result.reason, 'policy_has_open_claim');
});

test('a policy whose claims are all denied, paid or closed accepts a new one', async () => {
  // Settled history is not a duplicate. A policyholder who claimed and was paid
  // two years ago is not barred from claiming again.
  const fixture = state({
    claims: [
      sibling({ id: 'c-1', claim_number: 'CLM-2024-000001', status: 'denied' }),
      sibling({ id: 'c-2', claim_number: 'CLM-2024-000002', status: 'paid' }),
      sibling({ id: 'c-3', claim_number: 'CLM-2024-000003', status: 'closed' }),
    ],
  });
  const result: any = await fileClaim(fakeSupabase(fixture), filing({ estimated_amount: 80000 }));

  assert.equal(result.success, true);
  assert.equal(fixture.claims.length, 4);
  assert.equal(fixture.claims[3].claimed_amount, 80000);
});

test('the first claim on a policy is unaffected, and another policy does not block it', async () => {
  // The gate is scoped by policy_id, not by customer. One customer with a car
  // and a house has two files, and a live claim on one must not close the door
  // on the other.
  const fixture = state({
    policies: [
      { id: POLICY_ID, policy_number: POLICY_NUMBER, customer_id: CUSTOMER_ID, status: 'active' },
      {
        id: SECOND_POLICY_ID,
        policy_number: SECOND_POLICY_NUMBER,
        customer_id: CUSTOMER_ID,
        status: 'active',
      },
    ],
    claims: [sibling({ policy_id: SECOND_POLICY_ID, status: 'documents_needed' })],
  });
  const result: any = await fileClaim(fakeSupabase(fixture), filing());

  assert.equal(result.success, true);
  assert.match(result.claim_number, /^CLM-\d{4}-\d{6}$/);
  assert.equal(fixture.claims.length, 2);
  assert.equal(fixture.claims[1].policy_id, POLICY_ID);
});

test('an unreadable claims table refuses rather than filing on an unknown', async () => {
  // The failure that matters here. An outage on this lookup read as "no
  // duplicate found" would file precisely when we are least able to tell
  // whether we should — so the unanswerable question is refused instead.
  const fixture = state({ errors: { 'claims.policy_id': OUTAGE } });
  const result: any = await fileClaim(fakeSupabase(fixture), filing({ estimated_amount: 80000 }));

  assert.equal(result.success, false);
  assert.equal(result.reason, 'records_unavailable');
  assert.equal(result.unavailable, true);
  assert.equal(fixture.claims.length, 0);
  // Distinct from the policy-lookup outage in wording, so the caller is told
  // which question could not be answered, but the same reason so the agent
  // handles both the same way.
  assert.ok(result.message.includes('open'), result.message);
});

test('the open and settled sets partition every status the schema allows', async () => {
  // Written as a partition rather than two hand-typed lists so the halves
  // cannot drift when a status is added to the CHECK constraint.
  const schema = ['submitted', 'under_review', 'documents_needed', 'approved', 'denied', 'paid', 'closed'];

  assert.deepEqual(
    [...OPEN_CLAIM_STATUSES].sort(),
    ['approved', 'documents_needed', 'submitted', 'under_review']
  );
  assert.deepEqual([...SETTLED_CLAIM_STATUSES].sort(), ['closed', 'denied', 'paid']);

  for (const status of schema) {
    assert.equal(
      OPEN_CLAIM_STATUSES.has(status) !== SETTLED_CLAIM_STATUSES.has(status),
      true,
      `${status} must be in exactly one of the two sets`
    );
  }
  assert.equal(OPEN_CLAIM_STATUSES.size + SETTLED_CLAIM_STATUSES.size, schema.length);
});

test('a status the code does not recognise is treated as open, not as settled', async () => {
  // NULL is possible — the column is nullable — and a future migration could add
  // a status this file has never heard of. Neither is evidence that the claim is
  // finished, so both err towards a refusal somebody can recover from rather
  // than towards a duplicate nobody catches.
  for (const status of [null, undefined, 'awaiting_something_new']) {
    const fixture = state({ claims: [sibling({ status })] });
    const result: any = await fileClaim(fakeSupabase(fixture), filing());

    assert.equal(result.success, false, `${String(status)} should not read as settled`);
    assert.equal(result.reason, 'policy_has_open_claim');
  }
});

// --- 3c. Coming back out of documents_needed --------------------------------
//
// The gap these cover: a claim triaged to `documents_needed` stayed there
// forever. The uploads arrived, were hashed and attested, and
// `documents_received` filled up — and no code ever read that column again to
// ask whether the wait was over.

/** A claim waiting on documents, in whatever state the test needs. */
function waiting(overrides: Record<string, unknown> = {}) {
  return {
    id: 'claim-1',
    claim_number: 'CLM-2026-000456',
    status: 'documents_needed',
    documents_required: ['police_report', 'photos'],
    documents_received: ['photos'],
    ...overrides,
  };
}

test('the last required document takes the claim to under_review', async () => {
  const fixture = state({
    // The upload route runs this after the evidence pipeline, so the row
    // already carries the document that has just been attested.
    claims: [waiting({ documents_received: ['photos', 'police_report'] })],
  });
  const recorder = spyRecorder();

  const outcome = await advanceClaimOnDocumentsComplete(
    fakeSupabase(fixture),
    { recordEvent: recorder.recordEvent },
    'claim-1'
  );

  assert.equal(outcome.advanced, true);
  assert.equal(outcome.reason, null);
  assert.equal(outcome.status_before, 'documents_needed');
  assert.equal(outcome.status_after, 'under_review');
  assert.deepEqual(outcome.documents_missing, []);
  assert.equal(fixture.claims[0].status, 'under_review');
});

test('the order documents arrive in does not matter, only that they all have', async () => {
  // Set semantics, not sequence: `documents_received` is compared by
  // membership, so an out-of-order or repeated upload still completes.
  const fixture = state({
    claims: [
      waiting({ documents_received: ['police_report', 'photos', 'police_report'] }),
    ],
  });

  const outcome = await advanceClaimOnDocumentsComplete(fakeSupabase(fixture), {}, 'claim-1');

  assert.equal(outcome.advanced, true);
  assert.equal(fixture.claims[0].status, 'under_review');
});

test('a partial upload changes nothing at all', async () => {
  const fixture = state({ claims: [waiting()] });
  const recorder = spyRecorder();

  const outcome = await advanceClaimOnDocumentsComplete(
    fakeSupabase(fixture),
    { recordEvent: recorder.recordEvent },
    'claim-1'
  );

  assert.equal(outcome.advanced, false);
  assert.equal(outcome.reason, 'documents_outstanding');
  assert.deepEqual(outcome.documents_missing, ['police_report']);
  assert.equal(fixture.claims[0].status, 'documents_needed');
  // No write was even attempted, and the timeline is not padded with an entry
  // per upload — only the one that ends the wait is worth recording.
  assert.equal(fixture.writes.length, 0);
  assert.deepEqual(recorder.events, []);
});

test('a document type nobody asked for does not falsely complete the file', async () => {
  // The upload route refuses an unrequested type at the door
  // (claim-documents-service gate 6); this is the second lock. Completeness is
  // computed from `documents_required` alone, so extra types cannot cover for
  // a missing one however many of them arrive.
  const fixture = state({
    claims: [
      waiting({ documents_received: ['photos', 'vehicle_registration', 'selfie'] }),
    ],
  });

  const outcome = await advanceClaimOnDocumentsComplete(fakeSupabase(fixture), {}, 'claim-1');

  assert.equal(outcome.advanced, false);
  assert.equal(outcome.reason, 'documents_outstanding');
  assert.deepEqual(outcome.documents_missing, ['police_report']);
  assert.equal(fixture.claims[0].status, 'documents_needed');
  assert.equal(fixture.writes.length, 0);
});

test('a claim already under review is not disturbed', async () => {
  // Filed with a complete file, so it never waited on anyone. An upload
  // against it must not rewrite a status that is already correct.
  const fixture = state({
    claims: [
      waiting({ status: 'under_review', documents_received: ['photos', 'police_report'] }),
    ],
  });
  const recorder = spyRecorder();

  const outcome = await advanceClaimOnDocumentsComplete(
    fakeSupabase(fixture),
    { recordEvent: recorder.recordEvent },
    'claim-1'
  );

  assert.equal(outcome.advanced, false);
  assert.equal(outcome.reason, 'not_awaiting_documents');
  assert.equal(fixture.claims[0].status, 'under_review');
  assert.equal(fixture.writes.length, 0);
  assert.deepEqual(recorder.events, []);
});

test('the journey event says completeness was checked and contents were not', async () => {
  // The honest limit, on the record. The system checked that a document of the
  // right *type* arrived and hashed its bytes; nothing read what it says. A
  // timeline that let a reader infer otherwise would be the lie.
  const fixture = state({
    claims: [waiting({ documents_received: ['photos', 'police_report'] })],
  });
  const recorder = spyRecorder();

  await advanceClaimOnDocumentsComplete(
    fakeSupabase(fixture),
    { recordEvent: recorder.recordEvent },
    'claim-1'
  );

  assert.deepEqual(
    recorder.events.map((e) => e.eventType),
    ['documents_completed']
  );
  const detail = recorder.events[0].detail;
  assert.equal(detail.contents_inspected, false);
  assert.equal(detail.completeness_checked, true);
  assert.deepEqual(detail.documents_received, ['photos', 'police_report']);
  assert.deepEqual(detail.documents_required, ['police_report', 'photos']);
  assert.equal(detail.status_after, 'under_review');
  // No model was called, so nothing may suggest the claim was re-assessed.
  assert.equal(detail.readjudicated, false);
});

test('a status write that fails is reported rather than swallowed', async () => {
  // The document is recorded and attested; the claim is not where it should
  // be. Returning `advanced: true` here would tell the claimant their file is
  // with a reviewer when it is still sitting in documents_needed.
  const fixture = state({
    claims: [waiting({ documents_received: ['photos', 'police_report'] })],
    updateError: OUTAGE,
  });
  const recorder = spyRecorder();

  const outcome = await advanceClaimOnDocumentsComplete(
    fakeSupabase(fixture),
    { recordEvent: recorder.recordEvent },
    'claim-1'
  );

  assert.equal(outcome.advanced, false);
  assert.equal(outcome.reason, 'status_write_failed');
  assert.equal(outcome.status_after, null);
  assert.equal(fixture.claims[0].status, 'documents_needed');
  // Nothing claims the claim moved, on the timeline either.
  assert.deepEqual(recorder.events, []);
});

test('a reviewer deciding mid-upload wins the compare-and-set', async () => {
  const fixture = state({
    claims: [waiting({ documents_received: ['photos', 'police_report'] })],
  });
  const supabase = fakeSupabase(fixture);

  // The decision lands in the gap between the read and the write. The read
  // hands back a snapshot, exactly as PostgREST does, so the status the
  // compare-and-set is built from is the one that was genuinely observed.
  const original = fixture.claims[0];
  const outcome = await advanceClaimOnDocumentsComplete(
    {
      from(table: string) {
        const inner: any = (supabase as any).from(table);
        if (table !== 'claims') return inner;
        return {
          ...inner,
          select(columns?: string) {
            const builder = inner.select(columns);
            return {
              eq(column: string, value: unknown) {
                const eq = builder.eq(column, value);
                return {
                  async maybeSingle() {
                    const read = await eq.maybeSingle();
                    const snapshot = read.data ? { ...read.data } : null;
                    original.status = 'denied';
                    return { data: snapshot, error: read.error };
                  },
                };
              },
            };
          },
        };
      },
    } as any,
    {},
    'claim-1'
  );

  assert.equal(outcome.advanced, false);
  assert.equal(outcome.reason, 'status_superseded');
  assert.equal(fixture.claims[0].status, 'denied');
  // The write was attempted and matched nothing, rather than stamping over a
  // person's decision.
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.writes[0].applied, false);
});

test('a completed file never drags a decided, paid or closed claim backwards', async () => {
  // Uploading against a claim a reviewer has already answered must not put it
  // back in the queue and erase that answer from the row the dashboard reads.
  for (const status of [...AUTO_TRIAGE_IMMOVABLE_STATUSES]) {
    const fixture = state({
      claims: [waiting({ status, documents_received: ['photos', 'police_report'] })],
    });
    const recorder = spyRecorder();

    const outcome = await advanceClaimOnDocumentsComplete(
      fakeSupabase(fixture),
      { recordEvent: recorder.recordEvent },
      'claim-1'
    );

    assert.equal(outcome.advanced, false, `${status} was moved`);
    assert.equal(outcome.reason, 'claim_already_decided');
    assert.equal(fixture.claims[0].status, status, `${status} did not survive the upload`);
    assert.equal(fixture.writes.length, 0, `${status} was written to`);
    assert.deepEqual(recorder.events, []);
  }
});

test('document completion never writes approved or denied', async () => {
  // The companion to the auto-triage test above, and load-bearing for the same
  // reason: `approved` and `denied` are human acts recorded by a named
  // reviewer. A complete file is not an approved claim — it is a claim a
  // person can now finish reading.
  const scenarios = [
    waiting({ documents_received: ['photos', 'police_report'] }),
    waiting({ documents_received: ['photos'] }),
    waiting({ status: 'submitted', documents_received: ['photos', 'police_report'] }),
    waiting({ status: 'under_review', documents_received: ['photos', 'police_report'] }),
    waiting({ documents_required: [], documents_received: [] }),
  ];

  for (const claim of scenarios) {
    const fixture = state({ claims: [claim] });

    const outcome = await advanceClaimOnDocumentsComplete(fakeSupabase(fixture), {}, 'claim-1');

    assert.ok(
      outcome.status_after === 'under_review' || outcome.status_after === null,
      `status_after was ${outcome.status_after}`
    );
    assert.notEqual(fixture.claims[0].status, 'approved');
    assert.notEqual(fixture.claims[0].status, 'denied');
    // Checked at the point of asking, not only at the point of landing.
    for (const write of fixture.writes) {
      assert.equal(write.patch.status, 'under_review');
    }
  }
});

test('an unreachable claim record advances nothing', async () => {
  const fixture = state({
    claims: [waiting({ documents_received: ['photos', 'police_report'] })],
    errors: { 'claims.id': OUTAGE },
  });

  const outcome = await advanceClaimOnDocumentsComplete(fakeSupabase(fixture), {}, 'claim-1');

  assert.equal(outcome.advanced, false);
  assert.equal(outcome.reason, 'records_unavailable');
  assert.equal(fixture.writes.length, 0);
});

test('an upload against a claim that no longer exists advances nothing', async () => {
  const fixture = state({ claims: [] });

  const outcome = await advanceClaimOnDocumentsComplete(fakeSupabase(fixture), {}, 'claim-gone');

  assert.equal(outcome.advanced, false);
  assert.equal(outcome.reason, 'claim_not_found');
  assert.equal(fixture.writes.length, 0);
});

test('a journey recorder that throws does not lose the advance it describes', async () => {
  const fixture = state({
    claims: [waiting({ documents_received: ['photos', 'police_report'] })],
  });

  const outcome = await advanceClaimOnDocumentsComplete(
    fakeSupabase(fixture),
    {
      recordEvent: async () => {
        throw new Error('journey_events table is not there');
      },
    },
    'claim-1'
  );

  assert.equal(outcome.advanced, true);
  assert.equal(fixture.claims[0].status, 'under_review');
});

test('a claim with no document requirements at all is left alone', async () => {
  // Vacuously complete, but nothing was ever being waited on, so there is no
  // wait to end. It stays exactly where triage put it.
  const fixture = state({
    claims: [waiting({ status: 'submitted', documents_required: [], documents_received: [] })],
  });

  const outcome = await advanceClaimOnDocumentsComplete(fakeSupabase(fixture), {}, 'claim-1');

  assert.equal(outcome.advanced, false);
  assert.equal(outcome.reason, 'not_awaiting_documents');
  assert.equal(fixture.writes.length, 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordJourneyEvent } from './journey-events-service.js';

// --- Test doubles -----------------------------------------------------------

interface FakeState {
  /** Every row handed to insert(), so refusals can be told from writes. */
  rows: Array<Record<string, any>>;
  /** Injected fault: PostgREST answering with an error rather than throwing. */
  insertError: any;
  /** Injected fault: a client that throws outright — a reset, a bad URL. */
  insertThrows: Error | null;
  /** Tables the service touched, so it cannot quietly write somewhere else. */
  tables: string[];
}

function state(overrides: Partial<FakeState> = {}): FakeState {
  return { rows: [], insertError: null, insertThrows: null, tables: [], ...overrides };
}

function fakeSupabase(s: FakeState): SupabaseClient {
  return {
    from(table: string) {
      s.tables.push(table);
      return {
        async insert(row: Record<string, any>) {
          if (s.insertThrows) throw s.insertThrows;
          if (s.insertError) return { data: null, error: s.insertError };
          s.rows.push(row);
          return { data: null, error: null };
        },
      };
    },
  } as unknown as SupabaseClient;
}

/**
 * Silence the deliberate console.error calls while asserting they happened.
 *
 * The log line is the compensating control for a swallowed failure — if the
 * service ever stopped logging, a lost event would become genuinely silent —
 * so the tests assert on it rather than merely muting it.
 */
async function captureErrors(fn: () => Promise<void>): Promise<string[]> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

const CLAIM = '11111111-1111-1111-1111-111111111111';
const POLICY = '22222222-2222-2222-2222-222222222222';
const CALL = '33333333-3333-3333-3333-333333333333';

// --- What gets written ------------------------------------------------------

test('an event on a claim alone is recorded against that claim', async () => {
  const s = state();
  await recordJourneyEvent(fakeSupabase(s), {
    claimId: CLAIM,
    eventType: 'claim_filed',
    actor: 'agent',
    detail: { claim_number: 'CLM-2026-0001' },
    callLogId: CALL,
  });

  assert.deepEqual(s.tables, ['journey_events']);
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].claim_id, CLAIM);
  assert.equal(s.rows[0].policy_id, null);
  assert.equal(s.rows[0].event_type, 'claim_filed');
  assert.equal(s.rows[0].actor, 'agent');
  assert.deepEqual(s.rows[0].detail, { claim_number: 'CLM-2026-0001' });
  assert.equal(s.rows[0].call_log_id, CALL);
  assert.ok(s.rows[0].occurred_at);
});

test('an event on a policy alone is recorded — a renewal has no claim yet', async () => {
  // The case a claim-keyed table would have lost: the caller rang to file a
  // claim, was refused because the policy had lapsed, and paid to renew. There
  // is no claim in this story at all, and inventing one to hold the event is
  // the mistake migration 0015 exists to undo.
  const s = state();
  await recordJourneyEvent(fakeSupabase(s), {
    policyId: POLICY,
    eventType: 'renewal_paid',
    actor: 'provider',
    detail: { captured_amount_paise: 1_200_000 },
  });

  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].claim_id, null);
  assert.equal(s.rows[0].policy_id, POLICY);
  assert.equal(s.rows[0].actor, 'provider');
  assert.equal(s.rows[0].call_log_id, null);
});

test('an event carrying both a claim and a policy keeps both', async () => {
  const s = state();
  await recordJourneyEvent(fakeSupabase(s), {
    claimId: CLAIM,
    policyId: POLICY,
    eventType: 'settled',
    actor: 'human',
  });

  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].claim_id, CLAIM);
  assert.equal(s.rows[0].policy_id, POLICY);
});

test('an omitted detail is an empty object, never null', async () => {
  // The column is NOT NULL DEFAULT '{}'. Sending an explicit null would make
  // every detail-less event fail the constraint instead of writing.
  const s = state();
  await recordJourneyEvent(fakeSupabase(s), {
    claimId: CLAIM,
    eventType: 'documents_requested',
    actor: 'system',
  });

  assert.deepEqual(s.rows[0].detail, {});
});

test('a supplied occurred_at is kept — a webhook records what the rail timestamped', async () => {
  const s = state();
  const when = new Date('2026-08-01T10:30:00.000Z');
  await recordJourneyEvent(fakeSupabase(s), {
    policyId: POLICY,
    eventType: 'renewal_paid',
    actor: 'provider',
    occurredAt: when,
  });

  assert.equal(s.rows[0].occurred_at, '2026-08-01T10:30:00.000Z');
});

// --- What gets refused ------------------------------------------------------

test('an event naming neither a claim nor a policy records nothing', async () => {
  // It would sit in the table forever appearing on no timeline. Refused here
  // rather than by the CHECK constraint, so the log names the missing field.
  const s = state();
  const logged = await captureErrors(() =>
    recordJourneyEvent(fakeSupabase(s), { eventType: 'adjudicated', actor: 'system' })
  );

  assert.equal(s.rows.length, 0);
  assert.equal(s.tables.length, 0);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /neither a claim nor a policy/);
});

test('explicit nulls on both ids are refused the same way as omitting them', async () => {
  const s = state();
  await captureErrors(() =>
    recordJourneyEvent(fakeSupabase(s), {
      claimId: null,
      policyId: null,
      eventType: 'adjudicated',
      actor: 'system',
    })
  );

  assert.equal(s.rows.length, 0);
});

test('a blank event type records nothing', async () => {
  // A blank event_type renders as a blank row: the reader can see that
  // something happened and can never find out what.
  const s = state();
  const logged = await captureErrors(() =>
    recordJourneyEvent(fakeSupabase(s), { claimId: CLAIM, eventType: '   ', actor: 'system' })
  );

  assert.equal(s.rows.length, 0);
  assert.match(logged[0], /blank event_type/);
});

test('an unknown actor records nothing rather than a mislabelled one', async () => {
  const s = state();
  const logged = await captureErrors(() =>
    recordJourneyEvent(fakeSupabase(s), {
      claimId: CLAIM,
      eventType: 'decided',
      actor: 'robot' as any,
    })
  );

  assert.equal(s.rows.length, 0);
  assert.match(logged[0], /unknown actor/);
});

test('surrounding whitespace is trimmed off the event type', async () => {
  const s = state();
  await recordJourneyEvent(fakeSupabase(s), {
    claimId: CLAIM,
    eventType: '  deductible_paid\n',
    actor: 'provider',
  });

  assert.equal(s.rows[0].event_type, 'deductible_paid');
});

// --- Failure never propagates ----------------------------------------------

test('a database error does not throw — the step it described still happened', async () => {
  // The whole point of the service. Six workstreams record events on paths
  // where the step is already done: a claim filed, money captured, a policy put
  // back in force. If this threw, an unapplied migration 0021 would abort the
  // very steps it exists to write down.
  const s = state({ insertError: { code: '42P01', message: 'relation "journey_events" does not exist' } });

  const logged = await captureErrors(async () => {
    await recordJourneyEvent(fakeSupabase(s), {
      claimId: CLAIM,
      eventType: 'claim_filed',
      actor: 'agent',
    });
  });

  assert.equal(s.rows.length, 0);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /claim_filed/);
  assert.match(logged[0], /not recorded/);
});

test('a client that throws outright is caught too', async () => {
  const s = state({ insertThrows: new Error('fetch failed: ECONNRESET') });

  const logged = await captureErrors(async () => {
    await recordJourneyEvent(fakeSupabase(s), {
      policyId: POLICY,
      eventType: 'policy_reactivated',
      actor: 'system',
    });
  });

  assert.equal(logged.length, 1);
  assert.match(logged[0], /threw while recording an event/);
});

test('a failed write returns undefined rather than rejecting', async () => {
  // Callers attach this to a background .catch() or await it inline; both must
  // be safe, which means the promise resolves whatever the database did.
  const s = state({ insertError: { message: 'permission denied for table journey_events' } });

  const result = await captureErrors(async () => {
    const value = await recordJourneyEvent(fakeSupabase(s), {
      claimId: CLAIM,
      eventType: 'refunded',
      actor: 'system',
    });
    assert.equal(value, undefined);
  });

  assert.equal(result.length, 1);
});

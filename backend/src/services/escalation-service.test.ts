import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createEscalation,
  generateEscalationReference,
  type EscalationCreated,
  type EscalationResult,
} from './escalation-service.js';

// --- Test doubles -----------------------------------------------------------

interface FakeState {
  escalations: Record<string, any>[];
  call_logs: Record<string, any>[];
  /** Injected fault, so a genuine outage can be told apart from a collision. */
  insertError: any;
  /**
   * Forces the unique index to fire on the next N inserts regardless of what
   * is stored, which is the only way to reach the retry the way a real race
   * would.
   */
  forceCollisions: number;
}

/** PostgreSQL unique_violation — the reference_number index firing. */
const UNIQUE_VIOLATION = { code: '23505', message: 'duplicate key value violates unique constraint' };

/**
 * Minimal PostgREST stand-in covering the one shape the service uses:
 * a bare `.insert()` awaited for its error. Rows are kept so a second call
 * sees what the first one wrote, and the unique reference_number index is
 * enforced on insert.
 *
 * Every table the service could touch is backed, so an insert into `call_logs`
 * would be recorded rather than throwing — the test asserting that none happens
 * has to be able to observe one if it did.
 */
function fakeSupabase(state: FakeState) {
  return {
    from(table: string) {
      const rows: Record<string, any>[] = (state as any)[table];
      return {
        async insert(row: Record<string, unknown>) {
          if (state.insertError) return { data: null, error: state.insertError };

          if (state.forceCollisions > 0) {
            state.forceCollisions--;
            return { data: null, error: UNIQUE_VIOLATION };
          }

          const reference = row.reference_number;
          if (
            table === 'escalations' &&
            reference != null &&
            rows.some((r) => r.reference_number === reference)
          ) {
            return { data: null, error: UNIQUE_VIOLATION };
          }

          rows.push({ id: `${table}-${rows.length + 1}`, ...row });
          return { data: null, error: null };
        },
      };
    },
  };
}

function state(overrides: Partial<FakeState> = {}): FakeState {
  return {
    escalations: [],
    call_logs: [],
    insertError: null,
    forceCollisions: 0,
    ...overrides,
  };
}

function escalate(
  fixture: FakeState,
  data: Parameters<typeof createEscalation>[1] = { reason: 'Wants to speak to a supervisor' }
): Promise<EscalationResult> {
  return createEscalation(fakeSupabase(fixture) as unknown as SupabaseClient, data);
}

function assertCreated(result: EscalationResult): asserts result is EscalationCreated {
  assert.equal(result.success, true, `expected an escalation, got ${JSON.stringify(result)}`);
}

/** Every refusal must be inert: no escalation stored and no call invented. */
function assertRefused(result: EscalationResult, fixture: FakeState) {
  assert.equal(result.success, false, `expected a refusal, got ${JSON.stringify(result)}`);
  assert.equal(fixture.escalations.length, 0);
  assert.equal(fixture.call_logs.length, 0);
}

// --- No call context must not invent a call ---------------------------------

test('an escalation with no call context creates no call_logs row', async () => {
  const fixture = state();
  const result = await escalate(fixture);

  assertCreated(result);
  assert.equal(
    fixture.call_logs.length,
    0,
    'a call that never happened must never be written to call_logs'
  );
  assert.equal(fixture.escalations.length, 1);
});

test('an escalation with no call context stores a null call_log_id', async () => {
  const fixture = state();
  assertCreated(await escalate(fixture));
  assert.equal(fixture.escalations[0].call_log_id, null);
});

test('a supplied call_log_id is kept as the link to the real call', async () => {
  const fixture = state();
  assertCreated(
    await escalate(fixture, { reason: 'Unhappy with the outcome', call_log_id: 'call-42' })
  );
  assert.equal(fixture.escalations[0].call_log_id, 'call-42');
  assert.equal(fixture.call_logs.length, 0, 'an existing call must not be duplicated either');
});

// --- The reference the caller is told must be findable ----------------------

test('the reference read aloud is the one stored in its own column', async () => {
  const fixture = state();
  const result = await escalate(fixture);

  assertCreated(result);
  assert.equal(
    fixture.escalations[0].reference_number,
    result.reference_number,
    'the number a supervisor looks up must be the number the caller was given'
  );
  assert.ok(
    result.message.includes(result.reference_number),
    'the spoken message must quote the same reference'
  );
});

test('the reference has the canonical shape the migration constrains', async () => {
  const result = await escalate(state());
  assertCreated(result);
  assert.match(result.reference_number, /^ESC-\d{4}-\d{8}$/);
  assert.ok(result.reference_number.startsWith(`ESC-${new Date().getFullYear()}-`));
});

test('references do not repeat across many escalations', async () => {
  const fixture = state();
  const seen = new Set<string>();

  for (let i = 0; i < 200; i++) {
    const result = await escalate(fixture);
    assertCreated(result);
    seen.add(result.reference_number);
  }

  assert.equal(seen.size, 200, 'a repeated reference makes two escalations indistinguishable');
  assert.equal(fixture.escalations.length, 200);
});

test('the generator draws from a space wide enough to make collisions rare', () => {
  // The old form was four digits — 10,000 values, so a few dozen escalations a
  // day made a clash likely. This asserts the width, not the randomness.
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) seen.add(generateEscalationReference());
  assert.ok(seen.size > 1990, `expected near-unique draws, got ${seen.size} distinct of 2000`);
});

test('the generator uses the year it is given', () => {
  assert.ok(generateEscalationReference(new Date('2031-06-01T00:00:00Z')).startsWith('ESC-2031-'));
});

// --- A collision retries; exhaustion refuses --------------------------------

test('a reference collision is retried rather than reported as a failure', async () => {
  const fixture = state({ forceCollisions: 2 });
  const result = await escalate(fixture);

  assertCreated(result);
  assert.equal(fixture.escalations.length, 1);
  assert.equal(fixture.escalations[0].reference_number, result.reference_number);
});

test('exhausting the retries refuses, and says so differently from an outage', async () => {
  const fixture = state({ forceCollisions: 3 });
  const result = await escalate(fixture);

  assertRefused(result, fixture);
  assert.notEqual(
    result.message,
    'I was unable to create the escalation. Please try again.',
    'a collision must not be indistinguishable from a database fault'
  );
});

// --- A database fault refuses rather than fabricating ------------------------

test('a database fault refuses rather than fabricating an escalation', async () => {
  const fixture = state({ insertError: { code: '08006', message: 'connection failure' } });
  assertRefused(await escalate(fixture), fixture);
});

test('a database fault does not burn the retries on a non-collision error', async () => {
  let attempts = 0;
  const supabase = {
    from() {
      return {
        async insert() {
          attempts++;
          return { data: null, error: { code: '08006', message: 'connection failure' } };
        },
      };
    },
  };

  const result = await createEscalation(supabase as unknown as SupabaseClient, {
    reason: 'Wants a supervisor',
  });

  assert.equal(result.success, false);
  assert.equal(attempts, 1, 'an outage is not a collision and must not be retried blindly');
});

// --- Input handling ---------------------------------------------------------

test('the reason is trimmed before it is stored', async () => {
  const fixture = state();
  assertCreated(await escalate(fixture, { reason: '   Agent was unhelpful   ' }));
  assert.equal(fixture.escalations[0].reason, 'Agent was unhelpful');
});

test('an unrecognised priority falls back to normal rather than being stored', async () => {
  const fixture = state();
  const result = await escalate(fixture, { reason: 'Angry', priority: 'catastrophic' });

  assertCreated(result);
  assert.equal(fixture.escalations[0].priority, 'normal');
  assert.ok(result.message.includes('normal'));
});

// These used to assert the spoken SLA — "you can expect a response within 1
// business hour". Nothing in this system assigns, works or closes an
// escalation, so that was a commitment no code kept, and the tests were
// holding it in place. What is still worth asserting is that the priority the
// caller is told matches the priority that was stored: a message saying
// "urgent" over a row saying "normal" is the failure that matters here.
for (const [priority, spoken] of [
  ['urgent', 'urgent'],
  ['high', 'high'],
  ['normal', 'normal'],
  ['low', 'low'],
] as const) {
  test(`a ${priority} escalation reads back the priority it stored`, async () => {
    const fixture = state();
    const result = await escalate(fixture, { reason: 'Needs a supervisor', priority });

    assertCreated(result);
    assert.equal(fixture.escalations[0].priority, priority);
    assert.ok(result.message.includes(spoken), `expected "${spoken}" in: ${result.message}`);
    assert.ok(
      !/expect a response|within \d+ (business )?hour/i.test(result.message),
      `the message promised a response time nothing delivers: ${result.message}`
    );
  });
}

test('a new escalation is stored pending, never pre-resolved', async () => {
  const fixture = state();
  assertCreated(await escalate(fixture, { reason: 'Wants a callback', claim_id: 'claim-9' }));

  assert.equal(fixture.escalations[0].status, 'pending');
  assert.equal(fixture.escalations[0].claim_id, 'claim-9');
  assert.equal(fixture.escalations[0].customer_id, null);
});

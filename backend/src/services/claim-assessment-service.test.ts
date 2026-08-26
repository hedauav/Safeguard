import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  explainClaimAssessment,
  type ClaimAssessmentExplained,
  type ClaimAssessmentResult,
} from './claim-assessment-service.js';

// --- Test doubles -----------------------------------------------------------

interface FakeState {
  claims: Record<string, any>[];
  policies: Record<string, any>[];
  claim_documents: Record<string, any>[];
  /**
   * Injected faults, one per read, so a genuine outage can be told apart from
   * "not found". The two must never produce the same answer: telling somebody
   * their real claim does not exist while the database is down sends them off
   * to re-read a number that was correct the first time.
   */
  claimLookupError: any;
  policyLookupError: any;
  siblingLookupError: any;
  documentLookupError: any;
}

/**
 * Minimal PostgREST stand-in covering the two shapes the service uses:
 * `.select().eq().maybeSingle()` for a single row, and `.select().eq()`
 * awaited straight to a list (PostgREST builders are thenable).
 *
 * `claims` is read twice with different intents — once by claim_number for the
 * claim itself, once by policy_id for its siblings — so the fault is chosen by
 * the column, not the table.
 */
function fakeSupabase(state: FakeState): SupabaseClient {
  return {
    from(table: string) {
      const rows: Record<string, any>[] = (state as any)[table] ?? [];
      return {
        select() {
          return {
            eq(column: string, value: unknown) {
              const errorFor = () => {
                if (table === 'policies') return state.policyLookupError;
                if (table === 'claim_documents') return state.documentLookupError;
                return column === 'claim_number' ? state.claimLookupError : state.siblingLookupError;
              };
              const matches = () => rows.filter((row) => row[column] === value);
              return {
                async maybeSingle() {
                  const error = errorFor();
                  if (error) return { data: null, error };
                  return { data: matches()[0] ?? null, error: null };
                },
                then(resolve: (value: any) => unknown, reject?: (reason: any) => unknown) {
                  const error = errorFor();
                  const payload = error ? { data: null, error } : { data: matches(), error: null };
                  return Promise.resolve(payload).then(resolve, reject);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

// PostgREST's "no rows" code. Anything else is a real fault.
const NOT_FOUND = { code: 'PGRST116', message: 'no rows' };

const CLAIM_ID = 'claim-1';
const CLAIM_NUMBER = 'CLM-2026-000456';
const POLICY_ID = 'policy-1';
const POLICY_NUMBER = 'POL-2026-000111';

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    claims: [
      {
        id: CLAIM_ID,
        claim_number: CLAIM_NUMBER,
        policy_id: POLICY_ID,
        claim_type: 'collision',
        status: 'submitted',
        incident_date: '2026-06-01',
        claimed_amount: 40000,
        incident_description: 'Rear-ended at a junction.',
        documents_required: [],
        documents_received: [],
      },
    ],
    policies: [
      {
        id: POLICY_ID,
        policy_number: POLICY_NUMBER,
        policy_type: 'auto',
        status: 'active',
        coverage_amount: 100000,
        deductible: 5000,
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        coverage_details: null,
      },
    ],
    claim_documents: [],
    claimLookupError: null,
    policyLookupError: null,
    siblingLookupError: null,
    documentLookupError: null,
    ...overrides,
  };
}

function explained(result: ClaimAssessmentResult): ClaimAssessmentExplained {
  assert.equal(result.success, true, `expected an explanation, got: ${JSON.stringify(result)}`);
  return result as ClaimAssessmentExplained;
}

// --- What the policy says ---------------------------------------------------

test('a covered claim reports the limit, the excess and the payable amount', async () => {
  const state = baseState();
  const result = explained(await explainClaimAssessment(fakeSupabase(state), CLAIM_NUMBER));

  assert.equal(result.claim_number, CLAIM_NUMBER);
  assert.equal(result.policy_number, POLICY_NUMBER);
  assert.equal(result.claim_type_covered, true);
  assert.equal(result.coverage_amount, 100000);
  assert.equal(result.deductible, 5000);
  assert.equal(result.claimed_amount, 40000);
  // min(40000, 100000) - 5000, the settlement path's own arithmetic.
  assert.equal(result.payable_amount, 35000);
  assert.equal(result.blocking_rule, null);
});

test('the payable figure is capped at the coverage before the excess comes off', async () => {
  const state = baseState();
  state.claims[0].claimed_amount = 250000;
  const result = explained(await explainClaimAssessment(fakeSupabase(state), CLAIM_NUMBER));

  // min(250000, 100000) - 5000. Never the claimed amount less the excess.
  assert.equal(result.payable_amount, 95000);
});

test('a claim type outside the cover is reported as not covered, not as unknown', async () => {
  const state = baseState();
  state.claims[0].claim_type = 'medical';
  const result = explained(await explainClaimAssessment(fakeSupabase(state), CLAIM_NUMBER));

  assert.equal(result.claim_type_covered, false);
});

test('a policy type with no coverage schedule reports null, because unknown is not "not covered"', async () => {
  const state = baseState();
  state.policies[0].policy_type = 'marine';
  const result = explained(await explainClaimAssessment(fakeSupabase(state), CLAIM_NUMBER));

  assert.equal(result.claim_type_covered, null);
});

test('a claim with no stated amount reports a null payable, not zero', async () => {
  const state = baseState();
  state.claims[0].claimed_amount = null;
  const result = explained(await explainClaimAssessment(fakeSupabase(state), CLAIM_NUMBER));

  assert.equal(result.claimed_amount, null);
  // Zero would read as "your claim is worth nothing"; the truth is that nobody
  // has said what it is worth. This is the gap `estimated_amount` closes.
  assert.equal(result.payable_amount, null);
  assert.equal(result.blocking_rule?.id, 'claimed_amount_stated');
  assert.match(result.message, /No amount has been recorded/);
});

// --- Deterministic vetoes ---------------------------------------------------

test('a vetoing rule is named, with its own reason, and marked as a refusal', async () => {
  const state = baseState();
  state.claims[0].incident_date = '2025-01-01'; // before the policy term

  const result = explained(await explainClaimAssessment(fakeSupabase(state), CLAIM_NUMBER));

  assert.equal(result.blocking_rule?.id, 'policy_in_force_on_incident_date');
  assert.equal(result.blocking_rule?.effect, 'refused');
  assert.match(result.blocking_rule!.detail, /falls outside the term/);
  assert.match(result.blocking_rule!.detail, new RegExp(POLICY_NUMBER));
  // The rule's own sentence reaches the caller, unsoftened.
  assert.ok(result.message.includes(result.blocking_rule!.detail));
});

test('nothing left after the excess is a named refusal, not a silent zero', async () => {
  const state = baseState();
  state.claims[0].claimed_amount = 4000; // below the 5000 excess

  const result = explained(await explainClaimAssessment(fakeSupabase(state), CLAIM_NUMBER));

  assert.equal(result.payable_amount, 0);
  assert.equal(result.blocking_rule?.id, 'something_payable');
  assert.equal(result.blocking_rule?.effect, 'refused');
});

test('a rule that can only route to a person is marked needs_review, not refused', async () => {
  const state = baseState();
  // Above the limit escalates rather than denies: the settlement rule caps the
  // payout anyway, so what this needs is a conversation, not a denial.
  state.claims[0].claimed_amount = 250000;

  const result = explained(await explainClaimAssessment(fakeSupabase(state), CLAIM_NUMBER));

  assert.equal(result.blocking_rule?.id, 'claimed_amount_within_coverage');
  assert.equal(result.blocking_rule?.effect, 'needs_review');
  assert.match(result.message, /needs a person to look at it/);
});

test('a missing policy row escalates rather than being read as an active policy', async () => {
  const state = baseState();
  state.policies = [];
  const result = explained(await explainClaimAssessment(fakeSupabase(state), CLAIM_NUMBER));

  assert.equal(result.policy_number, null);
  assert.equal(result.blocking_rule?.id, 'policy_on_file');
  assert.equal(result.blocking_rule?.effect, 'needs_review');
});

// --- Outstanding documents --------------------------------------------------

test('outstanding documents exclude both what was received and what has been uploaded', async () => {
  const state = baseState();
  state.claims[0].documents_required = ['police_report', 'photos', 'repair_estimate'];
  state.claims[0].documents_received = ['photos'];
  // Uploaded a moment ago: the evidence pipeline writes documents_received
  // only after re-anchoring, so this is on file without being listed there.
  state.claim_documents = [{ claim_id: CLAIM_ID, document_type: 'police_report' }];

  const result = explained(await explainClaimAssessment(fakeSupabase(state), CLAIM_NUMBER));

  assert.deepEqual(result.documents_outstanding, ['repair_estimate']);
  assert.match(result.message, /still waiting on: repair estimate/);
});

test('a document read that fails warns rather than printing a shorter list as complete', async () => {
  const state = baseState({ documentLookupError: { code: '08006', message: 'connection failure' } });
  state.claims[0].documents_required = ['police_report'];

  const result = explained(await explainClaimAssessment(fakeSupabase(state), CLAIM_NUMBER));

  assert.ok(result.warnings.some((warning) => /Uploaded documents could not be read/.test(warning)));
  // The coverage arithmetic is unaffected, so it is still answered.
  assert.equal(result.payable_amount, 35000);
});

test('a sibling read that fails says the duplicate check did not run', async () => {
  const state = baseState({ siblingLookupError: { code: '08006', message: 'connection failure' } });

  const result = explained(await explainClaimAssessment(fakeSupabase(state), CLAIM_NUMBER));

  assert.ok(result.warnings.some((warning) => /duplicate-claim check did not run/.test(warning)));
});

// --- No model verdict may ever reach a caller -------------------------------

/**
 * Field names carried by `adjudicateClaim`'s recommendation that must never
 * appear here. The tool this service backs is on a phone line; the harm the
 * design forbids is a caller hearing an automated opinion that their claim
 * looks deniable before any adjuster has read a word.
 */
const FORBIDDEN_KEYS = [
  'verdict',
  'confidence',
  'inconsistencies',
  'recommendation',
  'model_proposed_amount',
  'amount_agreement',
  'policy_clauses',
  'prompt_system',
  'prompt_user',
];

/** The only verdicts that exist. None of them may be a value in this result. */
const VERDICTS = ['approve', 'deny', 'escalate'];

function assertNoVerdict(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoVerdict(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      assert.ok(
        !FORBIDDEN_KEYS.includes(key),
        `${path}.${key} leaks an adjudication field a caller must never hear`
      );
      assertNoVerdict(entry, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === 'string') {
    assert.ok(!VERDICTS.includes(value), `${path} carries the verdict "${value}"`);
  }
}

test('a clean claim carries no verdict, confidence, or inconsistencies', async () => {
  const result = await explainClaimAssessment(fakeSupabase(baseState()), CLAIM_NUMBER);
  assertNoVerdict(result);
});

test('a vetoed claim carries no verdict either — the rule is named, the leaning is not', async () => {
  const state = baseState();
  state.claims[0].incident_date = '2025-01-01';

  const result = explained(await explainClaimAssessment(fakeSupabase(state), CLAIM_NUMBER));

  assertNoVerdict(result);
  // The rule's veto verdict is translated, never passed through raw.
  assert.equal(result.blocking_rule?.effect, 'refused');
});

test('every explanation says a reviewer decides', async () => {
  const states: FakeState[] = [baseState(), baseState(), baseState()];
  states[1].claims[0].incident_date = '2025-01-01';
  states[2].claims[0].claimed_amount = null;

  for (const state of states) {
    const result = explained(await explainClaimAssessment(fakeSupabase(state), CLAIM_NUMBER));
    assert.match(result.message, /a claims reviewer decides/);
    assert.match(result.message, /None of that is a decision/);
  }
});

// --- Outage is not "not found" ----------------------------------------------

test('a claim read that faults refuses as unavailable, not as not-found', async () => {
  const state = baseState({ claimLookupError: { code: '08006', message: 'connection failure' } });

  const result = await explainClaimAssessment(fakeSupabase(state), CLAIM_NUMBER);

  assert.equal(result.success, false);
  assert.equal(result.reason, 'records_unavailable');
  assert.match(result.message, /trouble reaching our claim records/);
  // Never the wording that sends a caller off to re-read a correct number.
  assert.doesNotMatch(result.message, /couldn't find a claim/);
});

test('a policy read that faults refuses as unavailable, and names the claim it was on', async () => {
  const state = baseState({ policyLookupError: { code: '08006', message: 'connection failure' } });

  const result = await explainClaimAssessment(fakeSupabase(state), CLAIM_NUMBER);

  assert.equal(result.success, false);
  assert.equal(result.reason, 'records_unavailable');
  assert.equal(result.claim_number, CLAIM_NUMBER);
});

test('a genuinely absent claim is not-found, not an outage', async () => {
  const state = baseState({ claimLookupError: NOT_FOUND });
  state.claims = [];

  const result = await explainClaimAssessment(fakeSupabase(state), CLAIM_NUMBER);

  assert.equal(result.success, false);
  assert.equal(result.reason, 'claim_not_found');
  assert.match(result.message, /couldn't find a claim/);
});

test('a claim number spoken without its dashes still resolves', async () => {
  const state = baseState();
  const result = explained(await explainClaimAssessment(fakeSupabase(state), 'clm2026000456'));

  assert.equal(result.claim_number, CLAIM_NUMBER);
});

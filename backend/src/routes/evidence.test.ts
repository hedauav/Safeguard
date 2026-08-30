import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';

// environment.ts calls requireEnv() at import time and this route imports it,
// so the module graph refuses to load without database credentials. These
// placeholders let the endpoint be exercised without the environment the
// server needs to boot. `||=` rather than `??=`: an empty string is as absent
// as undefined to requireEnv.
process.env.SUPABASE_URL ||= 'https://stub.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'stub-service-role-key';

// AND THE GROQ KEY IS EMPTIED, DELIBERATELY AND BEFORE THE IMPORT BELOW.
// `features.adjudicationModel` is computed once at module load, so the
// unconfigured case is only reachable if the variable is cleared first — and a
// developer's .env holds a real key that dotenv would otherwise load here,
// which would flip `configured` to true and quietly delete the assertion that
// no key material reaches the response. Set to '' rather than deleted, because
// dotenv only fills in keys absent from process.env and optionalEnv reads ''
// as unset.
process.env.GROQ_API_KEY = '';

const Fastify = (await import('fastify')).default;
const evidenceRoutes = (await import('./evidence.js')).default;
const { rootIndexRoutes } = await import('./evidence.js');
const { computeEvidenceHash } = await import('../services/attestation-service.js');
const { BUILD_GIT_SHA, BUILD_STAMPED } = await import('../generated/version.js');

// --- Test doubles -----------------------------------------------------------

interface FakeState {
  deductible_payments: Record<string, any>[];
  evidence_bundles: Record<string, any>[];
  adjudications: Record<string, any>[];
  claims: Record<string, any>[];
  filecoin_uploads: Record<string, any>[];
  /** Injected read faults, keyed by table name. */
  errors: Record<string, any>;
}

function emptyState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    deductible_payments: [],
    evidence_bundles: [],
    adjudications: [],
    claims: [],
    filecoin_uploads: [],
    errors: {},
    ...overrides,
  };
}

/**
 * Minimal PostgREST stand-in.
 *
 * A single chainable builder rather than the nested shapes the other route
 * tests use, because this endpoint runs five queries of its own and then hands
 * the same client to readObservations, which runs four more in a different
 * shape. `.select()`, `.eq()`, `.in()`, `.not(col, 'is', null)`, `.order()` and
 * `.limit()` accumulate; `.maybeSingle()`, `.single()` and awaiting the builder
 * terminate. Rows are returned whole, ignoring the column list — which makes
 * the PII test stronger, not weaker: anything the route spreads rather than
 * picks would leak into the response here.
 */
function fakeSupabase(state: FakeState): SupabaseClient {
  return {
    from(table: string) {
      const error = state.errors[table] ?? null;
      let rows: Record<string, any>[] = [...((state as any)[table] ?? [])];

      const builder: any = {
        select() {
          return builder;
        },
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
        limit(count: number) {
          rows = rows.slice(0, count);
          return builder;
        },
        async maybeSingle() {
          return error ? { data: null, error } : { data: rows[0] ?? null, error: null };
        },
        async single() {
          if (error) return { data: null, error };
          return rows[0]
            ? { data: rows[0], error: null }
            : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
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

async function buildServer(state: FakeState) {
  const app = Fastify();
  app.decorate('supabase', fakeSupabase(state));
  await app.register(evidenceRoutes, { prefix: '/api' });
  await app.register(rootIndexRoutes);
  await app.ready();
  return app;
}

// --- Fixtures ---------------------------------------------------------------

/**
 * Deliberately carries the PII columns alongside the ones the endpoint reads.
 * A row in production holds all of these; the fixture must too, or the PII test
 * proves only that the fixture was thin.
 */
const CLAIM_ROW = {
  id: 'claim-1',
  claim_number: 'CLM-2026-964201',
  customer_id: 'customer-1',
  incident_description: 'A pipe burst in the kitchen and damaged the flooring.',
  notes: 'Spoke to Priya Raghunathan on the twelfth.',
  assigned_adjuster: 'Neha Agarwal',
  simulated: false,
  attested_at: '2026-04-11T17:35:12.000Z',
  attestation_tx_hash: '0x46e6de48c3568f9243f25fa2cea600f0932d9fe149509d7f4f4425003acc3c65',
  evidence_hash: '0x9ed40da62553b990914a64dc3d4e4308d29fc578aa17fb386f466d37acf82282',
};

const CUSTOMER_FIELDS = {
  full_name: 'Priya Raghunathan',
  email: 'priya.raghunathan@example.invalid',
  phone: '+919876543210',
  address: '14 Turner Road, Bandra West, Mumbai',
  date_of_birth: '1988-03-04',
};

const BUNDLE_JSON = { claim_number: 'CLM-2026-964201', filed_at: '2026-04-11T17:30:00.000Z' };
const SECOND_BUNDLE_JSON = { claim_number: 'CLM-2026-000890', filed_at: '2026-05-02T09:10:00.000Z' };

function populatedState(): FakeState {
  return emptyState({
    claims: [CLAIM_ROW],
    deductible_payments: [
      {
        claim_id: 'claim-1',
        payment_id: 'pay_QxYzTestCapture01',
        refund_id: 'rfnd_QxYzTestRefund01',
        amount_paise: 500000,
        captured_amount_paise: 100000,
        refund_amount_paise: 100000,
        captured_at: '2026-04-11T17:32:00.000Z',
        refunded_at: '2026-04-14T11:02:00.000Z',
        // Razorpay's webhook payloads carry the payer's contact details, and
        // deductible_payments sits next to the table that stores them.
        ...CUSTOMER_FIELDS,
      },
      {
        claim_id: 'claim-1',
        payment_id: 'pay_QxYzTestCapture02',
        refund_id: null,
        amount_paise: 500000,
        captured_amount_paise: 250000,
        refund_amount_paise: null,
        captured_at: '2026-05-02T09:14:00.000Z',
        refunded_at: null,
      },
      // No money arrived on this one. It must contribute to neither total nor
      // appear in the recent list.
      {
        claim_id: 'claim-1',
        payment_id: null,
        refund_id: null,
        amount_paise: 500000,
        captured_amount_paise: null,
        refund_amount_paise: null,
        captured_at: null,
        refunded_at: null,
      },
    ],
    evidence_bundles: [
      {
        claim_id: 'claim-1',
        bundle_json: BUNDLE_JSON,
        bundle_hash: computeEvidenceHash(BUNDLE_JSON as any),
        created_at: '2026-04-11T17:30:05.000Z',
      },
      {
        claim_id: 'claim-2',
        bundle_json: SECOND_BUNDLE_JSON,
        bundle_hash: computeEvidenceHash(SECOND_BUNDLE_JSON as any),
        created_at: '2026-05-02T09:10:05.000Z',
      },
    ],
    adjudications: [
      {
        model_invoked: true,
        vetoed_by: null,
        prompt_user: 'The claimant said: a pipe burst in the kitchen.',
        prompt_system: 'You are an adjudicator.',
        raw_response: '{"verdict":"escalate"}',
        simulated: false,
      },
      { model_invoked: true, simulated: false, vetoed_by: null },
      // FakeLlmProvider: model_invoked is true, but no model read anything.
      // 0017: never present such a row as a model-reviewed claim.
      { model_invoked: true, simulated: true, vetoed_by: null },
      { model_invoked: false, vetoed_by: 'policy_not_cancelled' },
      { model_invoked: false, vetoed_by: 'policy_not_cancelled' },
      { model_invoked: false, vetoed_by: 'claim_not_already_decided' },
    ],
    filecoin_uploads: [
      {
        claim_id: 'claim-1',
        upload_status: 'completed',
        attempted_at: '2026-04-11T17:31:00.000Z',
        completed_at: '2026-04-11T17:31:40.000Z',
        simulated: false,
      },
    ],
  });
}

// --- Shapes and types -------------------------------------------------------

test('the response carries every block, with the stated types', async () => {
  const app = await buildServer(populatedState());
  const response = await app.inject({ method: 'GET', url: '/api/evidence/recent' });
  assert.equal(response.statusCode, 200);
  const body = response.json();

  assert.equal(body.razorpay.mode, 'test');
  assert.equal(typeof body.razorpay.collected_paise, 'number');
  assert.equal(typeof body.razorpay.refunded_paise, 'number');
  assert.ok(Array.isArray(body.razorpay.recent));

  assert.equal(typeof body.audit_chain.records_checked, 'number');
  assert.equal(typeof body.audit_chain.chain_ok, 'boolean');
  assert.ok(body.audit_chain.first_bad_seq === null || typeof body.audit_chain.first_bad_seq === 'number');
  assert.equal(typeof body.audit_chain.head, 'string');

  assert.equal(body.attestation.network, 'base-sepolia');
  assert.ok(body.attestation.last_success_tx === null || typeof body.attestation.last_success_tx === 'string');

  assert.equal(body.adjudication.provider, 'groq');
  assert.equal(typeof body.adjudication.model, 'string');
  assert.equal(typeof body.adjudication.configured, 'boolean');
  assert.equal(typeof body.adjudication.model_invoked, 'number');
  assert.equal(typeof body.adjudication.model_simulated, 'number');
  assert.equal(typeof body.adjudication.vetoed_before_model, 'number');
  assert.equal(typeof body.adjudication.veto_reasons, 'object');

  assert.ok(!Number.isNaN(Date.parse(body.generated_at)));

  await app.close();
});

test('every figure is the query result, not a literal', async () => {
  const app = await buildServer(populatedState());
  const body = (await app.inject({ method: 'GET', url: '/api/evidence/recent' })).json();

  // 100000 + 250000 captured; the uncaptured link contributes nothing.
  assert.equal(body.razorpay.collected_paise, 350000);
  assert.equal(body.razorpay.refunded_paise, 100000);

  // Newest first, and the row with no payment_id is absent.
  assert.equal(body.razorpay.recent.length, 2);
  assert.deepEqual(
    body.razorpay.recent.map((row: any) => row.payment_id),
    ['pay_QxYzTestCapture02', 'pay_QxYzTestCapture01']
  );
  assert.equal(body.razorpay.recent[0].refund_id, null);
  assert.equal(body.razorpay.recent[0].amount_paise, 250000);
  assert.equal(body.razorpay.recent[1].refund_id, 'rfnd_QxYzTestRefund01');
  assert.equal(body.razorpay.recent[1].claim_number, 'CLM-2026-964201');
  assert.equal(body.razorpay.recent[1].refunded_at, '2026-04-14T11:02:00.000Z');

  // Both bundles rehash to the hash stored beside them.
  assert.equal(body.audit_chain.records_checked, 2);
  assert.equal(body.audit_chain.chain_ok, true);
  assert.equal(body.audit_chain.first_bad_seq, null);
  assert.equal(body.audit_chain.head, computeEvidenceHash(SECOND_BUNDLE_JSON as any));

  assert.equal(body.attestation.last_success_tx, CLAIM_ROW.attestation_tx_hash);
  assert.equal(body.attestation.last_success_at, CLAIM_ROW.attested_at);

  // Two real calls and one from FakeLlmProvider. The fake is counted apart,
  // never folded into "a model ran".
  assert.equal(body.adjudication.model_invoked, 2);
  assert.equal(body.adjudication.model_simulated, 1);
  assert.equal(body.adjudication.vetoed_before_model, 3);
  assert.deepEqual(body.adjudication.veto_reasons, {
    policy_not_cancelled: 2,
    claim_not_already_decided: 1,
  });

  await app.close();
});

test('a bundle whose stored hash does not match its JSON is reported by position', async () => {
  const state = populatedState();
  // The second bundle, in creation order. Its JSON is edited and its hash left
  // as it was — exactly the tamper this check exists to catch.
  state.evidence_bundles[1].bundle_json = { ...SECOND_BUNDLE_JSON, filed_at: '2026-05-02T09:99:99.000Z' };

  const app = await buildServer(state);
  const body = (await app.inject({ method: 'GET', url: '/api/evidence/recent' })).json();

  assert.equal(body.audit_chain.records_checked, 2);
  assert.equal(body.audit_chain.chain_ok, false);
  assert.equal(body.audit_chain.first_bad_seq, 2);

  await app.close();
});

// --- No personal data -------------------------------------------------------

/**
 * Column names that carry, or lead to, a person.
 *
 * Asserted against the serialised response rather than against a parsed shape,
 * so a field nested anywhere — inside a spread row, inside a bundle, inside a
 * prompt — is caught. The fixtures above deliberately hold every one of these,
 * so a route that returned whole rows would fail here rather than pass on an
 * empty table.
 */
const PII_COLUMN_NAMES = [
  'full_name',
  'customer_name',
  'customer_id',
  'email',
  'phone',
  'address',
  'date_of_birth',
  'incident_description',
  'notes',
  'assigned_adjuster',
  'transcript',
  'summary',
  'prompt_user',
  'prompt_system',
  'raw_response',
  'bundle_json',
  'payload',
  'webhook_payload',
];

test('the serialised response carries none of the PII column names', async () => {
  const app = await buildServer(populatedState());
  const serialised = (await app.inject({ method: 'GET', url: '/api/evidence/recent' })).body;

  for (const column of PII_COLUMN_NAMES) {
    assert.ok(
      !serialised.includes(column),
      `the response carries the PII column name "${column}"`
    );
  }

  await app.close();
});

test('the serialised response carries none of the PII values either', async () => {
  const app = await buildServer(populatedState());
  const serialised = (await app.inject({ method: 'GET', url: '/api/evidence/recent' })).body;

  const values = [
    ...Object.values(CUSTOMER_FIELDS),
    CLAIM_ROW.incident_description,
    CLAIM_ROW.notes,
    CLAIM_ROW.assigned_adjuster,
  ];
  for (const value of values) {
    assert.ok(!serialised.includes(value), `the response carries the PII value "${value}"`);
  }

  // What it does carry: claim numbers and Razorpay ids.
  assert.ok(serialised.includes('CLM-2026-964201'));
  assert.ok(serialised.includes('pay_QxYzTestCapture01'));
  assert.ok(serialised.includes('rfnd_QxYzTestRefund01'));

  await app.close();
});

// --- Empty tables -----------------------------------------------------------

test('empty tables produce zeros and nulls, never a figure from RESULTS.md', async () => {
  const app = await buildServer(emptyState());
  const response = await app.inject({ method: 'GET', url: '/api/evidence/recent' });
  assert.equal(response.statusCode, 200);
  const body = response.json();

  assert.equal(body.razorpay.collected_paise, 0);
  assert.equal(body.razorpay.refunded_paise, 0);
  assert.deepEqual(body.razorpay.recent, []);

  assert.equal(body.audit_chain.records_checked, 0);
  // Nothing checked and nothing wrong. `head` is null rather than a placeholder
  // hash, so "no bundle has ever been written" cannot read as one that has.
  assert.equal(body.audit_chain.chain_ok, true);
  assert.equal(body.audit_chain.first_bad_seq, null);
  assert.equal(body.audit_chain.head, null);

  assert.equal(body.attestation.network, 'base-sepolia');
  assert.equal(body.attestation.last_success_tx, null);
  assert.equal(body.attestation.last_success_at, null);

  assert.equal(body.adjudication.model_invoked, 0);
  assert.equal(body.adjudication.model_simulated, 0);
  assert.equal(body.adjudication.vetoed_before_model, 0);
  assert.deepEqual(body.adjudication.veto_reasons, {});

  // None of the figures the journey run recorded may appear on an empty
  // database. This is the assertion that fails if anyone ever pastes one in.
  const serialised = response.body;
  for (const literal of ['100000', '350000', 'pay_', 'rfnd_', '0x']) {
    assert.ok(!serialised.includes(literal), `an empty database produced "${literal}"`);
  }

  await app.close();
});

test('a database fault answers 503 rather than an empty but plausible response', async () => {
  const state = populatedState();
  state.errors.deductible_payments = { code: '57014', message: 'statement timeout' };

  const app = await buildServer(state);
  const response = await app.inject({ method: 'GET', url: '/api/evidence/recent' });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, 'Evidence records are temporarily unavailable.');

  await app.close();
});

// --- No secrets -------------------------------------------------------------

test('with no GROQ_API_KEY set, configured is false and no key material appears', async () => {
  assert.equal(process.env.GROQ_API_KEY, '', 'the preamble must clear the key before import');

  const app = await buildServer(populatedState());
  const response = await app.inject({ method: 'GET', url: '/api/evidence/recent' });
  const body = response.json();

  assert.equal(body.adjudication.configured, false);
  // The other two fields stay, so the absence is legible rather than silent.
  assert.equal(body.adjudication.provider, 'groq');
  assert.equal(typeof body.adjudication.model, 'string');
  assert.ok(body.adjudication.model.length > 0);

  // Nothing that could be a key, a length, or a prefix of one.
  const serialised = response.body;
  assert.ok(!serialised.includes('gsk_'));
  assert.ok(!serialised.includes('GROQ_API_KEY'));
  assert.ok(!/"(key|api_key|apiKey|token|secret)"/i.test(serialised));

  await app.close();
});

// --- The API root -----------------------------------------------------------

test('GET / answers 200 with the service, the version and the links', async () => {
  const app = await buildServer(emptyState());
  const response = await app.inject({ method: 'GET', url: '/' });

  assert.equal(response.statusCode, 200);
  const body = response.json();

  assert.equal(body.service, 'safeguard-api');
  assert.equal(body.version.git_sha, BUILD_STAMPED ? BUILD_GIT_SHA : 'unstamped');
  assert.equal(body.version.stamped, BUILD_STAMPED);
  assert.equal(typeof body.version.dirty, 'boolean');
  assert.equal(body.links.health, '/health');
  assert.equal(body.links.evidence, '/api/evidence/recent');

  await app.close();
});

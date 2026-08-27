import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

/**
 * Pinned before the module graph loads: `config` and `features` are both read
 * once at import time, and every one of these decides a branch this file walks
 * through. Empty rather than absent, because dotenv skips a key that is already
 * present in process.env — which is what keeps a developer's real .env, real
 * private key included, out of these tests.
 */
process.env.SIMULATE_BLOCKCHAIN = 'false';
process.env.AGENT_PRIVATE_KEY = '';
process.env.CLAIM_REGISTRY_ADDRESS = '';
process.env.CLAIM_REGISTRY_V2_ADDRESS = '';
process.env.EAS_CONTRACT_ADDRESS = '';
process.env.EAS_SCHEMA = '';
process.env.EAS_SCHEMA_UID = '';
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';

const { runEvidencePipeline } = await import('./evidence-pipeline.js');

// --- Test doubles -----------------------------------------------------------

interface Write {
  table: string;
  row: Record<string, any>;
}

interface FakeState {
  /** Rows a select on each table returns. */
  rows: Record<string, any>;
  /** Faults injected per table, per verb, so a refused write can be modelled. */
  insertErrors: Record<string, { message: string }>;
  inserts: Write[];
  updates: Write[];
}

/**
 * PostgREST stand-in covering only the shapes this pipeline uses: select with
 * eq + single, a bare awaited select, insert, and update + eq. The builder is
 * thenable because the claim_documents read awaits it directly rather than
 * calling a terminator.
 */
function fakeSupabase(state: FakeState) {
  return {
    from(table: string) {
      let verb: 'select' | 'insert' | 'update' = 'select';

      const settle = () => {
        if (verb === 'insert' || verb === 'update') {
          return { data: null, error: state.insertErrors[table] ?? null };
        }
        return { data: state.rows[table] ?? null, error: null };
      };

      const builder: any = {
        select: () => builder,
        eq: () => builder,
        insert(row: Record<string, any>) {
          verb = 'insert';
          state.inserts.push({ table, row });
          return builder;
        },
        update(row: Record<string, any>) {
          verb = 'update';
          state.updates.push({ table, row });
          return builder;
        },
        single: async () => settle(),
        maybeSingle: async () => settle(),
        then: (resolve: any, reject: any) => Promise.resolve(settle()).then(resolve, reject),
      };
      return builder;
    },
  };
}

const CLAIM_ID = '11111111-1111-4111-8111-111111111111';

function state(overrides: Partial<FakeState> = {}): FakeState {
  return {
    rows: {
      claims: {
        id: CLAIM_ID,
        claim_number: 'CLM-2026-000456',
        policy_id: '22222222-2222-4222-8222-222222222222',
        customer_id: '33333333-3333-4333-8333-333333333333',
        claim_type: 'collision',
        incident_date: '2026-08-01',
        incident_description: 'Rear-ended at a red light.',
        documents_received: ['police_report'],
        filed_at: '2026-08-02T10:00:00.000Z',
      },
      policies: { policy_number: 'POL-2024-001234' },
      claim_documents: [],
    },
    insertErrors: {},
    inserts: [],
    updates: [],
    ...overrides,
  };
}

/** A storage client that throws, i.e. the live failure this file is about. */
function throwingSynapse(message: string, name?: string) {
  return {
    storage: {
      upload: async () => {
        const err = new Error(message);
        if (name) err.name = name;
        throw err;
      },
    },
  } as any;
}

/** A storage client that stores the piece, optionally losing a copy on the way. */
function storingSynapse(partialFailures: { providerId: string; role: string; error: string }[] = []) {
  return {
    storage: {
      upload: async () => ({
        pieceCid: { toString: () => 'bafkreitestpiececid' },
        size: 42,
        copies: [{ role: 'primary', dataSetId: 312, retrievalUrl: 'https://sp.example/piece' }],
        failures: partialFailures,
      }),
    },
  } as any;
}

function fakeFastify(
  s: FakeState,
  filecoin: { synapse: any; unavailableReason: string | null }
): FastifyInstance {
  return {
    supabase: fakeSupabase(s),
    filecoin: { publicClient: {}, ...filecoin },
    // No wallet and no registry, so attestation is skipped and every assertion
    // below is about archival alone.
    ethereum: { publicClient: {}, walletClient: null, account: null },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as FastifyInstance;
}

function uploadRow(s: FakeState) {
  return s.inserts.find((w) => w.table === 'filecoin_uploads')?.row;
}

// --- The reason is kept -----------------------------------------------------

test('a failed upload records why it failed', async () => {
  // The defect: this row said 'failed' and nothing else, so a subsystem that
  // has never once succeeded left behind no evidence of what stopped it.
  const s = state();
  const fastify = fakeFastify(
    s,
    { synapse: throwingSynapse('execution reverted: InsufficientLockupFunds()', 'ContractFunctionExecutionError'), unavailableReason: null }
  );

  const result = await runEvidencePipeline(fastify, { claimId: CLAIM_ID });

  const row = uploadRow(s);
  assert.equal(row?.upload_status, 'failed');
  assert.match(row?.error, /InsufficientLockupFunds/);
  assert.match(row?.error, /ContractFunctionExecutionError/);
  // And nothing was invented to stand in for the bytes that were never stored.
  assert.equal(row?.piece_cid, null);
  assert.equal(row?.dataset_id, null);
  assert.match(result!.warnings.join(' '), /InsufficientLockupFunds/);
});

test('a disabled uploader records the plugin reason, not a guess about the key', async () => {
  const s = state();
  const fastify = fakeFastify(s, {
    synapse: null,
    unavailableReason: 'Synapse.create threw: unsupported chain id',
  });

  await runEvidencePipeline(fastify, { claimId: CLAIM_ID });

  assert.match(uploadRow(s)?.error, /unsupported chain id/);
  assert.doesNotMatch(uploadRow(s)?.error, /AGENT_PRIVATE_KEY/);
});

test('a clean success records no error at all', async () => {
  const s = state();
  const fastify = fakeFastify(s, { synapse: storingSynapse(), unavailableReason: null });

  await runEvidencePipeline(fastify, { claimId: CLAIM_ID });

  const row = uploadRow(s);
  assert.equal(row?.upload_status, 'completed');
  assert.equal(row?.error, null);
  assert.equal(row?.piece_cid, 'bafkreitestpiececid');
});

test('a piece stored with fewer copies says so, and does not read as a loss', async () => {
  // Partial copy failures were as invisible as total ones. They are recorded in
  // the same column, but the text leads with the fact the piece exists, so a
  // reader scanning for lost bundles cannot mistake one for the other.
  const s = state();
  const fastify = fakeFastify(s, {
    synapse: storingSynapse([{ providerId: 'f01234', role: 'secondary', error: 'sector sealing timeout' }]),
    unavailableReason: null,
  });

  await runEvidencePipeline(fastify, { claimId: CLAIM_ID });

  const row = uploadRow(s);
  assert.equal(row?.upload_status, 'completed');
  assert.match(row?.error, /^stored with fewer copies/);
  assert.match(row?.error, /sector sealing timeout/);
});

test('the recorded reason is never a blank string', async () => {
  // 0022 rejects '' at the database, so producing one here would turn a failed
  // upload into a failed insert — swapping one invisible fault for another.
  const s = state();
  const fastify = fakeFastify(s, { synapse: throwingSynapse(''), unavailableReason: null });

  await runEvidencePipeline(fastify, { claimId: CLAIM_ID });

  assert.ok(String(uploadRow(s)?.error ?? '').trim().length > 0);
});

// --- The write itself can fail ----------------------------------------------

test('a refused filecoin_uploads insert is reported rather than swallowed', async () => {
  // Exactly what happens on a deploy that ships this code before 0022 is
  // applied: PostgREST rejects the whole row over the unknown column, archival
  // attempts stop being recorded, and /health reads a frozen row forever.
  const s = state({
    insertErrors: {
      filecoin_uploads: { message: `column "error" of relation "filecoin_uploads" does not exist` },
    },
  });
  const fastify = fakeFastify(s, { synapse: storingSynapse(), unavailableReason: null });

  const result = await runEvidencePipeline(fastify, { claimId: CLAIM_ID });

  assert.match(result!.warnings.join(' '), /filecoin_uploads: column "error"/);
});

test('a refused archival row does not cost the claim its evidence hash', async () => {
  // The pipeline's standing rule: every step degrades on its own. A bookkeeping
  // failure must not take the tamper-evidence primitive down with it.
  const s = state({ insertErrors: { filecoin_uploads: { message: 'permission denied' } } });
  const fastify = fakeFastify(s, { synapse: storingSynapse(), unavailableReason: null });

  const result = await runEvidencePipeline(fastify, { claimId: CLAIM_ID });

  assert.match(result!.evidenceHash, /^0x[0-9a-f]{64}$/);
  const claimUpdate = s.updates.find((w) => w.table === 'claims')?.row;
  assert.equal(claimUpdate?.evidence_hash, result!.evidenceHash);
});

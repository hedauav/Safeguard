import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  readObservations,
  readWallet,
  unknownObservations,
  unknownWallet,
  type BalanceReader,
} from './health-observations.js';

// --- Test doubles -----------------------------------------------------------

interface FakeState {
  filecoin_uploads: Record<string, any>[];
  claims: Record<string, any>[];
  /** Injected faults, so a real outage can be told apart from an empty table. */
  errors: Partial<Record<'filecoin_uploads' | 'claims', any>>;
}

/**
 * Minimal PostgREST stand-in covering only the shapes readObservations uses:
 * select + eq/in/not filters + order + limit + maybeSingle.
 */
function fakeSupabase(state: FakeState) {
  return {
    from(table: 'filecoin_uploads' | 'claims') {
      const filters: ((row: any) => boolean)[] = [];
      let ordering: { column: string; ascending: boolean } | null = null;
      let take = Infinity;

      const builder: any = {
        select: () => builder,
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
          return builder;
        },
        in(column: string, values: unknown[]) {
          filters.push((row) => values.includes(row[column]));
          return builder;
        },
        not(column: string, operator: string, value: unknown) {
          if (operator === 'is' && value === null) {
            filters.push((row) => row[column] !== null && row[column] !== undefined);
          }
          return builder;
        },
        order(column: string, opts?: { ascending?: boolean }) {
          ordering = { column, ascending: opts?.ascending !== false };
          return builder;
        },
        limit(n: number) {
          take = n;
          return builder;
        },
        async maybeSingle() {
          const error = state.errors[table];
          if (error) return { data: null, error };
          let rows = state[table].filter((row) => filters.every((f) => f(row)));
          if (ordering) {
            const { column, ascending } = ordering;
            rows = rows.slice().sort((a, b) => {
              const left = String(a[column] ?? '');
              const right = String(b[column] ?? '');
              return (left < right ? -1 : left > right ? 1 : 0) * (ascending ? 1 : -1);
            });
          }
          return { data: rows.slice(0, take)[0] ?? null, error: null };
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const EMPTY: FakeState = { filecoin_uploads: [], claims: [], errors: {} };

function state(overrides: Partial<FakeState> = {}): FakeState {
  return { ...EMPTY, filecoin_uploads: [], claims: [], errors: {}, ...overrides };
}

// --- The production incident ------------------------------------------------

test('a failed upload reports failed, and attestation as skipped rather than green', async () => {
  // The exact shape of the live incident: the flags said filecoin_uploads=true
  // and chain_attestation=true over a claim whose upload had just failed and
  // which was never put on chain.
  const observed = await readObservations(
    fakeSupabase(
      state({
        filecoin_uploads: [
          {
            claim_id: 'claim-1',
            upload_status: 'failed',
            attempted_at: '2026-08-25T07:45:30Z',
            completed_at: null,
            simulated: false,
          },
        ],
        claims: [
          {
            id: 'claim-1',
            attestation_tx_hash: null,
            attested_at: null,
            evidence_hash: '0xabc',
            simulated: false,
          },
        ],
      })
    )
  );

  assert.equal(observed.filecoin_uploads.last_attempt, 'failed');
  assert.equal(observed.filecoin_uploads.last_attempt_at, '2026-08-25T07:45:30Z');
  assert.equal(observed.filecoin_uploads.last_success_at, null);

  assert.equal(observed.chain_attestation.last_attempt, 'skipped');
  assert.match(observed.chain_attestation.reason!, /no attestation transaction was recorded/);
  assert.equal(observed.chain_attestation.last_success_tx, null);
  assert.equal(observed.source, 'database');
});

test('a failed upload that was still anchored on chain reports attestation as succeeded', async () => {
  // A v2 registry anchors the evidence hash with an empty locator, so archival
  // failing no longer means nothing reached the chain. A recorded transaction
  // outranks the upload outcome.
  const observed = await readObservations(
    fakeSupabase(
      state({
        filecoin_uploads: [
          {
            claim_id: 'claim-1',
            upload_status: 'failed',
            attempted_at: '2026-08-25T07:45:30Z',
            completed_at: null,
            simulated: false,
          },
        ],
        claims: [
          {
            id: 'claim-1',
            attestation_tx_hash: '0xanchored',
            attested_at: '2026-08-25T07:45:44Z',
            evidence_hash: '0xabc',
            simulated: false,
          },
        ],
      })
    )
  );

  assert.equal(observed.filecoin_uploads.last_attempt, 'failed');
  assert.equal(observed.chain_attestation.last_attempt, 'succeeded');
  assert.equal(observed.chain_attestation.last_success_tx, '0xanchored');
});

test('a completed upload with a real transaction reports both as succeeded', async () => {
  const observed = await readObservations(
    fakeSupabase(
      state({
        filecoin_uploads: [
          {
            claim_id: 'claim-1',
            upload_status: 'completed',
            attempted_at: '2026-08-25T07:45:30Z',
            completed_at: '2026-08-25T07:45:41Z',
            simulated: false,
          },
        ],
        claims: [
          {
            id: 'claim-1',
            attestation_tx_hash: '0xdeadbeef',
            attested_at: '2026-08-25T07:45:55Z',
            evidence_hash: '0xabc',
            simulated: false,
          },
        ],
      })
    )
  );

  assert.equal(observed.filecoin_uploads.last_attempt, 'succeeded');
  assert.equal(observed.filecoin_uploads.last_success_at, '2026-08-25T07:45:41Z');
  assert.equal(observed.filecoin_uploads.reason, null);
  assert.equal(observed.chain_attestation.last_attempt, 'succeeded');
  assert.equal(observed.chain_attestation.last_success_tx, '0xdeadbeef');
  assert.equal(observed.chain_attestation.last_attempt_at, '2026-08-25T07:45:55Z');
});

test('simulated archival is labelled simulated, never succeeded', async () => {
  const observed = await readObservations(
    fakeSupabase(
      state({
        filecoin_uploads: [
          {
            claim_id: 'claim-1',
            upload_status: 'simulated',
            attempted_at: '2026-08-25T07:45:30Z',
            completed_at: '2026-08-25T07:45:31Z',
            simulated: true,
          },
        ],
        claims: [
          {
            id: 'claim-1',
            attestation_tx_hash: '0xnotarealtx',
            attested_at: '2026-08-25T07:45:32Z',
            evidence_hash: '0xabc',
            simulated: true,
          },
        ],
      })
    )
  );

  assert.equal(observed.filecoin_uploads.last_attempt, 'simulated');
  assert.equal(observed.chain_attestation.last_attempt, 'simulated');
  // A simulated run is not a success, so it must not fill in last_success_*.
  assert.equal(observed.filecoin_uploads.last_success_at, null);
  assert.equal(observed.chain_attestation.last_success_at, null);
  assert.equal(observed.chain_attestation.last_success_tx, null);
});

test('a stored bundle carrying no transaction reports attestation failed', async () => {
  const observed = await readObservations(
    fakeSupabase(
      state({
        filecoin_uploads: [
          {
            claim_id: 'claim-1',
            upload_status: 'completed',
            attempted_at: '2026-08-25T07:45:30Z',
            completed_at: '2026-08-25T07:45:41Z',
            simulated: false,
          },
        ],
        claims: [
          {
            id: 'claim-1',
            attestation_tx_hash: null,
            attested_at: null,
            evidence_hash: '0xabc',
            simulated: false,
          },
        ],
      })
    )
  );

  assert.equal(observed.filecoin_uploads.last_attempt, 'succeeded');
  assert.equal(observed.chain_attestation.last_attempt, 'failed');
  assert.match(observed.chain_attestation.reason!, /no attestation transaction/);
});

test('an empty database reports never, which is not the same as unknown or ok', async () => {
  const observed = await readObservations(fakeSupabase(state()));

  assert.equal(observed.filecoin_uploads.last_attempt, 'never');
  assert.equal(observed.filecoin_uploads.last_attempt_at, null);
  assert.equal(observed.chain_attestation.last_attempt, 'never');
  assert.equal(observed.source, 'database');
  assert.equal(observed.error, null);
});

test('a later failure does not erase when the capability last genuinely worked', async () => {
  const observed = await readObservations(
    fakeSupabase(
      state({
        filecoin_uploads: [
          {
            claim_id: 'claim-old',
            upload_status: 'completed',
            attempted_at: '2026-08-20T11:00:00Z',
            completed_at: '2026-08-20T11:02:00Z',
            simulated: false,
          },
          {
            claim_id: 'claim-new',
            upload_status: 'failed',
            attempted_at: '2026-08-25T07:45:30Z',
            completed_at: null,
            simulated: false,
          },
        ],
        claims: [
          {
            id: 'claim-old',
            attestation_tx_hash: '0xold',
            attested_at: '2026-08-20T11:03:00Z',
            evidence_hash: '0x1',
            simulated: false,
          },
          {
            id: 'claim-new',
            attestation_tx_hash: null,
            attested_at: null,
            evidence_hash: '0x2',
            simulated: false,
          },
        ],
      })
    )
  );

  assert.equal(observed.filecoin_uploads.last_attempt, 'failed');
  assert.equal(observed.filecoin_uploads.last_attempt_at, '2026-08-25T07:45:30Z');
  assert.equal(observed.filecoin_uploads.last_success_at, '2026-08-20T11:02:00Z');
  assert.equal(observed.chain_attestation.last_attempt, 'skipped');
  assert.equal(observed.chain_attestation.last_success_at, '2026-08-20T11:03:00Z');
  assert.equal(observed.chain_attestation.last_success_tx, '0xold');
});

test('an in-progress upload is reported as unknown, not rounded up to success', async () => {
  const observed = await readObservations(
    fakeSupabase(
      state({
        filecoin_uploads: [
          {
            claim_id: 'claim-1',
            upload_status: 'uploading',
            attempted_at: '2026-08-25T07:45:30Z',
            completed_at: null,
            simulated: false,
          },
        ],
        claims: [],
      })
    )
  );

  assert.equal(observed.filecoin_uploads.last_attempt, 'unknown');
  assert.match(observed.filecoin_uploads.reason!, /uploading/);
});

// --- The database-unavailable path -----------------------------------------

test('a database error is raised so the caller can answer 200 with unknown', async () => {
  await assert.rejects(
    () => readObservations(fakeSupabase(state({ errors: { filecoin_uploads: { message: 'timeout' } } }))),
    /timeout/
  );
});

test('an error on the per-claim lookup is raised too, not silently treated as absent', async () => {
  await assert.rejects(
    () =>
      readObservations(
        fakeSupabase(
          state({
            filecoin_uploads: [
              {
                claim_id: 'claim-1',
                upload_status: 'completed',
                attempted_at: '2026-08-25T07:45:30Z',
                completed_at: '2026-08-25T07:45:41Z',
                simulated: false,
              },
            ],
            errors: { claims: { message: 'connection reset' } },
          })
        )
      ),
    /connection reset/
  );
});

test('the unavailable snapshot says unknown everywhere and never claims success', async () => {
  const observed = unknownObservations('timeout after 2000ms');

  assert.equal(observed.source, 'unavailable');
  assert.equal(observed.error, 'timeout after 2000ms');
  for (const capability of [observed.filecoin_uploads, observed.chain_attestation]) {
    assert.equal(capability.last_attempt, 'unknown');
    assert.equal(capability.last_attempt_at, null);
    assert.equal(capability.last_success_at, null);
    assert.equal(capability.reason, 'timeout after 2000ms');
  }
  assert.equal(observed.chain_attestation.last_success_tx, null);
});

// --- Wallet -----------------------------------------------------------------

const balanceReader = (balance: bigint | Error): BalanceReader => ({
  async getBalance() {
    if (balance instanceof Error) throw balance;
    return balance;
  },
});

test('a funded wallet reports its balance in ETH', async () => {
  const observed = await readWallet(
    balanceReader(1_500_000_000_000_000n),
    '0xAgent',
    'base-sepolia'
  );

  assert.equal(observed.balance_status, 'funded');
  assert.equal(observed.balance_eth, '0.0015');
  assert.equal(observed.address, '0xAgent');
  assert.equal(observed.network, 'base-sepolia');
  assert.equal(observed.reason, null);
});

test('a drained wallet is called out explicitly rather than shown as a bare zero', async () => {
  const observed = await readWallet(balanceReader(0n), '0xAgent', 'base-sepolia');

  assert.equal(observed.balance_status, 'empty');
  assert.equal(observed.balance_eth, '0');
  assert.match(observed.reason!, /no funds/);
});

test('no configured wallet is not-configured, which is distinct from empty', async () => {
  const observed = await readWallet(balanceReader(0n), null, 'base-sepolia');

  assert.equal(observed.balance_status, 'not-configured');
  assert.equal(observed.balance_eth, null);
  assert.equal(observed.address, null);
});

test('an RPC failure is raised so the caller can degrade to unknown', async () => {
  await assert.rejects(
    () => readWallet(balanceReader(new Error('rpc down')), '0xAgent', 'base-sepolia'),
    /rpc down/
  );
});

test('the unknown wallet keeps the address but refuses to guess a balance', async () => {
  const observed = unknownWallet('0xAgent', 'base-sepolia', 'rpc down');

  assert.equal(observed.balance_status, 'unknown');
  assert.equal(observed.balance_eth, null);
  assert.equal(observed.address, '0xAgent');
  assert.equal(observed.reason, 'rpc down');
});

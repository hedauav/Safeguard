import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'viem';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MAX_DOCUMENT_BYTES,
  attachClaimDocument,
  documentEvidenceEntries,
  verifyClaimDocument,
  type DocumentAccepted,
  type DocumentArchiver,
  type DocumentRejected,
  type DocumentRejectionReason,
  type DocumentUploadResult,
} from './claim-documents-service.js';
import { buildEvidenceBundle } from './attestation-service.js';
import type { FilecoinUploadResult } from './filecoin-service.js';

// --- Test doubles -----------------------------------------------------------

interface FakeState {
  claims: Record<string, any>[];
  claim_documents: Record<string, any>[];
  /** Injected faults, so a genuine outage can be told apart from "not found". */
  claimLookupError: any;
  documentLookupError: any;
  insertError: any;
  /**
   * Makes the duplicate check see nothing even when a row exists, which is the
   * only way to reach the unique index the way a real race would.
   */
  hideExistingDocuments: boolean;
}

// PostgREST's "no rows" code. Anything else is a real fault.
const NOT_FOUND = { code: 'PGRST116', message: 'no rows' };
const UNIQUE_VIOLATION = { code: '23505', message: 'duplicate key value violates unique constraint' };

/**
 * Minimal PostgREST stand-in covering only the shapes the service uses:
 * chained `.eq()` filters terminated by `maybeSingle()`, an un-terminated
 * query awaited for a list, and `.insert().select().single()`. Rows are
 * mutated in place so a second call sees what the first one wrote, and the
 * unique (claim_id, content_hash) index is enforced on insert.
 */
function fakeSupabase(state: FakeState) {
  return {
    from(table: string) {
      const rows: Record<string, any>[] = (state as any)[table];
      const error = table === 'claims' ? state.claimLookupError : state.documentLookupError;
      const hidden = table === 'claim_documents' && state.hideExistingDocuments;

      const matching = (filters: Array<[string, unknown]>) =>
        hidden ? [] : rows.filter((row) => filters.every(([column, value]) => row[column] === value));

      function query(filters: Array<[string, unknown]>): any {
        return {
          eq(column: string, value: unknown) {
            return query([...filters, [column, value]]);
          },
          async maybeSingle() {
            if (error) return { data: null, error };
            return { data: matching(filters)[0] ?? null, error: null };
          },
          // PostgREST builders are thenable, so an un-terminated query awaits
          // straight to a list.
          then(resolve: (value: any) => unknown, reject?: (reason: any) => unknown) {
            const payload = error ? { data: null, error } : { data: matching(filters), error: null };
            return Promise.resolve(payload).then(resolve, reject);
          },
        };
      }

      return {
        select() {
          return query([]);
        },
        insert(row: Record<string, unknown>) {
          return {
            select() {
              return {
                async single() {
                  if (state.insertError) return { data: null, error: state.insertError };
                  const clash = rows.some(
                    (r) => r.claim_id === row.claim_id && r.content_hash === row.content_hash
                  );
                  if (clash) return { data: null, error: UNIQUE_VIOLATION };
                  const inserted = { id: `doc-${rows.length + 1}`, ...row };
                  rows.push(inserted);
                  return { data: inserted, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

const CLAIM_ID = 'claim-1';
const CLAIM_NUMBER = 'CLM-2026-000321';
const OTHER_CLAIM_ID = 'claim-2';
const OTHER_CLAIM_NUMBER = 'CLM-2026-000999';

function state(overrides: { claim?: Record<string, any> } = {}): FakeState {
  return {
    claims: [
      {
        id: CLAIM_ID,
        claim_number: CLAIM_NUMBER,
        documents_required: ['police_report', 'repair_estimate', 'photos'],
        documents_received: [],
        ...overrides.claim,
      },
      {
        id: OTHER_CLAIM_ID,
        claim_number: OTHER_CLAIM_NUMBER,
        documents_required: ['photos'],
        documents_received: [],
      },
    ],
    claim_documents: [],
    claimLookupError: null,
    documentLookupError: null,
    insertError: null,
    hideExistingDocuments: false,
  };
}

// --- Archivers --------------------------------------------------------------
// No network anywhere: each one returns a fixed discriminated result and
// records what it was handed.

function recordingArchiver(outcome: (bytes: Uint8Array) => FilecoinUploadResult) {
  const seen: Uint8Array[] = [];
  const archive: DocumentArchiver = async (bytes) => {
    seen.push(bytes);
    return outcome(bytes);
  };
  return Object.assign(archive, { seen });
}

const storedArchiver = () =>
  recordingArchiver((bytes) => ({
    ok: true,
    simulated: false,
    pieceCid: 'bafkreirealpiececid',
    size: bytes.byteLength,
    datasetId: '42',
    retrievalUrl: null,
    partialFailures: [],
  }));

const simulatedArchiver = () =>
  recordingArchiver((bytes) => ({
    ok: true,
    simulated: true,
    pieceCid: 'bafkreisimulatedcid',
    size: bytes.byteLength,
    datasetId: null,
    retrievalUrl: null,
    partialFailures: [],
  }));

const failingArchiver = () =>
  recordingArchiver(() => ({
    ok: false,
    disabled: false,
    error: 'InsufficientLockupFunds: no USDFC payment rail funded',
  }));

// --- Fixtures ---------------------------------------------------------------

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
/** The same file with one byte changed — the tampering case. */
const ALTERED_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 5]);

function upload(overrides: Record<string, any> = {}) {
  return {
    claimNumber: CLAIM_NUMBER,
    documentType: 'photos',
    filename: 'damage.png',
    mimeType: 'image/png',
    bytes: PNG,
    ...overrides,
  };
}

function attach(
  fixture: FakeState,
  archive: DocumentArchiver = storedArchiver(),
  overrides: Record<string, any> = {}
): Promise<DocumentUploadResult> {
  return attachClaimDocument(fakeSupabase(fixture) as unknown as SupabaseClient, archive, upload(overrides));
}

/** Every rejection must be inert: a reason to branch on, and nothing recorded. */
function assertRejected(
  result: DocumentUploadResult,
  reason: DocumentRejectionReason
): asserts result is DocumentRejected {
  assert.equal(result.success, false, `expected a rejection, got ${JSON.stringify(result)}`);
  assert.equal(result.reason, reason);
  assert.equal(result.document_id, null);
  assert.equal(result.cid, null, 'no rejection path may hand back a storage location');
}

function assertAccepted(result: DocumentUploadResult): asserts result is DocumentAccepted {
  assert.equal(result.success, true, `expected acceptance, got ${JSON.stringify(result)}`);
}

// --- Happy path -------------------------------------------------------------

test('the hash is keccak256 of the bytes actually received', async () => {
  const fixture = state();
  const archive = storedArchiver();
  const result = await attach(fixture, archive);

  assertAccepted(result);
  assert.equal(result.content_hash, keccak256(PNG), 'the anchor must be the bytes, nothing else');
  assert.match(result.content_hash, /^0x[0-9a-f]{64}$/);
  assert.equal(result.size_bytes, PNG.byteLength);
  assert.equal(result.mime_type, 'image/png');
  assert.equal(result.document_type, 'photos');
  assert.equal(result.storage_status, 'stored');
  assert.equal(result.cid, 'bafkreirealpiececid');
  assert.equal(result.simulated, false);

  // The archiver was handed the same bytes that were hashed.
  assert.equal(archive.seen.length, 1);
  assert.deepEqual(archive.seen[0], PNG);

  const row = fixture.claim_documents[0];
  assert.equal(row.claim_id, CLAIM_ID);
  assert.equal(row.content_hash, keccak256(PNG));
  assert.equal(row.cid, 'bafkreirealpiececid');
  assert.equal(row.storage_status, 'stored');
  assert.equal(row.simulated, false);
});

test('one flipped byte produces a different hash', async () => {
  const first = await attach(state());
  const second = await attach(state(), storedArchiver(), { bytes: ALTERED_PNG });

  assertAccepted(first);
  assertAccepted(second);
  assert.notEqual(first.content_hash, second.content_hash);
});

test('a claim number spoken without dashes still attaches', async () => {
  const result = await attach(state(), storedArchiver(), { claimNumber: 'clm2026000321' });
  assertAccepted(result);
  assert.equal(result.claim_number, CLAIM_NUMBER);
});

test('a content type carrying parameters is still recognised', async () => {
  const result = await attach(state(), storedArchiver(), {
    mimeType: 'application/pdf; charset=binary',
    documentType: 'police_report',
  });
  assertAccepted(result);
  assert.equal(result.mime_type, 'application/pdf');
});

// --- Gate: size -------------------------------------------------------------

test('refuses a file over the 10 MB ceiling before touching archival', async () => {
  const fixture = state();
  const archive = storedArchiver();
  const oversize = new Uint8Array(MAX_DOCUMENT_BYTES + 1);

  assertRejected(await attach(fixture, archive, { bytes: oversize }), 'file_too_large');
  assert.equal(archive.seen.length, 0, 'nothing may reach archival');
  assert.equal(fixture.claim_documents.length, 0, 'nothing may be recorded');
});

test('a file at exactly the ceiling is accepted', async () => {
  const atLimit = new Uint8Array(MAX_DOCUMENT_BYTES);
  atLimit[0] = 0x89;
  assertAccepted(await attach(state(), storedArchiver(), { bytes: atLimit }));
});

test('refuses a stream the transport truncated, whatever its length', async () => {
  // A cut-off stream hashes to something that is not the claimant's file, so
  // recording it would anchor the wrong bytes.
  const fixture = state();
  assertRejected(await attach(fixture, storedArchiver(), { truncated: true }), 'file_too_large');
  assert.equal(fixture.claim_documents.length, 0);
});

// --- Gate: media type -------------------------------------------------------

for (const mimeType of ['image/gif', 'application/zip', 'text/html', 'application/octet-stream', '']) {
  test(`refuses ${mimeType || 'an absent content type'}`, async () => {
    const fixture = state();
    const archive = storedArchiver();
    assertRejected(await attach(fixture, archive, { mimeType }), 'unsupported_media_type');
    assert.equal(archive.seen.length, 0);
    assert.equal(fixture.claim_documents.length, 0);
  });
}

// --- Gate: the request must describe a document -----------------------------

test('refuses an upload with no document type', async () => {
  assertRejected(await attach(state(), storedArchiver(), { documentType: '  ' }), 'missing_document_type');
});

test('refuses an empty upload', async () => {
  assertRejected(await attach(state(), storedArchiver(), { bytes: new Uint8Array() }), 'missing_file');
});

// --- Gate: the claim -------------------------------------------------------

test('refuses when the claim does not exist', async () => {
  const fixture = state();
  fixture.claims = [];
  fixture.claimLookupError = NOT_FOUND;

  const archive = storedArchiver();
  assertRejected(await attach(fixture, archive), 'claim_not_found');
  assert.equal(archive.seen.length, 0);
});

test('a database fault refuses as unavailable, not as a missing claim', async () => {
  const fixture = state();
  fixture.claimLookupError = { code: '08006', message: 'connection failure' };
  assertRejected(await attach(fixture), 'records_unavailable');
});

// --- Gate: the claim must want this document --------------------------------

test('refuses a document type the claim does not ask for', async () => {
  const fixture = state();
  const archive = storedArchiver();
  const result = await attach(fixture, archive, { documentType: 'medical_records' });

  assertRejected(result, 'document_type_not_required');
  assert.equal(result.claim_number, CLAIM_NUMBER);
  assert.match(result.message, /police report/);
  assert.equal(archive.seen.length, 0, 'unrequested evidence must never be archived');
  assert.equal(fixture.claim_documents.length, 0);
});

test('a claim with no requirements accepts nothing', async () => {
  const fixture = state({ claim: { documents_required: [] } });
  assertRejected(await attach(fixture), 'document_type_not_required');
});

// --- Gate: duplicates -------------------------------------------------------

test('refuses the same bytes twice on the same claim', async () => {
  const fixture = state();
  assertAccepted(await attach(fixture, storedArchiver()));

  const archive = storedArchiver();
  const second = await attach(fixture, archive);

  assertRejected(second, 'duplicate_document');
  assert.equal(second.content_hash, keccak256(PNG), 'the hash is known, so it is reported');
  assert.equal(archive.seen.length, 0, 'a known duplicate is not archived a second time');
  assert.equal(fixture.claim_documents.length, 1);
});

test('the unique index catches a duplicate the check raced past', async () => {
  const fixture = state();
  assertAccepted(await attach(fixture, storedArchiver()));

  // Both requests read an empty table, then both try to write.
  fixture.hideExistingDocuments = true;
  assertRejected(await attach(fixture, storedArchiver()), 'duplicate_document');
  assert.equal(fixture.claim_documents.length, 1, 'the second write must not land');
});

test('the same file on a different claim is not a duplicate', async () => {
  const fixture = state();
  assertAccepted(await attach(fixture, storedArchiver()));
  assertAccepted(await attach(fixture, storedArchiver(), { claimNumber: OTHER_CLAIM_NUMBER }));
  assert.equal(fixture.claim_documents.length, 2);
});

// --- Archival failures are recorded honestly --------------------------------

test('an archival failure is recorded as unarchived, never as stored', async () => {
  const fixture = state();
  const result = await attach(fixture, failingArchiver());

  // The upload still succeeds: the hash is what makes the file tamper-evident,
  // and losing it because Filecoin is down would be the worse outcome.
  assertAccepted(result);
  assert.equal(result.content_hash, keccak256(PNG));
  assert.equal(result.storage_status, 'unarchived');
  assert.equal(result.cid, null, 'a file that was never stored must not carry a CID');
  assert.equal(result.simulated, false, 'a failure is not a simulation');
  assert.match(result.warnings.join(' '), /InsufficientLockupFunds/);

  const row = fixture.claim_documents[0];
  assert.equal(row.storage_status, 'unarchived');
  assert.equal(row.cid, null);
  assert.equal(row.content_hash, keccak256(PNG));
});

test('simulated archival is flagged rather than presented as storage', async () => {
  const fixture = state();
  const result = await attach(fixture, simulatedArchiver());

  assertAccepted(result);
  assert.equal(result.storage_status, 'simulated');
  assert.equal(result.simulated, true);
  assert.equal(fixture.claim_documents[0].simulated, true);
});

test('a document row that cannot be written is not reported as recorded', async () => {
  const fixture = state();
  fixture.insertError = { code: '57014', message: 'statement timeout' };
  assertRejected(await attach(fixture, storedArchiver()), 'not_recorded');
  assert.equal(fixture.claim_documents.length, 0);
});

// --- Verification -----------------------------------------------------------

async function attachThenVerify(bytes: Uint8Array, fixture = state()) {
  const attached = await attach(fixture, storedArchiver());
  assertAccepted(attached);
  const verification = await verifyClaimDocument(fakeSupabase(fixture) as unknown as SupabaseClient, {
    claimNumber: CLAIM_NUMBER,
    documentId: attached.document_id,
    bytes,
  });
  return { attached, verification };
}

test('verifying the original file reports a match', async () => {
  const { attached, verification } = await attachThenVerify(PNG);

  assert.equal(verification.match, true);
  assert.equal(verification.reason, 'match');
  assert.equal(verification.computed_hash, attached.content_hash);
  assert.equal(verification.stored_hash, attached.content_hash);
  assert.equal(verification.document_type, 'photos');
  assert.equal(verification.cid, 'bafkreirealpiececid');
});

test('verifying an altered file reports a mismatch and both hashes', async () => {
  const { attached, verification } = await attachThenVerify(ALTERED_PNG);

  assert.equal(verification.match, false);
  assert.equal(verification.reason, 'hash_mismatch');
  assert.equal(verification.computed_hash, keccak256(ALTERED_PNG));
  assert.equal(verification.stored_hash, attached.content_hash);
  assert.notEqual(verification.computed_hash, verification.stored_hash);
  assert.match(verification.message, /altered|replaced/i);
});

test('verification needs a file to compare against', async () => {
  const fixture = state();
  const verification = await verifyClaimDocument(fakeSupabase(fixture) as unknown as SupabaseClient, {
    claimNumber: CLAIM_NUMBER,
    documentId: 'doc-1',
    bytes: new Uint8Array(),
  });
  assert.equal(verification.match, false);
  assert.equal(verification.reason, 'missing_file');
  assert.equal(verification.computed_hash, null);
});

test('a document id from another claim cannot be verified against this one', async () => {
  const fixture = state();
  const attached = await attach(fixture, storedArchiver(), { claimNumber: OTHER_CLAIM_NUMBER });
  assertAccepted(attached);

  const verification = await verifyClaimDocument(fakeSupabase(fixture) as unknown as SupabaseClient, {
    claimNumber: CLAIM_NUMBER,
    documentId: attached.document_id,
    bytes: PNG,
  });

  assert.equal(verification.match, false);
  assert.equal(verification.reason, 'document_not_found');
  assert.equal(verification.stored_hash, null);
});

test('verifying against an unknown claim reports the claim, not a mismatch', async () => {
  const fixture = state();
  fixture.claims = [];
  fixture.claimLookupError = NOT_FOUND;

  const verification = await verifyClaimDocument(fakeSupabase(fixture) as unknown as SupabaseClient, {
    claimNumber: CLAIM_NUMBER,
    documentId: 'doc-1',
    bytes: PNG,
  });
  assert.equal(verification.reason, 'claim_not_found');
});

// --- The bundle commits to the documents ------------------------------------

test('document hashes are ordered by hash, so row order cannot change the bundle', () => {
  const a = { document_type: 'photos', content_hash: '0xaa' };
  const b = { document_type: 'police_report', content_hash: '0xbb' };
  assert.deepEqual(documentEvidenceEntries([b, a]), documentEvidenceEntries([a, b]));
});

test('folding a document into the bundle changes the anchored hash', () => {
  const base = {
    claim_id: CLAIM_ID,
    claim_number: CLAIM_NUMBER,
    documents: ['photos'],
  };

  const without = buildEvidenceBundle(base).hash;
  const withDocument = buildEvidenceBundle({
    ...base,
    document_hashes: documentEvidenceEntries([
      { document_type: 'photos', content_hash: keccak256(PNG) },
    ]),
  }).hash;
  const withAltered = buildEvidenceBundle({
    ...base,
    document_hashes: documentEvidenceEntries([
      { document_type: 'photos', content_hash: keccak256(ALTERED_PNG) },
    ]),
  }).hash;

  assert.notEqual(withDocument, without, 'the bundle must cover the document');
  assert.notEqual(
    withAltered,
    withDocument,
    'altering one byte of a document must change the hash that goes on chain'
  );
});

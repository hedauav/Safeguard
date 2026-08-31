import { SupabaseClient } from '@supabase/supabase-js';
import { computeContentHash } from './attestation-service.js';
import { isNotFound } from './lookup-result.js';
import { referenceCandidates } from './reference-number.js';
import { extractPdfText } from './pdf-text.js';
import type { FilecoinUploadResult } from './filecoin-service.js';

/**
 * Tamper-evident claim documents.
 *
 * A claimant's proof — a photo of the damage, a repair invoice, a police
 * report — is only evidence if a later copy can be checked against what was
 * actually received. So the bytes are hashed here, before anything else is
 * attempted, and that hash is recorded whatever happens next.
 *
 * The archival step is allowed to fail, and is allowed to run out of time —
 * see DEFAULT_ARCHIVE_TIMEOUT_MS, and note that the two are told apart when
 * the claimant is told what happened. The hash is not allowed to be
 * invented. Every refusal and every degraded outcome below exists to keep
 * those two facts separable: this repository's v1 caught a Filecoin failure
 * and wrote a hardcoded CID, which was then attested on-chain as genuine
 * evidence of a file nobody had stored. Nothing in this module may default,
 * placeholder, or fabricate a CID, hash, or storage location.
 */

/** Largest upload accepted. A phone photo is ~3 MB; 10 MB is generous. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/**
 * How long this request waits for archival before recording the file without
 * it.
 *
 * This is a budget for human patience, not for Filecoin. It is spent while a
 * claimant watches a spinner in the call widget *during a live phone call*:
 * the agent tells them the upload "takes a few seconds", the widget asks them
 * to keep the page open, and past roughly ten seconds of silence a caller stops
 * believing anything is still happening — they reload, or they send the file a
 * second time, which files a second copy. Eight seconds leaves the database
 * writes that follow inside that window, and leaves an upload at the 10 MB
 * ceiling room to finish rather than being cut off just short of done.
 *
 * The failure this exists for is not slowness. It is the Warm Storage lockup
 * preflight against the Calibration RPC failing, which takes an unbounded time
 * to get around to saying so — and every second of that is a caller being given
 * no reason to think the call has not dropped. Archival is the last synchronous
 * third-party call left on this path; everything else heavy already runs after
 * the answer.
 */
export const DEFAULT_ARCHIVE_TIMEOUT_MS = 8_000;

/**
 * What a claimant may send. Narrow on purpose: everything here is either an
 * image or a PDF, so nothing executable is archived and later handed back to
 * an adjuster's browser.
 */
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

/** Where the bytes ended up. Never inferred — always what actually happened. */
export type DocumentStorageStatus = 'stored' | 'simulated' | 'unarchived';

/**
 * Archival, injected so the caller decides whether that means Filecoin, the
 * clearly-labelled simulation, or nothing at all. It hands back the same
 * discriminated result as the rest of the evidence layer, so a failure
 * arrives as data to record rather than as an exception to swallow.
 */
export type DocumentArchiver = (bytes: Uint8Array) => Promise<FilecoinUploadResult>;

/**
 * Reading text out of the uploaded bytes, injected for the same reason
 * archival is: so a test can decide what a parser does without one being run,
 * and so this module keeps no opinion about which formats can be read.
 *
 * Its contract is narrow and load-bearing. It returns the text or null, it
 * never rejects, and it never takes longer than it says it will. Everything
 * downstream of it — the hash, the row, the claim's document list — is written
 * afterwards, so an extractor that broke either half of that promise would
 * cost the claimant the record of a file that had already arrived.
 */
export type DocumentTextExtractor = (bytes: Uint8Array) => Promise<string | null>;

/** Why an upload was refused. Distinct per gate so callers can branch. */
export type DocumentRejectionReason =
  | 'missing_document_type'
  | 'missing_file'
  | 'file_too_large'
  | 'unsupported_media_type'
  | 'claim_not_found'
  | 'records_unavailable'
  | 'document_type_not_required'
  | 'duplicate_document'
  | 'not_recorded';

export interface DocumentRejected {
  success: false;
  reason: DocumentRejectionReason;
  /** Always null on a refusal: nothing was recorded, so nothing has an id. */
  document_id: null;
  /** Always null on a refusal: no refusal path may hand back a storage location. */
  cid: null;
  claim_number: string | null;
  /** Present only when the bytes were genuinely hashed before the refusal. */
  content_hash: string | null;
  message: string;
}

export interface DocumentAccepted {
  success: true;
  reason: null;
  document_id: string;
  claim_id: string;
  claim_number: string;
  document_type: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  /** keccak256 of the exact bytes received. The integrity anchor. */
  content_hash: string;
  /** Null whenever the bytes were not archived. Never a placeholder. */
  cid: string | null;
  storage_status: DocumentStorageStatus;
  /** Mirrors the archiver's own flag — never presented as a real upload. */
  simulated: boolean;
  /**
   * Whether any text was recorded alongside the bytes. False means the file is
   * evidence but cannot be cross-checked against the claim, which adjudication
   * reports rather than glosses over.
   */
  text_recorded: boolean;
  /** Non-fatal problems worth surfacing, e.g. why archival did not happen. */
  warnings: string[];
  message: string;
}

export type DocumentUploadResult = DocumentAccepted | DocumentRejected;

export interface ClaimDocumentUpload {
  claimNumber: string;
  documentType: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  /** True when the transport cut the stream off at its own size ceiling. */
  truncated?: boolean;
  /**
   * Text read out of the file, recorded beside the hash of the bytes it came
   * from so a reviewer can ask whether the two belong together. Optional: a
   * document with no text is still perfectly good evidence, it simply cannot
   * be cross-checked against the claim. See the 0017 migration header for why
   * this is taken at upload rather than extracted later.
   *
   * Supplied by whoever uploaded the file, so it is recorded with
   * text_source = 'claimant' and treated downstream as adversarial input.
   *
   * When it is absent and the bytes turn out to be a PDF with a text layer,
   * the file is read instead and the row records text_source = 'pdf_text'.
   * When it is present it wins outright: somebody typed those words about this
   * file, and quietly replacing them with a parser's reading would throw away
   * the one version of the text a human stands behind. It stays 'claimant'.
   */
  extractedText?: string;
}

/** Server-side policy for one attach, kept apart from the claimant's payload. */
export interface AttachDocumentOptions {
  /**
   * Overrides DEFAULT_ARCHIVE_TIMEOUT_MS. It lives here rather than on
   * ClaimDocumentUpload deliberately: the upload is parsed out of a multipart
   * body a stranger with the URL can post, and nothing in that body may be
   * allowed to lengthen the wait a caller is held for.
   */
  archiveTimeoutMs?: number;
  /**
   * Overrides the PDF reader. Defaults to `extractPdfText`, which decides for
   * itself whether the bytes are a PDF and hands back null for everything
   * else, so leaving this alone is what production does.
   */
  extractText?: DocumentTextExtractor;
}

/** The outcome of re-hashing a file against a stored document. */
export type DocumentVerificationReason =
  | 'match'
  | 'hash_mismatch'
  | 'missing_file'
  | 'claim_not_found'
  | 'document_not_found'
  | 'records_unavailable';

export interface DocumentVerification {
  match: boolean;
  reason: DocumentVerificationReason;
  document_id: string | null;
  claim_number: string | null;
  document_type: string | null;
  /** keccak256 of the file just supplied, when there were bytes to hash. */
  computed_hash: string | null;
  /** keccak256 recorded at upload time, when the document was found. */
  stored_hash: string | null;
  cid: string | null;
  storage_status: DocumentStorageStatus | null;
  message: string;
}

export interface VerifyClaimDocumentInput {
  claimNumber: string;
  documentId: string;
  bytes: Uint8Array;
}

function reject(
  reason: DocumentRejectionReason,
  message: string,
  claimNumber: string | null = null,
  contentHash: string | null = null
): DocumentRejected {
  return {
    success: false,
    reason,
    document_id: null,
    cid: null,
    claim_number: claimNumber,
    content_hash: contentHash,
    message,
  };
}

function isAllowedMimeType(value: string): value is AllowedMimeType {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(value);
}

/** PostgreSQL unique_violation — the (claim_id, content_hash) index firing. */
const UNIQUE_VIOLATION = '23505';

function humanize(documentType: string): string {
  return documentType.replace(/_/g, ' ');
}

/**
 * The document facts that go into the evidence bundle: type and content hash,
 * and nothing else. Filenames and MIME types are the claimant's metadata, not
 * the evidence, and including them would make the bundle hash change when a
 * file is merely renamed.
 *
 * Sorted by hash so the bundle is stable regardless of the order PostgREST
 * happens to return rows in — an unstable order would change the anchored
 * hash without any document changing.
 */
export function documentEvidenceEntries(
  rows: Array<{ document_type: string; content_hash: string }>
): Array<{ document_type: string; content_hash: string }> {
  return rows
    .map((row) => ({ document_type: row.document_type, content_hash: row.content_hash }))
    .sort((a, b) =>
      a.content_hash < b.content_hash ? -1 : a.content_hash > b.content_hash ? 1 : 0
    );
}

/** Claim numbers reach us through speech-to-text, usually without the dashes. */
async function findClaim(supabase: SupabaseClient, claimNumber: string) {
  let claim: any = null;
  let error: any = null;

  for (const candidate of referenceCandidates(claimNumber)) {
    const attempt = await supabase
      .from('claims')
      .select('id, claim_number, documents_required, documents_received')
      .eq('claim_number', candidate)
      .maybeSingle();
    if (attempt.data) return { claim: attempt.data, error: null };
    if (attempt.error && !isNotFound(attempt.error)) return { claim: null, error: attempt.error };
    error = attempt.error;
  }

  return { claim, error };
}

/**
 * What became of an archival attempt inside its budget. `timedOut` is kept
 * distinct from an `ok: false` result because they are different facts about
 * the world: the archive refused these bytes, versus we never heard back from
 * it. Only the first is something we know about the bytes.
 */
type ArchiveOutcome =
  | { timedOut: false; result: FilecoinUploadResult }
  | { timedOut: true };

/**
 * Run the archiver, but stop waiting after `budgetMs`.
 *
 * Two things here are load-bearing:
 *
 * The attempt gets its rejection handler attached *before* the race, not after.
 * Once we stop waiting, the underlying upload is still in flight; if it later
 * throws — which is exactly what the failing lockup preflight does — an
 * unattached promise becomes an unhandledRejection and takes the process with
 * it, turning a slow upload into an outage for every caller on the line. A
 * throw is folded into the same stated failure `uploadBytes` would have
 * returned, so the one contract this module rests on holds: archival failure
 * arrives as data to record, never as an exception to swallow.
 *
 * The timer is unref'd and cleared. A pending eight-second timer would
 * otherwise hold the event loop open after the response is long gone.
 */
async function archiveWithinBudget(
  archive: DocumentArchiver,
  bytes: Uint8Array,
  budgetMs: number
): Promise<ArchiveOutcome> {
  const attempt: Promise<ArchiveOutcome> = Promise.resolve()
    .then(() => archive(bytes))
    .then(
      (result): ArchiveOutcome => ({ timedOut: false, result }),
      (error): ArchiveOutcome => ({
        timedOut: false,
        result: {
          ok: false,
          disabled: false,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<ArchiveOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), budgetMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([attempt, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hash an uploaded file, archive it if archival is available, and record what
 * genuinely happened.
 *
 * Note what this does *not* do: it never adds the type to
 * `claims.documents_received`. That write belongs to the evidence pipeline,
 * which runs afterwards and re-anchors the bundle, so a claim can never show a
 * document as received before its hash is part of the attested bundle.
 */
export async function attachClaimDocument(
  supabase: SupabaseClient,
  archive: DocumentArchiver,
  input: ClaimDocumentUpload,
  options: AttachDocumentOptions = {}
): Promise<DocumentUploadResult> {
  // --- Gate 1: the request must describe a document -----------------------
  const documentType = (input.documentType ?? '').trim();
  if (!documentType) {
    return reject(
      'missing_document_type',
      'Tell me which document this is — for example a police report, photos, or a repair estimate.'
    );
  }

  // --- Gate 2: there must be bytes ----------------------------------------
  // Byte-level checks come before the database round trip: refusing a 40 MB
  // upload should not cost a query, and an empty file has nothing to hash.
  if (!input.bytes || input.bytes.byteLength === 0) {
    return reject('missing_file', 'That upload arrived empty, so there is nothing to record.');
  }

  // --- Gate 3: within the size ceiling ------------------------------------
  // `truncated` matters as much as the length: a stream cut off at the limit
  // hashes to something that is not the claimant's file.
  if (input.truncated || input.bytes.byteLength > MAX_DOCUMENT_BYTES) {
    return reject(
      'file_too_large',
      `That file is larger than the ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB limit. Please send a smaller copy.`
    );
  }

  // --- Gate 4: an allowed media type --------------------------------------
  const mimeType = (input.mimeType ?? '').split(';')[0].trim().toLowerCase();
  if (!isAllowedMimeType(mimeType)) {
    return reject(
      'unsupported_media_type',
      `We can only accept ${ALLOWED_MIME_TYPES.join(', ')}. That file is ${mimeType || 'of an unknown type'}.`
    );
  }

  // --- Gate 5: the claim must exist ---------------------------------------
  const { claim, error: claimError } = await findClaim(supabase, input.claimNumber);

  if (claimError && !isNotFound(claimError)) {
    console.error('attachClaimDocument: claim lookup failed:', claimError);
    return reject(
      'records_unavailable',
      "I'm having trouble reaching our claim records right now, so I can't record this document yet."
    );
  }

  if (!claim) {
    return reject(
      'claim_not_found',
      "I couldn't find a claim with that number, so there is nothing to attach this to."
    );
  }

  // --- Gate 6: the claim must actually want this document -----------------
  // Without this, anything at all can be pushed onto a claim and then anchored
  // on-chain as though an adjuster had asked for it.
  const required: string[] = claim.documents_required ?? [];
  if (!required.includes(documentType)) {
    return reject(
      'document_type_not_required',
      required.length
        ? `Claim ${claim.claim_number} doesn't ask for ${humanize(documentType)}. What it needs is: ${required.map(humanize).join(', ')}.`
        : `Claim ${claim.claim_number} has no outstanding document requirements.`,
      claim.claim_number
    );
  }

  // --- Hash the bytes ------------------------------------------------------
  // Everything from here on is recorded relative to this value, and it is
  // computed before archival is attempted so an archival failure cannot cost
  // us the one fact that makes the file checkable.
  const contentHash = computeContentHash(input.bytes);

  // --- Gate 7: not already recorded ---------------------------------------
  const { data: existing, error: existingError } = await supabase
    .from('claim_documents')
    .select('id, document_type, content_hash')
    .eq('claim_id', claim.id)
    .eq('content_hash', contentHash)
    .maybeSingle();

  if (existingError && !isNotFound(existingError)) {
    console.error('attachClaimDocument: duplicate check failed:', existingError);
    return reject(
      'records_unavailable',
      "I'm having trouble reaching our document records right now, so I can't record this document yet.",
      claim.claim_number,
      contentHash
    );
  }

  if (existing) {
    return reject(
      'duplicate_document',
      `We already have this exact file on claim ${claim.claim_number}, recorded as ${humanize(existing.document_type)}.`,
      claim.claim_number,
      contentHash
    );
  }

  // --- Read the file --------------------------------------------------------
  // Started here and awaited below, so the parse overlaps the archival wait
  // rather than following it. That ordering is the whole reason this is
  // affordable on a live call: the claimant's wait becomes the longer of the
  // two budgets instead of their sum, and on the normal path — a text-layer PDF
  // parses in single-digit milliseconds — it becomes exactly what it is today.
  //
  // Started after the gates, not before them, so a refused upload never pays
  // for a parse. Not started at all when the uploader typed the text
  // themselves, because that text wins regardless of what a parser would have
  // found and the work would be thrown away.
  //
  // `DocumentTextExtractor` is contracted never to reject and the default
  // implementation catches everything it can reach, and it is caught here
  // anyway. That is not belt and braces for its own sake: reading the file is
  // an optional nicety and recording the hash is the obligation, so the one
  // must not be able to reach the other. 0013's header is about the last time
  // an optional step in this path was allowed to compromise a mandatory one.
  // The handler is attached in the same tick as the call for the same reason
  // the evidence pipeline's is at `routes/claim-documents.ts:344-347` — a
  // rejection with no handler attached synchronously takes the process down.
  const suppliedText = (input.extractedText ?? '').trim();
  const extractText = options.extractText ?? extractPdfText;
  const reading: Promise<string | null> = suppliedText
    ? Promise.resolve(null)
    : extractText(input.bytes).catch((err) => {
        console.error('attachClaimDocument: reading the document failed:', err);
        return null;
      });

  // --- Archive -------------------------------------------------------------
  // Bounded, because this is the only third-party call left between the
  // claimant pressing send and the widget saying something back, and an
  // unbounded one is indistinguishable from a dropped call. See
  // DEFAULT_ARCHIVE_TIMEOUT_MS for how long, and why that long.
  const warnings: string[] = [];
  const timeoutMs = options.archiveTimeoutMs ?? DEFAULT_ARCHIVE_TIMEOUT_MS;
  const outcome = await archiveWithinBudget(archive, input.bytes, timeoutMs);

  let storageStatus: DocumentStorageStatus;
  let cid: string | null;
  let simulated: boolean;
  /** Tracked separately so the caller is told which of the two actually happened. */
  let archiveTimedOut = false;

  if (outcome.timedOut) {
    // We stopped waiting; the upload may well still be running. That is why
    // this degrades to the same row a refusal writes rather than to a
    // pending-with-a-CID-to-follow one: `storage_status` is constrained to
    // three values by 0013, `cid` must be NULL for exactly 'unarchived', and
    // there is no backfill path for either column. So the row is allowed to
    // understate what happened — it never claims storage nobody established —
    // and if the upload does land afterwards, we simply do not claim it. The
    // hash was computed above and is recorded either way, which is the fact
    // that makes the file checkable.
    archiveTimedOut = true;
    storageStatus = 'unarchived';
    cid = null;
    simulated = false;
    warnings.push(`archival: no answer within ${timeoutMs} ms, so the file is recorded unarchived`);
  } else if (!outcome.result.ok) {
    // The honest outcome. The row still gets written, because the hash on its
    // own is what makes the file tamper-evident; what it must not say is that
    // the bytes are somewhere they are not.
    storageStatus = 'unarchived';
    cid = null;
    simulated = false;
    warnings.push(`archival: ${outcome.result.error}`);
  } else {
    const archival = outcome.result;
    storageStatus = archival.simulated ? 'simulated' : 'stored';
    cid = archival.pieceCid;
    simulated = archival.simulated;
    warnings.push(...archival.partialFailures.map((failure) => `archival copy: ${failure}`));
  }

  // --- Record --------------------------------------------------------------
  // Empty text is stored as NULL, not as ''. The 0017 constraint pairs
  // extracted_text with a stated source, and a blank string with a source
  // attached would claim somebody read the file and found nothing in it.
  //
  // The two sources are ranked rather than merged, and the ranking is by who
  // is answerable for the words. A caption came from a person who can be asked
  // about it; a parser's reading came from the bytes. Neither is trusted — both
  // are fenced in the adjudication prompt — but they are different claims about
  // the document, and `text_source` has to say which one the column holds. A
  // file that is neither captioned nor readable keeps the NULL pair it has
  // today, which the prompt reports as a document nobody has read.
  const parsedText = suppliedText ? null : await reading;
  const extractedText = suppliedText || parsedText || null;
  const textSource = suppliedText ? 'claimant' : parsedText ? 'pdf_text' : null;

  const { data: inserted, error: insertError } = await supabase
    .from('claim_documents')
    .insert({
      claim_id: claim.id,
      document_type: documentType,
      original_filename: input.filename || 'upload',
      mime_type: mimeType,
      size_bytes: input.bytes.byteLength,
      content_hash: contentHash,
      cid,
      storage_status: storageStatus,
      simulated,
      extracted_text: extractedText,
      text_source: textSource,
      uploaded_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertError) {
    // The unique index caught a duplicate the check above raced past. Same
    // answer as gate 7, so a retry reads the same way whichever half fired.
    if (insertError.code === UNIQUE_VIOLATION) {
      return reject(
        'duplicate_document',
        `We already have this exact file on claim ${claim.claim_number}.`,
        claim.claim_number,
        contentHash
      );
    }

    console.error('attachClaimDocument: document row not written:', insertError);
    return reject(
      'not_recorded',
      "I received the file but couldn't record it against the claim, so please try again.",
      claim.claim_number,
      contentHash
    );
  }

  // The widget prints this sentence to the claimant verbatim, so it has to be
  // true of what actually happened. A timeout gets its own wording rather than
  // borrowing the failure line: "the archive is unavailable" asserts we heard
  // it turn the file down, and after a timeout we heard nothing at all. The
  // two produce the same row; they are not the same claim about the world, and
  // the weaker one is the only one we are entitled to make.
  const storageMessage =
    storageStatus === 'stored'
      ? 'It is archived on Filecoin.'
      : storageStatus === 'simulated'
        ? 'Archival is running in simulation, so nothing was uploaded.'
        : archiveTimedOut
          ? 'We could not reach the decentralized archive in the time we could keep you waiting, so only the fingerprint is on file.'
          : 'Decentralized archival is unavailable right now, so only the fingerprint is on file.';

  return {
    success: true,
    reason: null,
    document_id: inserted.id,
    claim_id: claim.id,
    claim_number: claim.claim_number,
    document_type: documentType,
    original_filename: input.filename || 'upload',
    mime_type: mimeType,
    size_bytes: input.bytes.byteLength,
    content_hash: contentHash,
    cid,
    storage_status: storageStatus,
    simulated,
    text_recorded: Boolean(extractedText),
    warnings,
    message: `Received your ${humanize(documentType)} for claim ${claim.claim_number}. ${storageMessage}`,
  };
}

/**
 * Re-hash a supplied file and compare it against what was recorded.
 *
 * This is the whole point of the feature made checkable: anyone holding a copy
 * of the file can find out whether it is byte-identical to what the claim was
 * filed with, without trusting our database — because the stored hash is
 * folded into the evidence bundle that is anchored on-chain.
 */
export async function verifyClaimDocument(
  supabase: SupabaseClient,
  input: VerifyClaimDocumentInput
): Promise<DocumentVerification> {
  const base = {
    document_id: null,
    claim_number: null,
    document_type: null,
    computed_hash: null,
    stored_hash: null,
    cid: null,
    storage_status: null,
  } as const;

  if (!input.bytes || input.bytes.byteLength === 0) {
    return {
      ...base,
      match: false,
      reason: 'missing_file',
      message: 'Send the file you want checked — there is nothing to compare against yet.',
    };
  }

  const { claim, error: claimError } = await findClaim(supabase, input.claimNumber);

  if (claimError && !isNotFound(claimError)) {
    console.error('verifyClaimDocument: claim lookup failed:', claimError);
    return {
      ...base,
      match: false,
      reason: 'records_unavailable',
      message: "I'm having trouble reaching our claim records right now, so I can't check this file.",
    };
  }

  if (!claim) {
    return {
      ...base,
      match: false,
      reason: 'claim_not_found',
      message: "I couldn't find a claim with that number.",
    };
  }

  // Scoped to the claim, so a document id from elsewhere cannot be verified
  // against a claim it does not belong to.
  const { data: document, error: documentError } = await supabase
    .from('claim_documents')
    .select('id, document_type, content_hash, cid, storage_status')
    .eq('id', input.documentId)
    .eq('claim_id', claim.id)
    .maybeSingle();

  if (documentError && !isNotFound(documentError)) {
    console.error('verifyClaimDocument: document lookup failed:', documentError);
    return {
      ...base,
      match: false,
      reason: 'records_unavailable',
      claim_number: claim.claim_number,
      message: "I'm having trouble reaching our document records right now, so I can't check this file.",
    };
  }

  if (!document) {
    return {
      ...base,
      match: false,
      reason: 'document_not_found',
      claim_number: claim.claim_number,
      message: `No document with that id is recorded against claim ${claim.claim_number}.`,
    };
  }

  const computedHash = computeContentHash(input.bytes);
  const match = computedHash === document.content_hash;

  return {
    match,
    reason: match ? 'match' : 'hash_mismatch',
    document_id: document.id,
    claim_number: claim.claim_number,
    document_type: document.document_type,
    computed_hash: computedHash,
    stored_hash: document.content_hash,
    cid: document.cid ?? null,
    storage_status: document.storage_status ?? null,
    message: match
      ? `This file is byte-for-byte the ${humanize(document.document_type)} recorded against claim ${claim.claim_number}.`
      : `This file does not match the ${humanize(document.document_type)} recorded against claim ${claim.claim_number}. It has been altered or replaced.`,
  };
}

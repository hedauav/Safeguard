import { SupabaseClient } from '@supabase/supabase-js';
import { computeContentHash } from './attestation-service.js';
import { isNotFound } from './lookup-result.js';
import { referenceCandidates } from './reference-number.js';
import type { FilecoinUploadResult } from './filecoin-service.js';

/**
 * Tamper-evident claim documents.
 *
 * A claimant's proof — a photo of the damage, a repair invoice, a police
 * report — is only evidence if a later copy can be checked against what was
 * actually received. So the bytes are hashed here, before anything else is
 * attempted, and that hash is recorded whatever happens next.
 *
 * The archival step is allowed to fail. The hash is not allowed to be
 * invented. Every refusal and every degraded outcome below exists to keep
 * those two facts separable: this repository's v1 caught a Filecoin failure
 * and wrote a hardcoded CID, which was then attested on-chain as genuine
 * evidence of a file nobody had stored. Nothing in this module may default,
 * placeholder, or fabricate a CID, hash, or storage location.
 */

/** Largest upload accepted. A phone photo is ~3 MB; 10 MB is generous. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

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
  input: ClaimDocumentUpload
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

  // --- Archive -------------------------------------------------------------
  const warnings: string[] = [];
  const archival = await archive(input.bytes);

  let storageStatus: DocumentStorageStatus;
  let cid: string | null;
  let simulated: boolean;

  if (!archival.ok) {
    // The honest outcome. The row still gets written, because the hash on its
    // own is what makes the file tamper-evident; what it must not say is that
    // the bytes are somewhere they are not.
    storageStatus = 'unarchived';
    cid = null;
    simulated = false;
    warnings.push(`archival: ${archival.error}`);
  } else {
    storageStatus = archival.simulated ? 'simulated' : 'stored';
    cid = archival.pieceCid;
    simulated = archival.simulated;
    warnings.push(...archival.partialFailures.map((failure) => `archival copy: ${failure}`));
  }

  // --- Record --------------------------------------------------------------
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

  const storageMessage =
    storageStatus === 'stored'
      ? 'It is archived on Filecoin.'
      : storageStatus === 'simulated'
        ? 'Archival is running in simulation, so nothing was uploaded.'
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

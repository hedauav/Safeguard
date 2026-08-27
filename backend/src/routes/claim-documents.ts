import { FastifyInstance, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { runEvidencePipeline } from '../services/evidence-pipeline.js';
import { uploadDocumentBytes } from '../services/filecoin-service.js';
import { advanceClaimOnDocumentsComplete } from '../services/claims-service.js';
import { recordJourneyEvent } from '../services/journey-events-service.js';
import { ONCHAIN_RATE_LIMIT, TOOL_RATE_LIMIT } from '../plugins/rate-limit.js';
import {
  MAX_DOCUMENT_BYTES,
  attachClaimDocument,
  verifyClaimDocument,
  type DocumentArchiver,
  type DocumentRejectionReason,
  type DocumentVerificationReason,
} from '../services/claim-documents-service.js';

/**
 * Largest `extracted_text` field accepted. Generous for a repair estimate or a
 * police report, and bounded so the field cannot be used to write a novel into
 * the claim record — or into an adjudication prompt.
 */
const MAX_EXTRACTED_TEXT_CHARS = 20_000;

interface ParsedUpload {
  documentType: string;
  extractedText: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  truncated: boolean;
}

/** Nothing here is a server fault, so none of it deserves a 500. */
const STATUS_FOR_REJECTION: Record<DocumentRejectionReason, number> = {
  missing_document_type: 400,
  missing_file: 400,
  file_too_large: 413,
  unsupported_media_type: 415,
  claim_not_found: 404,
  records_unavailable: 503,
  document_type_not_required: 422,
  duplicate_document: 409,
  not_recorded: 500,
};

const STATUS_FOR_VERIFICATION: Record<DocumentVerificationReason, number> = {
  // A mismatch is a successful check with a negative answer, not a failed
  // request — the caller asked whether the file matches and got a real answer.
  match: 200,
  hash_mismatch: 200,
  missing_file: 400,
  claim_not_found: 404,
  document_not_found: 404,
  records_unavailable: 503,
};

/**
 * Read the single file part and the accompanying fields.
 *
 * Everything is buffered rather than streamed onward, because the bytes have
 * to be hashed and archived as one unit and a partial read would hash to
 * something that is not the claimant's file. The size ceiling registered on
 * the plugin is what keeps that buffer bounded.
 */
async function parseUpload(request: FastifyRequest): Promise<ParsedUpload | null> {
  let documentType = '';
  let extractedText = '';
  let file: Omit<ParsedUpload, 'documentType' | 'extractedText'> | null = null;

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      // Later files are drained, not silently dropped: an unread stream stalls
      // the request. Only the first is considered.
      const buffer = await part.toBuffer();
      if (!file) {
        file = {
          filename: part.filename ?? 'upload',
          mimeType: part.mimetype ?? '',
          bytes: new Uint8Array(buffer),
          truncated: part.file.truncated,
        };
      }
    } else if (part.fieldname === 'document_type') {
      documentType = String(part.value ?? '');
    } else if (part.fieldname === 'extracted_text') {
      // Truncated rather than refused: the bytes and their hash are the thing
      // that must not be lost, and an over-long caption is no reason to reject
      // the evidence it came with.
      extractedText = String(part.value ?? '').slice(0, MAX_EXTRACTED_TEXT_CHARS);
    }
  }

  if (!file) return null;
  return { documentType, extractedText, ...file };
}

/** What folding the new type into `claims.documents_received` actually did. */
interface DocumentsReceivedWrite {
  /** True only when the claim row now lists this document type. */
  ok: boolean;
  /**
   * The claim's own lists, as they stand after this write. Null only when the
   * claim row could not be read at all, which is the one case where the route
   * has no independent view of what has arrived.
   */
  documents: { required: string[]; received: string[] } | null;
}

/**
 * Fold a newly recorded document type into `claims.documents_received`.
 *
 * This write used to belong exclusively to the evidence pipeline, which did it
 * at the very end of a Filecoin upload and a Base Sepolia round trip. That was
 * survivable while the route awaited the pipeline. It is not survivable now
 * that the pipeline runs in the background, because
 * `advanceClaimOnDocumentsComplete` reads exactly this column to decide whether
 * the claimant's wait is over: leave the write where it was and the claim would
 * never advance on the upload that completed it, only minutes later and only if
 * the pipeline happened to finish.
 *
 * So the route does it here, before it responds, and the pipeline still does it
 * afterwards. The two do not fight. The pipeline re-reads the column and writes
 * the union of what it finds with what it was told to add, so its write is a
 * no-op when this one landed and a repair when this one failed.
 *
 * What this costs is the ordering note at `claim-documents-service.ts:228-231`
 * — that a claim never lists a document as received before that document's hash
 * is part of the attested bundle. That guarantee was always softer than it
 * read: the pipeline writes `documents_received` in the same update whether the
 * attestation succeeded, failed, or was skipped entirely, so the column has
 * never actually meant "anchored on-chain". What it means, and all it has ever
 * meant, is "a file of this type is on record" — and the `claim_documents` row
 * carrying the keccak256 of the bytes is written before this function runs, so
 * that much is true the instant this write lands.
 *
 * This is a read-modify-write and therefore races a concurrent upload against
 * the same claim. The race is not introduced here — the pipeline has always
 * updated this array the same way — and the background pipeline's own union is
 * what heals a lost update. It is written down rather than hidden: two
 * documents arriving in the same instant can cost one of them its place in this
 * array until the next pipeline run puts it back.
 */
async function recordDocumentReceived(
  fastify: FastifyInstance,
  claimId: string,
  documentType: string
): Promise<DocumentsReceivedWrite> {
  const { data: claim, error: readError } = await fastify.supabase
    .from('claims')
    .select('documents_required, documents_received')
    .eq('id', claimId)
    .maybeSingle();

  if (readError || !claim) {
    fastify.log.error(
      { err: readError, claimId },
      'Claim row could not be read to record the document as received'
    );
    return { ok: false, documents: null };
  }

  const required: string[] = (claim.documents_required as string[] | null) ?? [];
  const received = Array.from(
    new Set([...((claim.documents_received as string[] | null) ?? []), documentType])
  );

  const { error: writeError } = await fastify.supabase
    .from('claims')
    .update({ documents_received: received })
    .eq('id', claimId);

  if (writeError) {
    fastify.log.error(
      { err: writeError, claimId, documentType },
      'Document is recorded but the claim row does not list it as received'
    );
    // The lists are still handed back. The file genuinely arrived and its hash
    // is genuinely on record, so the route can tell the claimant what is
    // outstanding truthfully even while the claim row disagrees.
    return { ok: false, documents: { required, received } };
  }

  return { ok: true, documents: { required, received } };
}

export default async function claimDocumentsRoutes(fastify: FastifyInstance) {
  await fastify.register(multipart, {
    limits: {
      // One byte over the ceiling, so an oversized upload is still detectable
      // here and refused with a stated reason rather than accepted at exactly
      // the limit or cut off invisibly.
      fileSize: MAX_DOCUMENT_BYTES + 1,
      files: 1,
      fields: 8,
    },
    // We would rather report the size in our own words than have the plugin
    // throw an opaque 413 before the claim is even identified.
    throwFileSizeLimit: false,
  });

  /**
   * Archival for uploaded documents. Uses whatever the Filecoin plugin managed
   * to construct — a null client yields a stated failure (or a flagged
   * simulation in demo mode), never a placeholder CID.
   */
  const archive: DocumentArchiver = (bytes) => uploadDocumentBytes(fastify.filecoin.synapse, bytes);

  // Both routes below name a rate-limit tier explicitly, and a route added here
  // later must do the same. @fastify/rate-limit reads `route.config.rateLimit`
  // in its own `onRoute` hook, which runs before any hook registered in this
  // scope, so a default injected by a hook is read too late and the route
  // silently falls back to the global 300/min ceiling — the same trap documented
  // at `webhook-tools.ts:105-109`.
  //
  // These two differ from every route next door in one respect that makes the
  // ceiling matter far more, not less: there is no `requireToolsToken` on them
  // and there cannot be. The call widget in the browser is what posts here, and
  // the tools token must never be shipped in a browser bundle. So this limit is
  // not a backstop for a leaked secret, as it is for the agent-facing routes —
  // it is the only thing between a stranger holding the URL and the agent
  // wallet. See the route comments for how each tier was chosen.

  // POST /claims/:claimNumber/documents — upload proof for a claim
  //
  // ONCHAIN_RATE_LIMIT (15/min) because every accepted upload fires the evidence
  // pipeline, and every pipeline run spends real testnet funds on a Base Sepolia
  // write — the identical reason `/tools/file-claim` names this tier. It is
  // generous for the traffic this route is built for (nobody photographs four
  // documents fifteen times in a minute) and tight enough that an unattended
  // script pointed at this URL exhausts a per-minute allowance rather than a
  // wallet.
  fastify.post('/claims/:claimNumber/documents', {
    config: { rateLimit: ONCHAIN_RATE_LIMIT },
  }, async (request: FastifyRequest<{
    Params: { claimNumber: string };
  }>, reply) => {
    if (!request.isMultipart()) {
      reply.code(415);
      return {
        success: false,
        reason: 'unsupported_media_type',
        document_id: null,
        cid: null,
        message: 'Send the file as multipart/form-data with a `file` part and a `document_type` field.',
      };
    }

    let upload: ParsedUpload | null;
    try {
      upload = await parseUpload(request);
    } catch (err) {
      fastify.log.warn({ err }, 'Claim document upload could not be parsed');
      reply.code(400);
      return {
        success: false,
        reason: 'missing_file',
        document_id: null,
        cid: null,
        message: 'That upload could not be read. Send exactly one file as multipart/form-data.',
      };
    }

    if (!upload) {
      reply.code(400);
      return {
        success: false,
        reason: 'missing_file',
        document_id: null,
        cid: null,
        message: 'No file was included in the upload.',
      };
    }

    const result = await attachClaimDocument(fastify.supabase, archive, {
      claimNumber: request.params.claimNumber,
      documentType: upload.documentType,
      filename: upload.filename,
      mimeType: upload.mimeType,
      bytes: upload.bytes,
      truncated: upload.truncated,
      extractedText: upload.extractedText,
    });

    if (!result.success) {
      fastify.log.info(
        { claimNumber: request.params.claimNumber, reason: result.reason },
        'Claim document rejected'
      );
      reply.code(STATUS_FOR_REJECTION[result.reason]);
      return result;
    }

    // --- The claim's own document list ---------------------------------------
    // Written here rather than left to the evidence pipeline, which no longer
    // runs before this response. `recordDocumentReceived` explains why that move
    // is safe, what it costs, and how the pipeline repairs it if it fails.
    const documentsWrite = await recordDocumentReceived(
      fastify,
      result.claim_id,
      result.document_type
    );

    // --- Has the wait ended? --------------------------------------------------
    // Still awaited, and deliberately. Nothing in here calls a model, a chain,
    // or a third party — it is one read and at most one compare-and-set on
    // `claims.status` — so it cannot stall the conversation, and a claimant who
    // has just sent the last outstanding file is owed a straight answer to "is
    // that everything?" rather than a shrug and a promise to look later.
    //
    // It works now only because of the write above: this reads
    // `claims.documents_received`, and before that write the column would not
    // yet mention the document that has just arrived.
    const advance = await advanceClaimOnDocumentsComplete(
      fastify.supabase,
      {
        recordEvent: ({ eventType, detail }) =>
          recordJourneyEvent(fastify.supabase, {
            claimId: result.claim_id,
            eventType,
            // `system`, not `agent` and certainly not `human`. Nobody decided
            // anything; the claim moved because a required file arrived.
            actor: 'system',
            detail,
          }),
      },
      result.claim_id
    );

    // --- Re-anchor, in the background ----------------------------------------
    // A Filecoin upload and a wait on a Base Sepolia receipt — fired and not
    // awaited, exactly as at `webhook-tools.ts:194` and for exactly the same
    // reason: a slow or unavailable Filecoin provider must never stall a live
    // phone conversation, and as of the call widget this route is on one.
    // Awaiting it held the response open for as long as the chain took, which
    // meant a claimant whose file had already been received, hashed and recorded
    // was told nothing at all until a third party finished — or was told nothing
    // ever, when the gateway timed the request out first.
    //
    // Nothing above this line depends on it. The document row, its content hash,
    // the claim's document list and the claim's status are all already written,
    // so a pipeline that fails costs the claim its fresh anchor and its CID —
    // both recoverable on the next run — and costs the claimant nothing.
    //
    // The claim id is hoisted into a const and the `.catch()` is attached in the
    // same tick. Neither is decoration: `result` is narrowed to the accepted
    // shape out here but would widen inside the closure, and a rejection with no
    // handler attached synchronously takes the process down.
    const claimId = result.claim_id;
    const claimNumber = result.claim_number;

    runEvidencePipeline(fastify, {
      claimId,
      // Still passed even though the column was written above: this is what
      // makes the pipeline re-union and rewrite `documents_received`, which is
      // the repair path for a write that failed a moment ago.
      addDocuments: [result.document_type],
    }).catch((err) => {
      fastify.log.error(
        { err, claimId, claimNumber },
        'Background evidence pipeline failed after a claim document upload'
      );
    });

    // --- What is genuinely still outstanding ----------------------------------
    // Taken from `advance` on the normal path, because that is a fresh read of
    // the claim row itself. Computed locally only when the row could not be
    // updated: in that case the row is behind what has actually arrived, and
    // reporting from it would ask the claimant to send a file they have this
    // second finished sending.
    const known = documentsWrite.documents;
    const documentsMissing =
      documentsWrite.ok || !known
        ? advance.documents_missing
        : known.required.filter((doc) => !known.received.includes(doc));

    // --- What did not finish --------------------------------------------------
    // Each of these leaves the document recorded and hashed but something
    // downstream incomplete, so each is a warning on a 201 rather than a failed
    // upload: the upload did succeed, and calling it a failure would invite the
    // claimant to send the file all over again. Saying nothing is the worse
    // error — it would leave them believing their claim is with a reviewer when
    // it is still sitting in `documents_needed`.
    const warnings = [...result.warnings];

    if (!documentsWrite.ok) {
      warnings.push(
        "claim record: the document is recorded and hashed, but the claim's document list was not updated, so the claim has not moved yet"
      );
    }

    if (advance.reason === 'status_write_failed' || advance.reason === 'records_unavailable') {
      warnings.push('claim status: the document is recorded, but the claim was not moved to under_review');
    }

    fastify.log.info(
      {
        claimNumber: result.claim_number,
        documentId: result.document_id,
        contentHash: result.content_hash,
        storage: result.storage_status,
        documentsReceivedWritten: documentsWrite.ok,
        documentsMissing,
        claimAdvanced: advance.advanced,
        claimAdvanceReason: advance.reason,
        // The anchor is no longer known at this point; it is logged again by the
        // pipeline itself when it lands.
        attestationPending: true,
      },
      'Claim document recorded'
    );

    reply.code(201);
    return {
      ...result,
      warnings,
      /**
       * Both null, and deliberately so rather than absent. The bundle hash and
       * the Base Sepolia transaction are produced by the pipeline fired above,
       * which by definition has not finished when this response is written.
       * Waiting for them is the stall this route just stopped doing, and
       * reporting anything other than null would be inventing an anchor that
       * does not exist yet. The claim row carries the real values once the
       * pipeline lands.
       */
      evidence_hash: null,
      attestation_tx_hash: null,
      /**
       * Says "ask again later" rather than "there is none" — the difference
       * between a document awaiting its anchor and one that failed to get one.
       */
      attestation_pending: true,
      /** Which required types are still outstanding; empty means none are. */
      documents_missing: documentsMissing,
      /**
       * Presence only. Every required type has arrived — nothing has read what
       * any of them says.
       */
      documents_complete: documentsMissing.length === 0,
      /**
       * Whether this upload is what took the claim out of `documents_needed`.
       * False is a real answer and not a missing one: a claim that was already
       * under review, one still short a document, and one whose status write
       * failed all report false, and none of them is described as having moved.
       */
      claim_advanced: advance.advanced,
      /** Where the claim stands now, moved or not. */
      claim_status: advance.status_after ?? advance.status_before,
    };
  });

  // POST /claims/:claimNumber/documents/:id/verify — re-hash a file and compare
  //
  // TOOL_RATE_LIMIT (120/min) rather than the on-chain tier: verification hashes
  // some bytes and reads two rows. It spends nothing, writes nothing and touches
  // no chain, so the reason for the tighter ceiling next door does not apply.
  // It still names a tier rather than falling through to the global 300/min,
  // because an unauthenticated route that will read a 10 MB body is worth
  // bounding on its own terms.
  fastify.post('/claims/:claimNumber/documents/:id/verify', {
    config: { rateLimit: TOOL_RATE_LIMIT },
  }, async (request: FastifyRequest<{
    Params: { claimNumber: string; id: string };
  }>, reply) => {
    if (!request.isMultipart()) {
      reply.code(415);
      return {
        match: false,
        reason: 'missing_file',
        message: 'Send the file to check as multipart/form-data.',
      };
    }

    let upload: ParsedUpload | null;
    try {
      upload = await parseUpload(request);
    } catch (err) {
      fastify.log.warn({ err }, 'Claim document verification could not be parsed');
      reply.code(400);
      return {
        match: false,
        reason: 'missing_file',
        message: 'That upload could not be read. Send exactly one file as multipart/form-data.',
      };
    }

    const result = await verifyClaimDocument(fastify.supabase, {
      claimNumber: request.params.claimNumber,
      documentId: request.params.id,
      // A file cut off at the size limit is not the original, so it is not
      // offered up as a candidate match.
      bytes: upload && !upload.truncated ? upload.bytes : new Uint8Array(),
    });

    fastify.log.info(
      {
        claimNumber: request.params.claimNumber,
        documentId: request.params.id,
        match: result.match,
        reason: result.reason,
      },
      'Claim document verification'
    );

    reply.code(STATUS_FOR_VERIFICATION[result.reason]);
    return result;
  });
}

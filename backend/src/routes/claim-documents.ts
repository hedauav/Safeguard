import { FastifyInstance, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { runEvidencePipeline } from '../services/evidence-pipeline.js';
import { uploadDocumentBytes } from '../services/filecoin-service.js';
import {
  MAX_DOCUMENT_BYTES,
  attachClaimDocument,
  verifyClaimDocument,
  type DocumentArchiver,
  type DocumentRejectionReason,
  type DocumentVerificationReason,
} from '../services/claim-documents-service.js';

interface ParsedUpload {
  documentType: string;
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
  let file: Omit<ParsedUpload, 'documentType'> | null = null;

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
    }
  }

  if (!file) return null;
  return { documentType, ...file };
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

  // POST /claims/:claimNumber/documents — upload proof for a claim
  fastify.post('/claims/:claimNumber/documents', async (request: FastifyRequest<{
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
    });

    if (!result.success) {
      fastify.log.info(
        { claimNumber: request.params.claimNumber, reason: result.reason },
        'Claim document rejected'
      );
      reply.code(STATUS_FOR_REJECTION[result.reason]);
      return result;
    }

    // Re-anchor the claim now that a new content hash exists. The pipeline
    // reads claim_documents itself, so the bundle it attests covers this file.
    const evidence = await runEvidencePipeline(fastify, {
      claimId: result.claim_id,
      addDocuments: [result.document_type],
    });

    fastify.log.info(
      {
        claimNumber: result.claim_number,
        documentId: result.document_id,
        contentHash: result.content_hash,
        storage: result.storage_status,
        evidenceHash: evidence?.evidenceHash ?? null,
      },
      'Claim document recorded'
    );

    reply.code(201);
    return {
      ...result,
      warnings: [...result.warnings, ...(evidence?.warnings ?? [])],
      /** The bundle hash this document's hash is now folded into. */
      evidence_hash: evidence?.evidenceHash ?? null,
      attestation_tx_hash: evidence?.attestationTxHash ?? null,
    };
  });

  // POST /claims/:claimNumber/documents/:id/verify — re-hash a file and compare
  fastify.post('/claims/:claimNumber/documents/:id/verify', async (request: FastifyRequest<{
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

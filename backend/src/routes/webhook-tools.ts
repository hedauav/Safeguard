import { FastifyInstance } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type Address, type Hash } from 'viem';
import { lookupClaim, checkDocuments, fileClaim } from '../services/claims-service.js';
import { createEscalation } from '../services/escalation-service.js';
import { scheduleCallback } from '../services/callback-service.js';
import { lookupPolicy } from '../services/policy-service.js';
import { computeEvidenceHash } from '../services/attestation-service.js';
import {
  ALLOWED_MIME_TYPES,
  MAX_DOCUMENT_BYTES,
} from '../services/claim-documents-service.js';
import { runEvidencePipeline } from '../services/evidence-pipeline.js';
import { isNotFound } from '../services/lookup-result.js';
import { referenceCandidates } from '../services/reference-number.js';
import { createEasClient, createEasSigner, issueAttestation } from '../services/eas-service.js';
import { settleClaim } from '../services/settlement-service.js';
import { SimulatedPayoutProvider } from '../services/payout-provider.js';
import { offerRenewal } from '../services/renewal-service.js';
import { createPaymentLinkProvider } from '../services/payment-link-provider.js';
import { config, features } from '../config/environment.js';

/**
 * Only a simulated rail is wired. A real provider implementing PayoutProvider
 * drops in here without the settlement rules changing. One instance per
 * process, because the simulated provider's idempotency memory lives in it.
 */
const payoutProvider = new SimulatedPayoutProvider();

/**
 * Razorpay when keys are configured, a clearly-labelled simulation otherwise.
 * One instance per process, because the simulated provider's reference memory
 * lives in it.
 */
const paymentLinkProvider = createPaymentLinkProvider({
  keyId: config.razorpayKeyId,
  keySecret: config.razorpayKeySecret,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Claims reach the tools either by internal id (from file_claim) or by the
 * number the caller reads out, which speech-to-text usually strips the dashes
 * from. Try both rather than make the agent guess which it is holding.
 */
async function findClaimByReference(supabase: SupabaseClient, reference: string) {
  const columns = 'id, claim_number, documents_required, documents_received';

  // Only attempted for something shaped like a UUID: Postgres rejects a
  // malformed one outright, and that error would mask a perfectly good claim
  // number waiting to be tried below.
  if (UUID.test(reference)) {
    const byId = await supabase.from('claims').select(columns).eq('id', reference).maybeSingle();
    if (byId.data) return byId.data;
    if (byId.error && !isNotFound(byId.error)) return null;
  }

  for (const candidate of referenceCandidates(reference)) {
    const attempt = await supabase
      .from('claims')
      .select(columns)
      .eq('claim_number', candidate)
      .maybeSingle();
    if (attempt.data) return attempt.data;
    if (attempt.error && !isNotFound(attempt.error)) return null;
  }

  return null;
}

export default async function webhookToolsRoutes(fastify: FastifyInstance) {
  // POST /tools/lookup-claim — look up a claim by claim number
  fastify.post('/tools/lookup-claim', async (request) => {
    try {
      const body = request.body as any;
      const claim_id = body.claim_id || body.claimId || body.claimNumber || body.claim_number;

      if (!claim_id) {
        return { found: false, message: 'Please provide a claim number.' };
      }

      fastify.log.info({ tool: 'lookup-claim', args: { claim_id } }, 'Tool invoked');
      const result = await lookupClaim(fastify.supabase, claim_id);
      fastify.log.info({ tool: 'lookup-claim', success: result.found }, 'Tool completed');
      return result;
    } catch (err) {
      fastify.log.error(err, 'lookup-claim tool failed');
      return { found: false, message: 'I was unable to look up that claim. Please try again.' };
    }
  });

  // POST /tools/check-policy — look up a policy by policy number
  fastify.post('/tools/check-policy', async (request) => {
    try {
      const body = request.body as any;
      const policy_number = body.policy_number || body.policyNumber;

      if (!policy_number) {
        return { found: false, message: 'Please provide a policy number.' };
      }

      fastify.log.info({ tool: 'check-policy', args: { policy_number } }, 'Tool invoked');
      const result = await lookupPolicy(fastify.supabase, policy_number);
      fastify.log.info({ tool: 'check-policy', success: result.found }, 'Tool completed');
      return result;
    } catch (err) {
      fastify.log.error(err, 'check-policy tool failed');
      return { found: false, message: 'I was unable to look up that policy. Please try again.' };
    }
  });

  // POST /tools/check-documents — check documents for a claim by claim number
  fastify.post('/tools/check-documents', async (request) => {
    try {
      const body = request.body as any;
      const claim_id = body.claim_id || body.claimId || body.claimNumber || body.claim_number;

      if (!claim_id) {
        return { found: false, message: 'Please provide a claim number.' };
      }

      fastify.log.info({ tool: 'check-documents', args: { claim_id } }, 'Tool invoked');
      const result = await checkDocuments(fastify.supabase, claim_id);
      fastify.log.info({ tool: 'check-documents', success: result.found }, 'Tool completed');
      return result;
    } catch (err) {
      fastify.log.error(err, 'check-documents tool failed');
      return { found: false, message: 'I was unable to check the documents for that claim. Please try again.' };
    }
  });

  // POST /tools/file-claim — file a new insurance claim
  fastify.post('/tools/file-claim', async (request) => {
    try {
      const body = request.body as any;

      const policy_number = body.policy_number || body.policyNumber;
      const incident_description = body.incident_description || body.incidentDescription;
      const claim_type = body.claim_type || body.claimType || 'auto';
      const incident_date = body.incident_date || body.incidentDate || new Date().toISOString();

      if (!policy_number || !incident_description) {
        return {
          success: false,
          message: 'I need at least a policy number and description of the incident to file a claim.',
        };
      }

      const args = { policy_number, claim_type, incident_date, incident_description };
      fastify.log.info({ tool: 'file-claim', args }, 'Tool invoked');
      const result = await fileClaim(fastify.supabase, args);

      if (!result.success || !result.claim_id) {
        fastify.log.info({ tool: 'file-claim', success: false }, 'Tool completed');
        return result;
      }

      // The claim is already filed and confirmed to the caller. Evidence archival
      // runs in the background so a slow or unavailable Filecoin provider never
      // stalls a live phone conversation.
      const claimId = result.claim_id;
      runEvidencePipeline(fastify, { claimId }).catch((err) => {
        fastify.log.error({ err, claimId }, 'Background evidence pipeline failed');
      });

      fastify.log.info({ tool: 'file-claim', success: true }, 'Tool completed');
      return result;
    } catch (error) {
      fastify.log.error(error, 'Error in file-claim');
      return {
        success: false,
        message: 'I was unable to file the claim right now. Please try again or I can transfer you to an agent.',
      };
    }
  });

  // POST /tools/settle-claim — release the settlement payout on an approved claim
  fastify.post('/tools/settle-claim', async (request) => {
    try {
      const body = request.body as any;
      const claim_id = body.claim_id || body.claimId || body.claimNumber || body.claim_number;

      // Deliberately the only parameter. The amount is computed from the claim
      // and the policy inside settleClaim, so no caller — the voice agent
      // included — is in a position to name a figure.
      if (!claim_id) {
        return {
          success: false,
          reason: 'claim_not_found',
          payout_id: null,
          message: 'Please provide a claim number.',
        };
      }

      fastify.log.info({ tool: 'settle-claim', args: { claim_id } }, 'Tool invoked');
      const result = await settleClaim(fastify.supabase, payoutProvider, claim_id, {
        autoApproveLimit: config.settlementAutoApproveLimit,
      });
      fastify.log.info(
        { tool: 'settle-claim', success: result.success, reason: result.reason },
        'Tool completed'
      );
      return result;
    } catch (error) {
      fastify.log.error(error, 'Error in settle-claim');
      return {
        success: false,
        reason: 'payout_failed',
        payout_id: null,
        message: 'I was unable to release that payment right now. Let me connect you with a representative.',
      };
    }
  });

  // POST /tools/offer-renewal — payment link for the premium on a lapsed policy
  fastify.post('/tools/offer-renewal', async (request) => {
    try {
      const body = request.body as any;
      const policy_number = body.policy_number || body.policyNumber || body.policyId || body.policy_id;

      // Deliberately the only parameter. The premium, the term and the ceiling
      // all come from the policy and from config inside offerRenewal, so no
      // caller — the voice agent included — can name a figure or a term.
      if (!policy_number) {
        return {
          success: false,
          reason: 'policy_not_found',
          payment_link_id: null,
          payment_link_url: null,
          message: 'Please provide a policy number.',
        };
      }

      fastify.log.info({ tool: 'offer-renewal', args: { policy_number } }, 'Tool invoked');
      const result = await offerRenewal(fastify.supabase, paymentLinkProvider, policy_number, {
        termMonths: config.renewalTermMonths,
        maxLinkAmount: config.renewalMaxLinkAmount,
      });
      fastify.log.info(
        { tool: 'offer-renewal', success: result.success, reason: result.reason },
        'Tool completed'
      );
      return result;
    } catch (error) {
      fastify.log.error(error, 'Error in offer-renewal');
      return {
        success: false,
        reason: 'link_failed',
        payment_link_id: null,
        payment_link_url: null,
        message: 'I was unable to set up a renewal payment right now. Let me connect you with a representative.',
      };
    }
  });

  // POST /tools/escalate-to-human — escalate call to a human supervisor
  fastify.post('/tools/escalate-to-human', async (request) => {
    try {
      const body = request.body as { reason: string; priority?: string };
      if (!body.reason) {
        return {
          success: false,
          message: 'Could you tell me the reason you would like to speak with a supervisor?',
        };
      }
      fastify.log.info({ tool: 'escalate-to-human', args: { reason: body.reason, priority: body.priority } }, 'Tool invoked');
      const result = await createEscalation(fastify.supabase, body);
      fastify.log.info({ tool: 'escalate-to-human', success: result.success }, 'Tool completed');
      return result;
    } catch (error) {
      fastify.log.error(error, 'Error in escalate-to-human');
      return {
        success: false,
        message: 'I was unable to create the escalation. Please hold while I try again.',
      };
    }
  });

  // POST /tools/schedule-callback — schedule a callback for the customer
  fastify.post('/tools/schedule-callback', async (request) => {
    try {
      const body = request.body as {
        phone_number: string;
        preferred_time: string;
        reason?: string;
      };
      if (!body.phone_number) {
        return { success: false, message: 'I need a phone number to schedule the callback.' };
      }
      if (!body.preferred_time?.trim()) {
        return { success: false, message: 'When would you like us to call you back?' };
      }
      fastify.log.info({ tool: 'schedule-callback', args: { phone_number: body.phone_number, preferred_time: body.preferred_time } }, 'Tool invoked');
      const result = await scheduleCallback(fastify.supabase, body);
      fastify.log.info({ tool: 'schedule-callback', success: result.success }, 'Tool completed');
      return result;
    } catch (error) {
      fastify.log.error(error, 'Error in schedule-callback');
      return {
        success: false,
        message: 'I was unable to schedule the callback. Can I try a different time?',
      };
    }
  });

  // POST /tools/attach-document — tell the caller what is still outstanding
  // and where to send it.
  //
  // Deliberately no file and no URL. A voice agent cannot see bytes, so
  // anything it "attached" would be an unverified pointer recorded as
  // evidence — which is exactly how v1 ended up anchoring documents nobody had
  // ever stored. Bytes go to POST /api/claims/:claimNumber/documents, which
  // hashes what it actually receives.
  fastify.post('/tools/attach-document', async (request) => {
    try {
      const body = request.body as {
        claim_id?: string;
        claim_number?: string;
        claimNumber?: string;
        document_type?: string;
        file_type?: string;
        file_url?: string;
      };
      const claimRef = body.claim_number || body.claimNumber || body.claim_id;
      const documentType = (body.document_type || body.file_type || '').trim();

      if (!claimRef) {
        return { success: false, message: 'I need a claim number before I can tell you what to send.' };
      }

      fastify.log.info({ tool: 'attach-document', args: { claim_id: claimRef, documentType } }, 'Tool invoked');

      const claim = await findClaimByReference(fastify.supabase, claimRef);
      if (!claim) {
        return { success: false, message: 'Claim not found.' };
      }

      const { data: uploaded } = await fastify.supabase
        .from('claim_documents')
        .select('document_type, content_hash, storage_status')
        .eq('claim_id', claim.id);

      const required: string[] = claim.documents_required ?? [];
      const received: string[] = claim.documents_received ?? [];
      const held = new Set((uploaded ?? []).map((row: any) => row.document_type));
      const missing = required.filter((doc) => !received.includes(doc) && !held.has(doc));

      const humanize = (doc: string) => doc.replace(/_/g, ' ');
      const uploadUrl = `${request.protocol}://${request.host}/api/claims/${encodeURIComponent(claim.claim_number)}/documents`;

      // The type the caller named, checked against what the claim asks for, so
      // the agent can correct them on the call instead of at upload time.
      const typeIsWanted = documentType ? required.includes(documentType) : null;

      let message: string;
      if (documentType && typeIsWanted === false) {
        message = required.length
          ? `Claim ${claim.claim_number} doesn't ask for ${humanize(documentType)}. What it still needs is: ${missing.map(humanize).join(', ') || 'nothing'}.`
          : `Claim ${claim.claim_number} has no outstanding document requirements.`;
      } else if (missing.length === 0) {
        message = `We have everything we need for claim ${claim.claim_number}.`;
      } else {
        message = `For claim ${claim.claim_number} we still need: ${missing.map(humanize).join(', ')}. I'll send you a secure upload link — we fingerprint each file the moment it arrives, so it can be checked later for any alteration.`;
      }

      return {
        success: true,
        claim_number: claim.claim_number,
        documents_required: required,
        documents_missing: missing,
        // Only files whose bytes were actually received and hashed.
        documents_uploaded: (uploaded ?? []).map((row: any) => ({
          document_type: row.document_type,
          content_hash: row.content_hash,
          storage_status: row.storage_status,
        })),
        requested_type_accepted: typeIsWanted,
        upload_url: uploadUrl,
        max_bytes: MAX_DOCUMENT_BYTES,
        accepted_mime_types: [...ALLOWED_MIME_TYPES],
        // A URL is not evidence until someone fetches and hashes it, so a
        // legacy caller passing one is told plainly that it was not recorded.
        file_url_ignored: Boolean(body.file_url),
        message,
      };
    } catch (error) {
      fastify.log.error(error, 'Error in attach-document');
      return { success: false, message: 'I was unable to check the documents on that claim right now.' };
    }
  });

  // POST /tools/escalate-to-regulator — record a regulatory escalation, attested when EAS is configured
  fastify.post('/tools/escalate-to-regulator', async (request) => {
    try {
      const body = request.body as { claim_id?: string; reason?: string; priority?: string };
      if (!body.claim_id || !body.reason) {
        return { success: false, message: 'I need a claim ID and reason to escalate to a regulator.' };
      }

      const { data: claim } = await fastify.supabase
        .from('claims')
        .select('id, claim_number, customer_id, claim_type, claimed_amount')
        .eq('id', body.claim_id)
        .single();

      if (!claim) {
        return { success: false, message: 'Claim not found.' };
      }

      const evidenceHash = computeEvidenceHash({
        claim_id: claim.id,
        claim_number: claim.claim_number,
        reason: body.reason,
        claim_type: claim.claim_type,
        claimed_amount: claim.claimed_amount,
        created_at: new Date().toISOString(),
      } as any);

      // The escalation itself is the customer-facing outcome and is recorded
      // first, so an attestation failure cannot lose the complaint.
      const escalation = await createEscalation(fastify.supabase, {
        claim_id: claim.id,
        customer_id: claim.customer_id,
        reason: body.reason,
        priority: body.priority,
      });

      if (!escalation.success) {
        return escalation;
      }

      let easUid: string | null = null;
      if (features.eas) {
        try {
          const eas = await createEasClient(config.easContractAddress as Address);
          const signer = createEasSigner(config.agentPrivateKey!, config.baseSepoliaRpcUrl);
          easUid = await issueAttestation(eas, signer, {
            recipient: fastify.ethereum.account as Address,
            schema: config.easSchema!,
            schemaUid: config.easSchemaUid as Hash,
            data: [
              { name: 'claim_id', type: 'string', value: claim.id },
              { name: 'claim_number', type: 'string', value: claim.claim_number },
              { name: 'reason', type: 'string', value: body.reason },
              { name: 'evidence_hash', type: 'string', value: evidenceHash },
            ],
          });
        } catch (err) {
          fastify.log.error({ err, claimId: claim.id }, 'Regulatory EAS attestation failed');
        }
      }

      return {
        success: true,
        reference_number: escalation.reference_number,
        eas_uid: easUid,
        evidence_hash: evidenceHash,
        message: easUid
          ? `Regulatory escalation submitted with an on-chain attestation. Your reference number is ${escalation.reference_number}.`
          : `Regulatory escalation recorded. Your reference number is ${escalation.reference_number}.`,
      };
    } catch (error) {
      fastify.log.error(error, 'Error in escalate-to-regulator');
      return { success: false, message: 'I was unable to escalate to the regulator right now.' };
    }
  });
}

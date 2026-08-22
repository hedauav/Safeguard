import { FastifyInstance } from 'fastify';
import { type Address, type Hash } from 'viem';
import { lookupClaim, checkDocuments, fileClaim } from '../services/claims-service.js';
import { createEscalation } from '../services/escalation-service.js';
import { scheduleCallback } from '../services/callback-service.js';
import { lookupPolicy } from '../services/policy-service.js';
import { computeEvidenceHash } from '../services/attestation-service.js';
import { runEvidencePipeline } from '../services/evidence-pipeline.js';
import { createEasClient, createEasSigner, issueAttestation } from '../services/eas-service.js';
import { config, features } from '../config/environment.js';

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

  // POST /tools/attach-document — attach a document/photo for a claim
  fastify.post('/tools/attach-document', async (request) => {
    try {
      const body = request.body as { claim_id?: string; file_url?: string; file_type?: string };
      if (!body.claim_id || !body.file_url || !body.file_type) {
        return { success: false, message: 'I need a claim ID, file URL, and file type to attach the document.' };
      }

      fastify.log.info({ tool: 'attach-document', args: { claim_id: body.claim_id, file_type: body.file_type } }, 'Tool invoked');

      const result = await runEvidencePipeline(fastify, {
        claimId: body.claim_id,
        addDocuments: [body.file_type],
        metadata: { file_url: body.file_url, file_type: body.file_type },
      });

      if (!result) {
        return { success: false, message: 'Claim not found.' };
      }

      // The document is recorded on the claim either way; only the archival
      // location is contingent on Filecoin being reachable.
      if (!result.filecoin.ok) {
        return {
          success: true,
          cid: null,
          evidence_hash: result.evidenceHash,
          storage: 'unavailable',
          message: 'Document attached to the claim. Decentralized archival is pending.',
        };
      }

      return {
        success: true,
        cid: result.filecoin.pieceCid,
        evidence_hash: result.evidenceHash,
        storage: 'filecoin',
        message: 'Document attached and stored on Filecoin.',
      };
    } catch (error) {
      fastify.log.error(error, 'Error in attach-document');
      return { success: false, message: 'I was unable to attach the document right now.' };
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

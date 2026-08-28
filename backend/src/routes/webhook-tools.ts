import { FastifyInstance } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type Address, type Hash } from 'viem';
import {
  lookupClaim,
  checkDocuments,
  fileClaim,
  autoTriageFiledClaim,
} from '../services/claims-service.js';
// Both of these are owned by other workstreams and may not have landed yet.
// They are imported rather than stubbed on purpose: a stub that compiles is a
// stub that ships.
import { recordJourneyEvent } from '../services/journey-events-service.js';
import { explainClaimAssessment } from '../services/claim-assessment-service.js';
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
import { adjudicateClaim } from '../services/adjudication-service.js';
import { createLlmProvider } from '../services/llm-provider.js';
import { requireToolsToken } from '../plugins/tools-auth.js';
import { ONCHAIN_RATE_LIMIT, TOOL_RATE_LIMIT } from '../plugins/rate-limit.js';
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

/**
 * Groq when a key is configured, a clearly-labelled fake otherwise. One
 * instance per process; it holds nothing but a bearer header and a base URL.
 * The fake's only answer is "escalate, no model was configured", so an
 * unconfigured deployment refuses to pretend rather than refusing to run.
 */
const llmProvider = createLlmProvider({
  apiKey: config.groqApiKey,
  model: config.groqModel,
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
  // Every route in this file is agent-facing, and until now every one of them
  // was reachable by anyone who had the URL — which is committed in
  // scripts/evaluate.mjs. Both guards are registered scope-wide rather than
  // route by route so a tool added later inherits them by default instead of
  // by someone remembering.
  fastify.addHook('preHandler', requireToolsToken);

  // The token guard above works scope-wide; a rate limit cannot. @fastify/rate-limit
  // reads `route.config.rateLimit` in its own `onRoute` hook, which runs before any
  // hook added here, so an `onRoute` hook that injects a default is read too late and
  // the route silently falls back to the global 300/min ceiling. Every route below
  // therefore names its tier explicitly, and a tool added later must do the same.

  // POST /tools/lookup-claim — look up a claim by claim number
  fastify.post('/tools/lookup-claim', { config: { rateLimit: TOOL_RATE_LIMIT } }, async (request) => {
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
  fastify.post('/tools/check-policy', { config: { rateLimit: TOOL_RATE_LIMIT } }, async (request) => {
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
  fastify.post('/tools/check-documents', { config: { rateLimit: TOOL_RATE_LIMIT } }, async (request) => {
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

  // POST /tools/file-claim — file a new insurance claim.
  // Filing kicks off a Filecoin upload and a Base Sepolia attestation, so each
  // call spends real testnet funds from the agent wallet. The tighter ceiling
  // is what bounds the bill if the token ever leaks.
  fastify.post('/tools/file-claim', { config: { rateLimit: ONCHAIN_RATE_LIMIT } }, async (request) => {
    try {
      const body = request.body as any;

      const policy_number = body.policy_number || body.policyNumber;
      const incident_description = body.incident_description || body.incidentDescription;
      // No defaults here any more. Both of these used to be filled in on the
      // way past — `claim_type` with 'auto', which no prompt and no service
      // ever promised, and `incident_date` with a full ISO timestamp where the
      // tool description promises YYYY-MM-DD. Because the route always supplied
      // a value, `claims-service.ts` could never apply its own defaults and the
      // documented behaviour was simply wrong. The service owns them now.
      const claim_type = body.claim_type || body.claimType;
      const incident_date = body.incident_date || body.incidentDate;
      // The caller's rough figure for what the damage will cost. Optional — a
      // caller who genuinely does not know still gets a claim filed — but
      // without it `adjudication-rules.ts` vetoes to `escalate` before the
      // model is even called, so every agent-filed claim was untriageable.
      // Validation lives in the service; the route only carries it across.
      const estimated_amount = body.estimated_amount ?? body.estimatedAmount;

      if (!policy_number || !incident_description) {
        return {
          success: false,
          message: 'I need at least a policy number and description of the incident to file a claim.',
        };
      }

      const args = {
        policy_number,
        claim_type,
        incident_date,
        incident_description,
        estimated_amount,
      };
      fastify.log.info({ tool: 'file-claim', args }, 'Tool invoked');
      const result = await fileClaim(fastify.supabase, args);

      if (!result.success || !result.claim_id) {
        fastify.log.info({ tool: 'file-claim', success: false }, 'Tool completed');
        return result;
      }

      // The claim is already filed and confirmed to the caller. Everything below
      // this line runs in the background for the same reason: a slow or
      // unavailable third party — Filecoin, or a language model — must never
      // stall a live phone conversation, and its failure must never lose a claim
      // the caller has already been told the number of.
      //
      // The id is hoisted into a const first and every `.catch()` is attached
      // synchronously. Neither is decoration: `result.claim_id` is typed as
      // possibly-absent and would widen inside the closure, and a rejection with
      // no handler attached in the same tick takes the process down.
      const claimId = result.claim_id;
      const claimNumber = result.claim_number;

      runEvidencePipeline(fastify, { claimId }).catch((err) => {
        fastify.log.error({ err, claimId }, 'Background evidence pipeline failed');
      });

      recordJourneyEvent(fastify.supabase, {
        claimId,
        eventType: 'claim_filed',
        actor: 'agent',
        detail: {
          claim_number: claimNumber,
          claim_type: claim_type ?? null,
          claimed_amount: result.claimed_amount ?? null,
          estimated_amount_recorded: result.estimated_amount_recorded ?? false,
        },
      }).catch((err) => {
        fastify.log.error({ err, claimId }, 'claim_filed journey event was not recorded');
      });

      // Auto-triage: adjudicate, then move the claim to `under_review` or
      // `documents_needed`. It can reach neither `approved` nor `denied` —
      // those are human acts, and the guard is in the service, not here.
      autoTriageFiledClaim(
        fastify.supabase,
        {
          adjudicate: (number) =>
            adjudicateClaim(fastify.supabase, llmProvider, number, {
              timeoutMs: config.adjudicationTimeoutMs,
              tokenPrices: {
                inputPerMTok: config.groqPriceInputPerMTok,
                outputPerMTok: config.groqPriceOutputPerMTok,
              },
            }),
          recordEvent: ({ eventType, detail }) =>
            recordJourneyEvent(fastify.supabase, {
              claimId,
              eventType,
              // `system`, not `agent`. Nobody asked for this; it happened
              // because the claim was filed.
              actor: 'system',
              detail,
            }),
        },
        claimId
      )
        .then((triage) => {
          fastify.log.info(
            {
              tool: 'file-claim',
              claimId,
              claim_number: claimNumber,
              triaged: triage.triaged,
              reason: triage.reason,
              verdict: triage.verdict,
              statusAfter: triage.status_after,
            },
            'Auto-triage completed'
          );
        })
        .catch((err) => {
          // Unreachable by design — the service returns outcomes rather than
          // throwing — which is exactly why it is worth logging loudly if it
          // ever fires. The claim stands filed either way.
          fastify.log.error({ err, claimId }, 'Background auto-triage failed');
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
  fastify.post('/tools/settle-claim', { config: { rateLimit: ONCHAIN_RATE_LIMIT } }, async (request) => {
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
      // The payment rail is handed over as well as the payout provider, and it
      // is not optional decoration. The settlement payout is simulated — see
      // payout-provider.ts — so the deductible refund that settleClaim attempts
      // straight afterwards is the ONLY movement of real money this system
      // performs. Without a rail here `settleClaim` short-circuits to
      // `no_refund_rail`: a caller whose claim was found in the other party's
      // favour was settled, told the payout was simulated, and then never
      // given back the excess they had actually paid.
      //
      // The module-scope instance is reused rather than a second one built per
      // call, for the reason its own comment gives: the simulated provider's
      // reference and receipt memory lives inside the object, so a fresh
      // instance would have forgotten every link and refund it had issued.
      // `createPaymentLinkProvider` returns a `PaymentRailProvider` — links in
      // and refunds out on the same rail — which is exactly what the refund
      // needs, since a refund can only be made against a payment that rail
      // captured.
      //
      // Nothing about the refund is decided here. No amount is passed and no
      // fault is asserted; settleClaim asks `faultWaivesDeductible` and
      // refundDeductible enforces the rest. This route only supplies the rail.
      const result = await settleClaim(fastify.supabase, payoutProvider, claim_id, {
        autoApproveLimit: config.settlementAutoApproveLimit,
        paymentRail: paymentLinkProvider,
      });
      // The refund outcome is logged alongside the settlement because it is now
      // reachable from here, and because it is the half that moves real money.
      //
      // A refused refund is spoken now — settlement-service.ts turns each reason
      // into a sentence, and separates an answer about the caller's money from a
      // failure of ours. So this log line is no longer the only trace. It stays
      // because what a caller hears and what an operator needs are different
      // things: `no_captured_payment` is deliberately silent on the call, and a
      // rail rejection needs somebody to notice it rather than a reassurance.
      // Both fields are read behind `result.success`, since a refusal carries
      // neither.
      fastify.log.info(
        {
          tool: 'settle-claim',
          success: result.success,
          reason: result.reason,
          refundSkipped: result.success ? result.deductible_refund_skipped : null,
          refundReason: result.success ? (result.deductible_refund?.reason ?? null) : null,
          refunded: result.success ? (result.deductible_refund?.success ?? false) : false,
        },
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
  fastify.post('/tools/offer-renewal', { config: { rateLimit: ONCHAIN_RATE_LIMIT } }, async (request) => {
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

  // POST /tools/adjudicate-claim — recommend whether a claim is payable
  //
  // On the on-chain tier rather than the tool tier. Nothing here touches a
  // chain, but every call that gets past the deterministic rules spends metered
  // tokens against a third-party API, and that is the property the tighter
  // ceiling exists to bound. A phone conversation adjudicates a claim once.
  fastify.post('/tools/adjudicate-claim', { config: { rateLimit: ONCHAIN_RATE_LIMIT } }, async (request) => {
    try {
      const body = request.body as any;
      const claim_id = body.claim_id || body.claimId || body.claimNumber || body.claim_number;

      // Deliberately the only parameter. The amount, the rules and the prompt
      // are all assembled inside adjudicateClaim, so no caller — the voice
      // agent included — can name a figure, skip a check, or steer the model.
      if (!claim_id) {
        return {
          success: false,
          reason: 'claim_not_found',
          verdict: null,
          adjudication_id: null,
          message: 'Please provide a claim number.',
        };
      }

      fastify.log.info({ tool: 'adjudicate-claim', args: { claim_id } }, 'Tool invoked');
      const result = await adjudicateClaim(fastify.supabase, llmProvider, claim_id, {
        timeoutMs: config.adjudicationTimeoutMs,
        tokenPrices: {
          inputPerMTok: config.groqPriceInputPerMTok,
          outputPerMTok: config.groqPriceOutputPerMTok,
        },
      });
      fastify.log.info(
        {
          tool: 'adjudicate-claim',
          success: result.success,
          verdict: result.verdict,
          vetoedBy: result.success ? result.vetoed_by : null,
          modelInvoked: result.success ? result.model_invoked : false,
          amountAgreement: result.success ? result.amount_agreement : null,
        },
        'Tool completed'
      );
      return result;
    } catch (error) {
      fastify.log.error(error, 'Error in adjudicate-claim');
      // Even the catch-all escalates. There is no path here that returns a
      // verdict favourable to paying a claim without having reached one.
      return {
        success: false,
        reason: 'records_unavailable',
        verdict: null,
        adjudication_id: null,
        message: 'I was unable to review that claim right now. Let me connect you with a representative.',
      };
    }
  });

  // POST /tools/explain-claim-assessment — what the agent is allowed to say
  //
  // `adjudicate_claim` stays unexposed to the voice agent, and this is why this
  // route exists instead. It returns only what is deterministically defensible:
  // whether the claim type is covered, the coverage limit, the deductible, the
  // computed payable amount, which documents are still outstanding, and — when
  // a deterministic rule vetoed — the name of the rule that did it.
  //
  // It must never carry the model's verdict, its confidence, or the
  // inconsistencies it thought it saw. A deterministic veto is arithmetic and
  // policy text, and the agent can defend every word of it to the caller. A
  // model's suspicion is neither, and a caller must never hear it. That
  // boundary is enforced in claim-assessment-service.ts, not by the wording
  // of a prompt.
  //
  // On the tool tier rather than the on-chain tier, and named explicitly as
  // every route in this file must be. Nothing here touches a chain and nothing
  // here spends metered tokens — it reads a policy and a claim and re-runs
  // arithmetic that has already been performed. If it ever grows a path that
  // reaches a model, this tier has to be revisited with it.
  fastify.post('/tools/explain-claim-assessment', { config: { rateLimit: TOOL_RATE_LIMIT } }, async (request) => {
    try {
      const body = request.body as any;
      const claim_id = body.claim_id || body.claimId || body.claimNumber || body.claim_number;

      // Deliberately the only parameter, for the same reason adjudicate_claim
      // takes only one: everything else is read from the records, so the agent
      // cannot name a figure, a coverage limit, or a deductible of its own.
      // Structured, and in the same shape the service's own refusals take, so
      // the agent branches on `reason` rather than on the wording of a sentence.
      if (!claim_id) {
        return {
          success: false,
          reason: 'claim_not_found',
          claim_number: null,
          message: 'Please provide a claim number.',
        };
      }

      fastify.log.info({ tool: 'explain-claim-assessment', args: { claim_id } }, 'Tool invoked');
      const result = await explainClaimAssessment(fastify.supabase, claim_id);
      fastify.log.info(
        {
          tool: 'explain-claim-assessment',
          success: result.success,
          reason: result.reason,
        },
        'Tool completed'
      );

      // What a caller was told about their own claim is part of its history.
      // If they later say "I was told it was covered for eight thousand", the
      // timeline should be able to show whether they were, and what the figures
      // were at that moment — coverage and deductibles can change afterwards.
      //
      // Only recorded when an assessment was actually given: a refusal told the
      // caller nothing, and writing one would put a conversation on the record
      // that never happened. Fired bare with .catch() attached synchronously,
      // like every other background write in this file, so a live call is never
      // held up by the timeline.
      if (result.success && result.claim_number) {
        recordJourneyEvent(fastify.supabase, {
          claimId: result.claim_id ?? null,
          eventType: 'assessment_explained',
          actor: 'agent',
          detail: {
            claim_number: result.claim_number,
            payable_amount: result.payable_amount,
            deductible: result.deductible,
            coverage_amount: result.coverage_amount,
            documents_outstanding: result.documents_outstanding,
            blocking_rule: result.blocking_rule?.id ?? null,
          },
        }).catch((err) => {
          fastify.log.error({ err, claim: result.claim_number }, 'assessment_explained not recorded');
        });
      }

      return result;
    } catch (error) {
      fastify.log.error(error, 'Error in explain-claim-assessment');
      // Says nothing about the claim. A failure here must not become a guess
      // about cover, and it must not become a hint about the outcome either.
      return {
        success: false,
        reason: 'records_unavailable',
        claim_number: null,
        message: 'I was unable to work out the assessment on that claim right now. Let me connect you with a representative.',
      };
    }
  });

  // POST /tools/escalate-to-human — escalate call to a human supervisor
  fastify.post('/tools/escalate-to-human', { config: { rateLimit: TOOL_RATE_LIMIT } }, async (request) => {
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
        // No retry follows this. Saying "hold while I try again" described a
        // second attempt that never happens, which leaves the caller waiting
        // on nothing and believing the escalation is still in progress.
        message:
          'I was not able to record the escalation, and nothing was saved. ' +
          'Please ask to speak to a supervisor directly.',
      };
    }
  });

  // POST /tools/schedule-callback — schedule a callback for the customer
  fastify.post('/tools/schedule-callback', { config: { rateLimit: TOOL_RATE_LIMIT } }, async (request) => {
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
  fastify.post('/tools/attach-document', { config: { rateLimit: TOOL_RATE_LIMIT } }, async (request) => {
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
        // There is no SMS or email sender in this backend, so the link cannot
        // be sent anywhere. It is read out on the call instead.
        message = `For claim ${claim.claim_number} we still need: ${missing.map(humanize).join(', ')}. You can upload them at ${uploadUrl} — I'll read that out for you now. We fingerprint each file the moment it arrives, so it can be checked later for any alteration.`;
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
  fastify.post('/tools/escalate-to-regulator', { config: { rateLimit: ONCHAIN_RATE_LIMIT } }, async (request) => {
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
        // Nothing here transmits anything to a regulator. The complaint is
        // recorded — and attested, when attestation is configured — so say
        // that and not "submitted".
        message: easUid
          ? `Regulatory complaint recorded, with an on-chain attestation of it. Your reference number is ${escalation.reference_number}.`
          : `Regulatory complaint recorded. Your reference number is ${escalation.reference_number}.`,
      };
    } catch (error) {
      fastify.log.error(error, 'Error in escalate-to-regulator');
      return { success: false, message: 'I was unable to escalate to the regulator right now.' };
    }
  });
}

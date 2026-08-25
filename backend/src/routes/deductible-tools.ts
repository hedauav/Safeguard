import { FastifyInstance } from 'fastify';
import { collectDeductible, refundDeductible } from '../services/deductible-service.js';
import { createPaymentLinkProvider } from '../services/payment-link-provider.js';
import { requireToolsToken } from '../plugins/tools-auth.js';
import { ONCHAIN_RATE_LIMIT } from '../plugins/rate-limit.js';
import { config } from '../config/environment.js';

/**
 * The deductible money loop, as tools the voice agent can call.
 *
 * Both endpoints here move real money on a real rail: Razorpay when keys are
 * configured, a clearly-labelled simulation otherwise. Claim settlement — the
 * payout to the claimant — is NOT here and is not real; it needs RazorpayX and
 * business KYC, and settlement-service.ts says so on every row it writes.
 */

/**
 * Razorpay when keys are configured, a clearly-labelled simulation otherwise.
 * One instance per process, because the simulated provider's reference and
 * receipt memory lives in it.
 */
const paymentRail = createPaymentLinkProvider({
  keyId: config.razorpayKeyId,
  keySecret: config.razorpayKeySecret,
});

export default async function deductibleToolsRoutes(fastify: FastifyInstance) {
  // Both routes here are agent-facing and both move money. Registered
  // scope-wide rather than route by route so a tool added later inherits the
  // guard by default instead of by someone remembering.
  fastify.addHook('preHandler', requireToolsToken);

  // The token guard works scope-wide; a rate limit cannot. @fastify/rate-limit
  // reads `route.config.rateLimit` in its own `onRoute` hook, which runs before
  // any hook added here, so each route names its tier explicitly.

  // POST /tools/collect-deductible — payment link for the deductible on a claim
  fastify.post(
    '/tools/collect-deductible',
    { config: { rateLimit: ONCHAIN_RATE_LIMIT } },
    async (request) => {
      try {
        const body = request.body as any;
        const claim_id =
          body?.claim_id || body?.claimId || body?.claimNumber || body?.claim_number;

        // Deliberately the only parameter. The deductible comes off the policy
        // inside collectDeductible and the ceiling comes from config, so no
        // caller — the voice agent included — can name a figure.
        if (!claim_id) {
          return {
            success: false,
            reason: 'claim_not_found',
            payment_link_id: null,
            payment_link_url: null,
            message: 'Please provide a claim number.',
          };
        }

        fastify.log.info({ tool: 'collect-deductible', args: { claim_id } }, 'Tool invoked');
        const result = await collectDeductible(fastify.supabase, paymentRail, claim_id, {
          maxLinkAmount: config.deductibleMaxLinkAmount,
        });
        fastify.log.info(
          {
            tool: 'collect-deductible',
            success: result.success,
            reason: result.reason,
            reused: result.success ? result.reused : null,
            simulated: result.success ? result.simulated : null,
          },
          'Tool completed'
        );
        return result;
      } catch (error) {
        fastify.log.error(error, 'Error in collect-deductible');
        return {
          success: false,
          reason: 'link_failed',
          payment_link_id: null,
          payment_link_url: null,
          message:
            "I wasn't able to set up a deductible payment right now. Nothing has been charged. Let me connect you with a representative.",
        };
      }
    }
  );

  // POST /tools/refund-deductible — waive the deductible on a not-at-fault claim
  //
  // This waives and refunds the deductible. It does not settle the claim, and
  // nothing it returns should be read as if it did.
  fastify.post(
    '/tools/refund-deductible',
    { config: { rateLimit: ONCHAIN_RATE_LIMIT } },
    async (request) => {
      try {
        const body = request.body as any;
        const claim_id =
          body?.claim_id || body?.claimId || body?.claimNumber || body?.claim_number;

        if (!claim_id) {
          return {
            success: false,
            reason: 'claim_not_found',
            refund_id: null,
            message: 'Please provide a claim number.',
          };
        }

        // No amount is passed through. refundDeductible defaults to the full
        // captured deductible, so the only figure a phone call can produce is
        // the money that actually came in.
        fastify.log.info({ tool: 'refund-deductible', args: { claim_id } }, 'Tool invoked');
        const result = await refundDeductible(fastify.supabase, paymentRail, claim_id);
        fastify.log.info(
          {
            tool: 'refund-deductible',
            success: result.success,
            reason: result.reason,
            simulated: result.success ? result.simulated : null,
          },
          'Tool completed'
        );
        return result;
      } catch (error) {
        fastify.log.error(error, 'Error in refund-deductible');
        // The catch-all refuses. There is no path here that reports money
        // returned without a refund id from the rail to show for it.
        return {
          success: false,
          reason: 'refund_failed',
          refund_id: null,
          message:
            "I wasn't able to process a deductible refund right now. Nothing has changed. Let me connect you with a representative.",
        };
      }
    }
  );
}

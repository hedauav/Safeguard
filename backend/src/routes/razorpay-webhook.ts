import { FastifyInstance } from 'fastify';
import { config, features } from '../config/environment.js';
import {
  RAZORPAY_EVENT_ID_HEADER,
  RAZORPAY_SIGNATURE_HEADER,
  eventLedgerId,
  extractCapture,
  verifyRazorpaySignature,
  withinAgeLimit,
  type RazorpayEventEnvelope,
} from '../services/razorpay-webhook.js';
import { recordDeductibleCapture } from '../services/deductible-service.js';

/**
 * Razorpay's webhook.
 *
 * Until this existed the agent could create a payment link and never learn
 * whether anybody paid it — the loop was open at exactly the point where money
 * changes hands. This is the closing half: a signed delivery from Razorpay
 * saying a link was paid, verified, deduplicated, and recorded against the
 * claim so that a refund can later be made against the capture.
 *
 * Configure in the Razorpay dashboard against `payment_link.paid`, with the
 * secret in RAZORPAY_WEBHOOK_SECRET.
 */
export default async function razorpayWebhookRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/webhooks/razorpay',
    { config: { rawBody: true } },
    async (request, reply) => {
      // Razorpay signs the bytes it sent. A parsed-and-restringified body is a
      // different message and will never verify — their docs are emphatic
      // about this and it is the usual reason integrations fail.
      const rawBody = (request as any).rawBody;
      const rawPayload =
        rawBody != null
          ? rawBody.toString()
          : typeof request.body === 'string'
            ? request.body
            : JSON.stringify(request.body ?? {});

      if (features.razorpayWebhookSignatureVerification) {
        const header = request.headers[RAZORPAY_SIGNATURE_HEADER] as string | undefined;

        const verdict = verifyRazorpaySignature(
          header,
          rawPayload,
          config.razorpayWebhookSecret!
        );
        if (!verdict.valid) {
          fastify.log.warn({ reason: verdict.reason }, 'Rejected Razorpay webhook');
          return reply.status(401).send({ success: false, error: 'Invalid webhook signature' });
        }
      } else if (features.razorpayWebhookUnverifiedAccepted) {
        // Development only. Locally there is no secret to sign with, and
        // refusing here would make the capture path untestable.
        fastify.log.warn(
          'Accepting Razorpay webhook WITHOUT signature verification — set RAZORPAY_WEBHOOK_SECRET'
        );
      } else {
        // Production with no secret configured. What this handler writes is a
        // record that money arrived, and that record is what a later refund is
        // made against — so an unverifiable delivery is refused rather than
        // believed. 503, not 401: nothing the sender could do would help, the
        // server is misconfigured.
        fastify.log.error(
          'Refused Razorpay webhook: RAZORPAY_WEBHOOK_SECRET is not configured, so no delivery can be verified'
        );
        return reply.status(503).send({
          success: false,
          error: 'Webhook verification is not configured on this server.',
        });
      }

      let envelope: RazorpayEventEnvelope;
      try {
        envelope = JSON.parse(rawPayload);
      } catch {
        return reply.status(400).send({ success: false, error: 'Malformed JSON payload' });
      }

      // Razorpay's signature carries no timestamp, so this bounds how ancient a
      // replay may be. It is not the replay guard — the ledger below is — and
      // the window is deliberately wide, because Razorpay's own retries run for
      // about a day and throwing one away loses a capture.
      if (!withinAgeLimit(envelope)) {
        fastify.log.warn(
          { event: envelope.event, createdAt: envelope.created_at },
          'Rejected Razorpay webhook older than the age limit'
        );
        return reply.status(400).send({ success: false, error: 'Event is too old to process' });
      }

      const extraction = extractCapture(envelope);

      if (extraction.kind === 'ignored') {
        // Authentic, just not a deductible capture — a cancellation, an
        // expiry, or an event for some other product on the same account.
        // 200 so Razorpay stops retrying something we will never act on.
        fastify.log.info(
          { event: envelope.event, reason: extraction.reason },
          'Razorpay webhook acknowledged without recording'
        );
        return reply.status(200).send({ success: true, recorded: false, reason: extraction.reason });
      }

      const ledgerId = eventLedgerId(
        request.headers[RAZORPAY_EVENT_ID_HEADER] as string | undefined,
        rawPayload
      );

      try {
        const result = await recordDeductibleCapture(
          fastify.supabase,
          extraction.capture,
          ledgerId,
          envelope
        );

        fastify.log.info(
          {
            event: extraction.capture.event,
            outcome: result.outcome,
            claimId: result.claim_id,
            paymentId: result.payment_id,
          },
          'Razorpay capture processed'
        );

        if (result.outcome === 'write_failed') {
          // 500 so Razorpay retries. The ledger row is written only after a
          // successful update, so a retry re-applies rather than being skipped.
          return reply.status(500).send({
            success: false,
            error: 'Could not record the payment. Please retry.',
          });
        }

        // Everything else is a settled answer — recorded, a replay, a link we
        // did not issue, or a capture we refuse to believe. All 200: retrying
        // would not change any of them.
        return reply.status(200).send({
          success: true,
          recorded: result.outcome === 'recorded',
          outcome: result.outcome,
          detail: result.detail,
        });
      } catch (error) {
        fastify.log.error(error, 'Error processing Razorpay webhook');
        return reply.status(500).send({ success: false, error: 'Failed to process webhook' });
      }
    }
  );
}

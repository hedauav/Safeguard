import { FastifyInstance } from 'fastify';
import { config, features } from '../config/environment.js';
import {
  RAZORPAY_EVENT_ID_HEADER,
  RAZORPAY_SIGNATURE_HEADER,
  eventLedgerId,
  extractPaymentEvent,
  verifyRazorpaySignature,
  withinAgeLimit,
  type RazorpayEventEnvelope,
} from '../services/razorpay-webhook.js';
import { recordDeductibleCapture } from '../services/deductible-service.js';
import { recordRenewalCapture, recordRenewalFailure } from '../services/renewal-service.js';

/**
 * Razorpay's webhook.
 *
 * Until this existed the agent could create a payment link and never learn
 * whether anybody paid it — the loop was open at exactly the point where money
 * changes hands. This is the closing half: a signed delivery from Razorpay
 * saying a link was paid, verified, deduplicated, and recorded against the
 * claim so that a refund can later be made against the capture.
 *
 * ONE DELIVERY, TWO POSSIBLE MEANINGS. Deductible links and renewal links live
 * in the same Razorpay account and produce byte-identical event shapes. The
 * only thing that tells them apart is the payment link id, and the only way to
 * resolve it is to ask each table in turn — so the dispatch below tries the
 * deductible handler, and when it says `unknown_link` tries the renewal one.
 * Neither handler will touch a link the other issued: that is what
 * `unknown_link` means, and it is why the order is safe rather than lucky.
 *
 * Configure in the Razorpay dashboard against `payment_link.paid`,
 * `payment.failed` and `payment_link.expired`, with the secret in
 * RAZORPAY_WEBHOOK_SECRET.
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

      const extraction = extractPaymentEvent(envelope);

      if (extraction.kind === 'ignored') {
        // Authentic, just not something we act on — a cancellation, a refund
        // notification, or an event for some other product on the same
        // account. 200 so Razorpay stops retrying something we never will.
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
        if (extraction.kind === 'failure') {
          // The money did not arrive. Nothing here changes a policy or a
          // claim — there is no consequence to record beyond the fact itself,
          // and inventing one would be worse than the silence this replaced.
          const failed = await recordRenewalFailure(
            fastify.supabase,
            extraction.failure,
            ledgerId,
            envelope
          );

          fastify.log.info(
            {
              event: extraction.failure.event,
              outcome: failed.outcome,
              policyId: failed.policy_id,
              paymentLinkId: failed.payment_link_id,
              reason: failed.reason,
            },
            'Razorpay payment failure processed'
          );

          if (failed.outcome === 'write_failed') {
            return reply.status(500).send({
              success: false,
              error: 'Could not record the payment failure. Please retry.',
            });
          }

          // `unknown_link` here means the failed link was a deductible's, or
          // something else on the account. It is acknowledged and logged but
          // not written to a row: `deductible_payments` is owned by the
          // deductible service and this route will not reach around it.
          return reply.status(200).send({
            success: true,
            recorded: failed.outcome === 'recorded',
            outcome: failed.outcome,
            detail: failed.detail,
          });
        }

        const deductible = await recordDeductibleCapture(
          fastify.supabase,
          extraction.capture,
          ledgerId,
          envelope
        );

        if (deductible.outcome !== 'unknown_link') {
          fastify.log.info(
            {
              event: extraction.capture.event,
              outcome: deductible.outcome,
              claimId: deductible.claim_id,
              paymentId: deductible.payment_id,
            },
            'Razorpay deductible capture processed'
          );

          if (deductible.outcome === 'write_failed') {
            // 500 so Razorpay retries. The ledger row is written only after a
            // successful update, so a retry re-applies rather than being
            // skipped.
            return reply.status(500).send({
              success: false,
              error: 'Could not record the payment. Please retry.',
            });
          }

          // Everything else is a settled answer — recorded, a replay, or a
          // capture we refuse to believe. All 200: retrying changes none of
          // them.
          return reply.status(200).send({
            success: true,
            recorded: deductible.outcome === 'recorded',
            kind: 'deductible',
            outcome: deductible.outcome,
            detail: deductible.detail,
          });
        }

        // Not a deductible link. The same delivery may still be a renewal
        // premium — the second half of the dispatch. Note that the deductible
        // handler wrote no ledger row on its way out, so this handler's own
        // replay check still works.
        const renewal = await recordRenewalCapture(
          fastify.supabase,
          extraction.capture,
          ledgerId,
          envelope
        );

        fastify.log.info(
          {
            event: extraction.capture.event,
            outcome: renewal.outcome,
            policyId: renewal.policy_id,
            paymentId: renewal.payment_id,
            newEndDate: renewal.new_end_date,
            policyActivated: renewal.policy_activated,
          },
          'Razorpay renewal capture processed'
        );

        if (renewal.outcome === 'write_failed' || renewal.outcome === 'activation_failed') {
          // Both mean a step did not land and the ledger row was not written,
          // so Razorpay's retry re-enters and re-applies. `activation_failed`
          // is the one that matters most: the customer has paid and the policy
          // is not yet back in force.
          return reply.status(500).send({
            success: false,
            error: 'Could not record the payment. Please retry.',
          });
        }

        if (renewal.outcome === 'unknown_link') {
          // Neither a deductible nor a renewal. Authentic, and none of our
          // business — 200, so Razorpay stops asking.
          fastify.log.warn(
            {
              event: extraction.capture.event,
              paymentLinkId: extraction.capture.paymentLinkId,
              paymentId: extraction.capture.paymentId,
            },
            'Razorpay capture matched no deductible and no renewal'
          );
          return reply.status(200).send({
            success: true,
            recorded: false,
            outcome: 'unknown_link',
            detail: 'this payment link belongs to no deductible or renewal we issued',
          });
        }

        return reply.status(200).send({
          success: true,
          recorded: renewal.outcome === 'recorded',
          kind: 'renewal',
          outcome: renewal.outcome,
          policy_activated: renewal.policy_activated,
          new_end_date: renewal.new_end_date,
          detail: renewal.detail,
        });
      } catch (error) {
        fastify.log.error(error, 'Error processing Razorpay webhook');
        return reply.status(500).send({ success: false, error: 'Failed to process webhook' });
      }
    }
  );
}

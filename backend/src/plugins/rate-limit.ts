import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import { FastifyInstance } from 'fastify';
import { config } from '../config/environment.js';

/**
 * Per-IP request ceilings.
 *
 * The shared secret is what keeps strangers out; this is what bounds the
 * damage if it ever leaks, and what stops an unauthenticated flood from
 * costing anything at all. The counters live in process memory, which is
 * correct for a single-instance deployment — running more than one replica
 * would need a shared store (Redis) or each replica enforces its own share.
 */

/** All limits are expressed per minute. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Tool endpoints. Generous rather than tight on purpose: ElevenLabs calls out
 * from shared egress addresses, so one IP legitimately carries every concurrent
 * conversation, and a limit sized for a single caller would throttle real ones.
 */
export const TOOL_RATE_LIMIT = {
  max: config.rateLimitToolsMax,
  timeWindow: RATE_LIMIT_WINDOW_MS,
};

/**
 * The handful of routes that spend money: a Filecoin upload and a Base Sepolia
 * write on filing, a payout on settlement, a payment link on renewal, an EAS
 * attestation on a regulatory escalation, and metered model tokens on
 * adjudication. No phone conversation reaches this rate, so anything that does
 * is abuse or a loop.
 */
export const ONCHAIN_RATE_LIMIT = {
  max: config.rateLimitOnchainMax,
  timeWindow: RATE_LIMIT_WINDOW_MS,
};

export default fp(async function rateLimitPlugin(fastify: FastifyInstance) {
  await fastify.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: RATE_LIMIT_WINDOW_MS,
    // The platform polls these to decide whether the service is alive. Throttling
    // them would turn a burst of traffic into a reported outage.
    allowList: (request) => request.url === '/health' || request.url === '/version',
    // The object returned here is thrown by the plugin, so it must carry
    // `statusCode` itself. Without it Fastify's generic error handler sees an
    // unclassified throw and answers 500 — a rejection that reads as a server
    // fault, which is exactly the wrong signal to give a client that should
    // back off. The `retry-after` header is set by the plugin either way.
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      data: null,
      error: `Too many requests. Retry in ${context.after}.`,
    }),
  });
}, {
  name: 'rate-limit',
});

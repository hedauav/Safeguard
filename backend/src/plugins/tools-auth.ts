import type { FastifyReply, FastifyRequest } from 'fastify';
import { config, features } from '../config/environment.js';
import { checkToolsToken } from '../services/tools-token.js';

/**
 * preHandler guard for every endpoint the voice agent (and only the voice
 * agent) is meant to reach.
 *
 * Wired as a scope-wide hook rather than per handler wherever a whole route
 * file is agent-facing, so a tool added later is protected by default instead
 * of by remembering.
 *
 * The decision itself is in services/tools-token.ts; this only translates it
 * into a reply, in the same shape agent-config.ts uses for its admin guard.
 */
export async function requireToolsToken(request: FastifyRequest, reply: FastifyReply) {
  const verdict = checkToolsToken(request.headers as Record<string, unknown>, {
    expected: config.toolsApiToken,
    allowUnauthenticated: features.toolsUnauthenticatedAccepted,
  });

  if (!verdict.ok) {
    request.log.warn(
      { url: request.url, reason: verdict.reason },
      'Rejected tool request without a valid token'
    );
    return reply.code(verdict.status).send({ data: null, error: verdict.message });
  }
}

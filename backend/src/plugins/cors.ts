import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import { FastifyInstance } from 'fastify';
import { config } from '../config/environment.js';

/**
 * `origin: true` reflected whatever Origin arrived and paired it with
 * `credentials: true`, which is the combination browsers treat as "this API
 * trusts every site on the internet with the visitor's cookies". The allowlist
 * below is the configured dashboard origin and nothing else.
 */

/** Compare origins, not URLs: a trailing slash or a path would never match. */
function toOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Any localhost port, in development only. Vite moves off 5173 when the port
 * is taken, and a dashboard that silently stops loading is worse than useless
 * to whoever is debugging it.
 */
const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/;

export function allowedOrigins(): string[] {
  const configured = toOrigin(config.frontendUrl);
  return configured ? [configured] : [];
}

export function isOriginAllowed(origin: string): boolean {
  if (allowedOrigins().includes(origin)) return true;
  return config.nodeEnv !== 'production' && LOCALHOST.test(origin);
}

export default fp(async function corsPlugin(fastify: FastifyInstance) {
  await fastify.register(cors, {
    origin: (origin, callback) => {
      // No Origin header at all: ElevenLabs' tool webhooks, the evaluation
      // harness, curl, health checks. CORS was never what protected those —
      // the shared-secret guard is — and refusing them here would break the
      // agent without closing anything.
      if (!origin) return callback(null, true);
      callback(null, isOriginAllowed(origin));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
  });
}, {
  name: 'cors',
});

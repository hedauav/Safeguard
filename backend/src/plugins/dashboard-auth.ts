import type { FastifyReply, FastifyRequest } from 'fastify';
import { config, features } from '../config/environment.js';
import {
  DASHBOARD_AUTH_CHALLENGE_HEADER,
  checkDashboardSession,
} from '../services/dashboard-session.js';

/**
 * preHandler guard for every endpoint an adjuster reaches and a stranger
 * should not.
 *
 * Wired as a scope-wide hook wherever a whole route file is dashboard-facing,
 * so a read added to that file later is protected by default rather than by
 * somebody remembering. `calls.ts` is the one exception: it holds the
 * agent-facing tool-execution write alongside the two dashboard reads, so
 * there the guard is named per route and the tools token keeps its own.
 *
 * What is deliberately NOT behind this guard, and why, since a guard is only
 * as legible as its exceptions:
 *
 *  - `/health`, `/version` and `/` — liveness and build identity. The platform
 *    polls them and they carry no customer data.
 *  - `/api/evidence/recent` and `/api/evidence/verify` — the reviewer's entry
 *    point and the reconciliation against Razorpay. Both exist to be checked
 *    by someone outside this project holding no credential at all; a proof
 *    behind a password is not a proof.
 *  - `POST /api/claims/:claimNumber/documents` and its `/verify` sibling — the
 *    call widget in a claimant's browser posts to them mid-conversation. They
 *    could never carry a secret, which is why they carry a tight rate limit
 *    instead.
 *  - Everything behind `requireToolsToken`, plus both webhooks. Those already
 *    authenticate, as the voice agent or as a signature over the raw body, and
 *    stacking a browser session on top would only break callers that hold no
 *    browser.
 *
 * The decision itself is in services/dashboard-session.ts; this only
 * translates it into a reply, in the same shape tools-auth.ts uses.
 */
export async function requireDashboardAuth(request: FastifyRequest, reply: FastifyReply) {
  const verdict = checkDashboardSession(request.headers as Record<string, unknown>, {
    sessionSecret: features.dashboardAuth ? config.dashboardSessionSecret : null,
    adminToken: config.adminToken,
    allowUnauthenticated: features.dashboardUnauthenticatedAccepted,
  });

  if (!verdict.ok) {
    request.log.warn(
      { url: request.url, reason: verdict.reason },
      'Rejected dashboard request without a valid session'
    );
    // The marker the browser reads to tell "your session ran out" apart from
    // "that admin token is wrong". Both are a bare 401 otherwise, and the
    // dashboard would sign the operator out every time they mistyped the admin
    // token on the agent-config page.
    reply.header(DASHBOARD_AUTH_CHALLENGE_HEADER, verdict.reason);
    return reply.code(verdict.status).send({ data: null, error: verdict.message });
  }
}

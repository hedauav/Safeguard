import { FastifyInstance, FastifyRequest } from 'fastify';
import { config, features } from '../config/environment.js';
import {
  DASHBOARD_TOKEN_HEADER,
  DASHBOARD_SESSION_TTL_MS,
  checkDashboardPassword,
} from '../services/dashboard-session.js';
import { ONCHAIN_RATE_LIMIT } from '../plugins/rate-limit.js';

/**
 * Sign-in for the adjuster dashboard.
 *
 * Two endpoints and no more: one that asks the server what it wants, and one
 * that hands it a password. There is no logout endpoint, because there is
 * nothing on the server to log out of — a token is an HMAC over an expiry, not
 * a row, so signing out is the browser forgetting the string it holds. Saying
 * otherwise with a route that returns 200 and changes nothing would be a
 * promise this design cannot keep; the lever that actually revokes a live
 * session is rotating DASHBOARD_SESSION_SECRET, which revokes all of them.
 *
 * Neither endpoint is behind `requireDashboardAuth`, for the obvious reason.
 * They are behind the tightest rate limit this API has instead.
 */

/**
 * The on-chain tier — the tightest ceiling already configured, 15/min per IP by
 * default — reused here rather than a new one invented.
 *
 * It is the right shape for a different reason than it is there. Nothing here
 * spends anything; what it bounds is guessing. A human signing in gets one
 * attempt every four seconds and never notices, and an unattended script
 * pointed at this URL exhausts a per-minute allowance instead of a password
 * space. The comparison inside is constant-time, so the limit is the only
 * thing standing between a wrong guess and the next one.
 */
const LOGIN_RATE_LIMIT = ONCHAIN_RATE_LIMIT;

export default async function authRoutes(fastify: FastifyInstance) {
  /**
   * GET /auth/status — what the server expects, before anybody types anything.
   *
   * The browser cannot tell a dashboard that wants a password from one that
   * does not by trying an endpoint and reading a 401: in development an
   * unconfigured deployment answers every request happily, and a login screen
   * offered there would ask for a password that can never be right. So the
   * server says which of the three it is, and the dashboard renders
   * accordingly.
   *
   * Nothing secret is disclosed. `required` is a boolean derived from whether
   * two variables are set; neither value, nor its length, nor its prefix is
   * read here.
   */
  fastify.get('/auth/status', async () => ({
    data: {
      /** Whether a password buys anything. False means there is none to check. */
      required: features.dashboardAuth,
      /**
       * True only in the development carve-out, where an unconfigured server
       * serves dashboard reads to anyone. Stated out loud so the browser can
       * say so on screen rather than presenting an open deployment as a
       * secured one.
       */
      open: features.dashboardUnauthenticatedAccepted,
      /** How long a freshly issued session lasts, so the browser can expire it locally. */
      session_ttl_seconds: DASHBOARD_SESSION_TTL_MS / 1000,
      /** The header a session token must be sent in. */
      token_header: DASHBOARD_TOKEN_HEADER,
      /**
       * Whether an ADMIN_TOKEN is configured. The agent-config and decision
       * writes need one in addition to a session, and a dashboard that cannot
       * tell whether the server has one would offer an edit form that can only
       * ever answer 503.
       */
      admin_token_configured: features.agentConfigEditing,
    },
    error: null,
  }));

  /**
   * POST /auth/login — a password in, a session token out.
   *
   * The token comes back in the body rather than a Set-Cookie header. A cookie
   * would be sent automatically on every cross-site request the browser makes
   * to this API, which is the property CSRF is built on; a token the page has
   * to attach by hand is attached only where this code attaches it. The API is
   * already cross-origin from the dashboard (Vercel to Railway), so a cookie
   * would additionally have to be SameSite=None to work at all — the exact
   * setting that removes the browser's own protection.
   */
  fastify.post(
    '/auth/login',
    { config: { rateLimit: LOGIN_RATE_LIMIT } },
    async (request: FastifyRequest<{ Body: { password?: unknown } }>, reply) => {
      const verdict = checkDashboardPassword((request.body ?? {}).password, {
        expected: config.dashboardPassword,
        sessionSecret: config.dashboardSessionSecret,
      });

      if (!verdict.ok) {
        // The password itself is never logged, and neither is its length. What
        // is worth recording is that somebody is guessing.
        request.log.warn({ reason: verdict.reason }, 'Rejected a dashboard sign-in');
        reply.code(verdict.status);
        return { data: null, error: verdict.message };
      }

      return {
        data: {
          token: verdict.token,
          /** Milliseconds since the epoch, the same units the token itself signs. */
          expires_at: verdict.expiresAt,
          token_header: DASHBOARD_TOKEN_HEADER,
        },
        error: null,
      };
    }
  );
}

import crypto from 'crypto';

/**
 * Shared-secret check for the endpoints the ElevenLabs agent calls.
 *
 * These endpoints are not merely reads: `file-claim` spends real testnet ETH
 * on a Base Sepolia attestation and pays for a Filecoin upload, `settle-claim`
 * releases a payout, and `conversation-init` returns a customer's name, policy
 * number and claim history for any phone number handed to it. Left open, the
 * URL alone is enough for a stranger to drain the agent wallet or mine the
 * customer table.
 *
 * The logic lives here, free of any config import, so it can be unit tested
 * without the environment the server needs to boot.
 */

/**
 * Header the ElevenLabs agent is configured to send on every tool call — its
 * webhook tools take arbitrary request headers, so this is the one it carries.
 * `Authorization: Bearer …` is accepted as well, because curl, the evaluation
 * harness and anything else hand-driven reach for that form first.
 */
export const TOOLS_TOKEN_HEADER = 'x-tools-token';

export type ToolsAuthVerdict =
  | { ok: true; reason: 'valid' | 'development_bypass' }
  | { ok: false; status: 401 | 503; reason: 'not_configured' | 'invalid'; message: string };

/** Case-insensitive header lookup — Fastify lowercases, other callers may not. */
function header(headers: Record<string, unknown>, name: string): string {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct) && typeof direct[0] === 'string') return direct[0];
  return '';
}

/** The token a request presented, from either accepted header. */
export function presentedToken(headers: Record<string, unknown>): string {
  const explicit = header(headers, TOOLS_TOKEN_HEADER).trim();
  if (explicit) return explicit;

  const authorization = header(headers, 'authorization').trim();
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

/**
 * Constant-time comparison. The length check has to come first because
 * timingSafeEqual throws on mismatched buffer lengths, and a thrown error
 * would leak the secret's length as surely as an early return would.
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Decide whether a request may reach a token-guarded endpoint.
 *
 * With no token configured the answer depends on where this is running:
 * production fails closed (503, the endpoint is disabled rather than open),
 * development falls open so `npm run dev` works out of the box. That asymmetry
 * is the whole point — a misconfigured production deployment must not quietly
 * behave like the old unauthenticated one.
 */
export function checkToolsToken(
  headers: Record<string, unknown>,
  options: { expected: string | null; allowUnauthenticated: boolean }
): ToolsAuthVerdict {
  if (!options.expected) {
    if (options.allowUnauthenticated) {
      return { ok: true, reason: 'development_bypass' };
    }
    return {
      ok: false,
      status: 503,
      reason: 'not_configured',
      message: 'This endpoint is disabled: TOOLS_API_TOKEN is not configured on the server.',
    };
  }

  const provided = presentedToken(headers);
  if (!provided || !tokenMatches(provided, options.expected)) {
    return {
      ok: false,
      status: 401,
      reason: 'invalid',
      message: `Invalid or missing tool token. Send it as ${TOOLS_TOKEN_HEADER} or Authorization: Bearer.`,
    };
  }

  return { ok: true, reason: 'valid' };
}

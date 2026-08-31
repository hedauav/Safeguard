import crypto from 'crypto';
import { secretMatches } from './tools-token.js';

/**
 * One shared password for the adjuster dashboard, and the stateless session
 * token a correct password buys.
 *
 * ## Why a password at all
 *
 * Everything the dashboard reads is customer data: names, phone numbers,
 * policy numbers, claim amounts, call transcripts, and the adjudication queue
 * that decides who gets paid. Until now the whole of it was reachable by
 * anyone who had the URL — the API asked for nothing, and migration 0007 had
 * additionally opened the same tables to Supabase's anon key, which is
 * embedded in the client bundle and therefore public. Two doors, both open.
 * This closes the first; migration 0027 closes the second.
 *
 * ## Why one password and no accounts
 *
 * There is one interface and one operator role. A user table, a signup flow
 * and a per-user permission model would all be scaffolding around a decision
 * nobody in this deployment is making, and each piece is somewhere else for a
 * mistake to hide. The reviewer name recorded against an adjudication decision
 * is an attribution the operator types, and it stays that — it was never a
 * login and this does not turn it into one.
 *
 * ## Why the token is an HMAC and not a row
 *
 * A session table would need a schema, a migration, a cleanup job and a read
 * on every request. An HMAC over an expiry needs none of those: the server can
 * tell a token it issued from one it did not, and can tell a live one from an
 * expired one, purely from the token and the secret. The cost is that a token
 * cannot be revoked before it expires — which is why the lifetime is short,
 * and why rotating DASHBOARD_SESSION_SECRET invalidates every outstanding
 * session at once, the revocation lever that actually matters here.
 *
 * The logic lives here, free of any config import, so it can be unit tested
 * without the environment the server needs to boot — the same arrangement, and
 * for the same reason, as tools-token.ts next door.
 */

/**
 * Header the dashboard sends its session token in.
 *
 * Deliberately NOT `Authorization: Bearer`, which the tools token accepts and
 * the admin token requires. The agent-config and adjudication-decision writes
 * already carry the ADMIN_TOKEN in `Authorization`, and those same requests
 * now also pass through this guard: sharing one header would have the guard
 * read the admin token as a malformed session and refuse a request that is
 * perfectly well authenticated. Two credentials, two headers, no ambiguity.
 */
export const DASHBOARD_TOKEN_HEADER = 'x-dashboard-token';

/**
 * Response header set on every refusal from the dashboard guard.
 *
 * The browser needs to tell "your session ran out, log in again" apart from
 * "that admin token is wrong", and both are a bare 401. Without a marker the
 * dashboard would sign the operator out every time they mistyped the admin
 * token on the agent-config page.
 */
export const DASHBOARD_AUTH_CHALLENGE_HEADER = 'x-dashboard-auth';

/**
 * How long a session lasts.
 *
 * Long enough to cover a working day of adjudication without a re-prompt in
 * the middle of a decision; short enough that a token copied off a shared
 * machine is worthless by the next one. Nothing here can be revoked early, so
 * the lifetime is the whole of the containment.
 */
export const DASHBOARD_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Version prefix, signed along with the expiry.
 *
 * Present so a later change to what a token carries cannot be mistaken for a
 * valid token of the current shape: the prefix is inside the signed material,
 * so a v1 token does not verify as a v2 one even under the same secret.
 */
const TOKEN_VERSION = 'v1';

export type DashboardAuthVerdict =
  | { ok: true; reason: 'valid' | 'admin_token' | 'development_bypass' }
  | {
      ok: false;
      status: 401 | 503;
      reason: 'not_configured' | 'invalid' | 'expired';
      message: string;
    };

export type DashboardLoginVerdict =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; status: 401 | 503; reason: 'not_configured' | 'invalid'; message: string };

/** Case-insensitive header lookup — Fastify lowercases, other callers may not. */
function header(headers: Record<string, unknown>, name: string): string {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct) && typeof direct[0] === 'string') return direct[0];
  return '';
}

/** The session token a request presented, from the one header that carries it. */
export function presentedDashboardToken(headers: Record<string, unknown>): string {
  return header(headers, DASHBOARD_TOKEN_HEADER).trim();
}

/** The admin token a request presented, in the header ADMIN_TOKEN has always used. */
function presentedBearer(headers: Record<string, unknown>): string {
  const authorization = header(headers, 'authorization').trim();
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

/** The bytes a token's signature covers: the version and the expiry, nothing else. */
function signedPayload(expiresAt: number): string {
  return `${TOKEN_VERSION}.${expiresAt}`;
}

function sign(payload: string, sessionSecret: string): string {
  return crypto.createHmac('sha256', sessionSecret).update(payload).digest('hex');
}

/**
 * Mint a token that expires at a fixed moment.
 *
 * The expiry travels in the clear and is signed rather than encrypted, because
 * there is nothing secret about when a session ends — only about whether this
 * server agreed to it. Moving the expiry forward changes the signed payload,
 * so a token edited to last longer stops verifying.
 */
export function issueDashboardToken(
  sessionSecret: string,
  options: { ttlMs?: number; now?: number } = {}
): { token: string; expiresAt: number } {
  const now = options.now ?? Date.now();
  const expiresAt = now + (options.ttlMs ?? DASHBOARD_SESSION_TTL_MS);
  const payload = signedPayload(expiresAt);
  return { token: `${payload}.${sign(payload, sessionSecret)}`, expiresAt };
}

/**
 * Whether a token was issued here and is still inside its lifetime.
 *
 * Signature first, expiry second, and both answers are collapsed into one
 * outcome for the caller. A forged token is never reported as "expired": that
 * would confirm to whoever sent it that the shape was right and only the clock
 * was wrong.
 */
function verifyDashboardToken(
  token: string,
  sessionSecret: string,
  now: number
): 'valid' | 'invalid' | 'expired' {
  const parts = token.split('.');
  if (parts.length !== 3) return 'invalid';

  const [version, expiry, signature] = parts;
  if (version !== TOKEN_VERSION) return 'invalid';

  // Rejected before it is compared, not after: `Number('')` is 0 and
  // `Number('12e3')` is a number that never round-trips, and either would let a
  // token through the arithmetic below on a technicality.
  if (!/^\d+$/.test(expiry)) return 'invalid';
  const expiresAt = Number(expiry);
  if (!Number.isSafeInteger(expiresAt)) return 'invalid';

  const expected = sign(signedPayload(expiresAt), sessionSecret);
  if (!secretMatches(signature, expected)) return 'invalid';

  return expiresAt > now ? 'valid' : 'expired';
}

/**
 * Decide whether a request may reach a dashboard endpoint.
 *
 * With no dashboard password configured the answer depends on where this is
 * running: production fails closed (503, the endpoint is disabled rather than
 * open), development falls open so `npm run dev` works out of the box. That is
 * the same asymmetry checkToolsToken makes, deliberately identical, and for
 * the same reason — a misconfigured production deployment must not quietly
 * behave like the old unauthenticated one.
 *
 * The ADMIN_TOKEN is accepted in place of a session, checked before anything
 * else. It is the strictly more privileged credential in this system: it is
 * what authorises rewriting the agent's prompt and recording a human approval
 * on a claim, and the endpoints guarded here are a subset of what its holder
 * can already do. Refusing it would be a lock the master key does not open,
 * and it would break the operator scripts (`rehearse-journey.mjs`) that have
 * always reached these routes with it and hold no browser session.
 */
export function checkDashboardSession(
  headers: Record<string, unknown>,
  options: {
    sessionSecret: string | null;
    adminToken: string | null;
    allowUnauthenticated: boolean;
    now?: number;
  }
): DashboardAuthVerdict {
  const adminToken = (options.adminToken ?? '').trim();
  if (adminToken) {
    const presentedAdmin = presentedBearer(headers);
    if (presentedAdmin && secretMatches(presentedAdmin, adminToken)) {
      return { ok: true, reason: 'admin_token' };
    }
  }

  if (!options.sessionSecret) {
    if (options.allowUnauthenticated) {
      return { ok: true, reason: 'development_bypass' };
    }
    return {
      ok: false,
      status: 503,
      reason: 'not_configured',
      message:
        'The dashboard is disabled: DASHBOARD_PASSWORD and DASHBOARD_SESSION_SECRET are not configured on the server.',
    };
  }

  const presented = presentedDashboardToken(headers);
  if (!presented) {
    return {
      ok: false,
      status: 401,
      reason: 'invalid',
      message: `Sign in to the dashboard. Send the session token as ${DASHBOARD_TOKEN_HEADER}.`,
    };
  }

  const outcome = verifyDashboardToken(presented, options.sessionSecret, options.now ?? Date.now());
  if (outcome === 'expired') {
    return {
      ok: false,
      status: 401,
      reason: 'expired',
      message: 'That dashboard session has expired. Sign in again.',
    };
  }
  if (outcome === 'invalid') {
    return {
      ok: false,
      status: 401,
      reason: 'invalid',
      message: `Sign in to the dashboard. Send the session token as ${DASHBOARD_TOKEN_HEADER}.`,
    };
  }

  return { ok: true, reason: 'valid' };
}

/**
 * Check a submitted password and, if it is the right one, mint a session.
 *
 * Both secrets are required together and there is no development carve-out
 * here. Without them there is nothing to compare against and nothing to sign
 * with, so a login cannot succeed in any environment — and it does not need
 * to, because the guard above is already falling open in exactly the
 * configuration that makes this 503. `GET /api/auth/status` is what the
 * browser reads to know it should not offer a login screen at all.
 *
 * The password is compared verbatim, without the `.trim()` the header tokens
 * get. A token arrives in a header where a stray newline is a transport
 * artefact; a password arrives in a JSON body where a leading or trailing
 * space is a character somebody deliberately typed, and silently discarding it
 * would let a shorter password than the one that was set open the lock.
 */
export function checkDashboardPassword(
  presented: unknown,
  options: { expected: string | null; sessionSecret: string | null; ttlMs?: number; now?: number }
): DashboardLoginVerdict {
  if (!options.expected || !options.sessionSecret) {
    return {
      ok: false,
      status: 503,
      reason: 'not_configured',
      message:
        'Sign-in is disabled: DASHBOARD_PASSWORD and DASHBOARD_SESSION_SECRET are not configured on the server.',
    };
  }

  // A non-string body field never reaches the comparison. Buffer.from(number)
  // allocates that many zero bytes rather than throwing, so an unchecked `4`
  // would be compared as four NUL characters against a four-character password.
  const invalid: DashboardLoginVerdict = {
    ok: false,
    status: 401,
    reason: 'invalid',
    message: 'That password is not correct.',
  };
  if (typeof presented !== 'string' || presented.length === 0) return invalid;
  if (!secretMatches(presented, options.expected)) return invalid;

  const { token, expiresAt } = issueDashboardToken(options.sessionSecret, {
    ttlMs: options.ttlMs,
    now: options.now,
  });
  return { ok: true, token, expiresAt };
}

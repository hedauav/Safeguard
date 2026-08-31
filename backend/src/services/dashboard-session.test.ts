import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DASHBOARD_SESSION_TTL_MS,
  DASHBOARD_TOKEN_HEADER,
  checkDashboardPassword,
  checkDashboardSession,
  issueDashboardToken,
  presentedDashboardToken,
} from './dashboard-session.js';

const PASSWORD = 'the-one-shared-dashboard-password';
const SESSION_SECRET = 'a-long-random-session-signing-secret';
const ADMIN_TOKEN = 'a-long-random-admin-token';

/** A configured deployment, enforcing. The shape every test below starts from. */
const enforced = {
  sessionSecret: SESSION_SECRET,
  adminToken: ADMIN_TOKEN,
  allowUnauthenticated: false,
};

/** A session token that is valid right now. */
function liveToken(): string {
  return issueDashboardToken(SESSION_SECRET).token;
}

// --- Signing in ------------------------------------------------------------

test('the right password buys a token that the guard then accepts', () => {
  const verdict = checkDashboardPassword(PASSWORD, {
    expected: PASSWORD,
    sessionSecret: SESSION_SECRET,
  });
  assert.equal(verdict.ok, true);
  if (!verdict.ok) return;

  const session = checkDashboardSession({ [DASHBOARD_TOKEN_HEADER]: verdict.token }, enforced);
  assert.deepEqual(session, { ok: true, reason: 'valid' });
});

test('a token comes back with an expiry a session length away, and not further', () => {
  const now = 1_700_000_000_000;
  const verdict = checkDashboardPassword(PASSWORD, {
    expected: PASSWORD,
    sessionSecret: SESSION_SECRET,
    now,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ok === true && verdict.expiresAt, now + DASHBOARD_SESSION_TTL_MS);
});

test('a wrong password of exactly the right length is refused', () => {
  const wrong = 'b'.repeat(PASSWORD.length);
  const verdict = checkDashboardPassword(wrong, {
    expected: PASSWORD,
    sessionSecret: SESSION_SECRET,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.status, 401);
});

test('a wrong password of a different length is refused, not thrown on', () => {
  // timingSafeEqual throws on mismatched lengths; a thrown error here would
  // surface as a 500 and would leak the password's length as surely as an
  // early return would.
  const verdict = checkDashboardPassword('short', {
    expected: PASSWORD,
    sessionSecret: SESSION_SECRET,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.status, 401);
});

test('a password that is not a string never reaches the comparison', () => {
  // Buffer.from(4) allocates four zero bytes rather than throwing, so an
  // unchecked number would be compared as NUL characters against a password of
  // the same length.
  for (const body of [4, null, undefined, {}, ['x'], true]) {
    const verdict = checkDashboardPassword(body, {
      expected: PASSWORD,
      sessionSecret: SESSION_SECRET,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok === false && verdict.status, 401);
  }
});

test('a password is compared verbatim, so surrounding whitespace is a wrong password', () => {
  const verdict = checkDashboardPassword(` ${PASSWORD} `, {
    expected: PASSWORD,
    sessionSecret: SESSION_SECRET,
  });
  assert.equal(verdict.ok, false);
});

test('signing in is impossible in every environment when either secret is missing', () => {
  // No development carve-out here, deliberately: there is nothing to compare
  // against and nothing to sign with, and the guard is already falling open in
  // exactly this configuration.
  for (const options of [
    { expected: null, sessionSecret: SESSION_SECRET },
    { expected: PASSWORD, sessionSecret: null },
    { expected: null, sessionSecret: null },
  ]) {
    const verdict = checkDashboardPassword(PASSWORD, options);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok === false && verdict.status, 503);
    assert.equal(verdict.ok === false && verdict.reason, 'not_configured');
  }
});

// --- Presenting a session --------------------------------------------------

test('rejects a request carrying no session token at all', () => {
  const verdict = checkDashboardSession({}, enforced);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.status, 401);
  assert.equal(verdict.ok === false && verdict.reason, 'invalid');
});

test('an expired token is refused and is told apart from a forged one', () => {
  const { token, expiresAt } = issueDashboardToken(SESSION_SECRET, { now: 1_000 });
  const verdict = checkDashboardSession({ [DASHBOARD_TOKEN_HEADER]: token }, {
    ...enforced,
    now: expiresAt + 1,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, 'expired');
});

test('a token is still live in the last millisecond of its lifetime', () => {
  const { token, expiresAt } = issueDashboardToken(SESSION_SECRET, { now: 1_000 });
  const verdict = checkDashboardSession({ [DASHBOARD_TOKEN_HEADER]: token }, {
    ...enforced,
    now: expiresAt - 1,
  });
  assert.deepEqual(verdict, { ok: true, reason: 'valid' });
});

test('a tampered signature is refused, and never as an expiry problem', () => {
  const [version, expiry, signature] = liveToken().split('.');
  const flipped = signature.slice(0, -1) + (signature.endsWith('a') ? 'b' : 'a');
  const verdict = checkDashboardSession(
    { [DASHBOARD_TOKEN_HEADER]: `${version}.${expiry}.${flipped}` },
    enforced
  );
  assert.equal(verdict.ok, false);
  // 'invalid', not 'expired': telling a forger the shape was right and only the
  // clock was wrong is a hint they did not have to be given.
  assert.equal(verdict.ok === false && verdict.reason, 'invalid');
});

test('an expiry moved forward stops verifying, because the expiry is what is signed', () => {
  const { token, expiresAt } = issueDashboardToken(SESSION_SECRET, { now: 1_000 });
  const [version, , signature] = token.split('.');
  const extended = `${version}.${expiresAt + 60_000}.${signature}`;
  const verdict = checkDashboardSession({ [DASHBOARD_TOKEN_HEADER]: extended }, enforced);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, 'invalid');
});

test('a token signed with another secret is refused', () => {
  const other = issueDashboardToken('a-different-signing-secret-entirely').token;
  const verdict = checkDashboardSession({ [DASHBOARD_TOKEN_HEADER]: other }, enforced);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, 'invalid');
});

test('a malformed token is refused rather than parsed into something', () => {
  const live = liveToken();
  const [, expiry, signature] = live.split('.');
  for (const token of [
    'not-a-token',
    `v1.${expiry}`,
    `v1.${expiry}.${signature}.extra`,
    `v2.${expiry}.${signature}`,
    // `Number('')` is 0 and `Number('12e3')` is a number that never round-trips;
    // both would otherwise reach the arithmetic on a technicality.
    `v1..${signature}`,
    `v1.12e3.${signature}`,
    `v1.-1.${signature}`,
    `v1.99999999999999999999.${signature}`,
  ]) {
    const verdict = checkDashboardSession({ [DASHBOARD_TOKEN_HEADER]: token }, enforced);
    assert.equal(verdict.ok, false, `expected ${token} to be refused`);
    assert.equal(verdict.ok === false && verdict.reason, 'invalid');
  }
});

test('surrounding whitespace on a session token is a transport artefact, not a wrong token', () => {
  const token = liveToken();
  assert.equal(presentedDashboardToken({ [DASHBOARD_TOKEN_HEADER]: `  ${token}\n` }), token);
  const verdict = checkDashboardSession(
    { [DASHBOARD_TOKEN_HEADER]: `  ${token}\n` },
    enforced
  );
  assert.deepEqual(verdict, { ok: true, reason: 'valid' });
});

test('a session token cannot be smuggled in through an Authorization header', () => {
  // The two credentials use two headers on purpose. A session presented as a
  // bearer is not a session, and it must not be read as a failed admin token
  // either — it is simply absent.
  const token = liveToken();
  assert.equal(presentedDashboardToken({ authorization: `Bearer ${token}` }), '');
  const verdict = checkDashboardSession({ authorization: `Bearer ${token}` }, enforced);
  assert.equal(verdict.ok, false);
});

test('a header repeated by a proxy is read from its first value', () => {
  const token = liveToken();
  assert.equal(presentedDashboardToken({ [DASHBOARD_TOKEN_HEADER]: [token, 'junk'] }), token);
  assert.equal(presentedDashboardToken({}), '');
});

// --- The admin token, and the master key it already is ----------------------

test('a valid admin token is accepted in place of a session', () => {
  const verdict = checkDashboardSession({ authorization: `Bearer ${ADMIN_TOKEN}` }, enforced);
  assert.deepEqual(verdict, { ok: true, reason: 'admin_token' });
});

test('an admin token with a trailing newline still opens the lock', () => {
  const verdict = checkDashboardSession(
    { authorization: `Bearer ${ADMIN_TOKEN}\n` },
    enforced
  );
  assert.deepEqual(verdict, { ok: true, reason: 'admin_token' });
});

test('a wrong admin token falls through to the session check rather than passing', () => {
  const verdict = checkDashboardSession(
    { authorization: `Bearer ${'x'.repeat(ADMIN_TOKEN.length)}` },
    enforced
  );
  assert.equal(verdict.ok, false);
});

test('a wrong admin token alongside a valid session is still let through', () => {
  // The agent-config page sends both. A mistyped admin token must not sign the
  // operator out of a session that is perfectly good.
  const verdict = checkDashboardSession(
    { authorization: 'Bearer wrong', [DASHBOARD_TOKEN_HEADER]: liveToken() },
    enforced
  );
  assert.deepEqual(verdict, { ok: true, reason: 'valid' });
});

test('an unconfigured admin token is never a lock that opens for nothing', () => {
  for (const adminToken of [null, '', '   ']) {
    const verdict = checkDashboardSession({ authorization: 'Bearer ' }, {
      ...enforced,
      adminToken,
    });
    assert.equal(verdict.ok, false);
  }
});

// --- What an unconfigured deployment does ----------------------------------

test('an unconfigured session secret fails closed outside development', () => {
  const verdict = checkDashboardSession({ [DASHBOARD_TOKEN_HEADER]: liveToken() }, {
    ...enforced,
    sessionSecret: null,
  });
  assert.equal(verdict.ok, false);
  // 503, not 401: the endpoint is disabled by misconfiguration, and no token
  // the caller could supply would change that.
  assert.equal(verdict.ok === false && verdict.status, 503);
  assert.equal(verdict.ok === false && verdict.reason, 'not_configured');
});

test('an unconfigured session secret falls open only in development', () => {
  const verdict = checkDashboardSession({}, {
    sessionSecret: null,
    adminToken: null,
    allowUnauthenticated: true,
  });
  assert.deepEqual(verdict, { ok: true, reason: 'development_bypass' });
});

test('a configured session secret is still enforced in development', () => {
  const verdict = checkDashboardSession({}, { ...enforced, allowUnauthenticated: true });
  assert.equal(verdict.ok, false);
});

test('an admin token still works on a deployment with no dashboard secrets set', () => {
  // The operator scripts hold this token and no browser session, and a server
  // that is failing closed for want of a dashboard password is not a reason to
  // refuse the strictly more privileged credential.
  const verdict = checkDashboardSession({ authorization: `Bearer ${ADMIN_TOKEN}` }, {
    sessionSecret: null,
    adminToken: ADMIN_TOKEN,
    allowUnauthenticated: false,
  });
  assert.deepEqual(verdict, { ok: true, reason: 'admin_token' });
});

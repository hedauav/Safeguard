import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkToolsToken, presentedToken, TOOLS_TOKEN_HEADER } from './tools-token.js';

const SECRET = 'a-long-random-shared-secret';
const enforced = { expected: SECRET, allowUnauthenticated: false };

test('accepts the token from the header the agent is configured to send', () => {
  const verdict = checkToolsToken({ [TOOLS_TOKEN_HEADER]: SECRET }, enforced);
  assert.deepEqual(verdict, { ok: true, reason: 'valid' });
});

test('accepts the same token as an Authorization bearer', () => {
  const verdict = checkToolsToken({ authorization: `Bearer ${SECRET}` }, enforced);
  assert.deepEqual(verdict, { ok: true, reason: 'valid' });
});

test('rejects a wrong token of the same length', () => {
  const wrong = 'b'.repeat(SECRET.length);
  const verdict = checkToolsToken({ [TOOLS_TOKEN_HEADER]: wrong }, enforced);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.status, 401);
});

test('a token of a different length is rejected, not thrown on', () => {
  // timingSafeEqual throws on mismatched lengths; the guard must compare
  // lengths itself rather than let that error escape as a 500.
  const verdict = checkToolsToken({ [TOOLS_TOKEN_HEADER]: 'short' }, enforced);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.status, 401);
});

test('rejects a request carrying no token at all', () => {
  const verdict = checkToolsToken({}, enforced);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, 'invalid');
});

test('an unconfigured token fails closed outside development', () => {
  const verdict = checkToolsToken({ [TOOLS_TOKEN_HEADER]: SECRET }, {
    expected: null,
    allowUnauthenticated: false,
  });
  assert.equal(verdict.ok, false);
  // 503, not 401: the endpoint is disabled by misconfiguration, and no token
  // the caller could supply would change that.
  assert.equal(verdict.ok === false && verdict.status, 503);
  assert.equal(verdict.ok === false && verdict.reason, 'not_configured');
});

test('an unconfigured token falls open only in development', () => {
  const verdict = checkToolsToken({}, { expected: null, allowUnauthenticated: true });
  assert.deepEqual(verdict, { ok: true, reason: 'development_bypass' });
});

test('a configured token is still enforced in development', () => {
  const verdict = checkToolsToken({ [TOOLS_TOKEN_HEADER]: 'nope' }, {
    expected: SECRET,
    allowUnauthenticated: true,
  });
  assert.equal(verdict.ok, false);
});

test('the explicit header wins over an Authorization header', () => {
  assert.equal(
    presentedToken({ [TOOLS_TOKEN_HEADER]: SECRET, authorization: 'Bearer something-else' }),
    SECRET
  );
});

test('surrounding whitespace and a non-bearer scheme do not smuggle a token through', () => {
  assert.equal(presentedToken({ [TOOLS_TOKEN_HEADER]: `  ${SECRET}  ` }), SECRET);
  assert.equal(presentedToken({ authorization: `Basic ${SECRET}` }), '');
  assert.equal(presentedToken({}), '');
});

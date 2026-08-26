import { test } from 'node:test';
import assert from 'node:assert/strict';

// environment.ts calls requireEnv() at import time and agent-config.ts imports
// it, so the module graph refuses to load without database credentials. These
// placeholders let the admin guard be exercised without the environment the
// server needs to boot — the same reason services/tools-token.ts keeps itself
// free of any config import. `||=` rather than `??=`: an empty string is as
// absent as undefined to requireEnv.
process.env.SUPABASE_URL ||= 'https://stub.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'stub-service-role-key';

const { adminTokenMatches, bearerToken } = await import('./agent-config.js');

const SECRET = 'an-admin-token-long-enough-to-matter';

test('accepts the configured token presented as a bearer', () => {
  assert.equal(adminTokenMatches(bearerToken(`Bearer ${SECRET}`), SECRET), true);
});

test('a token pasted with trailing whitespace is still the right token', () => {
  // The defect this covers: a secret copied out of a Railway variable or a
  // terminal arrives with a trailing space or newline, the length check fails
  // before timingSafeEqual is reached, and the operator gets a 401 that is
  // indistinguishable from having the wrong secret entirely.
  assert.equal(adminTokenMatches(bearerToken(`Bearer ${SECRET}\n`), SECRET), true);
  assert.equal(adminTokenMatches(bearerToken(`Bearer ${SECRET}   `), SECRET), true);
  assert.equal(adminTokenMatches(bearerToken(`  Bearer  ${SECRET}  `), SECRET), true);
});

test('a configured token stored with a trailing newline is still matchable', () => {
  // The other half of the same failure: no token any caller could send would
  // match a server-side secret that ends in whitespace.
  assert.equal(adminTokenMatches(SECRET, `${SECRET}\n`), true);
});

test('trimming does not let a genuinely wrong token through', () => {
  assert.equal(adminTokenMatches(bearerToken('Bearer not-the-token'), SECRET), false);
  // Same length, one character different — the case a length check alone passes.
  const nearly = `${SECRET.slice(0, -1)}X`;
  assert.equal(adminTokenMatches(bearerToken(`Bearer ${nearly}`), SECRET), false);
});

test('an interior difference is not trimmed away', () => {
  assert.equal(adminTokenMatches(bearerToken(`Bearer ${SECRET.replace('-', ' ')}`), SECRET), false);
});

test('a token of a different length is rejected, not thrown on', () => {
  // timingSafeEqual throws on mismatched buffer lengths; letting that escape
  // would turn a wrong password into a 500 and leak the secret's length.
  assert.equal(adminTokenMatches(bearerToken('Bearer short'), SECRET), false);
});

test('no token, no header, and a non-bearer scheme all fail', () => {
  assert.equal(bearerToken(''), '');
  assert.equal(bearerToken(`Basic ${SECRET}`), '');
  assert.equal(bearerToken(`Bearer${SECRET}`), '');
  assert.equal(adminTokenMatches(bearerToken(''), SECRET), false);
  assert.equal(adminTokenMatches(bearerToken(`Basic ${SECRET}`), SECRET), false);
});

test('an unconfigured admin token matches nothing, including the empty string', () => {
  // Fails closed. Without this, whitespace-only or unset ADMIN_TOKEN would be
  // matched by a caller sending an empty bearer token.
  assert.equal(adminTokenMatches('', null), false);
  assert.equal(adminTokenMatches('', ''), false);
  assert.equal(adminTokenMatches('', '   '), false);
});

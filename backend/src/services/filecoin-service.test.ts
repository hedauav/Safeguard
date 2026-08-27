import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Pinned before the module graph loads, because `config` is read once at import
 * time. SIMULATE_BLOCKCHAIN is forced off so the "no client" path returns a
 * failure with a reason rather than a simulated success — the branch under
 * test. The Supabase pair is only there because environment.ts requires it to
 * exist; nothing here talks to a database. dotenv does not overwrite a key that
 * is already present, so a developer's real .env cannot leak into these.
 */
process.env.SIMULATE_BLOCKCHAIN = 'false';
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';

const { uploadClaimBundle, uploadDocumentBytes } = await import('./filecoin-service.js');

// --- The disabled reason ----------------------------------------------------

test('a missing client reports the reason the plugin actually found', async () => {
  // The plugin knows why there is no Synapse client. Before this it was thrown
  // away and the upload layer guessed instead.
  const result = await uploadClaimBundle(null, { claim: 'x' }, 'AGENT_PRIVATE_KEY not set');

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.disabled, true);
  assert.match(result.ok === false ? result.error : '', /AGENT_PRIVATE_KEY not set/);
});

test('a client that failed to initialise reports the SDK fault, not the missing key', async () => {
  // The case the old hardcoded string got wrong: the key IS set, and the reader
  // was still told to go set it. This deployment has a funded wallet and a
  // working attestation path, so "set AGENT_PRIVATE_KEY" is exactly the kind of
  // wrong answer that costs an afternoon.
  const result = await uploadClaimBundle(
    null,
    { claim: 'x' },
    'unsupported chain id 314159 for Warm Storage'
  );

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : '', /unsupported chain id 314159/);
  assert.doesNotMatch(result.ok === false ? result.error : '', /AGENT_PRIVATE_KEY/);
});

test('with nobody to ask, it falls back to the assumption rather than to silence', async () => {
  // An empty reason must not become an empty error. A blank reason recorded
  // against a failure reads as "failed for no cause", which is the state this
  // whole change exists to end.
  for (const reason of [undefined, null, '', '   ']) {
    const result = await uploadClaimBundle(null, { claim: 'x' }, reason);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : '', /set AGENT_PRIVATE_KEY/);
  }
});

test('the reason never comes back blank', async () => {
  const result = await uploadDocumentBytes(null, new Uint8Array([1, 2, 3]), null);
  assert.equal(result.ok, false);
  assert.ok((result.ok === false ? result.error : '').trim().length > 0);
});

// --- What a thrown upload turns into ----------------------------------------

/** Minimal stand-in for the one method uploadBytes calls on a real client. */
function throwingSynapse(thrown: unknown) {
  return {
    storage: {
      upload: async () => {
        throw thrown;
      },
    },
  } as any;
}

test('a contract revert keeps its class name in front of the message', async () => {
  // The suspected production cause. The name is the part worth grepping for
  // across attempts to tell "always the same fault" from "a different one each
  // time", so it is kept even though the message usually repeats it.
  const err = new Error('execution reverted: InsufficientLockupFunds()');
  err.name = 'ContractFunctionExecutionError';

  const result = await uploadClaimBundle(throwingSynapse(err), { claim: 'x' });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.disabled, false);
  assert.match(
    result.ok === false ? result.error : '',
    /ContractFunctionExecutionError: execution reverted: InsufficientLockupFunds/
  );
});

test('a plain Error is not decorated with the word Error', async () => {
  const result = await uploadClaimBundle(throwingSynapse(new Error('socket hang up')), {});
  assert.equal(result.ok === false && result.error, 'socket hang up');
});

test('an Error with no message still says something', async () => {
  // Blank messages are common on rejections that carry their detail elsewhere,
  // and 0022 refuses to store a blank string precisely so this cannot happen.
  const err = new Error('');
  err.name = 'AbortError';

  const result = await uploadClaimBundle(throwingSynapse(err), {});
  assert.equal(result.ok === false && result.error, 'AbortError');
});

test('a thrown non-Error still yields a non-empty reason', async () => {
  for (const thrown of [undefined, null, '', {}]) {
    const result = await uploadClaimBundle(throwingSynapse(thrown), {});
    assert.equal(result.ok, false);
    assert.ok((result.ok === false ? result.error : '').trim().length > 0);
  }
});

test('a failure is never dressed up as a stored piece', async () => {
  // The invariant every one of these paths exists to protect: no CID, real or
  // placeholder, comes out of an attempt that did not store anything.
  const result = await uploadClaimBundle(throwingSynapse(new Error('nope')), {});
  assert.equal(result.ok, false);
  assert.equal('pieceCid' in result, false);
});

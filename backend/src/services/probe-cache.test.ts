import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCachedProbe, DEFAULT_ERROR_MAX_STALE_MS } from './probe-cache.js';

/** Lets a test decide exactly when the cache thinks time has passed. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

/** Flush pending microtasks and immediates, so a background refresh can land. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const options = (now: () => number) => ({
  ttlMs: 100,
  errorTtlMs: 50,
  timeoutMs: 1_000,
  maxStaleMs: 1_000,
  now,
});

test('a second call inside the ttl does not touch the dependency again', async () => {
  const clock = fakeClock();
  let calls = 0;
  const probe = createCachedProbe(
    async () => ++calls,
    () => -1,
    options(clock.now)
  );

  assert.equal(await probe.get(), 1);
  clock.advance(99);
  assert.equal(await probe.get(), 1);
  assert.equal(calls, 1, 'the healthcheck must not query once per poll');
});

test('concurrent callers share a single in-flight lookup', async () => {
  const clock = fakeClock();
  let calls = 0;
  const probe = createCachedProbe(
    async () => {
      calls += 1;
      await settle();
      return calls;
    },
    () => -1,
    options(clock.now)
  );

  const results = await Promise.all([probe.get(), probe.get(), probe.get()]);
  assert.deepEqual(results, [1, 1, 1]);
  assert.equal(calls, 1, 'a burst of probes must not stampede the database');
});

test('a stale value is served immediately while the refresh happens behind it', async () => {
  const clock = fakeClock();
  let calls = 0;
  const probe = createCachedProbe(
    async () => ++calls,
    () => -1,
    options(clock.now)
  );

  assert.equal(await probe.get(), 1);
  clock.advance(150);
  // Past the ttl but inside maxStale: the caller gets the old value without
  // waiting on the dependency at all.
  assert.equal(await probe.get(), 1);
  await settle();
  assert.equal(calls, 2, 'the refresh should have run in the background');
  assert.equal(await probe.get(), 2, 'the next caller sees the refreshed value');
});

test('a value older than maxStale is not served — the caller waits for a fresh one', async () => {
  const clock = fakeClock();
  let calls = 0;
  const probe = createCachedProbe(
    async () => ++calls,
    () => -1,
    options(clock.now)
  );

  assert.equal(await probe.get(), 1);
  clock.advance(5_000);
  assert.equal(await probe.get(), 2, 'week-old news must not be repeated indefinitely');
});

test('a probe that throws resolves to the fallback rather than rejecting', async () => {
  const clock = fakeClock();
  const probe = createCachedProbe<string>(
    async () => {
      throw new Error('connection refused');
    },
    (reason) => `unknown: ${reason}`,
    options(clock.now)
  );

  // Rejecting here would become a 500 from /health, and Railway would restart
  // a service that is actually fine.
  assert.equal(await probe.get(), 'unknown: connection refused');
});

test('a sprawling client error is reduced to one bounded line', async () => {
  const clock = fakeClock();
  const probe = createCachedProbe<string>(
    async () => {
      // Roughly what viem throws: a summary line, then the whole request body.
      throw new Error(
        `HTTP request failed.\n\nURL: https://rpc.invalid/\nRequest body: {"method":"eth_getBalance"}\n\n${'x'.repeat(500)}`
      );
    },
    (reason) => reason,
    options(clock.now)
  );

  const reason = await probe.get();
  assert.equal(reason, 'HTTP request failed.');
  assert.ok(!reason.includes('\n'), 'a healthcheck body must stay one line per reason');
});

test('a single very long line is truncated rather than pasted whole', async () => {
  const clock = fakeClock();
  const probe = createCachedProbe<string>(
    async () => {
      throw new Error('y'.repeat(500));
    },
    (reason) => reason,
    options(clock.now)
  );

  const reason = await probe.get();
  assert.equal(reason.length, 200);
  assert.ok(reason.endsWith('…'));
});

test('a probe that hangs past the timeout resolves to the fallback', async () => {
  const clock = fakeClock();
  const probe = createCachedProbe<string>(
    () => new Promise(() => {}),
    (reason) => `unknown: ${reason}`,
    { ttlMs: 100, errorTtlMs: 50, timeoutMs: 15, maxStaleMs: 1_000, now: clock.now }
  );

  const value = await probe.get();
  assert.match(value, /^unknown: lookup exceeded 15ms$/);
});

test('a failure is remembered for errorTtlMs, then retried', async () => {
  const clock = fakeClock();
  let calls = 0;
  let failing = true;
  const probe = createCachedProbe<string>(
    async () => {
      calls += 1;
      if (failing) throw new Error('down');
      return 'ok';
    },
    (reason) => `unknown: ${reason}`,
    options(clock.now)
  );

  assert.equal(await probe.get(), 'unknown: down');
  clock.advance(10);
  assert.equal(await probe.get(), 'unknown: down');
  assert.equal(calls, 1, 'a down dependency must not be hammered once per poll');

  // Past errorTtlMs the retry runs, but behind the cached failure rather than
  // in front of it: a hard-down dependency must never make a caller wait out
  // the full timeout on every poll.
  failing = false;
  clock.advance(60);
  assert.equal(await probe.get(), 'unknown: down', 'the caller is not made to wait for the retry');
  await settle();
  assert.equal(calls, 2, 'the retry did run');
  assert.equal(await probe.get(), 'ok', 'and the recovery shows up on the next poll');
});

test('a failed probe is not served past its own short stale window', async () => {
  const clock = fakeClock();
  let failing = true;
  const probe = createCachedProbe<string>(
    async () => {
      if (failing) throw new Error('JWT issued at future');
      return 'ok';
    },
    (reason) => `unknown: ${reason}`,
    // maxStaleMs is the /health shape: five minutes, tuned for a *successful*
    // snapshot. Before this fix failures borrowed it, and a database blip that
    // had already cleared kept being reported as a broken subsystem for the
    // whole five minutes.
    {
      ttlMs: 100,
      errorTtlMs: 50,
      timeoutMs: 1_000,
      maxStaleMs: 5 * 60_000,
      errorMaxStaleMs: 200,
      now: clock.now,
    }
  );

  assert.equal(await probe.get(), 'unknown: JWT issued at future');

  // Inside errorTtlMs the cached failure is still served, so a dependency that
  // is genuinely down is not queried once per healthcheck poll.
  clock.advance(10);
  assert.equal(await probe.get(), 'unknown: JWT issued at future');

  // Past the error stale window the caller waits for a real answer instead of
  // being handed a failure the dependency has already recovered from. Under
  // the old behaviour this same instant sat deep inside maxStaleMs and would
  // have replayed the blip.
  failing = false;
  clock.advance(200);
  assert.equal(await probe.get(), 'ok', 'a recovered dependency must not stay broken on /health');
});

test('the error stale window defaults well short of the success one', async () => {
  const clock = fakeClock();
  let failing = true;
  const probe = createCachedProbe<string>(
    async () => {
      if (failing) throw new Error('down');
      return 'ok';
    },
    (reason) => `unknown: ${reason}`,
    // No errorMaxStaleMs given: the default must still be far below the five
    // minutes maxStaleMs allows, because that is the production configuration.
    { ttlMs: 100, errorTtlMs: 5_000, timeoutMs: 1_000, maxStaleMs: 5 * 60_000, now: clock.now }
  );

  assert.ok(
    DEFAULT_ERROR_MAX_STALE_MS < 5 * 60_000,
    'the whole point is that a failure does not inherit the success window'
  );
  assert.equal(await probe.get(), 'unknown: down');
  failing = false;
  clock.advance(60_000);
  assert.equal(await probe.get(), 'ok', 'a minute-old failure must not still be on /health');
});

test('warm() fills the cache so the first real caller never waits', async () => {
  const clock = fakeClock();
  let calls = 0;
  const probe = createCachedProbe(
    async () => ++calls,
    () => -1,
    options(clock.now)
  );

  probe.warm();
  await settle();
  assert.equal(calls, 1);
  assert.equal(await probe.get(), 1);
  assert.equal(calls, 1, 'the warm result should be reused, not re-fetched');
});

test('a fallback that itself throws does not escape as an unhandled rejection', async () => {
  const clock = fakeClock();
  const probe = createCachedProbe<string>(
    async () => {
      throw new Error('down');
    },
    () => {
      throw new Error('fallback is broken');
    },
    options(clock.now)
  );

  // The caller still sees a rejection here, but warm()/background refresh must
  // swallow it rather than crashing the process on an unhandled rejection.
  probe.warm();
  await settle();
  await assert.rejects(() => probe.get(), /fallback is broken/);
});

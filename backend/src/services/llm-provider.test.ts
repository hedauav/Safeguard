import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GroqProvider,
  FakeLlmProvider,
  computeModelCostUsd,
  readUsage,
} from './llm-provider.js';

/**
 * Groq returns its token counts in the same response body as the answer, and
 * this codebase used to read the content out and discard the rest — which is
 * why every adjudication row on record before migration 0024 carries no
 * evidence of what the call cost.
 *
 * These tests are mostly about the null cases. A token count that is wrong is
 * a bad number; a token count that is invented is a number somebody would
 * quote in a cost model, so every path that cannot produce a real one has to
 * produce nothing instead.
 */

const usageBody = (usage: unknown) => ({
  model: 'openai/gpt-oss-120b',
  choices: [{ message: { content: '{"verdict":"approve"}' } }],
  usage,
});

const stubFetch = (body: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;

// --- readUsage --------------------------------------------------------------

test('reads the three counts Groq reports', () => {
  assert.deepEqual(
    readUsage({ prompt_tokens: 1840, completion_tokens: 226, total_tokens: 2066 }),
    { promptTokens: 1840, completionTokens: 226, totalTokens: 2066 }
  );
});

test('a provider that sent no usage object yields null, not a row of zeroes', () => {
  assert.equal(readUsage(undefined), null);
  assert.equal(readUsage(null), null);
  assert.equal(readUsage('1840'), null);
  assert.equal(readUsage({}), null);
});

test('keeps the counts that are present and nulls only the ones that are not', () => {
  assert.deepEqual(readUsage({ prompt_tokens: 900 }), {
    promptTokens: 900,
    completionTokens: null,
    totalTokens: null,
  });
});

test('total_tokens is taken as reported and never recomputed from the other two', () => {
  // Cached and reasoning tokens are billed and appear in neither of the other
  // fields, so a total that does not equal prompt + completion is Groq being
  // right and arithmetic here being wrong.
  const usage = readUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 900 });
  assert.equal(usage?.totalTokens, 900);
});

test('a negative or unusable count becomes null rather than being coerced', () => {
  assert.deepEqual(readUsage({ prompt_tokens: -5, completion_tokens: NaN, total_tokens: 12 }), {
    promptTokens: null,
    completionTokens: null,
    totalTokens: 12,
  });
});

// --- the provider -----------------------------------------------------------

test('GroqProvider carries the usage object out with the answer', async () => {
  const provider = new GroqProvider('test-key', {
    fetchImpl: stubFetch(usageBody({ prompt_tokens: 1840, completion_tokens: 226, total_tokens: 2066 })),
  });

  const completion = await provider.complete({ system: 's', user: 'u' });

  assert.equal(completion.usage?.promptTokens, 1840);
  assert.equal(completion.usage?.completionTokens, 226);
  assert.equal(completion.usage?.totalTokens, 2066);
  assert.equal(completion.simulated, false);
});

test('a Groq response with no usage still returns an answer, with null usage', async () => {
  const provider = new GroqProvider('test-key', { fetchImpl: stubFetch(usageBody(undefined)) });
  const completion = await provider.complete({ system: 's', user: 'u' });

  assert.equal(completion.usage, null);
  assert.equal(completion.text, '{"verdict":"approve"}');
});

test('the fake provider reports no usage at all', async () => {
  // Zero would read as a real call that happened to be free. No model ran.
  const completion = await new FakeLlmProvider().complete({ system: 's', user: 'u' });
  assert.equal(completion.usage, null);
  assert.equal(completion.simulated, true);
});

// --- cost -------------------------------------------------------------------

test('prices a completion when both rates and both counts are known', () => {
  const cost = computeModelCostUsd(
    { promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000 },
    { inputPerMTok: 0.15, outputPerMTok: 0.6 }
  );
  assert.equal(cost, 0.45);
});

test('keeps enough decimals that a single adjudication is not rounded to nothing', () => {
  const cost = computeModelCostUsd(
    { promptTokens: 1840, completionTokens: 226, totalTokens: 2066 },
    { inputPerMTok: 0.15, outputPerMTok: 0.6 }
  );
  assert.ok(cost !== null && cost > 0, 'a real call must not price at zero');
  assert.equal(cost, Number((0.000276 + 0.0001356).toFixed(8)));
});

test('an unconfigured rate produces no cost rather than a half-priced one', () => {
  const usage = { promptTokens: 1840, completionTokens: 226, totalTokens: 2066 };
  assert.equal(computeModelCostUsd(usage, { inputPerMTok: null, outputPerMTok: 0.6 }), null);
  assert.equal(computeModelCostUsd(usage, { inputPerMTok: 0.15, outputPerMTok: null }), null);
  assert.equal(computeModelCostUsd(usage, { inputPerMTok: null, outputPerMTok: null }), null);
});

test('a missing token count produces no cost, however well configured the rates', () => {
  assert.equal(
    computeModelCostUsd(
      { promptTokens: null, completionTokens: 226, totalTokens: 226 },
      { inputPerMTok: 0.15, outputPerMTok: 0.6 }
    ),
    null
  );
});

test('no usage at all produces no cost', () => {
  assert.equal(computeModelCostUsd(null, { inputPerMTok: 0.15, outputPerMTok: 0.6 }), null);
});

test('a zero-token call priced at a real rate is genuinely zero, not null', () => {
  // Distinct from every case above: the provider did report, and it reported
  // nothing billable. That is a measurement.
  assert.equal(
    computeModelCostUsd(
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      { inputPerMTok: 0.15, outputPerMTok: 0.6 }
    ),
    0
  );
});

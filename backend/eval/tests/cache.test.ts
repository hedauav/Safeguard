import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CompletionCache,
  GROQ_API_BASE,
  emptyUsage,
  resolveApiBase,
  resolveApiKey,
  sha256Text,
  type CompletionCacheFile,
  type CompletionEntry,
} from '../model-client.js';

/**
 * The completions cache is the only place in the harness where an answer paid
 * for on one configuration could be scored as though it came from another.
 * Arms B and C read from it by design, so what counts as "the same question"
 * has to include who was asked: the same model id served by Groq and by
 * Cerebras is two providers, and a cache that pooled them would report a
 * difference between arms that was really a difference between vendors.
 *
 * These tests pin that boundary, and pin the promise made either side of it —
 * that crossing it costs nothing already bought.
 */

const SYSTEM = 'system prompt under test';
const CEREBRAS = 'https://api.cerebras.ai/v1';

function sandbox(): string {
  return join(mkdtempSync(join(tmpdir(), 'safeguard-cache-')), 'completions-dev.json');
}

function entry(caseId: string, promptHash: string): CompletionEntry {
  return {
    case_id: caseId,
    run: 1,
    ok: true,
    text: '{"verdict":"approve"}',
    model: 'openai/gpt-oss-120b',
    latency_ms: 1200,
    usage: emptyUsage(),
    attempts: 1,
    throttled_attempts: 0,
    error: null,
    error_kind: null,
    http_statuses: [200],
    prompt_sha256: promptHash,
    called_at: '2026-08-25T00:00:00.000Z',
  };
}

/** A cache on disk holding one answer, written under `baseUrl`. */
function seeded(path: string, baseUrl: string, promptHash: string): void {
  const cache = CompletionCache.open(path, 'dev', 'openai/gpt-oss-120b', 1, 3072, SYSTEM, baseUrl);
  cache.put(entry('CLM-1', promptHash));
  cache.save();
}

test('an answer is reused when the provider is the same', () => {
  const path = sandbox();
  const hash = sha256Text('the question');
  seeded(path, GROQ_API_BASE, hash);

  const reopened = CompletionCache.open(path, 'dev', 'openai/gpt-oss-120b', 1, 3072, SYSTEM, GROQ_API_BASE);
  assert.ok(reopened.get('CLM-1', 1, hash), 'the paid answer should still be there');
});

test('a different provider serving the same model id starts a fresh cache', () => {
  const path = sandbox();
  const hash = sha256Text('the question');
  seeded(path, GROQ_API_BASE, hash);

  const elsewhere = CompletionCache.open(path, 'dev', 'openai/gpt-oss-120b', 1, 3072, SYSTEM, CEREBRAS);
  assert.equal(elsewhere.get('CLM-1', 1, hash), null, 'Groq answers must not be scored as Cerebras answers');
});

test('a cache written before providers were recorded is read as Groq', () => {
  const path = sandbox();
  const hash = sha256Text('the question');
  seeded(path, GROQ_API_BASE, hash);

  // Strip the field, exactly as an older run would have left the file.
  const file = JSON.parse(readFileSync(path, 'utf8')) as CompletionCacheFile;
  delete file.api_base;
  writeFileSync(path, JSON.stringify(file, null, 2), 'utf8');

  const reopened = CompletionCache.open(path, 'dev', 'openai/gpt-oss-120b', 1, 3072, SYSTEM, GROQ_API_BASE);
  assert.ok(reopened.get('CLM-1', 1, hash), 'answers from before this field existed were all Groq');
});

test('switching provider moves the earlier answers aside instead of overwriting them', () => {
  const path = sandbox();
  const hash = sha256Text('the question');
  seeded(path, GROQ_API_BASE, hash);

  // The switch, followed by the save that would have landed on top of them.
  CompletionCache.open(path, 'dev', 'openai/gpt-oss-120b', 1, 3072, SYSTEM, CEREBRAS).save();

  const archived = readdirSync(join(path, '..')).filter((name) => name.includes('.superseded.'));
  assert.equal(archived.length, 1, `expected one archive, found ${archived.join(', ')}`);
  assert.match(archived[0]!, /api-groq-com/, 'the archive should name the provider that produced it');

  const kept = JSON.parse(readFileSync(join(path, '..', archived[0]!), 'utf8')) as CompletionCacheFile;
  assert.equal(Object.keys(kept.entries).length, 1);
  assert.equal(kept.entries['CLM-1#1']!.prompt_sha256, hash);
});

test('archiving never replaces a larger archive with a smaller one', () => {
  const path = sandbox();
  const hash = sha256Text('the question');

  // Two answers under Groq, archived by a switch.
  const first = CompletionCache.open(path, 'dev', 'openai/gpt-oss-120b', 1, 3072, SYSTEM, GROQ_API_BASE);
  first.put(entry('CLM-1', hash));
  first.put({ ...entry('CLM-2', hash), case_id: 'CLM-2' });
  first.save();
  CompletionCache.open(path, 'dev', 'openai/gpt-oss-120b', 1, 3072, SYSTEM, CEREBRAS).save();

  // Back to Groq for one answer, then away again.
  const second = CompletionCache.open(path, 'dev', 'openai/gpt-oss-120b', 1, 3072, SYSTEM, GROQ_API_BASE);
  second.put(entry('CLM-1', hash));
  second.save();
  CompletionCache.open(path, 'dev', 'openai/gpt-oss-120b', 1, 3072, SYSTEM, CEREBRAS).save();

  const archived = readdirSync(join(path, '..')).filter((name) => name.includes('.superseded.'));
  assert.equal(archived.length, 1);
  const kept = JSON.parse(readFileSync(join(path, '..', archived[0]!), 'utf8')) as CompletionCacheFile;
  assert.equal(Object.keys(kept.entries).length, 2, 'the two-answer archive must survive the one-answer run');
});

test('an empty cache is not archived', () => {
  const path = sandbox();
  CompletionCache.open(path, 'dev', 'openai/gpt-oss-120b', 1, 3072, SYSTEM, GROQ_API_BASE).save();
  CompletionCache.open(path, 'dev', 'openai/gpt-oss-120b', 1, 3072, SYSTEM, CEREBRAS).save();

  const archived = readdirSync(join(path, '..')).filter((name) => name.includes('.superseded.'));
  assert.deepEqual(archived, [], 'there was nothing to keep');
  assert.ok(existsSync(path));
});

test('the base URL comes from the flag, then the environment, then Groq', () => {
  const before = process.env['LLM_API_BASE'];
  try {
    delete process.env['LLM_API_BASE'];
    assert.equal(resolveApiBase(), GROQ_API_BASE);
    assert.equal(resolveApiBase(CEREBRAS), CEREBRAS);
    assert.equal(resolveApiBase(`${CEREBRAS}/`), CEREBRAS, 'a trailing slash must not become //models');

    process.env['LLM_API_BASE'] = 'https://api.mistral.ai/v1';
    assert.equal(resolveApiBase(), 'https://api.mistral.ai/v1');
    assert.equal(resolveApiBase(CEREBRAS), CEREBRAS, 'the flag wins over the environment');
  } finally {
    if (before === undefined) delete process.env['LLM_API_BASE'];
    else process.env['LLM_API_BASE'] = before;
  }
});

test('LLM_API_KEY wins, and GROQ_API_KEY still works', () => {
  const beforeLlm = process.env['LLM_API_KEY'];
  const beforeGroq = process.env['GROQ_API_KEY'];
  try {
    delete process.env['LLM_API_KEY'];
    process.env['GROQ_API_KEY'] = 'gsk-old';
    assert.equal(resolveApiKey(), 'gsk-old');

    process.env['LLM_API_KEY'] = 'csk-new';
    assert.equal(resolveApiKey(), 'csk-new');

    delete process.env['LLM_API_KEY'];
    delete process.env['GROQ_API_KEY'];
    assert.equal(resolveApiKey(), '');
  } finally {
    if (beforeLlm === undefined) delete process.env['LLM_API_KEY'];
    else process.env['LLM_API_KEY'] = beforeLlm;
    if (beforeGroq === undefined) delete process.env['GROQ_API_KEY'];
    else process.env['GROQ_API_KEY'] = beforeGroq;
  }
});

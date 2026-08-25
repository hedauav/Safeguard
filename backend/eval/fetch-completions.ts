/**
 * Fills the shared completions cache, one call at a time.
 *
 *   npx tsx eval/fetch-completions.ts --split dev --k 3
 *
 * Why this exists separately from run-cli.ts:
 *
 * run-cli drives its calls through a concurrency pool. Against Groq's free
 * tier that pool oversubscribes an 8,000 token/minute bucket — three workers
 * firing 2,157-token prompts drain it instantly, every worker backs off in
 * lockstep, and on this machine the run stops making requests entirely and
 * never resumes. It also saves the cache only every 25 completions, and the
 * cached-reuse path returns before that check, so a stall can hide for an hour
 * and take up to 24 paid answers with it.
 *
 * This driver does the one thing that has to be reliable: fetch each
 * completion, write it to disk immediately, and pace itself so the bucket is
 * never drained in the first place. It computes nothing and scores nothing.
 * When it finishes, run-cli reads the same cache, finds every answer already
 * there, makes zero calls, and produces the four-arm report as usual.
 *
 * Re-running it resumes: entries that succeeded are kept, entries that failed
 * are refetched, because CompletionCache.get returns null for a failed entry.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';

import {
  ADJUDICATION_SYSTEM_PROMPT,
  buildAdjudicationPrompt,
} from '../src/services/adjudication-service.js';
import { DEFAULT_GROQ_MODEL } from '../src/services/llm-provider.js';

import { adaptCase } from './adapter.js';
import { loadSplit } from './dataset.js';
import {
  CompletionCache,
  RESULTS_DIR,
  completeOnce,
  sha256Text,
  type CompletionEntry,
} from './model-client.js';
import type { SplitName } from './types.js';

loadEnv();

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const split = (get('--split') ?? 'dev') as SplitName;
if (split !== 'dev' && split !== 'holdout') {
  throw new Error(`--split must be dev or holdout, got "${split}"`);
}
if (split === 'holdout' && !argv.includes('--yes-really-the-holdout')) {
  console.error('Refusing to fetch the holdout without --yes-really-the-holdout.');
  process.exit(2);
}

const k = Number(get('--k') ?? 3);
const model = get('--model') ?? process.env['GROQ_MODEL'] ?? DEFAULT_GROQ_MODEL;
/** Must match run-cli's default, or the cache is treated as incompatible. */
const maxTokens = Number(get('--max-tokens') ?? 3072);
/**
 * Groq's free tier refills roughly 8,000 tokens per minute, continuously.
 * A call costing T tokens therefore needs T/133 seconds of refill before the
 * next one. Pacing on measured usage beats a fixed sleep: cheap cases wait
 * less, and nothing has to guess.
 */
const tokensPerSecond = Number(get('--tokens-per-second') ?? (8000 / 60) * 0.95);

const logPath = join(RESULTS_DIR, `fetch-${split}.log`);
const say = (line: string): void => {
  const stamped = `${new Date().toISOString()}  ${line}`;
  console.error(stamped);
  try {
    appendFileSync(logPath, `${stamped}\n`, 'utf8');
  } catch {
    // A log that cannot be written is not a reason to lose the run.
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// ---------------------------------------------------------------------------
// Work
// ---------------------------------------------------------------------------

const apiKey = process.env['GROQ_API_KEY'] ?? '';
if (!apiKey) {
  console.error('No GROQ_API_KEY is set. Nothing to do.');
  process.exit(2);
}

const loaded = loadSplit(split);
const cases = loaded.cases.cases;
say(`split ${split}: ${cases.length} cases, k=${k}, model ${model}, max_tokens ${maxTokens}`);

const prompts = new Map<string, { user: string; hash: string }>();
for (const c of cases) {
  const adapted = adaptCase(c);
  const user = buildAdjudicationPrompt(adapted.facts, adapted.documents);
  prompts.set(c.case_id, { user, hash: sha256Text(user) });
}
say(`built ${prompts.size} prompts`);

const cache = CompletionCache.open(
  join(RESULTS_DIR, `completions-${split}.json`),
  split,
  model,
  k,
  maxTokens,
  ADJUDICATION_SYSTEM_PROMPT
);

interface Item {
  case_id: string;
  run: number;
}
const work: Item[] = [];
for (let run = 1; run <= k; run++) {
  for (const c of cases) work.push({ case_id: c.case_id, run });
}

const alreadyHave = work.filter((w) => cache.get(w.case_id, w.run, prompts.get(w.case_id)!.hash));
say(`${work.length} completions wanted, ${alreadyHave.length} already cached, ${work.length - alreadyHave.length} to fetch`);

let fetched = 0;
let failed = 0;
let throttled = 0;
let done = 0;

for (const item of work) {
  done++;
  const p = prompts.get(item.case_id)!;

  if (cache.get(item.case_id, item.run, p.hash)) continue;

  const startedAt = Date.now();
  const result = await completeOnce(
    { system: ADJUDICATION_SYSTEM_PROMPT, user: p.user },
    { apiKey, model, maxTokens, maxAttempts: 6 }
  );
  const elapsedMs = Date.now() - startedAt;

  const entry: CompletionEntry = {
    case_id: item.case_id,
    run: item.run,
    ok: result.ok,
    text: result.text,
    model: result.model,
    latency_ms: result.latency_ms,
    usage: result.usage,
    attempts: result.attempts,
    throttled_attempts: result.throttled_attempts,
    error: result.error,
    error_kind: result.error_kind,
    http_statuses: result.http_statuses,
    prompt_sha256: p.hash,
    called_at: new Date().toISOString(),
  };

  cache.put(entry);
  cache.save(); // every single call, so a crash costs nothing

  fetched++;
  if (!result.ok) failed++;
  throttled += result.throttled_attempts;

  const tokens = result.usage?.total_tokens ?? 0;
  say(
    `${done}/${work.length}  ${item.case_id}#${item.run}  ${result.ok ? 'ok' : `FAILED (${result.error_kind})`}` +
      `  ${tokens}tok  ${result.attempts}att  ${elapsedMs}ms` +
      `  [fetched ${fetched}, failed ${failed}, 429s ${throttled}]`
  );

  // A wrong key or a retired model id is fatal — every later call fails the
  // same way. A single case whose JSON did not validate is not: it is one
  // answer the model failed to close, recorded as a failure and left for a
  // later pass. Stopping the run on it would throw away the other 99.
  if (result.error_kind === 'client' && !/json_validate_failed/.test(result.error ?? '')) {
    say(`stopping: the provider rejected the request in a way retrying cannot fix — ${result.error}`);
    break;
  }

  // The daily token budget is gone. Every remaining call would spend six
  // attempts and six minutes of backoff to record the same 429, so stop and
  // let the next run resume from the cache once the cap resets. This is the
  // limit that is invisible in the response headers: the per-minute bucket
  // stays healthy while the per-day one is empty.
  if (/tokens per day|TPD/i.test(result.error ?? '')) {
    say(`stopping: the daily token budget for ${model} is exhausted — ${result.error?.slice(0, 200)}`);
    // Count the cache, not this session. `fetched - failed` is what this run
    // added; what survives a restart is every usable answer on disk, including
    // the ones earlier runs paid for.
    const usable = [...cache.all()].filter((e) => e.ok).length;
    say(`resume with the same command once it resets; ${usable} usable answers are cached and will be kept.`);
    break;
  }

  // Pace on what the call actually cost, not on a guess.
  const owedMs = ((tokens || 2200) / tokensPerSecond) * 1000 - elapsedMs;
  if (owedMs > 0) await sleep(owedMs);
}

cache.save();
say(`finished: ${fetched} fetched (${failed} failed), ${throttled} throttled attempts`);
say(`now run: npx tsx eval/run-cli.ts --split ${split} --k ${k}`);

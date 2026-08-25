/**
 * One model call, metered, retried, and written down.
 *
 * Three things this file exists to prevent.
 *
 * THE RETIRED MODEL. Groq removes model ids without notice. The id that was
 * the default in this repo a month ago — `llama-3.3-70b-versatile` — is gone,
 * and a request for it fails per call rather than at startup, which across a
 * long run reads as a flaky provider rather than a wrong configuration.
 * `preflightModel` asks `/v1/models` first and refuses to start against an id
 * the account cannot reach, printing the ids it can.
 *
 * THE RATE LIMIT THAT BECOMES A VERDICT. A 429 caught and turned into
 * `escalate` without being counted is a wrong verdict wearing a right one's
 * clothes. Every call records its attempts, whether it was throttled, and what
 * finally happened; nothing above this layer may read a failure as an answer.
 *
 * THE UNMEASURED COST. `LlmProvider` returns no token counts, so this module
 * injects its own `fetch` into `GroqProvider` — the seam the provider already
 * exposes for tests — and reads `usage` off the envelope on the way past. The
 * shipping provider still builds the request and parses the response, so the
 * code being measured is the code that ships.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GroqProvider,
  LlmTimeoutError,
  type LlmCompletionRequest,
} from '../src/services/llm-provider.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = join(HERE, 'results');
export const GROQ_API_BASE = 'https://api.groq.com/openai/v1';

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export function emptyUsage(): TokenUsage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

export function addUsage(into: TokenUsage, from: TokenUsage): TokenUsage {
  into.prompt_tokens += from.prompt_tokens;
  into.completion_tokens += from.completion_tokens;
  into.total_tokens += from.total_tokens;
  return into;
}

/** What one HTTP round trip did, captured on the way past. */
interface WireRecord {
  status: number | null;
  retryAfterSeconds: number | null;
  usage: TokenUsage | null;
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * A `fetch` that records status, `retry-after` and `usage` into `record` and
 * otherwise behaves exactly like the real one. The body is read once and
 * handed on as a fresh Response, so the provider above still parses it.
 */
function meteredFetch(record: WireRecord): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await fetch(input, init);
    record.status = response.status;

    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) record.retryAfterSeconds = numberOr(retryAfter, 0) || null;

    const text = await response.text();
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const usage = body?.['usage'] as Record<string, unknown> | undefined;
      if (usage && typeof usage === 'object') {
        record.usage = {
          prompt_tokens: numberOr(usage['prompt_tokens'], 0),
          completion_tokens: numberOr(usage['completion_tokens'], 0),
          total_tokens: numberOr(usage['total_tokens'], 0),
        };
      }
    } catch {
      // Not JSON. That is the provider's failure to report, not ours to hide.
    }

    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export class UnknownModelError extends Error {
  constructor(
    public readonly model: string,
    public readonly available: string[]
  ) {
    super(
      [
        `The configured model "${model}" is not one this account can reach.`,
        '',
        'Groq retires model ids without notice, and a request for a retired id fails',
        'per call rather than at startup — across a long run that reads as a flaky',
        'provider rather than a wrong configuration. Refusing to start instead.',
        '',
        `Ids available to this key (${available.length}):`,
        ...available.map((id) => `  ${id}`),
        '',
        'Set GROQ_MODEL in backend/.env to one of these, or pass --model.',
      ].join('\n')
    );
    this.name = 'UnknownModelError';
  }
}

/** Ask the provider which ids exist, and refuse to run against one that does not. */
export async function preflightModel(
  apiKey: string,
  model: string,
  baseUrl = GROQ_API_BASE
): Promise<string[]> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Could not list models (${response.status}): ${detail.slice(0, 300)}\n` +
        'Without that list a retired model id cannot be told apart from a flaky network, so ' +
        'the run stops here rather than attributing hundreds of failures to the wrong cause.'
    );
  }
  const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
  const available = (body.data ?? [])
    .map((entry) => (typeof entry.id === 'string' ? entry.id : null))
    .filter((id): id is string => id !== null)
    .sort();

  if (!available.includes(model)) throw new UnknownModelError(model, available);
  return available;
}

// ---------------------------------------------------------------------------
// One call
// ---------------------------------------------------------------------------

export type CallErrorKind = 'timeout' | 'throttled' | 'server' | 'client' | 'network' | null;

export interface CallResult {
  ok: boolean;
  text: string | null;
  /** The id the provider says answered, which may differ from the one asked for. */
  model: string | null;
  latency_ms: number | null;
  usage: TokenUsage;
  attempts: number;
  /** Attempts that came back 429, counted even when a later attempt succeeded. */
  throttled_attempts: number;
  error: string | null;
  error_kind: CallErrorKind;
  http_statuses: number[];
}

export interface CallOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  /**
   * Completion budget. `GroqProvider` defaults to 1024 and `adjudicateClaim`
   * does not override it; on a reasoning model that budget is spent on the
   * reasoning trace and the JSON object is never closed, which Groq returns as
   * a 400 `json_validate_failed`. The harness sets it explicitly and records
   * the value, because a number measured under a budget the shipping code does
   * not use has to say so.
   */
  maxTokens?: number;
  maxAttempts?: number;
  /** Ceiling on one backoff sleep, so a bad `retry-after` cannot stall the run. */
  maxBackoffMs?: number;
  /** Injectable so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable so tests do not depend on wall-clock jitter. */
  jitter?: () => number;
}

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_MAX_BACKOFF_MS = 60_000;
export const DEFAULT_CALL_TIMEOUT_MS = 45_000;

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The status a `LlmUnavailableError` was carrying, if it was carrying one. */
export function statusFromError(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /\((\d{3})\)/.exec(message);
  return match ? Number(match[1]) : null;
}

export function classifyFailure(error: unknown, status: number | null): CallErrorKind {
  if (error instanceof LlmTimeoutError) return 'timeout';
  if (status === 429) return 'throttled';
  if (status !== null && status >= 500) return 'server';
  if (status !== null && status >= 400) return 'client';
  return 'network';
}

/**
 * Statuses that mean the run is misconfigured rather than one case being hard.
 *
 * Kept deliberately narrow. A 400 is not on this list: Groq returns 400 with
 * `json_validate_failed` when a reasoning model spends its whole token budget
 * before closing the JSON object, which is a property of THAT prompt and that
 * budget, not of the key or the model id. Treating it as fatal stops a 500-call
 * run on its twelfth case; treating it as a per-case failure records it, counts
 * it, and lets the other 488 cases be measured.
 */
const FATAL_STATUSES = new Set([401, 403, 404]);

function isRetryable(kind: CallErrorKind): boolean {
  return kind === 'throttled' || kind === 'server' || kind === 'timeout' || kind === 'network';
}

/**
 * Complete one prompt, retrying only what is worth retrying.
 *
 * A 429, a 5xx, a timeout and a network fault are transient and get a backoff.
 * A 4xx that is not 429 is a wrong request — a retired model id, a bad key —
 * and retrying it four more times turns one clear error into five noisy ones.
 * It stops immediately, and the caller stops the run.
 */
export async function completeOnce(
  request: LlmCompletionRequest,
  options: CallOptions
): Promise<CallResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const jitter = options.jitter ?? (() => Math.floor(Math.random() * 400));

  const usage = emptyUsage();
  const statuses: number[] = [];
  let throttled = 0;
  let attemptsMade = 0;
  let lastError = '';
  let lastKind: CallErrorKind = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsMade = attempt;
    const wire: WireRecord = { status: null, retryAfterSeconds: null, usage: null };
    const provider = new GroqProvider(options.apiKey, {
      model: options.model,
      baseUrl: options.baseUrl,
      fetchImpl: meteredFetch(wire),
    });

    try {
      const completion = await provider.complete({
        ...request,
        timeoutMs,
        maxTokens: options.maxTokens ?? request.maxTokens,
      });
      if (wire.status !== null) statuses.push(wire.status);
      // Tokens are billed on every attempt that reached the model, including
      // ones whose answers were thrown away.
      if (wire.usage) addUsage(usage, wire.usage);
      return {
        ok: true,
        text: completion.text,
        model: completion.model,
        latency_ms: completion.latencyMs,
        usage,
        attempts: attempt,
        throttled_attempts: throttled,
        error: null,
        error_kind: null,
        http_statuses: statuses,
      };
    } catch (error) {
      const status = wire.status ?? statusFromError(error);
      if (status !== null) statuses.push(status);
      if (wire.usage) addUsage(usage, wire.usage);

      const kind = classifyFailure(error, status);
      if (kind === 'throttled') throttled++;
      lastKind = kind;
      lastError = error instanceof Error ? error.message : String(error);

      if (!isRetryable(kind) || attempt === maxAttempts) break;

      const advised = wire.retryAfterSeconds !== null ? wire.retryAfterSeconds * 1000 : null;
      const backoff = advised ?? Math.min(maxBackoffMs, 1000 * 2 ** (attempt - 1));
      // Jitter so a burst of throttled calls does not resynchronise and
      // throttle again in lockstep. It moves timing, never a verdict.
      await sleep(Math.min(maxBackoffMs, backoff + jitter()));
    }
  }

  return {
    ok: false,
    text: null,
    model: null,
    latency_ms: null,
    usage,
    attempts: attemptsMade,
    throttled_attempts: throttled,
    error: lastError || 'The call failed without reporting a reason.',
    error_kind: lastKind,
    http_statuses: statuses,
  };
}

/** A failure that means stopping the whole run rather than failing one case. */
export function isFatalConfigurationError(result: CallResult): boolean {
  if (result.ok) return false;
  return result.http_statuses.some((status) => FATAL_STATUSES.has(status));
}

// ---------------------------------------------------------------------------
// The shared cache
// ---------------------------------------------------------------------------

export const CACHE_VERSION = 1;

export interface CompletionEntry {
  case_id: string;
  /** 1-based run index within the k repeats. */
  run: number;
  ok: boolean;
  text: string | null;
  model: string | null;
  latency_ms: number | null;
  usage: TokenUsage;
  attempts: number;
  throttled_attempts: number;
  error: string | null;
  error_kind: CallErrorKind;
  http_statuses: number[];
  /** sha256 of the exact user prompt this answer was given. */
  prompt_sha256: string;
  called_at: string;
}

export interface CompletionCacheFile {
  version: number;
  split: string;
  /** The id asked for. Each entry also records the id that answered. */
  model_requested: string;
  k: number;
  /**
   * The completion budget these answers were generated under. Part of the
   * cache identity because it changes answers: a reasoning model given 1024
   * tokens and one given 3072 are, for scoring purposes, two different models.
   */
  max_tokens: number;
  system_prompt_sha256: string;
  entries: Record<string, CompletionEntry>;
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function cacheKey(caseId: string, run: number): string {
  return `${caseId}#${run}`;
}

/**
 * Every completion the run made, on disk.
 *
 * Arms B and C read the same entry for a given case and run. That is the whole
 * point. Two arms that each call the model and trust `temperature: 0` to make
 * the draws agree are two arms whose difference includes whatever the provider
 * did that afternoon; a control the harness does not hold is a control it does
 * not have, so the harness holds it.
 *
 * A cached answer is reused only when the prompt that produced it hashes the
 * same. Change the prompt and the cache empties itself rather than reporting
 * yesterday's answers against today's question. A recorded failure is never
 * reused: re-running after a rate limit should re-ask, not re-read the 429.
 */
export class CompletionCache {
  private readonly file: CompletionCacheFile;
  readonly path: string;
  private reused = 0;
  private fetched = 0;

  private constructor(path: string, file: CompletionCacheFile) {
    this.path = path;
    this.file = file;
  }

  static open(
    path: string,
    split: string,
    model: string,
    k: number,
    maxTokens: number,
    systemPrompt: string
  ): CompletionCache {
    const systemHash = sha256Text(systemPrompt);
    const fresh: CompletionCacheFile = {
      version: CACHE_VERSION,
      split,
      model_requested: model,
      k,
      max_tokens: maxTokens,
      system_prompt_sha256: systemHash,
      entries: {},
    };

    if (!existsSync(path)) return new CompletionCache(path, fresh);

    let existing: CompletionCacheFile;
    try {
      existing = JSON.parse(readFileSync(path, 'utf8')) as CompletionCacheFile;
    } catch {
      return new CompletionCache(path, fresh);
    }

    const compatible =
      existing.version === CACHE_VERSION &&
      existing.split === split &&
      existing.model_requested === model &&
      existing.max_tokens === maxTokens &&
      existing.system_prompt_sha256 === systemHash;

    // k is deliberately not part of compatibility: raising k should add runs,
    // not discard the ones already paid for.
    if (!compatible) return new CompletionCache(path, fresh);
    existing.k = Math.max(existing.k, k);
    return new CompletionCache(path, existing);
  }

  get(caseId: string, run: number, promptHash: string): CompletionEntry | null {
    const entry = this.file.entries[cacheKey(caseId, run)];
    if (!entry) return null;
    if (entry.prompt_sha256 !== promptHash) return null;
    if (!entry.ok) return null;
    return entry;
  }

  put(entry: CompletionEntry): void {
    this.file.entries[cacheKey(entry.case_id, entry.run)] = entry;
  }

  noteReuse(): void {
    this.reused++;
  }

  noteFetch(): void {
    this.fetched++;
  }

  get reusedCount(): number {
    return this.reused;
  }

  get fetchedCount(): number {
    return this.fetched;
  }

  all(): CompletionEntry[] {
    return Object.values(this.file.entries);
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.file, null, 2)}\n`, 'utf8');
  }
}

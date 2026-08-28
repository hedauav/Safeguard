/**
 * Provider-agnostic language-model surface.
 *
 * One method, one string in, one string out. Everything that makes a model
 * useful to this codebase — the schema it must answer in, what happens when it
 * does not, and what its answer is allowed to influence — lives above this
 * boundary in adjudication-service.ts, so swapping Groq for anything else
 * changes nothing about how a recommendation is reached.
 *
 * The shape mirrors the OpenAI chat-completions API because that is what Groq
 * serves, not because the caller knows or cares.
 */

/** Default ceiling on a single completion. A phone call cannot wait longer. */
export const DEFAULT_LLM_TIMEOUT_MS = 20_000;

/**
 * Groq's OpenAI-compatible endpoint. Overridable so the provider can be
 * exercised against a stub without a network.
 */
const GROQ_API_BASE = 'https://api.groq.com/openai/v1';

/** Used when GROQ_MODEL is unset. Not validated here — see GroqProvider. */
// Pinned to a model the account can actually reach. Groq retires model ids
// without notice — llama-3.3-70b-versatile was the previous default here and
// no longer appears in /v1/models, which fails at request time rather than at
// startup. Override with GROQ_MODEL.
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';

export interface LlmCompletionRequest {
  /** Instructions and output contract. Never contains claimant-supplied text. */
  system: string;
  /** The facts to reason over. Contains claimant-supplied text; see the caller. */
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * What the provider says the call cost, in tokens.
 *
 * Every field is independently nullable because this is reported, not
 * measured here: a provider that omits `usage`, or omits one field of it,
 * must leave a null rather than a zero. Zero tokens is a claim that the call
 * was free, and a cost model built on fabricated zeroes is worse than one
 * built on nothing — the gap is at least visible.
 */
export interface LlmUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface LlmCompletion {
  /** Exactly what the model returned, unparsed. */
  text: string;
  /** The model id that actually answered, as reported by the provider. */
  model: string;
  latencyMs: number;
  /**
   * Tokens the provider billed for this call, or null when it reported none.
   *
   * Groq returns these in the same response body as the answer and this
   * codebase used to discard them, which left every adjudication row with no
   * evidence of what it cost. Persisted by the caller for exactly that reason.
   */
  usage: LlmUsage | null;
  /**
   * True when this came from FakeLlmProvider: no model ran and the text is
   * canned. Callers must persist the flag, because a recommendation recorded
   * without it reads as though a model had read the documents.
   */
  simulated: boolean;
}

export interface LlmProvider {
  /** Recorded on the adjudication row, so it states which rail answered. */
  readonly name: string;
  complete(request: LlmCompletionRequest): Promise<LlmCompletion>;
}

/** The model did not answer in time. Distinct so the caller can record why. */
export class LlmTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`The model did not respond within ${timeoutMs} ms`);
    this.name = 'LlmTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** The provider was reachable but unusable: auth, quota, malformed envelope. */
export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

/**
 * A count from the provider, or null.
 *
 * Anything that is not a finite non-negative integer becomes null rather than
 * being coerced: a NaN written to an INT column fails the insert, and a
 * silently-floored float would be a token count nobody produced.
 */
function readTokenCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/**
 * Groq's OpenAI-shaped `usage` object, or null when it sent none.
 *
 * Returns null — not a row of nulls — when the provider omitted usage
 * entirely, so "the provider said nothing" and "the provider said zero" stay
 * distinguishable on the adjudication row.
 */
export function readUsage(raw: unknown): LlmUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const usage = raw as Record<string, unknown>;
  const promptTokens = readTokenCount(usage['prompt_tokens']);
  const completionTokens = readTokenCount(usage['completion_tokens']);
  const totalTokens = readTokenCount(usage['total_tokens']);
  if (promptTokens === null && completionTokens === null && totalTokens === null) {
    return null;
  }
  return { promptTokens, completionTokens, totalTokens };
}

/** USD per million tokens. Either side may be absent; see computeModelCostUsd. */
export interface TokenPrices {
  inputPerMTok: number | null;
  outputPerMTok: number | null;
}

/**
 * What a completion cost, in USD, or null.
 *
 * Null unless BOTH rates and BOTH token counts are present. A half-priced
 * call — output tokens counted, input tokens free because nobody configured
 * their rate — would be a cost figure that understates by exactly the part
 * that was missing, and it would look like every other figure in the column.
 * Refusing to produce one is the only way the column stays trustworthy.
 */
export function computeModelCostUsd(
  usage: LlmUsage | null,
  prices: TokenPrices
): number | null {
  if (!usage) return null;
  if (prices.inputPerMTok === null || prices.outputPerMTok === null) return null;
  if (usage.promptTokens === null || usage.completionTokens === null) return null;

  const cost =
    (usage.promptTokens / 1_000_000) * prices.inputPerMTok +
    (usage.completionTokens / 1_000_000) * prices.outputPerMTok;

  if (!Number.isFinite(cost) || cost < 0) return null;
  // Eight decimals, matching NUMERIC(14, 8). A single adjudication costs a
  // fraction of a cent, so rounding to cents would record every one of them
  // as zero.
  return Number(cost.toFixed(8));
}

export interface GroqProviderOptions {
  baseUrl?: string;
  model?: string;
  /** Injected in tests so the provider can be exercised without a network. */
  fetchImpl?: typeof fetch;
}

/**
 * Groq chat completions over HTTP bearer auth.
 *
 * Failures throw rather than returning empty text, so the caller escalates
 * instead of reading a blank answer as agreement. The model id is passed
 * through unchecked: we do not maintain a list of Groq's current models, and
 * a wrong id fails the call loudly here rather than silently downgrading.
 */
export class GroqProvider implements LlmProvider {
  readonly name = 'groq';
  readonly model: string;

  private readonly authorization: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, options: GroqProviderOptions = {}) {
    // Built once and never logged. The key must not reach a log line, an
    // error message, or a stack trace that gets shipped somewhere.
    this.authorization = `Bearer ${apiKey}`;
    this.baseUrl = options.baseUrl ?? GROQ_API_BASE;
    this.model = options.model ?? DEFAULT_GROQ_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    const startedAt = Date.now();

    // AbortSignal rather than Promise.race: racing leaves the request running
    // and its tokens billed after we have stopped caring about the answer.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: this.authorization,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          // temperature 0 is a request, not a guarantee. It is what the API
          // exposes for "stay as close to greedy decoding as you can"; it does
          // not make the provider deterministic, and nothing here may be built
          // on the assumption that the same prompt returns the same bytes
          // twice. That is why the raw response is stored verbatim and why
          // every downstream check re-derives its own answer.
          temperature: 0,
          max_tokens: request.maxTokens ?? 1024,
          // Asks the server to constrain output to a JSON object. Also only a
          // request: the parser above this layer still treats anything
          // unparseable as a parse failure rather than trusting the flag.
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
        }),
      });
    } catch (error) {
      if (controller.signal.aborted) throw new LlmTimeoutError(timeoutMs);
      throw new LlmUnavailableError(
        `Groq request failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // The body is Groq's error envelope, not our credentials.
      const detail = await response.text().catch(() => '');
      throw new LlmUnavailableError(
        `Groq completion failed (${response.status}): ${detail.slice(0, 300)}`
      );
    }

    const body = (await response.json().catch(() => null)) as Record<string, any> | null;
    const text = body?.choices?.[0]?.message?.content;

    if (typeof text !== 'string') {
      throw new LlmUnavailableError('Groq response carried no message content');
    }

    return {
      text,
      usage: readUsage(body?.usage),
      // Echo the model the provider says answered, not the one we asked for:
      // if they differ, the one that produced these tokens is the one worth
      // recording against the recommendation.
      model: typeof body?.model === 'string' ? body.model : this.model,
      latencyMs: Date.now() - startedAt,
      simulated: false,
    };
  }
}

/**
 * What FakeLlmProvider says when nobody scripted it.
 *
 * Deliberately an escalation with zero confidence and an inconsistency that
 * states plainly that no model ran. A fake that answered "approve" would make
 * an unconfigured deployment look like a working one.
 */
export const NO_MODEL_CONFIGURED_RESPONSE = JSON.stringify({
  verdict: 'escalate',
  confidence: 0,
  policy_clauses: [],
  inconsistencies: [
    'No language model is configured, so the uploaded documents were not read. A human must review this claim.',
  ],
  proposed_amount: null,
});

/** A scripted answer for one call. May throw, so faults are reproducible. */
export type FakeLlmScript = (request: LlmCompletionRequest) => string | Promise<string>;

/**
 * In-process stand-in used when no Groq credentials are configured, and the
 * only provider the tests ever see.
 *
 * It never reaches a network. Its answers come either from the script the
 * caller supplied — which may also throw, so timeouts and outages are
 * reproducible without one — or from NO_MODEL_CONFIGURED_RESPONSE.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly name = 'fake';
  readonly model = 'fake-adjudicator-v1';

  private readonly script: FakeLlmScript;
  private readonly requests: LlmCompletionRequest[] = [];

  constructor(script?: FakeLlmScript) {
    this.script = script ?? (() => NO_MODEL_CONFIGURED_RESPONSE);
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    this.requests.push(request);
    const startedAt = Date.now();
    const text = await this.script(request);
    return {
      text,
      model: this.model,
      // Null, not zero. No model ran, so there is no token count to report,
      // and a zero here would read as a real call that happened to be free.
      usage: null,
      // Floored at 1 so a recorded latency is never 0, which reads as "not
      // measured" on the adjudication row.
      latencyMs: Math.max(1, Date.now() - startedAt),
      simulated: true,
    };
  }

  /** Every request this provider was asked to complete, in order. */
  calls(): LlmCompletionRequest[] {
    return [...this.requests];
  }
}

/**
 * Real when a key exists, fake otherwise — never both, and never a fake answer
 * presented as a model's. Credentials are passed in rather than read from
 * config here, so this module stays free of the environment and of the import
 * cycle that would create.
 */
export function createLlmProvider(credentials: {
  apiKey: string | null;
  model?: string | null;
}): LlmProvider {
  if (credentials.apiKey) {
    return new GroqProvider(credentials.apiKey, { model: credentials.model ?? undefined });
  }
  return new FakeLlmProvider();
}

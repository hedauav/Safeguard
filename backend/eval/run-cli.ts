/**
 * The four-arm evaluation run.
 *
 *   npx tsx eval/run-cli.ts --split dev --k 5
 *   npx tsx eval/run-cli.ts --split dev --k 5 --no-model     (arm A only, no network)
 *
 * What it does, in order:
 *
 *   1. Refuses to start against a model id the account cannot reach.
 *   2. Loads the split. The holdout additionally requires an explicit flag,
 *      because running it is a decision made once and not a default.
 *   3. Builds one prompt per case, using the shipping prompt builder.
 *   4. Calls the model k times per case, ONCE, into a shared cache.
 *   5. Runs all four arms over that one set of completions.
 *   6. Scores every arm with scoring.ts — there is no second scorer.
 *   7. Writes the artefacts, so the figures can be verified rather than trusted.
 *
 * Step 4 is the design point. Arms B and C do not each call the model. They
 * read the same answer. Two arms that call independently and rely on
 * temperature 0 to make the draws agree have made the provider's behaviour
 * that afternoon part of their independent variable.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

import {
  ADJUDICATION_SYSTEM_PROMPT,
  buildAdjudicationPrompt,
  parseModelVerdict,
} from '../src/services/adjudication-service.js';
import { DEFAULT_GROQ_MODEL } from '../src/services/llm-provider.js';

import { adaptCase } from './adapter.js';
import {
  ARM_D_SEED,
  agreement,
  armA,
  armB,
  armC,
  armD,
  majorityVerdict,
  toPredictions,
  type ArmOutcome,
} from './arms.js';
import { loadSplit } from './dataset.js';
import {
  renderFourArmReport,
  type ArmAccounting,
  type KRepeatSummary,
  type NarrationInput,
  type RunManifest,
  type ScoredRow,
} from './four-arm-report.js';
import {
  CompletionCache,
  RESULTS_DIR,
  addUsage,
  completeOnce,
  resolveApiBase,
  resolveApiKey,
  emptyUsage,
  isFatalConfigurationError,
  preflightModel,
  sha256Text,
  UnknownModelError,
  type CompletionEntry,
} from './model-client.js';
import { renderSealStatus } from './seal.js';
import { RULEBOOK_VERSION } from './rules.js';
import {
  SCORING_RULES_VERSION,
  renderReport,
  score,
  type Prediction,
  type ScoreResult,
} from './scoring.js';
import type { SplitName, Verdict } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(HERE, '..', '.env') });

/**
 * The completion budget the shipping code actually uses.
 *
 * `GroqProvider.complete` falls back to 1024 when the caller names no ceiling,
 * and `adjudicateClaim` names none. On `openai/gpt-oss-120b` — the model the
 * repo is configured for — that is not enough: the model spends the budget on
 * its reasoning trace, never closes the JSON object, and Groq rejects the whole
 * request with a 400 `json_validate_failed`. Measured on this split, a
 * successful answer costs between 561 and 899 completion tokens, so 1024 is not
 * comfortably above the requirement, it is inside the noise.
 *
 * The harness therefore raises the budget and says so in the manifest and in
 * the caveats, rather than reporting a score obtained under a setting the
 * shipping code does not use and calling it the shipping system's score.
 */
export const SHIPPED_MAX_TOKENS = 1024;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
  split: SplitName;
  k: number;
  model: string;
  /** Which OpenAI-compatible provider answers. Recorded in the manifest. */
  apiBase: string;
  concurrency: number;
  maxTokens: number;
  maxAttempts: number;
  armDSeed: number;
  noModel: boolean;
  confirmHoldout: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index === -1 ? null : (argv[index + 1] ?? null);
  };
  const has = (flag: string) => argv.includes(flag);

  const split = (get('--split') ?? 'dev') as SplitName;
  if (split !== 'dev' && split !== 'holdout') {
    throw new Error(`--split must be dev or holdout, got "${split}"`);
  }

  const k = Number(get('--k') ?? 5);
  if (!Number.isInteger(k) || k < 1) throw new Error(`--k must be a positive integer, got "${k}"`);

  return {
    split,
    k,
    model: get('--model') ?? process.env['GROQ_MODEL'] ?? DEFAULT_GROQ_MODEL,
    apiBase: resolveApiBase(get('--base-url')),
    concurrency: Number(get('--concurrency') ?? 3),
    maxTokens: Number(get('--max-tokens') ?? SHIPPED_MAX_TOKENS * 3),
    maxAttempts: Number(get('--max-attempts') ?? 6),
    armDSeed: Number(get('--arm-d-seed') ?? ARM_D_SEED),
    noModel: has('--no-model'),
    confirmHoldout: has('--yes-really-the-holdout'),
  };
}

// ---------------------------------------------------------------------------
// A tiny concurrency pool
// ---------------------------------------------------------------------------

async function pool<T>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<void>) {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface CaseWork {
  case_id: string;
  run: number;
  promptUser: string;
  promptHash: string;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();

  if (args.split === 'holdout' && !args.confirmHoldout) {
    console.error(
      [
        'Refusing to run against the holdout.',
        '',
        'Spending the holdout is a decision made once, deliberately, and it cannot be',
        'unmade: every number produced against it afterwards is a number produced against',
        'a set that has been seen. If that decision has genuinely been taken, say so:',
        '',
        '  npx tsx eval/run-cli.ts --split holdout --yes-really-the-holdout',
      ].join('\n')
    );
    return 2;
  }

  const loaded = loadSplit(args.split);
  const cases = loaded.cases.cases;
  const truth = loaded.truth.entries;
  const caseIds = cases.map((c) => c.case_id);

  console.error(`Loaded ${cases.length} cases from the ${args.split} split (seed ${loaded.cases.seed}).`);

  // --- Preflight ----------------------------------------------------------
  const apiKey = resolveApiKey();
  let modelAvailable = false;

  if (!args.noModel) {
    if (!apiKey) {
      console.error(
        [
          'No LLM_API_KEY or GROQ_API_KEY is set, so no model can be called.',
          '',
          'Not falling back to FakeLlmProvider: a fake answer scored as though a model had',
          'read the documents is the single most misleading number this harness could produce.',
          'Run with --no-model to measure arm A alone, or set the key.',
        ].join('\n')
      );
      return 2;
    }
    try {
      const available = await preflightModel(apiKey, args.model, args.apiBase);
      modelAvailable = true;
      console.error(
        `Model "${args.model}" is reachable at ${args.apiBase} ` +
          `(${available.length} ids available to this key).`
      );
    } catch (error) {
      if (error instanceof UnknownModelError) {
        console.error(error.message);
        return 2;
      }
      console.error(String(error instanceof Error ? error.message : error));
      return 2;
    }
  }

  // --- Prompts ------------------------------------------------------------
  const adapted = new Map(cases.map((c) => [c.case_id, adaptCase(c)]));
  const prompts = new Map<string, { user: string; hash: string }>();
  for (const c of cases) {
    const user = buildAdjudicationPrompt(adapted.get(c.case_id)!.facts, adapted.get(c.case_id)!.documents);
    prompts.set(c.case_id, { user, hash: sha256Text(user) });
  }

  // --- The shared cache ---------------------------------------------------
  mkdirSync(RESULTS_DIR, { recursive: true });
  const completionsPath = join(RESULTS_DIR, `completions-${args.split}.json`);
  const cache = CompletionCache.open(
    completionsPath,
    args.split,
    args.model,
    args.k,
    args.maxTokens,
    ADJUDICATION_SYSTEM_PROMPT,
    args.apiBase
  );

  const usage = emptyUsage();
  let callsMade = 0;
  let callsFailed = 0;
  let throttledAttempts = 0;
  const modelsThatAnswered = new Set<string>();
  let fatalConfiguration: string | null = null;

  if (modelAvailable) {
    const work: CaseWork[] = [];
    for (let run = 1; run <= args.k; run++) {
      for (const c of cases) {
        const p = prompts.get(c.case_id)!;
        work.push({ case_id: c.case_id, run, promptUser: p.user, promptHash: p.hash });
      }
    }

    let done = 0;
    await pool(work, args.concurrency, async (item) => {
      if (fatalConfiguration) return;

      const cached = cache.get(item.case_id, item.run, item.promptHash);
      if (cached) {
        cache.noteReuse();
        if (cached.model) modelsThatAnswered.add(cached.model);
        done++;
        return;
      }

      const result = await completeOnce(
        { system: ADJUDICATION_SYSTEM_PROMPT, user: item.promptUser },
        {
          apiKey,
          model: args.model,
          baseUrl: args.apiBase,
          maxTokens: args.maxTokens,
          maxAttempts: args.maxAttempts,
        }
      );

      cache.noteFetch();
      callsMade++;
      addUsage(usage, result.usage);
      throttledAttempts += result.throttled_attempts;
      if (!result.ok) callsFailed++;
      if (result.model) modelsThatAnswered.add(result.model);

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
        prompt_sha256: item.promptHash,
        called_at: new Date().toISOString(),
      };
      cache.put(entry);

      if (isFatalConfigurationError(result)) {
        fatalConfiguration = result.error;
      }

      done++;
      if (done % 25 === 0 || done === work.length) {
        // Saved as we go: a run that dies at case 380 of 500 should not throw
        // away 380 paid-for answers.
        cache.save();
        console.error(
          `  ${done}/${work.length} completions (${cache.fetchedCount} fetched, ${cache.reusedCount} reused, ${callsFailed} failed, ${throttledAttempts} throttled attempts)`
        );
      }
    });
    cache.save();

    if (fatalConfiguration) {
      console.error('');
      console.error('Stopped: the provider rejected the request in a way that retrying cannot fix.');
      console.error(fatalConfiguration);
      console.error('');
      console.error('Partial completions have been saved. Nothing was scored, because a run that lost');
      console.error('an unknown fraction of its calls to a configuration fault is not a run.');
      return 2;
    }
  }

  // --- The arms -----------------------------------------------------------
  const modelRan = modelAvailable;

  const aOutcomes: ArmOutcome[] = cases.map((c) => armA(adapted.get(c.case_id)!, c.case_id));

  // Per run, per arm.
  const bByRun: ArmOutcome[][] = [];
  const cByRun: ArmOutcome[][] = [];
  const modelVerdictsByCase = new Map<string, Array<Verdict | null>>();
  const confidenceByCase = new Map<string, Array<{ verdict: Verdict | null; confidence: number | null }>>();

  if (modelRan) {
    const entriesByKey = new Map<string, CompletionEntry>();
    for (const entry of cache.all()) entriesByKey.set(`${entry.case_id}#${entry.run}`, entry);

    for (let run = 1; run <= args.k; run++) {
      const b: ArmOutcome[] = [];
      const c: ArmOutcome[] = [];
      for (const evalCase of cases) {
        const entry = entriesByKey.get(`${evalCase.case_id}#${run}`) ?? null;
        b.push(armB(evalCase.case_id, entry));
        c.push(armC(adapted.get(evalCase.case_id)!, evalCase.case_id, entry));

        // Repeatability is a property of the MODEL, so it is measured on the
        // model's own verdict before any veto or forcing. Measuring it on arm
        // C's output would report the deterministic layer's stability as the
        // model's, and the deterministic layer is stable by construction.
        const readable = entry && entry.ok && entry.text !== null ? parseModelVerdict(entry.text) : null;
        const verdict = readable && readable.ok ? readable.verdict.verdict : null;
        const confidence = readable && readable.ok ? readable.verdict.confidence : null;

        const list = modelVerdictsByCase.get(evalCase.case_id) ?? [];
        list.push(verdict);
        modelVerdictsByCase.set(evalCase.case_id, list);

        const confList = confidenceByCase.get(evalCase.case_id) ?? [];
        confList.push({ verdict, confidence });
        confidenceByCase.set(evalCase.case_id, confList);
      }
      bByRun.push(b);
      cByRun.push(c);
    }
  }

  // --- Scoring ------------------------------------------------------------
  const scoreOf = (predictions: Prediction[]): ScoreResult => score(predictions, truth, args.split);

  const aScore = scoreOf(toPredictions(aOutcomes));

  let bRun1: ScoreResult | null = null;
  let bMajority: ScoreResult | null = null;
  let cRun1: ScoreResult | null = null;
  let cMajority: ScoreResult | null = null;
  let dScore: ScoreResult | null = null;
  let dPredictions: Prediction[] | null = null;
  let bMajorityPredictions: Prediction[] | null = null;
  let cMajorityPredictions: Prediction[] | null = null;

  const kSummary: KRepeatSummary = {
    k: args.k,
    measurable: 0,
    unanimous: 0,
    tied: 0,
    excluded: 0,
    unstable: [],
    run1_vs_majority_flips: 0,
    confidence_note: null,
  };

  if (modelRan) {
    bRun1 = scoreOf(toPredictions(bByRun[0]!));
    cRun1 = scoreOf(toPredictions(cByRun[0]!));

    const majorityOver = (byRun: ArmOutcome[][]): Prediction[] =>
      caseIds.map((case_id, index) => {
        const verdicts = byRun.map((run) => run[index]!.verdict);
        return { case_id, verdict: majorityVerdict(verdicts).verdict };
      });

    bMajorityPredictions = majorityOver(bByRun);
    cMajorityPredictions = majorityOver(cByRun);
    bMajority = scoreOf(bMajorityPredictions);
    cMajority = scoreOf(cMajorityPredictions);

    dPredictions = armD(caseIds, toPredictions(cByRun[0]!).map((p) => p.verdict), args.armDSeed);
    dScore = scoreOf(dPredictions);

    const agreementReport = agreement(modelVerdictsByCase);
    kSummary.measurable = agreementReport.measurable;
    kSummary.unanimous = agreementReport.unanimous;
    kSummary.tied = agreementReport.tied;
    kSummary.excluded = agreementReport.excluded;
    kSummary.unstable = agreementReport.unstable;

    const cRun1ById = new Map(toPredictions(cByRun[0]!).map((p) => [p.case_id, p.verdict]));
    kSummary.run1_vs_majority_flips = cMajorityPredictions.filter(
      (p) => cRun1ById.get(p.case_id) !== p.verdict
    ).length;

    // Is the model's confidence any guide to whether it is about to be the
    // outlier? Measured rather than assumed.
    let minoritySum = 0;
    let minorityCount = 0;
    let majoritySum = 0;
    let majorityCount = 0;
    for (const u of agreementReport.unstable) {
      const runs = confidenceByCase.get(u.case_id) ?? [];
      const readable = runs.filter((r) => r.verdict !== null && r.confidence !== null);
      if (readable.length === 0) continue;
      const winner = majorityVerdict(readable.map((r) => r.verdict!)).verdict;
      for (const r of readable) {
        if (r.verdict === winner) {
          majoritySum += r.confidence!;
          majorityCount++;
        } else {
          minoritySum += r.confidence!;
          minorityCount++;
        }
      }
    }
    if (minorityCount > 0 && majorityCount > 0) {
      const minorityMean = minoritySum / minorityCount;
      const majorityMean = majoritySum / majorityCount;
      const direction =
        minorityMean > majorityMean
          ? 'HIGHER confidence than the runs that agreed with the majority, so confidence is worse than useless as a filter here'
          : minorityMean === majorityMean
            ? 'exactly the same confidence as the runs that agreed with the majority, so it carries no signal about which draw is the outlier'
            : 'lower confidence than the runs that agreed with the majority, which is the direction you would hope for — though see the spread before relying on it';
      kSummary.confidence_note =
        `On the ${agreementReport.unstable.length} unstable case(s), the ${minorityCount} minority run(s) reported a mean ` +
        `confidence of ${minorityMean.toFixed(2)} against ${majorityMean.toFixed(2)} across the ${majorityCount} majority run(s) — ` +
        `${direction}.`;
    } else if (agreementReport.unstable.length === 0) {
      kSummary.confidence_note =
        'No case disagreed with itself across the k runs, so there is no outlier whose confidence could be compared.';
    }
  }

  // --- Accounting ---------------------------------------------------------
  const countSource = (outcomes: ArmOutcome[] | null, source: string) =>
    outcomes ? outcomes.filter((o) => o.source === source).length : 0;

  const notAttempted = modelRan ? null : 'no model was called (--no-model, or no GROQ_API_KEY)';

  const accounting: ArmAccounting[] = [
    {
      arm: 'A',
      attempted: true,
      not_attempted_reason: null,
      cases: cases.length,
      model_consulted: 0,
      rules_vetoes: countSource(aOutcomes, 'rules_veto'),
      parse_failures: 0,
      api_failures: 0,
      amount_disagreements: 0,
    },
    {
      arm: 'B',
      attempted: modelRan,
      not_attempted_reason: notAttempted,
      cases: cases.length,
      model_consulted: modelRan ? cases.length : 0,
      rules_vetoes: 0,
      parse_failures: countSource(bByRun[0] ?? null, 'parse_failure'),
      api_failures: countSource(bByRun[0] ?? null, 'api_failure'),
      amount_disagreements: 0,
    },
    {
      arm: 'C',
      attempted: modelRan,
      not_attempted_reason: notAttempted,
      cases: cases.length,
      model_consulted: modelRan ? (cByRun[0] ?? []).filter((o) => o.model_consulted).length : 0,
      rules_vetoes: countSource(cByRun[0] ?? null, 'rules_veto'),
      parse_failures: countSource(cByRun[0] ?? null, 'parse_failure'),
      api_failures: countSource(cByRun[0] ?? null, 'api_failure'),
      amount_disagreements: countSource(cByRun[0] ?? null, 'model_amount_disagreement'),
    },
    {
      arm: 'D',
      attempted: modelRan,
      not_attempted_reason: modelRan ? null : 'arm C did not run, and D has nothing to match its mix against',
      cases: cases.length,
      model_consulted: 0,
      rules_vetoes: 0,
      parse_failures: 0,
      api_failures: 0,
      amount_disagreements: 0,
    },
  ];

  const comparison: ScoredRow[] = [
    { arm: 'A', label: 'A rules only', attempted: true, not_attempted_reason: null, result: aScore },
    { arm: 'B', label: `B model, run 1`, attempted: modelRan, not_attempted_reason: notAttempted, result: bRun1 },
    { arm: 'B', label: `B model, maj of ${args.k}`, attempted: modelRan, not_attempted_reason: notAttempted, result: bMajority },
    { arm: 'C', label: 'C rules+model, run 1', attempted: modelRan, not_attempted_reason: notAttempted, result: cRun1 },
    { arm: 'C', label: `C rules+model, maj ${args.k}`, attempted: modelRan, not_attempted_reason: notAttempted, result: cMajority },
    { arm: 'D', label: 'D random control', attempted: modelRan, not_attempted_reason: notAttempted, result: dScore },
  ];

  const finishedAt = new Date();
  const cModelConsulted = accounting.find((r) => r.arm === 'C')!.model_consulted;

  const manifest: RunManifest = {
    split: args.split,
    case_count: cases.length,
    dataset_seed: loaded.cases.seed,
    arm_d_seed: args.armDSeed,
    k: args.k,
    model_requested: modelRan ? args.model : '(none — arm A only)',
    api_base: modelRan ? args.apiBase : '(none — arm A only)',
    models_that_answered: [...modelsThatAnswered].sort(),
    max_tokens: args.maxTokens,
    shipped_max_tokens: SHIPPED_MAX_TOKENS,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    wall_seconds: (finishedAt.getTime() - startedAt.getTime()) / 1000,
    usage,
    calls_made: callsMade,
    calls_reused_from_cache: cache.reusedCount,
    calls_failed: callsFailed,
    throttled_attempts: throttledAttempts,
    rulebook_version: RULEBOOK_VERSION,
    scoring_rules_version: SCORING_RULES_VERSION,
    system_prompt_sha256: sha256Text(ADJUDICATION_SYSTEM_PROMPT),
    completions_path: relative(join(HERE, '..'), completionsPath).split('\\').join('/'),
    node_version: process.version,
  };

  const narration: NarrationInput = {
    a: aScore,
    b: bRun1,
    c: cRun1,
    d: dScore,
    c_model_consulted: cModelConsulted,
    case_count: cases.length,
  };

  const caveats = buildCaveats(args, modelRan, cases.length, cModelConsulted, callsFailed, throttledAttempts);

  const report = renderFourArmReport({
    manifest,
    accounting,
    comparison,
    kRepeat: kSummary,
    run1: cRun1,
    majority: cMajority,
    narration,
    caveats,
  });

  // --- Artefacts ----------------------------------------------------------
  const sealLine = loaded.seal
    ? renderSealStatus(loaded.seal)
    : 'Split: dev (not sealed; it is the set you are allowed to look at).';

  const write = (name: string, contents: string) => {
    const path = join(RESULTS_DIR, name);
    writeFileSync(path, contents.endsWith('\n') ? contents : `${contents}\n`, 'utf8');
    return path;
  };

  const written: string[] = [];
  written.push(write(`four-arm-${args.split}.txt`, report));
  written.push(write(`report-${args.split}-arm-a.txt`, renderReport(aScore, sealLine)));
  if (bRun1) written.push(write(`report-${args.split}-arm-b-run1.txt`, renderReport(bRun1, sealLine)));
  if (bMajority) written.push(write(`report-${args.split}-arm-b-majority.txt`, renderReport(bMajority, sealLine)));
  if (cRun1) written.push(write(`report-${args.split}-arm-c-run1.txt`, renderReport(cRun1, sealLine)));
  if (cMajority) written.push(write(`report-${args.split}-arm-c-majority.txt`, renderReport(cMajority, sealLine)));
  if (dScore) written.push(write(`report-${args.split}-arm-d.txt`, renderReport(dScore, sealLine)));

  const predictionFiles: Record<string, Prediction[] | null> = {
    [`predictions-${args.split}-arm-a.json`]: toPredictions(aOutcomes),
    [`predictions-${args.split}-arm-b-run1.json`]: bByRun[0] ? toPredictions(bByRun[0]) : null,
    [`predictions-${args.split}-arm-b-majority.json`]: bMajorityPredictions,
    [`predictions-${args.split}-arm-c-run1.json`]: cByRun[0] ? toPredictions(cByRun[0]) : null,
    [`predictions-${args.split}-arm-c-majority.json`]: cMajorityPredictions,
    [`predictions-${args.split}-arm-d.json`]: dPredictions,
  };
  for (const [name, predictions] of Object.entries(predictionFiles)) {
    if (predictions) written.push(write(name, JSON.stringify(predictions, null, 2)));
  }

  // Per-case outcomes for every arm and every run, so any figure above can be
  // recomputed from the record rather than believed.
  written.push(
    write(
      `outcomes-${args.split}.json`,
      JSON.stringify(
        {
          split: args.split,
          k: args.k,
          arm_a: aOutcomes,
          arm_b_by_run: bByRun,
          arm_c_by_run: cByRun,
          arm_d: dPredictions,
          model_verdicts_by_case: Object.fromEntries(modelVerdictsByCase),
        },
        null,
        2
      )
    )
  );

  written.push(
    write(
      `run-${args.split}.json`,
      JSON.stringify(
        {
          manifest,
          accounting,
          scores: {
            arm_a: aScore,
            arm_b_run1: bRun1,
            arm_b_majority: bMajority,
            arm_c_run1: cRun1,
            arm_c_majority: cMajority,
            arm_d: dScore,
          },
          k_repeat: kSummary,
          caveats,
        },
        null,
        2
      )
    )
  );

  console.log(report);
  console.error('');
  console.error('Artefacts:');
  for (const path of [...written, completionsPath]) {
    console.error(`  ${relative(process.cwd(), path).split('\\').join('/')}`);
  }

  return 0;
}

/**
 * The things a reader has to know before quoting a number.
 *
 * Written from what the run actually did, not from a fixed list, so a clean
 * run does not print warnings about failures it did not have.
 */
function buildCaveats(
  args: Args,
  modelRan: boolean,
  caseCount: number,
  cModelConsulted: number,
  callsFailed: number,
  throttledAttempts: number
): string[] {
  const caveats: string[] = [];

  if (!modelRan) {
    return [
      'No model was called on this run, so arms B, C and D were not attempted. Only arm A — the ' +
        'deterministic floor — has numbers, and every model-arm cell in the tables above reads ' +
        '"n/a" rather than zero.',
      'Policy exclusion wording reaches the model through coverage_details when a model does run; see ' +
        'eval/adapter.ts. Arm A never reads it: the nine deterministic checks are arithmetic over dates and ' +
        'amounts and have no way to decide whether an exclusion clause reaches an incident.',
    ];
  }

  caveats.push(
    'Arms B and C were handed the same completions from one shared cache; the model was called once ' +
      `per case per run, ${args.k} run(s) in total. On the ${caseCount - cModelConsulted} cases the ` +
      'deterministic layer vetoed, arm C never read its completion, but the call was still made and ' +
      'billed because arm B needed it. The token figures in the manifest are for the whole set of calls, ' +
      "not for arm C's share of them."
  );

  caveats.push(
    'The shared system prompt tells the model that the deterministic checks have already run and passed. ' +
      `That is true for arm C on every case it consults the model about, and false for arm B on the ` +
      `${caseCount - cModelConsulted} vetoed cases, which arm B answers anyway. This is a known bias against ` +
      'arm B, in the direction of making it approve things a lapsed or cancelled policy should have refused. ' +
      'Removing it would mean a second prompt and a second call per case, which puts provider variance back ' +
      'inside the very comparison the shared cache exists to remove.'
  );

  if (args.maxTokens !== SHIPPED_MAX_TOKENS) {
    caveats.push(
      `The model was given ${args.maxTokens} completion tokens. The shipping code gives it ${SHIPPED_MAX_TOKENS} — ` +
        'GroqProvider.complete falls back to that when the caller names no ceiling, and adjudicateClaim names none. ' +
        `On openai/gpt-oss-120b that default is not sufficient: the model spends the budget on its reasoning trace, ` +
        'never closes the JSON object, and Groq rejects the request outright with a 400 json_validate_failed rather ' +
        'than returning a truncated answer. A first pass at the shipped budget lost 1 call in 12 that way before it ' +
        'was raised. Successful answers on this split cost between roughly 550 and 900 completion tokens, so 1024 is ' +
        'not a comfortable margin, it is inside the noise. Every model number in this report was therefore obtained ' +
        'under a budget the shipping code does not currently use, and is an upper bound on what the shipping ' +
        'configuration would score today. This is a defect in backend/src/services/llm-provider.ts, which this ' +
        'harness does not own and has not edited.'
    );
  }

  caveats.push(
    'Policy exclusion wording reaches the model through coverage_details, because the policies table has no ' +
      'exclusions column and buildAdjudicationPrompt serialises coverage_details verbatim. Without that mapping ' +
      'the model would never see a single exclusion clause and every case turning on one would be unanswerable ' +
      'by construction. The mapping is in eval/adapter.ts and is stated there.'
  );

  caveats.push(
    'The shipping prompt does not tell the model which documents were REQUIRED, only which were uploaded, ' +
      'because claims.documents_required is not in buildAdjudicationPrompt. Eight dev cases are missing a ' +
      'required document and the model has no way to know it. That is a property of the shipped system, not of ' +
      'this harness, and it has not been repaired here in order to keep the measured pipeline the shipped one.'
  );

  if (callsFailed > 0) {
    caveats.push(
      `${callsFailed} model call(s) failed outright after retries. Every one of them became an escalation in the ` +
        'arm that read it, and every one is counted as an api failure in the accounting table rather than as the ' +
        'model choosing to escalate. An arm whose escalations are partly the network is not a cautious arm.'
    );
  }

  if (throttledAttempts > 0) {
    caveats.push(
      `${throttledAttempts} attempt(s) came back 429 and were retried with backoff. Retried attempts still burn ` +
        'tokens on the provider side where they reached the model, and the manifest counts them.'
    );
  }

  return caveats;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    });
}

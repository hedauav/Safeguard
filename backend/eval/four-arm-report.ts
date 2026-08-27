/**
 * The four-arm report.
 *
 * It uses `scoring.ts` for every number. There is no second scorer here and
 * there must never be one: a comparison table computed independently of the
 * per-arm reports is a table that can disagree with them, and the disagreement
 * will be discovered by a reader rather than by us.
 *
 * Three commitments this file adds on top of the scoring rules:
 *
 *   - No column anywhere adds a wrong approval to a wrong denial. `scoring.ts`
 *     ships a `blendedCost()` that throws for exactly this reason, and nothing
 *     here works around it. The two are printed side by side, in rupees, and
 *     the reader does the trade-off themselves or does not make it.
 *
 *   - Model consulted, parse failures and failed API calls are three numbers,
 *     not one. A cost table showing only the calls that succeeded flatters an
 *     arm that lost a third of them, and an escalation caused by a 429 is not
 *     the same event as an escalation the model chose.
 *
 *   - An arm that did not run prints "not attempted", never a zero. A zero in
 *     a wrong-approvals column reads as a perfect score.
 *
 *   - Every rate prints the 95% Wilson interval its denominator supports.
 *     Four arms scored on 100 cases produce four numbers that look like
 *     rankings, and on 100 cases several of the gaps between them are narrower
 *     than the intervals around them. A table that shows only the point
 *     estimates invites a reader to rank arms the data cannot rank.
 *
 *   - And every pair that decides something gets McNemar's exact test, because
 *     those intervals are marginal and every arm here is scored on the same
 *     cases. Overlapping marginal intervals are not a paired test and are much
 *     the weaker instrument; printing only the intervals would invite a reader
 *     to conclude "no difference" from the wrong one.
 *
 * And one commitment about what it is for: this report has to be able to
 * narrate a loss. If arm C does not beat arm A, `narrate` says so in the first
 * line of its section and recommends arm A. A harness that can only describe a
 * win is not measuring anything.
 */
import { inr } from './rng.js';
import { renderRulebook, wrap } from './rules.js';
import {
  mcnemar,
  rateText,
  renderScoringRules,
  wilson,
  type ScoreResult,
} from './scoring.js';
import { ARM_TITLES, type ArmName } from './arms.js';
import type { TokenUsage } from './model-client.js';

const WIDTH = 96;

export interface RunManifest {
  split: string;
  case_count: number;
  dataset_seed: number;
  arm_d_seed: number;
  k: number;
  model_requested: string;
  /**
   * The provider that answered. Optional because runs recorded before the
   * harness could target more than one did not write it; those were Groq.
   */
  api_base?: string;
  /** Distinct ids the provider said answered. More than one is worth seeing. */
  models_that_answered: string[];
  /** Completion budget these answers were generated under. */
  max_tokens: number;
  /** What the shipping code would have used, when the two differ. */
  shipped_max_tokens: number;
  started_at: string;
  finished_at: string;
  wall_seconds: number;
  usage: TokenUsage;
  calls_made: number;
  calls_reused_from_cache: number;
  calls_failed: number;
  throttled_attempts: number;
  rulebook_version: string;
  scoring_rules_version: string;
  system_prompt_sha256: string;
  completions_path: string;
  node_version: string;
}

export interface ArmAccounting {
  arm: ArmName;
  attempted: boolean;
  /** Why not, when it was not. */
  not_attempted_reason: string | null;
  cases: number;
  model_consulted: number;
  rules_vetoes: number;
  parse_failures: number;
  api_failures: number;
  amount_disagreements: number;
}

export interface ScoredRow {
  arm: ArmName;
  /** "C (run 1)", "C (majority of 5)". */
  label: string;
  attempted: boolean;
  not_attempted_reason: string | null;
  result: ScoreResult | null;
}

export interface KRepeatSummary {
  k: number;
  measurable: number;
  unanimous: number;
  tied: number;
  excluded: number;
  unstable: Array<{ case_id: string; counts: Record<string, number> }>;
  /** Cases where the run-1 verdict differed from the majority-of-k verdict. */
  run1_vs_majority_flips: number;
  /** Confidence reported on outlier runs, against the runs they disagreed with. */
  confidence_note: string | null;
}

function rule(char = '='): string {
  return char.repeat(WIDTH);
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text.padStart(width);
}

function block(title: string): string[] {
  return ['', rule('-'), title, rule('-'), ''];
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export function renderManifest(m: RunManifest): string {
  const lines: string[] = [];
  lines.push(...block('RUN MANIFEST — everything needed to reproduce or dispute these numbers'));
  lines.push(`  split                    ${m.split}   (${m.case_count} cases)`);
  lines.push(`  dataset seed             ${m.dataset_seed}`);
  lines.push(`  arm D seed               ${m.arm_d_seed}`);
  lines.push(`  k (runs per case)        ${m.k}`);
  lines.push(
    `  max completion tokens    ${m.max_tokens}` +
      (m.max_tokens === m.shipped_max_tokens
        ? '   (the same budget the shipping code uses)'
        : `   (the shipping code would use ${m.shipped_max_tokens} — see the caveats)`)
  );
  lines.push(`  model requested          ${m.model_requested}`);
  lines.push(`  provider                 ${m.api_base ?? 'https://api.groq.com/openai/v1'}`);
  lines.push(
    `  model that answered      ${m.models_that_answered.length ? m.models_that_answered.join(', ') : '(no call succeeded)'}`
  );
  lines.push(`  started                  ${m.started_at}`);
  lines.push(`  finished                 ${m.finished_at}  (${m.wall_seconds.toFixed(1)} s)`);
  lines.push(`  node                     ${m.node_version}`);
  lines.push('');
  lines.push(`  calls made this run      ${m.calls_made}`);
  lines.push(`  calls reused from cache  ${m.calls_reused_from_cache}`);
  lines.push(`  calls that failed        ${m.calls_failed}`);
  lines.push(`  attempts throttled (429) ${m.throttled_attempts}`);
  lines.push(
    `  tokens                   prompt ${m.usage.prompt_tokens}, completion ${m.usage.completion_tokens}, total ${m.usage.total_tokens}`
  );
  lines.push('      Tokens are counted for this run only. Reused answers cost nothing today and');
  lines.push('      are not billed again; the completions file records what each one cost when it');
  lines.push('      was fetched.');
  lines.push('');
  lines.push(`  rulebook                 v${m.rulebook_version}`);
  lines.push(`  scoring rules            v${m.scoring_rules_version}`);
  lines.push(`  system prompt sha256     ${m.system_prompt_sha256}`);
  lines.push(`  completions              ${m.completions_path}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Call accounting
// ---------------------------------------------------------------------------

export function renderAccounting(rows: readonly ArmAccounting[]): string {
  const lines: string[] = [];
  lines.push(...block('CALL ACCOUNTING — what each arm actually asked for and what came back'));
  lines.push(
    `  ${pad('arm', 4)}${pad('what it is', 40)}${padStart('consulted', 12)}${padStart('vetoed', 8)}${padStart('parse fail', 12)}${padStart('api fail', 10)}`
  );
  for (const row of rows) {
    if (!row.attempted) {
      lines.push(`  ${pad(row.arm, 4)}${pad(ARM_TITLES[row.arm], 40)}   NOT ATTEMPTED — ${row.not_attempted_reason ?? 'no reason recorded'}`);
      continue;
    }
    const consulted = `${row.model_consulted} of ${row.cases}`;
    lines.push(
      `  ${pad(row.arm, 4)}${pad(ARM_TITLES[row.arm], 40)}${padStart(consulted, 12)}${padStart(String(row.rules_vetoes), 8)}${padStart(String(row.parse_failures), 12)}${padStart(String(row.api_failures), 10)}`
    );
  }
  lines.push('');
  for (const chunk of wrap(
    'consulted is how many of the split\'s cases that arm put in front of the model. Arm C is ' +
      'lower than arm B by exactly the number of cases the deterministic layer vetoed before any ' +
      'model was called; that asymmetry is the shipping design and not an accounting error. ' +
      'parse fail and api fail are counted separately from each other and from the model\'s own ' +
      'escalations: an escalation caused by a rate limit is not the system being careful.',
    WIDTH - 6
  )) {
    lines.push(`      ${chunk}`);
  }
  const disagreements = rows.filter((r) => r.attempted && r.amount_disagreements > 0);
  if (disagreements.length > 0) {
    lines.push('');
    for (const row of disagreements) {
      lines.push(
        `      arm ${row.arm}: ${row.amount_disagreements} case(s) forced to escalate because the model's payable figure disagreed with the computed one.`
      );
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The four-arm comparison
// ---------------------------------------------------------------------------

/**
 * Short names for the pair table. The comparison table's own labels carry the
 * run and the vote ("C rules+model, run 1"), which is what that table needs
 * and more than a pair label can hold on one line.
 */
const PAIR_NAMES: Record<ArmName, string> = {
  A: 'A rules only',
  B: 'B model only',
  C: 'C rules + model',
  D: 'D random control',
};

/**
 * The three pairs worth testing, in the order they have to be read.
 *
 * A against C first, because if the model does not change the answer then
 * nothing after it matters. C against B second, to price the rules layer. B
 * against D last, because a model arm that is not distinguishable from a
 * control that does no reading has not earned the word "model" in its row.
 */
const PAIRED_TESTS: ReadonlyArray<{ first: ArmName; second: ArmName }> = [
  { first: 'A', second: 'C' },
  { first: 'C', second: 'B' },
  { first: 'B', second: 'D' },
];

function formatP(p: number): string {
  // Four places, and an explicit floor rather than "0.0000", which reads as a
  // p of zero and there is no such thing.
  return p < 0.0001 ? '< 0.0001' : p.toFixed(4);
}

/**
 * McNemar over the pairs that decide something, rendered next to the Wilson
 * column and explicitly distinguished from it.
 *
 * The distinction is the reason this section exists. Four Wilson intervals
 * sitting in a column invite a reader to check whether they overlap and to
 * conclude "no significant difference" when they do. That inference is invalid
 * on this data: every arm is scored on the same 100 cases, arms B and C read
 * the same cached completions, and arm D is drawn to arm C's own multiset of
 * verdicts. Nothing here is an independent sample of anything. Comparing
 * marginal intervals on paired measurements is markedly less powerful than the
 * paired test and will report no difference over differences that are real.
 */
function renderPairedTests(rows: readonly ScoredRow[]): string[] {
  const lines: string[] = [];
  const pick = (arm: ArmName): ScoredRow | undefined => rows.find((r) => r.arm === arm && r.result);

  lines.push('');
  lines.push('  PAIRED COMPARISONS — McNemar, exact, on the same cases');
  lines.push(
    `  ${pad('pair', 34)}${padStart('1st only', 11)}${padStart('2nd only', 11)}${padStart('discordant', 12)}${padStart('p (exact)', 12)}`
  );

  const readings: string[] = [];
  for (const pair of PAIRED_TESTS) {
    const first = pick(pair.first);
    const second = pick(pair.second);
    const label = `${PAIR_NAMES[pair.first]} vs ${PAIR_NAMES[pair.second]}`;
    if (!first?.result || !second?.result) {
      lines.push(`  ${pad(label, 34)}   not attempted — one side of this pair has no score`);
      continue;
    }

    const m = mcnemar(first.result.correct_by_case, second.result.correct_by_case);
    lines.push(
      `  ${pad(label, 34)}${padStart(String(m.only_first_correct), 11)}${padStart(String(m.only_second_correct), 11)}` +
        `${padStart(String(m.discordant), 12)}${padStart(formatP(m.p), 12)}`
    );

    if (m.discordant === 0) {
      readings.push(
        `${label}: the two arms were right and wrong on exactly the same ${m.n} cases. There are no ` +
          'discordant pairs, so the test has nothing to look at and reports no evidence of a difference, ' +
          'which is not the same claim as there being none.'
      );
      continue;
    }
    const ahead =
      m.only_first_correct === m.only_second_correct
        ? `they split the ${m.discordant} discordant cases evenly`
        : m.only_first_correct > m.only_second_correct
          ? `${PAIR_NAMES[pair.first]} took ${m.only_first_correct} of the ${m.discordant} discordant cases to ${m.only_second_correct}`
          : `${PAIR_NAMES[pair.second]} took ${m.only_second_correct} of the ${m.discordant} discordant cases to ${m.only_first_correct}`;
    const verdict =
      m.p < 0.05
        ? 'That difference survives the paired test at the conventional 5%.'
        : 'That difference does not survive the paired test at the conventional 5%: on this split the two arms are not distinguishable, whatever their point estimates look like side by side.';
    readings.push(`${label}: ${ahead}, and ${m.both_correct} were right in both arms. ${verdict}`);
  }

  lines.push('');
  lines.push('      1st only and 2nd only are the two discordant cells — cases exactly one arm got');
  lines.push('      right. Cases both arms got right, and cases both got wrong, carry no information');
  lines.push('      about which is better and the test discards them; the counts above say how much');
  lines.push('      of the split each test actually ran on.');
  lines.push('');
  for (const reading of readings) {
    const chunks = wrap(reading, WIDTH - 8);
    lines.push(`      ${chunks[0] ?? ''}`);
    for (const chunk of chunks.slice(1)) lines.push(`        ${chunk}`);
  }
  lines.push('');
  for (const chunk of wrap(
    'These p-values and the Wilson column above answer different questions and neither replaces ' +
      'the other. A Wilson interval is one arm\'s uncertainty about its own score. McNemar is ' +
      'whether two arms differ on the same cases. Reading two overlapping intervals as "no ' +
      'significant difference" is invalid here, because these arms are not independent samples: ' +
      'every one is scored on the same cases, arms B and C read the same cached completions, and ' +
      'arm D is drawn to arm C\'s own multiset of verdicts. The overlap reading is much the weaker ' +
      'test and will call a real difference no difference. Exact binomial rather than chi-square ' +
      'with a continuity correction because the discordant counts here are far below the count ' +
      'that approximation needs, and at this size the exact test is the cheap one anyway.',
    WIDTH - 6
  )) {
    lines.push(`      ${chunk}`);
  }
  return lines;
}

function cell(result: ScoreResult | null, get: (r: ScoreResult) => string): string {
  return result === null ? 'n/a' : get(result);
}

export function renderComparison(rows: readonly ScoredRow[]): string {
  const lines: string[] = [];
  lines.push(...block('THE FOUR ARMS'));

  for (const row of rows) {
    if (!row.attempted) {
      lines.push(`  ${pad(row.label, 22)} NOT ATTEMPTED — ${row.not_attempted_reason ?? 'no reason recorded'}`);
    }
  }
  if (rows.some((r) => !r.attempted)) lines.push('');

  lines.push('  EXACT-VERDICT MATCH, and what each arm predicted');
  lines.push(
    `  ${pad('arm', 22)}${padStart('exact match', 16)}${padStart('95% CI (Wilson)', 20)}${padStart('approve', 10)}${padStart('deny', 8)}${padStart('escalate', 10)}`
  );
  for (const row of rows) {
    const r = row.result;
    lines.push(
      `  ${pad(row.label, 22)}${padStart(cell(r, (x) => `${x.exact_match.count}/${x.exact_match.denominator} (${((100 * x.exact_match.count) / x.exact_match.denominator).toFixed(1)}%)`), 16)}` +
        `${padStart(cell(r, (x) => `${(100 * x.exact_match.lo).toFixed(1)} - ${(100 * x.exact_match.hi).toFixed(1)}%`), 20)}` +
        `${padStart(cell(r, (x) => String(x.by_prediction.approve)), 10)}${padStart(cell(r, (x) => String(x.by_prediction.deny)), 8)}${padStart(cell(r, (x) => String(x.by_prediction.escalate)), 10)}`
    );
  }
  const truth = rows.find((r) => r.result)?.result;
  if (truth) {
    lines.push(
      `  ${pad('(ground truth)', 22)}${padStart('—', 16)}${padStart('—', 20)}${padStart(String(truth.by_truth.approve), 10)}${padStart(String(truth.by_truth.deny), 8)}${padStart(String(truth.by_truth.escalate), 10)}`
    );
  }
  lines.push('      Denominator for every exact-match figure: cases in the split (S6).');
  lines.push('');
  for (const chunk of wrap(
    'The interval is a 95% Wilson score interval on that same denominator. It is printed ' +
      'because a gap between two arms that is smaller than the width of either interval is not ' +
      'yet a result, and the only way a reader can check that for themselves is if the widths are ' +
      'on the page next to the scores. Wilson rather than the normal approximation or a bootstrap: ' +
      'below a few hundred samples both of those misbehave (Bowyer, Aitchison & Ivanova, ICML ' +
      '2025), and both collapse to zero width at 0/n and n/n, which is where a bound is most ' +
      'needed and least honest to omit. The bounds are additive — they moved no point estimate in ' +
      'this table, and if they ever appear to, the arithmetic above them is what is wrong.',
    WIDTH - 6
  )) {
    lines.push(`      ${chunk}`);
  }

  lines.push(...renderPairedTests(rows));

  lines.push('');
  lines.push('  FAILURES, IN COUNTS — five categories, never summed into one');
  lines.push(
    `  ${pad('arm', 22)}${padStart('wrong appr', 12)}${padStart('wrong deny', 12)}${padStart('missed:paid', 13)}${padStart('missed:refd', 13)}${padStart('over-esc', 10)}`
  );
  for (const row of rows) {
    const r = row.result;
    lines.push(
      `  ${pad(row.label, 22)}${padStart(cell(r, (x) => String(x.wrong_approvals.rate.count)), 12)}` +
        `${padStart(cell(r, (x) => String(x.wrong_denials.rate.count)), 12)}` +
        `${padStart(cell(r, (x) => String(x.missed_escalation_paid.rate.count)), 13)}` +
        `${padStart(cell(r, (x) => String(x.missed_escalation_refused.rate.count)), 13)}` +
        `${padStart(cell(r, (x) => String(x.over_escalation.rate.count)), 10)}`
    );
  }

  lines.push('');
  lines.push('  FAILURES, IN RUPEES — from each case\'s own amounts, never from an average');
  lines.push(
    `  ${pad('arm', 22)}${padStart('paid in error', 18)}${padStart('withheld', 18)}${padStart('paid unreviewed', 18)}${padStart('delayed', 16)}`
  );
  for (const row of rows) {
    const r = row.result;
    lines.push(
      `  ${pad(row.label, 22)}${padStart(cell(r, (x) => `Rs ${inr(x.wrong_approvals.rupees)}`), 18)}` +
        `${padStart(cell(r, (x) => `Rs ${inr(x.wrong_denials.rupees)}`), 18)}` +
        `${padStart(cell(r, (x) => `Rs ${inr(x.missed_escalation_paid.rupees)}`), 18)}` +
        `${padStart(cell(r, (x) => `Rs ${inr(x.over_escalation.rupees)}`), 16)}`
    );
  }
  lines.push('');
  for (const chunk of wrap(
    'paid in error is money paid on claims whose correct verdict was deny. withheld is money ' +
      'refused to policyholders whose claims should have been approved. These are two different ' +
      'failures with two different victims and there is no column in this report that adds them ' +
      'together — scoring.ts ships a blendedCost() that throws rather than produce one (S2). ' +
      'paid unreviewed is money settled on cases that needed a human first. delayed is money owed ' +
      'to policyholders whose approvable claims were escalated instead (S3).',
    WIDTH - 6
  )) {
    lines.push(`      ${chunk}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// k-repeat
// ---------------------------------------------------------------------------

export function renderKRepeat(summary: KRepeatSummary, run1: ScoreResult | null, majority: ScoreResult | null): string {
  const lines: string[] = [];
  const cases = summary.measurable + summary.excluded;
  /**
   * Every claim in this section is a claim about repeats, and a run that drew
   * one answer per case has none to report. The k = 1 wording below is not a
   * softened version of the k > 1 wording; it says a different thing, because
   * a different thing happened. Prose describing five runs under a manifest
   * that says one is the same defect as a rate without its denominator: a
   * sentence that cannot be checked against the run it is sitting in.
   */
  const repeated = summary.k > 1;

  lines.push(
    ...block(
      repeated
        ? `REPEATABILITY — the same ${cases} prompts, ${summary.k} times each, at temperature 0`
        : `REPEATABILITY — NOT MEASURED ON THIS RUN: ${cases} prompts, once each (k = 1)`
    )
  );

  for (const chunk of wrap(
    repeated
      ? 'temperature 0 is a request, not a guarantee, and this is the measurement of what that ' +
          'request is actually worth on this model and this set. Nothing here is assumed.'
      : 'temperature 0 is a request, not a guarantee, and this run did not measure what that request ' +
          'is worth: it drew one answer per case. A single draw always agrees with itself, so no figure ' +
          'below is evidence of stability, and none is printed as though it were. Making that measurement ' +
          'takes --k 5 or more; until it is made, this section states what is not known rather than a result.',
    WIDTH - 6
  )) {
    lines.push(`  ${chunk}`);
  }
  lines.push('');

  const measurable = summary.measurable;
  if (repeated) {
    const pct = measurable === 0 ? 'n/a' : `${((100 * summary.unanimous) / measurable).toFixed(1)}%`;
    // The denominator here is the measurable cases, not the split, and the bound
    // is computed on that number rather than on 100. An interval quoted against
    // the wrong n is the same manipulation S6 forbids, done one layer down.
    const ci = wilson(summary.unanimous, measurable);
    lines.push(`  Per-case agreement       ${summary.unanimous}/${measurable} cases where all ${summary.k} runs gave the same verdict (${pct})`);
    lines.push(
      `                           95% CI (Wilson) ${(100 * ci.lo).toFixed(1)} - ${(100 * ci.hi).toFixed(1)}%` +
        (measurable === 0 ? '   — the whole range, because nothing was measured' : '')
    );
    lines.push('      Wilson, because the normal approximation puts a zero-width interval around an');
    lines.push('      agreement rate of 100% and this harness is in no position to promise that the');
    lines.push('      next case will agree with itself.');
  } else {
    lines.push('  Per-case agreement       not measured — one draw per case, and one draw agrees with');
    lines.push(`                           itself by arithmetic. Printing ${measurable}/${measurable} here would be a 100%`);
    lines.push('                           that measured nothing, so no percentage is given and no');
    lines.push('                           interval is put around one.');
  }
  lines.push(`  Cases excluded           ${summary.excluded} — at least one run did not return a readable verdict`);
  if (summary.excluded > 0) {
    for (const chunk of wrap(
      repeated
        ? `A case that was rate-limited into an escalation on one of its ${summary.k} runs did not agree ` +
            `with itself on the other ${summary.k - 1}. It is a case that could not be measured, and it is ` +
            'excluded rather than counted as stable.'
        : `The single call this run made on ${summary.excluded === 1 ? 'that case' : 'those cases'} returned no readable ` +
            'verdict, so there is nothing to compare it against and nothing to call stable. This is why ' +
            `the line above counts ${measurable} and not ${cases}: the split has ${cases} cases, and the excluded ` +
            'ones are named as excluded rather than quietly counted as agreeing.',
      WIDTH - 6
    )) {
      lines.push(`      ${chunk}`);
    }
  }
  if (repeated) {
    lines.push(`  Majority ties            ${summary.tied} — no verdict held a strict plurality; broken to escalate`);
    lines.push(`  Run 1 vs majority        ${summary.run1_vs_majority_flips} case(s) where the two disagree`);
  } else {
    lines.push('  Majority ties            n/a — the majority of one draw is that draw; a tie needs two');
    lines.push('  Run 1 vs majority        n/a — the two are one verdict by construction, not by measurement');
  }

  if (summary.unstable.length > 0) {
    lines.push('');
    lines.push('  CASES THAT DID NOT AGREE WITH THEMSELVES');
    for (const u of summary.unstable.slice(0, 12)) {
      lines.push(
        `      ${pad(u.case_id, 12)} approve ${u.counts['approve'] ?? 0}, deny ${u.counts['deny'] ?? 0}, escalate ${u.counts['escalate'] ?? 0}`
      );
    }
    if (summary.unstable.length > 12) {
      lines.push(`      ... and ${summary.unstable.length - 12} more`);
    }
  }

  if (summary.confidence_note) {
    lines.push('');
    for (const chunk of wrap(summary.confidence_note, WIDTH - 6)) lines.push(`      ${chunk}`);
  }

  lines.push('');
  lines.push('  DOES VOTING EARN ITS TOKENS?');
  if (!repeated) {
    for (const chunk of wrap(
      'Not asked on this run. With k = 1 the majority of a single draw is that draw, so the two rows this ' +
        'question needs would be one number printed twice, and their difference would be zero by construction ' +
        'rather than by measurement. The "maj of 1" rows in the comparison table above are the run-1 rows ' +
        'under a second name; nothing in this report treats them as a second result, and no claim about ' +
        'voting is made from them.',
      WIDTH - 6
    )) {
      lines.push(`      ${chunk}`);
    }
    return lines.join('\n');
  }
  if (!run1 || !majority) {
    lines.push('      Not measured — one of the two scores is missing.');
    return lines.join('\n');
  }
  const r1 = run1.exact_match;
  const mj = majority.exact_match;
  lines.push(`      run 1 alone          ${rateText(r1)}`);
  lines.push(`      majority of ${summary.k}       ${rateText(mj)}`);
  lines.push(
    `      wrong approvals      run 1: ${run1.wrong_approvals.rate.count} (Rs ${inr(run1.wrong_approvals.rupees)})   majority: ${majority.wrong_approvals.rate.count} (Rs ${inr(majority.wrong_approvals.rupees)})`
  );
  lines.push(
    `      wrong denials        run 1: ${run1.wrong_denials.rate.count} (Rs ${inr(run1.wrong_denials.rupees)})   majority: ${majority.wrong_denials.rate.count} (Rs ${inr(majority.wrong_denials.rupees)})`
  );
  lines.push('');
  const delta = mj.count - r1.count;
  const cost = `Voting costs ${summary.k}x the tokens of a single draw.`;
  if (delta > 0) {
    for (const chunk of wrap(
      `Majority voting is right on ${delta} more case(s) than a single draw. ${cost} Whether ${delta} case(s) ` +
        `in ${r1.denominator} is worth ${summary.k}x the spend is a decision this report does not make for anyone, ` +
        'but the two numbers it needs are above and neither has been blended with the other.',
      WIDTH - 6
    )) {
      lines.push(`      ${chunk}`);
    }
  } else if (delta === 0) {
    for (const chunk of wrap(
      `Majority voting scored exactly the same as a single draw. ${cost} On this split it bought ` +
        'nothing on exact match; check the two failure lines above before concluding it bought nothing at all, ' +
        'since the same score can be reached by different mistakes.',
      WIDTH - 6
    )) {
      lines.push(`      ${chunk}`);
    }
  } else {
    for (const chunk of wrap(
      `Majority voting scored ${-delta} case(s) WORSE than a single draw. ${cost} On this split, ` +
        `paying ${summary.k} times over made the answer worse, which is a result worth reporting precisely ` +
        'because it is the opposite of what voting is usually assumed to do.',
      WIDTH - 6
    )) {
      lines.push(`      ${chunk}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Narration
// ---------------------------------------------------------------------------

export interface NarrationInput {
  a: ScoreResult | null;
  b: ScoreResult | null;
  c: ScoreResult | null;
  d: ScoreResult | null;
  /** Cases arm C put in front of the model, out of the split. */
  c_model_consulted: number;
  case_count: number;
}

function exact(r: ScoreResult | null): number {
  return r ? r.exact_match.count : -1;
}

/**
 * What the numbers say, including when what they say is "do not ship this".
 *
 * The order is deliberate. C against A comes first, because if the model earns
 * nothing then nothing else in the report matters. C against D comes second,
 * because a margin over the floor that is not also a margin over a random
 * control is not a margin. Only then does the money get discussed, and it gets
 * discussed as two numbers.
 */
export function narrate(input: NarrationInput): string {
  const { a, b, c, d } = input;
  const lines: string[] = [];
  lines.push(...block('WHAT THE NUMBERS SAY'));

  const say = (text: string) => {
    for (const chunk of wrap(text, WIDTH - 4)) lines.push(`  ${chunk}`);
    lines.push('');
  };

  if (!a) {
    say('Arm A did not run, so there is no floor to measure anything against. See the accounting above.');
    return lines.join('\n');
  }

  if (!c) {
    say(
      `Only arm A ran. It is right on ${exact(a)} of ${a.exact_match.denominator} cases using no model at all, ` +
        `paying Rs ${inr(a.wrong_approvals.rupees)} it should not have paid and withholding ` +
        `Rs ${inr(a.wrong_denials.rupees)} that was owed. That is the floor, and it is the number any model has ` +
        'to beat before it has earned a place in the pipeline.'
    );
    say(
      'Arms B, C and D were not attempted, so nothing here says whether the model earns anything. No zero in ' +
        'this report stands for a model arm that did not run.'
    );
    return lines.join('\n');
  }

  // --- 1. Did the model earn anything? -----------------------------------
  const cOverA = exact(c) - exact(a);
  lines.push('  1. DID THE MODEL EARN ANYTHING?');
  lines.push('');
  if (cOverA > 0) {
    say(
      `Arm C is right on ${exact(c)} of ${c.exact_match.denominator} cases against arm A's ${exact(a)} — a gain of ` +
        `${cOverA} case(s) for ${input.c_model_consulted} model calls per pass. The model earned its place in the ` +
        'pipeline on this split.'
    );
  } else if (cOverA === 0) {
    say(
      `Arm C and arm A are right on exactly the same number of cases: ${exact(a)} of ${a.exact_match.denominator}. ` +
        `The model was consulted on ${input.c_model_consulted} of ${input.case_count} cases and changed the total ` +
        'score by nothing. RECOMMENDATION: ship arm A. It costs no tokens, cannot be rate-limited, cannot be ' +
        'prompt-injected by an uploaded document, and returns the same answer every time. Check the two failure ' +
        'columns before acting on this: an identical exact-match score can hide a different mix of mistakes, and ' +
        'if arm C trades wrong approvals for wrong denials that is a real difference the totals do not show.'
    );
  } else {
    say(
      `Arm C is right on ${exact(c)} of ${c.exact_match.denominator} cases; arm A, with no model at all, is right on ` +
        `${exact(a)}. Adding the model made the system WORSE by ${-cOverA} case(s). RECOMMENDATION: ship arm A. ` +
        'This is the result the harness exists to be able to report, and reporting it is not a failure of the ' +
        'harness — a harness that could only describe a win would not be measuring anything.'
    );
  }

  // --- 2. Judgement or volume? -------------------------------------------
  lines.push('  2. IS THE LIFT JUDGEMENT OR VOLUME?');
  lines.push('');
  if (!d) {
    say('Arm D did not run, so nothing here separates judgement from output distribution.');
  } else {
    const cOverD = exact(c) - exact(d);
    if (cOverD > 0) {
      say(
        `Arm D draws the same multiset of verdicts as arm C — the same ${c.by_prediction.approve} approvals, ` +
          `${c.by_prediction.deny} denials and ${c.by_prediction.escalate} escalations — and attaches them to the ` +
          `wrong cases. It scores ${exact(d)}. Arm C scores ${exact(c)}, ${cOverD} case(s) better. That margin is ` +
          'the part of arm C that came from reading the case rather than from the shape of its output distribution.'
      );
    } else {
      say(
        `Arm D scores ${exact(d)} against arm C's ${exact(c)} while emitting the identical mix of verdicts in a ` +
          'shuffled order. Arm C is not beating a control that does no reading at all, which means its score is ' +
          'explained by how often it says each word and not by which case it says it about. The lift is volume, ' +
          'not judgement.'
      );
    }
  }

  // --- 3. What is the rules layer worth? ---------------------------------
  lines.push('  3. WHAT IS THE RULES LAYER WORTH?');
  lines.push('');
  if (!b) {
    say('Arm B did not run, so the rules layer cannot be priced.');
  } else {
    const cOverB = exact(c) - exact(b);
    const verdict =
      cOverB > 0
        ? `Arm C beats arm B by ${cOverB} case(s)`
        : cOverB === 0
          ? 'Arm C and arm B score identically on exact match'
          : `Arm B beats arm C by ${-cOverB} case(s)`;
    say(
      `${verdict} (${exact(c)} against ${exact(b)}), reading the same completions. Both arms were handed the same ` +
        'model answers from one shared cache rather than each calling independently, so the difference between ' +
        'them is the rules layer and nothing else — no provider variance, no second draw, no reliance on ' +
        'temperature 0 to hold the independent variable still.'
    );
    say(
      `Where it costs arm B: on the ${input.case_count - input.c_model_consulted} cases the deterministic layer ` +
        'vetoed, the shared system prompt still told the model that every deterministic check had passed, because ' +
        'that is the prompt the shipping system sends. On those cases arm B was reasoning from a false premise it ' +
        'had no way to detect. This is a documented bias against arm B and it is stated here rather than left for ' +
        'a reader to find. Correcting it would mean a second prompt and a second call per case, which would put ' +
        'provider variance back inside the comparison the shared cache exists to remove.'
    );
  }

  // --- 4. The money, as two numbers --------------------------------------
  lines.push('  4. THE MONEY, AS TWO NUMBERS');
  lines.push('');
  const money = (name: string, r: ScoreResult | null) =>
    r === null
      ? `      ${pad(name, 22)} not attempted`
      : `      ${pad(name, 22)} paid in error Rs ${padStart(inr(r.wrong_approvals.rupees), 12)}    withheld Rs ${padStart(inr(r.wrong_denials.rupees), 12)}`;
  lines.push(money('A rules only', a));
  lines.push(money('B model only', b));
  lines.push(money('C rules + model', c));
  lines.push(money('D random control', d));
  lines.push('');
  say(
    'These two columns are never added. A system that cuts wrong approvals by refusing more claims has not ' +
      'improved, it has moved the loss onto policyholders, and the only way to see that is to keep the two ' +
      'columns apart and read both.'
  );

  if (c && a) {
    const paidWorse = c.wrong_approvals.rupees > a.wrong_approvals.rupees;
    const heldWorse = c.wrong_denials.rupees > a.wrong_denials.rupees;
    if (paidWorse && heldWorse) {
      say(
        'On this split arm C is worse than arm A on BOTH columns: it pays more that should not have been paid ' +
          'and it withholds more that was owed. There is no trade-off to argue about here.'
      );
    } else if (paidWorse) {
      say(
        `Arm C pays Rs ${inr(c.wrong_approvals.rupees - a.wrong_approvals.rupees)} more in error than arm A, and ` +
          `withholds Rs ${inr(a.wrong_denials.rupees - c.wrong_denials.rupees)} less from policyholders. That is a ` +
          'trade, and whoever ships it should say out loud which side they are choosing.'
      );
    } else if (heldWorse) {
      say(
        `Arm C withholds Rs ${inr(c.wrong_denials.rupees - a.wrong_denials.rupees)} more from policyholders than ` +
          `arm A, and pays Rs ${inr(a.wrong_approvals.rupees - c.wrong_approvals.rupees)} less in error. That is a ` +
          'trade made in the insurer\'s favour, and it should be named as one rather than reported as an improvement.'
      );
    } else {
      say('Arm C is at least as good as arm A on both money columns, which is the only case where no trade is being made.');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

export interface FourArmReportInput {
  manifest: RunManifest;
  accounting: readonly ArmAccounting[];
  comparison: readonly ScoredRow[];
  kRepeat: KRepeatSummary;
  run1: ScoreResult | null;
  majority: ScoreResult | null;
  narration: NarrationInput;
  /** Anything that happened during the run a reader has to know about. */
  caveats: readonly string[];
}

export function renderFourArmReport(input: FourArmReportInput): string {
  const lines: string[] = [];
  lines.push(rule());
  lines.push(`SafeGuard claim adjudication — four-arm evaluation, ${input.manifest.split} split`);
  lines.push(rule());
  lines.push('');
  lines.push('  A  deterministic rules only, no model                the floor');
  lines.push('  B  model only, no rules layer, no veto               the model on its own');
  lines.push('  C  rules + model                                     what ships');
  lines.push('  D  random verdicts drawn to match arm C\'s mix        the control');
  lines.push('');
  for (const chunk of wrap(
    'Arms B and C read the same model completions from one shared cache. The model was called ' +
      'once per case per run and both arms were handed the answer, rather than each arm calling ' +
      'independently and trusting temperature 0 to make the two draws agree. A control the harness ' +
      'does not hold is a control it does not have.',
    WIDTH - 2
  )) {
    lines.push(`  ${chunk}`);
  }
  lines.push('');
  lines.push(renderScoringRules());
  lines.push(renderRulebook());
  lines.push(renderManifest(input.manifest));
  lines.push(renderAccounting(input.accounting));
  lines.push(renderComparison(input.comparison));
  lines.push(renderKRepeat(input.kRepeat, input.run1, input.majority));
  lines.push(narrate(input.narration));

  if (input.caveats.length > 0) {
    lines.push(...block('CAVEATS — things a reader has to know before quoting any number above'));
    for (const [index, caveat] of input.caveats.entries()) {
      const chunks = wrap(caveat, WIDTH - 8);
      lines.push(`  ${index + 1}. ${chunks[0] ?? ''}`);
      for (const chunk of chunks.slice(1)) lines.push(`     ${chunk}`);
      lines.push('');
    }
  }

  lines.push(rule());
  lines.push('  No figure above blends a wrong approval with a wrong denial.');
  lines.push('  Every rate above states its denominator by name, and the 95% Wilson interval that');
  lines.push('  denominator supports. No point estimate above was changed by adding them.');
  lines.push('  An arm that did not run says so; no zero in this report stands for something not attempted.');
  lines.push(rule());
  return lines.join('\n');
}

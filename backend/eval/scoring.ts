/**
 * How a case is scored — written down before any number existed, and rendered
 * into every report so the rules cannot be quietly reinterpreted once the
 * numbers are disappointing.
 *
 * The four commitments, in the order they matter:
 *
 * 1. **No partial credit.** A verdict is right or it is not. There is no
 *    "nearly denied" and no score for good reasoning behind a wrong answer.
 *
 * 2. **A wrong approval and a wrong denial are never averaged into one
 *    number.** They are different failures with different victims. A wrong
 *    approval pays money that should not have been paid. A wrong denial fails
 *    a policyholder who was owed. A single "error rate" lets one be traded
 *    against the other silently, and the trade is always made in favour of
 *    whichever is cheaper to the insurer. Both are reported, separately, in
 *    rupees, using each case's own amounts.
 *
 * 3. **`escalate` where the truth was `approve` or `deny` is its own
 *    category.** It is a cost — a person's time, a claimant's delay — and not
 *    a win. It is also not as bad as a wrong payout, and flattening it into
 *    "wrong" would make a system that escalates everything look identical to
 *    one that pays every fraudulent claim.
 *
 * 4. **Every rate carries its denominator, by name.** A rate whose
 *    denominator is implicit can be improved by changing the denominator.
 *    Scoring refuses to run at all on a partial set of predictions, for the
 *    same reason.
 */
import { renderRulebook, RULEBOOK_VERSION, wrap } from './rules.js';
import { inr } from './rng.js';
import type { GroundTruthEntry, TrapCategory, Verdict } from './types.js';

export const SCORING_RULES_VERSION = '1.0.0';

export interface ScoringRule {
  id: string;
  title: string;
  text: string;
}

export const SCORING_RULES: readonly ScoringRule[] = Object.freeze([
  {
    id: 'S1',
    title: 'No partial credit',
    text:
      'A verdict matches the ground-truth label or it does not. Nothing is awarded for a ' +
      'plausible justification behind a wrong verdict, and nothing is deducted for a terse ' +
      'one behind a right verdict. This report scores decisions, not prose.',
  },
  {
    id: 'S2',
    title: 'Wrong approvals and wrong denials are never combined',
    text:
      'They are reported as two numbers, in counts and in rupees, and no line anywhere in ' +
      'this report adds them together or averages them. A wrong approval pays money that ' +
      'should not have been paid; a wrong denial fails a policyholder who was owed. Any ' +
      'single figure covering both hides which of the two a system is choosing.',
  },
  {
    id: 'S3',
    title: 'Over-escalation is a cost, not an error and not a win',
    text:
      'Predicting escalate where the truth was approve or deny is counted in its own ' +
      'category. It consumes a human review and delays a claimant, so it is not free; it ' +
      'pays nobody wrongly and refuses nobody wrongly, so it is not equivalent to a wrong ' +
      'payout. A system that escalates everything scores badly here and cleanly elsewhere, ' +
      'which is the honest picture of what it is.',
  },
  {
    id: 'S4',
    title: 'Missed escalation is split by what it did',
    text:
      'Predicting approve where the truth was escalate paid money without the review the ' +
      'case needed. Predicting deny where the truth was escalate refused a claimant on a ' +
      'file that did not support a refusal. These are counted separately because they land ' +
      'on different people.',
  },
  {
    id: 'S5',
    title: 'Rupees come from the case, never from a constant',
    text:
      'Every rupee figure is max(0, min(claimed_amount, coverage_amount) - deductible) for ' +
      'the case in question, taken from the fixture and recorded in the answer key as ' +
      'payable_if_approved_inr. No average claim size is used anywhere.',
  },
  {
    id: 'S6',
    title: 'Every rate states its denominator by name',
    text:
      'A rate whose denominator is implicit is a rate that can be improved by changing the ' +
      'denominator. For the same reason scoring refuses to run unless there is exactly one ' +
      'prediction for every case in the split: a run that quietly drops the cases it found ' +
      'hard is not a run.',
  },
]);

export function renderScoringRules(): string {
  const lines = [`Scoring rules v${SCORING_RULES_VERSION} — fixed before any result was measured.`, ''];
  for (const rule of SCORING_RULES) {
    lines.push(`  ${rule.id}  ${rule.title}`);
    for (const chunk of wrap(rule.text, 84)) lines.push(`      ${chunk}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

export interface Prediction {
  case_id: string;
  verdict: Verdict;
}

/**
 * The two-sided z for a 95% interval, written out rather than rounded to 1.96.
 *
 * A 1.96 in one file and a 1.959964 in another is how two renderings of the
 * same run come to disagree in the last printed digit, and a reader who finds
 * that disagreement has no way to tell it from a real one.
 */
const Z_95 = 1.959963984540054;

/**
 * The Wilson score interval for `count` successes out of `denominator` trials,
 * at 95%, returned as proportions in [0, 1].
 *
 * Wilson, not the normal approximation and not a bootstrap. Both of those are
 * being asked to do something they cannot at the sizes this harness works at:
 *
 *   - The normal (Wald) interval is symmetric about p-hat, so at 0 successes it
 *     returns [0, 0] and at n successes it returns [1, 1]. "0/31 wrong
 *     approvals" would print as a proven impossibility rather than as what it
 *     is, which is that none were seen in 31 tries. It also walks outside
 *     [0, 1] as soon as p-hat is near either end, and its coverage at n = 100
 *     is not the 95% it advertises.
 *   - The bootstrap fails the same two cases for a different reason: resampling
 *     31 outcomes that are all identical can only ever produce resamples that
 *     are all identical, so it reports zero width for exactly the results whose
 *     width matters most.
 *
 * Below a few hundred samples both misbehave (Bowyer, Aitchison & Ivanova,
 * ICML 2025). Every denominator in this file is two digits or three, so Wilson
 * is not the conservative choice here, it is the correct one. It inverts the
 * score test instead of the Wald test, which is why it is asymmetric about
 * p-hat and why it cannot leave [0, 1].
 */
export function wilson(count: number, denominator: number, z: number = Z_95): { lo: number; hi: number } {
  // A rate with no denominator constrains nothing at all, and [0, 1] says that
  // out loud. Returning NaN here would let formatting turn "we measured
  // nothing" into a dash that reads like a small number.
  if (denominator <= 0) return { lo: 0, hi: 1 };

  const n = denominator;
  const p = count / n;
  const z2 = z * z;
  const spread = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / spread;
  const half = (z / spread) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));

  // Clamping is floating-point hygiene, not a correction. Wilson cannot leave
  // [0, 1] mathematically; it can land a bit or two outside it in doubles, and
  // a printed "-0.0%" would be read as a bug in the scorer rather than in ULPs.
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/**
 * A count, the denominator it is a fraction of — always named — and the
 * interval that denominator actually supports.
 *
 * The bounds are S6 carried one step further. Naming n stops a rate being
 * improved by quietly changing n; printing [lo, hi] stops 9/31 and 29/100
 * being read as the same claim about the world because they round to the same
 * percentage. The point estimate is unchanged by their presence: a bound is
 * additive, and if adding one moves a score then the score was never the thing
 * it was reported as.
 */
export interface Rate {
  count: number;
  denominator: number;
  denominator_name: string;
  /** Wilson lower bound, 95%, as a proportion in [0, 1]. */
  lo: number;
  /** Wilson upper bound, 95%, as a proportion in [0, 1]. */
  hi: number;
}

export function rate(count: number, denominator: number, denominator_name: string): Rate {
  const { lo, hi } = wilson(count, denominator);
  return { count, denominator, denominator_name, lo, hi };
}

export function rateText(r: Rate): string {
  const pct = r.denominator === 0 ? 'n/a' : `${((100 * r.count) / r.denominator).toFixed(1)}%`;
  // No denominator, no interval worth printing: "0/0 (n/a, 95% CI 0.0-100.0)"
  // is a wider sentence saying the same nothing.
  const ci = r.denominator === 0 ? '' : `, 95% CI ${(100 * r.lo).toFixed(1)}-${(100 * r.hi).toFixed(1)}`;
  return `${r.count}/${r.denominator} ${r.denominator_name} (${pct}${ci})`;
}

// ---------------------------------------------------------------------------
// Paired comparison
// ---------------------------------------------------------------------------

/**
 * A paired comparison of two arms over the same cases.
 *
 * The two discordant cells are the interpretable numbers, and they are named
 * after what they are rather than after "b" and "c". The concordant cells are
 * carried as well, because 4 against 11 out of 100 cases and 4 against 11 out
 * of 15 are different statements and only the second one is close.
 */
export interface McNemarResult {
  /** Cases the first arm got right and the second got wrong. The b cell. */
  only_first_correct: number;
  /** Cases the second arm got right and the first got wrong. The c cell. */
  only_second_correct: number;
  both_correct: number;
  both_wrong: number;
  /** b + c. The only cases the test looks at; the rest carry no information. */
  discordant: number;
  /** Cases compared. Always b + c + both_correct + both_wrong. */
  n: number;
  /** Two-sided p from the exact binomial, never the chi-square approximation. */
  p: number;
}

/**
 * Two-sided exact binomial tail for k successes out of n at p = 0.5.
 *
 * The probabilities are built up multiplicatively rather than through a
 * binomial coefficient, because C(100, 50) is about 1e29 and does not survive
 * a double, while no pmf term is ever larger than 1.
 */
function twoSidedSignTest(k: number, n: number): number {
  if (n === 0) return 1;
  let pmf = Math.pow(0.5, n);
  let tail = pmf;
  for (let i = 1; i <= k; i++) {
    pmf = (pmf * (n - i + 1)) / i;
    tail += pmf;
  }
  // Doubling can overshoot when k is at or near n/2; a p above 1 is an
  // arithmetic artefact, not a probability.
  return Math.min(1, 2 * tail);
}

/**
 * McNemar's test on two arms scored over the same cases.
 *
 * WHY THIS EXISTS ALONGSIDE THE WILSON BOUNDS, because the two get confused
 * and the confusion costs a real result:
 *
 *   A Wilson interval describes one arm's own uncertainty about its own score.
 *   McNemar describes whether two arms differ on the same cases. They answer
 *   different questions, and the intervals are not a substitute for the test.
 *   Reading two overlapping marginal intervals as "no significant difference"
 *   is invalid whenever the two arms were measured on the same cases — which
 *   here they always are. Arms B and C read the same cached completions and
 *   arm D is drawn to arm C's own verdict multiset, so every pair in this
 *   harness is paired by construction. The marginal-overlap reading is
 *   substantially less powerful than the paired test and will report "no
 *   difference" over differences that are real.
 *
 * WHY THE EXACT BINOMIAL AND NOT CHI-SQUARE WITH A CONTINUITY CORRECTION:
 *
 *   The chi-square form is an approximation to this, and it is the one worth
 *   using only when the discordant count is large enough for the approximation
 *   to hold — the usual rule of thumb is b + c of at least 25. On 100 cases
 *   the discordant counts here are single and low double digits, which is
 *   exactly where the approximation is worst and where it is known to be
 *   anti-conservative before the correction and over-conservative after it.
 *   The exact test needs a loop of at most b + c terms, so on this data it is
 *   both the correct choice and the cheap one. Nothing is gained by
 *   approximating something this small.
 *
 * The concordant cells are discarded by the test itself, not by us: a case
 * both arms got right, or both got wrong, carries no information about which
 * of the two is better. They are still reported so that a reader can see how
 * much of the split the test actually ran on.
 */
export function mcnemar(
  first: Readonly<Record<string, boolean>>,
  second: Readonly<Record<string, boolean>>
): McNemarResult {
  const ids = Object.keys(first);
  // Pairing is the whole basis of the test, so an unpaired call is refused
  // rather than silently compared over whichever cases happen to be in both.
  // This is S6 one layer down: a test whose case set is implicit is a test
  // that can be improved by changing the case set.
  if (ids.length !== Object.keys(second).length) {
    throw new Error(
      `mcnemar: ${ids.length} cases against ${Object.keys(second).length}. A paired test needs ` +
        'the same cases on both sides; comparing whatever they have in common is not a paired test.'
    );
  }

  let onlyFirst = 0;
  let onlySecond = 0;
  let bothCorrect = 0;
  let bothWrong = 0;

  for (const id of ids) {
    const a = first[id];
    const b = second[id];
    if (b === undefined) {
      throw new Error(`mcnemar: ${id} is scored on one side and absent from the other; the pair is not a pair.`);
    }
    if (a && b) bothCorrect++;
    else if (a && !b) onlyFirst++;
    else if (!a && b) onlySecond++;
    else bothWrong++;
  }

  const discordant = onlyFirst + onlySecond;
  // No discordant pairs means the two arms were right and wrong on exactly the
  // same cases, and the test has nothing to look at. p = 1 is the honest
  // return: it says there is no evidence of a difference, which is not the
  // same claim as there being no difference, and it is what a reader gets
  // instead of a division by zero dressed up as certainty.
  const p = twoSidedSignTest(Math.min(onlyFirst, onlySecond), discordant);

  return {
    only_first_correct: onlyFirst,
    only_second_correct: onlySecond,
    both_correct: bothCorrect,
    both_wrong: bothWrong,
    discordant,
    n: ids.length,
    p,
  };
}

export interface CaseCost {
  case_id: string;
  trap: TrapCategory;
  truth: Verdict;
  predicted: Verdict;
  rupees: number;
}

export interface FailureGroup {
  rate: Rate;
  rupees: number;
  cases: CaseCost[];
}

export interface TrapBreakdown {
  trap: TrapCategory;
  correct: number;
  total: number;
}

export interface ScoreResult {
  scoring_rules_version: string;
  rulebook_version: string;
  split: string;
  /** The denominator for exact match, and the size of the scored set. */
  n: number;
  by_truth: Record<Verdict, number>;
  by_prediction: Record<Verdict, number>;
  /** confusion[truth][predicted]. */
  confusion: Record<Verdict, Record<Verdict, number>>;
  exact_match: Rate;
  /** Predicted approve, truth deny. Money paid that should not have been. */
  wrong_approvals: FailureGroup;
  /** Predicted deny, truth approve. A policyholder failed. */
  wrong_denials: FailureGroup;
  /** Predicted approve, truth escalate. Paid without the review it needed. */
  missed_escalation_paid: FailureGroup;
  /** Predicted deny, truth escalate. Refused on a file that did not support it. */
  missed_escalation_refused: FailureGroup;
  /** Predicted escalate, truth approve or deny. A cost, not an error. */
  over_escalation: FailureGroup;
  by_trap: TrapBreakdown[];
  /**
   * Per case, whether this arm's verdict matched the label. Carried so that a
   * paired comparison between two arms can be recomputed from the record
   * rather than believed, and so that mcnemar() has something to pair on.
   * Exact match only (S1); there is no partial entry here either.
   */
  correct_by_case: Record<string, boolean>;
}

const VERDICTS: readonly Verdict[] = ['approve', 'deny', 'escalate'];

function emptyCounts(): Record<Verdict, number> {
  return { approve: 0, deny: 0, escalate: 0 };
}

/**
 * There is deliberately no function that returns a single blended cost, and
 * this is what stands where one would go. Anyone reaching for it gets the
 * argument rather than a number.
 */
export function blendedCost(): never {
  throw new Error(
    'blendedCost: refused by S2. A wrong approval and a wrong denial are different failures ' +
      'with different victims, and any single figure covering both hides which of the two a ' +
      'system is choosing. Report wrong_approvals and wrong_denials side by side.'
  );
}

/**
 * Score a set of predictions against the answer key.
 *
 * Throws rather than scoring a partial run: a missing prediction silently
 * shrinks every denominator in the report, which is precisely the manipulation
 * S6 exists to prevent.
 */
export function score(
  predictions: readonly Prediction[],
  truth: readonly GroundTruthEntry[],
  split = 'unnamed'
): ScoreResult {
  const truthById = new Map(truth.map((t) => [t.case_id, t]));

  const seen = new Set<string>();
  for (const p of predictions) {
    if (!truthById.has(p.case_id)) {
      throw new Error(`score: prediction for unknown case ${p.case_id}`);
    }
    if (seen.has(p.case_id)) {
      throw new Error(`score: two predictions for ${p.case_id}; a case gets exactly one verdict`);
    }
    if (!VERDICTS.includes(p.verdict)) {
      throw new Error(`score: ${p.case_id} predicted "${p.verdict}", which is not one of ${VERDICTS.join(', ')}`);
    }
    seen.add(p.case_id);
  }
  const absent = truth.filter((t) => !seen.has(t.case_id)).map((t) => t.case_id);
  if (absent.length > 0) {
    throw new Error(
      `score: no prediction for ${absent.length} case(s) — ${absent.slice(0, 5).join(', ')}` +
        `${absent.length > 5 ? ', ...' : ''}. Refusing to score a partial run: dropping the cases a ` +
        'system found hard shrinks every denominator in the report (S6).'
    );
  }

  const predById = new Map(predictions.map((p) => [p.case_id, p.verdict]));

  const by_truth = emptyCounts();
  const by_prediction = emptyCounts();
  const confusion: Record<Verdict, Record<Verdict, number>> = {
    approve: emptyCounts(),
    deny: emptyCounts(),
    escalate: emptyCounts(),
  };

  const wrongApprovals: CaseCost[] = [];
  const wrongDenials: CaseCost[] = [];
  const missedPaid: CaseCost[] = [];
  const missedRefused: CaseCost[] = [];
  const overEscalated: CaseCost[] = [];

  const trapTotals = new Map<TrapCategory, { correct: number; total: number }>();
  const correctByCase: Record<string, boolean> = {};

  for (const entry of truth) {
    const predicted = predById.get(entry.case_id)!;
    const actual = entry.label;

    by_truth[actual]++;
    by_prediction[predicted]++;
    confusion[actual][predicted]++;

    const bucket = trapTotals.get(entry.trap) ?? { correct: 0, total: 0 };
    bucket.total++;
    // S1: exact match only. The same test decides the trap breakdown and the
    // per-case record a paired test later reads, so the two cannot drift.
    correctByCase[entry.case_id] = predicted === actual;
    if (predicted === actual) bucket.correct++;
    trapTotals.set(entry.trap, bucket);

    if (predicted === actual) continue;

    const cost: CaseCost = {
      case_id: entry.case_id,
      trap: entry.trap,
      truth: actual,
      predicted,
      rupees: entry.payable_if_approved_inr,
    };

    if (predicted === 'approve' && actual === 'deny') wrongApprovals.push(cost);
    else if (predicted === 'approve' && actual === 'escalate') missedPaid.push(cost);
    else if (predicted === 'deny' && actual === 'approve') wrongDenials.push(cost);
    else if (predicted === 'deny' && actual === 'escalate') missedRefused.push(cost);
    else if (predicted === 'escalate') overEscalated.push(cost);
  }

  const rupees = (cases: CaseCost[]) => cases.reduce((sum, c) => sum + c.rupees, 0);
  const correct = VERDICTS.reduce((sum, v) => sum + confusion[v][v], 0);

  // There is deliberately no "cases where approving would be wrong" denominator
  // pooling deny and escalate. They fail differently, so they are not one
  // population, and pooling them is the first step towards S2 being ignored.
  const nNotEscalate = by_truth.approve + by_truth.deny;

  return {
    scoring_rules_version: SCORING_RULES_VERSION,
    rulebook_version: RULEBOOK_VERSION,
    split,
    n: truth.length,
    by_truth,
    by_prediction,
    confusion,
    exact_match: rate(correct, truth.length, 'cases in the split'),
    wrong_approvals: {
      rate: rate(wrongApprovals.length, by_truth.deny, 'cases whose correct verdict was deny'),
      rupees: rupees(wrongApprovals),
      cases: wrongApprovals,
    },
    wrong_denials: {
      rate: rate(wrongDenials.length, by_truth.approve, 'cases whose correct verdict was approve'),
      rupees: rupees(wrongDenials),
      cases: wrongDenials,
    },
    missed_escalation_paid: {
      rate: rate(missedPaid.length, by_truth.escalate, 'cases whose correct verdict was escalate'),
      rupees: rupees(missedPaid),
      cases: missedPaid,
    },
    missed_escalation_refused: {
      rate: rate(missedRefused.length, by_truth.escalate, 'cases whose correct verdict was escalate'),
      rupees: rupees(missedRefused),
      cases: missedRefused,
    },
    over_escalation: {
      rate: rate(overEscalated.length, nNotEscalate, 'cases whose correct verdict was approve or deny'),
      rupees: rupees(overEscalated.filter((c) => c.truth === 'approve')),
      cases: overEscalated,
    },
    correct_by_case: correctByCase,
    by_trap: [...trapTotals.entries()]
      .map(([trap, b]) => ({ trap, correct: b.correct, total: b.total }))
      .sort((a, b) => a.trap.localeCompare(b.trap)),
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function table(result: ScoreResult): string[] {
  const lines = ['  truth \\ predicted    approve      deny  escalate'];
  for (const t of VERDICTS) {
    const row = VERDICTS.map((p) => String(confusionCell(result, t, p)).padStart(9)).join(' ');
    lines.push(`  ${t.padEnd(20)}${row}`);
  }
  return lines;
}

function confusionCell(result: ScoreResult, truth: Verdict, predicted: Verdict): number {
  return result.confusion[truth][predicted];
}

function group(title: string, gloss: string, g: FailureGroup, moneyLabel: string): string[] {
  const lines = ['', `  ${title}`];
  for (const chunk of wrap(gloss, 84)) lines.push(`      ${chunk}`);
  lines.push(`      ${rateText(g.rate)}`);
  lines.push(`      ${moneyLabel}: Rs ${inr(g.rupees)}`);
  for (const c of g.cases.slice(0, 8)) {
    lines.push(`        ${c.case_id}  ${c.trap}  truth=${c.truth} predicted=${c.predicted}  Rs ${inr(c.rupees)}`);
  }
  if (g.cases.length > 8) lines.push(`        ... and ${g.cases.length - 8} more`);
  return lines;
}

/**
 * The full report. The rulebook and the scoring rules are printed in every
 * one of these, because a rule that only lives in a source file is a rule that
 * can be reinterpreted the morning after a bad result.
 */
export function renderReport(result: ScoreResult, sealLine?: string): string {
  const lines: string[] = [];
  lines.push('='.repeat(88));
  lines.push(`SafeGuard claim adjudication — scored against the ${result.split} split`);
  lines.push('='.repeat(88));
  lines.push('');
  if (sealLine) {
    lines.push(sealLine);
    lines.push('');
  }
  lines.push(renderScoringRules());
  lines.push(renderRulebook());
  lines.push('-'.repeat(88));
  lines.push('RESULTS');
  lines.push('-'.repeat(88));
  lines.push('');
  lines.push(`  Exact-verdict match: ${rateText(result.exact_match)}`);
  lines.push('      No partial credit was awarded anywhere in this figure (S1).');
  lines.push('      Every CI above and below is a 95% Wilson score interval on that line\'s own');
  lines.push('      denominator. Wilson rather than the normal approximation because at these');
  lines.push('      denominators the normal approximation reports zero width for 0/n and n/n, and');
  lines.push('      a bound of zero width on a count nobody observed is not a bound.');
  lines.push('');
  lines.push(
    `  Ground-truth mix: approve ${result.by_truth.approve}, deny ${result.by_truth.deny}, escalate ${result.by_truth.escalate}`
  );
  lines.push(
    `  Predicted mix:    approve ${result.by_prediction.approve}, deny ${result.by_prediction.deny}, escalate ${result.by_prediction.escalate}`
  );
  lines.push('');
  lines.push(...table(result));

  lines.push(
    ...group(
      'WRONG APPROVALS — money paid that should not have been',
      'Predicted approve where the correct verdict was deny. Reported on its own and never ' +
        'averaged with wrong denials (S2).',
      result.wrong_approvals,
      'Paid in error'
    )
  );
  lines.push(
    ...group(
      'WRONG DENIALS — a policyholder who was owed and was refused',
      'Predicted deny where the correct verdict was approve. Reported on its own and never ' +
        'averaged with wrong approvals (S2).',
      result.wrong_denials,
      'Withheld from policyholders'
    )
  );
  lines.push(
    ...group(
      'MISSED ESCALATION, PAID — settled without the review the file needed',
      'Predicted approve where the correct verdict was escalate (S4).',
      result.missed_escalation_paid,
      'Paid without review'
    )
  );
  lines.push(
    ...group(
      'MISSED ESCALATION, REFUSED — refused on a file that did not support a refusal',
      'Predicted deny where the correct verdict was escalate (S4).',
      result.missed_escalation_refused,
      'At stake in these cases'
    )
  );
  lines.push(
    ...group(
      'OVER-ESCALATION — a cost, not an error and not a win',
      'Predicted escalate where the correct verdict was approve or deny. Each one buys a human ' +
        'review that was not needed and delays a claimant (S3). The rupee figure counts only the ' +
        'cases whose correct verdict was approve, where real money was delayed.',
      result.over_escalation,
      'Delayed to policyholders'
    )
  );

  lines.push('');
  lines.push('  BY TRAP CATEGORY (exact match)');
  for (const t of result.by_trap) {
    const pct = t.total === 0 ? 'n/a' : `${((100 * t.correct) / t.total).toFixed(0)}%`;
    lines.push(`      ${t.trap.padEnd(34)} ${String(t.correct).padStart(3)}/${String(t.total).padEnd(3)} ${pct}`);
  }
  lines.push('');
  lines.push('-'.repeat(88));
  lines.push(
    `  Scoring rules v${result.scoring_rules_version}; labels derived under rulebook v${result.rulebook_version}.`
  );
  lines.push('  No figure above blends a wrong approval with a wrong denial.');
  lines.push('-'.repeat(88));
  return lines.join('\n');
}

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

/** A count and the denominator it is a fraction of, which is always named. */
export interface Rate {
  count: number;
  denominator: number;
  denominator_name: string;
}

export function rate(count: number, denominator: number, denominator_name: string): Rate {
  return { count, denominator, denominator_name };
}

export function rateText(r: Rate): string {
  const pct = r.denominator === 0 ? 'n/a' : `${((100 * r.count) / r.denominator).toFixed(1)}%`;
  return `${r.count}/${r.denominator} ${r.denominator_name} (${pct})`;
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

  for (const entry of truth) {
    const predicted = predById.get(entry.case_id)!;
    const actual = entry.label;

    by_truth[actual]++;
    by_prediction[predicted]++;
    confusion[actual][predicted]++;

    const bucket = trapTotals.get(entry.trap) ?? { correct: 0, total: 0 };
    bucket.total++;
    // S1: exact match only.
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

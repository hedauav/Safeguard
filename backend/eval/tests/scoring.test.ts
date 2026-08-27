import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCORING_RULES,
  blendedCost,
  mcnemar,
  rate,
  rateText,
  renderReport,
  renderScoringRules,
  score,
  wilson,
  type Prediction,
} from '../scoring.js';
import { renderRulebook, RULES } from '../rules.js';
import { readTruth } from '../dataset.js';
import type { CaseFacts, GroundTruthEntry, Verdict } from '../types.js';

const FACTS: CaseFacts = {
  in_force: true,
  exclusion_applies: false,
  exclusion_clause: null,
  deductible_swallows_claim: false,
  over_coverage_limit: false,
  evidence_contradiction: false,
  contradiction_detail: null,
  duplicate_filing: false,
  evidence_insufficient: false,
};

/** A tiny hand-built key, so the arithmetic under test is visible. */
function entry(id: string, label: Verdict, payable: number): GroundTruthEntry {
  return {
    case_id: id,
    label,
    rule: 'R8',
    justification: 'fixture',
    trap: 'straightforward_approve',
    facts: FACTS,
    claimed_amount_inr: payable + 10_000,
    payable_if_approved_inr: payable,
  };
}

const TRUTH: GroundTruthEntry[] = [
  entry('t-approve-1', 'approve', 100_000),
  entry('t-approve-2', 'approve', 250_000),
  entry('t-deny-1', 'deny', 400_000),
  entry('t-deny-2', 'deny', 60_000),
  entry('t-escalate-1', 'escalate', 800_000),
  entry('t-escalate-2', 'escalate', 30_000),
];

function predict(map: Record<string, Verdict>): Prediction[] {
  return Object.entries(map).map(([case_id, verdict]) => ({ case_id, verdict }));
}

const PERFECT = predict({
  't-approve-1': 'approve',
  't-approve-2': 'approve',
  't-deny-1': 'deny',
  't-deny-2': 'deny',
  't-escalate-1': 'escalate',
  't-escalate-2': 'escalate',
});

// --- S1: no partial credit --------------------------------------------------

test('a perfect run is 6/6 and costs nothing', () => {
  const r = score(PERFECT, TRUTH, 'fixture');
  assert.equal(r.exact_match.count, 6);
  assert.equal(r.exact_match.denominator, 6);
  assert.equal(r.wrong_approvals.rupees, 0);
  assert.equal(r.wrong_denials.rupees, 0);
  assert.equal(r.over_escalation.rate.count, 0);
});

test('escalating an approvable claim earns nothing, not a fraction', () => {
  const nearMiss: Prediction[] = PERFECT.map((p) =>
    p.case_id === 't-approve-1' ? { ...p, verdict: 'escalate' as Verdict } : p
  );
  const r = score(nearMiss, TRUTH, 'fixture');
  assert.equal(r.exact_match.count, 5, 'a near-miss verdict is a miss');
  assert.equal(r.over_escalation.rate.count, 1);
  assert.equal(r.wrong_denials.rate.count, 0, 'an over-escalation is not a denial');
  assert.equal(r.wrong_approvals.rate.count, 0);
});

// --- S2: the two failures never become one ----------------------------------

test('a wrong approval and a wrong denial are counted and priced separately', () => {
  const r = score(
    predict({
      't-approve-1': 'deny', //  wrong denial, Rs 100,000 withheld
      't-approve-2': 'approve',
      't-deny-1': 'approve', //  wrong approval, Rs 400,000 paid in error
      't-deny-2': 'deny',
      't-escalate-1': 'escalate',
      't-escalate-2': 'escalate',
    }),
    TRUTH,
    'fixture'
  );

  assert.equal(r.wrong_approvals.rate.count, 1);
  assert.equal(r.wrong_approvals.rupees, 400_000);
  assert.equal(r.wrong_approvals.rate.denominator, 2);
  assert.equal(r.wrong_approvals.rate.denominator_name, 'cases whose correct verdict was deny');

  assert.equal(r.wrong_denials.rate.count, 1);
  assert.equal(r.wrong_denials.rupees, 100_000);
  assert.equal(r.wrong_denials.rate.denominator, 2);
  assert.equal(r.wrong_denials.rate.denominator_name, 'cases whose correct verdict was approve');

  assert.notEqual(r.wrong_approvals.rupees, r.wrong_denials.rupees);
});

test('the result object contains no field that blends the two failures', () => {
  const r = score(PERFECT, TRUTH, 'fixture');
  for (const key of Object.keys(r)) {
    assert.doesNotMatch(
      key,
      /(total|overall|combined|blended|aggregate|average|mean)/i,
      `"${key}" reads like a single number covering both failure kinds`
    );
  }
});

test('asking for a blended cost gets the argument, not a number', () => {
  assert.throws(() => blendedCost(), /refused by S2/);
  assert.throws(() => blendedCost(), /different victims/);
});

// --- S3 / S4: escalation has its own categories -----------------------------

test('escalate predicted where the truth was approve or deny is its own category', () => {
  const r = score(
    predict({
      't-approve-1': 'escalate',
      't-approve-2': 'approve',
      't-deny-1': 'escalate',
      't-deny-2': 'deny',
      't-escalate-1': 'escalate',
      't-escalate-2': 'escalate',
    }),
    TRUTH,
    'fixture'
  );
  assert.equal(r.over_escalation.rate.count, 2);
  assert.equal(r.over_escalation.rate.denominator, 4);
  assert.equal(r.over_escalation.rate.denominator_name, 'cases whose correct verdict was approve or deny');
  // Only the approvable one had money delayed; the deniable one had none owed.
  assert.equal(r.over_escalation.rupees, 100_000);
  assert.equal(r.wrong_approvals.rate.count, 0);
  assert.equal(r.wrong_denials.rate.count, 0);
});

test('a missed escalation is split by whether it paid or refused', () => {
  const r = score(
    predict({
      't-approve-1': 'approve',
      't-approve-2': 'approve',
      't-deny-1': 'deny',
      't-deny-2': 'deny',
      't-escalate-1': 'approve', // paid Rs 800,000 without the review it needed
      't-escalate-2': 'deny', //    refused on a file that did not support it
    }),
    TRUTH,
    'fixture'
  );
  assert.equal(r.missed_escalation_paid.rate.count, 1);
  assert.equal(r.missed_escalation_paid.rupees, 800_000);
  assert.equal(r.missed_escalation_refused.rate.count, 1);
  assert.equal(r.missed_escalation_refused.rupees, 30_000);
  assert.equal(r.missed_escalation_paid.rate.denominator_name, 'cases whose correct verdict was escalate');
  // Neither is folded into the wrong-approval or wrong-denial counts.
  assert.equal(r.wrong_approvals.rate.count, 0);
  assert.equal(r.wrong_denials.rate.count, 0);
});

test('a system that escalates everything scores badly in one place and cleanly elsewhere', () => {
  const r = score(
    TRUTH.map((t) => ({ case_id: t.case_id, verdict: 'escalate' as Verdict })),
    TRUTH,
    'fixture'
  );
  assert.equal(r.exact_match.count, 2);
  assert.equal(r.over_escalation.rate.count, 4);
  assert.equal(r.wrong_approvals.rupees, 0, 'it pays nobody wrongly');
  assert.equal(r.wrong_denials.rupees, 0, 'it refuses nobody wrongly');
});

// --- S5 / S6: rupees and denominators ---------------------------------------

test('rupee figures come from the cases, not from an average', () => {
  const r = score(
    predict({
      't-approve-1': 'approve',
      't-approve-2': 'deny',
      't-deny-1': 'deny',
      't-deny-2': 'deny',
      't-escalate-1': 'escalate',
      't-escalate-2': 'escalate',
    }),
    TRUTH,
    'fixture'
  );
  assert.equal(r.wrong_denials.rupees, 250_000, 'the amount is the one on that case');
  assert.deepEqual(
    r.wrong_denials.cases.map((c) => c.case_id),
    ['t-approve-2']
  );
});

test('every rate renders with its denominator named', () => {
  const r = score(PERFECT, TRUTH, 'fixture');
  assert.equal(rateText(r.exact_match), '6/6 cases in the split (100.0%, 95% CI 61.0-100.0)');
  assert.match(rateText(r.wrong_approvals.rate), /cases whose correct verdict was deny/);
  assert.equal(
    rateText({ count: 0, denominator: 0, denominator_name: 'nothing', lo: 0, hi: 1 }),
    '0/0 nothing (n/a)'
  );
});

// --- Wilson intervals -------------------------------------------------------
//
// The cases below are the ones a normal-approximation bound gets wrong, which
// is why they are here and not a smoke test of the happy path.

test('Wilson matches the closed form on a textbook value', () => {
  // 50/100 at 95%: the interval every reference works out to 0.4038 - 0.5962.
  const w = wilson(50, 100);
  assert.ok(Math.abs(w.lo - 0.4038315303659956) < 1e-12, `lo was ${w.lo}`);
  assert.ok(Math.abs(w.hi - 0.5961684696340044) < 1e-12, `hi was ${w.hi}`);
  // At p = 0.5 the interval is symmetric; everywhere else it is not, and that
  // asymmetry is the difference between Wilson and the thing it replaces.
  assert.ok(Math.abs((w.lo + w.hi) / 2 - 0.5) < 1e-12);
});

test('zero successes gets a real upper bound, not a zero-width interval', () => {
  // This is the case the normal approximation reports as [0, 0]: p-hat is 0,
  // so its half-width is z * sqrt(0/n) = 0, and "no wrong approvals in 31
  // deniable cases" prints as a proof that there can never be one.
  const w = wilson(0, 31);
  assert.equal(w.lo, 0, 'a count of zero cannot have a lower bound above zero');
  assert.ok(w.hi > 0, 'seeing none in 31 tries does not bound the rate at zero');
  assert.ok(Math.abs(w.hi - 0.11025539546043596) < 1e-12, `hi was ${w.hi}`);
  // The rule of three is the usual sanity check on this: roughly 3/n.
  assert.ok(w.hi > 3 / 31 && w.hi < 4 / 31);
});

test('all successes gets a real lower bound, not certainty', () => {
  const w = wilson(10, 10);
  assert.ok(w.hi >= 1 - 1e-12, 'the upper bound at n/n is 1');
  assert.ok(w.hi <= 1, 'and never above it');
  assert.ok(w.lo < 1, '10 for 10 is not a promise about the eleventh');
  assert.ok(Math.abs(w.lo - 0.7224672001371107) < 1e-12, `lo was ${w.lo}`);
});

test('very small n produces a wide interval rather than a confident one', () => {
  // 1/1 is where the bootstrap has nothing to resample and the normal
  // approximation returns [1, 1]. Wilson says what one observation is worth.
  const one = wilson(1, 1);
  assert.ok(one.lo > 0 && one.lo < 0.25, `lo was ${one.lo}`);
  assert.ok(one.hi >= 1 - 1e-12);
  assert.ok(Math.abs(one.lo - 0.20654931437723745) < 1e-12);

  const none = wilson(0, 1);
  assert.equal(none.lo, 0);
  assert.ok(Math.abs(none.hi - 0.7934506856227626) < 1e-12);

  // A coin flipped twice, once each way, tells you almost nothing, and the
  // interval is nearly the whole line rather than a tidy 50%.
  const half = wilson(1, 2);
  assert.ok(half.hi - half.lo > 0.8, `width was ${half.hi - half.lo}`);
});

test('the interval never leaves [0, 1] and never inverts, at any count or n', () => {
  for (let n = 1; n <= 120; n++) {
    for (let c = 0; c <= n; c++) {
      const w = wilson(c, n);
      assert.ok(w.lo >= 0 && w.lo <= 1, `lo out of range at ${c}/${n}: ${w.lo}`);
      assert.ok(w.hi >= 0 && w.hi <= 1, `hi out of range at ${c}/${n}: ${w.hi}`);
      assert.ok(w.lo <= w.hi, `inverted at ${c}/${n}`);
      // The point estimate must lie inside its own interval, always.
      assert.ok(w.lo <= c / n + 1e-12 && c / n - 1e-12 <= w.hi, `p-hat outside its interval at ${c}/${n}`);
    }
  }
});

test('the interval narrows as the denominator grows at a fixed proportion', () => {
  const widths = [10, 50, 100, 500, 2000].map((n) => {
    const w = wilson(n / 2, n);
    return w.hi - w.lo;
  });
  for (let i = 1; i < widths.length; i++) {
    assert.ok(widths[i]! < widths[i - 1]!, `width did not shrink from n=${i}`);
  }
});

test('a rate with no denominator claims the whole range rather than NaN', () => {
  const w = wilson(0, 0);
  assert.equal(w.lo, 0);
  assert.equal(w.hi, 1);
  assert.ok(!Number.isNaN(w.lo) && !Number.isNaN(w.hi));
});

test('bounds are additive: attaching them moves no count and no denominator', () => {
  const r = rate(9, 31, 'cases whose correct verdict was deny');
  assert.equal(r.count, 9, 'the count is the count');
  assert.equal(r.denominator, 31, 'the denominator is the denominator');
  assert.equal(r.denominator_name, 'cases whose correct verdict was deny');
  assert.ok(Math.abs(r.lo - 0.1609580015630062) < 1e-12);
  assert.ok(Math.abs(r.hi - 0.46592329330749926) < 1e-12);
  // And the bound brackets the point estimate it was computed from.
  assert.ok(r.lo < 9 / 31 && 9 / 31 < r.hi);
});

test('every rate in a scored result carries a bound on its own denominator', () => {
  const r = score(PERFECT, TRUTH, 'fixture');
  const rates = [
    r.exact_match,
    r.wrong_approvals.rate,
    r.wrong_denials.rate,
    r.missed_escalation_paid.rate,
    r.missed_escalation_refused.rate,
    r.over_escalation.rate,
  ];
  for (const one of rates) {
    const expected = wilson(one.count, one.denominator);
    assert.equal(one.lo, expected.lo, `${one.denominator_name}: lo not computed on its own n`);
    assert.equal(one.hi, expected.hi, `${one.denominator_name}: hi not computed on its own n`);
  }
});

test('the rendered report prints the interval and names the estimator', () => {
  const r = score(PERFECT, TRUTH, 'fixture');
  const report = renderReport(r, 'Holdout seal: INTACT');
  assert.match(report, /95% CI 61\.0-100\.0/);
  assert.match(report, /Wilson score interval/);
  // The zero-successes groups must show a non-zero upper bound in the report,
  // which is the whole reason the estimator was changed.
  assert.match(report, /0\/2 cases whose correct verdict was deny \(0\.0%, 95% CI 0\.0-[1-9]/);
});

test('scoring refuses a partial run rather than shrinking the denominator', () => {
  const partial = PERFECT.filter((p) => p.case_id !== 't-deny-1');
  assert.throws(() => score(partial, TRUTH, 'fixture'), /no prediction for 1 case/);
  assert.throws(() => score(partial, TRUTH, 'fixture'), /shrinks every denominator/);
});

test('scoring refuses unknown cases, duplicate verdicts and invented verdicts', () => {
  assert.throws(() => score([...PERFECT, { case_id: 'nope', verdict: 'approve' }], TRUTH, 'x'), /unknown case/);
  assert.throws(
    () => score([...PERFECT, { case_id: 't-deny-1', verdict: 'approve' }], TRUTH, 'x'),
    /two predictions/
  );
  assert.throws(
    () => score(PERFECT.map((p) => ({ ...p, verdict: 'maybe' as Verdict })), TRUTH, 'x'),
    /not one of approve, deny, escalate/
  );
});

// --- McNemar, on paired arms ------------------------------------------------
//
// The Wilson tests above are about one rate's own uncertainty. These are about
// whether two arms differ on the same cases, which is a different question and
// is not answered by asking whether two marginal intervals overlap.

/** Correctness maps, written out so the 2x2 table under test is visible. */
function correctness(pattern: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  [...pattern].forEach((ch, i) => {
    out[`c-${i}`] = ch === '1';
  });
  return out;
}

/** b cases only the first got right, c only the second, plus concordant ones. */
function paired(b: number, c: number, bothCorrect = 0, bothWrong = 0) {
  let first = '';
  let second = '';
  for (let i = 0; i < b; i++) {
    first += '1';
    second += '0';
  }
  for (let i = 0; i < c; i++) {
    first += '0';
    second += '1';
  }
  for (let i = 0; i < bothCorrect; i++) {
    first += '1';
    second += '1';
  }
  for (let i = 0; i < bothWrong; i++) {
    first += '0';
    second += '0';
  }
  return mcnemar(correctness(first), correctness(second));
}

test('McNemar matches the closed form on a textbook 2x2', () => {
  // b = 12, c = 5. Two-sided exact = 2 * sum(C(17, i)) for i in 0..5, over
  // 2^17 = 2 * 9402 / 131072. Worked out by hand so the code cannot define its
  // own right answer.
  const m = paired(12, 5, 60, 23);
  assert.equal(m.only_first_correct, 12);
  assert.equal(m.only_second_correct, 5);
  assert.equal(m.discordant, 17);
  assert.equal(m.both_correct, 60);
  assert.equal(m.both_wrong, 23);
  assert.equal(m.n, 100);
  assert.ok(Math.abs(m.p - (2 * 9402) / 131072) < 1e-15, `p was ${m.p}`);
  assert.ok(Math.abs(m.p - 0.143463134765625) < 1e-15);
});

test('perfect agreement returns p = 1 rather than dividing by zero', () => {
  // Both arms right and wrong on exactly the same cases. There is nothing for
  // the test to look at, and p = 1 says "no evidence of a difference", which
  // is not the same claim as "no difference".
  const m = paired(0, 0, 40, 60);
  assert.equal(m.discordant, 0);
  assert.equal(m.p, 1, 'zero discordant pairs is no evidence, not certainty');
  assert.ok(Number.isFinite(m.p));
  assert.equal(m.both_correct, 40);
  assert.equal(m.both_wrong, 60);
});

test('fully discordant one way is as significant as the counts allow', () => {
  // 10 cases split them and the first arm won all 10: p = 2 * 0.5^10.
  const m = paired(10, 0);
  assert.equal(m.both_correct, 0);
  assert.equal(m.both_wrong, 0);
  assert.ok(Math.abs(m.p - 2 / 1024) < 1e-15, `p was ${m.p}`);
  assert.ok(m.p < 0.05);

  // A single discordant case cannot reach 5% however it falls, and the test
  // says so rather than being impressed by a clean sweep of one.
  assert.equal(paired(1, 0).p, 1);
  assert.equal(paired(3, 0).p, 0.25);
});

test('fully discordant but evenly split is the least significant result there is', () => {
  const m = paired(5, 5);
  assert.equal(m.discordant, 10);
  assert.equal(m.p, 1, 'doubling the central tail overshoots 1 and must be clamped');
});

test('McNemar is symmetric: swapping the arms swaps the cells and keeps p', () => {
  for (const [b, c] of [
    [12, 5],
    [0, 7],
    [3, 3],
    [30, 1],
  ] as const) {
    const forward = paired(b, c, 10, 10);
    const backward = paired(c, b, 10, 10);
    assert.equal(forward.p, backward.p, `p changed when the pair was reversed at ${b}/${c}`);
    assert.equal(forward.only_first_correct, backward.only_second_correct);
    assert.equal(forward.only_second_correct, backward.only_first_correct);
    assert.equal(forward.both_correct, backward.both_correct);
    assert.equal(forward.both_wrong, backward.both_wrong);
  }
});

test('p stays a probability across every discordant table up to 100 cases', () => {
  for (let d = 0; d <= 100; d++) {
    for (let b = 0; b <= d; b++) {
      const m = paired(b, d - b);
      assert.ok(m.p >= 0 && m.p <= 1, `p out of range at b=${b}, c=${d - b}: ${m.p}`);
      assert.ok(Number.isFinite(m.p), `p not finite at b=${b}, c=${d - b}`);
    }
  }
});

test('a more lopsided split is never less significant than a balanced one', () => {
  // Monotonicity in the discordant split, at a fixed discordant total.
  let previous = paired(10, 10).p;
  for (let b = 11; b <= 20; b++) {
    const p = paired(b, 20 - b).p;
    assert.ok(p <= previous + 1e-15, `p rose from ${previous} to ${p} at b=${b}`);
    previous = p;
  }
  assert.ok(previous < 0.001, 'a 20-0 sweep should be firmly significant');
});

test('an unpaired comparison is refused rather than compared on the overlap', () => {
  assert.throws(() => mcnemar(correctness('1100'), correctness('110')), /paired test needs the same cases/);
  assert.throws(() => mcnemar({ a: true, b: false }, { a: true, z: false }), /is not a pair/);
});

test('scoring records per-case correctness for the paired test to read', () => {
  const r = score(PERFECT, TRUTH, 'fixture');
  assert.equal(Object.keys(r.correct_by_case).length, TRUTH.length);
  assert.ok(Object.values(r.correct_by_case).every((v) => v === true));

  const oneWrong = score(
    PERFECT.map((p) => (p.case_id === 't-deny-1' ? { ...p, verdict: 'approve' as Verdict } : p)),
    TRUTH,
    'fixture'
  );
  assert.equal(oneWrong.correct_by_case['t-deny-1'], false);
  assert.equal(oneWrong.correct_by_case['t-deny-2'], true);
  // The per-case record and the headline count are the same judgement, so they
  // cannot drift: one is the sum of the other.
  assert.equal(Object.values(oneWrong.correct_by_case).filter(Boolean).length, oneWrong.exact_match.count);

  // And two results are directly pairable, which is the point of carrying it.
  const m = mcnemar(r.correct_by_case, oneWrong.correct_by_case);
  assert.equal(m.only_first_correct, 1);
  assert.equal(m.only_second_correct, 0);
  assert.equal(m.n, TRUTH.length);
});

test('a paired test can separate arms whose marginal intervals overlap', () => {
  // This is the whole reason the test is in the report. Two arms six points
  // apart on 100 cases have Wilson intervals that overlap heavily, and a
  // reader comparing the intervals would call it no difference. Paired on the
  // same cases, with every disagreement falling one way, it is not.
  const a = wilson(53, 100);
  const b = wilson(47, 100);
  assert.ok(a.lo < b.hi && b.lo < a.hi, 'the marginal intervals overlap, as expected');

  const m = paired(6, 0, 47, 47);
  assert.equal(m.n, 100);
  assert.ok(m.p < 0.05, `the paired test should still separate them, p was ${m.p}`);
});

// --- The rules have to travel with the numbers ------------------------------

test('the report renders the scoring rules and the rulebook in full', () => {
  const r = score(PERFECT, TRUTH, 'fixture');
  const report = renderReport(r, 'Holdout seal: INTACT');

  for (const rule of SCORING_RULES) {
    assert.ok(report.includes(rule.id), `report omits ${rule.id}`);
    assert.ok(report.includes(rule.title), `report omits "${rule.title}"`);
  }
  for (const rule of RULES) {
    assert.ok(report.includes(rule.id), `report omits adjudication rule ${rule.id}`);
    assert.ok(report.includes(rule.name), `report omits "${rule.name}"`);
  }
  assert.ok(report.includes('Holdout seal: INTACT'));
  assert.match(report, /No figure above blends a wrong approval with a wrong denial\./);
  assert.match(report, /WRONG APPROVALS/);
  assert.match(report, /WRONG DENIALS/);
  assert.match(report, /OVER-ESCALATION/);
});

test('the rendered rules are the rules, not a paraphrase of them', () => {
  const rendered = renderScoringRules();
  for (const rule of SCORING_RULES) assert.ok(rendered.includes(rule.title));
  const book = renderRulebook();
  for (const rule of RULES) assert.ok(book.includes(rule.name));
  // Precedence has to be visible, because several labels turn on it.
  assert.match(book, /first match wins/);
});

// --- Against the real answer key --------------------------------------------

test('scoring the shipped dev key end to end behaves', () => {
  const truth = readTruth('dev');
  const perfect = truth.entries.map((e) => ({ case_id: e.case_id, verdict: e.label }));
  const r = score(perfect, truth.entries, 'dev');
  assert.equal(r.exact_match.count, truth.entries.length);
  assert.equal(r.by_truth.approve + r.by_truth.deny + r.by_truth.escalate, truth.entries.length);

  // Approving everything is the cheapest way to look decisive, and this is what
  // it costs in the units that matter.
  const approveAll = truth.entries.map((e) => ({ case_id: e.case_id, verdict: 'approve' as Verdict }));
  const bad = score(approveAll, truth.entries, 'dev');
  assert.equal(bad.wrong_denials.rate.count, 0);
  assert.ok(bad.wrong_approvals.rupees > 0, 'approving every deniable claim has a rupee cost');
  assert.ok(bad.missed_escalation_paid.rupees > 0, 'and it also pays out every ambiguous file unreviewed');
  assert.equal(bad.wrong_approvals.rate.denominator, bad.by_truth.deny);

  // Denying everything fails policyholders instead, and the two costs are
  // reported in different places rather than cancelling out.
  const denyAll = truth.entries.map((e) => ({ case_id: e.case_id, verdict: 'deny' as Verdict }));
  const worse = score(denyAll, truth.entries, 'dev');
  assert.equal(worse.wrong_approvals.rupees, 0);
  assert.ok(worse.wrong_denials.rupees > 0);
  assert.equal(worse.wrong_denials.rate.denominator, worse.by_truth.approve);
});

test('per-trap breakdown covers every trap in the split exactly once', () => {
  const truth = readTruth('dev');
  const perfect = truth.entries.map((e) => ({ case_id: e.case_id, verdict: e.label }));
  const r = score(perfect, truth.entries, 'dev');
  const seen = new Set(r.by_trap.map((t) => t.trap));
  assert.equal(seen.size, r.by_trap.length);
  assert.equal(
    r.by_trap.reduce((sum, t) => sum + t.total, 0),
    truth.entries.length
  );
});

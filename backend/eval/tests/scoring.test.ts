import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCORING_RULES,
  blendedCost,
  rateText,
  renderReport,
  renderScoringRules,
  score,
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
  assert.equal(rateText(r.exact_match), '6/6 cases in the split (100.0%)');
  assert.match(rateText(r.wrong_approvals.rate), /cases whose correct verdict was deny/);
  assert.equal(rateText({ count: 0, denominator: 0, denominator_name: 'nothing' }), '0/0 nothing (n/a)');
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

/**
 * The adjudication rulebook the labels were derived from.
 *
 * Every label in `ground-truth.json` is the output of `deriveVerdict` applied
 * to that case's recorded facts. Nothing was labelled by taste. Two
 * consequences worth being explicit about:
 *
 *   1. Disagreeing with a label means disagreeing with a rule, which is an
 *      argument that can be had in the open before any system is measured.
 *   2. Precedence is part of the rulebook, not an accident of ordering. A
 *      claim on a lapsed policy that also has a contradicted estimate is a
 *      denial, because R1 fires before R4. Several cases exist only to make
 *      that ordering observable.
 *
 * The rulebook is versioned. Changing it changes the answer key, which is the
 * one edit the holdout seal exists to make loud.
 */
import type { CaseFacts, Verdict } from './types.js';

export const RULEBOOK_VERSION = '1.0.0';

export interface Rule {
  id: string;
  name: string;
  verdict: Verdict;
  /** What has to be true of the facts for this rule to fire. */
  when: (f: CaseFacts) => boolean;
  text: string;
}

/**
 * Precedence order. The first rule whose condition holds decides the case.
 */
export const RULES: readonly Rule[] = Object.freeze([
  {
    id: 'R1',
    name: 'policy-not-in-force',
    verdict: 'deny',
    when: (f) => !f.in_force,
    text:
      'If the policy was not in force on the incident date — the incident falls outside ' +
      'start_date..end_date, or the policy was cancelled — the claim is denied. This is ' +
      'checked first, so a lapsed policy is a denial even when the evidence is also bad.',
  },
  {
    id: 'R2',
    name: 'exclusion-applies',
    verdict: 'deny',
    when: (f) => f.exclusion_applies,
    text:
      'If a written exclusion in the policy covers the incident as described, the claim is ' +
      'denied and the clause is named. An exclusion that is merely adjacent to the incident ' +
      'does not fire this rule.',
  },
  {
    id: 'R3',
    name: 'nothing-payable-after-deductible',
    verdict: 'deny',
    when: (f) => f.deductible_swallows_claim,
    text:
      'If the claimed amount is at or below the deductible, nothing is payable and the claim ' +
      'is denied. The policyholder is owed the arithmetic, not a cheque for zero.',
  },
  {
    id: 'R4',
    name: 'evidence-contradicts-claim',
    verdict: 'escalate',
    when: (f) => f.evidence_contradiction,
    text:
      'If an uploaded document disagrees with the claim — a repair estimate whose total is not ' +
      'the claimed amount, a police report whose date of occurrence is not the declared ' +
      'incident date — the claim is escalated. It is not a denial: the claimant may simply ' +
      'have mis-stated a figure, and the system does not get to assume fraud.',
  },
  {
    id: 'R5',
    name: 'duplicate-filing',
    verdict: 'escalate',
    when: (f) => f.duplicate_filing,
    text:
      'If the same incident already appears on file under another claim number, the claim is ' +
      'escalated rather than paid or refused. Two filings for one event are usually a mistake ' +
      'and occasionally not, and a machine cannot tell which from the record alone.',
  },
  {
    id: 'R6',
    name: 'over-coverage-limit',
    verdict: 'escalate',
    when: (f) => f.over_coverage_limit,
    text:
      'If the claimed amount exceeds the coverage limit, the claim is escalated. Any payment ' +
      'has to be capped at the limit and the claimant has to be told why they are receiving ' +
      'less than they asked for, and that conversation belongs to a human.',
  },
  {
    id: 'R7',
    name: 'evidence-insufficient',
    verdict: 'escalate',
    when: (f) => f.evidence_insufficient,
    text:
      'If the evidence on file does not settle the question either way, the claim is escalated. ' +
      'This is the honest answer to an ambiguous case, and the dataset contains cases whose ' +
      'correct label is exactly this — a system that never escalates is not thereby better.',
  },
  {
    id: 'R8',
    name: 'clean-approval',
    verdict: 'approve',
    when: () => true,
    text:
      'Otherwise — in force, no exclusion, above the deductible, within the limit, evidence ' +
      'consistent, nothing duplicated — the claim is approved. Roughly two fifths of the set ' +
      'reaches this rule, because a set made entirely of traps measures nothing.',
  },
]);

export interface Derivation {
  verdict: Verdict;
  rule: string;
}

/** Apply the rulebook in precedence order. */
export function deriveVerdict(facts: CaseFacts): Derivation {
  for (const rule of RULES) {
    if (rule.when(facts)) return { verdict: rule.verdict, rule: rule.id };
  }
  /* istanbul ignore next — R8 is unconditional. */
  throw new Error('deriveVerdict: no rule fired, which R8 makes impossible');
}

/** The rulebook as text, for embedding in a report. */
export function renderRulebook(): string {
  const lines = [
    `Adjudication rulebook v${RULEBOOK_VERSION} — applied in order, first match wins.`,
    '',
  ];
  for (const rule of RULES) {
    lines.push(`  ${rule.id}  ${rule.name} -> ${rule.verdict}`);
    for (const chunk of wrap(rule.text, 84)) lines.push(`      ${chunk}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    if (line.length === 0) line = w;
    else if (line.length + 1 + w.length <= width) line += ` ${w}`;
    else {
      out.push(line);
      line = w;
    }
  }
  if (line.length > 0) out.push(line);
  return out;
}

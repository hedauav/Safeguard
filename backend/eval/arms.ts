/**
 * The four arms.
 *
 *   A  deterministic rules only, no model            the floor
 *   B  model only, no rules layer, no veto           the ceiling nobody should ship
 *   C  rules + model                                 what actually ships
 *   D  random verdicts matching C's predicted mix    the control
 *
 * Arm D is the one that stops the report flattering itself. A system that
 * approves 60% of a set where 41% should be approved will look competent on
 * accuracy for arithmetic reasons that have nothing to do with judgement. D
 * draws the same multiset of verdicts as C and attaches them to the wrong
 * cases, so any margin C holds over D is the part of C's score that came from
 * reading the case rather than from the shape of its output distribution. If C
 * cannot beat D, C is producing volume, not judgement, and the report says so.
 *
 * Arms B and C never call a model. They are handed a completion that the
 * runner fetched once and shared. In arm C the deterministic layer runs first
 * and can veto, and a vetoed case simply never reads its completion — the
 * asymmetry is real and the report states it as "model consulted: N of M"
 * rather than hiding it behind an average.
 */
import { parseModelVerdict } from '../src/services/adjudication-service.js';
import { runDeterministicChecks } from '../src/services/adjudication-rules.js';
import type { AdaptedCase } from './adapter.js';
import type { CompletionEntry } from './model-client.js';
import { Rng } from './rng.js';
import type { Prediction } from './scoring.js';
import type { Verdict } from './types.js';

export type ArmName = 'A' | 'B' | 'C' | 'D';

export const ARM_TITLES: Record<ArmName, string> = {
  A: 'Deterministic rules only (no model)',
  B: 'Model only (no rules layer, no veto)',
  C: 'Rules + model (what ships)',
  D: 'Random verdicts matching C (control)',
};

/** Largest gap tolerated between the model's figure and the computed one. */
export const AMOUNT_AGREEMENT_EPSILON = 0.01;

/**
 * Why a case ended where it did. Kept apart from the verdict so a report can
 * say how many escalations were the model's judgement and how many were the
 * network's, which is the difference between a cautious system and a broken one.
 */
export type OutcomeSource =
  | 'rules_veto'
  | 'rules_no_objection'
  | 'model'
  | 'model_amount_disagreement'
  | 'parse_failure'
  | 'api_failure'
  | 'random';

export interface ArmOutcome {
  case_id: string;
  verdict: Verdict;
  source: OutcomeSource;
  /** The deterministic check that forced the verdict, when one did. */
  vetoed_by: string | null;
  /** False in arm C for every vetoed case; always true in arm B. */
  model_consulted: boolean;
  /** The model's own verdict before any veto or forcing, when it gave one. */
  model_verdict: Verdict | null;
  model_confidence: number | null;
  model_proposed_amount: number | null;
  /** Computed in code. Null in arm B, which has no rules layer to compute it. */
  computed_payable: number | null;
  detail: string | null;
}

// ---------------------------------------------------------------------------
// Arm A — deterministic rules only
// ---------------------------------------------------------------------------

/**
 * The nine shipped checks and nothing else.
 *
 * When no check objects, arm A approves. That is the honest reading of a
 * rules-only system: every check that could refuse has run and none of them
 * refused, so there is nothing left holding the claim up. It is also the same
 * shape as R8 in the answer key's own rulebook, which approves exactly when no
 * earlier rule fired. Arm A cannot escalate for ambiguity, because arithmetic
 * over dates and amounts has no way to notice that a document is ambiguous —
 * that limit is the point of measuring the floor rather than assuming it.
 */
export function armA(adapted: AdaptedCase, caseId: string): ArmOutcome {
  const deterministic = runDeterministicChecks(adapted.facts);
  if (deterministic.veto) {
    return {
      case_id: caseId,
      verdict: deterministic.veto.vetoes ?? 'escalate',
      source: 'rules_veto',
      vetoed_by: deterministic.veto.id,
      model_consulted: false,
      model_verdict: null,
      model_confidence: null,
      model_proposed_amount: null,
      computed_payable: deterministic.payableAmount,
      detail: deterministic.veto.detail,
    };
  }
  return {
    case_id: caseId,
    verdict: 'approve',
    source: 'rules_no_objection',
    vetoed_by: null,
    model_consulted: false,
    model_verdict: null,
    model_confidence: null,
    model_proposed_amount: null,
    computed_payable: deterministic.payableAmount,
    detail: 'All nine deterministic checks passed and nothing objected.',
  };
}

// ---------------------------------------------------------------------------
// Reading one completion
// ---------------------------------------------------------------------------

interface ModelRead {
  verdict: Verdict | null;
  source: 'model' | 'parse_failure' | 'api_failure';
  confidence: number | null;
  proposed_amount: number | null;
  detail: string;
}

/**
 * Turn one cached completion into a verdict, or say why it is not one.
 *
 * A failed call and an unreadable answer both become `escalate`, which is what
 * the shipping service does, and both are recorded as what they are. Neither
 * may be counted as the model having judged the case: an arm whose escalations
 * are a third rate limits is not a cautious arm.
 */
export function readCompletion(entry: CompletionEntry | null | undefined): ModelRead {
  if (!entry || !entry.ok || entry.text === null) {
    return {
      verdict: null,
      source: 'api_failure',
      confidence: null,
      proposed_amount: null,
      detail: entry?.error ?? 'No completion was recorded for this case.',
    };
  }

  const parse = parseModelVerdict(entry.text);
  if (!parse.ok) {
    return {
      verdict: null,
      source: 'parse_failure',
      confidence: null,
      proposed_amount: null,
      detail: parse.failure,
    };
  }

  return {
    verdict: parse.verdict.verdict,
    source: 'model',
    confidence: parse.verdict.confidence,
    proposed_amount: parse.verdict.proposed_amount,
    detail: parse.verdict.inconsistencies.slice(0, 2).join('; ') || 'no inconsistencies reported',
  };
}

// ---------------------------------------------------------------------------
// Arm B — model only
// ---------------------------------------------------------------------------

/**
 * The model's answer, taken as the verdict.
 *
 * No veto, no arithmetic cross-check, no forcing. In particular the amount
 * disagreement check does NOT run here: it compares the model's figure against
 * one the rules layer computed, and arm B has no rules layer. Importing that
 * check into arm B would be importing part of arm C into the arm that exists
 * to show what the rules layer is worth.
 */
export function armB(caseId: string, entry: CompletionEntry | null | undefined): ArmOutcome {
  const read = readCompletion(entry);
  return {
    case_id: caseId,
    verdict: read.verdict ?? 'escalate',
    source: read.source,
    vetoed_by: null,
    model_consulted: true,
    model_verdict: read.verdict,
    model_confidence: read.confidence,
    model_proposed_amount: read.proposed_amount,
    computed_payable: null,
    detail: read.detail,
  };
}

// ---------------------------------------------------------------------------
// Arm C — rules + model, as shipped
// ---------------------------------------------------------------------------

/**
 * The shipping pipeline: deterministic checks first, model only if they let
 * the case through, and a forced escalation when the model's arithmetic
 * disagrees with the arithmetic computed in code.
 *
 * The order matters and is not an implementation detail. A claim on a policy
 * that had lapsed on the incident date is refused by date comparison, and no
 * model is asked. That is why arm C's "model consulted" count is lower than
 * arm B's, and why a token cost for arm C that quietly used arm B's call count
 * would overstate what shipping this actually costs.
 */
export function armC(
  adapted: AdaptedCase,
  caseId: string,
  entry: CompletionEntry | null | undefined
): ArmOutcome {
  const deterministic = runDeterministicChecks(adapted.facts);
  const payable = deterministic.payableAmount;

  if (deterministic.veto) {
    return {
      case_id: caseId,
      verdict: deterministic.veto.vetoes ?? 'escalate',
      source: 'rules_veto',
      vetoed_by: deterministic.veto.id,
      // The completion for this case exists and was paid for; arm C did not
      // read it. Saying so is what keeps the cost table honest.
      model_consulted: false,
      model_verdict: null,
      model_confidence: null,
      model_proposed_amount: null,
      computed_payable: payable,
      detail: deterministic.veto.detail,
    };
  }

  const read = readCompletion(entry);
  if (read.verdict === null) {
    return {
      case_id: caseId,
      verdict: 'escalate',
      source: read.source,
      vetoed_by: null,
      model_consulted: true,
      model_verdict: null,
      model_confidence: null,
      model_proposed_amount: null,
      computed_payable: payable,
      detail: read.detail,
    };
  }

  if (
    read.proposed_amount !== null &&
    Math.abs(read.proposed_amount - payable) > AMOUNT_AGREEMENT_EPSILON
  ) {
    return {
      case_id: caseId,
      verdict: 'escalate',
      source: 'model_amount_disagreement',
      vetoed_by: null,
      model_consulted: true,
      model_verdict: read.verdict,
      model_confidence: read.confidence,
      model_proposed_amount: read.proposed_amount,
      computed_payable: payable,
      detail: `The model calculated ${read.proposed_amount.toFixed(2)} payable against ${payable.toFixed(2)} computed in code.`,
    };
  }

  return {
    case_id: caseId,
    verdict: read.verdict,
    source: 'model',
    vetoed_by: null,
    model_consulted: true,
    model_verdict: read.verdict,
    model_confidence: read.confidence,
    model_proposed_amount: read.proposed_amount,
    computed_payable: payable,
    detail: read.detail,
  };
}

// ---------------------------------------------------------------------------
// Arm D — the control
// ---------------------------------------------------------------------------

/**
 * The seed arm D draws from.
 *
 * Deliberately neither of the dataset seeds. A control drawn from the seed
 * that generated the cases is a control correlated with the cases, and the
 * correlation would be invisible in the output.
 */
export const ARM_D_SEED = 8811704;

/**
 * C's own verdicts, shuffled onto the wrong cases.
 *
 * Not an i.i.d. draw from C's distribution — a permutation of C's exact
 * multiset. The two are close in expectation and different in what they prove:
 * a permutation matches C's approve rate, deny rate and escalate rate exactly,
 * with no sampling error to argue about afterwards. Whatever C scores above D
 * is therefore attributable to which case got which verdict, and to nothing
 * about how often it says each word.
 */
export function armD(
  caseIds: readonly string[],
  cVerdicts: readonly Verdict[],
  seed = ARM_D_SEED
): Prediction[] {
  if (caseIds.length !== cVerdicts.length) {
    throw new Error(
      `armD: ${caseIds.length} cases but ${cVerdicts.length} verdicts to draw from. The control ` +
        "must match arm C's predicted mix exactly or it is not the control it claims to be."
    );
  }
  const pool = new Rng(seed).shuffle([...cVerdicts]);
  return caseIds.map((case_id, index) => ({ case_id, verdict: pool[index]! }));
}

// ---------------------------------------------------------------------------
// k-repeat
// ---------------------------------------------------------------------------

export interface MajorityResult {
  verdict: Verdict;
  counts: Record<Verdict, number>;
  /** True when every run gave the same verdict. */
  unanimous: boolean;
  /** True when no single verdict held a strict plurality. */
  tied: boolean;
}

/**
 * Majority of k, with the tie-break written down.
 *
 * With k=5 and three verdicts a tie is reachable — 2 approve, 2 deny, 1
 * escalate. The tie-break is `escalate`, because a system that cannot agree
 * with itself about a case has described that case accurately: it is one a
 * human should look at. This biases majority-of-k towards escalation relative
 * to a single draw, which is a real effect and is why the report counts ties
 * separately rather than folding them into the majority score and leaving the
 * reader to wonder where the extra escalations came from.
 */
export function majorityVerdict(verdicts: readonly Verdict[]): MajorityResult {
  if (verdicts.length === 0) throw new Error('majorityVerdict: no runs to vote over');
  const counts: Record<Verdict, number> = { approve: 0, deny: 0, escalate: 0 };
  for (const v of verdicts) counts[v]++;

  const best = Math.max(counts.approve, counts.deny, counts.escalate);
  const leaders = (['approve', 'deny', 'escalate'] as const).filter((v) => counts[v] === best);
  const unanimous = leaders.length === 1 && counts[leaders[0]!] === verdicts.length;
  const tied = leaders.length > 1;

  return { verdict: tied ? 'escalate' : leaders[0]!, counts, unanimous, tied };
}

export interface AgreementReport {
  /** Cases where all k runs returned a readable verdict. */
  measurable: number;
  /** Of those, cases where all k runs returned the SAME verdict. */
  unanimous: number;
  /** Of those, cases where the majority was a tie. */
  tied: number;
  /** Cases excluded because at least one run did not return a readable verdict. */
  excluded: number;
  /** Case ids where the k runs disagreed, worst first. */
  unstable: Array<{ case_id: string; counts: Record<Verdict, number> }>;
}

/**
 * Per-case agreement across the k runs.
 *
 * Measured only over cases where every run produced a readable verdict. A case
 * whose third run was rate-limited into an escalation is not a case that agreed
 * with itself four times out of five — it is a case the harness could not
 * measure, and it is reported as excluded rather than counted as stable.
 */
export function agreement(perCase: ReadonlyMap<string, Array<Verdict | null>>): AgreementReport {
  let measurable = 0;
  let unanimous = 0;
  let tied = 0;
  let excluded = 0;
  const unstable: Array<{ case_id: string; counts: Record<Verdict, number> }> = [];

  for (const [case_id, verdicts] of perCase) {
    if (verdicts.length === 0 || verdicts.some((v) => v === null)) {
      excluded++;
      continue;
    }
    measurable++;
    const result = majorityVerdict(verdicts as Verdict[]);
    if (result.unanimous) unanimous++;
    else unstable.push({ case_id, counts: result.counts });
    if (result.tied) tied++;
  }

  unstable.sort((a, b) => {
    const spread = (c: Record<Verdict, number>) => Math.max(c.approve, c.deny, c.escalate);
    return spread(a.counts) - spread(b.counts) || a.case_id.localeCompare(b.case_id);
  });

  return { measurable, unanimous, tied, excluded, unstable };
}

export function toPredictions(outcomes: readonly ArmOutcome[]): Prediction[] {
  return outcomes.map((o) => ({ case_id: o.case_id, verdict: o.verdict }));
}

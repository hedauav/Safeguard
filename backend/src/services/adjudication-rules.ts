import { computeSettlement } from './settlement-service.js';
import { toAmount } from './money.js';

/**
 * The deterministic half of claim adjudication.
 *
 * Pure and synchronous on purpose. Everything in this file is arithmetic and
 * date comparison over facts already fetched, so it can be exercised without a
 * database, without a network, and without a model — and so that the answers a
 * reviewer most needs to trust are the answers no model participated in.
 *
 * Two properties matter more than the rules themselves:
 *
 *  1. These run FIRST. A veto short-circuits before the model is called, which
 *     is cheaper, stricter, and means a claim on a policy that had lapsed on
 *     the incident date is refused by arithmetic rather than by a model
 *     behaving well that afternoon.
 *
 *  2. The payable figure is computed HERE, from the claim and the policy. It
 *     is not something a model proposes and we accept. computePayableAmount
 *     delegates to computeSettlement so the figure a recommendation carries is
 *     the same figure the settlement path would actually disburse — two
 *     implementations of one rule is how they drift apart.
 */

/** The only verdicts that exist. Anything else is a bug, not a new outcome. */
export type AdjudicationVerdict = 'approve' | 'deny' | 'escalate';

export const ADJUDICATION_VERDICTS: readonly AdjudicationVerdict[] = [
  'approve',
  'deny',
  'escalate',
] as const;

export function isAdjudicationVerdict(value: unknown): value is AdjudicationVerdict {
  return (ADJUDICATION_VERDICTS as readonly string[]).includes(value as string);
}

/**
 * Two claims for the same incident rarely arrive on the same date — a claimant
 * who calls back on Monday about Friday's collision is describing one event.
 * Seven days is wide enough to catch that and narrow enough that two genuine
 * incidents a fortnight apart do not collide.
 */
export const DUPLICATE_INCIDENT_WINDOW_DAYS = 7;

/**
 * Which claim types each kind of policy covers.
 *
 * A schedule, not a guess: `claims.claim_type` (collision, water_damage,
 * medical, ...) and `policies.policy_type` (auto, home, health, life) are
 * separate vocabularies with nothing in the schema joining them, so the join
 * has to be stated somewhere. Stated here, in code, where it is reviewable and
 * testable, rather than left to a model to infer from the words.
 *
 * A policy may widen its own schedule through
 * `coverage_details.covered_claim_types`, which is how an endorsement is
 * expressed. Nothing may narrow it here — a denial on the strength of an
 * omission from this table would be a denial on the strength of a typo.
 */
export const COVERED_CLAIM_TYPES: Record<string, readonly string[]> = {
  auto: ['collision', 'windshield', 'theft', 'comprehensive', 'vandalism', 'auto', 'general'],
  home: ['water_damage', 'fire_damage', 'theft', 'storm_damage', 'vandalism', 'home', 'general'],
  health: ['medical', 'hospitalisation', 'hospitalization', 'prescription', 'health', 'general'],
  life: ['death', 'terminal_illness', 'life'],
};

/** Statuses meaning a human has already decided this claim, or it is paid. */
const ALREADY_DECIDED_STATUSES = new Set(['approved', 'denied', 'paid', 'closed']);

/** A prior claim in one of these states is settled history, not a duplicate. */
const SPENT_CLAIM_STATUSES = new Set(['denied', 'closed']);

/** Every deterministic check, in the order they run. */
export type RuleId =
  | 'policy_on_file'
  | 'policy_not_cancelled'
  | 'policy_in_force_on_incident_date'
  | 'claim_type_covered'
  | 'claimed_amount_stated'
  | 'claimed_amount_within_coverage'
  | 'claim_not_already_decided'
  | 'no_near_duplicate_claim'
  | 'something_payable';

export interface RuleOutcome {
  id: RuleId;
  /** One line a reviewer can read without opening this file. */
  detail: string;
  passed: boolean;
  /**
   * The verdict this failure forces, or null when the check passed. `deny` is
   * reserved for failures that are matters of record — the policy term did not
   * cover the date, the deductible exceeds the claim. Everything ambiguous
   * escalates, because an automated denial on a guess costs a claimant more
   * than an automated escalation costs us.
   */
  vetoes: AdjudicationVerdict | null;
}

export interface PolicyFacts {
  policy_number: string;
  policy_type: string | null;
  status: string | null;
  coverage_amount: unknown;
  deductible: unknown;
  start_date: string | null;
  end_date: string | null;
  coverage_details: Record<string, unknown> | null;
}

export interface ClaimFacts {
  id: string;
  claim_number: string;
  claim_type: string | null;
  status: string | null;
  incident_date: string | null;
  claimed_amount: unknown;
  incident_description: string | null;
}

/** Another claim on the same policy, for the near-duplicate check. */
export interface SiblingClaim {
  id: string;
  claim_number: string;
  claim_type: string | null;
  status: string | null;
  incident_date: string | null;
}

export interface AdjudicationFacts {
  claim: ClaimFacts;
  /** Null when no policy row could be read. Never assumed to be in force. */
  policy: PolicyFacts | null;
  /** Every other claim on the same policy. May include the claim itself. */
  siblingClaims: SiblingClaim[];
}

/** True only for a value that is genuinely a number, not merely coercible. */
function isStatedAmount(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(parsed) && parsed > 0;
}

/**
 * A DATE column arrives as 'YYYY-MM-DD'; a TIMESTAMPTZ arrives with a time.
 * Reduced to the date part so comparisons never depend on the server's zone —
 * a claim filed at 23:00 IST must not read as the following day in UTC.
 * Returns null for anything that is not a calendar date, so an unparseable
 * value escalates rather than silently comparing as the epoch.
 */
export function toDateOnly(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const timestamp = Date.parse(`${year}-${month}-${day}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return null;
  // Round-trip so 2026-02-30 is rejected rather than rolling into March.
  const normalised = new Date(timestamp).toISOString().slice(0, 10);
  return normalised === `${year}-${month}-${day}` ? normalised : null;
}

/** Whole days between two 'YYYY-MM-DD' values, or null if either is unusable. */
export function daysBetween(a: string | null, b: string | null): number | null {
  const left = toDateOnly(a);
  const right = toDateOnly(b);
  if (!left || !right) return null;
  const ms = Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`);
  return Math.round(Math.abs(ms) / 86_400_000);
}

/**
 * The payable figure, and the only one with any authority.
 *
 * max(0, min(claimed, coverage) - deductible), by way of the settlement path's
 * own implementation so the recommendation and the eventual disbursement can
 * never disagree. No caller may substitute a number from anywhere else.
 */
export function computePayableAmount(input: {
  claimedAmount: unknown;
  coverageAmount: unknown;
  deductible: unknown;
}): number {
  return computeSettlement(input);
}

/**
 * The claim types a policy covers: its schedule, widened by any endorsement
 * recorded in coverage_details. Returns null when the policy type is one we
 * hold no schedule for — "unknown" is not "not covered".
 */
export function coveredClaimTypes(policy: PolicyFacts): string[] | null {
  const scheduled = COVERED_CLAIM_TYPES[(policy.policy_type ?? '').toLowerCase()];

  const endorsed = policy.coverage_details?.['covered_claim_types'];
  const extra = Array.isArray(endorsed)
    ? endorsed.filter((entry): entry is string => typeof entry === 'string')
    : [];

  if (!scheduled && extra.length === 0) return null;
  return [...(scheduled ?? []), ...extra].map((entry) => entry.toLowerCase());
}

function pass(id: RuleId, detail: string): RuleOutcome {
  return { id, detail, passed: true, vetoes: null };
}

function fail(id: RuleId, detail: string, vetoes: AdjudicationVerdict): RuleOutcome {
  return { id, detail, passed: false, vetoes };
}

export interface DeterministicResult {
  /** Every check that ran, in order, passed or not. The audit trail. */
  checks: RuleOutcome[];
  /**
   * The first failing check, or null when all passed. Only the first is acted
   * on: once the policy did not cover the incident date, whether the amount is
   * within a limit that never applied is not a finding worth reporting.
   */
  veto: RuleOutcome | null;
  /** Computed regardless of the outcome, so a refusal still shows its working. */
  payableAmount: number;
}

/**
 * Run every deterministic check over already-fetched facts.
 *
 * Never throws, never awaits, never reads anything it was not handed.
 */
export function runDeterministicChecks(facts: AdjudicationFacts): DeterministicResult {
  const { claim, policy, siblingClaims } = facts;
  const checks: RuleOutcome[] = [];

  const payableAmount = policy
    ? computePayableAmount({
        claimedAmount: claim.claimed_amount,
        coverageAmount: policy.coverage_amount,
        deductible: policy.deductible,
      })
    : 0;

  // --- 1. There is a policy to adjudicate against -------------------------
  if (!policy) {
    checks.push(
      fail(
        'policy_on_file',
        `No policy row could be read for claim ${claim.claim_number}, so there is nothing to check the claim against.`,
        // Escalate rather than deny: a missing row is far more likely to be our
        // problem than the claimant's.
        'escalate'
      )
    );
    return { checks, veto: checks[0], payableAmount };
  }
  checks.push(pass('policy_on_file', `Policy ${policy.policy_number} is on file.`));

  // --- 2. The policy was not cancelled ------------------------------------
  // A cancelled policy was deliberately terminated — for non-payment, fraud, or
  // at the customer's request. Unlike a lapse, it is not undone by the incident
  // having happened during the term.
  if ((policy.status ?? '').toLowerCase() === 'cancelled') {
    checks.push(
      fail(
        'policy_not_cancelled',
        `Policy ${policy.policy_number} was cancelled, so no claim can be paid against it.`,
        'deny'
      )
    );
    return { checks, veto: checks[checks.length - 1], payableAmount };
  }
  checks.push(pass('policy_not_cancelled', `Policy ${policy.policy_number} is not cancelled.`));

  // --- 3. The policy term covered the incident date -----------------------
  // The question is the date, not today's status. A policy that has since
  // expired still covers an incident that happened inside its term, and
  // treating 'expired' as an automatic denial would deny every late-filed
  // claim that is in fact perfectly good.
  const incidentDate = toDateOnly(claim.incident_date);
  const startDate = toDateOnly(policy.start_date);
  const endDate = toDateOnly(policy.end_date);

  if (!incidentDate || !startDate || !endDate) {
    checks.push(
      fail(
        'policy_in_force_on_incident_date',
        `Cannot compare dates for claim ${claim.claim_number}: incident ${claim.incident_date ?? 'unset'}, policy term ${policy.start_date ?? 'unset'} to ${policy.end_date ?? 'unset'}.`,
        'escalate'
      )
    );
    return { checks, veto: checks[checks.length - 1], payableAmount };
  }

  if (incidentDate < startDate || incidentDate > endDate) {
    checks.push(
      fail(
        'policy_in_force_on_incident_date',
        `The incident on ${incidentDate} falls outside the term of policy ${policy.policy_number} (${startDate} to ${endDate}).`,
        'deny'
      )
    );
    return { checks, veto: checks[checks.length - 1], payableAmount };
  }
  checks.push(
    pass(
      'policy_in_force_on_incident_date',
      `The incident on ${incidentDate} falls inside the term of policy ${policy.policy_number} (${startDate} to ${endDate}).`
    )
  );

  // --- 4. The claim type is within the cover ------------------------------
  const claimType = (claim.claim_type ?? '').toLowerCase();
  const covered = coveredClaimTypes(policy);

  if (!covered) {
    checks.push(
      fail(
        'claim_type_covered',
        `No coverage schedule is held for a policy of type ${policy.policy_type ?? 'unset'}, so whether ${claimType || 'this claim type'} is covered cannot be decided in code.`,
        'escalate'
      )
    );
    return { checks, veto: checks[checks.length - 1], payableAmount };
  }

  if (!claimType || !covered.includes(claimType)) {
    checks.push(
      fail(
        'claim_type_covered',
        `A ${claimType || 'blank'} claim is not within the cover of a ${policy.policy_type} policy (${covered.join(', ')}).`,
        'deny'
      )
    );
    return { checks, veto: checks[checks.length - 1], payableAmount };
  }
  checks.push(
    pass('claim_type_covered', `A ${claimType} claim is within the cover of policy ${policy.policy_number}.`)
  );

  // --- 5. There is an amount to assess ------------------------------------
  if (!isStatedAmount(claim.claimed_amount)) {
    checks.push(
      fail(
        'claimed_amount_stated',
        `Claim ${claim.claim_number} states no claimed amount, so there is nothing to assess.`,
        'escalate'
      )
    );
    return { checks, veto: checks[checks.length - 1], payableAmount };
  }
  checks.push(
    pass('claimed_amount_stated', `Claim ${claim.claim_number} states ${toAmount(claim.claimed_amount).toFixed(2)}.`)
  );

  // --- 6. The amount is within the policy limit ---------------------------
  // Escalate rather than deny. The settlement rule caps the payout at the
  // coverage anyway, so nothing is at risk of overpayment; what a claim above
  // the limit needs is somebody telling the claimant, which is a conversation
  // and not a denial.
  const claimed = toAmount(claim.claimed_amount);
  const coverage = toAmount(policy.coverage_amount);
  if (claimed > coverage) {
    checks.push(
      fail(
        'claimed_amount_within_coverage',
        `The claimed ${claimed.toFixed(2)} exceeds the ${coverage.toFixed(2)} coverage on policy ${policy.policy_number}.`,
        'escalate'
      )
    );
    return { checks, veto: checks[checks.length - 1], payableAmount };
  }
  checks.push(
    pass(
      'claimed_amount_within_coverage',
      `The claimed ${claimed.toFixed(2)} is within the ${coverage.toFixed(2)} coverage on policy ${policy.policy_number}.`
    )
  );

  // --- 7. Nobody has decided this claim already ---------------------------
  const claimStatus = (claim.status ?? '').toLowerCase();
  if (ALREADY_DECIDED_STATUSES.has(claimStatus)) {
    checks.push(
      fail(
        'claim_not_already_decided',
        `Claim ${claim.claim_number} is already ${claimStatus}. A recommendation now could only invite somebody to decide it a second time.`,
        'escalate'
      )
    );
    return { checks, veto: checks[checks.length - 1], payableAmount };
  }
  checks.push(pass('claim_not_already_decided', `Claim ${claim.claim_number} is ${claimStatus || 'unset'} and undecided.`));

  // --- 8. No near-duplicate claim for the same incident -------------------
  const duplicate = siblingClaims.find((sibling) => {
    if (sibling.id === claim.id) return false;
    if (SPENT_CLAIM_STATUSES.has((sibling.status ?? '').toLowerCase())) return false;
    if ((sibling.claim_type ?? '').toLowerCase() !== claimType) return false;
    const gap = daysBetween(sibling.incident_date, claim.incident_date);
    return gap !== null && gap <= DUPLICATE_INCIDENT_WINDOW_DAYS;
  });

  if (duplicate) {
    checks.push(
      fail(
        'no_near_duplicate_claim',
        `Claim ${duplicate.claim_number} on the same policy is also a ${claimType} claim dated ${duplicate.incident_date ?? 'unknown'}, within ${DUPLICATE_INCIDENT_WINDOW_DAYS} days of this one. These may be the same incident claimed twice.`,
        'escalate'
      )
    );
    return { checks, veto: checks[checks.length - 1], payableAmount };
  }
  checks.push(
    pass('no_near_duplicate_claim', `No other open ${claimType} claim on this policy falls within ${DUPLICATE_INCIDENT_WINDOW_DAYS} days of ${incidentDate}.`)
  );

  // --- 9. Something is left after the deductible --------------------------
  if (payableAmount <= 0) {
    checks.push(
      fail(
        'something_payable',
        `Once the ${toAmount(policy.deductible).toFixed(2)} deductible is applied to claim ${claim.claim_number}, nothing is payable.`,
        'deny'
      )
    );
    return { checks, veto: checks[checks.length - 1], payableAmount };
  }
  checks.push(
    pass('something_payable', `${payableAmount.toFixed(2)} is payable after the deductible.`)
  );

  return { checks, veto: null, payableAmount };
}

/**
 * Shapes for the labelled adjudication evaluation set.
 *
 * These are fixtures, not database rows. They mirror the columns in
 * `backend/database/run-all.sql` closely enough that a case can be read by
 * anyone who knows the schema, but nothing here is ever written to Supabase
 * and no id in here collides with the live dataset's reserved number ranges.
 *
 * Money is in Indian rupees, as whole rupees. Every amount a report prints
 * comes from the case's own fields, never from a constant in the scorer.
 */

/** The only three verdicts an adjudication may return. */
export type Verdict = 'approve' | 'deny' | 'escalate';

/** Claim types the agent knows how to file — `getDefaultDocuments` in
 *  `backend/src/services/claims-service.ts` is the authority on this list. */
export type ClaimType =
  | 'collision'
  | 'windshield'
  | 'theft'
  | 'water_damage'
  | 'fire_damage'
  | 'medical'
  | 'comprehensive';

export type PolicyType = 'auto' | 'home' | 'health';

export type PolicyStatus = 'active' | 'expired' | 'cancelled' | 'pending';

/**
 * What kind of trap a case is. Kept out of `cases.json` on purpose: a case
 * file that announces "this one is the boundary case" is a case file that can
 * be adjudicated without reading the policy.
 */
export type TrapCategory =
  // --- labelled `approve` -------------------------------------------------
  | 'straightforward_approve'
  | 'documents_complete_approve'
  | 'limit_boundary_under'
  | 'policy_lapsed_after'
  | 'exclusion_near_miss'
  // --- labelled `deny` ----------------------------------------------------
  | 'policy_lapsed_before'
  | 'policy_cancelled'
  | 'exclusion_applies'
  | 'deductible_exceeds_claim'
  | 'stacked_lapse_and_contradiction'
  // --- labelled `escalate` ------------------------------------------------
  | 'limit_boundary_over'
  | 'estimate_contradiction'
  | 'report_date_mismatch'
  | 'near_duplicate_filing'
  | 'ambiguous_evidence';

export interface EvalCustomer {
  full_name: string;
  email: string;
  phone: string;
  date_of_birth: string;
  address: string;
}

export interface EvalPolicy {
  policy_number: string;
  policy_type: PolicyType;
  provider: string;
  /** Rupees. The most the policy will pay for a single claim. */
  coverage_amount: number;
  /** Rupees. Borne by the policyholder before anything is payable. */
  deductible: number;
  premium_monthly: number;
  start_date: string;
  end_date: string;
  status: PolicyStatus;
  coverage_details: Record<string, unknown>;
  /**
   * Exclusion clauses as they are printed in the policy wording. An
   * adjudicator has to decide whether one of these actually covers the
   * incident described — several cases turn on an exclusion that is adjacent
   * to the incident without reaching it.
   */
  exclusions: string[];
}

export interface EvalDocument {
  /** One of the claim's `documents_required` entries. */
  document_type: string;
  original_filename: string;
  mime_type: string;
  /** The text a reader would get out of the file. */
  content: string;
}

export interface EvalClaim {
  claim_number: string;
  claim_type: ClaimType;
  incident_date: string;
  incident_description: string;
  /** Rupees, as declared by the claimant. */
  claimed_amount: number;
  documents_required: string[];
  documents_received: string[];
  filed_at: string;
}

/**
 * One case: a policy, a claim against it, and whatever was uploaded.
 * Deliberately carries no label and no trap name.
 */
export interface EvalCase {
  case_id: string;
  customer: EvalCustomer;
  policy: EvalPolicy;
  claim: EvalClaim;
  documents: EvalDocument[];
  /**
   * Claims already on file for this policyholder that an adjudicator can see.
   * Empty for most cases; populated where the point of the case is that the
   * same incident has been filed twice.
   */
  related_claims: EvalClaim[];
}

/**
 * The structural facts the rulebook decides on. Stored on the answer-key side
 * so a label can be re-derived rather than taken on trust — and so a test can
 * check the derivable ones back against the case file.
 */
export interface CaseFacts {
  /** Policy in force on the incident date. */
  in_force: boolean;
  /** An exclusion in the policy wording covers this incident. */
  exclusion_applies: boolean;
  /** Named clause, when one applies. */
  exclusion_clause: string | null;
  /** Claimed amount is at or below the deductible, so nothing is payable. */
  deductible_swallows_claim: boolean;
  /** Claimed amount is above the policy's coverage limit. */
  over_coverage_limit: boolean;
  /** An uploaded document disagrees with what the claim says. */
  evidence_contradiction: boolean;
  /** What disagrees with what, in one phrase. */
  contradiction_detail: string | null;
  /** The same incident appears to have been filed already. */
  duplicate_filing: boolean;
  /** The evidence on file does not settle the question either way. */
  evidence_insufficient: boolean;
}

export interface GroundTruthEntry {
  case_id: string;
  label: Verdict;
  /** Rule id from the rulebook that produced the label. */
  rule: string;
  /** One line: why this label is the correct one. */
  justification: string;
  trap: TrapCategory;
  facts: CaseFacts;
  /** Rupees, straight off the claim. */
  claimed_amount_inr: number;
  /**
   * Rupees that change hands if this claim is approved:
   * `max(0, min(claimed, coverage) - deductible)`.
   * This is the number a wrong verdict is priced in.
   */
  payable_if_approved_inr: number;
}

export type SplitName = 'dev' | 'holdout';

export interface CasesFile {
  split: SplitName;
  seed: number;
  rulebook_version: string;
  currency: 'INR';
  count: number;
  /** Present so a reader knows the labels live somewhere else. */
  labels: 'withheld — see ground-truth.json';
  cases: EvalCase[];
}

export interface GroundTruthFile {
  split: SplitName;
  seed: number;
  rulebook_version: string;
  currency: 'INR';
  count: number;
  entries: GroundTruthEntry[];
}

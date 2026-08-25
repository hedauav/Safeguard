/**
 * The facts that can be read straight off a case file, without judgement.
 *
 * These exist so that most of the answer key can be checked rather than
 * believed. If `ground-truth.json` says a case is over the coverage limit,
 * the case file itself has to agree, and a test says so. The two facts that
 * cannot be derived this way — whether an exclusion actually reaches the
 * incident, and whether the evidence is genuinely ambiguous — are the two the
 * answer key has to assert on its own, and they are exactly the two a human
 * reviewer should read.
 */
import { ESTIMATE_DOCUMENT, REPORT_DOCUMENT } from './fixtures.js';
import type { EvalCase } from './types.js';

/** The one money line a document is allowed to state as its own total. */
const TOTAL_RE = /^(?:Grand total|Estimate total|Invoice total|Net payable) \(INR\): ([\d,]+)$/m;

/** The one date line a document is allowed to assert as the date of the event. */
const DATE_RE = /^(?:Date of occurrence|Date of call): (\d{4}-\d{2}-\d{2})$/m;

/**
 * How far a stated total may sit from the claimed amount before it counts as a
 * contradiction: the larger of Rs 500 and 2% of the claim. Rounding and a
 * revised quote are not fraud; a total that is a third of the claim is a
 * different document about a different job.
 */
export function contradictionTolerance(claimed: number): number {
  return Math.max(500, Math.round(claimed * 0.02));
}

export function parseTotal(content: string): number | null {
  const m = TOTAL_RE.exec(content);
  return m ? Number(m[1]!.replace(/,/g, '')) : null;
}

export function parseDate(content: string): string | null {
  const m = DATE_RE.exec(content);
  return m ? m[1]! : null;
}

export interface StructuralFacts {
  in_force: boolean;
  over_coverage_limit: boolean;
  deductible_swallows_claim: boolean;
  evidence_contradiction: boolean;
  duplicate_filing: boolean;
  /** Filled in when a contradiction is found, so a failure says what it saw. */
  contradiction_detail: string | null;
}

/**
 * Derive every fact that follows from the numbers and dates alone.
 *
 * `in_force` is deliberately strict about both ends of the term: the cases
 * that turn on this are one day either side of `end_date`, and an
 * off-by-one here would silently relabel them.
 */
export function structuralFacts(c: EvalCase): StructuralFacts {
  const { policy, claim } = c;

  const withinTerm = claim.incident_date >= policy.start_date && claim.incident_date <= policy.end_date;
  const statusAllows = policy.status === 'active' || policy.status === 'expired';
  const in_force = withinTerm && statusAllows;

  const over_coverage_limit = claim.claimed_amount > policy.coverage_amount;
  const deductible_swallows_claim = claim.claimed_amount <= policy.deductible;

  let evidence_contradiction = false;
  let contradiction_detail: string | null = null;

  const estimateType = ESTIMATE_DOCUMENT[claim.claim_type];
  const estimate = c.documents.find((d) => d.document_type === estimateType);
  if (estimate) {
    const total = parseTotal(estimate.content);
    if (total !== null && Math.abs(total - claim.claimed_amount) > contradictionTolerance(claim.claimed_amount)) {
      evidence_contradiction = true;
      contradiction_detail = `${estimateType} totals ${total} against a claimed ${claim.claimed_amount}`;
    }
  }

  const reportType = REPORT_DOCUMENT[claim.claim_type];
  if (reportType) {
    const report = c.documents.find((d) => d.document_type === reportType);
    if (report) {
      const stated = parseDate(report.content);
      if (stated !== null && stated !== claim.incident_date) {
        evidence_contradiction = true;
        contradiction_detail =
          contradiction_detail ??
          `${reportType} records ${stated} against a declared incident date of ${claim.incident_date}`;
      }
    }
  }

  const duplicate_filing = c.related_claims.some(
    (r) => r.incident_date === claim.incident_date && r.claim_type === claim.claim_type
  );

  return {
    in_force,
    over_coverage_limit,
    deductible_swallows_claim,
    evidence_contradiction,
    duplicate_filing,
    contradiction_detail,
  };
}

/** Rupees that change hands if this claim is approved. */
export function payableIfApproved(c: EvalCase): number {
  return Math.max(0, Math.min(c.claim.claimed_amount, c.policy.coverage_amount) - c.policy.deductible);
}

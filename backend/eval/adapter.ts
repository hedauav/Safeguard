/**
 * An evaluation case, in the shape the shipping adjudication code expects.
 *
 * The harness measures `backend/src/services/adjudication-rules.ts` and
 * `adjudication-service.ts` as they are, not a reimplementation of them. That
 * means every case has to be presented to those functions in exactly the shape
 * a Supabase read would have produced, and the mapping has to be stated rather
 * than assumed, because a mapping decision made quietly here is a result
 * silently manufactured later.
 *
 * Four decisions, each of which changes numbers:
 *
 * 1. `policy.exclusions` goes into `coverage_details.exclusions`. The
 *    `policies` table has no exclusions column — `coverage_details JSONB` is
 *    the only place policy wording can live, and `buildAdjudicationPrompt`
 *    serialises `coverage_details` into the prompt verbatim. Without this the
 *    model never sees a single exclusion clause and the seventeen cases that
 *    turn on one (nine `exclusion_applies`, eight `exclusion_near_miss`) are
 *    unanswerable by construction. Measuring a model against a question it was
 *    not shown is not measuring the model.
 *
 * 2. `covered_claim_types` is NOT synthesised. The endorsement path in
 *    `coveredClaimTypes` exists so a policy can widen its own schedule, and
 *    using it here to widen every policy would hide whatever the shipped
 *    schedule in `COVERED_CLAIM_TYPES` gets wrong. It gets something wrong on
 *    this split; the report says what.
 *
 * 3. `claim.status` is `submitted`. The eval claim carries no status because
 *    every case is a claim awaiting adjudication, and `submitted` is the
 *    status that means exactly that. It is deliberately not one of
 *    `ALREADY_DECIDED_STATUSES`, which would veto all 100 cases.
 *
 * 4. `documents_required` is not put in front of the model, because the
 *    shipping prompt does not put it in front of the model. Eight dev cases
 *    are missing a required document and the model is given no way to know it.
 *    That is a property of the shipped system and the report names it rather
 *    than repairing it here.
 */
import { createHash } from 'node:crypto';
import type {
  AdjudicationFacts,
  ClaimFacts,
  PolicyFacts,
  SiblingClaim,
} from '../src/services/adjudication-rules.js';
import type { DocumentFacts } from '../src/services/adjudication-service.js';
import type { EvalCase } from './types.js';

export interface AdaptedCase {
  facts: AdjudicationFacts;
  documents: DocumentFacts[];
}

/** The status every eval claim is in: filed, undecided, awaiting a verdict. */
export const EVAL_CLAIM_STATUS = 'submitted';

function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function adaptPolicy(c: EvalCase): PolicyFacts {
  return {
    policy_number: c.policy.policy_number,
    policy_type: c.policy.policy_type,
    status: c.policy.status,
    coverage_amount: c.policy.coverage_amount,
    deductible: c.policy.deductible,
    start_date: c.policy.start_date,
    end_date: c.policy.end_date,
    // Decision 1. The only channel the schema gives policy wording.
    coverage_details: { ...c.policy.coverage_details, exclusions: c.policy.exclusions },
  };
}

export function adaptClaim(c: EvalCase): ClaimFacts {
  return {
    id: c.case_id,
    claim_number: c.claim.claim_number,
    claim_type: c.claim.claim_type,
    status: EVAL_CLAIM_STATUS,
    incident_date: c.claim.incident_date,
    claimed_amount: c.claim.claimed_amount,
    incident_description: c.claim.incident_description,
  };
}

/**
 * Every claim on the policy, the claim under adjudication included.
 *
 * `runDeterministicChecks` filters the claim out of its own sibling list by
 * id, so including it is both correct and the thing that proves the filter
 * works. Related claims are `submitted` rather than `denied` or `closed`:
 * those two statuses are treated as spent history and would silently switch
 * off the near-duplicate rule on all five duplicate cases.
 */
export function adaptSiblings(c: EvalCase): SiblingClaim[] {
  const self: SiblingClaim = {
    id: c.case_id,
    claim_number: c.claim.claim_number,
    claim_type: c.claim.claim_type,
    status: EVAL_CLAIM_STATUS,
    incident_date: c.claim.incident_date,
  };
  const related = c.related_claims.map((r, index) => ({
    id: `${c.case_id}#related-${index + 1}`,
    claim_number: r.claim_number,
    claim_type: r.claim_type,
    status: EVAL_CLAIM_STATUS,
    incident_date: r.incident_date,
  }));
  return [self, ...related];
}

export function adaptDocuments(c: EvalCase): DocumentFacts[] {
  return c.documents.map((d, index) => ({
    id: `${c.case_id}#doc-${index + 1}`,
    document_type: d.document_type,
    original_filename: d.original_filename,
    content_hash: contentHash(d.content),
    extracted_text: d.content.trim() ? d.content : null,
    // Every word of every document in this set was written by the claimant's
    // side of the transaction. Saying so is what makes the prompt's untrusted
    // fence mean anything.
    text_source: 'claimant',
    uploaded_at: c.claim.filed_at,
  }));
}

export function adaptCase(c: EvalCase): AdaptedCase {
  const facts: AdjudicationFacts = {
    claim: adaptClaim(c),
    policy: adaptPolicy(c),
    siblingClaims: adaptSiblings(c),
  };
  return { facts, documents: adaptDocuments(c) };
}

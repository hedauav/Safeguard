import { SupabaseClient } from '@supabase/supabase-js';
import { isNotFound } from './lookup-result.js';
import { referenceCandidates } from './reference-number.js';
import {
  coveredClaimTypes,
  runDeterministicChecks,
  type AdjudicationFacts,
  type ClaimFacts,
  type PolicyFacts,
  type RuleId,
  type SiblingClaim,
} from './adjudication-rules.js';

/**
 * What the voice agent is allowed to tell a caller about their claim.
 *
 * This is the deliberately narrower sibling of `adjudicateClaim`, and the
 * narrowness is the entire feature. `adjudicateClaim` produces a verdict, a
 * confidence, and a list of inconsistencies a model believed it found; it is
 * absent from `AGENT_TOOLS` for the reason set out in ARCHITECTURE.md under
 * "Not a voice tool, on purpose" — a caller hearing an automated opinion that
 * their claim looks deniable, before any adjuster has read a word, is the harm
 * the whole design exists to prevent.
 *
 * So this module answers a different question. Not "what should happen to this
 * claim", which is a judgement, but "what does the policy say", which is a
 * matter of record:
 *
 *  - is the claim type within the cover, and what is the limit
 *  - what is the excess
 *  - what would be payable — max(0, min(claimed, coverage) - deductible)
 *  - which documents are still outstanding
 *  - whether a deterministic rule has already ruled the claim out, and which
 *
 * Every one of those is arithmetic over the claim row and the policy row, or
 * a sentence written in `adjudication-rules.ts` by a person. A caller can be
 * told any of it, an adjuster can be shown the working, and if the caller
 * disagrees there is something concrete to disagree with.
 *
 * A model's suspicion has none of those properties, so no model participates
 * here at all. There is no `LlmProvider` parameter, nothing in this file reads
 * the `adjudications` table, and the deterministic rules layer is called
 * directly — `runDeterministicChecks` is pure, synchronous, and is the same
 * code path that would veto before a model was ever called. If a verdict field
 * is ever wanted in this result, the answer is no; the caller wanting it is
 * asking for `adjudicateClaim`, which is a back-office endpoint.
 */

/** Why an explanation could not be given. Distinct per gate so callers branch. */
export type ClaimAssessmentRefusalReason = 'claim_not_found' | 'records_unavailable';

export interface ClaimAssessmentRefused {
  success: false;
  reason: ClaimAssessmentRefusalReason;
  claim_number: string | null;
  message: string;
}

/**
 * A deterministic rule that stopped the claim, named so the agent can say
 * which one and the caller can argue with it.
 *
 * `detail` is the rule's own sentence from `adjudication-rules.ts` — policy
 * dates, the coverage schedule, or the deductible arithmetic. It is not a
 * summary of one and must not be paraphrased into something softer.
 */
export interface BlockingRule {
  id: RuleId;
  detail: string;
  /**
   * What the rule's veto actually means for the claim.
   *
   * `refused` is a matter of record the caller can be told plainly: the policy
   * term did not cover the date, the type is not within the cover, nothing is
   * left after the excess. `needs_review` is everything the rules could only
   * route to a person — a missing policy row, an unreadable date, an amount
   * above the limit, a possible duplicate. The distinction exists so the agent
   * does not deliver "a person needs to look at this" in the voice of a
   * refusal, which is how an escalation gets heard as a denial.
   *
   * Derived from the rule's own `vetoes` verdict, which is deterministic. It
   * is not, and can never be, a model's leaning.
   */
  effect: 'refused' | 'needs_review';
}

export interface ClaimAssessmentExplained {
  success: true;
  reason: null;
  /**
   * The claim's internal id. Not for the caller — it is here so what the agent
   * told somebody about their own claim can be written to that claim's
   * timeline, which is keyed by id rather than by the number a caller reads
   * out. Nothing in the spoken message uses it.
   */
  claim_id: string;
  claim_number: string;
  claim_type: string | null;
  claim_status: string | null;
  policy_number: string | null;
  policy_type: string | null;
  /**
   * Whether the claim type falls within the policy's cover. Null when no
   * coverage schedule is held for that policy type — "unknown" is not "not
   * covered", and saying otherwise on the phone would be a denial by omission.
   */
  claim_type_covered: boolean | null;
  coverage_amount: number | null;
  deductible: number | null;
  /** What the claimant asked for. Null when the claim states no amount. */
  claimed_amount: number | null;
  /**
   * max(0, min(claimed, coverage) - deductible), via the rules layer, which
   * delegates to `computeSettlement` — the same arithmetic the settlement path
   * would actually disburse. Null, never 0, when no amount was claimed: zero
   * would read as "your claim is worth nothing" when the truth is that nobody
   * has said what it is worth yet.
   */
  payable_amount: number | null;
  /** Document types the claim still wants and has not received. */
  documents_outstanding: string[];
  /** Null when no deterministic rule vetoed. Never a model's opinion. */
  blocking_rule: BlockingRule | null;
  /** Non-fatal problems, e.g. a document read that failed. */
  warnings: string[];
  message: string;
}

export type ClaimAssessmentResult = ClaimAssessmentExplained | ClaimAssessmentRefused;

function refuse(
  reason: ClaimAssessmentRefusalReason,
  message: string,
  claimNumber: string | null = null
): ClaimAssessmentRefused {
  return { success: false, reason, claim_number: claimNumber, message };
}

/**
 * Postgres NUMERIC arrives over PostgREST as a string, so arithmetic on the
 * raw column silently concatenates. Returns null rather than 0 for anything
 * that is not a number, because a missing figure and a figure of zero are
 * different things to say out loud.
 */
function toAmountOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function humanize(documentType: string): string {
  return documentType.replace(/_/g, ' ');
}

function money(value: number): string {
  return value.toFixed(2);
}

/** Claim numbers reach us through speech-to-text, usually without the dashes. */
async function findClaim(supabase: SupabaseClient, claimNumber: string) {
  const columns =
    'id, claim_number, policy_id, claim_type, status, incident_date, claimed_amount, ' +
    'incident_description, documents_required, documents_received';

  let claim: any = null;
  let error: any = null;

  for (const candidate of referenceCandidates(claimNumber)) {
    const attempt = await supabase
      .from('claims')
      .select(columns)
      .eq('claim_number', candidate)
      .maybeSingle();
    if (attempt.data) return { claim: attempt.data, error: null };
    if (attempt.error && !isNotFound(attempt.error)) return { claim: null, error: attempt.error };
    error = attempt.error;
  }

  return { claim, error };
}

/**
 * Explain a filed claim against its policy.
 *
 * Takes a claim number and nothing else — the same shape as `settle_claim` and
 * `collect_deductible`, and for the same reason. Every figure it reports is
 * derived here from the claim and the policy; a figure the caller could name
 * is a figure the caller could be talked into naming, and there is nothing for
 * them to name.
 */
export async function explainClaimAssessment(
  supabase: SupabaseClient,
  claimNumber: string
): Promise<ClaimAssessmentResult> {
  const warnings: string[] = [];

  // --- Gate 1: the claim must exist ---------------------------------------
  // A read fault and an absent row are answered differently on purpose.
  // Telling somebody their real claim does not exist during an outage is worse
  // than admitting the outage, and it sends them to read the number back to us
  // over and over while nothing is wrong with the number.
  const { claim: claimRow, error: claimError } = await findClaim(supabase, claimNumber);

  if (claimError && !isNotFound(claimError)) {
    console.error('explainClaimAssessment: claim lookup failed:', claimError);
    return refuse(
      'records_unavailable',
      "I'm having trouble reaching our claim records right now, so I can't go through the cover on that claim. Let me try again, or I can connect you with a representative."
    );
  }

  if (!claimRow) {
    return refuse(
      'claim_not_found',
      "I couldn't find a claim with that number, so there's nothing for me to go through. Could you read it back to me?"
    );
  }

  const claim: ClaimFacts = {
    id: claimRow.id,
    claim_number: claimRow.claim_number,
    claim_type: claimRow.claim_type ?? null,
    status: claimRow.status ?? null,
    incident_date: claimRow.incident_date ?? null,
    claimed_amount: claimRow.claimed_amount,
    incident_description: claimRow.incident_description ?? null,
  };

  // --- The policy ----------------------------------------------------------
  // A missing row is not treated as an active policy. It becomes the
  // `policy_on_file` veto in the rules layer, which escalates rather than
  // denies, because a row we cannot read is far more likely to be our problem
  // than the claimant's.
  const { data: policyRow, error: policyError } = await supabase
    .from('policies')
    .select(
      'policy_number, policy_type, status, coverage_amount, deductible, start_date, end_date, coverage_details'
    )
    .eq('id', claimRow.policy_id)
    .maybeSingle();

  if (policyError && !isNotFound(policyError)) {
    console.error('explainClaimAssessment: policy lookup failed:', policyError);
    return refuse(
      'records_unavailable',
      "I'm having trouble reaching our policy records right now, so I can't tell you what the cover says. Let me connect you with a representative.",
      claim.claim_number
    );
  }

  const policy: PolicyFacts | null = policyRow
    ? {
        policy_number: policyRow.policy_number,
        policy_type: policyRow.policy_type ?? null,
        status: policyRow.status ?? null,
        coverage_amount: policyRow.coverage_amount,
        deductible: policyRow.deductible,
        start_date: policyRow.start_date ?? null,
        end_date: policyRow.end_date ?? null,
        coverage_details: (policyRow.coverage_details as Record<string, unknown>) ?? null,
      }
    : null;

  // --- Sibling claims, for the near-duplicate rule -------------------------
  const { data: siblingRows, error: siblingError } = await supabase
    .from('claims')
    .select('id, claim_number, claim_type, status, incident_date')
    .eq('policy_id', claimRow.policy_id);

  if (siblingError && !isNotFound(siblingError)) {
    // Not fatal, but the duplicate rule then ran over an empty set. Said out
    // loud rather than left implied, because a clean pass would otherwise
    // suggest a check that never happened.
    console.error('explainClaimAssessment: sibling claim lookup failed:', siblingError);
    warnings.push('Other claims on this policy could not be read, so the duplicate-claim check did not run.');
  }

  const siblingClaims: SiblingClaim[] = (siblingRows ?? []).map((row: any) => ({
    id: row.id,
    claim_number: row.claim_number,
    claim_type: row.claim_type ?? null,
    status: row.status ?? null,
    incident_date: row.incident_date ?? null,
  }));

  // --- The deterministic layer --------------------------------------------
  // Pure, synchronous, and the same code that vetoes ahead of the model in the
  // adjudication path. `payableAmount` comes back from here rather than being
  // recomputed locally: two implementations of one rule is how they drift, and
  // the figure a caller is told must be the figure the settlement path would
  // pay. See `computePayableAmount` -> `computeSettlement`.
  const facts: AdjudicationFacts = { claim, policy, siblingClaims };
  const deterministic = runDeterministicChecks(facts);

  const claimedAmount = toAmountOrNull(claim.claimed_amount);

  // Null, not 0, when nothing was claimed. The rules layer computes a payable
  // of 0 in that case because its arithmetic coerces an absent amount to zero,
  // which is right for a veto and wrong for a sentence read to a caller.
  const payableAmount = claimedAmount === null ? null : deterministic.payableAmount;

  const blockingRule: BlockingRule | null = deterministic.veto
    ? {
        id: deterministic.veto.id,
        detail: deterministic.veto.detail,
        effect: deterministic.veto.vetoes === 'deny' ? 'refused' : 'needs_review',
      }
    : null;

  // --- What the cover says -------------------------------------------------
  const covered = policy ? coveredClaimTypes(policy) : null;
  const claimType = (claim.claim_type ?? '').toLowerCase();
  // Null when no schedule is held for the policy type: unknown is not "no".
  const claimTypeCovered = covered ? Boolean(claimType) && covered.includes(claimType) : null;

  // --- Outstanding documents ----------------------------------------------
  // The same three-way test the attach-document tool uses: required, minus
  // what the claim records as received, minus anything whose bytes have
  // actually arrived and been hashed. The third term matters because the
  // evidence pipeline writes `documents_received` only after the bundle is
  // re-anchored, so a file uploaded a moment ago is on file without yet being
  // listed there, and telling the caller to send it again would be wrong.
  const required: string[] = claimRow.documents_required ?? [];
  const received: string[] = claimRow.documents_received ?? [];

  const { data: uploaded, error: documentError } = await supabase
    .from('claim_documents')
    .select('document_type')
    .eq('claim_id', claim.id);

  if (documentError && !isNotFound(documentError)) {
    // Degrade rather than refuse: the coverage arithmetic is unaffected, and
    // the caller still gets the part of the answer we can stand behind. What
    // we must not do is print a shorter outstanding list as though it were
    // complete.
    console.error('explainClaimAssessment: document lookup failed:', documentError);
    warnings.push('Uploaded documents could not be read, so the outstanding list may be out of date.');
  }

  const held = new Set((uploaded ?? []).map((row: any) => row.document_type));
  const documentsOutstanding = required.filter((doc) => !received.includes(doc) && !held.has(doc));

  const coverageAmount = toAmountOrNull(policy?.coverage_amount);
  const deductible = toAmountOrNull(policy?.deductible);

  return {
    success: true,
    reason: null,
    claim_id: claim.id,
    claim_number: claim.claim_number,
    claim_type: claim.claim_type,
    claim_status: claim.status,
    policy_number: policy?.policy_number ?? null,
    policy_type: policy?.policy_type ?? null,
    claim_type_covered: claimTypeCovered,
    coverage_amount: coverageAmount,
    deductible,
    claimed_amount: claimedAmount,
    payable_amount: payableAmount,
    documents_outstanding: documentsOutstanding,
    blocking_rule: blockingRule,
    warnings,
    message: buildMessage({
      claimNumber: claim.claim_number,
      claimType: claim.claim_type,
      claimTypeCovered,
      coverageAmount,
      deductible,
      payableAmount,
      documentsOutstanding,
      blockingRule,
    }),
  };
}

/**
 * The sentence the agent reads out.
 *
 * Written here rather than left to the model so the reviewer caveat cannot be
 * dropped on a call where it matters. Every branch below ends by saying a
 * person decides; none of them says what that person will decide.
 */
function buildMessage(input: {
  claimNumber: string;
  claimType: string | null;
  claimTypeCovered: boolean | null;
  coverageAmount: number | null;
  deductible: number | null;
  payableAmount: number | null;
  documentsOutstanding: string[];
  blockingRule: BlockingRule | null;
}): string {
  const parts: string[] = [];

  if (input.claimTypeCovered === true && input.coverageAmount !== null) {
    parts.push(
      `Claim ${input.claimNumber} is a ${input.claimType ?? 'general'} claim, which this policy covers up to ${money(input.coverageAmount)}.`
    );
  } else if (input.claimTypeCovered === false) {
    parts.push(`A ${input.claimType ?? 'general'} claim is not within the cover on this policy.`);
  } else {
    parts.push(`I can't tell from the policy schedule whether a ${input.claimType ?? 'general'} claim is covered here.`);
  }

  if (input.deductible !== null) {
    parts.push(`The excess is ${money(input.deductible)}.`);
  }

  if (input.payableAmount !== null) {
    parts.push(
      input.payableAmount > 0
        ? `After the excess, ${money(input.payableAmount)} would be payable if the claim is approved.`
        : 'Once the excess is applied there would be nothing payable on it.'
    );
  } else {
    // The `estimated_amount` gap, said plainly. A claim with no figure cannot
    // be assessed at all, and the caller is the only person who can fix that.
    parts.push('No amount has been recorded against the claim yet, so there is nothing to work the payable figure out from.');
  }

  if (input.documentsOutstanding.length) {
    parts.push(`We're still waiting on: ${input.documentsOutstanding.map(humanize).join(', ')}.`);
  }

  if (input.blockingRule) {
    parts.push(
      input.blockingRule.effect === 'refused'
        ? `One thing does stand in the way: ${input.blockingRule.detail}`
        : `One thing needs a person to look at it: ${input.blockingRule.detail}`
    );
  }

  // Last, and unconditional. This is the sentence the whole module exists to
  // keep attached to the figures above it.
  parts.push('None of that is a decision — a claims reviewer decides, and nothing is settled until they have.');

  return parts.join(' ');
}

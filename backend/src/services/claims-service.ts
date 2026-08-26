import { SupabaseClient } from '@supabase/supabase-js';
import { randomInt } from 'crypto';
import { isNotFound, unavailable } from './lookup-result.js';
import { referenceCandidates } from './reference-number.js';
import { ablations } from '../config/ablation.js';
// Types only — erased at compile time, so this file gains no runtime dependency
// on the adjudication stack (and none on an LLM provider) by naming its shapes.
import type { AdjudicationResult } from './adjudication-service.js';
import type { AdjudicationVerdict } from './adjudication-rules.js';

/** PostgreSQL unique_violation — the claims.claim_number index firing. */
const UNIQUE_VIOLATION = '23505';

/** Bounded so a collision retries but a broken insert refuses promptly. */
const MAX_CLAIM_NUMBER_ATTEMPTS = 3;

/**
 * Claim numbers are drawn, not derived — nothing about a freshly filed claim
 * is unique enough to hash. A six-digit serial in a year therefore collides
 * often enough to matter, so the constraint is the authority and the caller
 * retries on it rather than treating a collision as an outage.
 */
export function generateClaimNumber(now: Date = new Date()): string {
  const serial = String(randomInt(0, 1_000_000)).padStart(6, '0');
  return `CLM-${now.getFullYear()}-${serial}`;
}

/**
 * Try each plausible spelling of a reference number in turn.
 * Returns the first hit, or the last error so genuine faults still surface.
 */
async function findByCandidates(
  supabase: SupabaseClient,
  table: string,
  column: string,
  select: string,
  raw: string
) {
  // With normalisation ablated, look up exactly what the transcript contained.
  // That is what the tool layer does without the recovery layer, and it is how
  // the harness measures what the layer is worth.
  const candidates = ablations.normalisation ? [raw] : referenceCandidates(raw);
  let lastError: any = null;

  for (const candidate of candidates) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .eq(column, candidate)
      .maybeSingle();

    if (data) return { data: data as any, error: null };
    // A real fault (network, auth) must not be mistaken for "not found",
    // so stop trying alternatives and report it.
    if (error && !isNotFound(error)) return { data: null, error };
    lastError = error;
  }

  return { data: null, error: lastError };
}

export async function lookupClaim(
  supabase: SupabaseClient,
  claimNumber: string
) {
  // Callers read numbers aloud, so the transcript often lacks the dashes.
  const { data: claim, error } = await findByCandidates(
    supabase,
    'claims',
    'claim_number',
    '*, customers!inner(full_name)',
    claimNumber
  );

  if (error && !isNotFound(error)) {
    console.error('lookupClaim: query failed:', error);
    return unavailable('claim');
  }

  if (!claim) {
    return {
      found: false,
      message: "I couldn't find a claim with that number. Could you read it back to me?",
    };
  }

  const customer_name = (claim.customers as any)?.full_name || 'Unknown';

  return {
    found: true,
    claim: {
      claim_number: claim.claim_number,
      status: claim.status,
      claim_type: claim.claim_type,
      incident_date: claim.incident_date,
      incident_description: claim.incident_description,
      claimed_amount: claim.claimed_amount,
      assigned_adjuster: claim.assigned_adjuster,
      documents_required: claim.documents_required,
      documents_received: claim.documents_received,
      customer_name,
    },
  };
}

export async function checkDocuments(
  supabase: SupabaseClient,
  claimNumber: string
) {
  const { data: claim, error } = await findByCandidates(
    supabase,
    'claims',
    'claim_number',
    'claim_number, documents_required, documents_received',
    claimNumber
  );

  if (error && !isNotFound(error)) {
    console.error('checkDocuments: query failed:', error);
    return unavailable('claim');
  }

  if (!claim) {
    return { found: false, message: "I couldn't find a claim with that number." };
  }

  const required: string[] = claim.documents_required || [];
  const received: string[] = claim.documents_received || [];
  const missing = required.filter((d: string) => !received.includes(d));

  const humanize = (doc: string) => doc.replace(/_/g, ' ');

  let message: string;
  if (missing.length === 0) {
    message = `All required documents have been received for claim ${claim.claim_number}.`;
  } else {
    const humanizedList = missing.map(humanize).join(' and ');
    message = `You still need to submit the following for claim ${claim.claim_number}: ${humanizedList}.`;
  }

  return {
    found: true,
    claim_number: claim.claim_number,
    documents_required: required,
    documents_received: received,
    documents_missing: missing,
    message,
  };
}

function getDefaultDocuments(claimType: string): string[] {
  const defaults: Record<string, string[]> = {
    collision: ['police_report', 'repair_estimate', 'photos', 'other_driver_info'],
    windshield: ['photos', 'repair_estimate'],
    theft: ['police_report', 'proof_of_purchase', 'photos'],
    water_damage: ['plumber_invoice', 'damage_photos', 'contractor_estimate'],
    fire_damage: ['fire_dept_report', 'contractor_estimates', 'photos'],
    medical: ['medical_records', 'itemized_bill', 'referral_letter'],
    comprehensive: ['photos', 'repair_estimate', 'incident_report'],
  };
  return defaults[claimType] || ['photos', 'incident_report'];
}

/** What reading a caller-supplied estimate produced. */
export interface EstimatedAmount {
  /** The figure to store, or null when none could be read. */
  amount: number | null;
  /**
   * True only when something was supplied and could not be read as a figure.
   * Distinct from "nothing was supplied", because the agent should re-ask in
   * the first case and must not badger the caller in the second.
   */
  rejected: boolean;
}

/**
 * Read the caller's rough figure for what the damage will cost.
 *
 * The only caller is a language model transcribing a phone conversation, so
 * what arrives here is whatever it heard: a number, a numeric string, or — far
 * more often than one would like — "about fifty thousand", "a lot", or an
 * empty string. Every one of those must become NULL rather than a figure.
 *
 * Coercion is the failure this exists to prevent. `Number('a lot')` is NaN,
 * `Number('')` and `Number(null)` are both 0, and `Number(true)` is 1 — so a
 * plain `Number(...)` would file a claim stating that the damage cost nothing,
 * which the deterministic rules would then happily assess and settle at zero.
 * A claim with no stated amount escalates honestly for that stated reason
 * (`adjudication-rules.ts`, `claimed_amount_stated`); a claim stating a
 * fabricated zero does not.
 *
 * Nothing here caps the figure. A claim above the coverage limit is already a
 * deterministic escalate, and the settlement arithmetic caps the payout, so
 * clamping here would only hide what the caller actually said.
 */
export function readEstimatedAmount(value: unknown): EstimatedAmount {
  // Not supplied at all. Optional means optional: the claim is still filed.
  if (value === undefined || value === null) return { amount: null, rejected: false };
  if (typeof value === 'string' && value.trim() === '') return { amount: null, rejected: false };

  // Deliberately narrow. A boolean, an array, or an object is not a figure
  // however willingly JavaScript would convert it into one.
  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string') {
    // Commas and a currency symbol are how a figure is written, not nonsense,
    // so they are stripped. Words are not, and fall through to `rejected`.
    const cleaned = value.replace(/[,\s₹]|(?:^rs\.?)/gi, '');
    parsed = Number(cleaned);
  } else {
    return { amount: null, rejected: true };
  }

  if (!Number.isFinite(parsed) || parsed <= 0) return { amount: null, rejected: true };
  return { amount: parsed, rejected: false };
}

export async function fileClaim(
  supabase: SupabaseClient,
  data: {
    policy_number: string;
    // Optional, and left optional on purpose. The route used to supply its own
    // defaults for both of these, which made the defaults below dead code and
    // the documented behaviour wrong — 'auto' where the prompt promised
    // 'general', and a full ISO timestamp where the tool description promised
    // YYYY-MM-DD. One source of truth, and it is here.
    claim_type?: string | null;
    incident_date?: string | null;
    incident_description: string;
    /**
     * Roughly what the caller thinks the damage will cost, if they know.
     * Stored in `claims.claimed_amount` — the column the deterministic rules
     * read, and without which every claim escalates for want of a figure.
     */
    estimated_amount?: unknown;
  }
) {
  // Default claim_type to 'general' if empty/missing
  const claimType = data.claim_type?.trim() || 'general';

  // Default incident_date to today if empty/missing
  const incidentDate = data.incident_date?.trim() || new Date().toISOString().split('T')[0];

  // Trim incident_description to avoid whitespace-only strings
  const incidentDescription = (data.incident_description || '').trim();

  // Read before the policy lookup so an unreadable figure is known about even
  // on the paths that refuse to file — the caller is told what was and was not
  // taken down either way.
  const estimate = readEstimatedAmount(data.estimated_amount);

  // Callers read the policy number aloud when filing, exactly as they do when
  // looking one up, so the same spelling recovery has to apply here.
  const { data: policy, error: policyError } = await findByCandidates(
    supabase,
    'policies',
    'policy_number',
    'id, customer_id, status',
    data.policy_number
  );

  // An outage is not the same as a policy that does not exist. Telling a
  // policyholder their real policy is unknown to us is the worse failure, and
  // it is the one the read paths were already careful to avoid.
  if (policyError && !isNotFound(policyError)) {
    console.error('fileClaim: policy lookup failed:', policyError);
    return {
      success: false,
      unavailable: true,
      message:
        "I can't reach our records right now, so I can't file this yet. Nothing has been lost — please try again shortly or I can arrange a callback.",
    };
  }

  if (!policy) {
    return { success: false, message: 'I could not find a policy with that number.' };
  }

  if (policy.status !== 'active' && !ablations.refusalGates) {
    return {
      success: false,
      message: 'That policy is not currently active, so a new claim cannot be filed.',
    };
  }

  let claim: any = null;
  let claimNumber = '';

  for (let attempt = 1; attempt <= MAX_CLAIM_NUMBER_ATTEMPTS; attempt++) {
    claimNumber = generateClaimNumber();

    const { data, error } = await supabase
      .from('claims')
      .insert({
        claim_number: claimNumber,
        policy_id: policy.id,
        customer_id: policy.customer_id,
        claim_type: claimType,
        status: 'submitted',
        incident_date: incidentDate,
        incident_description: incidentDescription,
        // The column has existed since the first migration and has only ever
        // been read. NULL is written deliberately when the caller could not
        // give a figure: the rules layer refuses to assess an unstated amount
        // and says so, which is the honest outcome.
        claimed_amount: estimate.amount,
        documents_required: getDefaultDocuments(claimType),
        documents_received: [],
      })
      .select()
      .single();

    if (!error && data) {
      claim = data;
      break;
    }

    // A taken claim number says nothing about the database's health. Retrying
    // it as an outage — which is what the single generic message did — hid a
    // recoverable collision behind the same words as a genuine failure.
    if (error?.code === UNIQUE_VIOLATION && attempt < MAX_CLAIM_NUMBER_ATTEMPTS) {
      console.warn(
        `fileClaim: claim number ${claimNumber} already taken, retrying (attempt ${attempt} of ${MAX_CLAIM_NUMBER_ATTEMPTS})`
      );
      continue;
    }

    if (error?.code === UNIQUE_VIOLATION) {
      console.error(
        `fileClaim: could not find a free claim number in ${MAX_CLAIM_NUMBER_ATTEMPTS} attempts`,
        error
      );
      return {
        success: false,
        message:
          "I wasn't able to assign a claim number just now. Nothing has been lost — please try again in a moment and it will go through.",
      };
    }

    console.error('fileClaim: claim insert failed:', error);
    return { success: false, message: 'There was an issue filing your claim. Please try again.' };
  }

  if (!claim) {
    // Unreachable: the loop either fills `claim` or returns above.
    return { success: false, message: 'There was an issue filing your claim. Please try again.' };
  }

  // Said out loud only when something was supplied and could not be read. The
  // claim is filed either way; the agent is told so it can ask once more rather
  // than leaving the caller believing a figure was taken down.
  const estimateNote = estimate.rejected
    ? " I couldn't make out an amount from that, so no figure is recorded against the claim yet — tell me a rough cost any time and it can be added."
    : '';

  return {
    success: true,
    claim_id: claim.id,
    claim_number: claimNumber,
    status: 'submitted',
    /** What was written to `claims.claimed_amount`; null when none was stated. */
    claimed_amount: estimate.amount,
    estimated_amount_recorded: estimate.amount !== null,
    // No code assigns an adjuster — `assigned_adjuster` is only ever read — and
    // nothing here promises a turnaround. Say what the insert actually did.
    message: `Your claim has been filed successfully. Your claim number is ${claimNumber}. It's recorded as submitted and queued for review. Quote that number and I can read you its status any time.${estimateNote}`,
    next_steps: [
      'Upload photos of the damage',
      'Get a repair or cost estimate',
      'Keep all related receipts and documents',
    ],
  };
}

// --- Auto-triage on filing ---------------------------------------------------
//
// A claim used to land as `submitted` and stop there. Nothing read it, nothing
// moved it, and `under_review` and `documents_needed` were written by no code
// at all. This is the path that moves it — and the whole of its design is the
// line it will not cross.
//
// TRIAGE MAY MOVE A CLAIM; IT MAY NEVER DECIDE ONE. The two statuses below are
// the only ones this file writes. `approved` and `denied` are human acts,
// recorded by a named reviewer through `routes/adjudication-review.ts`, and the
// landing page says so in as many words. A model recommending `approve` moves
// the claim to `under_review` exactly like one recommending `deny` does; the
// recommendation is carried in the `adjudications` audit row where a person
// reads it, and nowhere else.
//
// The status write lives here rather than inside `adjudicateClaim` on purpose.
// That service's refusal to touch `claims` is deliberate and documented at
// `adjudication-service.ts:20-46` and `:694-705`, and other callers — the
// `/tools/adjudicate-claim` route, the evaluation harness — depend on being
// able to ask for a recommendation without the claim moving underneath them.

/**
 * Statuses auto-triage refuses to overwrite.
 *
 * The `paid`/`closed` half is the same guard `adjudication-review.ts:73-74`
 * applies, for the same reason: a paid claim is not un-paid by a re-read, and
 * money that has moved is not walked backwards by a background job.
 *
 * `approved`/`denied` are here as well, and that addition is the point. Those
 * two are the record of a human decision, and the review queue reads the claim
 * row to show it. Dragging a decided claim back to `under_review` would erase a
 * reviewer's answer from the only place the dashboard looks — a background task
 * silently undoing a person's decision.
 */
export const AUTO_TRIAGE_IMMOVABLE_STATUSES = new Set(['approved', 'denied', 'paid', 'closed']);

/** The only two statuses this path is permitted to write. */
export type AutoTriageStatus = 'under_review' | 'documents_needed';

/** Why triage did not move the claim, when it did not. */
export type AutoTriageReason =
  | 'claim_not_found'
  | 'records_unavailable'
  | 'already_adjudicated'
  | 'claim_already_decided'
  | 'adjudication_refused'
  | 'status_write_failed'
  | 'status_superseded';

export interface AutoTriageOutcome {
  /** True only when the claim now stands at `status_after`. */
  triaged: boolean;
  reason: AutoTriageReason | null;
  claim_number: string | null;
  /** The recommendation, carried for the log and the journey event only. */
  verdict: AdjudicationVerdict | null;
  adjudication_id: string | null;
  status_before: string | null;
  status_after: AutoTriageStatus | null;
  documents_missing: string[];
}

/**
 * The journey recorder, injected rather than imported.
 *
 * `recordJourneyEvent` needs a Supabase client and an actor this service has no
 * opinion about, and injecting it keeps this file free of a runtime dependency
 * on the journey table — so a claim is still filed and still triaged on a
 * deployment where migration 0021 has not been applied yet. It is also what
 * lets the tests below assert on the events without a database.
 */
export type JourneyRecorder = (event: {
  eventType: string;
  detail: Record<string, unknown>;
}) => Promise<void>;

export interface AutoTriageDeps {
  /** Takes a claim number and nothing else — see `adjudicateClaim`. */
  adjudicate: (claimNumber: string) => Promise<AdjudicationResult>;
  recordEvent?: JourneyRecorder;
}

function outcome(partial: Partial<AutoTriageOutcome>): AutoTriageOutcome {
  return {
    triaged: false,
    reason: null,
    claim_number: null,
    verdict: null,
    adjudication_id: null,
    status_before: null,
    status_after: null,
    documents_missing: [],
    ...partial,
  };
}

/**
 * Adjudicate a freshly filed claim and move it to the right waiting room.
 *
 * Called in the background from the file-claim route: the caller has already
 * been told their claim number, so nothing here may stall the call and nothing
 * here may lose the claim. Every failure below therefore returns an outcome
 * rather than throwing, and every one of them leaves the claim exactly as
 * `fileClaim` left it — filed, `submitted`, and visible.
 *
 * Never resolves to `approved` or `denied`. See the block comment above.
 */
export async function autoTriageFiledClaim(
  supabase: SupabaseClient,
  deps: AutoTriageDeps,
  claimId: string
): Promise<AutoTriageOutcome> {
  const record = async (eventType: string, detail: Record<string, unknown>) => {
    if (!deps.recordEvent) return;
    try {
      await deps.recordEvent({ eventType, detail });
    } catch (err) {
      // The contract says the recorder never throws, but a lost event must not
      // be allowed to lose the step it describes, so this path does not rely
      // on the contract being kept.
      console.error('autoTriageFiledClaim: journey event was not recorded:', err);
    }
  };

  // --- The claim as it stands now -----------------------------------------
  // Re-read rather than trusted from the insert: between filing and this task
  // running, a reviewer may have decided it, and the guard below is only worth
  // anything if it is checked against the current row.
  const { data: claimRow, error: claimError } = await supabase
    .from('claims')
    .select('id, claim_number, status, documents_required, documents_received')
    .eq('id', claimId)
    .maybeSingle();

  if (claimError && !isNotFound(claimError)) {
    console.error('autoTriageFiledClaim: claim lookup failed:', claimError);
    return outcome({ reason: 'records_unavailable' });
  }
  if (!claimRow) {
    return outcome({ reason: 'claim_not_found' });
  }

  const claim = claimRow as unknown as {
    id: string;
    claim_number: string;
    status: string | null;
    documents_required: string[] | null;
    documents_received: string[] | null;
  };
  const statusBefore = claim.status ?? null;

  if (statusBefore && AUTO_TRIAGE_IMMOVABLE_STATUSES.has(statusBefore)) {
    return outcome({
      reason: 'claim_already_decided',
      claim_number: claim.claim_number,
      status_before: statusBefore,
    });
  }

  // --- One adjudication per claim ------------------------------------------
  // A re-file produces a new claim row and rightly gets its own adjudication.
  // This guards the other case: this task running twice against the same claim
  // — a retried request, a duplicated background job — which would otherwise
  // spend a second lot of metered tokens and leave two audit rows a reviewer
  // has to reconcile.
  const { data: existing, error: existingError } = await supabase
    .from('adjudications')
    .select('id')
    .eq('claim_id', claim.id);

  if (existingError && !isNotFound(existingError)) {
    // Deliberately not fatal. If the audit table cannot be read we cannot rule
    // out a duplicate, but a duplicate is a recoverable audit row — the review
    // queue already shows one recommendation per claim, newest first — whereas
    // a claim that never reaches the queue at all is the failure this whole
    // change exists to fix. Proceed, and say in the log that we proceeded.
    console.warn(
      `autoTriageFiledClaim: could not check for an existing adjudication on ${claim.claim_number}; proceeding anyway:`,
      existingError
    );
  } else if ((existing ?? []).length > 0) {
    return outcome({
      reason: 'already_adjudicated',
      claim_number: claim.claim_number,
      status_before: statusBefore,
    });
  }

  // --- The recommendation ---------------------------------------------------
  const assessment = await deps.adjudicate(claim.claim_number);

  if (!assessment.success) {
    // The claim stays filed and untouched. It is still `submitted`, still
    // findable by its number, and a human can still adjudicate it by hand.
    console.error(
      `autoTriageFiledClaim: ${claim.claim_number} was not adjudicated (${assessment.reason}); it stands filed and unmoved.`
    );
    await record('adjudicated', {
      claim_number: claim.claim_number,
      refused: true,
      reason: assessment.reason,
    });
    return outcome({
      reason: 'adjudication_refused',
      claim_number: claim.claim_number,
      status_before: statusBefore,
    });
  }

  // Recorded before the claim is moved, mirroring the human review path: if the
  // status write then fails, the journey still shows that the claim was
  // assessed and the claim row still shows that it did not move. The two
  // together are the truth; either alone would be a lie.
  await record('adjudicated', {
    claim_number: claim.claim_number,
    adjudication_id: assessment.adjudication_id,
    verdict: assessment.verdict,
    vetoed_by: assessment.vetoed_by,
    model_invoked: assessment.model_invoked,
    // The recommendation is recorded, never acted on. Whatever it says, the
    // status computed below is one of exactly two values.
    requires_human_approval: true,
  });

  // --- Which waiting room ---------------------------------------------------
  // The verdict is deliberately not consulted here. The only question is
  // whether the file is complete enough for a person to read.
  const required = claim.documents_required ?? [];
  const received = claim.documents_received ?? [];
  const missing = required.filter((doc) => !received.includes(doc));
  const target: AutoTriageStatus = missing.length > 0 ? 'documents_needed' : 'under_review';

  const settled = outcome({
    triaged: true,
    claim_number: claim.claim_number,
    verdict: assessment.verdict,
    adjudication_id: assessment.adjudication_id,
    status_before: statusBefore,
    status_after: target,
    documents_missing: missing,
  });

  // Already where it belongs — a second run of this task is a no-op rather
  // than a redundant write.
  if (statusBefore === target) {
    return settled;
  }

  // Compare-and-set on the status we read. A reviewer's decision landing in the
  // gap between the read above and this write wins; this task does not stamp
  // over it. `.select()` is what makes the zero-row case visible at all —
  // without it PostgREST reports a filter that matched nothing as a success.
  const { data: updated, error: statusError } = await supabase
    .from('claims')
    .update({ status: target })
    .eq('id', claim.id)
    .eq('status', statusBefore)
    .select('id');

  if (statusError) {
    console.error(
      `autoTriageFiledClaim: ${claim.claim_number} was adjudicated but not moved to ${target}:`,
      statusError
    );
    return { ...settled, triaged: false, reason: 'status_write_failed', status_after: null };
  }

  if ((updated ?? []).length === 0) {
    console.warn(
      `autoTriageFiledClaim: ${claim.claim_number} moved off '${statusBefore}' while it was being assessed; leaving it where it is.`
    );
    return { ...settled, triaged: false, reason: 'status_superseded', status_after: null };
  }

  if (target === 'documents_needed') {
    await record('documents_requested', {
      claim_number: claim.claim_number,
      documents_required: required,
      documents_missing: missing,
    });
  }

  return settled;
}

// --- The claim comes back out of `documents_needed` --------------------------
//
// The other half of the waiting room. `autoTriageFiledClaim` puts a claim into
// `documents_needed` when its file is short; nothing put it back. The claimant
// uploaded the missing police report, the evidence pipeline hashed it, attested
// it and added its type to `claims.documents_received` — and the claim sat in
// `documents_needed` forever, because no code read that column afterwards and
// asked whether the wait was over. This is that code.
//
// It is deliberately the sibling of the function above and not a new pattern:
// same immovable-status guard, same compare-and-set on the status that was
// read, same injected journey recorder, same rule that failures come back as
// outcomes rather than exceptions.
//
// THE SAME LINE APPLIES. `approved` and `denied` are human acts recorded by a
// named reviewer through `routes/adjudication-review.ts`. The only status this
// path can write is the single literal below, and a complete file is not an
// approved claim — it is a claim a person can now finish reading.
//
// ## Why adjudication is NOT re-run here
//
// The obvious-looking move — new evidence arrived, so re-adjudicate — would be
// theatre. Nothing in this codebase extracts text from an uploaded document.
// `claim_documents.extracted_text` is filled only when whoever uploaded the
// file typed something into the `extracted_text` field themselves, and
// `adjudication-service` reads the claim's own description and the policy, not
// the files. So a second adjudication would see exactly what the first one saw
// — plus, at best, a claimant-supplied caption it already treats as
// adversarial input — and would spend a metered model call to write down the
// same recommendation with a newer timestamp. A reviewer opening the queue
// would then have two audit rows to reconcile and no new information in
// either.
//
// The recommendation from filing therefore stands. What changed on this upload
// is not the assessment; it is that the file is no longer waiting on the
// claimant. That is a status fact, and a status fact is all that is written.

/** Why the claim did not come out of `documents_needed`, when it did not. */
export type DocumentCompletionReason =
  | 'claim_not_found'
  | 'records_unavailable'
  | 'documents_outstanding'
  | 'claim_already_decided'
  | 'not_awaiting_documents'
  | 'status_write_failed'
  | 'status_superseded';

export interface DocumentCompletionOutcome {
  /** True only when the claim now stands at `under_review` because of this run. */
  advanced: boolean;
  reason: DocumentCompletionReason | null;
  claim_number: string | null;
  status_before: string | null;
  /**
   * Typed as the one literal on purpose. There is no assignment in this
   * function that could put another value here, and the type says so.
   */
  status_after: 'under_review' | null;
  documents_required: string[];
  documents_received: string[];
  /** Empty when the file is complete. Non-empty is why nothing moved. */
  documents_missing: string[];
}

export interface DocumentCompletionDeps {
  recordEvent?: JourneyRecorder;
}

function completion(partial: Partial<DocumentCompletionOutcome>): DocumentCompletionOutcome {
  return {
    advanced: false,
    reason: null,
    claim_number: null,
    status_before: null,
    status_after: null,
    documents_required: [],
    documents_received: [],
    documents_missing: [],
    ...partial,
  };
}

/**
 * After a document upload lands, take the claim out of `documents_needed` if
 * the file is now complete.
 *
 * Call this *after* whatever writes `claims.documents_received` — in the upload
 * route that means after the evidence pipeline, so the row read below already
 * contains the document that has just been attested. Reading it any earlier
 * would test the file as it stood before the upload and never complete.
 *
 * Completeness here means one thing exactly: every type named in
 * `documents_required` now appears in `documents_received`. It is a check on
 * *presence*, not on content — see the journey event below, which says so on
 * the timeline rather than letting a reader assume otherwise.
 *
 * Never resolves to `approved` or `denied`.
 */
export async function advanceClaimOnDocumentsComplete(
  supabase: SupabaseClient,
  deps: DocumentCompletionDeps,
  claimId: string
): Promise<DocumentCompletionOutcome> {
  const record = async (eventType: string, detail: Record<string, unknown>) => {
    if (!deps.recordEvent) return;
    try {
      await deps.recordEvent({ eventType, detail });
    } catch (err) {
      // Same rule as the sibling: the recorder is contracted never to throw,
      // and a lost event must not be allowed to lose the step it describes if
      // that contract is ever broken.
      console.error(
        'advanceClaimOnDocumentsComplete: journey event was not recorded:',
        err
      );
    }
  };

  // --- The claim as it stands now -----------------------------------------
  // Read fresh, for the same reason as in triage: the upload route knows what
  // it just wrote, but it does not know what a reviewer did while the bytes
  // were being hashed and archived, and the guards below are only worth
  // anything against the current row.
  const { data: claimRow, error: claimError } = await supabase
    .from('claims')
    .select('id, claim_number, status, documents_required, documents_received')
    .eq('id', claimId)
    .maybeSingle();

  if (claimError && !isNotFound(claimError)) {
    console.error('advanceClaimOnDocumentsComplete: claim lookup failed:', claimError);
    return completion({ reason: 'records_unavailable' });
  }
  if (!claimRow) {
    return completion({ reason: 'claim_not_found' });
  }

  const claim = claimRow as unknown as {
    id: string;
    claim_number: string;
    status: string | null;
    documents_required: string[] | null;
    documents_received: string[] | null;
  };
  const statusBefore = claim.status ?? null;
  const required = claim.documents_required ?? [];
  const received = claim.documents_received ?? [];
  const missing = required.filter((doc) => !received.includes(doc));

  const seen = completion({
    claim_number: claim.claim_number,
    status_before: statusBefore,
    documents_required: required,
    documents_received: received,
    documents_missing: missing,
  });

  // --- The line this path may not cross ------------------------------------
  // Checked before anything else about documents, because a decided, paid or
  // closed claim is finished with this question entirely. Uploading a file
  // against a claim a reviewer has already denied must not walk it back into
  // the review queue and erase that answer from the row the dashboard reads.
  if (statusBefore && AUTO_TRIAGE_IMMOVABLE_STATUSES.has(statusBefore)) {
    return { ...seen, reason: 'claim_already_decided' };
  }

  // --- Still short ----------------------------------------------------------
  // A partial upload changes nothing. The claim stays exactly where it is and
  // no event is written: "two of three documents have arrived" is already
  // visible from the document rows themselves, and a timeline entry per upload
  // would bury the one entry that matters.
  //
  // Note that `missing` is computed from `documents_required` alone, so a type
  // that is not on that list cannot complete the file however many of them
  // arrive. (The upload route refuses those at the door — see
  // `claim-documents-service.ts` gate 6 — and this is the second lock.)
  if (missing.length > 0) {
    return { ...seen, reason: 'documents_outstanding' };
  }

  // --- Complete, but not waiting on the claimant ---------------------------
  // A claim already in `under_review` (or still `submitted`, if triage has not
  // caught up) is not disturbed. This path exists to end one specific wait,
  // and it has no opinion about a claim that is not in it.
  if (statusBefore !== 'documents_needed') {
    return { ...seen, reason: 'not_awaiting_documents' };
  }

  // --- Out of the waiting room ---------------------------------------------
  // Compare-and-set on the status that was read, exactly as triage does. If a
  // reviewer decided the claim in the gap between the read above and this
  // write, their decision wins and this task leaves it alone. `.select()` is
  // what makes a zero-row update visible — PostgREST reports a filter that
  // matched nothing as a plain success.
  const { data: updated, error: statusError } = await supabase
    .from('claims')
    .update({ status: 'under_review' })
    .eq('id', claim.id)
    .eq('status', statusBefore)
    .select('id');

  if (statusError) {
    // Reported, never swallowed. The document is recorded and attested; the
    // claim is not where it should be. The caller decides what to say about
    // that, but it must not be told everything succeeded.
    console.error(
      `advanceClaimOnDocumentsComplete: ${claim.claim_number} has a complete file but was not moved to under_review:`,
      statusError
    );
    return { ...seen, reason: 'status_write_failed' };
  }

  if ((updated ?? []).length === 0) {
    console.warn(
      `advanceClaimOnDocumentsComplete: ${claim.claim_number} moved off 'documents_needed' while the upload was being processed; leaving it where it is.`
    );
    return { ...seen, reason: 'status_superseded' };
  }

  // --- Say what was and was not checked ------------------------------------
  // Recorded after the write, like `documents_requested` above, so the event
  // only ever describes a move that actually happened.
  //
  // `contents_inspected: false` is the load-bearing field. This system checked
  // that a document of the right *type* arrived and hashed its bytes; it never
  // read what the document says. A timeline entry reading "documents
  // completed" beside a claim in `under_review` would otherwise invite exactly
  // the wrong inference — that something verified the police report is a
  // police report, or that the repair estimate matches the damage described.
  // Nothing did. A real insurer's intake works the same way: presence is
  // checked by the system, contents by an adjuster. Stating the boundary is
  // honest, not apologetic, and the person who reads this claim next is the
  // one who inspects the contents.
  await record('documents_completed', {
    claim_number: claim.claim_number,
    documents_required: required,
    documents_received: received,
    completeness_checked: true,
    contents_inspected: false,
    status_before: statusBefore,
    status_after: 'under_review',
    // The assessment from filing stands; no model was called. See the block
    // comment above for why re-adjudicating would add a timestamp and nothing
    // else.
    readjudicated: false,
  });

  return { ...seen, advanced: true, status_after: 'under_review' };
}

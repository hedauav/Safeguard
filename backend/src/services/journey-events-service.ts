import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Who or what performed a step.
 *
 * Closed, and mirrored by the CHECK constraint in migration 0021. The four
 * values are not interchangeable labels: conflating 'human' with 'agent' would
 * let a rendered timeline claim that a person approved something a model did,
 * which is the single worst sentence this table could be made to say.
 *
 *   'agent'    the voice agent, acting on a live call
 *   'system'   this backend, acting unattended (auto-adjudication, a job)
 *   'human'    a named person, e.g. a reviewer in the approval queue
 *   'provider' an outside party telling us something — a Razorpay webhook
 */
export type JourneyActor = 'agent' | 'system' | 'human' | 'provider';

const JOURNEY_ACTORS: readonly string[] = ['agent', 'system', 'human', 'provider'];

export interface JourneyEventInput {
  /** At least one of claimId / policyId must be given. */
  claimId?: string | null;
  /** At least one of claimId / policyId must be given. */
  policyId?: string | null;
  /**
   * What happened — `claim_filed`, `renewal_failed`, `deductible_paid`, and so
   * on. Deliberately an open vocabulary, not a union: see migration 0021.
   */
  eventType: string;
  actor: JourneyActor;
  /**
   * Small, render-only payload for the timeline: an amount, a reference, the
   * reason a step was refused. Never the authoritative copy of anything — the
   * per-step table owns that.
   */
  detail?: Record<string, unknown>;
  callLogId?: string | null;
  /**
   * When the step actually happened, if that is not now. A webhook records a
   * capture the rail timestamped earlier, and a retried delivery records it
   * later still; the timeline orders by this, while `created_at` keeps the
   * audit fact of when we learned of it. Defaults to now.
   *
   * Additive to the agreed contract — every call that omits it behaves exactly
   * as the contract specifies.
   */
  occurredAt?: string | Date | null;
}

/**
 * Append one row to the claim/policy journey.
 *
 * ## This function never throws. That is its most important property.
 *
 * Six separate call sites record events, and every one of them is recording a
 * step that has ALREADY HAPPENED — a claim filed, money captured, a policy put
 * back in force. If writing the journal entry could throw, then a journey_events
 * outage, an unapplied migration 0021, or a transient PostgREST error would
 * propagate up and abort the step that was being recorded. A claim the caller
 * was already told was filed would be lost because we could not write down that
 * we had filed it.
 *
 * So: a lost event must never lose the step it was recording. Every failure —
 * a refused input, a database error, a client that throws outright — is logged
 * and swallowed. The log line is the compensating control, and it names the
 * event that went missing so it can be reconstructed from the per-step tables.
 *
 * The one thing this does NOT do is retry. A retry loop inside a call path
 * would trade a lost event for a stalled call, which is the worse of the two.
 *
 * Callers may `await` it or attach it to a background `.catch()`; both are
 * safe, because there is nothing to catch.
 */
export async function recordJourneyEvent(
  supabase: SupabaseClient,
  event: JourneyEventInput
): Promise<void> {
  try {
    const claimId = event.claimId ?? null;
    const policyId = event.policyId ?? null;
    const eventType = typeof event.eventType === 'string' ? event.eventType.trim() : '';

    // Refused locally rather than sent to be rejected by the CHECK constraint,
    // so the log names the bad field instead of quoting a Postgres constraint
    // name. Nothing is written: an event belonging to neither a claim nor a
    // policy would sit in the table forever, appearing on no timeline.
    if (!claimId && !policyId) {
      console.error(
        `recordJourneyEvent: refusing '${eventType || '(blank)'}' — it names neither a claim nor a policy, so no timeline could ever show it.`
      );
      return;
    }

    if (!eventType) {
      console.error(
        `recordJourneyEvent: refusing an event with a blank event_type (claim ${claimId ?? 'none'}, policy ${policyId ?? 'none'}).`
      );
      return;
    }

    if (!JOURNEY_ACTORS.includes(event.actor)) {
      console.error(
        `recordJourneyEvent: refusing '${eventType}' — unknown actor ${JSON.stringify(event.actor)}. Expected one of ${JOURNEY_ACTORS.join(', ')}.`
      );
      return;
    }

    const occurredAt =
      event.occurredAt instanceof Date
        ? event.occurredAt.toISOString()
        : (event.occurredAt ?? new Date().toISOString());

    const { error } = await supabase.from('journey_events').insert({
      claim_id: claimId,
      policy_id: policyId,
      event_type: eventType,
      actor: event.actor,
      detail: event.detail ?? {},
      occurred_at: occurredAt,
      call_log_id: event.callLogId ?? null,
    });

    if (error) {
      // Deliberately loud and complete: this line is the only remaining record
      // that the step happened at all, so it carries everything needed to
      // reconstruct the row by hand.
      console.error(
        `recordJourneyEvent: '${eventType}' not recorded (claim ${claimId ?? 'none'}, policy ${policyId ?? 'none'}, actor ${event.actor}):`,
        error
      );
    }
  } catch (err) {
    // A client that throws rather than returning { error } — a network reset,
    // a malformed URL, a mocked client in a test. Same rule: the step stands.
    console.error('recordJourneyEvent: threw while recording an event; the step it described still happened:', err);
  }
}

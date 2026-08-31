import { SupabaseClient } from '@supabase/supabase-js';
import { randomInt } from 'crypto';

/** PostgreSQL unique_violation — the escalations.reference_number index firing. */
const UNIQUE_VIOLATION = '23505';

/** Bounded so a persistently failing insert refuses rather than looping. */
const MAX_REFERENCE_ATTEMPTS = 3;

const VALID_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

// The spoken SLA table lived here — "within 1 business hour" and so on. It was
// removed from what the caller is told because nothing in this system assigns,
// works or closes an escalation, so it was a commitment no code kept; see the
// note above the priority tests in escalation-service.test.ts. The table itself
// outlived its last caller and is gone now too.

/**
 * A reference the agent reads aloud and a supervisor can look up.
 *
 * Eight digits from a CSPRNG rather than four from `Math.random()`: the old
 * form had a 10,000-value space, so a day with a few dozen escalations was
 * already likely to hand two callers the same number. The shape stays speakable
 * and matches the canonical `PREFIX-YEAR-SERIAL` form the lookup normaliser
 * understands, so a caller reading it back without the dashes still resolves.
 *
 * Uniqueness is not assumed — the column carries a unique constraint and the
 * insert below retries on a collision.
 */
export function generateEscalationReference(now: Date = new Date()): string {
  const serial = String(randomInt(0, 100_000_000)).padStart(8, '0');
  return `ESC-${now.getFullYear()}-${serial}`;
}

export interface EscalationCreated {
  success: true;
  reference_number: string;
  message: string;
}

export interface EscalationRefused {
  success: false;
  message: string;
}

export type EscalationResult = EscalationCreated | EscalationRefused;

function refuse(message: string): EscalationRefused {
  return { success: false, message };
}

export async function createEscalation(
  supabase: SupabaseClient,
  data: {
    reason: string;
    priority?: string;
    call_log_id?: string;
    customer_id?: string;
    claim_id?: string;
  }
): Promise<EscalationResult> {
  // Trim reason to avoid whitespace-only strings
  const reason = (data.reason || '').trim();

  // Validate priority (default to 'normal')
  const priority = VALID_PRIORITIES.includes((data.priority || '') as any)
    ? data.priority!
    : 'normal';

  // An escalation raised outside a call simply has no call attached. The
  // previous version invented a `call_logs` row to satisfy a NOT NULL foreign
  // key, which meant every escalation minted a call that never happened —
  // rows with no `ended_at` that sat in the dashboard as calls in progress
  // forever and inflated the analytics. A null is honest; a fabricated call
  // record is the exact class of artifact this system exists to not produce.
  const callLogId = data.call_log_id || null;

  for (let attempt = 1; attempt <= MAX_REFERENCE_ATTEMPTS; attempt++) {
    const referenceNumber = generateEscalationReference();

    const { error } = await supabase.from('escalations').insert({
      call_log_id: callLogId,
      reference_number: referenceNumber,
      reason,
      priority,
      status: 'pending',
      customer_id: data.customer_id || null,
      claim_id: data.claim_id || null,
      notes: callLogId
        ? 'Escalated during live call.'
        : 'Escalated outside a call.',
    });

    if (!error) {
      return {
        success: true,
        reference_number: referenceNumber,
        // The priority is real and stored; the response window was not. Nothing
        // in this system assigns, works or closes an escalation, so a spoken
        // "you can expect a response within X" was a commitment no code keeps.
        // Say what was recorded and how it was flagged, and stop there.
        message: `I've recorded this for a supervisor at ${priority} priority. Your reference number is ${referenceNumber}.`,
      };
    }

    // A reference collision is recoverable and means nothing about the
    // database's health, so it is the one error worth another attempt.
    if (error.code === UNIQUE_VIOLATION && attempt < MAX_REFERENCE_ATTEMPTS) {
      console.warn(
        `Escalation: reference ${referenceNumber} already taken, retrying (attempt ${attempt} of ${MAX_REFERENCE_ATTEMPTS})`
      );
      continue;
    }

    if (error.code === UNIQUE_VIOLATION) {
      console.error(
        `Escalation: could not find a free reference number in ${MAX_REFERENCE_ATTEMPTS} attempts`,
        error
      );
      return refuse(
        'I was unable to raise the escalation just now. Nothing has been lost — please try again in a moment, or stay on the line and I will try once more.'
      );
    }

    console.error('Escalation: insert failed:', error);
    return refuse('I was unable to create the escalation. Please try again.');
  }

  // Unreachable: the loop either returns or exhausts into the branch above.
  return refuse('I was unable to create the escalation. Please try again.');
}

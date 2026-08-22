import type { PostgrestError } from '@supabase/supabase-js';

/**
 * Supabase returns this code from `.single()` when the query matched no rows.
 * Any other error is a genuine fault (network, auth, schema), which must not
 * be reported to a caller as "not found" — telling someone their real policy
 * does not exist during an outage is worse than admitting the outage.
 */
const NO_ROWS_RETURNED = 'PGRST116';

export function isNotFound(error: PostgrestError | null): boolean {
  return error?.code === NO_ROWS_RETURNED;
}

/** A lookup failed for a reason other than the record being absent. */
export interface LookupUnavailable {
  found: false;
  unavailable: true;
  message: string;
}

export function unavailable(subject: string): LookupUnavailable {
  return {
    found: false,
    unavailable: true,
    message: `I'm having trouble reaching our ${subject} records right now. Let me try again, or I can connect you with a representative.`,
  };
}

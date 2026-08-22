/**
 * Normalisation for claim and policy numbers spoken over the phone.
 *
 * Speech-to-text rarely produces the dashes: "C L M 2026 000456" comes through
 * as "CLM2026000456", which matches nothing on an exact lookup. Rather than
 * make the agent retry with different spellings, canonicalise the input before
 * querying.
 */

/** Canonical shape: three letters, a four-digit year, then a six-digit serial. */
const CANONICAL = /^([A-Z]{2,4})[-\s]?(\d{4})[-\s]?(\d{4,8})$/;

/**
 * Candidate spellings to try, most likely first, without duplicates.
 * Always includes the trimmed original so unusual formats still work.
 */
export function referenceCandidates(input: string): string[] {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return [];

  const candidates: string[] = [trimmed];

  // Strip separators and normalise case, then re-insert the dashes.
  const compact = trimmed.toUpperCase().replace(/[\s_.‐-―-]/g, '');
  const match = CANONICAL.exec(compact);
  if (match) {
    candidates.push(`${match[1]}-${match[2]}-${match[3]}`);
  }

  // An uppercased form helps when only the case was wrong.
  candidates.push(trimmed.toUpperCase());

  return Array.from(new Set(candidates.filter(Boolean)));
}

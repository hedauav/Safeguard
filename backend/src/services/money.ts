/**
 * The two money conversions every service in the claim path needs.
 *
 * These were copy-pasted into five files. That is survivable for a string
 * helper and dangerous for a money one: the copies drift, and the first
 * symptom of drift is a settlement that is a few paise off the deductible
 * refund taken against it, which nobody notices until a reconciliation run
 * says the two ledgers disagree. One definition, imported everywhere, is the
 * only way the arithmetic in `computeSettlement`, `computeRenewalAmount` and
 * `computeDeductible` can be reasoned about together.
 *
 * Deliberately not here: `toPaise`. Two incompatible versions of that name
 * exist in this codebase — the services parse with `parseInt`, clamp anything
 * non-positive to 0 and return a plain `number`; the read-only verification
 * routes parse with `Number`, keep negatives, and return `null` for an absent
 * column so a missing figure can be told apart from a genuine zero. Both are
 * correct for their caller and merging them under one name would silently
 * change a total on one side or the other. They stay where they are until
 * somebody gives them two different names on purpose.
 */

/**
 * Postgres NUMERIC arrives over PostgREST as a string, so arithmetic on the
 * raw column silently concatenates. Everything monetary goes through here.
 */
export function toAmount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Snap to whole paise. Rupee amounts are computed by subtraction and division
 * — a capture read back as `capturedAmountPaise / 100` — and binary floating
 * point turns those into figures like 2499.9999999999995. Rounding at the
 * boundary keeps what is written to a NUMERIC column and what is quoted to the
 * customer the same number.
 */
export function toCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

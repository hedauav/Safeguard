/**
 * How money is rendered in the dashboard.
 *
 * Every amount this application handles is rupees. `settlement-service.ts`
 * converts a settlement with `amountPaise: Math.round(settlement * 100)` and
 * asks the rail for INR; the deductible link, the capture and the refund are
 * all INR through Razorpay. There is no second currency anywhere in the money
 * path.
 *
 * The dashboard nevertheless rendered `$` in four places — a hardcoded dollar
 * sign in front of a rupee figure, on the claim list, the claim detail, the
 * policy panel and the review queue. That is not a cosmetic slip. A reviewer
 * approving a settlement reads the number they are approving, and a claim
 * shown as "$32,000" against a policy whose real cover is ₹8,50,000 misstates
 * both the payout and the limit it sits inside by roughly ninety times.
 *
 * The one place that already got this right is CallWidget, which formats using
 * the currency the agent actually supplied rather than assuming. It stays as
 * it is: a tool result carries its own currency code, so it should be trusted
 * over any default. This module is for the amounts read straight out of the
 * database columns, where the currency is not carried alongside and INR is the
 * only thing they have ever been.
 */

/**
 * Indian digit grouping — ₹8,50,000, not ₹850,000. Lakhs and crores are how
 * the figures in this book of business are actually written and spoken, and a
 * demo read aloud to an Indian audience should group them the same way.
 *
 * No paise. Every amount in these columns is a whole number of rupees, and two
 * trailing zeroes on every row is noise that makes the column harder to scan.
 */
const RUPEES = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/**
 * An amount in rupees, or a placeholder when there is not one.
 *
 * Null and undefined render as the em dash rather than as ₹0. A claim with no
 * approved amount has not been approved for nothing — it has not been approved
 * yet, and the two must not look the same in a column somebody is scanning for
 * what still needs a decision.
 *
 * A value that is not a finite number renders as the placeholder too. Postgres
 * NUMERIC arrives over PostgREST as a string, so this is handed '32000' as
 * often as 32000; Number() covers that, and anything it cannot parse is a bug
 * upstream that should show as missing rather than as NaN.
 */
export function rupees(value: number | string | null | undefined, placeholder = '—'): string {
  if (value === null || value === undefined || value === '') return placeholder;
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) return placeholder;
  return RUPEES.format(amount);
}

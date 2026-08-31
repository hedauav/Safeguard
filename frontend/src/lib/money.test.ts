import { expect, test } from 'vitest'
import { rupees } from './money'

/**
 * These exist because the dashboard once rendered `$` in front of rupee
 * figures in four places, which misstated a payout and the limit it sat inside
 * by roughly ninety times. The formatting is not cosmetic here: a reviewer
 * approves the number they are shown.
 *
 * The assertions deliberately check properties rather than whole strings.
 * Intl's exact spacing around the symbol varies between ICU versions, and a
 * test that pins it would fail on a different Node without anything being
 * wrong.
 */

test('an amount is grouped the Indian way, in lakhs rather than thousands', () => {
  expect(rupees(850000)).toContain('8,50,000')
  expect(rupees(850000)).not.toContain('850,000')
})

test('an amount carries the rupee symbol and never a dollar sign', () => {
  const rendered = rupees(32000)
  expect(rendered).toContain('₹')
  expect(rendered).not.toContain('$')
})

test('paise are not shown, because every column here holds whole rupees', () => {
  expect(rupees(1000)).not.toContain('.')
})

test('a string amount renders the same as the number it represents', () => {
  // Postgres NUMERIC arrives over PostgREST as a string, so this function is
  // handed '32000' as often as 32000.
  expect(rupees('32000')).toBe(rupees(32000))
})

test('nothing at all renders as the placeholder, never as zero', () => {
  // A claim with no approved amount has not been approved for nothing — it has
  // not been approved yet, and a column being scanned for what still needs a
  // decision must not show the two the same way.
  expect(rupees(null)).toBe('—')
  expect(rupees(undefined)).toBe('—')
  expect(rupees('')).toBe('—')
})

test('a genuine zero renders as zero and not as the placeholder', () => {
  const rendered = rupees(0)
  expect(rendered).not.toBe('—')
  expect(rendered).toContain('0')
})

test('an unparseable value shows as missing rather than as NaN', () => {
  expect(rupees('not a number')).toBe('—')
  expect(rupees(Number.NaN)).toBe('—')
  expect(rupees(Number.POSITIVE_INFINITY)).toBe('—')
})

test('the placeholder can be overridden without affecting a real amount', () => {
  expect(rupees(null, 'not set')).toBe('not set')
  expect(rupees(500, 'not set')).toContain('500')
})

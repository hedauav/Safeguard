import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAmount, toCurrency } from './money.js';

// --- toAmount ---------------------------------------------------------------

test('a NUMERIC column arriving as a string is still arithmetic', () => {
  // PostgREST serialises NUMERIC as a string; '3000.50' - 500 would be NaN.
  assert.equal(toAmount('3000.50'), 3000.5);
  assert.equal(toAmount('3000.50') - toAmount('500.00'), 2500.5);
});

test('a number is passed through untouched', () => {
  assert.equal(toAmount(3000.5), 3000.5);
});

test('a missing amount reads as zero rather than NaN', () => {
  assert.equal(toAmount(null), 0);
  assert.equal(toAmount(undefined), 0);
  assert.equal(toAmount(''), 0);
});

test('a value that is not a number at all reads as zero, never NaN', () => {
  // NaN leaking into a total makes every figure downstream NaN, and a page
  // rendering 'NaN' is less recoverable than one rendering a wrong zero.
  assert.equal(toAmount('not an amount'), 0);
  assert.equal(toAmount({}), 0);
  assert.equal(toAmount(NaN), 0);
  assert.equal(toAmount(Infinity), 0);
});

test('zero is preserved as zero and is not treated as missing', () => {
  assert.equal(toAmount(0), 0);
  assert.equal(toAmount('0.00'), 0);
});

test('a negative amount is carried through, not clamped', () => {
  // Clamping belongs to the callers — computeSettlement floors its own result
  // at zero — so a refund overshoot stays visible to whoever is checking it.
  assert.equal(toAmount(-500), -500);
  assert.equal(toAmount('-500.25'), -500.25);
});

// --- toCurrency -------------------------------------------------------------

test('a subtraction that lands just short of a whole paise is snapped back', () => {
  // computeSettlement is claim - coverage cap - deductible, and binary floats
  // turn that into 0.599999999999909 rather than 0.60. Unrounded, that is what
  // gets written to a NUMERIC column and quoted to the customer.
  assert.equal(3000.5 - 500 - 2499.9, 0.599999999999909);
  assert.equal(toCurrency(3000.5 - 500 - 2499.9), 0.6);
  assert.equal(toCurrency(0.1 + 0.2), 0.3);
});

test('a third decimal place rounds to the nearer paise', () => {
  assert.equal(toCurrency(1.234), 1.23);
  assert.equal(toCurrency(1.236), 1.24);
});

test('an exact half paise rounds up, not to even', () => {
  assert.equal(toCurrency(0.125), 0.13);
});

test('zero rounds to zero and a negative keeps its sign', () => {
  assert.equal(toCurrency(0), 0);
  assert.equal(toCurrency(-1.236), -1.24);
});

test('an amount already in whole paise is left exactly as it is', () => {
  assert.equal(toCurrency(2500), 2500);
  assert.equal(toCurrency(2500.5), 2500.5);
});

// --- The round trip ---------------------------------------------------------

test('rupees converted to paise and back are the same figure', () => {
  // The rail is quoted amountPaise: Math.round(amount * 100) and answers in
  // paise; every figure shown to a customer comes back through toCurrency. A
  // drift of one paise here is a settlement that will not reconcile.
  for (const rupees of [0, 0.01, 1, 99.99, 2500.5, 8500.05, 850000, 123456.78]) {
    const paise = Math.round(rupees * 100);
    assert.equal(toCurrency(paise / 100), rupees, `round trip failed for ${rupees}`);
  }
});

test('a string amount survives the round trip through the rail', () => {
  const paise = Math.round(toAmount('8500.05') * 100);
  assert.equal(paise, 850005);
  assert.equal(toCurrency(paise / 100), 8500.05);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { referenceCandidates } from './reference-number.js';

test('recovers the dashed form from a number spoken without dashes', () => {
  // Exactly what arrived from a real call transcript.
  const candidates = referenceCandidates('CLM2026000456');
  assert.ok(candidates.includes('CLM-2026-000456'));
});

test('handles spaces and lowercase', () => {
  assert.ok(referenceCandidates('clm 2026 000456').includes('CLM-2026-000456'));
  assert.ok(referenceCandidates('CLM 2026 000456').includes('CLM-2026-000456'));
});

test('leaves an already-correct number first in the list', () => {
  assert.equal(referenceCandidates('CLM-2026-000456')[0], 'CLM-2026-000456');
});

test('works for policy numbers too', () => {
  assert.ok(referenceCandidates('POL2024001234').includes('POL-2024-001234'));
});

test('always keeps the original so unusual formats still resolve', () => {
  assert.ok(referenceCandidates('  weird-format-99  ').includes('weird-format-99'));
});

test('returns nothing for empty input', () => {
  assert.deepEqual(referenceCandidates(''), []);
  assert.deepEqual(referenceCandidates('   '), []);
});

test('does not invent dashes for something that is not a reference number', () => {
  assert.ok(!referenceCandidates('hello').some((c) => c.includes('-')));
});

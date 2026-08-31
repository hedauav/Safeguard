import { expect, test } from 'vitest'
import {
  FAULT_CHOICES,
  REFRESH_INTERVAL_MS,
  mergeQueue,
  provenanceOf,
} from './helpers'
import type { Adjudication, ReviewQueueItem, ReviewQueueResponse } from '../../types'

/**
 * The pure half of the review queue — the screen where a human decides a claim
 * and where a fault finding can waive money. Nothing here touches React or the
 * network, which is why it can be checked at all.
 */

function adjudication(over: Partial<Adjudication> = {}): Adjudication {
  return {
    id: 'adj-1',
    claim_id: 'claim-1',
    claim_number: 'CLM-2026-000456',
    verdict: 'escalate',
    confidence: 1,
    computed_payable_amount: 0,
    model_proposed_amount: null,
    amount_agreement: 'not_proposed',
    policy_clauses: [],
    inconsistencies: [],
    checks: [],
    vetoed_by: null,
    model_invoked: false,
    model_provider: null,
    model_id: null,
    model_latency_ms: null,
    simulated: false,
    parse_error: null,
    ...over,
  } as Adjudication
}

function item(id: string, over: Partial<Adjudication> = {}): ReviewQueueItem {
  return {
    adjudication: adjudication({ id, ...over }),
    claim: {
      id: `claim-${id}`,
      claim_number: `CLM-${id}`,
      status: 'under_review',
      claimed_amount: 1000,
      customer_name: 'A Claimant',
    },
  } as ReviewQueueItem
}

function response(items: ReviewQueueItem[], over: Partial<ReviewQueueResponse> = {}): ReviewQueueResponse {
  return {
    data: items,
    total: items.length,
    state: 'pending',
    limit: 50,
    scanned: items.length,
    scan_cap: 500,
    truncated: false,
    claims_with_adjudication: items.length,
    claims_total: items.length,
    claims_never_adjudicated: 0,
    pending_count: items.length,
    decided_count: 0,
    reviews_available: true,
    reviews_unavailable_reason: null,
    decisions_enabled: true,
    error: null,
    ...over,
  } as ReviewQueueResponse
}

// --- provenanceOf: three mutually exclusive states -------------------------

test('a rule veto is reported as a veto even though no model was invoked', () => {
  // Both conditions are true of a vetoed row, so the order of the checks is
  // the behaviour: a veto must not read as an unusable model.
  const a = adjudication({ vetoed_by: 'policy_not_cancelled', model_invoked: false })
  expect(provenanceOf(a)).toBe('rule_veto')
})

test('a model that was never invoked is unusable rather than spoken', () => {
  expect(provenanceOf(adjudication({ model_invoked: false }))).toBe('model_unusable')
})

test('a model that answered unparseably is unusable even though it was invoked', () => {
  const a = adjudication({ model_invoked: true, parse_error: 'not json' })
  expect(provenanceOf(a)).toBe('model_unusable')
})

test('only a clean invocation is reported as the model having spoken', () => {
  const a = adjudication({ model_invoked: true, parse_error: null })
  expect(provenanceOf(a)).toBe('model_spoke')
})

// --- FAULT_CHOICES: the table that can waive money -------------------------

test('exactly one fault finding waives the deductible', () => {
  const waiving = FAULT_CHOICES.filter((c) => c.waives)
  expect(waiving).toHaveLength(1)
  expect(waiving[0].key).toBe('other_party')
})

test('shared fault does not waive, deliberately rather than by omission', () => {
  expect(FAULT_CHOICES.find((c) => c.key === 'shared')?.waives).toBe(false)
})

test('the unset choice is never sent on the wire', () => {
  // 'unset' is this page's word for the absence of a choice. The server
  // validates against a closed list and refuses an unrecognised value by name,
  // so a label that leaked onto the request would be a 400, not a coercion.
  const unset = FAULT_CHOICES.find((c) => c.key === 'unset')
  expect(unset?.wire).toBe('omitted from the request')
  expect(unset?.waives).toBe(false)
})

test('every sendable choice carries the literal string the server validates', () => {
  const sendable = FAULT_CHOICES.filter((c) => c.key !== 'unset')
  const accepted = ['other_party', 'insured', 'shared', 'undetermined']
  expect(sendable.map((c) => c.wire).sort()).toEqual([...accepted].sort())
  // The key and the wire value must not drift apart: the label on the button
  // and the value in the audit record are the same decision.
  for (const choice of sendable) expect(choice.wire).toBe(choice.key)
})

test('every choice explains its consequence, because one of them moves money', () => {
  for (const choice of FAULT_CHOICES) {
    expect(choice.label.length).toBeGreaterThan(0)
    expect(choice.consequence.length).toBeGreaterThan(0)
  }
})

// --- mergeQueue: a refresh must not move the row somebody is working in ----

test('with nothing on screen yet the fresh read is taken whole', () => {
  const next = response([item('a'), item('b')])
  expect(mergeQueue(null, next, 'a')).toBe(next)
})

test('with no row pinned the fresh read is taken whole', () => {
  const prev = response([item('a')])
  const next = response([item('b')])
  expect(mergeQueue(prev, next, null)).toBe(next)
})

test('a pinned row that was never on screen does not hold anything back', () => {
  const prev = response([item('a')])
  const next = response([item('b')])
  expect(mergeQueue(prev, next, 'ghost')).toBe(next)
})

test('the pinned row keeps the object it had, not the one the refresh brought', () => {
  const held = item('a', { verdict: 'escalate' })
  const prev = response([held, item('b')])
  const next = response([item('a', { verdict: 'approve' }), item('b')])

  const merged = mergeQueue(prev, next, 'a')
  const pinned = merged.data.find((i) => i.adjudication.id === 'a')

  // Identity, not just equality: a reviewer half-way through a note must not
  // have the row swapped underneath them for a decided panel.
  expect(pinned).toBe(held)
  expect(pinned?.adjudication.verdict).toBe('escalate')
})

test('the pinned row keeps its position even when the refresh reorders around it', () => {
  const prev = response([item('a'), item('b'), item('c')])
  const next = response([item('c'), item('b'), item('a')])

  const merged = mergeQueue(prev, next, 'b')
  expect(merged.data.findIndex((i) => i.adjudication.id === 'b')).toBe(1)
  expect(merged.data.map((i) => i.adjudication.id)).toEqual(['a', 'b', 'c'])
})

test('rows other than the pinned one take the fresh data', () => {
  const prev = response([item('a', { verdict: 'escalate' }), item('b', { verdict: 'escalate' })])
  const next = response([item('a', { verdict: 'escalate' }), item('b', { verdict: 'approve' })])

  const merged = mergeQueue(prev, next, 'a')
  expect(merged.data.find((i) => i.adjudication.id === 'b')?.adjudication.verdict).toBe('approve')
})

test('a row the refresh added goes on the end rather than shuffling in above', () => {
  const prev = response([item('a'), item('b')])
  const next = response([item('new'), item('a'), item('b')])

  const merged = mergeQueue(prev, next, 'a')
  expect(merged.data.map((i) => i.adjudication.id)).toEqual(['a', 'b', 'new'])
})

test('a row the refresh dropped disappears unless it is the pinned one', () => {
  const prev = response([item('a'), item('b')])
  const next = response([item('a')])

  const merged = mergeQueue(prev, next, 'a')
  expect(merged.data.map((i) => i.adjudication.id)).toEqual(['a'])
})

test('the pinned row survives even after the refresh stops returning it', () => {
  // Somebody else answering the held recommendation is handled by the server
  // returning 409 on submit, not by yanking the row out from under the cursor.
  const held = item('a')
  const prev = response([held, item('b')])
  const next = response([item('b')])

  const merged = mergeQueue(prev, next, 'a')
  expect(merged.data.find((i) => i.adjudication.id === 'a')).toBe(held)
})

test('counts and banners always come from the fresh read, never the held one', () => {
  const prev = response([item('a')], { pending_count: 1, total: 1, truncated: false })
  const next = response([item('a'), item('b')], {
    pending_count: 9,
    total: 9,
    truncated: true,
    decisions_enabled: false,
  })

  const merged = mergeQueue(prev, next, 'a')
  // The header must never be lying about what is out there, even while one row
  // is deliberately stale.
  expect(merged.pending_count).toBe(9)
  expect(merged.total).toBe(9)
  expect(merged.truncated).toBe(true)
  expect(merged.decisions_enabled).toBe(false)
})

test('merging never mutates what was already on screen', () => {
  const prev = response([item('a'), item('b')])
  const before = prev.data.map((i) => i.adjudication.id)

  mergeQueue(prev, response([item('b'), item('c')]), 'a')
  expect(prev.data.map((i) => i.adjudication.id)).toEqual(before)
})

// --- the refresh interval --------------------------------------------------

test('the queue re-reads itself on a half-minute, not on a tight loop', () => {
  // Slow enough to be free against a list endpoint that caps its own scan;
  // fast enough that a claim adjudicated while somebody is on this page shows
  // up before they leave it, which was the original bug.
  expect(REFRESH_INTERVAL_MS).toBe(30_000)
})

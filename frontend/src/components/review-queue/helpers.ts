import { rupees } from '../../lib/money'
import type {
  Adjudication, FaultDetermination, ReviewQueueResponse,
} from '../../types'

/**
 * The pure parts of the review queue: formatters, the tables the page reads
 * labels out of, the predicate that decides which engine produced a row, and
 * the merge that folds a background read into what is already on screen.
 *
 * Nothing here touches React, the network or the DOM, which is the point —
 * these are the pieces whose behaviour can be checked without a browser.
 */

export const CURRENCY = (value: number | null | undefined) =>
  rupees(value)

export const VERDICT_STYLE: Record<string, string> = {
  approve: 'bg-green-100 text-green-800 border-green-200',
  deny: 'bg-red-100 text-red-800 border-red-200',
  escalate: 'bg-amber-100 text-amber-800 border-amber-200',
}

/**
 * What a reviewer can say about fault, including saying nothing.
 *
 * `'unset'` is this page's word for the absence of a choice; it is never sent.
 * The other four are the literal strings `adjudication-review.ts` validates
 * against, written out here rather than assembled, because the server refuses
 * an unrecognised value by name instead of coercing it — and a fault finding
 * silently mapped onto the wrong word could waive money.
 *
 * `wire` is what actually goes on the request, shown to the reader so the
 * label on the button and the value in the audit record can be checked against
 * each other. Only `other_party` waives the deductible; `shared` does not, and
 * that is a rule of the policy rather than an oversight here.
 */
export type FaultChoice = FaultDetermination | 'unset'

export const FAULT_CHOICES: {
  key: FaultChoice
  label: string
  wire: string
  waives: boolean
  consequence: string
}[] = [
  {
    key: 'unset',
    label: 'Not recorded',
    wire: 'omitted from the request',
    waives: false,
    consequence:
      'Nothing is written to the claim. A claim with no fault finding on it can never have its deductible waived, so the excess stays with the policyholder until somebody records one — on this decision or a later one.',
  },
  {
    key: 'other_party',
    label: 'The other party',
    wire: 'other_party',
    waives: true,
    consequence:
      'The one finding that waives the deductible. If the claim has already been settled the refund is made now; otherwise it follows automatically when the claim settles. This is the only path in this system that moves money back out to the policyholder.',
  },
  {
    key: 'insured',
    label: 'Our policyholder',
    wire: 'insured',
    waives: false,
    consequence:
      'The deductible stands and is not returned. The finding is written to the claim and attributed to you.',
  },
  {
    key: 'shared',
    label: 'Shared',
    wire: 'shared',
    waives: false,
    consequence:
      'Shared fault does not waive the deductible — deliberately, not by omission. The excess stands.',
  },
  {
    key: 'undetermined',
    label: 'Looked into, undetermined',
    wire: 'undetermined',
    waives: false,
    consequence:
      'A recorded finding that fault could not be established. No refund follows. It differs from leaving this unrecorded in one way only, and it is the way that matters to whoever reads the claim next: it says somebody looked.',
  },
]

/** Which of the three mutually exclusive provenance states a row is in. */
export type Provenance = 'rule_veto' | 'model_unusable' | 'model_spoke'

export function provenanceOf(a: Adjudication): Provenance {
  if (a.vetoed_by) return 'rule_veto'
  if (a.parse_error || !a.model_invoked) return 'model_unusable'
  return 'model_spoke'
}

export type QueueState = 'pending' | 'decided' | 'all'

/**
 * How often the queue re-reads itself, in milliseconds.
 *
 * Thirty seconds, picked against how this queue is actually filled and read.
 * Claims arrive one at a time from a call that has just ended, so the thing
 * being waited for is a single row appearing — not a stream. Reading the
 * working on one recommendation takes a reviewer tens of seconds at least, so
 * half a minute is short enough that a claim adjudicated while somebody is on
 * this page shows up before they leave it, which is the whole bug: a reviewer
 * concluded a claim was missing when it was sitting in a queue that had
 * stopped asking. It is also slow enough to be free — two reads a minute per
 * open tab, against a list endpoint that caps its own scan — and the timer
 * stops entirely while the tab is hidden, so a screen left open overnight
 * costs nothing.
 */
export const REFRESH_INTERVAL_MS = 30_000

/**
 * Fold a fresh read into what is on screen without moving the row somebody is
 * working in.
 *
 * A background refresh has no mandate to interrupt. When a row is open the
 * reviewer may be halfway through a note, or have a fault finding selected and
 * not yet submitted, and both the row's contents and its position are things
 * their hand is already committed to. So the held row keeps its *previous*
 * object — not restamped, not relabelled, not swapped for a decided panel
 * underneath a half-typed note — and keeps its previous index; the rows around
 * it take the new data but keep the old order, and rows the refresh added go on
 * the end rather than shuffling in above. Counts and banners come from the
 * fresh read either way, so the header is never lying about what is out there.
 *
 * Holding stale data on that one row is safe precisely because the server does
 * not trust this page: if somebody else answered the held recommendation the
 * decision comes back 409, which this screen already explains as nothing
 * recorded and nothing broken. Collapsing the row unpins it and the next read
 * lands whole.
 */
export function mergeQueue(
  prev: ReviewQueueResponse | null,
  next: ReviewQueueResponse,
  pinnedId: string | null,
): ReviewQueueResponse {
  if (prev === null || pinnedId === null) return next
  if (!prev.data.some((i) => i.adjudication.id === pinnedId)) return next

  const fresh = new Map(next.data.map((i) => [i.adjudication.id, i]))
  const kept = prev.data
    .filter((i) => i.adjudication.id === pinnedId || fresh.has(i.adjudication.id))
    .map((i) => (i.adjudication.id === pinnedId ? i : fresh.get(i.adjudication.id) ?? i))

  const seen = new Set(kept.map((i) => i.adjudication.id))
  const added = next.data.filter((i) => !seen.has(i.adjudication.id))

  return { ...next, data: [...kept, ...added] }
}

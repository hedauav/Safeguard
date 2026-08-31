import { UserCheck } from 'lucide-react'
import type { AdjudicationReview } from '../../types'

/** The decision already on file, when there is one. */
export function DecidedPanel({ review }: { review: AdjudicationReview }) {
  const overrode =
    (review.decision === 'approved' && review.recommended_verdict !== 'approve') ||
    (review.decision === 'rejected' && review.recommended_verdict !== 'deny')

  return (
    <div className="rounded-lg border border-gray-300 bg-gray-50 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
        <UserCheck className="w-4 h-4" />
        {review.reviewer} {review.decision === 'approved' ? 'approved' : 'rejected'} this claim on{' '}
        {new Date(review.decided_at).toLocaleString()}
      </div>
      <dl className="mt-3 grid grid-cols-[11rem_1fr] gap-x-4 gap-y-1 text-xs text-gray-700">
        <dt className="text-gray-500">Recommendation then</dt>
        <dd className="font-mono">{review.recommended_verdict}</dd>
        <dt className="text-gray-500">Agreement</dt>
        <dd className={overrode ? 'text-amber-700 font-semibold' : ''}>
          {overrode ? 'The human went against the recommendation.' : 'The human agreed with the recommendation.'}
        </dd>
        <dt className="text-gray-500">Claim status</dt>
        <dd>
          {review.claim_status_after === null ? (
            <span className="text-amber-700">
              not changed by this decision (still <span className="font-mono">{review.claim_status_before ?? 'unknown'}</span>)
            </span>
          ) : (
            <>
              <span className="font-mono">{review.claim_status_before ?? 'unknown'}</span>
              {' → '}
              <span className="font-mono font-semibold">{review.claim_status_after}</span>
            </>
          )}
        </dd>
      </dl>
      {review.note && <p className="mt-2 text-sm text-gray-700 italic">&ldquo;{review.note}&rdquo;</p>}
      <p className="mt-3 text-xs text-gray-400">
        The reviewer name is an attribution supplied with the admin token, not an authenticated identity.
      </p>
    </div>
  )
}

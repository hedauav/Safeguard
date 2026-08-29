import { useEffect, useState } from 'react'
import { Printer, ExternalLink, ShieldCheck, XCircle, Loader2 } from 'lucide-react'
import { getClaimOutcome } from '../lib/api'
import { rupees } from '../lib/money'
import type { ClaimOutcome as Outcome } from '../types'

/**
 * What happened to this claim's money, and why.
 *
 * Two things a claimant could never see before. A refused claim had a reason
 * that existed only in an adjudication row nobody rendered; a refunded claim had
 * a refund that existed as a sentence the agent said once. Both are the same
 * complaint the product was built after — a figure with no working shown.
 *
 * ## The receipt shows two sources and does not merge them
 *
 * `stored` is what this system wrote down when it asked for the refund. `rail`
 * is what Razorpay says about that refund now. A refund is issued `pending` and
 * settles later, so the stored status goes stale — on the first claim this was
 * built against, stored said `pending` while Razorpay already said `processed`.
 * Rendering only our copy would have told the claimant their money had not
 * arrived when it had.
 *
 * Where they differ, the rail's answer is shown as the status and ours is shown
 * beside it as what we recorded. Where the rail cannot be reached, the receipt
 * still renders and says which half is missing.
 *
 * ## It is SafeGuard's receipt, not Razorpay's
 *
 * Razorpay processed the refund. This document is ours, and it prints the refund
 * id so the reader does not have to take our word for it. Styling it as
 * something Razorpay issued would be a claim about provenance that is not ours
 * to make — and the settlement is disclosed in the same panel, because on this
 * deployment the payout is simulated and a receipt that showed only the refund
 * would imply the claim amount had been paid too.
 */

const REFUND_STATUS_STYLE: Record<string, string> = {
  processed: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  pending: 'bg-amber-50 text-amber-800 border-amber-200',
  failed: 'bg-red-50 text-red-800 border-red-200',
}

function when(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-6 gap-y-1 py-2 border-b border-dashed border-gray-200 last:border-0">
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="text-sm text-gray-900 font-medium text-right break-all">{children}</dd>
    </div>
  )
}

export function ClaimOutcome({ claimNumber }: { claimNumber: string }) {
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      setLoading(true)
      try {
        const res = await getClaimOutcome(claimNumber)
        if (cancelled) return
        if (res.error) setError(res.error)
        else setOutcome(res.data ?? null)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'The outcome could not be loaded.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [claimNumber])

  if (loading) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6 flex items-center gap-2 text-sm text-gray-500">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
        Loading the outcome…
      </div>
    )
  }

  // A failed read must not be drawn as "no refund" — those are different facts.
  if (error) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6 text-sm text-gray-600">
        The outcome could not be loaded, so this panel is showing nothing rather
        than implying there is nothing. <span className="text-gray-500">{error}</span>
      </div>
    )
  }

  if (!outcome) return null

  const d = outcome.decision
  const refused = d?.decision === 'rejected'
  const stored = outcome.stored
  const rail = outcome.rail
  const status = rail?.status ?? stored?.status ?? null

  return (
    <div className="space-y-6">
      {/* ---------- The decision, and the reason ---------- */}
      {d && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-2">
            {refused ? (
              <XCircle className="w-5 h-5 text-red-600" aria-hidden="true" />
            ) : (
              <ShieldCheck className="w-5 h-5 text-emerald-600" aria-hidden="true" />
            )}
            <h2 className="text-base font-semibold text-gray-900">
              {refused ? 'This claim was rejected' : 'This claim was approved'}
            </h2>
          </div>

          <div className="px-6 py-4">
            {d.reason ? (
              <blockquote className="border-l-4 border-gray-300 pl-4 text-sm text-gray-900">
                {d.reason}
                {d.reason_source && (
                  <span className="block mt-1 text-xs text-gray-500">
                    Recorded by {d.reason_source}
                    {d.failed_check && (
                      <> · failed check <code className="font-mono">{d.failed_check}</code></>
                    )}
                  </span>
                )}
              </blockquote>
            ) : (
              <p className="text-sm text-gray-600">
                No reason was recorded against this decision.
              </p>
            )}

            <dl className="mt-4">
              <Row label="Decided by">{d.reviewer ?? '—'}</Row>
              <Row label="Decided at">{when(d.decided_at)}</Row>
              <Row label="Recommendation">
                <span className="font-mono">{d.recommended_verdict ?? '—'}</span>
                {d.overrode_recommendation && (
                  <span className="ml-2 text-xs text-amber-700">
                    the reviewer went against it
                  </span>
                )}
              </Row>
              <Row label="Model consulted">
                {d.model_invoked === null ? '—' : d.model_invoked ? 'yes' : 'no — the rules decided'}
              </Row>
            </dl>
          </div>
        </div>
      )}

      {/* ---------- The refund receipt ---------- */}
      {outcome.has_refund && stored ? (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden print:border-0">
          <div className="px-6 py-4 border-b border-gray-200 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Refund receipt</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Deductible returned · processed by Razorpay
              </p>
            </div>
            <div className="flex items-center gap-2 print:hidden">
              {status && (
                <span
                  className={`px-2 py-1 text-xs font-semibold rounded border ${
                    REFUND_STATUS_STYLE[status] ?? 'bg-gray-50 text-gray-700 border-gray-200'
                  }`}
                >
                  {status}
                </span>
              )}
              <button
                onClick={() => window.print()}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-700 border border-gray-300 rounded hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <Printer className="w-3.5 h-3.5" aria-hidden="true" />
                Print
              </button>
            </div>
          </div>

          <div className="px-6 py-4">
            <dl>
              <Row label="Refund reference">
                <span className="font-mono">{stored.refund_id}</span>
              </Row>
              <Row label="Amount returned">
                {rupees((stored.amount_paise ?? 0) / 100)}
              </Row>
              <Row label="Against payment">
                <span className="font-mono">{stored.against_payment_id ?? '—'}</span>
              </Row>
              <Row label="Deductible collected">
                {rupees((stored.captured_amount_paise ?? 0) / 100)} on {when(stored.captured_at)}
              </Row>
              <Row label="Refund issued">{when(stored.refunded_at)}</Row>
              {outcome.claimant?.name && <Row label="Claimant">{outcome.claimant.name}</Row>}
              {outcome.policy?.number && (
                <Row label="Policy">
                  <span className="font-mono">{outcome.policy.number}</span>
                </Row>
              )}
            </dl>

            {/* Where the two sources disagree, say so rather than picking one
                silently. This is the case that motivated the panel. */}
            {rail && stored.status !== rail.status && (
              <p className="mt-4 text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded p-3">
                Razorpay currently reports this refund as{' '}
                <strong>{rail.status}</strong>. This system recorded it as{' '}
                <strong>{stored.status}</strong> when it was issued — a refund is
                created pending and settles afterwards, so the status above is
                Razorpay's, not ours.
              </p>
            )}

            {outcome.rail_error && (
              <p className="mt-4 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-3">
                {outcome.rail_error}
              </p>
            )}

            {stored.simulated && (
              <p className="mt-4 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-3">
                This refund was issued by the simulated rail. No money moved.
              </p>
            )}

            {/* The settlement is disclosed here on purpose: showing a refund
                without it would imply the claim amount had been paid too. */}
            {outcome.settlement?.disclosure && (
              <p className="mt-3 text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded p-3">
                {outcome.settlement.disclosure}
              </p>
            )}

            {!stored.simulated && stored.refund_id && (
              <a
                href={`https://dashboard.razorpay.com/app/refunds/${stored.refund_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:text-blue-900 print:hidden"
              >
                Verify this refund on Razorpay
                <ExternalLink className="w-3 h-3" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
      ) : (
        outcome.reason && (
          <div className="bg-white rounded-lg border border-gray-200 px-6 py-4">
            <h2 className="text-base font-semibold text-gray-900">Refund</h2>
            <p className="text-sm text-gray-600 mt-1">{outcome.reason}</p>
          </div>
        )
      )}
    </div>
  )
}

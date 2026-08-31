import { Check, X } from 'lucide-react'
import type { AdjudicationCheck } from '../../types'

/** Every deterministic check that ran, in order, passes included. */
export function ChecksPanel({ checks, vetoedBy }: { checks: AdjudicationCheck[]; vetoedBy: string | null }) {
  if (!Array.isArray(checks) || checks.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        No checks are recorded on this row. That is a gap in the record, not a claim that none ran.
      </p>
    )
  }

  const failed = checks.filter((c) => !c.passed).length

  return (
    <div>
      <p className="text-xs text-gray-500 mb-2">
        {checks.length} check{checks.length === 1 ? '' : 's'} ran, {failed} failed.
        {' '}The passes are shown too: they are the evidence the model was only asked what it was entitled to answer.
      </p>
      <ul className="space-y-1.5">
        {checks.map((check, i) => {
          const isVeto = vetoedBy !== null && check.id === vetoedBy
          return (
            <li
              key={`${check.id}-${i}`}
              className={`flex items-start gap-2 text-sm rounded-md px-2 py-1.5 ${
                isVeto ? 'bg-red-50 border border-red-200' : check.passed ? '' : 'bg-amber-50'
              }`}
            >
              {check.passed
                ? <Check className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                : <X className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />}
              <div className="min-w-0">
                <span className="font-mono text-xs text-gray-700">{check.id}</span>
                {isVeto && (
                  <span className="ml-2 text-xs font-semibold text-red-700 uppercase tracking-wide">
                    vetoed → {check.vetoes ?? 'escalate'}
                  </span>
                )}
                {!check.passed && !isVeto && check.vetoes && (
                  <span className="ml-2 text-xs text-amber-700">forces {check.vetoes}</span>
                )}
                <p className={`${check.passed ? 'text-gray-500' : 'text-gray-800'}`}>{check.detail}</p>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

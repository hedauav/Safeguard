import { AlertTriangle, Check, Coins, Info } from 'lucide-react'
import { FAULT_CHOICES } from './helpers'
import type { FaultChoice } from './helpers'

/**
 * Who was at fault, and what saying so does.
 *
 * The consequence of the current choice is rendered under the choices, in the
 * present tense, before anything is pressed. The alternative — which is what
 * this page did — is a reviewer who finds out that the deductible cannot be
 * waived from a warning in the response, once the decision is already on file
 * and a second one on the same recommendation is a 409.
 */
export function FaultPanel({ value, onChange }: { value: FaultChoice; onChange: (v: FaultChoice) => void }) {
  const chosen = FAULT_CHOICES.find((c) => c.key === value) ?? FAULT_CHOICES[0]

  return (
    <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
      <h5 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
        <Coins className="w-3.5 h-3.5" /> Who was at fault
        <span className="font-normal normal-case tracking-normal text-gray-400">— optional</span>
      </h5>
      <p className="text-xs text-gray-500 mt-1">
        The deductible refund is gated on this field, and on this field alone. Recording{' '}
        <span className="font-mono">other_party</span> is what lets the policyholder&apos;s excess be given
        back; every other answer, including no answer, leaves it with them.
      </p>

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {FAULT_CHOICES.map((c) => {
          const active = c.key === value
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => onChange(c.key)}
              aria-pressed={active}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
                active
                  ? c.waives
                    ? 'bg-green-600 text-white border-green-600'
                    : c.key === 'unset'
                      ? 'bg-amber-500 text-white border-amber-500'
                      : 'bg-gray-800 text-white border-gray-800'
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'
              }`}
            >
              {c.waives && <Coins className="w-3.5 h-3.5" />}
              {c.label}
            </button>
          )
        })}
      </div>

      <div
        className={`mt-2.5 rounded px-3 py-2 text-sm border flex items-start gap-2 ${
          chosen.waives
            ? 'bg-green-50 border-green-200 text-green-900'
            : chosen.key === 'unset'
              ? 'bg-amber-50 border-amber-200 text-amber-900'
              : 'bg-white border-gray-200 text-gray-700'
        }`}
      >
        {chosen.waives
          ? <Check className="w-4 h-4 mt-0.5 shrink-0" />
          : chosen.key === 'unset'
            ? <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            : <Info className="w-4 h-4 mt-0.5 shrink-0" />}
        <span>{chosen.consequence}</span>
      </div>

      <p className="mt-1.5 text-[11px] text-gray-400">
        Sent as <span className="font-mono">{chosen.wire}</span>. A finding is written to the claim and
        attributed to you by name; it is a fact about the incident, not a status, so it is recorded
        whichever way you decide.
      </p>
    </div>
  )
}

import { Check, CircleSlash, ShieldAlert } from 'lucide-react'
import { CURRENCY } from './helpers'
import type { Adjudication } from '../../types'

/**
 * The two figures, side by side, never merged.
 *
 * The computed figure is the one with authority; the model's is carried only
 * so it can be compared. When they disagree the verdict was forced to escalate
 * in code, and this panel is where a reviewer sees why.
 */
export function AmountPanel({ a }: { a: Adjudication }) {
  const disagreed = a.amount_agreement === 'disagreed'

  const modelFigure = () => {
    switch (a.amount_agreement) {
      case 'not_asked':
        return {
          value: '—',
          note: a.vetoed_by
            ? 'The model was never asked: a rule vetoed before it was called.'
            : 'The model was never asked, or produced no usable answer.',
        }
      case 'not_proposed':
        return { value: '—', note: 'The model was asked and returned no figure.' }
      default:
        return { value: CURRENCY(a.model_proposed_amount), note: 'Recorded for comparison. Never paid.' }
    }
  }
  const model = modelFigure()

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Computed payable</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{CURRENCY(a.computed_payable_amount)}</p>
          <p className="text-xs text-gray-500 mt-1">
            Arithmetic, in code, by the same function the settlement path uses. The only figure with authority.
          </p>
        </div>
        <div className={`rounded-lg border p-4 ${disagreed ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-white'}`}>
          <p className={`text-xs font-medium uppercase tracking-wider ${disagreed ? 'text-red-700' : 'text-gray-500'}`}>
            Model proposed
          </p>
          <p className={`text-2xl font-bold mt-1 ${disagreed ? 'text-red-700' : 'text-gray-900'}`}>{model.value}</p>
          <p className={`text-xs mt-1 ${disagreed ? 'text-red-700' : 'text-gray-500'}`}>{model.note}</p>
        </div>
      </div>

      {disagreed ? (
        <div className="mt-3 rounded-lg border-2 border-red-400 bg-red-50 px-4 py-3 flex items-start gap-2">
          <ShieldAlert className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
          <div className="text-sm text-red-800">
            <p className="font-semibold">The two figures disagree.</p>
            <p className="mt-0.5">
              A model whose arithmetic differs from ours has misread something. The verdict was forced to{' '}
              <span className="font-mono font-semibold">escalate</span> in code, and the computed figure stands
              regardless of what the model said.
            </p>
          </div>
        </div>
      ) : a.amount_agreement === 'agreed' ? (
        <p className="mt-2 text-sm text-green-700 flex items-center gap-1.5">
          <Check className="w-4 h-4" /> The model&apos;s figure matches the computed one.
        </p>
      ) : (
        <p className="mt-2 text-sm text-gray-500 flex items-center gap-1.5">
          <CircleSlash className="w-4 h-4" />
          No figure was compared — <span className="font-mono">{a.amount_agreement}</span>.
        </p>
      )}
    </div>
  )
}

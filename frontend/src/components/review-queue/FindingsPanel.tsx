import type { Provenance } from './helpers'
import type { Adjudication } from '../../types'

export function FindingsPanel({ a, provenance }: { a: Adjudication; provenance: Provenance }) {
  const modelSpoke = provenance === 'model_spoke'
  const findingsLabel = provenance === 'rule_veto'
    ? 'Rule finding'
    : modelSpoke
      ? 'Inconsistencies the model reported'
      : 'Recorded failure'

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
          Policy clauses cited
        </h4>
        {!modelSpoke ? (
          <p className="text-sm text-gray-500">
            None. Clauses are only ever cited by the model, and no model output stands on this row.
          </p>
        ) : a.policy_clauses.length === 0 ? (
          <p className="text-sm text-gray-500">The model cited no clause.</p>
        ) : (
          <ul className="space-y-1.5">
            {a.policy_clauses.map((clause, i) => (
              <li key={i} className="text-sm text-gray-800 bg-gray-50 border border-gray-200 rounded px-2 py-1.5">
                {clause}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{findingsLabel}</h4>
        {a.inconsistencies.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing recorded.</p>
        ) : (
          <ul className="space-y-1.5">
            {a.inconsistencies.map((entry, i) => (
              <li key={i} className="text-sm text-gray-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                {entry}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

import { AlertTriangle, Cpu, Gavel } from 'lucide-react'
import type { Provenance } from './helpers'
import type { Adjudication } from '../../types'

/**
 * Which engine produced this recommendation, and what that means for
 * everything else on the row.
 */
export function ProvenancePanel({ a, provenance }: { a: Adjudication; provenance: Provenance }) {
  if (provenance === 'rule_veto') {
    return (
      <div className="rounded-lg border border-purple-200 bg-purple-50 p-4">
        <div className="flex items-center gap-2 text-purple-900 font-semibold text-sm">
          <Gavel className="w-4 h-4" /> Decided by rule. The model was never consulted.
        </div>
        <p className="text-sm text-purple-900 mt-1">
          Check <span className="font-mono font-semibold">{a.vetoed_by}</span> vetoed before any model was called,
          so there is no model output on this row and none is shown.
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-purple-900">
          <dt className="text-purple-700">Confidence</dt>
          <dd>{a.confidence} — arithmetic and date comparison, not a model&apos;s estimate of itself</dd>
          <dt className="text-purple-700">Model</dt>
          <dd>not invoked</dd>
        </dl>
      </div>
    )
  }

  const modelLine = (
    <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1 text-xs text-gray-700">
      <dt className="text-gray-500">Model</dt>
      <dd className="font-mono break-all">{a.model_id ?? 'not recorded'}</dd>
      <dt className="text-gray-500">Provider</dt>
      <dd className="font-mono">{a.model_provider ?? 'not recorded'}</dd>
      <dt className="text-gray-500">Latency</dt>
      <dd>{a.model_latency_ms === null ? 'not recorded' : `${a.model_latency_ms} ms`}</dd>
    </dl>
  )

  if (provenance === 'model_unusable') {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
        <div className="flex items-center gap-2 text-amber-900 font-semibold text-sm">
          <AlertTriangle className="w-4 h-4" />
          {a.model_invoked
            ? 'The model was called and its answer could not be used.'
            : 'No model answer is recorded on this row.'}
        </div>
        {a.parse_error && (
          <pre className="mt-2 text-xs bg-white border border-amber-200 rounded p-2 whitespace-pre-wrap break-words text-amber-900">
            {a.parse_error}
          </pre>
        )}
        <p className="text-sm text-amber-900 mt-2">
          Nothing was defaulted: the failure was recorded and the verdict escalated. The findings below are that
          recorded failure, not the model&apos;s reading of the claim.
        </p>
        {a.model_invoked && modelLine}
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-center gap-2 text-gray-900 font-semibold text-sm">
        <Cpu className="w-4 h-4 text-blue-600" /> A model read the documents and answered.
      </div>
      <p className="text-sm text-gray-600 mt-1">
        Self-reported confidence <span className="font-semibold">{(a.confidence * 100).toFixed(0)}%</span>.
        {' '}That is the model&apos;s own estimate of itself, and is not evidence of anything.
      </p>
      {a.simulated && (
        <div className="mt-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <span className="font-semibold">Simulated.</span> This answer came from the fake provider because no
          model API key is configured. No model read anything. Do not treat this as a reviewed claim.
        </div>
      )}
      {modelLine}
    </div>
  )
}

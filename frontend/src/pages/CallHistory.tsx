import { Fragment, useEffect, useState } from 'react'
import { PhoneIncoming, PhoneOutgoing, Wifi, ChevronLeft, ChevronRight, Phone, ChevronDown, ChevronUp, CheckCircle2, XCircle } from 'lucide-react'
import { getCall, getCalls } from '../lib/api'
import { TranscriptViewer } from '../components/TranscriptViewer'
import type { CallLog, CallLogDetail } from '../types'

// `in_progress` is gone deliberately: the webhook writer only ever stores
// `completed` or `failed`, so the filter could only ever match rows left behind
// by an older defect. Offering it advertised a state the system cannot produce.
const STATUSES = ['', 'completed', 'failed']
const DIRECTIONS = ['', 'inbound', 'outbound', 'webrtc']

interface OutcomeStyle {
  label: string
  className: string
}

/**
 * How each outcome the writer can store is presented.
 *
 * This map used to expect a vocabulary nothing wrote — `claim_filed`,
 * `info_provided`, `escalated` — while the writer emitted `resolved` /
 * `unresolved` / `unknown` and the seed data used a third set again. Only two
 * words ever intersected, so nearly every call rendered as the same grey badge.
 * The writer is now the single source of the vocabulary and this map covers all
 * of it.
 */
const OUTCOME_STYLES: Record<string, OutcomeStyle> = {
  claim_filed: { label: 'Claim filed', className: 'bg-green-100 text-green-700' },
  escalated: { label: 'Escalated to a human', className: 'bg-red-100 text-red-700' },
  escalated_to_regulator: { label: 'Escalated to regulator', className: 'bg-red-100 text-red-700' },
  settlement_initiated: { label: 'Settlement initiated', className: 'bg-amber-100 text-amber-700' },
  deductible_requested: { label: 'Excess requested', className: 'bg-amber-100 text-amber-700' },
  renewal_offered: { label: 'Renewal offered', className: 'bg-indigo-100 text-indigo-700' },
  callback_scheduled: { label: 'Callback scheduled', className: 'bg-purple-100 text-purple-700' },
  documents_requested: { label: 'Documents requested', className: 'bg-sky-100 text-sky-700' },
  info_provided: { label: 'Information provided', className: 'bg-blue-100 text-blue-700' },
  resolved: { label: 'Resolved', className: 'bg-emerald-100 text-emerald-700' },
  unresolved: { label: 'Unresolved', className: 'bg-orange-100 text-orange-700' },
  // Deliberately plain and deliberately named. A call whose outcome nothing
  // recorded must read as unrecorded rather than borrow a nicer word.
  unknown: { label: 'Outcome unknown', className: 'bg-gray-100 text-gray-500' },
}

/**
 * Rows written before the vocabulary above existed — the seeded demo data, and
 * anything a previous deployment stored. These are aliases, not reinterpretations:
 * each says the same thing as the canonical word it maps to. The seed SQL that
 * produced them is not this file's to rewrite.
 */
const LEGACY_OUTCOME_ALIASES: Record<string, string> = {
  information_provided: 'info_provided',
  claim_update_delivered: 'info_provided',
  escalation_created: 'escalated',
  new_claim_filed: 'claim_filed',
}

function describeOutcome(outcome: string): OutcomeStyle {
  // The initiation-failure path stores `initiation_failed: <reason>`, and the
  // reason is the entire content of such a row — so it is shown, not dropped.
  if (outcome.startsWith('initiation_failed')) {
    const reason = outcome.slice('initiation_failed:'.length).trim().replace(/_/g, ' ')
    return {
      label: reason && reason !== 'unknown' ? `Never connected — ${reason}` : 'Never connected',
      className: 'bg-red-100 text-red-700',
    }
  }

  const canonical = LEGACY_OUTCOME_ALIASES[outcome] ?? outcome
  return (
    OUTCOME_STYLES[canonical] ?? {
      // Something stored a word this build does not know. Show it verbatim and
      // uncoloured; inferring a meaning would be inventing one.
      label: outcome.replace(/_/g, ' '),
      className: 'bg-gray-100 text-gray-600',
    }
  )
}

/**
 * Who the call was with.
 *
 * A browser-widget caller is anonymous by construction: there is no phone
 * number, and nothing identifies them unless they filed a claim during the
 * call. That case used to render as "Unknown", which says a lookup failed and
 * something is missing. Nothing failed — "Web caller" is simply what they are.
 * "Unknown" is kept for a phone call we could not attribute, where it is true.
 */
function describeCaller(call: CallLog): string {
  if (call.customer_name) return call.customer_name
  if (call.phone_number) return call.phone_number
  return call.direction === 'webrtc' ? 'Web caller' : 'Unknown'
}

function formatDuration(seconds: number | null) {
  if (seconds === null) return '—'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function DirectionIcon({ direction }: { direction: string }) {
  switch (direction) {
    case 'inbound':
      return <PhoneIncoming className="w-4 h-4 text-green-500" />
    case 'outbound':
      return <PhoneOutgoing className="w-4 h-4 text-blue-500" />
    case 'webrtc':
      return <Wifi className="w-4 h-4 text-purple-500" />
    default:
      return <Phone className="w-4 h-4 text-gray-400" />
  }
}

/**
 * The tools the agent actually invoked on a call.
 *
 * `GET /api/calls/:id` has always returned these and nothing in the dashboard
 * ever asked for them, so the most substantive record of what happened on a
 * call was captured and never shown. Each of the four states below is
 * distinguishable on purpose — in particular an empty list means "no tools
 * ran", which is a different statement from "we could not read them".
 */
function ToolExecutions({
  detail,
  loading,
  error,
}: {
  detail?: CallLogDetail
  loading: boolean
  error?: string
}) {
  if (loading) {
    return <p className="text-sm text-gray-500">Loading what the agent did…</p>
  }
  if (error) {
    return <p className="text-sm text-red-600">{error}</p>
  }
  if (!detail) {
    return null
  }
  if (detail.tool_executions_error) {
    return <p className="text-sm text-amber-700">{detail.tool_executions_error}</p>
  }
  if (detail.tool_executions.length === 0) {
    return <p className="text-sm text-gray-500">The agent invoked no tools on this call.</p>
  }

  return (
    <ul className="divide-y divide-gray-100">
      {detail.tool_executions.map((execution) => (
        <li key={execution.id} className="flex items-start gap-3 py-2">
          {execution.success ? (
            <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0 text-emerald-500" />
          ) : (
            <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-500" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-gray-900">{execution.tool_name}</span>
              {!execution.success && (
                <span className="text-xs text-red-600">failed</span>
              )}
              {execution.latency_ms !== null && (
                <span className="text-xs text-gray-400 tabular-nums">{execution.latency_ms} ms</span>
              )}
              <span className="text-xs text-gray-400">
                {new Date(execution.executed_at).toLocaleTimeString()}
              </span>
            </div>
            {execution.tool_args && Object.keys(execution.tool_args).length > 0 && (
              <p className="mt-0.5 text-xs text-gray-500 font-mono break-all">
                {JSON.stringify(execution.tool_args)}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Everything an expanded row shows: the conversation, the tools, the summary. */
function CallDetail({
  call,
  detail,
  loading,
  error,
}: {
  call: CallLog
  detail?: CallLogDetail
  loading: boolean
  error?: string
}) {
  const transcript = call.transcript ?? []

  return (
    <div className="space-y-3">
      <div className="max-h-80 overflow-y-auto rounded-lg border border-gray-200 bg-white">
        {transcript.length > 0 ? (
          <TranscriptViewer transcript={transcript} />
        ) : (
          <p className="p-4 text-sm text-gray-500">No transcript was recorded for this call.</p>
        )}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-3">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
          Tools invoked
        </p>
        <ToolExecutions detail={detail} loading={loading} error={error} />
      </div>

      {call.summary && (
        <div className="p-3 bg-blue-50 rounded-lg">
          <p className="text-xs font-medium text-blue-700 mb-1">Call Summary</p>
          <p className="text-sm text-blue-900">{call.summary}</p>
        </div>
      )}
    </div>
  )
}

export function CallHistory() {
  const [calls, setCalls] = useState<CallLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [directionFilter, setDirectionFilter] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Per-call detail, keyed by id and kept once fetched. Nothing here is
  // invalidated by paging, because a completed call's tool executions do not
  // change.
  const [details, setDetails] = useState<Record<string, CallLogDetail>>({})
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({})
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null)
  const limit = 20

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      setLoading(true)
      try {
        const filter: Record<string, string> = {}
        if (statusFilter) filter.status = statusFilter
        if (directionFilter) filter.direction = directionFilter

        const res = await getCalls(Object.keys(filter).length > 0 ? filter : undefined, page, limit)
        if (cancelled) return
        setCalls(res.data)
        setTotal(res.total)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load calls')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [statusFilter, directionFilter, page])

  /**
   * Open a row, fetching its detail the first time it is opened.
   *
   * Lazily and once: the detail endpoint runs a second query per call, so
   * fetching it for the whole page on load would multiply the cost of the list
   * by the page size to show data most rows are never expanded to reveal.
   */
  const toggleExpanded = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null)
      return
    }

    setExpandedId(id)
    if (details[id] || loadingDetailId === id) return

    setDetailErrors((prev) => {
      if (!(id in prev)) return prev
      const rest = { ...prev }
      delete rest[id]
      return rest
    })
    setLoadingDetailId(id)

    getCall(id)
      .then((res) => {
        if (res.data) {
          setDetails((prev) => ({ ...prev, [id]: res.data }))
        } else {
          setDetailErrors((prev) => ({ ...prev, [id]: res.error ?? 'Call detail is unavailable.' }))
        }
      })
      .catch((err) => {
        setDetailErrors((prev) => ({
          ...prev,
          [id]: err instanceof Error ? err.message : 'Call detail is unavailable.',
        }))
      })
      .finally(() => {
        setLoadingDetailId((current) => (current === id ? null : current))
      })
  }

  const totalPages = Math.ceil(total / limit)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Call History</h1>
          <p className="text-sm text-gray-500 mt-1">View all AI agent call logs</p>
        </div>
        <div className="flex gap-2">
          <select
            value={directionFilter}
            onChange={(e) => { setDirectionFilter(e.target.value); setPage(1) }}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Directions</option>
            {DIRECTIONS.filter(Boolean).map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Statuses</option>
            {STATUSES.filter(Boolean).map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <p className="text-red-700">{error}</p>
          <button onClick={() => setPage(1)} className="text-blue-600 hover:underline text-sm mt-2">Retry</button>
        </div>
      ) : calls.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <Phone className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">No calls found</p>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Direction</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Customer</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Duration</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Outcome</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Tools Used</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {calls.map((call) => (
                  <Fragment key={call.id}>
                    <tr
                      onClick={() => toggleExpanded(call.id)}
                      className="hover:bg-gray-50 cursor-pointer transition-colors"
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <DirectionIcon direction={call.direction} />
                          <span className="text-sm capitalize">{call.direction}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900">{describeCaller(call)}</td>
                      <td className="px-6 py-4 text-sm text-gray-600">{formatDuration(call.duration_seconds)}</td>
                      <td className="px-6 py-4">
                        {call.outcome ? (
                          (() => {
                            const { label, className } = describeOutcome(call.outcome)
                            return (
                              <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${className}`}>
                                {label}
                              </span>
                            )
                          })()
                        ) : (
                          <span className="text-sm text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex gap-1 flex-wrap">
                          {call.tools_used?.map((tool) => (
                            <span key={tool} className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-xs">{tool}</span>
                          )) || <span className="text-sm text-gray-400">—</span>}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-500">{new Date(call.started_at).toLocaleString()}</td>
                      <td className="px-3 py-4">
                        {/* Every row expands now, not only those with a
                            transcript: the tools the agent invoked are worth
                            opening for even when nothing was said. */}
                        {expandedId === call.id
                          ? <ChevronUp className="w-4 h-4 text-gray-400" />
                          : <ChevronDown className="w-4 h-4 text-gray-400" />}
                      </td>
                    </tr>
                    {expandedId === call.id && (
                      <tr key={`${call.id}-detail`}>
                        <td colSpan={7} className="px-6 py-4 bg-gray-50">
                          <CallDetail
                            call={call}
                            detail={details[call.id]}
                            loading={loadingDetailId === call.id}
                            error={detailErrors[call.id]}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-gray-500">
                Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="p-2 rounded-lg border border-gray-300 disabled:opacity-50 hover:bg-gray-50"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-sm text-gray-600">Page {page} of {totalPages}</span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="p-2 rounded-lg border border-gray-300 disabled:opacity-50 hover:bg-gray-50"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

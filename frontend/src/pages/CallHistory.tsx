import { Fragment, useEffect, useState } from 'react'
import { PhoneIncoming, PhoneOutgoing, Wifi, ChevronLeft, ChevronRight, Phone, ChevronDown, ChevronUp } from 'lucide-react'
import { getCalls } from '../lib/api'
import { TranscriptViewer } from '../components/TranscriptViewer'
import type { CallLog } from '../types'

const STATUSES = ['', 'in_progress', 'completed', 'failed']
const DIRECTIONS = ['', 'inbound', 'outbound', 'webrtc']

const outcomeColors: Record<string, string> = {
  claim_filed: 'bg-green-100 text-green-700',
  info_provided: 'bg-blue-100 text-blue-700',
  escalated: 'bg-red-100 text-red-700',
  callback_scheduled: 'bg-purple-100 text-purple-700',
  resolved: 'bg-emerald-100 text-emerald-700',
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

export function CallHistory() {
  const [calls, setCalls] = useState<CallLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [directionFilter, setDirectionFilter] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
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
                      onClick={() => setExpandedId(expandedId === call.id ? null : call.id)}
                      className="hover:bg-gray-50 cursor-pointer transition-colors"
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <DirectionIcon direction={call.direction} />
                          <span className="text-sm capitalize">{call.direction}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900">{call.customer_name || call.phone_number || 'Unknown'}</td>
                      <td className="px-6 py-4 text-sm text-gray-600">{formatDuration(call.duration_seconds)}</td>
                      <td className="px-6 py-4">
                        {call.outcome ? (
                          <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${outcomeColors[call.outcome] || 'bg-gray-100 text-gray-700'}`}>
                            {call.outcome.replace(/_/g, ' ')}
                          </span>
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
                        {call.transcript && call.transcript.length > 0 && (
                          expandedId === call.id
                            ? <ChevronUp className="w-4 h-4 text-gray-400" />
                            : <ChevronDown className="w-4 h-4 text-gray-400" />
                        )}
                      </td>
                    </tr>
                    {expandedId === call.id && call.transcript && call.transcript.length > 0 && (
                      <tr key={`${call.id}-transcript`}>
                        <td colSpan={7} className="px-6 py-4 bg-gray-50">
                          <div className="max-h-80 overflow-y-auto rounded-lg border border-gray-200 bg-white">
                            <TranscriptViewer transcript={call.transcript} />
                          </div>
                          {call.summary && (
                            <div className="mt-3 p-3 bg-blue-50 rounded-lg">
                              <p className="text-xs font-medium text-blue-700 mb-1">Call Summary</p>
                              <p className="text-sm text-blue-900">{call.summary}</p>
                            </div>
                          )}
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

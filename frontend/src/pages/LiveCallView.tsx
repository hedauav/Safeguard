import { Headphones, Clock, Radio } from 'lucide-react'
import { ToolExecutionCard } from '../components/ToolExecutionCard'
import { useRealtimeCalls } from '../hooks/useRealtimeCalls'

/**
 * Live view of a call in progress.
 *
 * This page previously shipped a hardcoded transcript and two fabricated tool
 * executions, defaulted to "call active", and merged the fake executions with
 * the real ones so the two were indistinguishable on screen. The invented
 * figures ($8,500, March 15th) did not even match the claim they named. That is
 * the same class of mechanism the rest of this project exists to have removed,
 * so it is gone: everything below renders only what actually arrived over the
 * realtime channel, and when nothing has, the page says so.
 */
export function LiveCallView() {
  const { toolExecutions } = useRealtimeCalls()

  // Activity is observed, not assumed. There is no way to put this page into a
  // "live" state without a real tool execution arriving.
  const isActive = toolExecutions.length > 0
  const lastExecutedAt = isActive
    ? toolExecutions[toolExecutions.length - 1]?.executed_at
    : null

  if (!isActive) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center">
        <div className="p-4 bg-gray-100 rounded-full mb-4">
          <Headphones className="w-12 h-12 text-gray-400" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">No Active Call</h1>
        <p className="text-gray-500 mt-2 max-w-md">
          Tool executions appear here in real time while a call is in progress.
          Start one from the call widget in the bottom-right corner, or open{' '}
          <span className="font-medium text-gray-700">Call History</span> to read
          a completed call with its full transcript.
        </p>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-green-500 animate-pulse" />
          <span className="text-sm font-medium text-green-700">Call in progress</span>
        </div>
        {lastExecutedAt && (
          <div className="flex items-center gap-1.5 text-sm text-gray-600">
            <Clock className="w-4 h-4" />
            last tool call {new Date(lastExecutedAt).toLocaleTimeString()}
          </div>
        )}
      </div>

      <div className="flex-1 bg-white border border-gray-200 rounded-xl overflow-hidden flex flex-col min-h-0">
        <div className="px-4 py-3 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900">Tool Executions</h2>
          <p className="text-xs text-gray-400">
            {toolExecutions.length} tool{toolExecutions.length === 1 ? '' : 's'} called
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {toolExecutions.map((exec) => (
            <ToolExecutionCard key={exec.id} execution={exec} />
          ))}
        </div>
      </div>

      {/* The live transcript is not streamed — ElevenLabs delivers it in the
          post-call webhook, so it appears under Call History once the call
          ends. Showing a placeholder here would be inventing one. */}
      <p className="mt-3 text-xs text-gray-400">
        The transcript is delivered when the call ends and appears under Call History.
      </p>
    </div>
  )
}

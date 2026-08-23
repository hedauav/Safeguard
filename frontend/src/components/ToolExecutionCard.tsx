import { useState } from 'react'
import { CheckCircle2, XCircle, Clock, ChevronDown, ChevronUp, Wrench } from 'lucide-react'

import type { CallToolExecution } from '../types'

/** The subset of a tool execution this card renders. */
type ToolExecution = Pick<
  CallToolExecution,
  'tool_name' | 'tool_args' | 'tool_result' | 'success' | 'latency_ms' | 'executed_at'
>

interface ToolExecutionCardProps {
  execution: ToolExecution
}

export function ToolExecutionCard({ execution }: ToolExecutionCardProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <Wrench className="w-4 h-4 text-gray-400" />
          <span className="text-sm font-medium text-gray-900">
            {execution.tool_name.replace(/_/g, ' ')}
          </span>
          {execution.success ? (
            <CheckCircle2 className="w-4 h-4 text-green-500" />
          ) : (
            <XCircle className="w-4 h-4 text-red-500" />
          )}
        </div>
        <div className="flex items-center gap-3">
          {execution.latency_ms !== null && (
            <span className="flex items-center gap-1 text-xs text-gray-500">
              <Clock className="w-3 h-3" />
              {execution.latency_ms}ms
            </span>
          )}
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          )}
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-3 space-y-2 border-t border-gray-100">
          {execution.tool_args && Object.keys(execution.tool_args).length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-500 mt-2 mb-1">Arguments</p>
              <pre className="text-xs bg-gray-50 p-2 rounded overflow-x-auto text-gray-700">
                {JSON.stringify(execution.tool_args, null, 2)}
              </pre>
            </div>
          )}
          {execution.tool_result && Object.keys(execution.tool_result).length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">Result</p>
              <pre className="text-xs bg-gray-50 p-2 rounded overflow-x-auto text-gray-700">
                {JSON.stringify(execution.tool_result, null, 2)}
              </pre>
            </div>
          )}
          <p className="text-xs text-gray-400">
            Executed at {new Date(execution.executed_at).toLocaleTimeString()}
          </p>
        </div>
      )}
    </div>
  )
}

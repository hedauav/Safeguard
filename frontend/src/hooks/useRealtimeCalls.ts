import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import type { CallToolExecution, JsonValue } from '../types'

interface CallEvent {
  type: 'tool-executed' | 'call-completed'
  /** Broadcast payloads are free-form; callers narrow what they need. */
  payload: Record<string, JsonValue> | undefined
}

export function useRealtimeCalls() {
  const [latestEvent, setLatestEvent] = useState<CallEvent | null>(null)
  const [toolExecutions, setToolExecutions] = useState<CallToolExecution[]>([])

  const clearEvents = useCallback(() => {
    setLatestEvent(null)
    setToolExecutions([])
  }, [])

  useEffect(() => {
    const channel = supabase
      .channel('call-updates')
      .on('broadcast', { event: 'tool-executed' }, (payload) => {
        const execution = payload.payload?.tool_execution as CallToolExecution
        if (execution) {
          setToolExecutions((prev) => [...prev, execution])
        }
        setLatestEvent({ type: 'tool-executed', payload: payload.payload })
      })
      .on('broadcast', { event: 'call-completed' }, (payload) => {
        setLatestEvent({ type: 'call-completed', payload: payload.payload })
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  return { latestEvent, toolExecutions, clearEvents }
}

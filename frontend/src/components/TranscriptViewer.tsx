import { useEffect, useRef } from 'react'
import { Bot, User } from 'lucide-react'
import type { TranscriptEntry } from '../types'

interface TranscriptViewerProps {
  transcript: TranscriptEntry[]
}

/**
 * A turn's position in the call, as "m:ss".
 *
 * This component used to look for a `timestamp` string that nothing writes, so
 * no turn has ever shown a time. What the writer stores is an offset in
 * seconds, which is also the more useful thing to show: "1:47" tells you where
 * in the call something was said, which a wall-clock time does not.
 *
 * Returns null rather than "0:00" for a missing or nonsensical value — no time
 * shown is honest, an invented one is not.
 */
function formatOffset(seconds: number | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  return `${minutes}:${remainder.toString().padStart(2, '0')}`
}

export function TranscriptViewer({ transcript }: TranscriptViewerProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript])

  if (transcript.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        No transcript available
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 overflow-y-auto h-full p-4">
      {transcript.map((entry, index) => {
        const isAgent = entry.role === 'agent' || entry.role === 'assistant' || entry.role === 'ai'
        // Seeded rows carry a formatted string instead of an offset; either is
        // shown, and neither is fabricated when both are absent.
        const time = formatOffset(entry.time_in_call_secs) ?? entry.timestamp ?? null
        return (
          <div
            key={`${entry.role}-${index}`}
            className={`flex gap-3 ${isAgent ? 'justify-start' : 'justify-end'}`}
          >
            {isAgent && (
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
                <Bot className="w-4 h-4 text-blue-600" />
              </div>
            )}
            <div className={`max-w-[75%] ${isAgent ? '' : 'order-first'}`}>
              <div className={`flex items-center gap-2 mb-1 ${isAgent ? '' : 'justify-end'}`}>
                <span className="text-xs font-medium text-gray-500">
                  {isAgent ? 'AI Agent' : 'Caller'}
                </span>
                {time && (
                  <span className="text-xs text-gray-400 tabular-nums">{time}</span>
                )}
              </div>
              <div
                className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                  isAgent
                    ? 'bg-gray-100 text-gray-800 rounded-tl-sm'
                    : 'bg-blue-600 text-white rounded-tr-sm'
                }`}
              >
                {entry.message}
              </div>
            </div>
            {!isAgent && (
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
                <User className="w-4 h-4 text-green-600" />
              </div>
            )}
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}

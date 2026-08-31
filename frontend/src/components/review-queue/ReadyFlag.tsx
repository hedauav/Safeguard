import { AlertTriangle, Check } from 'lucide-react'

/**
 * One precondition for deciding, stated before anybody clicks anything.
 *
 * The point of the row of these is that a reader can tell what the page wants
 * from them without pressing a dead button to find out.
 */
export function ReadyFlag({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${ok ? 'text-green-700' : 'text-amber-700'}`}>
      {ok
        ? <Check className="w-3.5 h-3.5 shrink-0" />
        : <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
      {ok ? okText : badText}
    </span>
  )
}

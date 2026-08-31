import { AlertTriangle } from 'lucide-react'

export function Banner({ kind, children }: { kind: 'warn' | 'err' | 'info'; children: React.ReactNode }) {
  const style = kind === 'err'
    ? 'bg-red-50 border-red-200 text-red-800'
    : kind === 'warn'
      ? 'bg-amber-50 border-amber-200 text-amber-900'
      : 'bg-blue-50 border-blue-200 text-blue-900'
  return (
    <div className={`border rounded-lg px-4 py-3 text-sm flex items-start gap-2 ${style}`}>
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      <div>{children}</div>
    </div>
  )
}

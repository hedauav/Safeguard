import { useState } from 'react'
import { ShieldCheck, ShieldX } from 'lucide-react'
import { verifyClaimIntegrity } from '../lib/api'

export function IntegrityCheckButton({ claimId }: { claimId: string }) {
  const [status, setStatus] = useState<'idle' | 'checking' | 'match' | 'mismatch'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  const handleCheck = async () => {
    setStatus('checking')
    setMessage(null)

    try {
      const response = await verifyClaimIntegrity(claimId)
      if (response.data.match) {
        setStatus('match')
        setMessage('Integrity verified')
      } else {
        setStatus('mismatch')
        setMessage(response.data.reason || 'Integrity mismatch detected')
      }
    } catch (error) {
      setStatus('mismatch')
      setMessage(error instanceof Error ? error.message : 'Integrity check failed')
    }
  }

  const isMatch = status === 'match'
  const isMismatch = status === 'mismatch'

  return (
    <div className="space-y-2">
      <button
        onClick={handleCheck}
        disabled={status === 'checking'}
        className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium border ${
          isMatch
            ? 'bg-green-600 border-green-600 text-white'
            : isMismatch
              ? 'bg-red-600 border-red-600 text-white'
              : 'bg-white border-gray-200 text-gray-700'
        }`}
      >
        {isMatch ? <ShieldCheck className="w-4 h-4" /> : <ShieldX className="w-4 h-4" />}
        {status === 'checking' ? 'Verifying...' : 'Verify Integrity'}
      </button>
      {message && (
        <p className={`text-xs ${isMatch ? 'text-green-700' : 'text-red-600'}`}>
          {message}
        </p>
      )}
    </div>
  )
}

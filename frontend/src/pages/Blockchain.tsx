import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Database, CheckCircle2, Clock, ExternalLink, RefreshCw, FlaskConical } from 'lucide-react'
import { supabase } from '../lib/supabase'

interface ClaimFilecoinRow {
  id: string
  claim_number: string
  claim_type: string
  status: string
  filecoin_cid: string | null
  piece_cid: string | null
  attestation_tx_hash: string | null
  eas_uid: string | null
  attested_at: string | null
  simulated: boolean | null
  filed_at: string
  customers: { full_name: string } | { full_name: string }[] | null
}

/** An embedded Supabase join arrives as an object or a single-element array. */
function customerName(c: ClaimFilecoinRow['customers']): string {
  if (!c) return '—'
  const row = Array.isArray(c) ? c[0] : c
  return row?.full_name ?? '—'
}

function truncate(s: string | null | undefined, n = 14): string {
  if (!s) return '—'
  return s.length > n ? s.slice(0, n) + '…' : s
}

/** Fetches the claims shown on this page. Throws so callers own the error state. */
async function fetchClaimRows(): Promise<ClaimFilecoinRow[]> {
  const { data, error } = await supabase
    .from('claims')
    .select('id, claim_number, claim_type, status, filecoin_cid, piece_cid, attestation_tx_hash, eas_uid, attested_at, simulated, filed_at, customers(full_name)')
    .order('filed_at', { ascending: false })
    .limit(50)

  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as ClaimFilecoinRow[]
}

export function Blockchain() {
  const [claims, setClaims] = useState<ClaimFilecoinRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Initial load. `loading` already starts true, so nothing is set
  // synchronously here.
  useEffect(() => {
    let cancelled = false

    const run = async () => {
      try {
        const rows = await fetchClaimRows()
        if (cancelled) return
        setClaims(rows)
        setError(null)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void run()
    return () => { cancelled = true }
  }, [])

  /** Refresh is user-initiated, so showing the spinner immediately is fine. */
  const refresh = async () => {
    setLoading(true)
    try {
      setClaims(await fetchClaimRows())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const stored = claims.filter(c => c.filecoin_cid).length
  const attested = claims.filter(c => c.attestation_tx_hash).length
  const simulatedCount = claims.filter(c => c.simulated).length

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Database className="w-6 h-6 text-blue-500" />
            Blockchain & Filecoin
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            On-chain attestations and decentralized storage proofs
            {simulatedCount > 0 && (
              <span
                className="ml-2 inline-flex items-center gap-1 text-xs text-gray-400"
                title="Test-network data: evidence bundles were hashed and content-addressed, but not published to a live network, so explorer links are not shown."
              >
                <FlaskConical className="h-3 w-3" />
                test network
              </span>
            )}
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          className="flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-sm text-gray-500">Total Claims</p>
          <p className="text-3xl font-bold text-gray-900 mt-1">{claims.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-green-100 border-2 p-5">
          <p className="text-sm text-green-600">Stored on Filecoin</p>
          <p className="text-3xl font-bold text-green-700 mt-1">{stored}</p>
        </div>
        <div className="bg-white rounded-xl border border-blue-100 border-2 p-5">
          <p className="text-sm text-blue-600">On-Chain Attested</p>
          <p className="text-3xl font-bold text-blue-700 mt-1">{attested}</p>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <p className="text-red-700">{error}</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Claim</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Customer</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Filecoin CID</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Attestation Tx</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Attested</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {claims.map((claim) => (
                <tr key={claim.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <Link
                      to={`/claims/${claim.id}`}
                      className="text-blue-600 hover:underline font-medium"
                    >
                      {claim.claim_number}
                    </Link>
                    <p className="text-xs text-gray-400 capitalize">{claim.claim_type.replace(/_/g, ' ')}</p>

                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {customerName(claim.customers)}
                  </td>
                  <td className="px-4 py-3">
                    {claim.filecoin_cid && claim.simulated ? (
                      <span
                        className="font-mono text-xs text-gray-500"
                        title={`${claim.filecoin_cid} (simulated — never uploaded)`}
                      >
                        {truncate(claim.filecoin_cid, 18)}
                      </span>
                    ) : claim.filecoin_cid ? (
                      <a
                        href={`https://ipfs.io/ipfs/${claim.filecoin_cid}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-green-700 font-mono text-xs hover:underline"
                        title={claim.filecoin_cid}
                      >
                        {truncate(claim.filecoin_cid, 18)}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                        <Clock className="w-3 h-3" /> Pending
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {claim.attestation_tx_hash && claim.simulated ? (
                      <span
                        className="font-mono text-xs text-gray-500"
                        title={`${claim.attestation_tx_hash} (simulated — not a real transaction)`}
                      >
                        {truncate(claim.attestation_tx_hash, 18)}
                      </span>
                    ) : claim.attestation_tx_hash ? (
                      <a
                        href={`https://sepolia.basescan.org/tx/${claim.attestation_tx_hash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-blue-600 font-mono text-xs hover:underline"
                        title={claim.attestation_tx_hash}
                      >
                        {truncate(claim.attestation_tx_hash, 18)}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {claim.filecoin_cid ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
                        <CheckCircle2 className="w-3 h-3" /> Stored
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
                        <Clock className="w-3 h-3" /> Pending
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {claim.attested_at ? new Date(claim.attested_at).toLocaleDateString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Instructions box */}
      <div className="mt-6 bg-blue-50 border border-blue-100 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-blue-900 mb-2">How Filecoin storage is triggered</h3>
        <ol className="text-sm text-blue-800 space-y-1 list-decimal list-inside">
          <li>A customer makes a call using the ElevenLabs widget (bottom-right corner)</li>
          <li>The AI agent files a claim using the <code className="bg-blue-100 px-1 rounded">file_claim</code> tool</li>
          <li>When the call ends, the backend automatically uploads the evidence bundle to Filecoin</li>
          <li>The Filecoin CID is attested on Base Sepolia via the <code className="bg-blue-100 px-1 rounded">ClaimRegistry</code> contract</li>
          <li>This page and the Claim Detail page update with the CID and transaction hash</li>
        </ol>
      </div>
    </div>
  )
}

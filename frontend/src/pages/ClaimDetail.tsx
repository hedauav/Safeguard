import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, FileText, Phone, Shield, Calendar, DollarSign, User } from 'lucide-react'
import { getClaim } from '../lib/api'
import { ClaimStatusBadge } from '../components/ClaimStatusBadge'
import type { ClaimDetail as ClaimDetailType } from '../types'

export function ClaimDetail() {
  const { id } = useParams<{ id: string }>()
  const [claim, setClaim] = useState<ClaimDetailType | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false

    const load = async () => {
      setLoading(true)
      try {
        const res = await getClaim(id)
        if (!cancelled) setClaim(res.data)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load claim')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [id])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  if (error || !claim) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
        <p className="text-red-700">{error || 'Claim not found'}</p>
        <Link to="/" className="text-blue-600 hover:underline text-sm mt-2 inline-block">
          Back to claims
        </Link>
      </div>
    )
  }

  return (
    <div>
      <Link to="/" className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-900 mb-4">
        <ArrowLeft className="w-4 h-4" />
        Back to Claims
      </Link>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{claim.claim_number}</h1>
          <p className="text-sm text-gray-500 mt-1">Filed {new Date(claim.filed_at).toLocaleDateString()}</p>
        </div>
        <div className="flex items-center gap-3">
          <ClaimStatusBadge status={claim.status} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Claim Info */}
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <FileText className="w-5 h-5 text-gray-400" />
              Claim Details
            </h2>
            <dl className="grid grid-cols-2 gap-4">
              <div>
                <dt className="text-sm text-gray-500">Type</dt>
                <dd className="text-sm font-medium text-gray-900 capitalize">{claim.claim_type.replace(/_/g, ' ')}</dd>
              </div>
              <div>
                <dt className="text-sm text-gray-500">Customer</dt>
                <dd className="text-sm font-medium text-gray-900 flex items-center gap-1">
                  <User className="w-3.5 h-3.5 text-gray-400" />
                  {claim.customer_name}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-gray-500">Incident Date</dt>
                <dd className="text-sm font-medium text-gray-900 flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5 text-gray-400" />
                  {new Date(claim.incident_date).toLocaleDateString()}
                </dd>
              </div>
              {/* No code ever assigns an adjuster — see the note at
                  backend/src/services/claims-service.ts:275. The column is read
                  but never written, so the only non-null values are the ones the
                  seed script invented, and every claim the agent actually files
                  read "Unassigned". Showing that empty row on a real claim
                  implied a queue that does not exist, so the field only appears
                  when the row genuinely carries a name. */}
              {claim.assigned_adjuster && (
                <div>
                  <dt className="text-sm text-gray-500">Adjuster</dt>
                  <dd className="text-sm font-medium text-gray-900">{claim.assigned_adjuster}</dd>
                </div>
              )}
              <div>
                <dt className="text-sm text-gray-500">Claimed Amount</dt>
                <dd className="text-sm font-medium text-gray-900 flex items-center gap-1">
                  <DollarSign className="w-3.5 h-3.5 text-gray-400" />
                  {claim.claimed_amount ? `$${claim.claimed_amount.toLocaleString()}` : 'N/A'}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-gray-500">Approved Amount</dt>
                <dd className="text-sm font-medium text-gray-900">
                  {claim.approved_amount ? `$${claim.approved_amount.toLocaleString()}` : 'Pending'}
                </dd>
              </div>
            </dl>
            {claim.incident_description && (
              <div className="mt-4 pt-4 border-t border-gray-100">
                <dt className="text-sm text-gray-500 mb-1">Incident Description</dt>
                <dd className="text-sm text-gray-700">{claim.incident_description}</dd>
              </div>
            )}
            {claim.notes && (
              <div className="mt-3">
                <dt className="text-sm text-gray-500 mb-1">Notes</dt>
                <dd className="text-sm text-gray-700">{claim.notes}</dd>
              </div>
            )}
          </div>

          {/* Documents */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Documents</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <h3 className="text-sm font-medium text-gray-500 mb-2">Required</h3>
                {claim.documents_required && claim.documents_required.length > 0 ? (
                  <ul className="space-y-1">
                    {claim.documents_required.map((doc, i) => (
                      <li key={i} className="text-sm text-gray-700 flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />
                        {doc}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-gray-400">None specified</p>
                )}
              </div>
              <div>
                <h3 className="text-sm font-medium text-gray-500 mb-2">Received</h3>
                {claim.documents_received && claim.documents_received.length > 0 ? (
                  <ul className="space-y-1">
                    {claim.documents_received.map((doc, i) => (
                      <li key={i} className="text-sm text-green-700 flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                        {doc}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-gray-400">None received</p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar: Policy + Call Logs */}
        <div className="space-y-6">
          {claim.policy && (
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <Shield className="w-5 h-5 text-gray-400" />
                Policy
              </h2>
              <dl className="space-y-3">
                <div>
                  <dt className="text-xs text-gray-500">Policy Number</dt>
                  <dd className="text-sm font-medium text-gray-900">{claim.policy.policy_number}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Type</dt>
                  <dd className="text-sm text-gray-900 capitalize">{claim.policy.policy_type}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Provider</dt>
                  <dd className="text-sm text-gray-900">{claim.policy.provider}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Coverage</dt>
                  <dd className="text-sm font-medium text-gray-900">${claim.policy.coverage_amount.toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Deductible</dt>
                  <dd className="text-sm text-gray-900">${claim.policy.deductible.toLocaleString()}</dd>
                </div>
              </dl>
            </div>
          )}

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            {/* Headed "Related Calls", which overstated the query behind it.
                backend/src/routes/claims.ts filters call_logs by customer_id
                alone — nothing ties a call to this particular claim — so this
                is every call that customer has made, whatever it was about. */}
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Phone className="w-5 h-5 text-gray-400" />
              Calls from this customer
            </h2>
            {claim.call_logs.length > 0 ? (
              <div className="space-y-3">
                {claim.call_logs.map((call) => (
                  <div key={call.id} className="border border-gray-100 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-gray-500 capitalize">{call.direction}</span>
                      <span className="text-xs text-gray-400">
                        {call.duration_seconds ? `${Math.floor(call.duration_seconds / 60)}:${(call.duration_seconds % 60).toString().padStart(2, '0')}` : '—'}
                      </span>
                    </div>
                    <p className="text-sm text-gray-700">{call.summary || 'No summary'}</p>
                    <p className="text-xs text-gray-400 mt-1">{new Date(call.started_at).toLocaleString()}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400">No calls recorded for this customer</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

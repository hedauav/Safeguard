import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, FileText, Phone, Shield, Calendar, DollarSign, User, Clock, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import { clsx } from 'clsx'
import { getClaim } from '../lib/api'
import { ClaimStatusBadge } from '../components/ClaimStatusBadge'
import type { ClaimDetail as ClaimDetailType, JourneyEvent, JsonValue } from '../types'
import { rupees } from '../lib/money'

// ---------------------------------------------------------------------------
// The journey
//
// Until migration 0021 nothing recorded a claim's history, and this page said
// so by showing a single status badge over ten per-step tables it never read.
// `journey_events` is the record; everything below renders that record and
// nothing else.
//
// The one rule that governs all of it: a stage is drawn as reached ONLY when
// an event says it was reached. `filed_at` is not evidence that a "filed"
// event was recorded — it is evidence that the claim row exists — so an empty
// timeline draws no stages at all rather than a plausible-looking first step.
// ---------------------------------------------------------------------------

interface StageDefinition {
  key: string
  label: string
  /**
   * Event-type prefixes that mean this stage has been reached.
   *
   * Prefixes rather than an exact list because the writers of these rows live
   * in five other files: `deductible_requested`, `deductible_paid` and any
   * `deductible_*` a later step adds all belong to the deductible stage, and a
   * stage indicator that silently ignored a new event type would under-report
   * progress. Anything matching no stage is still rendered in full in the
   * event log below — the indicator is a summary, the log is the record.
   */
  prefixes: string[]
}

const JOURNEY_STAGES: StageDefinition[] = [
  { key: 'filed', label: 'Filed', prefixes: ['claim_filed', 'filed'] },
  // Adjudication, document chase and escalation are all one thing from the
  // outside: the claim is being looked at and nobody has decided yet.
  { key: 'under_review', label: 'Under review', prefixes: ['adjudicat', 'document', 'escalat', 'assessment', 'under_review'] },
  { key: 'decided', label: 'Decided', prefixes: ['decid', 'decision'] },
  { key: 'deductible', label: 'Deductible', prefixes: ['deductible'] },
  { key: 'settled', label: 'Settled', prefixes: ['settle'] },
  { key: 'refunded', label: 'Refunded', prefixes: ['refund'] },
]

/**
 * Words in an event type that mark it as a step that did not work.
 *
 * Deliberately narrow. `rejected` and `denied` are NOT here: a rejected claim
 * is a decision that succeeded, and painting it red would tell the reviewer
 * their own decision had malfunctioned. This looks for the step failing, not
 * for an unwelcome outcome.
 */
const FAILURE_WORDS = /(^|_)(failed|failure|error|expired)(_|$)/

/** Whether this event records a step that did not complete. */
function isFailureEvent(event: JourneyEvent): boolean {
  if (FAILURE_WORDS.test(event.event_type.toLowerCase())) return true
  const detail = event.detail
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return false
  if (detail.ok === false || detail.success === false) return true
  if (typeof detail.error === 'string' && detail.error.trim() !== '') return true
  return false
}

function matchesStage(eventType: string, stage: StageDefinition): boolean {
  const type = eventType.toLowerCase()
  return stage.prefixes.some((prefix) => type.startsWith(prefix))
}

interface StageProgress {
  definition: StageDefinition
  /** When the stage was first reached, or null when it has not been. */
  reachedAt: string | null
  /** True when at least one event in this stage records a failure. */
  failed: boolean
  failureDetail: string | null
}

function computeStages(events: JourneyEvent[]): StageProgress[] {
  return JOURNEY_STAGES.map((definition) => {
    const matching = events.filter((event) => matchesStage(event.event_type, definition))
    const failures = matching.filter(isFailureEvent)
    // The EARLIEST matching event, not the latest: a stage is reached the
    // moment it is first reached, and a retry must not make the claim look
    // like it only got there on the second attempt.
    const reachedAt = matching.reduce<string | null>(
      (earliest, event) => (earliest === null || event.occurred_at < earliest ? event.occurred_at : earliest),
      null
    )
    return {
      definition,
      reachedAt,
      failed: failures.length > 0,
      failureDetail: failures.length > 0 ? humaniseEventType(failures[0].event_type) : null,
    }
  })
}

/** `deductible_payment_failed` → `Deductible payment failed`. */
function humaniseEventType(eventType: string): string {
  const words = eventType.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value)
  // A row whose timestamp does not parse is shown verbatim rather than as
  // "Invalid Date" — the stored value is the fact, and hiding it helps nobody.
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

/** Flatten a `detail` JSONB blob into printable pairs, capped so one fat row cannot swamp the page. */
function detailEntries(detail: Record<string, JsonValue> | null): Array<[string, string]> {
  if (!detail) return []
  return Object.entries(detail)
    .slice(0, 8)
    .map(([key, value]) => {
      const printed =
        value === null ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value)
      return [
        key.replace(/_/g, ' '),
        printed.length > 160 ? `${printed.slice(0, 160)}…` : printed,
      ] as [string, string]
    })
}

const ACTOR_STYLES: Record<string, string> = {
  agent: 'bg-blue-50 text-blue-700',
  system: 'bg-gray-100 text-gray-600',
  human: 'bg-purple-50 text-purple-700',
  provider: 'bg-amber-50 text-amber-700',
}

/** One row of the event log. Every event is drawn, whether or not it maps to a stage. */
function JourneyEventRow({ event, isLast }: { event: JourneyEvent; isLast: boolean }) {
  const failed = isFailureEvent(event)
  const entries = detailEntries(event.detail)

  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center pt-1.5">
        <span
          className={clsx('w-2 h-2 rounded-full shrink-0', failed ? 'bg-red-500' : 'bg-gray-300')}
        />
        {/* The connector, suppressed on the final row so the timeline does not
            trail off into a line implying a step that has not been drawn. */}
        {!isLast && <span className="w-px flex-1 bg-gray-200" />}
      </div>
      <div className="pb-4 min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={clsx('text-sm font-medium', failed ? 'text-red-700' : 'text-gray-900')}>
            {humaniseEventType(event.event_type)}
          </span>
          <span
            className={clsx(
              'px-1.5 py-0.5 rounded text-[11px] font-medium',
              ACTOR_STYLES[event.actor] ?? 'bg-gray-100 text-gray-600'
            )}
          >
            {event.actor}
          </span>
          {failed && (
            <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-red-100 text-red-700">
              did not complete
            </span>
          )}
        </div>
        <p className="text-xs text-gray-400 mt-0.5">{formatTimestamp(event.occurred_at)}</p>
        {entries.length > 0 && (
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {entries.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-xs text-gray-400 capitalize whitespace-nowrap">{key}</dt>
                <dd className="text-xs text-gray-600 break-words">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </li>
  )
}

/**
 * The stage indicator plus the full event log.
 *
 * Four distinguishable states, because an empty array on its own cannot tell
 * "nothing has happened" apart from "the table is missing" or "the read
 * failed", and telling a reviewer a claim has no history when the query merely
 * fell over is the exact failure this project was rebuilt to remove.
 */
function JourneyPanel({ claim }: { claim: ClaimDetailType }) {
  const events = claim.journey_events ?? []
  const policyEvents = claim.policy_events ?? []

  // 1. The read failed. Say that, and say nothing about progress — we know
  //    nothing about it, and an empty indicator would be a claim we cannot make.
  if (claim.journey_error) {
    return (
      <div className="bg-white rounded-xl border border-red-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-2 flex items-center gap-2">
          <Clock className="w-5 h-5 text-gray-400" />
          Journey
        </h2>
        <div className="flex items-start gap-2 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <p>
            {claim.journey_error} This is not the same as nothing having happened — the record
            could not be fetched, so this page cannot say how far the claim has got.
          </p>
        </div>
      </div>
    )
  }

  // 2. The table is not there. A named, fixable state, not an outage.
  if (claim.journey_available === false) {
    return (
      <div className="bg-white rounded-xl border border-amber-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-2 flex items-center gap-2">
          <Clock className="w-5 h-5 text-gray-400" />
          Journey
        </h2>
        <div className="flex items-start gap-2 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <p>
            Journey recording is not switched on for this database — migration{' '}
            <code className="text-xs">0021_journey_events.sql</code> has not been applied. No claim
            has a timeline until it is.
          </p>
        </div>
      </div>
    )
  }

  // 3. Nothing was ever written for this claim. State it plainly. In
  //    particular, do NOT draw a "Filed" step out of `filed_at`: the claim row
  //    existing proves the claim was filed, it does not prove anybody recorded
  //    the step, and a timeline that fabricates its first entry is worth less
  //    than no timeline at all.
  if (events.length === 0 && policyEvents.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-2 flex items-center gap-2">
          <Clock className="w-5 h-5 text-gray-400" />
          Journey
        </h2>
        <p className="text-sm text-gray-600">
          No steps were recorded for this claim.
        </p>
        <p className="text-sm text-gray-500 mt-2">
          The journey log only holds what was written after it existed. This claim was filed on{' '}
          {formatTimestamp(claim.filed_at)}, and whatever happened to it since was not written
          down — which is not the same as nothing having happened. Its current status is{' '}
          <span className="font-medium text-gray-700">{claim.status.replace(/_/g, ' ')}</span>.
        </p>
      </div>
    )
  }

  const stages = computeStages(events)

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
        <Clock className="w-5 h-5 text-gray-400" />
        Journey
      </h2>

      {/* The claim has policy events but none of its own. Every stage below
          will read "Not reached", which is true and would otherwise look like
          a rendering fault, so it is stated rather than left to be inferred. */}
      {events.length === 0 && (
        <p className="text-sm text-gray-500 mb-4">
          Nothing was recorded against this claim itself. The policy events below are the whole of
          what exists.
        </p>
      )}

      {/* Stage indicator. Never wraps a stage in optimism: a stage with no
          event under it reads "Not reached", full stop. */}
      <ol className="flex flex-wrap gap-y-4 mb-6">
        {stages.map((stage) => (
          <li key={stage.definition.key} className="flex items-start min-w-[9rem] flex-1">
            <div className="flex flex-col items-center mr-2">
              {stage.failed ? (
                <XCircle className="w-5 h-5 text-red-500 shrink-0" />
              ) : stage.reachedAt ? (
                <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />
              ) : (
                <span className="w-5 h-5 rounded-full border-2 border-dashed border-gray-300 shrink-0" />
              )}
            </div>
            <div className="min-w-0">
              <p
                className={clsx(
                  'text-sm font-medium',
                  stage.failed ? 'text-red-700' : stage.reachedAt ? 'text-gray-900' : 'text-gray-400'
                )}
              >
                {stage.definition.label}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">
                {stage.reachedAt ? formatTimestamp(stage.reachedAt) : 'Not reached'}
              </p>
              {stage.failed && (
                <p className="text-xs text-red-600 mt-0.5">{stage.failureDetail}</p>
              )}
            </div>
          </li>
        ))}
      </ol>

      {claim.journey_truncated && (
        <p className="text-xs text-amber-700 mb-3 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          More events exist than the server returns. The log below is the earliest part of the
          record, not all of it.
        </p>
      )}

      {events.length > 0 && (
        <>
          <h3 className="text-sm font-medium text-gray-500 mb-3">
            Every step recorded, oldest first
          </h3>
          <ol>
            {events.map((event, index) => (
              <JourneyEventRow key={event.id} event={event} isLast={index === events.length - 1} />
            ))}
          </ol>
        </>
      )}

      {policyEvents.length > 0 && (
        <div className="mt-4 pt-4 border-t border-gray-100">
          {/* Renewals belong to the policy, not to this claim — a policy can be
              renewed with no claim in sight. They are shown because "lapsed →
              renewed → filed → paid" is one story, and kept under their own
              heading because listing them among the claim's steps would say
              they were part of it. They are not counted by the indicator above. */}
          <h3 className="text-sm font-medium text-gray-500 mb-3">
            Policy events — recorded against the policy, not this claim
          </h3>
          <ol>
            {policyEvents.map((event, index) => (
              <JourneyEventRow
                key={event.id}
                event={event}
                isLast={index === policyEvents.length - 1}
              />
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}

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

      {/* Full width and above everything else: where the claim has actually got
          to is the question this page is opened to answer, and it used to be
          answerable only by the one status badge in the header. */}
      <JourneyPanel claim={claim} />

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
                  {rupees(claim.claimed_amount, 'N/A')}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-gray-500">Approved Amount</dt>
                <dd className="text-sm font-medium text-gray-900">
                  {rupees(claim.approved_amount, 'Pending')}
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
                  <dd className="text-sm font-medium text-gray-900">{rupees(claim.policy.coverage_amount)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Deductible</dt>
                  <dd className="text-sm text-gray-900">{rupees(claim.policy.deductible)}</dd>
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

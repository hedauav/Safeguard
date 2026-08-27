import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, CircleSlash, Coins, Cpu,
  Gavel, Info, KeyRound, RefreshCw, Scale, ShieldAlert, ThumbsDown, ThumbsUp,
  UserCheck, X,
} from 'lucide-react'
import { LoadingSpinner } from '../components/LoadingSpinner'
import { ErrorState } from '../components/ErrorState'
import {
  getReviewQueue, decideAdjudication,
  getAdminToken, setAdminToken, getReviewerName, setReviewerName,
} from '../lib/api'
import type {
  Adjudication, AdjudicationCheck, AdjudicationReview, FaultDetermination,
  ReviewDecisionResult, ReviewQueueItem, ReviewQueueResponse,
} from '../types'

/**
 * The human review queue.
 *
 * `adjudication-service.ts` produces recommendations and nothing else — it
 * never writes `claims.status`. This is the screen where that stops being an
 * assertion in a comment and becomes something you can watch happen: a person
 * reads the working, presses a button, and the claim moves.
 *
 * Everything on it is a column that exists in `adjudications` (0017) or
 * `adjudication_reviews` (0019). There is no sample row, no placeholder
 * recommendation, and no state this page can enter that the database did not
 * put it in. Four distinctions are load-bearing and each is drawn explicitly
 * rather than left to the reader:
 *
 *  * A RULE VETO is not a model opinion. When `vetoed_by` is set the model was
 *    never called, so no field is labelled as something a model said — the
 *    confidence is arithmetic, the finding is the rule's own sentence, and the
 *    provenance block says the model was not consulted.
 *
 *  * A MODEL THAT ANSWERED UNUSABLY is not a model that answered. `parse_error`
 *    gets its own block and the findings beside it are labelled as the recorded
 *    failure, not as the model's reading of the claim.
 *
 *  * "NO ADJUDICATION HAS RUN" is not "adjudication ran and escalated". Only
 *    claims with a recommendation can appear here at all, so the count of
 *    claims with none is reported beside the queue — and comes back blank
 *    rather than approximate when the scan could not see the whole table.
 *
 *  * A DISAGREEMENT ABOUT MONEY is the tripwire. The computed figure and the
 *    model's proposed figure are always shown side by side, never merged, and
 *    a mismatch is the loudest thing on the row.
 *
 *  * NO FAULT FINDING is not a finding of no fault. The fault control below is
 *    optional because the endpoint's is, and a reviewer who does not know must
 *    be able to approve without asserting one — but leaving it unrecorded is
 *    what makes the deductible unrefundable, so the consequence is stated
 *    beside the control rather than arriving as a warning after the click.
 */

const CURRENCY = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : `$${Number(value).toLocaleString()}`

const VERDICT_STYLE: Record<string, string> = {
  approve: 'bg-green-100 text-green-800 border-green-200',
  deny: 'bg-red-100 text-red-800 border-red-200',
  escalate: 'bg-amber-100 text-amber-800 border-amber-200',
}

/**
 * What a reviewer can say about fault, including saying nothing.
 *
 * `'unset'` is this page's word for the absence of a choice; it is never sent.
 * The other four are the literal strings `adjudication-review.ts` validates
 * against, written out here rather than assembled, because the server refuses
 * an unrecognised value by name instead of coercing it — and a fault finding
 * silently mapped onto the wrong word could waive money.
 *
 * `wire` is what actually goes on the request, shown to the reader so the
 * label on the button and the value in the audit record can be checked against
 * each other. Only `other_party` waives the deductible; `shared` does not, and
 * that is a rule of the policy rather than an oversight here.
 */
type FaultChoice = FaultDetermination | 'unset'

const FAULT_CHOICES: {
  key: FaultChoice
  label: string
  wire: string
  waives: boolean
  consequence: string
}[] = [
  {
    key: 'unset',
    label: 'Not recorded',
    wire: 'omitted from the request',
    waives: false,
    consequence:
      'Nothing is written to the claim. A claim with no fault finding on it can never have its deductible waived, so the excess stays with the policyholder until somebody records one — on this decision or a later one.',
  },
  {
    key: 'other_party',
    label: 'The other party',
    wire: 'other_party',
    waives: true,
    consequence:
      'The one finding that waives the deductible. If the claim has already been settled the refund is made now; otherwise it follows automatically when the claim settles. This is the only path in this system that moves money back out to the policyholder.',
  },
  {
    key: 'insured',
    label: 'Our policyholder',
    wire: 'insured',
    waives: false,
    consequence:
      'The deductible stands and is not returned. The finding is written to the claim and attributed to you.',
  },
  {
    key: 'shared',
    label: 'Shared',
    wire: 'shared',
    waives: false,
    consequence:
      'Shared fault does not waive the deductible — deliberately, not by omission. The excess stands.',
  },
  {
    key: 'undetermined',
    label: 'Looked into, undetermined',
    wire: 'undetermined',
    waives: false,
    consequence:
      'A recorded finding that fault could not be established. No refund follows. It differs from leaving this unrecorded in one way only, and it is the way that matters to whoever reads the claim next: it says somebody looked.',
  },
]

/** Which of the three mutually exclusive provenance states a row is in. */
type Provenance = 'rule_veto' | 'model_unusable' | 'model_spoke'

function provenanceOf(a: Adjudication): Provenance {
  if (a.vetoed_by) return 'rule_veto'
  if (a.parse_error || !a.model_invoked) return 'model_unusable'
  return 'model_spoke'
}

function Banner({ kind, children }: { kind: 'warn' | 'err' | 'info'; children: React.ReactNode }) {
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

/**
 * One precondition for deciding, stated before anybody clicks anything.
 *
 * The point of the row of these is that a reader can tell what the page wants
 * from them without pressing a dead button to find out.
 */
function ReadyFlag({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${ok ? 'text-green-700' : 'text-amber-700'}`}>
      {ok
        ? <Check className="w-3.5 h-3.5 shrink-0" />
        : <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
      {ok ? okText : badText}
    </span>
  )
}

/**
 * The two figures, side by side, never merged.
 *
 * The computed figure is the one with authority; the model's is carried only
 * so it can be compared. When they disagree the verdict was forced to escalate
 * in code, and this panel is where a reviewer sees why.
 */
function AmountPanel({ a }: { a: Adjudication }) {
  const disagreed = a.amount_agreement === 'disagreed'

  const modelFigure = () => {
    switch (a.amount_agreement) {
      case 'not_asked':
        return {
          value: '—',
          note: a.vetoed_by
            ? 'The model was never asked: a rule vetoed before it was called.'
            : 'The model was never asked, or produced no usable answer.',
        }
      case 'not_proposed':
        return { value: '—', note: 'The model was asked and returned no figure.' }
      default:
        return { value: CURRENCY(a.model_proposed_amount), note: 'Recorded for comparison. Never paid.' }
    }
  }
  const model = modelFigure()

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Computed payable</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{CURRENCY(a.computed_payable_amount)}</p>
          <p className="text-xs text-gray-500 mt-1">
            Arithmetic, in code, by the same function the settlement path uses. The only figure with authority.
          </p>
        </div>
        <div className={`rounded-lg border p-4 ${disagreed ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-white'}`}>
          <p className={`text-xs font-medium uppercase tracking-wider ${disagreed ? 'text-red-700' : 'text-gray-500'}`}>
            Model proposed
          </p>
          <p className={`text-2xl font-bold mt-1 ${disagreed ? 'text-red-700' : 'text-gray-900'}`}>{model.value}</p>
          <p className={`text-xs mt-1 ${disagreed ? 'text-red-700' : 'text-gray-500'}`}>{model.note}</p>
        </div>
      </div>

      {disagreed ? (
        <div className="mt-3 rounded-lg border-2 border-red-400 bg-red-50 px-4 py-3 flex items-start gap-2">
          <ShieldAlert className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
          <div className="text-sm text-red-800">
            <p className="font-semibold">The two figures disagree.</p>
            <p className="mt-0.5">
              A model whose arithmetic differs from ours has misread something. The verdict was forced to{' '}
              <span className="font-mono font-semibold">escalate</span> in code, and the computed figure stands
              regardless of what the model said.
            </p>
          </div>
        </div>
      ) : a.amount_agreement === 'agreed' ? (
        <p className="mt-2 text-sm text-green-700 flex items-center gap-1.5">
          <Check className="w-4 h-4" /> The model&apos;s figure matches the computed one.
        </p>
      ) : (
        <p className="mt-2 text-sm text-gray-500 flex items-center gap-1.5">
          <CircleSlash className="w-4 h-4" />
          No figure was compared — <span className="font-mono">{a.amount_agreement}</span>.
        </p>
      )}
    </div>
  )
}

/** Every deterministic check that ran, in order, passes included. */
function ChecksPanel({ checks, vetoedBy }: { checks: AdjudicationCheck[]; vetoedBy: string | null }) {
  if (!Array.isArray(checks) || checks.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        No checks are recorded on this row. That is a gap in the record, not a claim that none ran.
      </p>
    )
  }

  const failed = checks.filter((c) => !c.passed).length

  return (
    <div>
      <p className="text-xs text-gray-500 mb-2">
        {checks.length} check{checks.length === 1 ? '' : 's'} ran, {failed} failed.
        {' '}The passes are shown too: they are the evidence the model was only asked what it was entitled to answer.
      </p>
      <ul className="space-y-1.5">
        {checks.map((check, i) => {
          const isVeto = vetoedBy !== null && check.id === vetoedBy
          return (
            <li
              key={`${check.id}-${i}`}
              className={`flex items-start gap-2 text-sm rounded-md px-2 py-1.5 ${
                isVeto ? 'bg-red-50 border border-red-200' : check.passed ? '' : 'bg-amber-50'
              }`}
            >
              {check.passed
                ? <Check className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                : <X className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />}
              <div className="min-w-0">
                <span className="font-mono text-xs text-gray-700">{check.id}</span>
                {isVeto && (
                  <span className="ml-2 text-xs font-semibold text-red-700 uppercase tracking-wide">
                    vetoed → {check.vetoes ?? 'escalate'}
                  </span>
                )}
                {!check.passed && !isVeto && check.vetoes && (
                  <span className="ml-2 text-xs text-amber-700">forces {check.vetoes}</span>
                )}
                <p className={`${check.passed ? 'text-gray-500' : 'text-gray-800'}`}>{check.detail}</p>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * Which engine produced this recommendation, and what that means for
 * everything else on the row.
 */
function ProvenancePanel({ a, provenance }: { a: Adjudication; provenance: Provenance }) {
  if (provenance === 'rule_veto') {
    return (
      <div className="rounded-lg border border-purple-200 bg-purple-50 p-4">
        <div className="flex items-center gap-2 text-purple-900 font-semibold text-sm">
          <Gavel className="w-4 h-4" /> Decided by rule. The model was never consulted.
        </div>
        <p className="text-sm text-purple-900 mt-1">
          Check <span className="font-mono font-semibold">{a.vetoed_by}</span> vetoed before any model was called,
          so there is no model output on this row and none is shown.
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-purple-900">
          <dt className="text-purple-700">Confidence</dt>
          <dd>{a.confidence} — arithmetic and date comparison, not a model&apos;s estimate of itself</dd>
          <dt className="text-purple-700">Model</dt>
          <dd>not invoked</dd>
        </dl>
      </div>
    )
  }

  const modelLine = (
    <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1 text-xs text-gray-700">
      <dt className="text-gray-500">Model</dt>
      <dd className="font-mono break-all">{a.model_id ?? 'not recorded'}</dd>
      <dt className="text-gray-500">Provider</dt>
      <dd className="font-mono">{a.model_provider ?? 'not recorded'}</dd>
      <dt className="text-gray-500">Latency</dt>
      <dd>{a.model_latency_ms === null ? 'not recorded' : `${a.model_latency_ms} ms`}</dd>
    </dl>
  )

  if (provenance === 'model_unusable') {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
        <div className="flex items-center gap-2 text-amber-900 font-semibold text-sm">
          <AlertTriangle className="w-4 h-4" />
          {a.model_invoked
            ? 'The model was called and its answer could not be used.'
            : 'No model answer is recorded on this row.'}
        </div>
        {a.parse_error && (
          <pre className="mt-2 text-xs bg-white border border-amber-200 rounded p-2 whitespace-pre-wrap break-words text-amber-900">
            {a.parse_error}
          </pre>
        )}
        <p className="text-sm text-amber-900 mt-2">
          Nothing was defaulted: the failure was recorded and the verdict escalated. The findings below are that
          recorded failure, not the model&apos;s reading of the claim.
        </p>
        {a.model_invoked && modelLine}
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-center gap-2 text-gray-900 font-semibold text-sm">
        <Cpu className="w-4 h-4 text-blue-600" /> A model read the documents and answered.
      </div>
      <p className="text-sm text-gray-600 mt-1">
        Self-reported confidence <span className="font-semibold">{(a.confidence * 100).toFixed(0)}%</span>.
        {' '}That is the model&apos;s own estimate of itself, and is not evidence of anything.
      </p>
      {a.simulated && (
        <div className="mt-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <span className="font-semibold">Simulated.</span> This answer came from the fake provider because no
          model API key is configured. No model read anything. Do not treat this as a reviewed claim.
        </div>
      )}
      {modelLine}
    </div>
  )
}

function FindingsPanel({ a, provenance }: { a: Adjudication; provenance: Provenance }) {
  const modelSpoke = provenance === 'model_spoke'
  const findingsLabel = provenance === 'rule_veto'
    ? 'Rule finding'
    : modelSpoke
      ? 'Inconsistencies the model reported'
      : 'Recorded failure'

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
          Policy clauses cited
        </h4>
        {!modelSpoke ? (
          <p className="text-sm text-gray-500">
            None. Clauses are only ever cited by the model, and no model output stands on this row.
          </p>
        ) : a.policy_clauses.length === 0 ? (
          <p className="text-sm text-gray-500">The model cited no clause.</p>
        ) : (
          <ul className="space-y-1.5">
            {a.policy_clauses.map((clause, i) => (
              <li key={i} className="text-sm text-gray-800 bg-gray-50 border border-gray-200 rounded px-2 py-1.5">
                {clause}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{findingsLabel}</h4>
        {a.inconsistencies.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing recorded.</p>
        ) : (
          <ul className="space-y-1.5">
            {a.inconsistencies.map((entry, i) => (
              <li key={i} className="text-sm text-gray-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                {entry}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** The decision already on file, when there is one. */
function DecidedPanel({ review }: { review: AdjudicationReview }) {
  const overrode =
    (review.decision === 'approved' && review.recommended_verdict !== 'approve') ||
    (review.decision === 'rejected' && review.recommended_verdict !== 'deny')

  return (
    <div className="rounded-lg border border-gray-300 bg-gray-50 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
        <UserCheck className="w-4 h-4" />
        {review.reviewer} {review.decision === 'approved' ? 'approved' : 'rejected'} this claim on{' '}
        {new Date(review.decided_at).toLocaleString()}
      </div>
      <dl className="mt-3 grid grid-cols-[11rem_1fr] gap-x-4 gap-y-1 text-xs text-gray-700">
        <dt className="text-gray-500">Recommendation then</dt>
        <dd className="font-mono">{review.recommended_verdict}</dd>
        <dt className="text-gray-500">Agreement</dt>
        <dd className={overrode ? 'text-amber-700 font-semibold' : ''}>
          {overrode ? 'The human went against the recommendation.' : 'The human agreed with the recommendation.'}
        </dd>
        <dt className="text-gray-500">Claim status</dt>
        <dd>
          {review.claim_status_after === null ? (
            <span className="text-amber-700">
              not changed by this decision (still <span className="font-mono">{review.claim_status_before ?? 'unknown'}</span>)
            </span>
          ) : (
            <>
              <span className="font-mono">{review.claim_status_before ?? 'unknown'}</span>
              {' → '}
              <span className="font-mono font-semibold">{review.claim_status_after}</span>
            </>
          )}
        </dd>
      </dl>
      {review.note && <p className="mt-2 text-sm text-gray-700 italic">&ldquo;{review.note}&rdquo;</p>}
      <p className="mt-3 text-xs text-gray-400">
        The reviewer name is an attribution supplied with the admin token, not an authenticated identity.
      </p>
    </div>
  )
}

/**
 * Who was at fault, and what saying so does.
 *
 * The consequence of the current choice is rendered under the choices, in the
 * present tense, before anything is pressed. The alternative — which is what
 * this page did — is a reviewer who finds out that the deductible cannot be
 * waived from a warning in the response, once the decision is already on file
 * and a second one on the same recommendation is a 409.
 */
function FaultPanel({ value, onChange }: { value: FaultChoice; onChange: (v: FaultChoice) => void }) {
  const chosen = FAULT_CHOICES.find((c) => c.key === value) ?? FAULT_CHOICES[0]

  return (
    <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
      <h5 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
        <Coins className="w-3.5 h-3.5" /> Who was at fault
        <span className="font-normal normal-case tracking-normal text-gray-400">— optional</span>
      </h5>
      <p className="text-xs text-gray-500 mt-1">
        The deductible refund is gated on this field, and on this field alone. Recording{' '}
        <span className="font-mono">other_party</span> is what lets the policyholder&apos;s excess be given
        back; every other answer, including no answer, leaves it with them.
      </p>

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {FAULT_CHOICES.map((c) => {
          const active = c.key === value
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => onChange(c.key)}
              aria-pressed={active}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
                active
                  ? c.waives
                    ? 'bg-green-600 text-white border-green-600'
                    : c.key === 'unset'
                      ? 'bg-amber-500 text-white border-amber-500'
                      : 'bg-gray-800 text-white border-gray-800'
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'
              }`}
            >
              {c.waives && <Coins className="w-3.5 h-3.5" />}
              {c.label}
            </button>
          )
        })}
      </div>

      <div
        className={`mt-2.5 rounded px-3 py-2 text-sm border flex items-start gap-2 ${
          chosen.waives
            ? 'bg-green-50 border-green-200 text-green-900'
            : chosen.key === 'unset'
              ? 'bg-amber-50 border-amber-200 text-amber-900'
              : 'bg-white border-gray-200 text-gray-700'
        }`}
      >
        {chosen.waives
          ? <Check className="w-4 h-4 mt-0.5 shrink-0" />
          : chosen.key === 'unset'
            ? <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            : <Info className="w-4 h-4 mt-0.5 shrink-0" />}
        <span>{chosen.consequence}</span>
      </div>

      <p className="mt-1.5 text-[11px] text-gray-400">
        Sent as <span className="font-mono">{chosen.wire}</span>. A finding is written to the claim and
        attributed to you by name; it is a fact about the incident, not a status, so it is recorded
        whichever way you decide.
      </p>
    </div>
  )
}

/**
 * What the server did, in its own words, after a decision was accepted.
 *
 * The response carries warnings the queue cannot re-derive once it reloads —
 * above all the one that says an approved claim has no fault finding and so
 * can never have its deductible waived. Reloading immediately, which is what
 * this page used to do on success, threw that sentence away. So the reload is
 * put behind a button and the sentences are shown first.
 */
function DecisionOutcomePanel({
  result, onReload,
}: { result: ReviewDecisionResult; onReload: () => void }) {
  const refund = result.deductible_refund

  return (
    <div className="rounded-lg border border-gray-300 bg-white p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
        <UserCheck className="w-4 h-4" />
        Recorded. {result.reviewer} {result.decision === 'approved' ? 'approved' : 'rejected'}{' '}
        <span className="font-mono">{result.claim_number}</span>.
      </div>

      <dl className="mt-3 grid grid-cols-[11rem_1fr] gap-x-4 gap-y-1 text-xs text-gray-700">
        <dt className="text-gray-500">Claim status</dt>
        <dd>
          {result.claim_status_after === null ? (
            <span className="text-amber-700">
              not changed by this decision (still{' '}
              <span className="font-mono">{result.claim_status_before ?? 'unknown'}</span>)
            </span>
          ) : (
            <>
              <span className="font-mono">{result.claim_status_before ?? 'unknown'}</span>
              {' → '}
              <span className="font-mono font-semibold">{result.claim_status_after}</span>
            </>
          )}
        </dd>
        <dt className="text-gray-500">Fault on the claim</dt>
        <dd>
          {/* What the server says it wrote, not what was picked here. The two
              differ when the claim update failed, and a warning below says so. */}
          {result.fault_determination === null ? (
            <span className="text-amber-700">nothing was written</span>
          ) : (
            <>
              <span className="font-mono font-semibold">{result.fault_determination}</span>
              {result.fault_determined_by && <> — recorded by {result.fault_determined_by}</>}
            </>
          )}
        </dd>
      </dl>

      {result.warnings.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {result.warnings.map((warning, i) => (
            <li
              key={i}
              className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2 flex items-start gap-2"
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      )}

      {result.deductible_refund_note && (
        <p className="mt-2 text-sm text-blue-900 bg-blue-50 border border-blue-200 rounded px-3 py-2 flex items-start gap-2">
          <Info className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{result.deductible_refund_note}</span>
        </p>
      )}

      {refund && (refund.success ? (
        <div className="mt-2 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
          <p className="font-semibold flex items-center gap-1.5">
            <Coins className="w-4 h-4" /> The deductible was refunded.
          </p>
          <p className="mt-0.5">{refund.message}</p>
          <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-x-4 gap-y-0.5 text-xs">
            {/* No currency symbol is invented here: the amount is shown as the
                rail returned it, and the message above words it in full. */}
            <dt className="text-green-700">Amount</dt>
            <dd className="font-mono">{refund.refund_amount.toFixed(2)}</dd>
            <dt className="text-green-700">Refund id</dt>
            <dd className="font-mono break-all">{refund.refund_id}</dd>
            <dt className="text-green-700">Status</dt>
            <dd className="font-mono">{refund.refund_status}</dd>
          </dl>
          {refund.simulated && (
            <p className="mt-2 rounded border border-red-300 bg-red-50 px-2 py-1.5 text-red-800">
              <span className="font-semibold">Simulated.</span> No payment rail was called and no money
              actually moved. Do not report this as a refund to a customer.
            </p>
          )}
          {refund.stands_in_for_settlement && refund.settlement_disclosure && (
            <p className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-amber-900">
              {refund.settlement_disclosure}
            </p>
          )}
        </div>
      ) : (
        <div className="mt-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <p className="font-semibold">The fault finding waives the deductible, but it was not refunded.</p>
          <p className="mt-0.5">{refund.message}</p>
          <p className="mt-1 text-xs">
            Refused at <span className="font-mono">{refund.reason}</span>. The decision and the fault
            finding are both on file; only the money did not move.
          </p>
        </div>
      ))}

      <button
        type="button"
        onClick={onReload}
        className="mt-3 inline-flex items-center gap-1.5 text-blue-700 text-sm font-medium hover:underline"
      >
        <RefreshCw className="w-3.5 h-3.5" /> Reload the queue
      </button>
    </div>
  )
}

interface RowProps {
  item: ReviewQueueItem
  expanded: boolean
  onToggle: () => void
  reviewer: string
  token: string
  onReviewerChange: (value: string) => void
  onTokenChange: (value: string) => void
  canDecide: boolean
  disabledReason: string | null
  /**
   * True when the only thing standing between this row and a decision is a
   * field the browser owns — the reviewer name or the admin token. Those are
   * fixable here; a server that has no `ADMIN_TOKEN` is not.
   */
  fixableHere: boolean
  onDecided: () => void
}

/** What went wrong, and whether it is actually wrong. */
type Failure = { kind: 'error' | 'conflict'; text: string }

function QueueRow({
  item, expanded, onToggle, reviewer, token, onReviewerChange, onTokenChange,
  canDecide, disabledReason, fixableHere, onDecided,
}: RowProps) {
  const a = item.adjudication
  const provenance = provenanceOf(a)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null)
  const [failure, setFailure] = useState<Failure | null>(null)

  /**
   * The fault finding lives on the row, not on the page.
   *
   * A finding is a statement about one incident. Page-level state would let a
   * reviewer pick `other_party` on one claim, move to the next, and approve it
   * with a finding they never made about it — a false record, on the field that
   * decides whether money goes back out. Per-row state cannot do that.
   */
  const [fault, setFault] = useState<FaultChoice>('unset')

  /** What the server said about the decision it just accepted. */
  const [outcome, setOutcome] = useState<ReviewDecisionResult | null>(null)

  // Collapsing the row clears it, for the same reason: a row that remembers a
  // finding while out of sight is a finding nobody is looking at.
  useEffect(() => {
    if (!expanded) {
      setFault('unset')
      setOutcome(null)
    }
  }, [expanded])

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(decision)
    setFailure(null)
    try {
      // 'unset' is this page's word for "no answer" and is never sent; the
      // helper leaves the field off the request entirely, which is what the
      // server reads as "not yet known".
      const res = await decideAdjudication(
        a.id,
        decision,
        reviewer.trim(),
        note.trim() || undefined,
        fault === 'unset' ? undefined : fault
      )
      if (res.error) {
        setFailure({ kind: 'error', text: res.error })
      } else if (
        res.data &&
        (res.data.warnings.length > 0 ||
          res.data.deductible_refund !== null ||
          res.data.deductible_refund_note !== null)
      ) {
        // The server had something to say — most often that this approval has
        // no fault finding, so the deductible can never be waived. Reloading
        // now would discard it, and the recommendation cannot be decided twice
        // to get it back. Show it, and let the reader trigger the reload.
        setOutcome(res.data)
        setFault('unset')
      } else {
        onDecided()
      }
    } catch (err) {
      const anyErr = err as {
        response?: { status?: number; data?: { error?: string } }
        message?: string
      }
      const serverSaid = anyErr.response?.data?.error

      if (!anyErr.response) {
        // No response at all: the request never reached a server that could
        // answer it, so nothing was recorded. Axios flattens this to a bare
        // "Network Error", which reads like a bug in this page rather than an
        // unreachable API.
        setFailure({
          kind: 'error',
          text:
            'The API never answered, so nothing was recorded. The server may be down, ' +
            'or the browser may have refused the request (CORS / mixed content). ' +
            `Underlying error: ${anyErr.message ?? 'no detail'}.`,
        })
      } else if (anyErr.response.status === 409) {
        // 409 is the server holding a line, not failing: this recommendation
        // has already been answered, or a newer run has superseded it.
        setFailure({
          kind: 'conflict',
          text: serverSaid ?? 'This recommendation has already been decided.',
        })
      } else {
        // The server's own message, when there is one — it names the actual
        // reason (bad token, missing reviewer) far better than a generic
        // sentence would.
        setFailure({
          kind: 'error',
          text: serverSaid ?? anyErr.message ?? 'The decision could not be recorded.',
        })
      }
    } finally {
      setBusy(null)
    }
  }

  const provenanceChip = provenance === 'rule_veto'
    ? { text: 'Rule veto — no model', cls: 'bg-purple-100 text-purple-800 border-purple-200' }
    : provenance === 'model_unusable'
      ? { text: 'Model answer unusable', cls: 'bg-amber-100 text-amber-800 border-amber-200' }
      : { text: a.simulated ? 'Simulated model' : 'Model answered', cls: a.simulated
          ? 'bg-red-100 text-red-800 border-red-200'
          : 'bg-blue-50 text-blue-700 border-blue-200' }

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
      >
        {expanded ? <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-blue-600">{a.claim_number}</span>
            {item.claim?.customer_name && (
              <span className="text-sm text-gray-600">{item.claim.customer_name}</span>
            )}
            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium capitalize ${VERDICT_STYLE[a.verdict] ?? 'bg-gray-100 text-gray-700 border-gray-200'}`}>
              {a.verdict}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded-full border ${provenanceChip.cls}`}>
              {provenanceChip.text}
            </span>
            {a.amount_agreement === 'disagreed' && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-red-600 text-white font-semibold">
                amounts disagree
              </span>
            )}
            {item.review && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-white">
                {item.review.decision} by {item.review.reviewer}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            recommended {new Date(a.created_at).toLocaleString()}
            {' · computed payable '}{CURRENCY(a.computed_payable_amount)}
            {item.claim && <> · claim status <span className="font-mono">{item.claim.status}</span></>}
            {item.superseded_count > 0 && <> · supersedes {item.superseded_count} earlier run{item.superseded_count === 1 ? '' : 's'}</>}
          </p>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-200 p-4 space-y-5 bg-gray-50/60">
          <AmountPanel a={a} />
          <ProvenancePanel a={a} provenance={provenance} />
          <FindingsPanel a={a} provenance={provenance} />

          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
              Deterministic checks
            </h4>
            <ChecksPanel checks={a.checks} vetoedBy={a.vetoed_by} />
          </div>

          <div className="flex items-center gap-4 text-xs text-gray-400">
            <span className="font-mono">adjudication {a.id}</span>
            {item.claim && (
              <Link to={`/claims/${item.claim.id}`} className="text-blue-600 hover:underline">
                open the claim →
              </Link>
            )}
          </div>

          {item.review ? (
            <DecidedPanel review={item.review} />
          ) : outcome ? (
            <DecisionOutcomePanel result={outcome} onReload={onDecided} />
          ) : (
            <div className="rounded-lg border border-gray-300 bg-white p-4">
              <h4 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                <Scale className="w-4 h-4" /> Your decision
              </h4>
              <p className="text-xs text-gray-500 mt-1">
                Approving sets the claim to <span className="font-mono">approved</span>, which is the only status
                the settlement path will disburse from. Rejecting sets it to <span className="font-mono">denied</span>.
                Neither figure above is changed by either button.
              </p>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why (optional) — recorded verbatim against this decision"
                rows={2}
                className="mt-3 w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />

              <FaultPanel value={fault} onChange={setFault} />

              {failure && failure.kind === 'error' && (
                <p className="mt-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
                  {failure.text}
                </p>
              )}
              {failure && failure.kind === 'conflict' && (
                <div className="mt-2 text-sm text-blue-900 bg-blue-50 border border-blue-200 rounded px-3 py-2 flex items-start gap-2">
                  <Info className="w-4 h-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold">Nothing was recorded, and nothing is broken.</p>
                    <p className="mt-0.5">{failure.text}</p>
                    <button
                      onClick={onDecided}
                      className="mt-1.5 inline-flex items-center gap-1.5 text-blue-700 font-medium hover:underline"
                    >
                      <RefreshCw className="w-3.5 h-3.5" /> Reload the queue to see what is on file
                    </button>
                  </div>
                </div>
              )}

              {/* Every path that greys the buttons says why, right here, so the
                  reason cannot scroll away with the banners at the top. */}
              {disabledReason && (
                <div className="mt-2 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p>{disabledReason}</p>

                    {/* The fields the message points at, repeated where the
                        message is, so "enter your token" is something you can
                        act on without losing this row. */}
                    {fixableHere && (
                      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[11px] font-medium text-amber-800 uppercase tracking-wider mb-1">
                            Reviewer
                          </label>
                          <input
                            value={reviewer}
                            onChange={(e) => onReviewerChange(e.target.value)}
                            placeholder="Your name"
                            className="w-full px-3 py-1.5 bg-white border border-amber-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] font-medium text-amber-800 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                            <KeyRound className="w-3 h-3" /> Admin token
                          </label>
                          <input
                            type="password"
                            value={token}
                            onChange={(e) => onTokenChange(e.target.value)}
                            placeholder="ADMIN_TOKEN"
                            className="w-full px-3 py-1.5 bg-white border border-amber-300 rounded-lg text-sm font-mono text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => void decide('approve')}
                  disabled={!canDecide || busy !== null}
                  title={disabledReason ?? undefined}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ThumbsUp className="w-4 h-4" />
                  {busy === 'approve' ? 'Recording…' : 'Approve claim'}
                </button>
                <button
                  onClick={() => void decide('reject')}
                  disabled={!canDecide || busy !== null}
                  title={disabledReason ?? undefined}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ThumbsDown className="w-4 h-4" />
                  {busy === 'reject' ? 'Recording…' : 'Reject claim'}
                </button>
                {canDecide && (
                  <span className="text-xs text-gray-500">
                    Signed <span className="font-medium text-gray-700">{reviewer.trim()}</span>
                    {' · fault '}
                    {/* Restated at the button, because the picker scrolls and
                        this is the last thing read before the click. */}
                    {fault === 'unset' ? (
                      <span className="font-medium text-amber-700">not recorded</span>
                    ) : (
                      <span className="font-mono text-gray-700">{fault}</span>
                    )}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type QueueState = 'pending' | 'decided' | 'all'

export function ReviewQueue() {
  const [queue, setQueue] = useState<ReviewQueueResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<QueueState>('pending')
  const [expanded, setExpanded] = useState<string | null>(null)

  const [reviewer, setReviewer] = useState(getReviewerName())
  const [token, setToken] = useState(getAdminToken())

  // A counter rather than a callable loader: `reload` has to be safe to hand
  // to a retry button and to a row that has just recorded a decision, and
  // bumping a dependency is the only way to do that without a setState landing
  // in the effect body.
  const [reloadNonce, setReloadNonce] = useState(0)
  const reload = () => setReloadNonce((n) => n + 1)

  useEffect(() => {
    // Guard against a slow earlier request resolving after a newer one, which
    // is easy to trigger by switching tabs quickly.
    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await getReviewQueue(state)
        if (!cancelled) setQueue(res)
      } catch (err) {
        if (cancelled) return
        const anyErr = err as { response?: { data?: { error?: string } }; message?: string }
        setError(anyErr.response?.data?.error ?? anyErr.message ?? 'Failed to load the review queue')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [state, reloadNonce])

  // Whatever the *server* has ruled out, said in its own words where it has
  // them. This is the branch that used to be silent.
  const serverBlock: string | null =
    queue === null
      ? null
      : queue.reviews_available !== true
        ? queue.reviews_unavailable_reason
          ?? 'The server cannot read or record decisions: there is no adjudication_reviews table to write one into. Apply migration 0019 on the API.'
        : queue.decisions_enabled !== true
          ? 'The server has no ADMIN_TOKEN configured, so it would refuse any decision sent from here. Set ADMIN_TOKEN on the API and restart it — the buttons are disabled rather than failing after the fact.'
          : null

  const decisionsPossible = queue !== null && serverBlock === null
  const missingReviewer = reviewer.trim().length === 0
  const missingToken = token.trim().length === 0
  const canDecide = decisionsPossible && !missingReviewer && !missingToken

  // Every path that greys a button produces a sentence. A disabled control
  // with nothing beside it is indistinguishable from a broken page, and this
  // is the screen a first-time reader judges the system on.
  const disabledReason: string | null =
    serverBlock
    ?? (queue === null
      ? 'The queue has not loaded yet, so there is nothing to decide on.'
      : missingReviewer && missingToken
        ? 'Enter your name and the admin token before deciding. Both fields are in the header above, and repeated just below.'
        : missingToken
          ? 'Enter the admin token before deciding — without it the server refuses the decision. The field is in the header above, and repeated just below.'
          : missingReviewer
            ? 'Enter your name before deciding: a decision with nobody attached to it is not an audit record. The field is in the header above, and repeated just below.'
            : null)

  // Only the two browser-held fields can be filled in from inside a row; a
  // server without an ADMIN_TOKEN is not something this page can repair.
  const fixableHere = decisionsPossible && (missingReviewer || missingToken)

  const pendingCount = queue?.pending_count ?? null

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Review Queue</h1>
        <p className="text-sm text-gray-500 mt-1">
          What the AI recommended, and the working behind it. Nothing here has decided anything — the
          adjudication service writes an audit row and never touches a claim&apos;s status. You do.
        </p>
      </div>

      {/* Who is deciding, and with what authority.

          Sticky, because the message on a disabled button says "enter the
          admin token above" and a reader three rows down cannot act on that if
          "above" has scrolled off the screen. */}
      <div className="sticky top-0 z-20 -mx-6 px-6 pt-4 pb-3 mb-4 bg-gray-50/95 backdrop-blur-sm border-b border-gray-200">
        <div className="bg-white border border-gray-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
              Reviewer
            </label>
            <input
              value={reviewer}
              onChange={(e) => { setReviewer(e.target.value); setReviewerName(e.target.value) }}
              placeholder="Your name, recorded against every decision"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5" /> Admin token
            </label>
            <input
              type="password"
              value={token}
              onChange={(e) => { setToken(e.target.value); setAdminToken(e.target.value) }}
              placeholder="ADMIN_TOKEN"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* The state of the page, before anyone clicks anything. */}
          <div className="sm:col-span-2 border-t border-gray-100 pt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <ReadyFlag
              ok={!missingReviewer}
              okText={`Signing as ${reviewer.trim()}`}
              badText="No reviewer name"
            />
            <ReadyFlag ok={!missingToken} okText="Admin token set" badText="No admin token" />
            <ReadyFlag
              ok={decisionsPossible}
              okText="Server accepts decisions"
              badText={queue === null ? 'Queue not loaded' : 'Server cannot record decisions'}
            />
            <span className="text-xs text-gray-500">
              {pendingCount === null
                ? 'Pending count unknown'
                : `${pendingCount} awaiting a decision`}
            </span>
            <span
              className={`ml-auto text-xs font-semibold px-2 py-0.5 rounded-full border ${
                canDecide
                  ? 'bg-green-50 text-green-800 border-green-200'
                  : 'bg-amber-50 text-amber-900 border-amber-200'
              }`}
            >
              {canDecide ? 'Ready to decide' : 'Not ready to decide'}
            </span>
          </div>
          {!canDecide && disabledReason && (
            <p className="sm:col-span-2 -mt-1 text-xs text-amber-900">{disabledReason}</p>
          )}
        </div>
      </div>

      {loading ? (
        <LoadingSpinner message="Reading recommendations" />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !queue ? (
        <ErrorState message="The queue returned nothing at all." onRetry={reload} />
      ) : (
        <>
          <div className="space-y-3 mb-4">
            {!queue.reviews_available && (
              <Banner kind="err">
                <p className="font-semibold">Decisions cannot be read or recorded.</p>
                <p>
                  {queue.reviews_unavailable_reason
                    ?? 'There is no adjudication_reviews table to write a decision into. Apply migration 0019 on the API.'}
                </p>
                <p className="mt-1">
                  Every row below is shown without a review state, because there is no way to tell a decided
                  recommendation from an undecided one until that migration is applied.
                </p>
              </Banner>
            )}
            {!queue.decisions_enabled && (
              <Banner kind="warn">
                The server has no <span className="font-mono">ADMIN_TOKEN</span> configured, so no decision can be
                recorded from here. The buttons are disabled rather than failing after the fact.
              </Banner>
            )}
            {queue.truncated && (
              <Banner kind="warn">
                This queue read the newest {queue.scan_cap} adjudications and stopped there. Older ones are not
                shown, and the &ldquo;never adjudicated&rdquo; count below is withheld rather than guessed.
              </Banner>
            )}
          </div>

          {/* State tabs. Counts come back null when they cannot be known. */}
          <div className="flex items-center gap-1 mb-4 bg-gray-100 rounded-lg p-1 w-fit">
            {(['pending', 'decided', 'all'] as QueueState[]).map((s) => {
              const count = s === 'pending' ? queue.pending_count : s === 'decided' ? queue.decided_count : queue.claims_with_adjudication
              return (
                <button
                  key={s}
                  onClick={() => { setState(s); setExpanded(null) }}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium capitalize transition-colors ${
                    state === s ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  {s === 'pending' ? 'Awaiting decision' : s === 'decided' ? 'Decided' : 'All'}
                  <span className="ml-1.5 text-xs text-gray-400">{count === null ? '—' : count}</span>
                </button>
              )
            })}
          </div>

          {/* The distinction the queue cannot show on its own: claims with no
              recommendation at all never appear here, and that is not the same
              thing as a recommendation that escalated. */}
          <p className="text-xs text-gray-500 mb-4">
            {queue.claims_with_adjudication} claim{queue.claims_with_adjudication === 1 ? ' has' : 's have'} an
            adjudication on file
            {queue.claims_total !== null && <> out of {queue.claims_total} total</>}.
            {' '}
            {queue.claims_never_adjudicated === null
              ? 'How many have never been adjudicated is unknown here — the scan was truncated, and an approximate figure would be worse than none.'
              : `${queue.claims_never_adjudicated} ${queue.claims_never_adjudicated === 1 ? 'claim has' : 'claims have'} never been adjudicated at all, and so cannot appear in this queue. That is a different state from a recommendation that escalated.`}
          </p>

          {queue.data.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
              <Scale className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              {queue.scanned === 0 ? (
                <>
                  <h3 className="text-lg font-medium text-gray-900">No adjudication has ever been run</h3>
                  <p className="text-sm text-gray-500 mt-1 max-w-md mx-auto">
                    The <span className="font-mono">adjudications</span> table is empty. Nothing is waiting on a
                    human because nothing has been assessed yet — which is not the same as everything having been
                    cleared. Run <span className="font-mono">POST /api/tools/adjudicate-claim</span> against a
                    claim to put something here.
                  </p>
                </>
              ) : state === 'pending' ? (
                <>
                  <h3 className="text-lg font-medium text-gray-900">Nothing is awaiting a decision</h3>
                  <p className="text-sm text-gray-500 mt-1">
                    All {queue.decided_count ?? 0} recommendation{queue.decided_count === 1 ? ' has' : 's have'}{' '}
                    already been answered by a person.
                  </p>
                </>
              ) : (
                <>
                  <h3 className="text-lg font-medium text-gray-900">Nothing here yet</h3>
                  <p className="text-sm text-gray-500 mt-1">
                    No recommendation matches this filter.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {queue.data.map((item) => (
                <QueueRow
                  key={item.adjudication.id}
                  item={item}
                  expanded={expanded === item.adjudication.id}
                  onToggle={() => setExpanded(expanded === item.adjudication.id ? null : item.adjudication.id)}
                  reviewer={reviewer}
                  token={token}
                  onReviewerChange={(v) => { setReviewer(v); setReviewerName(v) }}
                  onTokenChange={(v) => { setToken(v); setAdminToken(v) }}
                  canDecide={canDecide}
                  disabledReason={disabledReason}
                  fixableHere={fixableHere}
                  onDecided={reload}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

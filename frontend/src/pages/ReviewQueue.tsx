import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle, ChevronDown, ChevronRight, Coins, Info, KeyRound, RefreshCw,
  Scale, ThumbsDown, ThumbsUp, UserCheck,
} from 'lucide-react'
import { LoadingSpinner } from '../components/LoadingSpinner'
import { ErrorState } from '../components/ErrorState'
import {
  getReviewQueue, decideAdjudication,
  getAdminToken, setAdminToken, getReviewerName, setReviewerName,
} from '../lib/api'
import type {
  ReviewDecisionResult, ReviewQueueItem, ReviewQueueResponse,
} from '../types'
import { AmountPanel } from '../components/review-queue/AmountPanel'
import { Banner } from '../components/review-queue/Banner'
import { ChecksPanel } from '../components/review-queue/ChecksPanel'
import { DecidedPanel } from '../components/review-queue/DecidedPanel'
import { FaultPanel } from '../components/review-queue/FaultPanel'
import { FindingsPanel } from '../components/review-queue/FindingsPanel'
import { ProvenancePanel } from '../components/review-queue/ProvenancePanel'
import { ReadyFlag } from '../components/review-queue/ReadyFlag'
import {
  CURRENCY, VERDICT_STYLE, REFRESH_INTERVAL_MS, provenanceOf, mergeQueue,
} from '../components/review-queue/helpers'
import type { FaultChoice, QueueState } from '../components/review-queue/helpers'

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
 *    beside the control rather than arriving as a warning after the click, and
 *    approving with it still unrecorded asks once before it happens.
 *
 * The page also re-reads itself on a timer, not only on mount: a claim can be
 * auto-adjudicated into this queue while somebody is looking at it, and a queue
 * that only ever shows what was true on mount teaches its reader that absent
 * from the screen means absent from the system. The refresh is subordinate to
 * the reviewer rather than the other way round — an OPEN ROW IS HELD exactly as
 * it is, same data and same position, until it is collapsed, so nothing
 * reshuffles or restamps under a half-finished decision.
 */

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

/**
 * The one question this page asks before it does something.
 *
 * Approving with no fault finding is legitimate — a reviewer who does not know
 * must be able to say so — and it is also the single click on this screen that
 * quietly costs the policyholder their deductible. The refusal that follows is
 * correct and arrives far too late: the claim settles, the refund is refused
 * `fault_not_determined`, and the reviewer is not looking any more.
 *
 * So the consequence is named once, in money rather than in field names, with
 * the way out offered first. It is not a block: the second button proceeds.
 * Nothing asks on reject — a rejected claim is never settled, so there is no
 * deductible taken and no refund to lose — and nothing asks when a finding has
 * been made, `undetermined` included, because that is an answer.
 */
function ApproveWithoutFaultConfirm({
  busy, onConfirm, onCancel,
}: { busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div
      role="alertdialog"
      aria-label="Approve without recording who was at fault?"
      className="mt-3 rounded-lg border-2 border-amber-400 bg-amber-50 px-4 py-3"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
        <div className="text-sm text-amber-900">
          <p className="font-semibold">Approve without recording who was at fault?</p>
          <p className="mt-1">
            The policyholder keeps paying the deductible. Nothing on this claim waives it, so no refund
            follows this approval — not now, and not when the claim settles. Only a finding that the other
            party was at fault sends that money back, and this recommendation cannot be answered a second
            time to add one.
          </p>
          <p className="mt-1.5">
            If you looked and could not tell, <span className="font-medium">Looked into, undetermined</span>{' '}
            records that. It returns nothing either, but it says somebody looked.
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-white text-amber-900 text-sm font-medium rounded-lg border border-amber-400 hover:bg-amber-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Go back and record fault
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <ThumbsUp className="w-4 h-4" />
          {busy ? 'Recording…' : 'Approve, deductible stays with the policyholder'}
        </button>
      </div>
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

  /**
   * True while the "you are about to approve with no fault finding" question
   * is standing. Only ever set by the approve button, and only when `fault` is
   * `'unset'`; picking any finding answers the question and takes it down.
   */
  const [confirmingApprove, setConfirmingApprove] = useState(false)

  /** What the server said about the decision it just accepted. */
  const [outcome, setOutcome] = useState<ReviewDecisionResult | null>(null)

  // Collapsing the row clears it, for the same reason: a row that remembers a
  // finding while out of sight is a finding nobody is looking at.
  useEffect(() => {
    if (!expanded) {
      setFault('unset')
      setOutcome(null)
      setConfirmingApprove(false)
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

              {/* Choosing a finding answers the standing question, so the
                  confirmation comes down rather than sitting there contradicted
                  by the picker above it. */}
              <FaultPanel
                value={fault}
                onChange={(v) => { setFault(v); setConfirmingApprove(false) }}
              />

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
              {confirmingApprove ? (
                <ApproveWithoutFaultConfirm
                  busy={busy !== null}
                  onConfirm={() => { setConfirmingApprove(false); void decide('approve') }}
                  onCancel={() => setConfirmingApprove(false)}
                />
              ) : (
                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={() => {
                      // The only branch that asks. A finding of any kind —
                      // `undetermined` included — goes straight through, and so
                      // does reject, which has no settlement to take a
                      // deductible out of in the first place.
                      if (fault === 'unset') {
                        setFailure(null)
                        setConfirmingApprove(true)
                        return
                      }
                      void decide('approve')
                    }}
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
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ReviewQueue() {
  const [queue, setQueue] = useState<ReviewQueueResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<QueueState>('pending')
  const [expanded, setExpanded] = useState<string | null>(null)

  const [reviewer, setReviewer] = useState(getReviewerName())
  const [token, setToken] = useState(getAdminToken())

  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)

  // A counter rather than a callable loader: `reload` has to be safe to hand
  // to a retry button and to a row that has just recorded a decision, and
  // bumping a dependency is the only way to do that without a setState landing
  // in the effect body.
  const [reloadNonce, setReloadNonce] = useState(0)
  const reload = () => setReloadNonce((n) => n + 1)

  // Read by the loader, which outlives the render that started it: a timer
  // firing thirty seconds from now must use the tab and the open row as they
  // are then, not as they were when the interval was installed.
  const stateRef = useRef(state)
  stateRef.current = state
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  const seqRef = useRef(0)
  const busyRef = useRef(false)

  /**
   * One reader, two manners.
   *
   * `blocking` is what a first paint, a tab switch and a retry want: the
   * spinner, the whole list torn down and rebuilt. `background` is what a
   * timer and the refresh button want, and it must never set `loading` —
   * swapping the list for a spinner unmounts every row, and an unmounted row
   * takes its note, its fault selection and its outcome panel with it. Keeping
   * the rows mounted and keyed by adjudication id is what lets a half-filled
   * form live through a refresh; `mergeQueue` is what keeps it still.
   */
  const load = useCallback(async (mode: 'blocking' | 'background') => {
    // Never stack polls behind a request that is already out.
    if (mode === 'background' && busyRef.current) return
    busyRef.current = true

    // Guard against a slow earlier request resolving after a newer one, which
    // is easy to trigger by switching tabs quickly.
    const seq = ++seqRef.current
    if (mode === 'blocking') {
      setLoading(true)
      setError(null)
    } else {
      setRefreshing(true)
    }

    try {
      const res = await getReviewQueue(stateRef.current)
      if (seq !== seqRef.current) return
      if (mode === 'blocking') {
        setQueue(res)
      } else {
        setQueue((prev) => mergeQueue(prev, res, expandedRef.current))
      }
      setError(null)
      setRefreshError(null)
      setLastLoadedAt(Date.now())
    } catch (err) {
      if (seq !== seqRef.current) return
      const anyErr = err as { response?: { data?: { error?: string } }; message?: string }
      const message =
        anyErr.response?.data?.error ?? anyErr.message ?? 'Failed to load the review queue'
      // A refresh that fails must not take the queue down with it. What is on
      // screen was true when it loaded; the header says so and says when.
      if (mode === 'blocking') setError(message)
      else setRefreshError(message)
    } finally {
      if (seq === seqRef.current) {
        busyRef.current = false
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => { void load('blocking') }, [state, reloadNonce, load])

  // The timer, and only while somebody could be looking at it.
  useEffect(() => {
    if (!autoRefresh) return
    const id = window.setInterval(() => {
      if (document.hidden) return
      void load('background')
    }, REFRESH_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [autoRefresh, load])

  // Coming back to a tab is the moment the screen is most likely to be stale
  // and most likely to be believed, so it reads once on the way in.
  useEffect(() => {
    if (!autoRefresh) return
    const onVisible = () => { if (!document.hidden) void load('background') }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [autoRefresh, load])

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

  // True when a refresh would be holding a row still rather than replacing it.
  // Said out loud in the header, because a queue that visibly declines to move
  // needs to look deliberate rather than stuck.
  const holdingOpenRow =
    expanded !== null && (queue?.data.some((i) => i.adjudication.id === expanded) ?? false)

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
          {/* How current this is, and how to make it more current.

              The queue used to read once on mount and never again, so a claim
              adjudicated while somebody had this open simply was not here and
              read as a claim that did not exist. */}
          <div className="sm:col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
            <button
              type="button"
              onClick={() => void load('background')}
              disabled={loading || refreshing}
              className="inline-flex items-center gap-1.5 font-medium text-blue-700 hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? 'Reading…' : 'Refresh now'}
            </button>
            <span className="text-gray-500">
              {lastLoadedAt === null
                ? 'Not read yet'
                : `Read at ${new Date(lastLoadedAt).toLocaleTimeString()}`}
              {autoRefresh
                ? ` · again every ${REFRESH_INTERVAL_MS / 1000}s while this tab is visible`
                : ' · automatic re-reading is off'}
            </span>
            <button
              type="button"
              onClick={() => setAutoRefresh((v) => !v)}
              aria-pressed={autoRefresh}
              className="text-gray-500 hover:text-gray-800 hover:underline"
            >
              {autoRefresh ? 'turn off' : 'turn on'}
            </button>
            {holdingOpenRow && (
              <span className="text-amber-900 basis-full">
                A row is open, so it is being held exactly as you have it — same contents, same place in
                the list — and anything half-entered on it survives a refresh. Everything around it is
                current; that row catches up when you collapse it.
              </span>
            )}
            {refreshError && (
              <span className="text-amber-900 basis-full">
                The last re-read failed, so this is what was on file at the time above, unchanged.{' '}
                {refreshError}
              </span>
            )}
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

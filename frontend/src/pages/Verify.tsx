import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Shield,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  CircleSlash,
  RefreshCw,
  ArrowLeft,
  ExternalLink,
} from 'lucide-react'
import { getVerification, verifyPayment } from '../lib/api'
import type { VerifiedPayment, VerificationSweep } from '../types'
import { rupees } from '../lib/money'

/**
 * /verify — the page a stranger can open to check that the money was real.
 *
 * ## Why this page exists
 *
 * The project's payments were verifiable, but only by someone willing to read
 * the repository, find the Razorpay ids in a markdown file, and take the
 * database's word for the totals. A reviewer said as much: a competing entry
 * could be checked from outside in minutes, and this one could not. That is a
 * fair criticism of the presentation rather than of the payments, and the fix
 * is presentational: one public URL, no login, no tooling, legible on a phone.
 *
 * ## What it shows, and the one thing it refuses to blur
 *
 * Two columns, never merged: what SafeGuard recorded, and what Razorpay's API
 * says about the same payment id right now. The verdict per row is computed
 * from the comparison, and a disagreement is rendered in red at the same size
 * as a confirmation. A page that could only ever say "confirmed" would be a
 * prettier way of asserting exactly what was being doubted.
 *
 * ## The caveat this page states rather than hides
 *
 * Razorpay's test-mode records are not publicly queryable — reading them needs
 * the merchant key, so the lookup is relayed through this API. That means the
 * page shows Razorpay's answer, not a link a reader can follow to Razorpay
 * themselves. It narrows what has to be trusted from "their whole database and
 * every number in their README" down to "their server relayed one API response
 * faithfully", which is a real reduction and not the same as zero. Saying so
 * is the point; a verification page that overstated its own strength would be
 * the worst possible thing to put at this URL.
 */

const VERDICT_STYLES: Record<
  VerifiedPayment['verdict'],
  { label: string; className: string; Icon: typeof CheckCircle2; blurb: string }
> = {
  confirmed: {
    label: 'Confirmed by Razorpay',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    Icon: CheckCircle2,
    blurb: 'Razorpay was asked about this payment id and agreed with every figure on record.',
  },
  disagrees: {
    label: 'Disagrees',
    className: 'bg-red-50 text-red-700 border-red-200',
    Icon: AlertTriangle,
    blurb: 'Razorpay answered and does not agree with what this system recorded.',
  },
  // Deliberately not red, and deliberately not worded as a denial. Razorpay
  // returns the same answer for a payment that never existed and for a real
  // one made through a different merchant account, and these are the second
  // kind — collected on a second test account that has since hit its limit.
  // Painting them as failures would be the page lying in the other direction.
  not_on_this_account: {
    label: 'On our other test account',
    className: 'bg-sky-50 text-sky-800 border-sky-200',
    Icon: HelpCircle,
    blurb:
      'Razorpay answered, and has no payment with this id on the account this API\u2019s key opens. These were collected through a second test account that has since reached its limit.',
  },
  unavailable: {
    label: 'Not confirmed',
    className: 'bg-amber-50 text-amber-800 border-amber-200',
    Icon: HelpCircle,
    blurb: 'Razorpay could not be asked, or does not know this id. The figures shown are unconfirmed.',
  },
  simulated: {
    label: 'Simulated — no money moved',
    className: 'bg-gray-100 text-gray-600 border-gray-300',
    Icon: CircleSlash,
    blurb: 'This row was written by the simulated rail. There is nothing at Razorpay to check.',
  },
}

/** Paise to a rupee string. Every column in the money path is minor units. */
function paise(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return rupees(value / 100)
}

function shortDate(value: string | null): string {
  if (!value) return '—'
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return '—'
  return at.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function VerdictBadge({ verdict }: { verdict: VerifiedPayment['verdict'] }) {
  const { label, className, Icon } = VERDICT_STYLES[verdict]
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium whitespace-nowrap ${className}`}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      {label}
    </span>
  )
}

/** A monospace identifier that wraps rather than blowing out the layout. */
function Id({ value }: { value: string | null }) {
  if (!value) return <span className="text-gray-400">—</span>
  return <code className="font-mono text-[13px] break-all text-gray-700">{value}</code>
}

function SummaryTile({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'neutral' | 'good' | 'bad' | 'warn'
}) {
  const tones = {
    neutral: 'text-gray-900',
    good: 'text-emerald-700',
    // A zero here is good news, so it is not painted as an alarm. Only an
    // actual disagreement turns red — otherwise the page cries wolf on load.
    bad: value === '0' ? 'text-gray-900' : 'text-red-700',
    warn: value === '0' ? 'text-gray-900' : 'text-amber-700',
  }
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tones[tone]}`}>{value}</div>
    </div>
  )
}

/**
 * One row, plus the live re-check.
 *
 * The re-check is deliberately not served from the sweep's cache. The whole
 * value of the button is that a sceptical reader watches a request leave and
 * an answer arrive; giving them the cached copy would be the same JSON and
 * would quietly defeat the reason they pressed it.
 */
function PaymentRow({ payment }: { payment: VerifiedPayment }) {
  const [live, setLive] = useState<VerifiedPayment | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const current = live ?? payment

  async function recheck() {
    setChecking(true)
    setError(null)
    try {
      setLive(await verifyPayment(payment.stored.payment_id))
    } catch {
      setError('The re-check could not be completed. Nothing about the row below has changed.')
    } finally {
      setChecking(false)
    }
  }

  const railPayment = current.rail?.payment ?? null

  return (
    <div className="border-b border-gray-200 last:border-b-0 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900">
            {current.stored.claim_number ?? 'Claim number withheld'}
          </div>
          <div className="mt-1">
            <Id value={current.stored.payment_id} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <VerdictBadge verdict={current.verdict} />
          <button
            onClick={recheck}
            disabled={checking}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} />
            {checking ? 'Asking Razorpay…' : live ? 'Checked live' : 'Check live'}
          </button>
        </div>
      </div>

      {/* The two answers, side by side and never merged. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg bg-gray-50 border border-gray-200 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            SafeGuard recorded
          </div>
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500">Collected</dt>
              <dd className="tabular-nums text-gray-900">
                {paise(current.stored.captured_amount_paise)}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500">Returned</dt>
              <dd className="tabular-nums text-gray-900">
                {paise(current.stored.refund_amount_paise)}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500">Captured at</dt>
              <dd className="text-gray-900">{shortDate(current.stored.captured_at)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500">Refund id</dt>
              <dd className="text-right">
                <Id value={current.stored.refund_id} />
              </dd>
            </div>
          </dl>
        </div>

        <div
          className={`rounded-lg border p-3 ${
            railPayment ? 'bg-white border-gray-200' : 'bg-gray-50 border-dashed border-gray-300'
          }`}
        >
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              Razorpay says
            </div>
            {/* Which account answered, shown only when it took more than the
                first one — otherwise it is noise on every row. */}
            {current.answered_by && current.answered_by !== 'primary' && (
              <span className="text-[11px] text-gray-500">
                via {current.answered_by} account
              </span>
            )}
          </div>
          {railPayment ? (
            <dl className="mt-2 space-y-1 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500">Amount</dt>
                <dd className="tabular-nums text-gray-900">{paise(railPayment.amountPaise)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500">Refunded</dt>
                <dd className="tabular-nums text-gray-900">
                  {paise(railPayment.amountRefundedPaise)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500">Status</dt>
                <dd className="text-gray-900">
                  {railPayment.status}
                  {railPayment.captured ? ' · captured' : ' · not captured'}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500">Method</dt>
                <dd className="text-gray-900">{railPayment.method ?? '—'}</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-2 text-sm text-gray-600">
              {current.rail_error ?? VERDICT_STYLES[current.verdict].blurb}
            </p>
          )}
        </div>
      </div>

      {railPayment && current.rail_error && (
        <p className="mt-3 text-sm text-amber-800">{current.rail_error}</p>
      )}
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </div>
  )
}

export default function Verify() {
  const [sweep, setSweep] = useState<VerificationSweep | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setSweep(await getVerification())
    } catch {
      // Deliberately not "0 payments, 0 disagreements". An outage that rendered
      // as an empty, agreeing book would be the single most misleading thing
      // this page could do.
      setSweep(null)
      setError(
        'The payment records could not be checked right now. This says nothing either way about the payments — only that the check did not run.'
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const summary = sweep?.summary ?? null

  return (
    <div className="min-h-screen bg-gray-50 font-sans">
      <nav className="sticky top-0 z-40 bg-white border-b border-gray-200">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-2 shrink-0">
            <Shield className="w-5 h-5 text-blue-600" />
            <span className="font-bold text-gray-900">SafeGuard</span>
          </Link>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900"
          >
            <ArrowLeft className="w-4 h-4" />
            Home
          </Link>
        </div>
      </nav>

      <main className="mx-auto max-w-5xl px-4 sm:px-6 py-10 space-y-8">
        <header>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900">
            Verify the money
          </h1>
          <p className="mt-3 max-w-2xl text-gray-600">
            Every deductible this system collected and returned, checked one payment at a time
            against Razorpay&rsquo;s own API. No login, no credentials, no repository. What
            SafeGuard recorded is shown beside what the payment rail says, and where they differ
            this page says so.
          </p>
        </header>

        {loading && !sweep && (
          <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-500">
            Asking Razorpay about every payment on record…
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
            <p className="font-medium">The check did not run.</p>
            <p className="mt-1 text-sm">{error}</p>
            <button
              onClick={load}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-amber-100"
            >
              <RefreshCw className="w-4 h-4" />
              Try again
            </button>
          </div>
        )}

        {summary && (
          <>
            <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <SummaryTile label="Payments checked" value={String(summary.payments_checked)} />
              <SummaryTile
                label="Confirmed by Razorpay"
                value={String(summary.confirmed)}
                tone="good"
              />
              <SummaryTile label="Disagreements" value={String(summary.disagrees)} tone="bad" />
              <SummaryTile
                label="On our other account"
                value={String(summary.not_on_this_account)}
                tone="neutral"
              />
              <SummaryTile
                label="Could not be checked"
                value={String(summary.unavailable + summary.simulated)}
                tone="warn"
              />
            </section>

            {summary.not_on_this_account > 0 && (
              <section className="rounded-xl border border-sky-200 bg-sky-50 p-5">
                <h2 className="font-semibold text-sky-900">
                  Why {summary.not_on_this_account} of these say &ldquo;other account&rdquo;
                </h2>
                <p className="mt-2 text-sm text-sky-900/90">
                  They were collected through a second Razorpay test account, which has since
                  reached its transaction limit. The key this API holds opens the other one, and
                  Razorpay answers <code className="font-mono">400 &ldquo;The id provided does
                  not exist&rdquo;</code> for any payment outside the account a key belongs to.
                </p>
                <p className="mt-2 text-sm text-sky-900/90">
                  That response looks identical whether a payment was made elsewhere or never
                  made at all, so this page will not claim more for these rows than it can show.
                  Their ids and amounts are on record and are counted in the left-hand column;
                  they are excluded from the Razorpay column rather than quietly filled in with
                  ours. The {summary.confirmed} confirmed above are confirmed on their own.
                </p>
              </section>
            )}

            {/* The comparison that matters most: our totals against theirs. */}
            <section className="rounded-xl border border-gray-200 bg-white overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-200">
                <h2 className="font-semibold text-gray-900">The totals, from both sides</h2>
                <p className="mt-1 text-sm text-gray-600">
                  The right-hand column is summed from Razorpay&rsquo;s answers, over the{' '}
                  {summary.rail_totals_cover} of {summary.payments_checked} payments it answered
                  for. Payments it did not answer for are left out of it rather than quietly
                  filled in with ours.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left text-gray-500">
                    <tr>
                      <th className="px-5 py-2.5 font-medium"> </th>
                      <th className="px-5 py-2.5 font-medium">SafeGuard recorded</th>
                      <th className="px-5 py-2.5 font-medium">Razorpay says</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    <tr>
                      <td className="px-5 py-3 text-gray-600">Collected</td>
                      <td className="px-5 py-3 tabular-nums font-medium text-gray-900">
                        {paise(summary.stored_collected_paise)}
                      </td>
                      <td className="px-5 py-3 tabular-nums font-medium text-gray-900">
                        {paise(summary.rail_collected_paise)}
                      </td>
                    </tr>
                    <tr>
                      <td className="px-5 py-3 text-gray-600">Returned</td>
                      <td className="px-5 py-3 tabular-nums font-medium text-gray-900">
                        {paise(summary.stored_refunded_paise)}
                      </td>
                      <td className="px-5 py-3 tabular-nums font-medium text-gray-900">
                        {paise(summary.rail_refunded_paise)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="px-5 py-3 bg-gray-50 border-t border-gray-200 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-gray-600">
                  Checked {shortDate(sweep?.checked_at ?? null)} · {sweep?.checked_against.provider}{' '}
                  · {sweep?.checked_against.mode} mode
                </p>
                <button
                  onClick={load}
                  disabled={loading}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                  Re-check all
                </button>
              </div>
            </section>

            <section className="rounded-xl border border-gray-200 bg-white overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-200">
                <h2 className="font-semibold text-gray-900">
                  Payment by payment ({sweep?.payments.length ?? 0})
                </h2>
                <p className="mt-1 text-sm text-gray-600">
                  Press <span className="font-medium">Check live</span> on any row to watch the
                  request go to Razorpay and come back. That one is never served from cache.
                </p>
              </div>
              {sweep && sweep.payments.length > 0 ? (
                <div>
                  {sweep.payments.map((payment) => (
                    <PaymentRow key={payment.stored.payment_id} payment={payment} />
                  ))}
                </div>
              ) : (
                <p className="px-5 py-8 text-center text-gray-500">
                  No captured payments are on record in this deployment.
                </p>
              )}
            </section>
          </>
        )}

        {/* --- Check it without this page at all --------------------------- */}
        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="font-semibold text-gray-900">Prefer to check it yourself</h2>
          <p className="mt-1 text-sm text-gray-600">
            Both endpoints are public and unauthenticated. Nothing on this page comes from
            anywhere else.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-gray-900 p-4 text-[13px] leading-relaxed text-gray-100">
            <code>{`# What SafeGuard recorded
curl -s https://safeguard-api-production-7c24.up.railway.app/api/evidence/recent | jq '.razorpay'

# The same payments, checked against Razorpay
curl -s https://safeguard-api-production-7c24.up.railway.app/api/evidence/verify | jq '.summary'

# Any single payment id from the list above
curl -s https://safeguard-api-production-7c24.up.railway.app/api/evidence/verify/pay_XXXXXXXX | jq`}</code>
          </pre>
        </section>

        {/* --- What this does and does not establish ------------------------ */}
        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="font-semibold text-gray-900">What this proves, and what it does not</h2>
          <ul className="mt-3 space-y-3 text-sm text-gray-700">
            <li className="flex gap-2.5">
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600" />
              <span>
                The payment ids above are real Razorpay payments. The amounts, the capture and the
                refund on each one are read from Razorpay&rsquo;s API at the moment you load this
                page, not from anything typed into a document.
              </span>
            </li>
            <li className="flex gap-2.5">
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600" />
              <span>
                Money moved <em>both ways</em>. Collecting is the easy half; the refund column is
                the same money going back out, against the same payment id.
              </span>
            </li>
            <li className="flex gap-2.5">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
              <span>
                <strong>This is Razorpay test mode.</strong> Real cards were never charged. The
                integration is genuine and the API calls are genuine; the rupees are not.
              </span>
            </li>
            <li className="flex gap-2.5">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
              <span>
                <strong>The lookup is relayed through this API.</strong> Razorpay&rsquo;s test-mode
                records need the merchant key to read, so there is no link you can follow to
                Razorpay yourself. This narrows what you have to trust from &ldquo;their database
                and every figure in their README&rdquo; to &ldquo;their server relayed one API
                response faithfully&rdquo;. That is a real reduction, and it is not zero.
              </span>
            </li>
            <li className="flex gap-2.5">
              <CircleSlash className="w-4 h-4 mt-0.5 shrink-0 text-gray-500" />
              <span>
                Claim <em>settlement payouts</em> are simulated and always said so — they need
                RazorpayX and completed KYC. The deductible loop on this page is the only real
                money in the system.
              </span>
            </li>
          </ul>
          <a
            href="https://safeguard-api-production-7c24.up.railway.app/health"
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700"
          >
            See which features are live and which are simulated
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </section>
      </main>
    </div>
  )
}

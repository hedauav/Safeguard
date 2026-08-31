import { useState, type FormEvent } from 'react'
import axios from 'axios'
import { Lock, Loader2, ShieldAlert } from 'lucide-react'
import { login } from '../lib/api'

/**
 * The one thing standing between a stranger with the URL and every customer
 * name, phone number, transcript and claim amount this dashboard renders.
 *
 * It is a password and not a login: there is one operator role here and no user
 * table, so there is no name to ask for. The reviewer name recorded against an
 * adjudication decision stays what it always was — an attribution the operator
 * types — and this does not turn it into an identity.
 *
 * Shown in place of the page content rather than instead of the whole app. The
 * sidebar and the call widget stay mounted behind it on purpose: the widget is
 * how a claimant reaches the voice agent and sends documents, and that flow was
 * never behind a password and must not become so.
 */
export function LoginScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || !password) return

    setBusy(true)
    setError(null)
    try {
      await login(password)
      // Cleared before handing control back, so a password does not sit in a
      // React state tree behind whatever renders next.
      setPassword('')
      onAuthenticated()
    } catch (err) {
      // The server's own words. 'not configured' and 'not correct' are
      // different problems with different fixes, and only the server knows
      // which one it has — inventing a message here would flatten them into
      // "wrong password" and send the operator hunting for the wrong thing.
      const message =
        (axios.isAxiosError(err) && (err.response?.data as { error?: string } | undefined)?.error) ||
        (axios.isAxiosError(err) && !err.response
          ? 'Could not reach the API. Check that the backend is running.'
          : null) ||
        'Sign-in failed.'
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center justify-center h-full">
      <div className="w-full max-w-md bg-white rounded-xl border border-gray-200 p-8">
        <div className="flex items-center gap-2 mb-1">
          <Lock className="w-5 h-5 text-gray-400" />
          <h1 className="text-xl font-bold text-gray-900">Adjuster sign-in</h1>
        </div>
        <p className="text-sm text-gray-500 mb-6">
          This dashboard shows customer names, policy numbers, claim amounts and call
          transcripts. Enter the shared password to continue.
        </p>

        <form onSubmit={submit}>
          <label htmlFor="dashboard-password" className="block text-sm font-medium text-gray-700 mb-1">
            Dashboard password
          </label>
          <input
            id="dashboard-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm focus:border-blue-400 focus:outline-none disabled:bg-gray-50"
          />

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
              <ShieldAlert className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={busy || !password}
            className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-300"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {busy ? 'Checking…' : 'Sign in'}
          </button>
        </form>

        {/* Said out loud because it is a real limit and not a footnote: the
            session is a signed expiry, so nothing can revoke one early. An
            operator who has to lock somebody out before it lapses has to
            rotate DASHBOARD_SESSION_SECRET, which ends every session at once. */}
        <p className="mt-6 text-xs text-gray-400">
          A session lasts a working day and cannot be revoked before it expires. Rotate
          DASHBOARD_SESSION_SECRET on the server to end every session at once.
        </p>
      </div>
    </div>
  )
}

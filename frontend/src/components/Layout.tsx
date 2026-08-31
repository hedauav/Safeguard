import { useCallback, useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { LogOut, ShieldAlert, ShieldOff } from 'lucide-react'
import { Sidebar } from './Sidebar'
import { CallWidget } from './CallWidget'
import { LoginScreen } from './LoginScreen'
import { getAuthStatus, getDashboardToken, logout, onDashboardAuthLost } from '../lib/api'

/**
 * Whether the dashboard content may be rendered, and if not, why not.
 *
 * Five states and not a boolean, because "no password is being asked for" is
 * two entirely different situations. A development server with the variables
 * unset serves everything to everyone; a production server with them unset
 * refuses everything. Both answer `required: false`, both would render an
 * identical login-less screen under a boolean, and one of them is a security
 * incident while the other is a broken deploy.
 */
type Gate =
  | { kind: 'checking' }
  /** The server is not enforcing, and says so. Development only. */
  | { kind: 'open' }
  /** The server is enforcing and we hold nothing it will accept. */
  | { kind: 'locked' }
  /** We hold a token the server has not yet refused. */
  | { kind: 'unlocked' }
  /** The server is refusing everyone, including us. Nothing to type. */
  | { kind: 'unavailable' }

export function Layout() {
  const [gate, setGate] = useState<Gate>({ kind: 'checking' })

  /**
   * Ask the server what it wants.
   *
   * A token we already hold does not shortcut this: it may be expired or
   * signed with a secret that has since been rotated, and the only thing that
   * knows is the server. Holding it means we start `unlocked` and get sent back
   * by the first 401 — which the interceptor in lib/api.ts turns into the
   * auth-lost signal subscribed to below — rather than re-prompting an adjuster
   * who is still signed in.
   */
  const check = useCallback(async () => {
    try {
      const { data } = await getAuthStatus()
      if (data.required) {
        setGate({ kind: getDashboardToken() ? 'unlocked' : 'locked' })
      } else if (data.open) {
        setGate({ kind: 'open' })
      } else {
        setGate({ kind: 'unavailable' })
      }
    } catch {
      // The status call is the one request that works without a session, so a
      // failure here is the API being unreachable rather than a refusal. Assume
      // the gate is on: showing the login screen to somebody who turns out not
      // to need it costs a wasted keystroke, and rendering the dashboard to
      // somebody who does costs rather more.
      setGate({ kind: getDashboardToken() ? 'unlocked' : 'locked' })
    }
  }, [])

  useEffect(() => {
    // `check` awaits the status call before it touches state, so nothing is set
    // during this effect's synchronous pass — the lint rule follows the call
    // into `check`, sees a setter, and cannot see the await standing between
    // them. Asking on mount is the whole point of the gate: the alternative is
    // rendering the dashboard first and retracting it, which is the flash of
    // unauthorised content this component exists to prevent.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void check()
  }, [check])

  // The server refused a session mid-session — it expired, or the signing
  // secret was rotated under us. Straight back to the login screen; the token
  // has already been discarded by the interceptor that noticed.
  useEffect(() => onDashboardAuthLost(() => setGate({ kind: 'locked' })), [])

  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar />
      <main className="flex-1 overflow-auto p-6">
        {gate.kind === 'checking' && (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        )}

        {gate.kind === 'locked' && (
          <LoginScreen onAuthenticated={() => setGate({ kind: 'unlocked' })} />
        )}

        {gate.kind === 'unavailable' && (
          <div className="flex items-center justify-center h-full">
            <div className="w-full max-w-md bg-white rounded-xl border border-gray-200 p-8 text-center">
              <ShieldAlert className="w-8 h-8 text-red-400 mx-auto mb-3" />
              <h1 className="text-lg font-bold text-gray-900">The dashboard is disabled</h1>
              <p className="mt-2 text-sm text-gray-500">
                The API has no dashboard password configured and is refusing every read
                rather than serving customer data unauthenticated. Set{' '}
                <code className="font-mono text-xs">DASHBOARD_PASSWORD</code> and{' '}
                <code className="font-mono text-xs">DASHBOARD_SESSION_SECRET</code> on the
                server, then reload.
              </p>
            </div>
          </div>
        )}

        {(gate.kind === 'open' || gate.kind === 'unlocked') && (
          <>
            {gate.kind === 'open' && (
              // Never let an unsecured deployment look like a secured one. This
              // is the development carve-out, and it is exactly the state
              // somebody could otherwise deploy without noticing.
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <ShieldOff className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                <p className="text-sm text-amber-800">
                  No dashboard password is configured, so this data is readable by anyone
                  who can reach the API. Set{' '}
                  <code className="font-mono text-xs">DASHBOARD_PASSWORD</code> and{' '}
                  <code className="font-mono text-xs">DASHBOARD_SESSION_SECRET</code>{' '}
                  before using real customer data.
                </p>
              </div>
            )}
            {gate.kind === 'unlocked' && (
              <div className="mb-4 flex justify-end">
                <button
                  onClick={() => {
                    logout()
                    setGate({ kind: 'locked' })
                  }}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-100 hover:text-gray-900 transition-colors"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Sign out
                </button>
              </div>
            )}
            <Outlet />
          </>
        )}
      </main>
      {/* Outside the gate, deliberately. This is the claimant's way to reach the
          voice agent and to send the documents it asks for, and it posts to the
          two endpoints that are unauthenticated by necessity — a browser cannot
          be trusted with a shared secret. Putting it behind the adjuster's
          password would lock a claimant out of their own claim. */}
      <CallWidget />
    </div>
  )
}

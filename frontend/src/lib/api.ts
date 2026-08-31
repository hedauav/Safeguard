import axios from 'axios'
import type {
  Claim,
  ClaimDetail,
  ClaimOutcome,
  CallLog,
  CallLogDetail,
  AnalyticsData,
  Escalation,
  AgentIdentity,
  AgentConfigData,
  AgentConfigUpdate,
  AgentSyncResult,
  PaginatedResponse,
  ApiResponse,
  ClaimsFilter,
  CallsFilter,
  EscalationsFilter,
  ReviewQueueResponse,
  ReviewDecisionResult,
  FaultDetermination,
  VerificationSweep,
  VerifiedPayment,
  AuthStatus,
  DashboardSession,
  ClaimEvidenceRecord,
} from '../types'

/**
 * Resolve the API base URL at build time.
 *
 * v1 shipped a deployed dashboard whose base URL was a committed
 * `http://localhost:3005` default, so every request from the hosted site went
 * nowhere and failed silently. Vite inlines this value at build time, so a
 * missing variable cannot be recovered at runtime — it has to be caught here.
 *
 * Development keeps the localhost default because that is genuinely correct
 * there. A production build without an explicit URL is the v1 bug, so it fails
 * loudly instead of quietly pointing at a machine that isn't there.
 */
function resolveBaseUrl(): string {
  const configured = import.meta.env.VITE_API_URL
  if (configured) return configured
  if (import.meta.env.PROD) {
    throw new Error(
      '[SafeGuard] VITE_API_URL is not set. A production build must be given the ' +
        'deployed API URL — falling back to localhost is the exact failure this ' +
        'project was rebuilt to remove.'
    )
  }
  return 'http://localhost:3005'
}

const api = axios.create({
  baseURL: resolveBaseUrl(),
})

/**
 * The dashboard session token, and the plumbing that keeps it attached.
 *
 * ## Why a header and not a cookie
 *
 * The API is cross-origin from this page — Vercel to Railway — so a session
 * cookie would have to be SameSite=None to be sent at all, which is precisely
 * the setting that removes the browser's own protection against another site
 * making the request for you. A token this code attaches by hand is attached
 * only where this code attaches it.
 *
 * ## Why localStorage
 *
 * It survives a reload, which is the whole point of a session that lasts a
 * working day. It is readable by any script running on this origin, which is a
 * real cost and a smaller one than re-prompting an adjuster mid-decision; the
 * containment is the token's short lifetime and the fact that rotating
 * DASHBOARD_SESSION_SECRET on the server invalidates every outstanding one.
 * The admin token next door has been kept the same way since v1.
 */
const DASHBOARD_TOKEN_KEY = 'safeguard.dashboardToken'

/** Header the server reads a session token from. Must match DASHBOARD_TOKEN_HEADER. */
const DASHBOARD_TOKEN_HEADER = 'x-dashboard-token'

/**
 * Response header the server sets on every refusal from the dashboard guard.
 *
 * Without it the browser cannot tell "your session ran out" from "that admin
 * token is wrong", because both are a bare 401 — and it would sign the
 * operator out every time they mistyped the admin token on the config page.
 */
const DASHBOARD_CHALLENGE_HEADER = 'x-dashboard-auth'

/**
 * The in-tab copy, always kept in step with storage.
 *
 * It is what makes a private window work at all: `localStorage` there can
 * throw on write, and a session that only ever lived in storage would be lost
 * on the very request that follows the login. This one is lost on reload
 * instead, which is the correct amount of degradation.
 */
let memoryToken = ''

export function getDashboardToken(): string {
  if (memoryToken) return memoryToken
  try {
    return localStorage.getItem(DASHBOARD_TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setDashboardToken(token: string): void {
  memoryToken = token
  try {
    if (token) localStorage.setItem(DASHBOARD_TOKEN_KEY, token)
    else localStorage.removeItem(DASHBOARD_TOKEN_KEY)
  } catch {
    // Private browsing or blocked storage: the session is simply not
    // remembered across a reload. The copy above still carries this tab.
  }
}

/**
 * Everyone who wants to know that the session is gone.
 *
 * A set of callbacks rather than a React context, because the interceptor that
 * discovers it is not inside React and cannot dispatch into one. Layout
 * subscribes on mount and unsubscribes on unmount.
 */
const authLostListeners = new Set<() => void>()

/** Subscribe to "the server refused our session". Returns the unsubscribe. */
export function onDashboardAuthLost(listener: () => void): () => void {
  authLostListeners.add(listener)
  return () => {
    authLostListeners.delete(listener)
  }
}

/** Forget the session locally and tell the dashboard to show the login screen. */
export function clearDashboardSession(): void {
  setDashboardToken('')
  for (const listener of authLostListeners) listener()
}

api.interceptors.request.use((request) => {
  const token = getDashboardToken()
  if (token) request.headers.set(DASHBOARD_TOKEN_HEADER, token)
  return request
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    // Only a refusal that names itself as ours signs the operator out. A 401
    // from the admin-token check carries no such header and must leave the
    // session alone, and a 503 from an unconfigured server is not a reason to
    // discard a token that may be perfectly good once it is configured.
    const response = axios.isAxiosError(error) ? error.response : undefined
    if (response?.status === 401 && response.headers?.[DASHBOARD_CHALLENGE_HEADER]) {
      clearDashboardSession()
    }
    return Promise.reject(error)
  }
)

/**
 * What the server expects, asked before a login screen is offered.
 *
 * Deliberately outside everything above: it is the one call that has to work
 * when there is no session at all.
 */
export async function getAuthStatus(): Promise<ApiResponse<AuthStatus>> {
  const { data } = await api.get<ApiResponse<AuthStatus>>('/api/auth/status')
  return data
}

/**
 * Exchange the shared password for a session, and remember it.
 *
 * Throws on a wrong password — the caller renders the server's own message
 * rather than one invented here, because 'not configured' and 'not correct'
 * are different problems and only the server knows which one it has.
 */
export async function login(password: string): Promise<DashboardSession> {
  const { data } = await api.post<ApiResponse<DashboardSession>>('/api/auth/login', { password })
  setDashboardToken(data.data.token)
  return data.data
}

/** Sign out. There is nothing on the server to tell: a token is an HMAC, not a row. */
export function logout(): void {
  clearDashboardSession()
}

export async function getClaims(
  filter?: ClaimsFilter,
  page = 1,
  limit = 20
): Promise<PaginatedResponse<Claim>> {
  const params = { ...filter, page, limit }
  const { data } = await api.get<PaginatedResponse<Claim>>('/api/claims', { params })
  return data
}

/**
 * One claim, plus its `journey_events` timeline.
 *
 * The timeline arrives with the claim rather than on its own endpoint: it is
 * the claim page's primary content, not a lazily-expanded detail, and a second
 * round trip would let the page paint a claim with no history for a moment —
 * exactly the "nothing has happened" impression this endpoint exists to stop.
 *
 * Note the three fields that qualify an empty timeline — `journey_available`,
 * `journey_error`, `journey_truncated`. They must be rendered, not discarded:
 * an empty array on its own cannot tell "nothing happened yet" apart from
 * "the table is missing" or "the read failed".
 */
export async function getClaim(id: string): Promise<ApiResponse<ClaimDetail>> {
  const { data } = await api.get<ApiResponse<ClaimDetail>>(`/api/claims/${id}`)
  return data
}

/**
 * The archival columns for the evidence page.
 *
 * This used to be a Supabase query made from the browser with the publishable
 * key, which is embedded in this bundle and therefore public — the last direct
 * client read in the frontend, and the reason the `claims` table had to stay
 * open to the anon role. It now goes through the API, behind the same session
 * as every other claim read. Migration 0027 closes the door it was holding.
 */
export async function getClaimEvidenceRecords(): Promise<ApiResponse<ClaimEvidenceRecord[]>> {
  const { data } = await api.get<ApiResponse<ClaimEvidenceRecord[]>>(
    '/api/claims/evidence-records'
  )
  return data
}

export async function getClaimOutcome(claimNumber: string): Promise<ApiResponse<ClaimOutcome>> {
  const { data } = await api.get<ApiResponse<ClaimOutcome>>(`/api/claims/${claimNumber}/outcome`)
  return data
}

export async function verifyClaimIntegrity(id: string): Promise<ApiResponse<{
  match: boolean
  computed_hash?: string
  stored_hash?: string
  claim_hash?: string | null
  reason?: string
}>> {
  const { data } = await api.post(`/api/claims/${id}/verify-integrity`)
  return data
}

export async function getCalls(
  filter?: CallsFilter,
  page = 1,
  limit = 20
): Promise<PaginatedResponse<CallLog>> {
  const params = { ...filter, page, limit }
  const { data } = await api.get<PaginatedResponse<CallLog>>('/api/calls', { params })
  return data
}

/**
 * One call plus the tool executions recorded against it.
 *
 * Fetched lazily when a row on the call history page is expanded — the list
 * endpoint does not carry tool executions, and fetching them for every row on
 * load would cost a query per call to show something most rows never reveal.
 */
export async function getCall(id: string): Promise<ApiResponse<CallLogDetail>> {
  const { data } = await api.get<ApiResponse<CallLogDetail>>(`/api/calls/${id}`)
  return data
}

export async function getAnalytics(): Promise<ApiResponse<AnalyticsData>> {
  const { data } = await api.get<ApiResponse<AnalyticsData>>('/api/analytics')
  return data
}

export async function getAgentIdentity(): Promise<ApiResponse<AgentIdentity>> {
  const { data } = await api.get<ApiResponse<AgentIdentity>>('/api/agent-identity')
  return data
}

export async function getEscalations(
  filter?: EscalationsFilter,
  page = 1,
  limit = 20
): Promise<PaginatedResponse<Escalation>> {
  const params = { ...filter, page, limit }
  const { data } = await api.get<PaginatedResponse<Escalation>>('/api/escalations', { params })
  return data
}

export async function getAgentConfig(): Promise<ApiResponse<AgentConfigData>> {
  const { data } = await api.get<ApiResponse<AgentConfigData>>('/api/agent-config')
  return data
}

/** Admin token for the agent-config write endpoints, kept per-browser. */
const ADMIN_TOKEN_KEY = 'safeguard.adminToken'

export function getAdminToken(): string {
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setAdminToken(token: string): void {
  try {
    if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token)
    else localStorage.removeItem(ADMIN_TOKEN_KEY)
  } catch {
    // Private browsing or blocked storage: the token simply is not remembered.
  }
}

const authHeaders = () => ({ Authorization: `Bearer ${getAdminToken()}` })

export async function updateAgentConfig(
  update: AgentConfigUpdate
): Promise<ApiResponse<AgentConfigData>> {
  const { data } = await api.put('/api/agent-config', update, { headers: authHeaders() })
  return data
}

export async function resetAgentConfig(): Promise<ApiResponse<AgentConfigData>> {
  const { data } = await api.post('/api/agent-config/reset', {}, { headers: authHeaders() })
  return data
}

export async function syncAgentConfig(): Promise<ApiResponse<AgentSyncResult>> {
  const { data } = await api.post('/api/agent-config/sync', {}, { headers: authHeaders() })
  return data
}

/**
 * The AI recommendations waiting on a human, one per claim, newest first.
 *
 * The response carries its own limits — `truncated`, `reviews_available`,
 * `decisions_enabled`, and counts that come back null rather than approximate.
 * The queue page renders those, because a queue that cannot say how much of
 * the table it read is a queue that quietly under-reports work.
 */
export async function getReviewQueue(
  state: 'pending' | 'decided' | 'all' = 'pending',
  limit = 50
): Promise<ReviewQueueResponse> {
  const { data } = await api.get<ReviewQueueResponse>('/api/adjudications/queue', {
    params: { state, limit },
  })
  return data
}

/**
 * Record a human's decision on one recommendation. Requires the admin token.
 *
 * `faultDetermination` is optional in the same way the endpoint makes it
 * optional: a reviewer who does not yet know who was at fault must be able to
 * approve without asserting one. When it is omitted the field is left off the
 * body entirely rather than sent as null or an empty string — the server reads
 * an absent field as "not yet known" and writes nothing to the claim, and the
 * response then says out loud that the deductible cannot be waived.
 *
 * When it is present it is one of the four strings the server validates
 * against, sent verbatim. Anything else comes back as a 400 naming the four,
 * which is the correct outcome: a fault finding is not something to guess at
 * on the way through.
 */
export async function decideAdjudication(
  adjudicationId: string,
  decision: 'approve' | 'reject',
  reviewer: string,
  note?: string,
  faultDetermination?: FaultDetermination
): Promise<ApiResponse<ReviewDecisionResult>> {
  const { data } = await api.post(
    `/api/adjudications/${adjudicationId}/decision`,
    {
      decision,
      reviewer,
      note,
      ...(faultDetermination ? { fault_determination: faultDetermination } : {}),
    },
    { headers: authHeaders() }
  )
  return data
}

/** Who the browser last said was reviewing. An attribution, not a login. */
const REVIEWER_KEY = 'safeguard.reviewerName'

export function getReviewerName(): string {
  try {
    return localStorage.getItem(REVIEWER_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setReviewerName(name: string): void {
  try {
    if (name) localStorage.setItem(REVIEWER_KEY, name)
    else localStorage.removeItem(REVIEWER_KEY)
  } catch {
    // Private browsing or blocked storage: the name simply is not remembered.
  }
}

/**
 * The public verification calls.
 *
 * Deliberately outside `authHeaders()`. Both endpoints are unauthenticated by
 * design — a proof that only holds for someone already holding an admin token
 * is not a proof anyone outside this project can use, which was the whole
 * complaint these routes answer.
 */
export async function getVerification(): Promise<VerificationSweep> {
  const { data } = await api.get<VerificationSweep>('/api/evidence/verify')
  return data
}

/**
 * One payment, checked live.
 *
 * The sweep above is cached for a minute; this is not, and the difference is
 * the point of the per-row button: the reader is meant to watch the request
 * go out and the answer come back rather than be handed a copy.
 */
export async function verifyPayment(paymentId: string): Promise<VerifiedPayment> {
  const { data } = await api.get<VerifiedPayment>(
    `/api/evidence/verify/${encodeURIComponent(paymentId)}`
  )
  return data
}

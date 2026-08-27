import axios from 'axios'
import type {
  Claim,
  ClaimDetail,
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

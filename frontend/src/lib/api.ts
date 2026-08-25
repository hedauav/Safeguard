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

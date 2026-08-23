/** Any value that can round-trip through JSON — used for free-form JSONB columns. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

// API Response wrappers
export interface ApiResponse<T> {
  data: T
  error: string | null
}

export interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  limit: number
}

// Database entities
export interface Customer {
  id: string
  full_name: string
  email: string | null
  phone: string
  date_of_birth: string | null
  address: string | null
  created_at: string
}

export interface Policy {
  id: string
  policy_number: string
  customer_id: string
  policy_type: 'auto' | 'home' | 'health' | 'life'
  provider: string
  coverage_amount: number
  deductible: number
  premium_monthly: number
  start_date: string
  end_date: string
  status: 'active' | 'expired' | 'cancelled' | 'pending'
  coverage_details: Record<string, JsonValue>
  created_at: string
}

export interface Claim {
  id: string
  claim_number: string
  policy_id: string
  customer_id: string
  claim_type: string
  status: 'submitted' | 'under_review' | 'documents_needed' | 'approved' | 'denied' | 'paid' | 'closed'
  incident_date: string
  incident_description: string
  claimed_amount: number | null
  approved_amount: number | null
  assigned_adjuster: string | null
  documents_required: string[] | null
  documents_received: string[] | null
  notes: string | null
  filecoin_cid?: string | null
  piece_cid?: string | null
  dataset_id?: string | null
  attestation_tx_hash?: string | null
  eas_uid?: string | null
  evidence_hash?: string | null
  pdp_proof_status?: 'pending' | 'verified' | 'failed' | null
  agent_id?: number | null
  attested_at?: string | null
  simulated?: boolean | null
  filed_at: string
  updated_at: string
  customer_name: string
}

export interface ClaimDetail extends Claim {
  policy: {
    id: string
    policy_number: string
    policy_type: string
    provider: string
    coverage_amount: number
    deductible: number
    status: string
  } | null
  call_logs: Array<{
    id: string
    direction: string
    status: string
    summary: string | null
    started_at: string
    duration_seconds: number | null
  }>
}

export interface TranscriptEntry {
  role: string
  message: string
  timestamp?: string
}

export interface CallLog {
  id: string
  elevenlabs_conversation_id: string | null
  customer_id: string | null
  direction: 'inbound' | 'outbound' | 'webrtc'
  phone_number: string | null
  status: 'in_progress' | 'completed' | 'failed'
  duration_seconds: number | null
  transcript: TranscriptEntry[] | null
  summary: string | null
  outcome: string | null
  tools_used: string[] | null
  recording_url: string | null
  started_at: string
  ended_at: string | null
  customer_name: string
}

export interface CallLogDetail extends CallLog {
  tool_executions: CallToolExecution[]
}

export interface CallToolExecution {
  id: string
  call_log_id: string
  tool_name: string
  tool_args: Record<string, JsonValue> | null
  tool_result: Record<string, JsonValue> | null
  success: boolean
  latency_ms: number | null
  executed_at: string
}

export interface Escalation {
  id: string
  call_log_id: string
  claim_id: string | null
  customer_id: string | null
  reason: string
  priority: 'low' | 'normal' | 'high' | 'urgent'
  status: 'pending' | 'assigned' | 'resolved'
  assigned_to: string | null
  notes: string | null
  created_at: string
  resolved_at: string | null
  customer_name: string
  claim_number: string | null
  call_summary: string | null
}

export interface ScheduledCallback {
  id: string
  call_log_id: string | null
  customer_id: string | null
  phone_number: string
  scheduled_time: string
  reason: string | null
  status: 'pending' | 'completed' | 'cancelled'
  created_at: string
}

export interface AnalyticsData {
  total_calls: number
  avg_duration_seconds: number
  calls_by_direction: {
    inbound: number
    outbound: number
    webrtc: number
  }
  calls_by_status: {
    in_progress: number
    completed: number
    failed: number
  }
  claims_by_status: Record<string, number>
  total_claims: number
  total_escalations: number
  pending_escalations: number
  calls_over_time: Array<{
    date: string
    count: number
  }>
}

// Filter types
export interface ClaimsFilter {
  status?: string
  claim_type?: string
  customer_id?: string
}

export interface CallsFilter {
  status?: string
  direction?: string
  customer_id?: string
}

export interface EscalationsFilter {
  status?: string
  priority?: string
}

export interface AgentIdentity {
  agent_id: number
  agent_card_cid: string | null
  identity_registry_address: string | null
  network: string | null
  owner_address: string | null
  claim_registry_address: string | null
  registration_tx_hash: string | null
}

export interface AgentToolParameter {
  name: string
  type: 'string' | 'number' | 'boolean'
  required: boolean
  description: string
}

export interface AgentToolDefinition {
  name: string
  description: string
  method: 'POST'
  path: string
  url: string
  parameters: AgentToolParameter[]
}

export interface AgentConfigData {
  agent_name: string
  first_message: string
  system_prompt: string
  customized: boolean
  updated_at: string | null
  synced_at: string | null
  disabled_tools: string[]
  all_tools: Array<AgentToolDefinition & { enabled: boolean }>
  tools: AgentToolDefinition[]
  integration: {
    base_url: string
    webhook_url: string
    conversation_init_url: string
    elevenlabs_agent_id: string | null
  }
  mode: 'simulation' | 'live'
  features: {
    webhook_signature_verification: boolean
    filecoin_uploads: boolean
    chain_attestation: boolean
    eas_attestation: boolean
    simulated_archival: boolean
    editing_enabled: boolean
    sync_enabled: boolean
  }
}

export interface AgentConfigUpdate {
  agent_name?: string
  first_message?: string
  system_prompt?: string
  disabled_tools?: string[]
}

export interface AgentSyncResult {
  agentId: string
  toolsCreated: number
  toolsUpdated: number
  toolsAttached: number
  warnings: string[]
}

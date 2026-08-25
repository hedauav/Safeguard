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
  call_log_id: string | null
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

// ---------------------------------------------------------------------------
// Human review of AI adjudications
//
// These mirror `adjudications` (migration 0017) and `adjudication_reviews`
// (0019) field for field. Nothing rendered on the review queue is derived from
// anything but a column that actually exists in one of those two tables.
// ---------------------------------------------------------------------------

/** The only verdicts an adjudication can carry. A recommendation, never a decision. */
export type AdjudicationVerdict = 'approve' | 'deny' | 'escalate'

/** How the model's figure compared with the one computed in code. */
export type AmountAgreement = 'agreed' | 'disagreed' | 'not_proposed' | 'not_asked'

/** One deterministic check, exactly as the rules layer recorded it. */
export interface AdjudicationCheck {
  id: string
  passed: boolean
  /** The verdict this failure forced, or null when the check passed. */
  vetoes: AdjudicationVerdict | null
  detail: string
}

export interface Adjudication {
  id: string
  claim_id: string
  claim_number: string
  verdict: AdjudicationVerdict
  confidence: number
  /** Computed in code. The only figure here with any authority. */
  computed_payable_amount: number
  /** What the model calculated. Recorded for comparison, never to be paid. */
  model_proposed_amount: number | null
  amount_agreement: AmountAgreement
  policy_clauses: string[]
  inconsistencies: string[]
  checks: AdjudicationCheck[]
  /** The rule that short-circuited before the model was called, or null. */
  vetoed_by: string | null
  model_invoked: boolean
  model_provider: string | null
  model_id: string | null
  model_latency_ms: number | null
  /** True when the answer came from FakeLlmProvider — no model read anything. */
  simulated: boolean
  parse_error: string | null
  created_at: string
}

/** The human's answer. Absent means nobody has answered yet. */
export interface AdjudicationReview {
  id: string
  adjudication_id: string
  decision: 'approved' | 'rejected'
  reviewer: string
  note: string | null
  /** The recommendation as it stood when the button was pressed. */
  recommended_verdict: AdjudicationVerdict
  model_invoked: boolean
  claim_status_before: string | null
  /** Null means the claim status was NOT changed by this decision. */
  claim_status_after: string | null
  decided_at: string
}

export interface ReviewQueueItem {
  adjudication: Adjudication
  /** Null when the claim row could not be read; never a stand-in row. */
  claim: {
    id: string
    claim_number: string
    status: string
    claimed_amount: number | null
    customer_name: string
  } | null
  review: AdjudicationReview | null
  /** Older adjudications on the same claim, superseded by this one. */
  superseded_count: number
}

export interface ReviewQueueResponse {
  data: ReviewQueueItem[]
  total: number
  state: 'pending' | 'decided' | 'all'
  limit: number
  /** How many adjudication rows were actually read. */
  scanned: number
  scan_cap: number
  /** True when the scan window filled, so the counts below are incomplete. */
  truncated: boolean
  claims_with_adjudication: number
  claims_total: number | null
  /** Exact, or null when the scan was truncated and no honest figure exists. */
  claims_never_adjudicated: number | null
  pending_count: number | null
  decided_count: number | null
  /** False when the 0019 migration has not been applied. */
  reviews_available: boolean
  reviews_unavailable_reason: string | null
  /** False when the server has no ADMIN_TOKEN, so no decision can be recorded. */
  decisions_enabled: boolean
  error: string | null
}

export interface ReviewDecisionResult {
  id: string
  adjudication_id: string
  claim_number: string
  decision: 'approved' | 'rejected'
  reviewer: string
  note: string | null
  recommended_verdict: AdjudicationVerdict
  claim_status_before: string | null
  claim_status_after: string | null
  decided_at: string
  /** True when the human went against what was recommended. */
  overrode_recommendation: boolean
  warnings: string[]
}

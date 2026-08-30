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

/**
 * Who caused a journey event. Mirrors the CHECK on `journey_events.actor`.
 *
 * `| (string & {})` keeps the four known values on autocomplete without making
 * the UI lie if the writer ever records a fifth: the timeline renders whatever
 * the row actually says rather than silently mislabelling it.
 */
export type JourneyActor = 'agent' | 'system' | 'human' | 'provider' | (string & {})

/**
 * One row of `journey_events` (migration 0021), exactly as stored.
 *
 * Append-only: a step that failed is a row here too, and that is the point —
 * the claim page shows failures rather than hiding them behind the last
 * successful step.
 */
export interface JourneyEvent {
  id: string
  claim_id: string | null
  policy_id: string | null
  event_type: string
  actor: JourneyActor
  detail: Record<string, JsonValue> | null
  occurred_at: string
  call_log_id: string | null
}

export interface ClaimOutcome {
  claim_number: string
  status: string
  has_refund: boolean
  reason?: string | null
  decision: {
    decision: string
    reviewer: string | null
    decided_at: string | null
    recommended_verdict: string | null
    overrode_recommendation: boolean | null
    reason: string | null
    reason_source: string | null
    failed_check: string | null
    model_invoked: boolean | null
  } | null
  claimant?: { name: string | null; email: string | null } | null
  policy?: { number: string | null; type: string | null; deductible: number | null } | null
  stored?: {
    provider: string | null
    refund_id: string
    status: string | null
    amount_paise: number | null
    receipt: string | null
    refunded_at: string | null
    simulated: boolean
    against_payment_id: string | null
    captured_amount_paise: number | null
    captured_at: string | null
  } | null
  rail?: {
    id: string
    status: string
    amount_paise: number
    currency: string
    payment_id: string
    receipt: string
    created_at: string
  } | null
  rail_error?: string | null
  settlement?: {
    approved_amount: number | null
    payout_id: string | null
    payout_reference: string | null
    paid_at: string | null
    simulated: boolean | null
    disclosure: string | null
  } | null
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
  /**
   * Everything recorded against this claim, oldest first.
   *
   * Empty means one of three different things and the page must say which:
   * `journey_available: false` (migration 0021 unapplied), `journey_error`
   * non-null (the read failed), or genuinely nothing written — which for a
   * claim filed before this table existed is simply true. None of them licence
   * drawing a "filed" step out of `filed_at`.
   */
  journey_events: JourneyEvent[]
  /**
   * Policy-level events with no claim of their own — renewal offered, paid,
   * failed, policy reactivated. Kept separate from the claim's own steps
   * because a renewal is not a step of this claim.
   */
  policy_events: JourneyEvent[]
  /** False when migration 0021 has not been applied. */
  journey_available: boolean
  /** Why the timeline could not be read, or null when it was read fine. */
  journey_error: string | null
  /** True when the server's event cap was hit, so the timeline is a prefix. */
  journey_truncated: boolean
}

/**
 * One turn of a call, exactly as the webhook writer stores it.
 *
 * `timestamp` was the only field this type declared, and nothing has ever
 * written it: ElevenLabs sends no absolute time, and the writer stores
 * `time_in_call_secs` — an offset from the start of the call. Every turn
 * therefore rendered without any time at all. It is kept as an optional
 * fallback because the seeded demo rows predate the offset.
 */
export interface TranscriptEntry {
  role: string
  message: string
  /** Seconds from the start of the call. What the writer actually stores. */
  time_in_call_secs?: number
  /** Pre-existing rows only. Rendered verbatim when present and no offset is. */
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
  /**
   * Why the tool list could not be read, or null when it was read fine.
   * An empty array has to mean "the agent invoked nothing"; without this the
   * UI could not tell that apart from a query that failed.
   */
  tool_executions_error: string | null
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

/**
 * Who was at fault, as the decision endpoint spells it.
 *
 * These four strings are the ones `adjudication-review.ts` validates against
 * and the ones the claims CHECK constraint permits — the server refuses
 * anything else by name rather than coercing it, so nothing may be reworded on
 * the way out of this app. Only `other_party` waives the deductible;
 * `shared` deliberately does not.
 *
 * The absence of a value is not one of them. A decision sent with no fault
 * field writes nothing to the claim, which is a different fact from a recorded
 * finding of `undetermined` — both mean no refund, but only one means somebody
 * looked.
 */
export type FaultDetermination = 'insured' | 'other_party' | 'shared' | 'undetermined'

/**
 * The deductible waiver carried out as a consequence of a decision.
 *
 * A discriminated union because a refusal must never be readable as a refund:
 * `refund_id` is typed `null` on the failure arm so no rendering path can print
 * one that does not exist.
 */
export type DeductibleRefundResult =
  | {
      success: true
      reason: null
      claim_number: string
      refund_id: string
      refund_status: 'pending' | 'processed' | 'failed'
      refund_amount: number
      payment_id: string
      /** True when no real rail was involved. Never present this as money moved. */
      simulated: boolean
      /**
       * True when the claim's settlement payout was simulated, which makes this
       * refund the only real money-out on the claim.
       */
      stands_in_for_settlement: boolean
      /** That disclosure in words. Must be rendered where the flag is true. */
      settlement_disclosure: string | null
      message: string
    }
  | {
      success: false
      reason: string
      refund_id: null
      claim_number: string | null
      refund_amount: number | null
      message: string
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
  /**
   * What was actually written onto the claim — not what was asked for. Null
   * when none was sent, and also when the write failed, in which case a
   * sentence in `warnings` says so.
   */
  fault_determination: FaultDetermination | null
  fault_determined_by: string | null
  /** The refund this decision caused, or null when it caused none. */
  deductible_refund: DeductibleRefundResult | null
  /**
   * Set when the fault finding waives the deductible but the claim has not been
   * settled yet, so the refund follows at settlement rather than now.
   */
  deductible_refund_note: string | null
  warnings: string[]
}

/**
 * The public verification endpoints — /api/evidence/verify and
 * /api/evidence/verify/:paymentId. Mirrors backend/src/routes/verify.ts.
 *
 * `stored` and `rail` are two answers to the same question from two different
 * parties, and they are separate fields here for the same reason they are
 * separate in the response: merging them would put the payment rail's name on
 * a figure that came out of our own database.
 */
export interface RailPaymentView {
  id: string
  /** Razorpay's own word: 'captured', 'refunded', 'authorized', 'failed'. */
  status: string
  captured: boolean
  amountPaise: number
  amountRefundedPaise: number
  refundStatus: string | null
  currency: string
  /** An instrument class — 'card', 'upi' — never an instrument. */
  method: string | null
  createdAt: string
}

export interface StoredPaymentView {
  claim_number: string | null
  payment_id: string
  captured_amount_paise: number | null
  captured_at: string | null
  refund_id: string | null
  refund_status: string | null
  refund_amount_paise: number | null
  refunded_at: string | null
  simulated: boolean
  refund_simulated: boolean
}

/**
 * Three-valued throughout. `null` means the rail could not be asked, which is
 * not the same as the rail disagreeing, and the page must never render them
 * the same way.
 */
export interface PaymentAgreement {
  rail_confirms_capture: boolean | null
  capture_amount_matches: boolean | null
  rail_confirms_refund: boolean | null
  refund_amount_matches: boolean | null
}

export interface VerifiedPayment {
  stored: StoredPaymentView
  rail: { payment: RailPaymentView | null; refund: { id: string; status: string; amount_paise: number; payment_id: string; created_at: string } | null } | null
  rail_error: string | null
  agreement: PaymentAgreement
  verdict: 'confirmed' | 'disagrees' | 'not_on_this_account' | 'unavailable' | 'simulated'
  /**
   * Which Razorpay account answered — a label such as `primary` or
   * `archive`, never anything derived from a key. Null when none did.
   */
  answered_by: string | null
}

export interface VerificationSummary {
  payments_checked: number
  confirmed: number
  disagrees: number
  /** Answered for by the rail, but under different credentials to ours. */
  not_on_this_account: number
  unavailable: number
  simulated: number
  stored_collected_paise: number
  stored_refunded_paise: number
  /** Summed from the rail's answers, over `rail_totals_cover` payments only. */
  rail_collected_paise: number
  rail_refunded_paise: number
  rail_totals_cover: number
  totals_agree: boolean
}

export interface VerificationSweep {
  /** Which rail was asked, as opposed to what it said. */
  checked_against: {
    provider: string
    mode: string
    /**
     * The accounts consulted, by label. More than one because the book spans
     * more than one: an earlier test account that has since hit its limit
     * holds part of it, and a Razorpay key reads only its own account.
     */
    accounts: string[]
  }
  summary: VerificationSummary
  payments: VerifiedPayment[]
  checked_at: string
  cache_ttl_seconds: number
}

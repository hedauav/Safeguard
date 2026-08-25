// ============================================
// Database Table Interfaces
// ============================================

export interface Customer {
  id: string;
  full_name: string;
  email: string | null;
  phone: string;
  date_of_birth: string | null;
  address: string | null;
  created_at: string;
}

export interface Policy {
  id: string;
  policy_number: string;
  customer_id: string;
  policy_type: 'auto' | 'home' | 'health' | 'life';
  provider: string;
  coverage_amount: number;
  deductible: number;
  premium_monthly: number;
  start_date: string;
  end_date: string;
  status: 'active' | 'expired' | 'cancelled' | 'pending';
  coverage_details: Record<string, any>;
  created_at: string;
}

export interface Claim {
  id: string;
  claim_number: string;
  policy_id: string;
  customer_id: string;
  claim_type: string;
  status: 'submitted' | 'under_review' | 'documents_needed' | 'approved' | 'denied' | 'paid' | 'closed';
  incident_date: string;
  incident_description: string;
  claimed_amount: number | null;
  approved_amount: number | null;
  assigned_adjuster: string | null;
  documents_required: string[] | null;
  documents_received: string[] | null;
  notes: string | null;
  filecoin_cid: string | null;
  piece_cid: string | null;
  dataset_id: string | null;
  attestation_tx_hash: string | null;
  eas_uid: string | null;
  evidence_hash: string | null;
  pdp_proof_status: 'pending' | 'verified' | 'failed' | null;
  agent_id: number | null;
  attested_at: string | null;
  filed_at: string;
  updated_at: string;
}

export interface CallLog {
  id: string;
  elevenlabs_conversation_id: string | null;
  customer_id: string | null;
  direction: 'inbound' | 'outbound' | 'webrtc';
  phone_number: string | null;
  status: 'in_progress' | 'completed' | 'failed';
  duration_seconds: number | null;
  transcript: Array<{ role: string; message: string; timestamp?: string }> | null;
  summary: string | null;
  outcome: string | null;
  tools_used: string[] | null;
  recording_url: string | null;
  analysis: Record<string, any> | null;
  evaluation: Record<string, any> | null;
  metadata: Record<string, any> | null;
  webhook_payload: Record<string, any> | null;
  started_at: string;
  ended_at: string | null;
}

export interface CallToolExecution {
  id: string;
  call_log_id: string;
  tool_name: string;
  tool_args: Record<string, any> | null;
  tool_result: Record<string, any> | null;
  success: boolean;
  latency_ms: number | null;
  executed_at: string;
}

export interface Escalation {
  id: string;
  /** Null when the escalation was raised outside a call. */
  call_log_id: string | null;
  /** The reference read aloud to the caller, e.g. ESC-2026-04817263. */
  reference_number: string | null;
  claim_id: string | null;
  customer_id: string | null;
  reason: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'pending' | 'assigned' | 'resolved';
  assigned_to: string | null;
  notes: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface ScheduledCallback {
  id: string;
  call_log_id: string | null;
  customer_id: string | null;
  phone_number: string;
  scheduled_time: string;
  reason: string | null;
  status: 'pending' | 'completed' | 'cancelled';
  created_at: string;
}

// ============================================
// API Response Types
// ============================================

export interface ApiResponse<T> {
  data: T;
  error: string | null;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

// ============================================
// API Request Types
// ============================================

export interface ClaimsFilter {
  status?: Claim['status'];
  claim_type?: string;
  customer_id?: string;
}

export interface CallsFilter {
  status?: CallLog['status'];
  direction?: CallLog['direction'];
  customer_id?: string;
}

// ============================================
// ElevenLabs Webhook Payload
// ============================================

export interface ElevenLabsConversationEndedPayload {
  conversation_id: string;
  agent_id: string;
  status: string;
  transcript: Array<{
    role: 'agent' | 'user';
    message: string;
    timestamp?: number;
  }>;
  metadata: Record<string, any>;
  analysis: {
    call_successful: boolean;
    transcript_summary: string;
    data_collection_results?: Record<string, any>;
    evaluation_criteria_results?: Record<string, any>;
  };
  conversation_initiation_client_data?: Record<string, any>;
}

// ============================================
// Analytics Response
// ============================================

export interface AnalyticsData {
  total_calls: number;
  avg_duration_seconds: number;
  calls_by_direction: Record<string, number>;
  calls_by_status: Record<string, number>;
  claims_by_status: Record<string, number>;
  total_claims: number;
  total_escalations: number;
  pending_escalations: number;
  calls_over_time: Array<{ date: string; count: number }>;
}

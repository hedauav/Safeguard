import crypto from 'crypto';

/**
 * Parsing and verification for ElevenLabs post-call webhooks.
 *
 * Reference: https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks
 *
 * Payloads are enveloped as `{ type, event_timestamp, data }`. Reading fields
 * off the envelope root (as an earlier version did) silently yields undefined
 * for every field, which is why this shape is modelled explicitly.
 */

export type ElevenLabsEventType =
  | 'post_call_transcription'
  | 'post_call_audio'
  | 'call_initiation_failure';

export interface ElevenLabsToolCall {
  /** Field naming varies by tool type; both spellings appear in the wild. */
  tool_name?: string;
  name?: string;
  params_as_json?: string;
  parameters?: Record<string, unknown>;
  tool_call_id?: string;
  request_id?: string;
  type?: string;
}

export interface ElevenLabsToolResult {
  tool_name?: string;
  name?: string;
  result_value?: unknown;
  result?: unknown;
  is_error?: boolean;
  tool_call_id?: string;
  request_id?: string;
  tool_latency_secs?: number;
}

export interface ElevenLabsTranscriptTurn {
  role: 'agent' | 'user';
  message: string | null;
  /** Seconds from call start. ElevenLabs does not send absolute timestamps. */
  time_in_call_secs?: number;
  tool_calls?: ElevenLabsToolCall[] | null;
  tool_results?: ElevenLabsToolResult[] | null;
}

export interface ElevenLabsTranscriptionData {
  agent_id: string;
  conversation_id: string;
  status?: string;
  transcript?: ElevenLabsTranscriptTurn[];
  metadata?: {
    start_time_unix_secs?: number;
    /** The real duration field. Not `duration_seconds`. */
    call_duration_secs?: number;
    cost?: number;
    termination_reason?: string;
    phone_call?: {
      direction?: string;
      external_number?: string;
      agent_number?: string;
      call_sid?: string;
      type?: string;
    };
    [key: string]: unknown;
  };
  analysis?: {
    /** A string such as "success" or "failure" — NOT a boolean. */
    call_successful?: string;
    transcript_summary?: string;
    data_collection_results?: Record<string, any>;
    evaluation_criteria_results?: Record<string, any>;
  };
  conversation_initiation_client_data?: Record<string, any>;
}

export interface ElevenLabsWebhookEnvelope {
  type: ElevenLabsEventType;
  event_timestamp: number;
  data: Record<string, any>;
}

export interface NormalizedToolExecution {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  success: boolean;
  latencyMs: number | null;
}

/** Maximum age of a webhook we will accept, guarding against replay. */
const SIGNATURE_TOLERANCE_SECONDS = 30 * 60;

export type SignatureVerdict =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Verify the `ElevenLabs-Signature` header.
 *
 * Format: `t=<unix_seconds>,v0=<hex_hmac>` where the HMAC is taken over
 * `${timestamp}.${rawBody}` — signing the body alone never validates.
 */
export function verifySignature(
  headerValue: string | undefined,
  rawBody: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): SignatureVerdict {
  if (!headerValue) {
    return { valid: false, reason: 'Missing ElevenLabs-Signature header' };
  }

  let timestamp: string | null = null;
  let providedHash: string | null = null;

  for (const part of headerValue.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't') timestamp = value;
    if (key === 'v0') providedHash = value;
  }

  if (!timestamp || !providedHash) {
    return { valid: false, reason: 'Malformed signature header (expected "t=...,v0=...")' };
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return { valid: false, reason: 'Signature timestamp is not a number' };
  }
  if (Math.abs(nowSeconds - timestampSeconds) > SIGNATURE_TOLERANCE_SECONDS) {
    return { valid: false, reason: 'Signature timestamp outside tolerance window' };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const providedBuf = Buffer.from(providedHash, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');

  if (providedBuf.length !== expectedBuf.length) {
    return { valid: false, reason: 'Signature mismatch' };
  }
  if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return { valid: false, reason: 'Signature mismatch' };
  }

  return { valid: true };
}

/**
 * Pull real tool executions out of the transcript.
 *
 * ElevenLabs attaches `tool_calls` / `tool_results` to individual agent turns,
 * not to the top-level metadata. Results are matched to calls by id where one
 * is present, falling back to positional pairing within the same turn.
 */
export function extractToolExecutions(
  transcript: ElevenLabsTranscriptTurn[]
): NormalizedToolExecution[] {
  const idOf = (item: ElevenLabsToolCall | ElevenLabsToolResult) =>
    item.tool_call_id ?? item.request_id ?? null;
  const nameOf = (item: ElevenLabsToolCall | ElevenLabsToolResult) =>
    item.tool_name ?? item.name ?? 'unknown';

  // ElevenLabs records a tool_call on the agent's turn and the tool_result on a
  // later turn, once the request comes back. Pairing within a single turn
  // therefore matches almost nothing and splits every call into two orphan
  // rows, so collect across the whole transcript first.
  const calls: ElevenLabsToolCall[] = [];
  const results: ElevenLabsToolResult[] = [];
  for (const turn of transcript) {
    calls.push(...(turn.tool_calls ?? []));
    results.push(...(turn.tool_results ?? []));
  }

  const unmatched = [...results];

  const takeResult = (call: ElevenLabsToolCall): ElevenLabsToolResult | undefined => {
    const id = idOf(call);
    // Prefer an explicit id match; ids are unique per invocation, so this is
    // the only pairing that stays correct when a tool is called twice.
    if (id) {
      const byId = unmatched.findIndex((r) => idOf(r) === id);
      if (byId !== -1) return unmatched.splice(byId, 1)[0];
    }
    // Otherwise fall back to the earliest unclaimed result for the same tool,
    // which preserves call order for repeated invocations.
    const byName = unmatched.findIndex((r) => nameOf(r) === nameOf(call));
    if (byName !== -1) return unmatched.splice(byName, 1)[0];
    return undefined;
  };

  const executions: NormalizedToolExecution[] = calls.map((call) => {
    const result = takeResult(call);
    return {
      toolName: nameOf(call),
      args: parseArgs(call),
      result: result ? (result.result_value ?? result.result ?? null) : null,
      // A call with no result never completed — that is a genuine failure,
      // distinct from a result that came back flagged is_error.
      success: result ? result.is_error !== true : false,
      latencyMs:
        result?.tool_latency_secs != null ? Math.round(result.tool_latency_secs * 1000) : null,
    };
  });

  // Results with no originating call still record that the tool ran.
  for (const orphan of unmatched) {
    executions.push({
      toolName: nameOf(orphan),
      args: {},
      result: orphan.result_value ?? orphan.result ?? null,
      success: orphan.is_error !== true,
      latencyMs:
        orphan.tool_latency_secs != null ? Math.round(orphan.tool_latency_secs * 1000) : null,
    });
  }

  return executions;
}

function parseArgs(call: ElevenLabsToolCall): Record<string, unknown> {
  if (call.parameters && typeof call.parameters === 'object') {
    return call.parameters;
  }
  if (typeof call.params_as_json === 'string') {
    try {
      const parsed = JSON.parse(call.params_as_json);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return { raw: call.params_as_json };
    }
  }
  return {};
}

/**
 * Locate the id of a claim filed during the call.
 * Checks the agent's structured data collection first, then the actual
 * file_claim tool result. Returns null when no claim was filed — the caller
 * must not invent one.
 */
export function extractClaimId(
  dataCollection: Record<string, any> | null | undefined,
  executions: NormalizedToolExecution[]
): string | null {
  const fromCollection =
    dataCollection?.claim_id?.value ??
    dataCollection?.claim_id ??
    dataCollection?.claim?.id;
  if (fromCollection && typeof fromCollection !== 'object') {
    return String(fromCollection);
  }

  for (const execution of executions) {
    if (!/file[_-]?claim/i.test(execution.toolName)) continue;
    const result = execution.result as any;
    const parsed = typeof result === 'string' ? safeJsonParse(result) : result;
    if (parsed?.claim_id) return String(parsed.claim_id);
  }

  return null;
}

function safeJsonParse(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Duration in seconds, from the field ElevenLabs actually sends. */
export function calculateDuration(data: ElevenLabsTranscriptionData): number {
  const reported = data.metadata?.call_duration_secs;
  if (typeof reported === 'number' && reported >= 0) return Math.round(reported);

  const transcript = data.transcript ?? [];
  const last = transcript[transcript.length - 1]?.time_in_call_secs;
  return typeof last === 'number' ? Math.round(last) : 0;
}

/** Map ElevenLabs' string verdict onto our call outcome. */
export function mapOutcome(callSuccessful: string | undefined): string {
  if (callSuccessful === 'success') return 'resolved';
  if (callSuccessful === 'failure') return 'unresolved';
  return 'unknown';
}

/**
 * The outcomes this writer is allowed to store, most significant first.
 *
 * Each entry names a tool the agent can actually invoke, so an outcome is only
 * ever claimed when a matching tool ran *and came back successful*. Order is
 * precedence: a call where the agent looked up a claim and then filed one is a
 * call where a claim was filed — the more consequential action wins.
 *
 * This list, plus the three verdict outcomes below it (`resolved`,
 * `unresolved`, `unknown`) and the `initiation_failed: …` string written by the
 * failure path, is the complete vocabulary. The dashboard's colour map is built
 * from exactly this set; nothing else is invented at either end.
 */
const OUTCOME_BY_TOOL: ReadonlyArray<{ tools: readonly string[]; outcome: string }> = [
  { tools: ['file_claim'], outcome: 'claim_filed' },
  { tools: ['escalate_to_regulator'], outcome: 'escalated_to_regulator' },
  { tools: ['escalate_to_human'], outcome: 'escalated' },
  { tools: ['settle_claim'], outcome: 'settlement_initiated' },
  { tools: ['collect_deductible'], outcome: 'deductible_requested' },
  { tools: ['offer_renewal'], outcome: 'renewal_offered' },
  { tools: ['schedule_callback'], outcome: 'callback_scheduled' },
  { tools: ['attach_document'], outcome: 'documents_requested' },
  { tools: ['lookup_claim', 'check_policy', 'check_documents'], outcome: 'info_provided' },
];

/**
 * What actually happened on the call.
 *
 * `mapOutcome` alone only ever yields resolved / unresolved / unknown, which is
 * a verdict on the conversation rather than a record of it — every real call
 * rendered as an identical badge carrying no information. The tool executions
 * are the one place the call's substance is written down, so they are read
 * first.
 *
 * Two rules keep this honest. Only a tool that *succeeded* counts: an attempted
 * `file_claim` that errored is not a filed claim. And when no tool tells us
 * anything, we fall back to ElevenLabs' verdict rather than guessing — an
 * unknown outcome stays `unknown`, because "we do not know" is the true answer
 * and dressing it up as something specific would be a lie the data cannot
 * support.
 *
 * The concrete action is preferred over a `failure` verdict deliberately: a
 * claim that reached the database was filed whatever the model thought of the
 * conversation around it. The verdict is an opinion; the execution row is a
 * fact.
 */
export function deriveOutcome(
  callSuccessful: string | undefined,
  executions: NormalizedToolExecution[]
): string {
  const succeeded = new Set(executions.filter((e) => e.success).map((e) => e.toolName));

  for (const { tools, outcome } of OUTCOME_BY_TOOL) {
    if (tools.some((tool) => succeeded.has(tool))) return outcome;
  }

  return mapOutcome(callSuccessful);
}

/** Reject placeholders ElevenLabs sends in place of a number it does not have. */
function cleanPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // ElevenLabs fills unresolved dynamic variables with these literals rather
  // than omitting them, and our own conversation-init returns "Unknown" too.
  if (['unknown', 'null', 'undefined', 'none'].includes(trimmed.toLowerCase())) return null;
  return trimmed;
}

/**
 * The caller's number, from wherever this particular call carries it.
 *
 * `metadata.phone_call.external_number` is the only source the writer used
 * before, and it is absent for every browser-widget conversation — which is why
 * those rows had no number and no name. Where a call was personalised, the
 * number ElevenLabs personalised it with comes back in
 * `conversation_initiation_client_data.dynamic_variables`, so that is checked
 * too. Returns null rather than a placeholder when there is genuinely nothing.
 */
export function extractCallerPhone(data: ElevenLabsTranscriptionData): string | null {
  const direct = cleanPhone(data.metadata?.phone_call?.external_number);
  if (direct) return direct;

  const vars = data.conversation_initiation_client_data?.dynamic_variables as
    | Record<string, unknown>
    | undefined;

  for (const key of ['system__caller_id', 'caller_id', 'phone_number', 'customer_phone']) {
    const value = cleanPhone(vars?.[key]);
    if (value) return value;
  }

  return null;
}

/**
 * The spellings of one number worth trying against `customers.phone`.
 *
 * Stored numbers are E.164 (`+14155550101`); carriers and the browser SDK are
 * less consistent, sending spaces, dashes or a bare national number. Comparing
 * the raw string alone silently misses a customer who is sitting right there in
 * the table, and a missed match is exactly the "Unknown" this fixes.
 */
export function phoneLookupVariants(phone: string): string[] {
  const trimmed = phone.trim();
  const variants = new Set<string>([trimmed]);

  const digits = trimmed.replace(/\D/g, '');
  if (digits) {
    variants.add(digits);
    variants.add(`+${digits}`);
  }

  return [...variants];
}

/**
 * The slice of the Supabase client customer resolution needs.
 *
 * Deliberately loose: `SupabaseClient`'s builder generics do not survive being
 * described structurally, and pinning them here would buy nothing — the point
 * of the interface is that a test can hand this function a stub instead of a
 * database.
 */
export interface CustomerLookupClient {
  from(table: string): any;
}

async function firstRow(query: any): Promise<Record<string, any> | null> {
  const { data } = await query;
  return Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
}

/**
 * Which customer this call belongs to, or null when we genuinely cannot tell.
 *
 * `customer_id` was never written at all, so the dashboard's join returned null
 * for every row and every call read as "Unknown". Two identifications are
 * available and both are real:
 *
 *  1. The caller's number, matched against `customers.phone`. This is the same
 *     identification conversation-init already performs to greet them by name.
 *  2. A claim filed during the call, which carries its own `customer_id` — the
 *     one identification available to a browser-widget call, where there is no
 *     number at all.
 *
 * Returns null when neither applies. That is the normal, correct answer for an
 * anonymous web caller, and the dashboard says so in those words rather than
 * implying a lookup failed. Lookup errors are swallowed: the call record is
 * what matters, and losing it because the customers table hiccuped would be a
 * worse bug than an unattributed row.
 */
export async function resolveCustomerId(
  client: CustomerLookupClient,
  identification: { phone?: string | null; claimId?: string | null }
): Promise<string | null> {
  const { phone, claimId } = identification;

  if (phone) {
    for (const variant of phoneLookupVariants(phone)) {
      try {
        const row = await firstRow(
          client.from('customers').select('id').eq('phone', variant).limit(1)
        );
        if (row?.id) return String(row.id);
      } catch {
        // Fall through to the next variant, then to the claim below.
      }
    }
  }

  if (claimId) {
    try {
      const row = await firstRow(
        client.from('claims').select('customer_id').eq('id', claimId).limit(1)
      );
      if (row?.customer_id) return String(row.customer_id);
    } catch {
      // Nothing further to try.
    }
  }

  return null;
}

/** Map the phone_call metadata onto our direction enum. */
export function mapDirection(data: ElevenLabsTranscriptionData): 'inbound' | 'outbound' | 'webrtc' {
  const direction = data.metadata?.phone_call?.direction;
  if (direction === 'outbound') return 'outbound';
  if (direction === 'inbound') return 'inbound';
  // No phone_call block means the conversation came over the browser SDK.
  return data.metadata?.phone_call ? 'inbound' : 'webrtc';
}

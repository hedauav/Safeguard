import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  verifySignature,
  extractToolExecutions,
  extractClaimId,
  calculateDuration,
  mapOutcome,
  mapDirection,
  type ElevenLabsTranscriptTurn,
  type ElevenLabsTranscriptionData,
} from './elevenlabs-webhook.js';

const SECRET = 'wsec_test_secret';

function sign(body: string, timestamp: number, secret = SECRET): string {
  const hash = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v0=${hash}`;
}

// --- Signature verification -------------------------------------------------

test('accepts a correctly signed payload', () => {
  const body = JSON.stringify({ type: 'post_call_transcription' });
  const now = 1_700_000_000;
  const result = verifySignature(sign(body, now), body, SECRET, now);
  assert.equal(result.valid, true);
});

test('rejects a signature computed over the body alone', () => {
  // The previous implementation HMAC'd only the body, which never validates.
  const body = JSON.stringify({ type: 'post_call_transcription' });
  const now = 1_700_000_000;
  const bodyOnly = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  const result = verifySignature(`t=${now},v0=${bodyOnly}`, body, SECRET, now);
  assert.equal(result.valid, false);
});

test('rejects a payload signed with the wrong secret', () => {
  const body = '{}';
  const now = 1_700_000_000;
  const result = verifySignature(sign(body, now, 'wrong_secret'), body, SECRET, now);
  assert.equal(result.valid, false);
});

test('rejects a tampered body', () => {
  const body = '{"amount":100}';
  const now = 1_700_000_000;
  const header = sign(body, now);
  const result = verifySignature(header, '{"amount":999999}', SECRET, now);
  assert.equal(result.valid, false);
});

test('rejects a stale signature outside the tolerance window', () => {
  const body = '{}';
  const signedAt = 1_700_000_000;
  const result = verifySignature(sign(body, signedAt), body, SECRET, signedAt + 3600);
  assert.equal(result.valid, false);
  assert.match((result as { reason: string }).reason, /tolerance/);
});

test('rejects a missing or malformed header', () => {
  assert.equal(verifySignature(undefined, '{}', SECRET).valid, false);
  assert.equal(verifySignature('garbage', '{}', SECRET).valid, false);
  assert.equal(verifySignature('t=123', '{}', SECRET).valid, false);
});

// --- Outcome mapping --------------------------------------------------------

test('call_successful is a string, not a boolean', () => {
  // "failure" is truthy, so the previous boolean check marked failed calls resolved.
  assert.equal(mapOutcome('success'), 'resolved');
  assert.equal(mapOutcome('failure'), 'unresolved');
  assert.equal(mapOutcome(undefined), 'unknown');
});

// --- Duration ---------------------------------------------------------------

test('reads duration from call_duration_secs', () => {
  const data = { metadata: { call_duration_secs: 22 } } as ElevenLabsTranscriptionData;
  assert.equal(calculateDuration(data), 22);
});

test('falls back to the last turn time when duration is absent', () => {
  const data = {
    metadata: {},
    transcript: [
      { role: 'agent', message: 'hi', time_in_call_secs: 0 },
      { role: 'user', message: 'hello', time_in_call_secs: 14 },
    ],
  } as ElevenLabsTranscriptionData;
  assert.equal(calculateDuration(data), 14);
});

test('returns zero rather than throwing on an empty transcript', () => {
  assert.equal(calculateDuration({ metadata: {} } as ElevenLabsTranscriptionData), 0);
});

// --- Direction --------------------------------------------------------------

test('maps phone metadata to direction, defaulting to webrtc for browser calls', () => {
  assert.equal(
    mapDirection({ metadata: { phone_call: { direction: 'inbound' } } } as ElevenLabsTranscriptionData),
    'inbound'
  );
  assert.equal(
    mapDirection({ metadata: { phone_call: { direction: 'outbound' } } } as ElevenLabsTranscriptionData),
    'outbound'
  );
  assert.equal(mapDirection({ metadata: {} } as ElevenLabsTranscriptionData), 'webrtc');
});

// --- Tool extraction --------------------------------------------------------

test('extracts tool calls from transcript turns and pairs them with results', () => {
  const transcript: ElevenLabsTranscriptTurn[] = [
    { role: 'user', message: 'check claim CLM-1', tool_calls: null, tool_results: null },
    {
      role: 'agent',
      message: 'Looking that up.',
      tool_calls: [
        {
          tool_name: 'lookup_claim',
          tool_call_id: 'call_1',
          params_as_json: '{"claim_number":"CLM-1"}',
        },
      ],
      tool_results: [
        {
          tool_name: 'lookup_claim',
          tool_call_id: 'call_1',
          result_value: { found: true },
          is_error: false,
          tool_latency_secs: 0.42,
        },
      ],
    },
  ];

  const executions = extractToolExecutions(transcript);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].toolName, 'lookup_claim');
  assert.deepEqual(executions[0].args, { claim_number: 'CLM-1' });
  assert.equal(executions[0].success, true);
  assert.equal(executions[0].latencyMs, 420);
});

test('marks a tool execution unsuccessful when the result is an error', () => {
  const executions = extractToolExecutions([
    {
      role: 'agent',
      message: '',
      tool_calls: [{ tool_name: 'file_claim', tool_call_id: 'c1' }],
      tool_results: [{ tool_name: 'file_claim', tool_call_id: 'c1', is_error: true, result_value: 'boom' }],
    },
  ]);
  assert.equal(executions[0].success, false);
});

test('returns nothing for a transcript with no tool activity', () => {
  const executions = extractToolExecutions([
    { role: 'agent', message: 'Hello', tool_calls: null, tool_results: null },
    { role: 'user', message: 'Hi', tool_calls: null, tool_results: null },
  ]);
  assert.deepEqual(executions, []);
});

// --- Claim id extraction ----------------------------------------------------

test('finds the claim id in the file_claim tool result', () => {
  const executions = extractToolExecutions([
    {
      role: 'agent',
      message: '',
      tool_calls: [{ tool_name: 'file_claim', tool_call_id: 'c1' }],
      tool_results: [
        {
          tool_name: 'file_claim',
          tool_call_id: 'c1',
          result_value: { success: true, claim_id: 'uuid-123', claim_number: 'CLM-2024-000001' },
        },
      ],
    },
  ]);
  assert.equal(extractClaimId(null, executions), 'uuid-123');
});

test('reads a claim id out of a stringified tool result', () => {
  const executions = extractToolExecutions([
    {
      role: 'agent',
      message: '',
      tool_calls: [{ name: 'file_claim', tool_call_id: 'c1' }],
      tool_results: [{ name: 'file_claim', tool_call_id: 'c1', result_value: '{"claim_id":"uuid-456"}' }],
    },
  ]);
  assert.equal(extractClaimId(null, executions), 'uuid-456');
});

test('prefers the agent data collection result when present', () => {
  assert.equal(extractClaimId({ claim_id: { value: 'uuid-from-analysis' } }, []), 'uuid-from-analysis');
});

test('returns null when no claim was filed, so none can be fabricated', () => {
  // The previous webhook invented a mock claim here to keep a demo pipeline
  // running. A call where nothing was filed must yield nothing.
  const executions = extractToolExecutions([
    {
      role: 'agent',
      message: '',
      tool_calls: [{ tool_name: 'check_policy', tool_call_id: 'c1' }],
      tool_results: [{ tool_name: 'check_policy', tool_call_id: 'c1', result_value: { found: true } }],
    },
  ]);
  assert.equal(extractClaimId(null, executions), null);
  assert.equal(extractClaimId({}, []), null);
});

// --- Cross-turn tool pairing -------------------------------------------------
// Observed in a real call: ElevenLabs records tool_calls on the agent's turn
// and tool_results on a later turn. Pairing per-turn split every call into two
// orphan rows — an args-only row marked failed, and a result-only row.

test('pairs a tool call with a result on a later turn', () => {
  const executions = extractToolExecutions([
    {
      role: 'agent',
      message: 'Let me look that up.',
      tool_calls: [{ tool_name: 'lookup_claim', tool_call_id: 'c1', params_as_json: '{"claim_number":"CLM-2026-000456"}' }],
      tool_results: null,
    },
    {
      role: 'agent',
      message: '',
      tool_calls: null,
      tool_results: [{ tool_name: 'lookup_claim', tool_call_id: 'c1', result_value: { found: true }, is_error: false, tool_latency_secs: 0.464 }],
    },
  ]);

  assert.equal(executions.length, 1, 'one call plus its result is one execution');
  assert.equal(executions[0].success, true);
  assert.equal(executions[0].latencyMs, 464);
  assert.deepEqual(executions[0].args, { claim_number: 'CLM-2026-000456' });
});

test('keeps repeated calls to one tool in order', () => {
  // The caller gave the number without dashes, the agent retried with them.
  const executions = extractToolExecutions([
    { role: 'agent', message: '', tool_calls: [{ tool_name: 'lookup_claim', tool_call_id: 'a', params_as_json: '{"claim_number":"CLM2026000456"}' }], tool_results: null },
    { role: 'agent', message: '', tool_calls: null, tool_results: [{ tool_name: 'lookup_claim', tool_call_id: 'a', result_value: { found: false }, tool_latency_secs: 0.732 }] },
    { role: 'agent', message: '', tool_calls: [{ tool_name: 'lookup_claim', tool_call_id: 'b', params_as_json: '{"claim_number":"CLM-2026-000456"}' }], tool_results: null },
    { role: 'agent', message: '', tool_calls: null, tool_results: [{ tool_name: 'lookup_claim', tool_call_id: 'b', result_value: { found: true }, tool_latency_secs: 0.464 }] },
  ]);

  assert.equal(executions.length, 2, 'two calls, not four orphan rows');
  assert.deepEqual(executions[0].args, { claim_number: 'CLM2026000456' });
  assert.equal(executions[0].latencyMs, 732);
  assert.deepEqual(executions[1].args, { claim_number: 'CLM-2026-000456' });
  assert.equal(executions[1].latencyMs, 464);
});

test('a call whose result never arrives is recorded as failed', () => {
  const executions = extractToolExecutions([
    { role: 'agent', message: '', tool_calls: [{ tool_name: 'file_claim', tool_call_id: 'x' }], tool_results: null },
  ]);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].success, false);
  assert.equal(executions[0].latencyMs, null);
});

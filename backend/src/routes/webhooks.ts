import { FastifyInstance } from 'fastify';
import { config, features } from '../config/environment.js';
import { createCallLog, updateCallLog, logToolExecution } from '../services/call-log-service.js';
import { runEvidencePipeline } from '../services/evidence-pipeline.js';
import {
  verifySignature,
  extractToolExecutions,
  extractClaimId,
  extractCallerPhone,
  calculateDuration,
  deriveOutcome,
  mapDirection,
  resolveCustomerId,
  type ElevenLabsWebhookEnvelope,
  type ElevenLabsTranscriptionData,
} from '../services/elevenlabs-webhook.js';

export default async function webhooksRoutes(fastify: FastifyInstance) {
  fastify.post('/webhooks/elevenlabs/conversation-ended', {
    config: { rawBody: true },
  }, async (request, reply) => {
    const rawBody = (request as any).rawBody;
    const rawPayload =
      rawBody != null
        ? rawBody.toString()
        : typeof request.body === 'string'
          ? request.body
          : JSON.stringify(request.body ?? {});

    if (features.webhookSignatureVerification) {
      const header = (request.headers['elevenlabs-signature']
        || request.headers['x-elevenlabs-signature']) as string | undefined;

      const verdict = verifySignature(header, rawPayload, config.elevenlabsWebhookSecret!);
      if (!verdict.valid) {
        fastify.log.warn({ reason: verdict.reason }, 'Rejected ElevenLabs webhook');
        return reply.status(401).send({ success: false, error: 'Invalid webhook signature' });
      }
    } else if (features.webhookUnverifiedAccepted) {
      // Development only. Locally there is no secret to sign with, and refusing
      // here would make the post-call path untestable.
      fastify.log.warn(
        'Accepting ElevenLabs webhook WITHOUT signature verification — set ELEVENLABS_WEBHOOK_SECRET'
      );
    } else {
      // Production with no secret configured. This handler writes the call log,
      // the transcript and the tool-execution rows that make up the compliance
      // record, and kicks off an on-chain attestation of them — so an
      // unverifiable delivery is refused rather than believed. 503, not 401:
      // nothing the sender could do would help, the server is misconfigured.
      fastify.log.error(
        'Refused ElevenLabs webhook: ELEVENLABS_WEBHOOK_SECRET is not configured, so no delivery can be verified'
      );
      return reply.status(503).send({
        success: false,
        error: 'Webhook verification is not configured on this server.',
      });
    }

    let envelope: ElevenLabsWebhookEnvelope;
    try {
      envelope = JSON.parse(rawPayload);
    } catch {
      return reply.status(400).send({ success: false, error: 'Malformed JSON payload' });
    }

    try {
      switch (envelope.type) {
        case 'post_call_transcription':
          return reply.status(200).send(
            await handleTranscription(fastify, envelope.data as ElevenLabsTranscriptionData)
          );

        case 'call_initiation_failure':
          return reply.status(200).send(await handleInitiationFailure(fastify, envelope.data));

        case 'post_call_audio':
          // Audio payloads carry only base64 MP3; there is no configured object
          // store for recordings, so acknowledge without pretending to save it.
          fastify.log.info(
            { conversationId: envelope.data?.conversation_id },
            'Received post_call_audio — no recording store configured, skipping'
          );
          return reply.status(200).send({ success: true, stored: false });

        default:
          fastify.log.info({ type: envelope.type }, 'Ignoring unrecognized webhook type');
          return reply.status(200).send({ success: true, ignored: true });
      }
    } catch (error) {
      fastify.log.error(error, 'Error processing ElevenLabs webhook');
      return reply.status(500).send({ success: false, error: 'Failed to process webhook' });
    }
  });
}

async function handleTranscription(fastify: FastifyInstance, data: ElevenLabsTranscriptionData) {
  const transcript = data.transcript ?? [];
  const executions = extractToolExecutions(transcript);

  const { data: existing } = await fastify.supabase
    .from('call_logs')
    .select('id')
    .eq('elevenlabs_conversation_id', data.conversation_id)
    .maybeSingle();

  // Resolved before the insert, not after: a call log written without a
  // customer_id is a row the dashboard can only ever render as "Unknown", and
  // nothing later fills it in. The claim id is needed here too — for a browser
  // call it is the only identification there is — so it is extracted up front
  // and reused by the evidence pipeline below.
  const claimId = extractClaimId(data.analysis?.data_collection_results, executions);
  const callerPhone = extractCallerPhone(data);
  const customerId = await resolveCustomerId(fastify.supabase, { phone: callerPhone, claimId });

  if (!customerId) {
    // Worth knowing about: on a phone call it means a number we hold did not
    // match any customer row. On a webrtc call it is simply the truth.
    fastify.log.info(
      { conversationId: data.conversation_id, hasPhone: callerPhone != null },
      'Call log has no resolvable customer'
    );
  }

  const callLogData = {
    elevenlabs_conversation_id: data.conversation_id,
    direction: mapDirection(data),
    status: 'completed' as const,
    phone_number: callerPhone,
    duration_seconds: calculateDuration(data),
    transcript: transcript.map((turn) => ({
      role: turn.role,
      message: turn.message ?? '',
      ...(turn.time_in_call_secs != null
        ? { time_in_call_secs: turn.time_in_call_secs }
        : {}),
    })),
    summary: data.analysis?.transcript_summary ?? null,
    // What the agent actually did, falling back to ElevenLabs' verdict when the
    // tools say nothing. See deriveOutcome for why the action beats the verdict.
    outcome: deriveOutcome(data.analysis?.call_successful, executions),
    // Derived from tool calls that actually ran, not from substring-matching
    // the transcript text.
    tools_used: Array.from(new Set(executions.map((e) => e.toolName))),
    // Only written when we resolved one. A redelivered webhook whose caller we
    // can no longer identify must not blank out an attribution an earlier
    // delivery got right.
    ...(customerId ? { customer_id: customerId } : {}),
    analysis: data.analysis?.data_collection_results ?? null,
    evaluation: data.analysis?.evaluation_criteria_results ?? null,
    metadata: data.metadata ?? null,
    webhook_payload: data as any,
    ended_at: new Date().toISOString(),
  };

  const callLog = existing
    ? await updateCallLog(fastify.supabase, existing.id, callLogData)
    : await createCallLog(fastify.supabase, {
        ...callLogData,
        started_at: data.metadata?.start_time_unix_secs
          ? new Date(data.metadata.start_time_unix_secs * 1000).toISOString()
          : new Date().toISOString(),
      });

  // Replace rather than append, so a redelivered webhook does not duplicate rows.
  if (existing) {
    await fastify.supabase.from('call_tool_executions').delete().eq('call_log_id', callLog.id);
  }

  for (const execution of executions) {
    await logToolExecution(fastify.supabase, {
      call_log_id: callLog.id,
      tool_name: execution.toolName,
      tool_args: execution.args,
      tool_result: execution.result as any,
      success: execution.success,
      latency_ms: execution.latencyMs,
    });
  }

  // Archive evidence only for a claim that was genuinely filed during the call.
  if (claimId) {
    runEvidencePipeline(fastify, { claimId, callLogId: callLog.id }).catch((err) => {
      fastify.log.error({ err, claimId }, 'Background evidence pipeline failed');
    });
  }

  await fastify.supabase.channel('call-updates').send({
    type: 'broadcast',
    event: 'call-completed',
    payload: { call_log_id: callLog.id },
  });

  return { success: true, call_log_id: callLog.id, tool_executions: executions.length };
}

async function handleInitiationFailure(fastify: FastifyInstance, data: Record<string, any>) {
  // A call that never connected is still a call about somebody. We know the
  // number we dialled, so the row can name them rather than joining to nothing
  // and rendering as another anonymous "Unknown".
  const dialled: string | null =
    data.metadata?.body?.To ?? data.metadata?.body?.to_number ?? null;
  const customerId = await resolveCustomerId(fastify.supabase, { phone: dialled });

  const callLog = await createCallLog(fastify.supabase, {
    elevenlabs_conversation_id: data.conversation_id,
    direction: 'outbound',
    status: 'failed',
    phone_number: dialled,
    ...(customerId ? { customer_id: customerId } : {}),
    outcome: `initiation_failed: ${data.failure_reason ?? 'unknown'}`,
    summary: `Call could not be initiated (${data.failure_reason ?? 'unknown'}).`,
    metadata: data.metadata ?? null,
    webhook_payload: data as any,
    ended_at: new Date().toISOString(),
  });

  fastify.log.info(
    { conversationId: data.conversation_id, reason: data.failure_reason },
    'Recorded call initiation failure'
  );

  return { success: true, call_log_id: callLog.id };
}

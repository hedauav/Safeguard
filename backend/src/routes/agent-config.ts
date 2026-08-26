import crypto from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config, features } from '../config/environment.js';
import { AGENT_TOOLS } from '../config/agent-definition.js';
import {
  loadAgentSettings,
  saveAgentSettings,
  resetAgentSettings,
  markSynced,
  enabledTools,
  AgentSettingsValidationError,
  AgentSettingsUnavailableError,
} from '../services/agent-settings.js';
import { syncAgent, ElevenLabsAdminError } from '../services/elevenlabs-admin.js';

/** Public base URL this request arrived on, so tool URLs match reality. */
function publicBaseUrl(request: FastifyRequest): string {
  const proto =
    (request.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ??
    (config.nodeEnv === 'production' ? 'https' : 'http');
  const host =
    (request.headers['x-forwarded-host'] as string | undefined)?.split(',')[0] ??
    request.headers.host ??
    `localhost:${config.port}`;
  return `${proto}://${host}`;
}

/**
 * The token an Authorization header presents, with surrounding whitespace gone.
 *
 * Trimming is not tidiness. `Bearer ` is followed by whatever the operator
 * pasted, and a token copied out of a Railway variable, a terminal, or a
 * password manager routinely arrives with a trailing space or newline. Because
 * the comparison below has to check length before `timingSafeEqual`, one
 * invisible character turned a correct token into a 401 indistinguishable from
 * a wrong one — which is what made the dashboard's Save and Sync buttons fail
 * for an operator holding the right secret. The sibling guard in
 * `services/tools-token.ts` has always trimmed; this now matches it.
 *
 * Exported so the comparison can be tested without booting a server, and so
 * `adjudication-review.ts` shares this guard rather than keeping its own copy
 * of the same bug.
 */
export function bearerToken(header: string): string {
  const value = header.trim();
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

/**
 * Constant-time comparison of a presented token against the configured one.
 *
 * The length check has to come first because `timingSafeEqual` throws on
 * mismatched buffer lengths, and a thrown error would leak the secret's length
 * as surely as an early return would. The configured token is trimmed too: an
 * environment variable set with a trailing newline is otherwise unmatchable by
 * any token a caller could send, and no amount of care at the caller's end
 * would fix it.
 *
 * A secret that is empty *after* trimming matches nothing rather than matching
 * an empty bearer token — trimming must never turn a whitespace-only
 * ADMIN_TOKEN into a lock that opens for anyone who sends nothing.
 */
export function adminTokenMatches(provided: string, expected: string | null): boolean {
  const secret = (expected ?? '').trim();
  if (!secret) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Guard for the write endpoints.
 *
 * Fails closed: with no ADMIN_TOKEN configured these endpoints refuse rather
 * than falling open, because an unauthenticated write here would let anyone
 * rewrite the agent's prompt or re-point its tools at a server they control.
 */
function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!config.adminToken) {
    reply.code(503).send({
      data: null,
      error: 'Editing is disabled: ADMIN_TOKEN is not configured on the server.',
    });
    return false;
  }

  const provided = bearerToken(request.headers.authorization ?? '');
  if (!adminTokenMatches(provided, config.adminToken)) {
    reply.code(401).send({ data: null, error: 'Invalid or missing admin token.' });
    return false;
  }
  return true;
}

export default async function agentConfigRoutes(fastify: FastifyInstance) {
  /**
   * Turn an unreadable settings table into an answer rather than a stack trace.
   *
   * `loadAgentSettings` throws when the read itself failed, which is a
   * deployment problem — usually migration 0008 never applied. 503 says so:
   * the endpoint is unavailable because the server is misconfigured, not
   * because the caller asked for something wrong.
   */
  function reportUnavailable(err: unknown, reply: FastifyReply): { data: null; error: string } {
    fastify.log.error({ err }, 'Agent settings are unreadable');
    reply.code(err instanceof AgentSettingsUnavailableError ? 503 : 500);
    return {
      data: null,
      error: err instanceof Error ? err.message : 'Could not read agent settings.',
    };
  }

  // GET /agent-config — live definition, including operator overrides.
  fastify.get('/agent-config', async (request, reply) => {
    const baseUrl = publicBaseUrl(request);

    let settings;
    try {
      settings = await loadAgentSettings(fastify.supabase);
    } catch (err) {
      return reportUnavailable(err, reply);
    }
    const active = enabledTools(settings);

    return {
      data: {
        agent_name: settings.agentName,
        first_message: settings.firstMessage,
        system_prompt: settings.systemPrompt,
        customized: settings.customized,
        /**
         * A rename rewrites the shipped defaults but never a prompt the
         * operator wrote, so this says when their own text still introduces
         * the agent by another name. The dashboard warns; the edit stays
         * theirs to make.
         */
        custom_prompt_mentions_other_name: settings.customPromptMentionsOtherName,
        updated_at: settings.updatedAt,
        synced_at: settings.syncedAt,
        disabled_tools: settings.disabledTools,
        // Every tool, each flagged, so the dashboard can render toggles.
        //
        // A client tool has no URL to advertise: it runs in the caller's
        // browser and the agent hands it its arguments directly, so there is
        // no endpoint for anyone to call. Interpolating an absent `path` would
        // publish `https://host/undefined` — type-safe and silently wrong — so
        // the absence is stated as null rather than papered over.
        all_tools: AGENT_TOOLS.map((tool) => ({
          ...tool,
          url: tool.path ? `${baseUrl}${tool.path}` : null,
          enabled: !settings.disabledTools.includes(tool.name),
        })),
        // Only the enabled ones, for consumers that want the live set.
        tools: active.map((tool) => ({
          ...tool,
          url: tool.path ? `${baseUrl}${tool.path}` : null,
        })),
        integration: {
          base_url: baseUrl,
          webhook_url: `${baseUrl}/api/webhooks/elevenlabs/conversation-ended`,
          conversation_init_url: `${baseUrl}/api/elevenlabs/conversation-init`,
          elevenlabs_agent_id: config.elevenlabsAgentId,
        },
        mode: features.simulated ? 'simulation' : 'live',
        features: {
          webhook_signature_verification: features.webhookSignatureVerification,
          filecoin_uploads: features.filecoin && fastify.filecoin.synapse !== null,
          chain_attestation: features.attestation,
          eas_attestation: features.eas,
          simulated_archival: features.simulated,
          editing_enabled: features.agentConfigEditing,
          sync_enabled: features.agentConfigSync,
        },
      },
      error: null,
    };
  });

  // PUT /agent-config — save overrides. Does not touch ElevenLabs.
  fastify.put('/agent-config', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const body = request.body as {
      agent_name?: string;
      first_message?: string;
      system_prompt?: string;
      disabled_tools?: string[];
    };

    try {
      const settings = await saveAgentSettings(fastify.supabase, {
        agentName: body.agent_name,
        firstMessage: body.first_message,
        systemPrompt: body.system_prompt,
        disabledTools: body.disabled_tools,
      });

      fastify.log.info({ disabled: settings.disabledTools }, 'Agent settings updated');
      return {
        data: {
          agent_name: settings.agentName,
          first_message: settings.firstMessage,
          system_prompt: settings.systemPrompt,
          disabled_tools: settings.disabledTools,
          updated_at: settings.updatedAt,
          synced_at: settings.syncedAt,
        },
        error: null,
      };
    } catch (err) {
      if (err instanceof AgentSettingsValidationError) {
        reply.code(400);
        return { data: null, error: err.message };
      }
      // A write that landed and a table that cannot be read are different
      // problems with different fixes, so the operator is told which one.
      if (err instanceof AgentSettingsUnavailableError) {
        return reportUnavailable(err, reply);
      }
      fastify.log.error(err, 'Failed to save agent settings');
      reply.code(500);
      return { data: null, error: 'Could not save agent settings.' };
    }
  });

  // POST /agent-config/reset — drop overrides, back to shipped defaults.
  fastify.post('/agent-config/reset', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    let settings;
    try {
      settings = await resetAgentSettings(fastify.supabase);
    } catch (err) {
      return reportUnavailable(err, reply);
    }
    return {
      data: {
        agent_name: settings.agentName,
        first_message: settings.firstMessage,
        system_prompt: settings.systemPrompt,
        disabled_tools: settings.disabledTools,
      },
      error: null,
    };
  });

  // POST /agent-config/sync — push saved settings to ElevenLabs.
  fastify.post('/agent-config/sync', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    if (!features.agentConfigSync) {
      reply.code(503);
      return {
        data: null,
        error: 'Sync is unavailable: set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID on the server.',
      };
    }

    // Inside the try: an unreadable settings table must not surface as an
    // unhandled 500 on the button an operator presses to fix their config.
    try {
      const settings = await loadAgentSettings(fastify.supabase);
      const tools = enabledTools(settings);

      const result = await syncAgent(settings, tools, publicBaseUrl(request));
      await markSynced(fastify.supabase);

      fastify.log.info(result, 'Agent synced to ElevenLabs');
      return { data: result, error: null };
    } catch (err) {
      if (err instanceof AgentSettingsUnavailableError) return reportUnavailable(err, reply);
      const message = err instanceof Error ? err.message : String(err);
      fastify.log.error({ err }, 'Agent sync failed');
      reply.code(err instanceof ElevenLabsAdminError ? 502 : 500);
      return { data: null, error: message };
    }
  });
}

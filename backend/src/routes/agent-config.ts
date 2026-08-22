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

  const header = request.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

  const a = Buffer.from(provided);
  const b = Buffer.from(config.adminToken);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) {
    reply.code(401).send({ data: null, error: 'Invalid or missing admin token.' });
    return false;
  }
  return true;
}

export default async function agentConfigRoutes(fastify: FastifyInstance) {
  // GET /agent-config — live definition, including operator overrides.
  fastify.get('/agent-config', async (request) => {
    const baseUrl = publicBaseUrl(request);
    const settings = await loadAgentSettings(fastify.supabase);
    const active = enabledTools(settings);

    return {
      data: {
        agent_name: settings.agentName,
        first_message: settings.firstMessage,
        system_prompt: settings.systemPrompt,
        customized: settings.customized,
        updated_at: settings.updatedAt,
        synced_at: settings.syncedAt,
        disabled_tools: settings.disabledTools,
        // Every tool, each flagged, so the dashboard can render toggles.
        all_tools: AGENT_TOOLS.map((tool) => ({
          ...tool,
          url: `${baseUrl}${tool.path}`,
          enabled: !settings.disabledTools.includes(tool.name),
        })),
        // Only the enabled ones, for consumers that want the live set.
        tools: active.map((tool) => ({ ...tool, url: `${baseUrl}${tool.path}` })),
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
      fastify.log.error(err, 'Failed to save agent settings');
      reply.code(500);
      return { data: null, error: 'Could not save agent settings.' };
    }
  });

  // POST /agent-config/reset — drop overrides, back to shipped defaults.
  fastify.post('/agent-config/reset', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const settings = await resetAgentSettings(fastify.supabase);
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

    const settings = await loadAgentSettings(fastify.supabase);
    const tools = enabledTools(settings);

    try {
      const result = await syncAgent(settings, tools, publicBaseUrl(request));
      await markSynced(fastify.supabase);

      fastify.log.info(result, 'Agent synced to ElevenLabs');
      return { data: result, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fastify.log.error({ err }, 'Agent sync failed');
      reply.code(err instanceof ElevenLabsAdminError ? 502 : 500);
      return { data: null, error: message };
    }
  });
}

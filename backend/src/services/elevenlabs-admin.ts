import { config } from '../config/environment.js';
import type { AgentToolDefinition } from '../config/agent-definition.js';
import type { AgentSettings } from './agent-settings.js';

const EL = 'https://api.elevenlabs.io/v1';

export class ElevenLabsAdminError extends Error {}

export interface SyncResult {
  agentId: string;
  toolsCreated: number;
  toolsUpdated: number;
  toolsAttached: number;
  warnings: string[];
}

async function el(path: string, init: RequestInit = {}): Promise<any> {
  if (!config.elevenlabsApiKey) {
    throw new ElevenLabsAdminError(
      'ELEVENLABS_API_KEY is not configured on the server, so the agent cannot be synced.'
    );
  }

  const res = await fetch(`${EL}${path}`, {
    ...init,
    headers: {
      'xi-api-key': config.elevenlabsApiKey,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const detail =
      body?.detail?.message ?? (typeof body === 'string' ? body : JSON.stringify(body));
    throw new ElevenLabsAdminError(`ElevenLabs ${res.status}: ${String(detail).slice(0, 300)}`);
  }
  return body;
}

function requestBodySchema(tool: AgentToolDefinition) {
  const properties: Record<string, unknown> = {};
  for (const p of tool.parameters) {
    properties[p.name] = { type: p.type, description: p.description };
  }
  return {
    type: 'object',
    description: `Arguments for ${tool.name}`,
    properties,
    required: tool.parameters.filter((p) => p.required).map((p) => p.name),
  };
}

function toolConfigFor(tool: AgentToolDefinition, baseUrl: string) {
  return {
    type: 'webhook',
    name: tool.name,
    description: tool.description,
    response_timeout_secs: 20,
    api_schema: {
      url: `${baseUrl}${tool.path}`,
      method: tool.method,
      request_body_schema: requestBodySchema(tool),
    },
  };
}

/**
 * Push the current settings and enabled tools to the configured ElevenLabs agent.
 *
 * Reconciles by tool name so repeated syncs update rather than duplicate.
 * Disabled tools are simply left off the agent's tool_ids — their definitions
 * stay in the workspace so re-enabling does not require recreating them.
 */
export async function syncAgent(
  settings: AgentSettings,
  tools: AgentToolDefinition[],
  baseUrl: string
): Promise<SyncResult> {
  if (!config.elevenlabsAgentId) {
    throw new ElevenLabsAdminError('ELEVENLABS_AGENT_ID is not configured on the server.');
  }

  const warnings: string[] = [];

  const existing = await el('/convai/tools');
  const byName = new Map<string, string>();
  for (const t of existing?.tools ?? []) {
    const name = t.tool_config?.name ?? t.name;
    if (name) byName.set(name, t.id);
  }

  const toolIds: string[] = [];
  let created = 0;
  let updated = 0;

  for (const tool of tools) {
    const payload = { tool_config: toolConfigFor(tool, baseUrl) };
    const existingId = byName.get(tool.name);
    try {
      if (existingId) {
        await el(`/convai/tools/${existingId}`, { method: 'PATCH', body: JSON.stringify(payload) });
        toolIds.push(existingId);
        updated++;
      } else {
        const res = await el('/convai/tools', { method: 'POST', body: JSON.stringify(payload) });
        toolIds.push(res.id);
        created++;
      }
    } catch (err) {
      warnings.push(`${tool.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (toolIds.length === 0) {
    throw new ElevenLabsAdminError(
      `No tools could be configured, so the agent was left unchanged. ${warnings.join('; ')}`
    );
  }

  await el(`/convai/agents/${config.elevenlabsAgentId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: `SafeGuard Claims Agent (${settings.agentName})`,
      conversation_config: {
        agent: {
          prompt: { prompt: settings.systemPrompt, tool_ids: toolIds },
          first_message: settings.firstMessage,
          language: 'en',
        },
      },
    }),
  });

  return {
    agentId: config.elevenlabsAgentId,
    toolsCreated: created,
    toolsUpdated: updated,
    toolsAttached: toolIds.length,
    warnings,
  };
}

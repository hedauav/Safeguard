import { config } from '../config/environment.js';
import { TOOLS_TOKEN_HEADER } from './tools-token.js';
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

/**
 * The JSON schema describing a tool's arguments.
 *
 * One builder serves both tool types because ElevenLabs uses one shape for
 * both: a webhook tool's `api_schema.request_body_schema` and a client tool's
 * `parameters` are the same `ObjectJsonSchemaPropertyInput` in their API —
 * `{ type: 'object', description, properties, required }`. All that differs is
 * where the object hangs and what the agent does with it: serialise it as a
 * request body, or hand it to a function running in the caller's browser.
 */
function parameterSchema(tool: AgentToolDefinition) {
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
  // A client tool exists because a server tool's *result* never reaches the
  // browser. ElevenLabs' `agent_tool_response` event carries only the tool
  // name, its call id, its type, and whether it errored — there is no payload
  // field on it at all. So a payment link that offer_renewal returns cannot be
  // surfaced in the web widget by listening for the response; the only route is
  // a tool whose *arguments* the agent fills in and whose body runs in the
  // page, which is what show_payment_link is for.
  //
  // Such a tool has no URL and no request, so it gets no `api_schema`: there
  // would be nothing to put in one. It gets no auth header either — the header
  // exists to prove a call reached our backend from ElevenLabs, and a client
  // tool never touches our backend. Sending the shared secret anyway would
  // publish it to whoever holds the conversation socket in exchange for
  // nothing. No `response_timeout_secs` either: nothing is awaited.
  //
  // Branching on `toolType` rather than on whether a path happens to be set:
  // the client variant declares `path?: undefined` instead of omitting it, so
  // the key's absence proves nothing and `tool.path` type-checks either way.
  // The discriminator is the only thing that actually distinguishes the two,
  // and testing it here is also what narrows `tool` to the webhook variant
  // below, where `path` and `method` are guaranteed present.
  if (tool.toolType === 'client') {
    return {
      type: 'client',
      name: tool.name,
      description: tool.description,
      // `parameters`, not `request_body_schema` — same schema shape, different
      // field, because there is no request body to describe. Getting this wrong
      // registers a tool the agent can see but cannot pass arguments to.
      parameters: parameterSchema(tool),
    };
  }

  return {
    type: 'webhook',
    name: tool.name,
    description: tool.description,
    response_timeout_secs: 20,
    api_schema: {
      url: `${baseUrl}${tool.path}`,
      method: tool.method,
      request_body_schema: parameterSchema(tool),
      // The shared secret travels with every tool call the agent makes. Synced
      // from here rather than pasted into the ElevenLabs console, so turning
      // TOOLS_API_TOKEN on does not silently leave the live agent locked out.
      // Omitted entirely when unset, so a sync never writes an empty header.
      ...(config.toolsApiToken
        ? { request_headers: { [TOOLS_TOKEN_HEADER]: config.toolsApiToken } }
        : {}),
    },
  };
}

/**
 * Push the current settings and enabled tools to the configured ElevenLabs agent.
 *
 * Reconciles by tool name so repeated syncs update rather than duplicate.
 * Disabled tools are simply left off the agent's tool_ids — their definitions
 * stay in the workspace so re-enabling does not require recreating them.
 *
 * Client and webhook tools travel this path identically and on purpose. One
 * `/convai/tools` collection holds both, the listing reports both under
 * `tool_config.name`, and the agent attaches both by plain id — so the kind of
 * a tool is decided once, in `toolConfigFor`, and nothing downstream of it has
 * to branch. The one case that is not interchangeable is changing an existing
 * tool's kind under a name already registered as the other: ElevenLabs may
 * refuse that PATCH. It surfaces as a per-tool warning and the rest of the sync
 * still lands, which is the right failure — the fix is to delete the tool in
 * the workspace and re-sync, not to have this function guess.
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

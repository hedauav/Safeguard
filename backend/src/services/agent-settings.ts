import type { SupabaseClient } from '@supabase/supabase-js';
import {
  SYSTEM_PROMPT,
  FIRST_MESSAGE,
  AGENT_TOOLS,
  type AgentToolDefinition,
} from '../config/agent-definition.js';

export interface AgentSettings {
  agentName: string;
  firstMessage: string;
  systemPrompt: string;
  /** Tool names the operator has switched off. */
  disabledTools: string[];
  syncedAt: string | null;
  updatedAt: string | null;
  /** True when any field differs from the shipped defaults. */
  customized: boolean;
}

export interface AgentSettingsInput {
  agentName?: string;
  firstMessage?: string;
  systemPrompt?: string;
  disabledTools?: string[];
}

const DEFAULTS = {
  agentName: 'Anish',
  firstMessage: FIRST_MESSAGE,
  systemPrompt: SYSTEM_PROMPT,
};

/**
 * Current effective settings: stored overrides layered over the shipped
 * defaults. A missing row or a null column means "use the default", so the
 * table only ever holds deliberate changes.
 */
export async function loadAgentSettings(supabase: SupabaseClient): Promise<AgentSettings> {
  const { data, error } = await supabase
    .from('agent_settings')
    .select('agent_name, first_message, system_prompt, disabled_tools, synced_at, updated_at')
    .eq('id', 1)
    .maybeSingle();

  if (error || !data) {
    return { ...DEFAULTS, disabledTools: [], syncedAt: null, updatedAt: null, customized: false };
  }

  const agentName = data.agent_name ?? DEFAULTS.agentName;
  const firstMessage = data.first_message ?? DEFAULTS.firstMessage;
  const systemPrompt = data.system_prompt ?? DEFAULTS.systemPrompt;
  const disabledTools: string[] = data.disabled_tools ?? [];

  return {
    agentName,
    firstMessage,
    systemPrompt,
    disabledTools,
    syncedAt: data.synced_at ?? null,
    updatedAt: data.updated_at ?? null,
    customized:
      agentName !== DEFAULTS.agentName ||
      firstMessage !== DEFAULTS.firstMessage ||
      systemPrompt !== DEFAULTS.systemPrompt ||
      disabledTools.length > 0,
  };
}

export class AgentSettingsValidationError extends Error {}

/**
 * Validate and persist overrides.
 *
 * Rejects an empty prompt and unknown tool names: silently accepting either
 * would leave the agent in a state the operator did not intend, and an unknown
 * tool name usually means a typo that would otherwise disable nothing.
 */
export async function saveAgentSettings(
  supabase: SupabaseClient,
  input: AgentSettingsInput
): Promise<AgentSettings> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (input.systemPrompt !== undefined) {
    const prompt = input.systemPrompt.trim();
    if (prompt.length < 20) {
      throw new AgentSettingsValidationError(
        'The system prompt is too short to be useful — give the agent at least a sentence of instruction.'
      );
    }
    if (prompt.length > 20000) {
      throw new AgentSettingsValidationError('The system prompt exceeds 20,000 characters.');
    }
    patch.system_prompt = prompt;
  }

  if (input.firstMessage !== undefined) {
    const message = input.firstMessage.trim();
    if (!message) {
      throw new AgentSettingsValidationError('The first message cannot be empty.');
    }
    if (message.length > 1000) {
      throw new AgentSettingsValidationError('The first message exceeds 1,000 characters.');
    }
    patch.first_message = message;
  }

  if (input.agentName !== undefined) {
    const name = input.agentName.trim();
    if (!name) throw new AgentSettingsValidationError('The agent name cannot be empty.');
    if (name.length > 60) throw new AgentSettingsValidationError('The agent name is too long.');
    patch.agent_name = name;
  }

  if (input.disabledTools !== undefined) {
    const known = new Set(AGENT_TOOLS.map((t) => t.name));
    const unknown = input.disabledTools.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new AgentSettingsValidationError(`Unknown tool name(s): ${unknown.join(', ')}`);
    }
    if (input.disabledTools.length >= AGENT_TOOLS.length) {
      throw new AgentSettingsValidationError(
        'At least one tool must stay enabled, or the agent cannot look anything up.'
      );
    }
    patch.disabled_tools = Array.from(new Set(input.disabledTools));
  }

  const { error } = await supabase.from('agent_settings').update(patch).eq('id', 1);
  if (error) {
    throw new Error(`Could not save agent settings: ${error.message}`);
  }

  return loadAgentSettings(supabase);
}

/** Record that the current settings were pushed to ElevenLabs. */
export async function markSynced(supabase: SupabaseClient): Promise<void> {
  await supabase.from('agent_settings').update({ synced_at: new Date().toISOString() }).eq('id', 1);
}

/** Restore the shipped defaults by clearing every override. */
export async function resetAgentSettings(supabase: SupabaseClient): Promise<AgentSettings> {
  await supabase
    .from('agent_settings')
    .update({
      agent_name: null,
      first_message: null,
      system_prompt: null,
      disabled_tools: [],
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);
  return loadAgentSettings(supabase);
}

/** Tools currently enabled, in their defined order. */
export function enabledTools(settings: AgentSettings): AgentToolDefinition[] {
  return AGENT_TOOLS.filter((tool) => !settings.disabledTools.includes(tool.name));
}

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_AGENT_NAME,
  systemPromptFor,
  firstMessageFor,
  introducedName,
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
  /**
   * True when a prompt or greeting the operator wrote by hand still introduces
   * the agent under some other name. Advisory only — see `introducedName`.
   */
  customPromptMentionsOtherName: boolean;
}

export interface AgentSettingsInput {
  agentName?: string;
  firstMessage?: string;
  systemPrompt?: string;
  disabledTools?: string[];
}

/**
 * A read of `agent_settings` that failed for a reason other than "there is no
 * override row yet".
 *
 * Kept distinct because those two states used to look identical: a missing
 * table or an RLS refusal returned the shipped defaults, so a deployment where
 * migration 0008 had never been applied rendered exactly like a fresh one, and
 * every save into it appeared to work and then vanished. A read that failed
 * has to say so.
 */
export class AgentSettingsUnavailableError extends Error {}

/** The shipped settings for an agent of the given name. */
function defaultsFor(agentName: string) {
  return {
    agentName,
    firstMessage: firstMessageFor(agentName),
    systemPrompt: systemPromptFor(agentName),
  };
}

/**
 * Current effective settings: stored overrides layered over the shipped
 * defaults. A null column means "use the default", so the table only ever
 * holds deliberate changes.
 *
 * The defaults are computed from the stored `agent_name`, not from a fixed
 * string. That is what makes a rename audible: an operator who has never
 * touched the prompt gets one that introduces the agent by the name they
 * chose, while an operator who *has* edited the prompt keeps their own text
 * untouched and is warned instead.
 *
 * Throws rather than falling back when the read itself fails. An absent row is
 * "no overrides yet"; an absent table or a refused select is a broken
 * deployment, and returning defaults for it hides the breakage behind a screen
 * that looks fine.
 */
export async function loadAgentSettings(supabase: SupabaseClient): Promise<AgentSettings> {
  const { data, error } = await supabase
    .from('agent_settings')
    .select('agent_name, first_message, system_prompt, disabled_tools, synced_at, updated_at')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    throw new AgentSettingsUnavailableError(
      `Could not read agent settings: ${error.message}. If this deployment has never run migration 0008, apply it.`
    );
  }

  if (!data) {
    return {
      ...defaultsFor(DEFAULT_AGENT_NAME),
      disabledTools: [],
      syncedAt: null,
      updatedAt: null,
      customized: false,
      customPromptMentionsOtherName: false,
    };
  }

  const agentName = data.agent_name ?? DEFAULT_AGENT_NAME;
  const defaults = defaultsFor(agentName);
  const firstMessage = data.first_message ?? defaults.firstMessage;
  const systemPrompt = data.system_prompt ?? defaults.systemPrompt;
  const disabledTools: string[] = data.disabled_tools ?? [];

  // Only text the operator actually stored is examined. A default rendered a
  // moment ago always agrees with the name it was rendered from, so including
  // it could only produce a warning about our own template.
  const handWritten = [data.system_prompt, data.first_message].filter(
    (text): text is string => typeof text === 'string' && text.length > 0
  );

  return {
    agentName,
    firstMessage,
    systemPrompt,
    disabledTools,
    syncedAt: data.synced_at ?? null,
    updatedAt: data.updated_at ?? null,
    customized:
      agentName !== DEFAULT_AGENT_NAME ||
      firstMessage !== defaults.firstMessage ||
      systemPrompt !== defaults.systemPrompt ||
      disabledTools.length > 0,
    customPromptMentionsOtherName: handWritten.some((text) => {
      const named = introducedName(text);
      return named !== null && named.toLowerCase() !== agentName.toLowerCase();
    }),
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

  // Upsert, not update. `update(...).eq('id', 1)` against an empty table
  // matches zero rows and PostgREST reports no error for that, so the save
  // returned success, the reload returned the defaults, and the dashboard said
  // "Saved" while the field it had just written reverted in front of the
  // operator. Migration 0008 seeds row 1, but a database restored without its
  // seed data, or one where the row was deleted, is exactly the case that
  // produced the bug — so the write creates the row it needs.
  const { error } = await supabase
    .from('agent_settings')
    .upsert({ id: 1, ...patch }, { onConflict: 'id' });
  if (error) {
    throw new Error(`Could not save agent settings: ${error.message}`);
  }

  return loadAgentSettings(supabase);
}

/** Record that the current settings were pushed to ElevenLabs. */
export async function markSynced(supabase: SupabaseClient): Promise<void> {
  // Upsert for the same reason as the save: with no row to update this wrote
  // nothing and reported nothing, and the dashboard went on showing "never
  // synced" after a sync that had actually reached ElevenLabs.
  await supabase
    .from('agent_settings')
    .upsert({ id: 1, synced_at: new Date().toISOString() }, { onConflict: 'id' });
}

/** Restore the shipped defaults by clearing every override. */
export async function resetAgentSettings(supabase: SupabaseClient): Promise<AgentSettings> {
  await supabase.from('agent_settings').upsert(
    {
      id: 1,
      agent_name: null,
      first_message: null,
      system_prompt: null,
      disabled_tools: [],
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );
  return loadAgentSettings(supabase);
}

/** Tools currently enabled, in their defined order. */
export function enabledTools(settings: AgentSettings): AgentToolDefinition[] {
  return AGENT_TOOLS.filter((tool) => !settings.disabledTools.includes(tool.name));
}

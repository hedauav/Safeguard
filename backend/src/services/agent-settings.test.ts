import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  loadAgentSettings,
  saveAgentSettings,
  resetAgentSettings,
  markSynced,
  AgentSettingsUnavailableError,
  AgentSettingsValidationError,
} from './agent-settings.js';
import { DEFAULT_AGENT_NAME } from '../config/agent-definition.js';

// --- Test doubles -----------------------------------------------------------

interface FakeState {
  /** The single `agent_settings` row, or null for a table with no row in it. */
  row: Record<string, any> | null;
  /** Injected faults, so a broken table can be told apart from an empty one. */
  readError: any;
  writeError: any;
  /** Every upsert payload, so the fixed row id can be asserted on. */
  writes: Array<{ payload: Record<string, any>; options: any }>;
}

function state(overrides: Partial<FakeState> = {}): FakeState {
  return { row: null, readError: null, writeError: null, writes: [], ...overrides };
}

/**
 * Minimal PostgREST stand-in for the one table this service touches.
 *
 * `upsert` merges into the stored row rather than replacing it, which is what
 * ON CONFLICT DO UPDATE does: columns absent from the payload keep the values
 * already in the row. A fake that replaced instead would let a save that drops
 * an untouched column pass its test.
 */
function fakeSupabase(s: FakeState): SupabaseClient {
  return {
    from(table: string) {
      assert.equal(table, 'agent_settings');
      return {
        select() {
          return {
            eq() {
              return this;
            },
            async maybeSingle() {
              if (s.readError) return { data: null, error: s.readError };
              return { data: s.row, error: null };
            },
          };
        },
        async upsert(payload: Record<string, any>, options: any) {
          s.writes.push({ payload, options });
          if (s.writeError) return { data: null, error: s.writeError };
          s.row = { id: 1, disabled_tools: [], ...s.row, ...payload };
          return { data: null, error: null };
        },
      };
    },
  } as unknown as SupabaseClient;
}

// --- A save that used to vanish ---------------------------------------------

test('a save into a table with no row creates the row instead of reverting', async () => {
  // The original bug: update().eq('id', 1) matched zero rows, PostgREST
  // reported no error for that, so the route answered "Saved" and the reload
  // handed back the shipped defaults — the field reverted in front of whoever
  // had just typed it.
  const s = state({ row: null });
  const settings = await saveAgentSettings(fakeSupabase(s), { agentName: 'Priya' });

  assert.equal(settings.agentName, 'Priya');
  assert.notEqual(s.row, null);
  assert.equal(s.row?.agent_name, 'Priya');
});

test('the save targets the fixed single row', async () => {
  const s = state();
  await saveAgentSettings(fakeSupabase(s), { agentName: 'Priya' });

  assert.equal(s.writes.length, 1);
  assert.equal(s.writes[0].payload.id, 1);
  assert.deepEqual(s.writes[0].options, { onConflict: 'id' });
});

test('saving one field leaves the others as they were stored', async () => {
  const custom = 'You are Priya, a voice assistant for SafeGuard Insurance and nothing else.';
  const s = state({ row: { id: 1, system_prompt: custom, disabled_tools: ['settle_claim'] } });

  const settings = await saveAgentSettings(fakeSupabase(s), { agentName: 'Priya' });

  assert.equal(settings.systemPrompt, custom);
  assert.deepEqual(settings.disabledTools, ['settle_claim']);
});

test('a write that genuinely failed is reported, not swallowed', async () => {
  const s = state({ writeError: { message: 'permission denied for table agent_settings' } });
  await assert.rejects(() => saveAgentSettings(fakeSupabase(s), { agentName: 'Priya' }), /permission denied/);
});

test('sync and reset write to the same row rather than a no-op update', async () => {
  // markSynced had the same defect: with no row it wrote nothing and reported
  // nothing, so the dashboard kept saying "never synced" after a sync that had
  // actually reached ElevenLabs.
  const synced = state({ row: null });
  await markSynced(fakeSupabase(synced));
  assert.equal(synced.writes[0].payload.id, 1);
  assert.ok(synced.row?.synced_at);

  const reset = state({ row: { id: 1, agent_name: 'Priya', system_prompt: 'a hand-written prompt' } });
  const settings = await resetAgentSettings(fakeSupabase(reset));
  assert.equal(reset.writes[0].payload.id, 1);
  assert.equal(settings.agentName, DEFAULT_AGENT_NAME);
});

// --- A read that used to lie ------------------------------------------------

test('an absent row still means "no overrides yet"', async () => {
  const settings = await loadAgentSettings(fakeSupabase(state({ row: null })));

  assert.equal(settings.agentName, DEFAULT_AGENT_NAME);
  assert.equal(settings.customized, false);
  assert.equal(settings.customPromptMentionsOtherName, false);
  assert.deepEqual(settings.disabledTools, []);
  assert.equal(settings.syncedAt, null);
});

test('a failed read is an error, not an empty settings table', async () => {
  // A missing table or a refused select used to return the shipped defaults,
  // which rendered identically to a fresh install — so a deployment that had
  // never run migration 0008 looked fine and lost every save.
  const s = state({ readError: { code: 'PGRST205', message: 'Could not find the table' } });
  await assert.rejects(
    () => loadAgentSettings(fakeSupabase(s)),
    (err: unknown) => err instanceof AgentSettingsUnavailableError
  );
});

// --- A rename the caller can hear -------------------------------------------

test('renaming the agent changes the prompt and the greeting', async () => {
  const s = state({ row: { id: 1, agent_name: 'Priya' } });
  const settings = await loadAgentSettings(fakeSupabase(s));

  assert.match(settings.systemPrompt, /^You are Priya, a voice assistant/);
  assert.match(settings.firstMessage, /^Hi, this is Priya from SafeGuard/);
  assert.ok(!settings.systemPrompt.includes(DEFAULT_AGENT_NAME));
  assert.equal(settings.customized, true);
});

test('the shipped defaults are unchanged for an agent nobody has renamed', async () => {
  const settings = await loadAgentSettings(fakeSupabase(state({ row: { id: 1 } })));

  assert.match(settings.systemPrompt, /^You are Anish, a voice assistant/);
  assert.match(settings.firstMessage, /^Hi, this is Anish from SafeGuard/);
  assert.equal(settings.customized, false);
});

test('a prompt the operator wrote by hand is never rewritten by a rename', async () => {
  // Substituting a name into a stored prompt is how a system prompt gets
  // corrupted in a way nobody notices until a call goes wrong. It stays theirs,
  // byte for byte, and the mismatch is reported instead.
  const custom = 'You are Anish, and you only ever discuss windshield claims.';
  const s = state({ row: { id: 1, agent_name: 'Priya', system_prompt: custom } });

  const settings = await loadAgentSettings(fakeSupabase(s));

  assert.equal(settings.systemPrompt, custom);
  assert.equal(settings.customPromptMentionsOtherName, true);
});

test('a hand-written greeting under the old name is flagged too', async () => {
  const s = state({
    row: { id: 1, agent_name: 'Priya', first_message: 'Hi, this is Anish from SafeGuard.' },
  });
  const settings = await loadAgentSettings(fakeSupabase(s));
  assert.equal(settings.customPromptMentionsOtherName, true);
});

test('no warning when the hand-written prompt already uses the current name', async () => {
  const s = state({
    row: {
      id: 1,
      agent_name: 'Priya',
      system_prompt: 'You are Priya, and you only ever discuss windshield claims.',
      first_message: 'Hi, this is Priya from SafeGuard.',
    },
  });
  const settings = await loadAgentSettings(fakeSupabase(s));
  assert.equal(settings.customPromptMentionsOtherName, false);
});

test('no warning from a default the rename just rendered', async () => {
  // The defaults always agree with the name they were rendered from, so
  // including them could only ever warn about our own template.
  const s = state({ row: { id: 1, agent_name: 'Priya' } });
  const settings = await loadAgentSettings(fakeSupabase(s));
  assert.equal(settings.customPromptMentionsOtherName, false);
});

test('a custom prompt that introduces nobody is not flagged', async () => {
  // A warning that lights up on every prompt that happens to name the company
  // is a warning nobody reads.
  const s = state({
    row: {
      id: 1,
      agent_name: 'Priya',
      system_prompt: 'You are a voice assistant for SafeGuard Insurance. Be brief.',
    },
  });
  const settings = await loadAgentSettings(fakeSupabase(s));
  assert.equal(settings.customPromptMentionsOtherName, false);
});

// --- Validation is unchanged ------------------------------------------------

test('an empty name and an unknown tool are still refused before any write', async () => {
  const s = state();
  await assert.rejects(
    () => saveAgentSettings(fakeSupabase(s), { agentName: '   ' }),
    (err: unknown) => err instanceof AgentSettingsValidationError
  );
  await assert.rejects(
    () => saveAgentSettings(fakeSupabase(s), { disabledTools: ['no_such_tool'] }),
    (err: unknown) => err instanceof AgentSettingsValidationError
  );
  assert.equal(s.writes.length, 0);
});

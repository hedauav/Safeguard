-- ============================================
-- Migration 0008: editable agent settings
--
-- Stores dashboard overrides for the voice agent's prompt, greeting, and which
-- tools are enabled. The backend's agent-definition.ts remains the default;
-- this table only holds what an operator has deliberately changed, so an empty
-- table means "use the shipped defaults".
--
-- Single row, id fixed at 1.
-- ============================================

CREATE TABLE IF NOT EXISTS agent_settings (
  id             SMALLINT PRIMARY KEY DEFAULT 1,
  agent_name     TEXT,
  first_message  TEXT,
  system_prompt  TEXT,
  -- Tool names the operator has switched off. Tools absent here are enabled.
  disabled_tools TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Last time these settings were pushed to ElevenLabs, if ever.
  synced_at      TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_settings_single_row CHECK (id = 1)
);

INSERT INTO agent_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Operators read the current config through the backend, which uses the service
-- role key; the dashboard reads it via the API too. No anon policy is added,
-- so the prompt is not world-readable straight out of the database.
ALTER TABLE agent_settings ENABLE ROW LEVEL SECURITY;

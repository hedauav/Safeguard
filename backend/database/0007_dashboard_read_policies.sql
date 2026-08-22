-- ============================================
-- Migration 0007: read-only access for the dashboard
--
-- The React dashboard reads Supabase directly from the browser for the
-- Blockchain page and for realtime claim/call subscriptions. With RLS enabled
-- and no policies, those queries return an empty set with no error, so the UI
-- renders as "no data" rather than failing visibly.
--
-- These policies grant SELECT only. No INSERT/UPDATE/DELETE policy exists, so
-- the publishable key still cannot modify anything; all writes go through the
-- backend, which uses the service role key.
--
-- SCOPE NOTE: this makes the seeded claim data readable by anyone holding the
-- publishable key, which is embedded in the client bundle and therefore public.
-- That matches the backend's existing /api/claims endpoint, which is also
-- unauthenticated. Before putting real policyholder data in this database,
-- add authentication and replace these blanket policies with per-user rules.
-- ============================================

DO $$
DECLARE
  t text;
  readable_tables text[] := ARRAY[
    'customers', 'policies', 'claims', 'call_logs', 'call_tool_executions',
    'escalations', 'scheduled_callbacks',
    'agent_registrations', 'filecoin_uploads', 'evidence_bundles'
  ];
BEGIN
  FOREACH t IN ARRAY readable_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'dashboard_read_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO anon, authenticated USING (true)',
      'dashboard_read_' || t, t
    );
  END LOOP;
END $$;

-- Realtime delivers row changes only for tables in this publication.
DO $$
DECLARE
  t text;
  realtime_tables text[] := ARRAY['claims', 'call_logs'];
BEGIN
  FOREACH t IN ARRAY realtime_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', t);
    END IF;
  END LOOP;
END $$;

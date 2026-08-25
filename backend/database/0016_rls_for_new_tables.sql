-- ============================================
-- Migration 0016: row-level security for policy_renewals and claim_documents
--
-- 0007 enabled RLS on the ten tables that existed then. policy_renewals (0012)
-- and claim_documents (0013) arrived afterwards and were never added, so both
-- shipped with RLS off. In Supabase that is not "no policies, no access" — a
-- table without RLS is fully readable AND writable through PostgREST by the
-- anon key, and that key is embedded in the shipped frontend bundle. Anyone
-- with the dashboard URL could read every renewal payment link, its short_url
-- and amount, and every document content hash — and insert or delete rows.
--
-- WHY NO ANON SELECT POLICY HERE:
-- 0007 granted anon SELECT because the dashboard queries those tables directly
-- from the browser (the Blockchain page and the realtime claim/call
-- subscriptions). Neither of these two tables is read that way: the only
-- client-side Supabase reads in the frontend are `claims` (Blockchain.tsx,
-- useRealtimeClaims.ts), and every access to policy_renewals and
-- claim_documents goes through the backend, which holds the service role key
-- and bypasses RLS entirely (renewal-service.ts, claim-documents-service.ts,
-- evidence-pipeline.ts, webhook-tools.ts). Granting anon SELECT would publish
-- payment links and document hashes to buy nothing.
--
-- So these follow agent_settings (0008), not 0007: RLS on, no policy at all.
-- With RLS enabled and zero policies the anon and authenticated roles get
-- nothing — no SELECT, no INSERT, no UPDATE, no DELETE — while the service
-- role continues to work unchanged. If the dashboard ever needs to render
-- renewals or documents in the browser, add a scoped SELECT policy then, and
-- weigh publishing short_url and content_hash before you do.
--
-- Additive and idempotent. Safe to re-run.
-- ============================================

DO $$
DECLARE
  t text;
  -- RLS on, deliberately no anon/authenticated policy. See header.
  protected_tables text[] := ARRAY['policy_renewals', 'claim_documents'];
BEGIN
  FOREACH t IN ARRAY protected_tables LOOP
    IF EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);

      -- Defensive: if an earlier hand-run of this file, or a copy of 0007's
      -- loop, ever created a blanket read policy on these tables, drop it.
      -- Leaving one behind would silently undo the whole point of this
      -- migration, and re-running must converge on "no policy".
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'dashboard_read_' || t, t);
    END IF;
  END LOOP;
END $$;

-- Neither table is streamed to the browser, so neither is added to the
-- supabase_realtime publication. Publication membership is not gated by RLS in
-- the way table reads are; adding them would be a second, separate exposure.

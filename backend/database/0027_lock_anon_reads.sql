-- ============================================
-- Migration 0027: close the second door
--
-- Migration 0007 granted the anon role a blanket SELECT on ten tables so the
-- browser could query Supabase directly for the Blockchain page and the
-- realtime claim/call subscriptions. Its own header said what that cost, and
-- said it plainly: "this makes the seeded claim data readable by anyone
-- holding the publishable key, which is embedded in the client bundle and
-- therefore public... Before putting real policyholder data in this database,
-- add authentication and replace these blanket policies with per-user rules."
--
-- The authentication now exists. Every adjuster-facing read on the API is
-- behind a shared dashboard password (services/dashboard-session.ts,
-- plugins/dashboard-auth.ts), and the one page that still read Supabase from
-- the browser — Blockchain.tsx, against `claims` — has been repointed at
-- GET /api/claims/evidence-records, which sits behind that same password. The
-- realtime subscriptions 0007 also cited were removed from the frontend some
-- time ago and there are none left anywhere in it.
--
-- So the policies are the last thing holding the second door open. A password
-- on the API secures nothing at all while the same rows can be read straight
-- out of PostgREST with a key that ships in the JavaScript: customers, their
-- policies, every claim, every call log with its transcript, every escalation
-- and every scheduled callback. This drops them.
--
-- WHY DROP AND NOT NARROW:
-- 0007's alternative was per-user rules, which presumes users. This deployment
-- has one operator role and no user table, and there is no `auth.uid()` to
-- scope a policy by. A policy that cannot name who is asking cannot express
-- anything narrower than "everyone", so the honest replacement for "everyone"
-- is nothing — RLS on, zero policies, which is what 0008 did for
-- agent_settings and 0016 did for policy_renewals and claim_documents. The
-- backend holds the service role key and bypasses RLS entirely, so every read
-- the dashboard performs continues to work, now through an endpoint that asks
-- who is calling.
--
-- WHAT THIS DOES NOT TOUCH:
-- The `supabase_realtime` publication membership 0007 added for `claims` and
-- `call_logs` is left as it is. Publication membership is not itself a read
-- grant — Supabase Realtime applies RLS to the rows it would deliver, so with
-- no SELECT policy an anon subscriber receives nothing. Removing tables from a
-- publication is a separate change with its own failure mode (a later feature
-- silently receiving no events), and it is not needed to close this door.
--
-- Idempotent and safe to re-run, in 0007's own style: RLS is asserted rather
-- than assumed, and DROP POLICY IF EXISTS converges on "no policy" whether the
-- policy is there or not. Running this twice, or running it on a database
-- where 0007 was never applied, leaves the same state either way.
--
-- TO UNDO: re-run 0007_dashboard_read_policies.sql. Read its SCOPE NOTE first,
-- and know that doing so republishes every table listed below to anyone
-- holding the publishable key.
-- ============================================

DO $$
DECLARE
  t text;
  -- The same ten tables 0007 opened, in the same order, so the two files can be
  -- read side by side and the correspondence checked by eye.
  readable_tables text[] := ARRAY[
    'customers', 'policies', 'claims', 'call_logs', 'call_tool_executions',
    'escalations', 'scheduled_callbacks',
    'agent_registrations', 'filecoin_uploads', 'evidence_bundles'
  ];
BEGIN
  FOREACH t IN ARRAY readable_tables LOOP
    IF EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t
    ) THEN
      -- Asserted, not assumed. Dropping the policy off a table whose RLS had
      -- somehow been switched back off would leave it MORE readable than
      -- before, not less: without RLS, PostgREST hands the anon role the whole
      -- table and no policy is consulted at all.
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'dashboard_read_' || t, t);
    END IF;
  END LOOP;
END $$;

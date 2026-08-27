-- ============================================
-- Migration 0023: the revoke in 0022 was a no-op — actually close it
--
-- 0022 added `filecoin_uploads.error` and, in its own words, kept it away from
-- the browser with:
--
--     REVOKE SELECT (error) ON filecoin_uploads FROM anon, authenticated;
--
-- That statement ran without error and did nothing. From the PostgreSQL REVOKE
-- documentation, second half of the sentence that matters:
--
--     "When revoking privileges on a table, the corresponding column
--      privileges (if any) are automatically revoked on each column of the
--      table, as well. On the other hand, if a role has been granted
--      privileges on a table, then revoking the same privileges from
--      individual columns will have no effect."
--
-- A column-level REVOKE cannot subtract from a table-level GRANT. Supabase's
-- project defaults hand anon and authenticated a table-wide
-- `GRANT ALL ON ALL TABLES IN SCHEMA public`, so 0022 removed a column grant
-- that had never been issued and left the whole-table SELECT standing. The
-- guarded DO block reported success because there was nothing for it to fail
-- at.
--
-- VERIFIED AGAINST THE LIVE DATABASE, using the publishable key out of
-- frontend/.env — the same key compiled into the browser bundle:
--
--   GET /rest/v1/filecoin_uploads?select=error       -> HTTP 200 (not 42501)
--   GET /rest/v1/filecoin_uploads?order=error.desc   -> HTTP 200
--   GET /rest/v1/filecoin_uploads?error=not.is.null  -> HTTP 200
--
-- The last two are the conclusive ones: PostgREST can only order or filter on
-- a column the calling role holds SELECT on. The key was confirmed to really
-- be the anon role and not a service key in disguise — policy_renewals,
-- claim_documents and agent_settings all return [] on it and return rows on
-- the service key.
--
-- NOTHING HAS LEAKED. Every `error` in the live table is NULL, and the
-- deployed API (0b0f7a3) predates the code that writes the column at all. The
-- exposure opens on the next deploy of this branch, and the first Synapse
-- failure it captures is expected to carry the agent wallet address and the
-- Calibration RPC URL — which in most hosted setups has an API key in its
-- path. This migration has to land before that deploy, not after it.
--
-- Idempotent and re-runnable. Grants only; no schema change.
-- ============================================

-- --- 1. Table-level revoke, then an explicit per-column re-grant ------------
--
-- The shape the first sentence of that doc quote gives us. Revoking SELECT at
-- the table level clears the table privilege AND every column privilege on it,
-- so the GRANT that follows is not additive to anything — it is the complete
-- new definition of what these two roles may read. `error` is the one column
-- left out, and leaving a column out is the only mechanism that actually
-- withholds it.
--
-- EVERY OTHER COLUMN MUST BE NAMED. After the revoke there is no table-level
-- SELECT to fall back on, so a column missing from this list is a column anon
-- can no longer read. The list below is the live schema of filecoin_uploads —
-- ten columns from 0003, `simulated` from 0006 — minus `error`.
--
-- A consequence worth stating because it will bite someone later: a column
-- added to this table by a future migration will NOT be readable by anon or
-- authenticated until it is added to a grant. That is the safe direction to
-- fail in, and it is the opposite of how the table behaved before today, when
-- a new column was public the instant it existed. That default is what made
-- 0022's mistake dangerous rather than merely wrong.
--
-- Names are filtered through information_schema so this file still runs on a
-- database where 0006 never applied. The RAISE EXCEPTION guards the one
-- outcome worse than the leak: revoking SELECT and then granting nothing back,
-- which would take the table dark for every browser read.
--
-- To undo (restores the exposure — do not):
--   GRANT SELECT ON filecoin_uploads TO anon, authenticated;

DO $$
DECLARE
  readable CONSTANT text[] := ARRAY[
    'id', 'claim_id', 'piece_cid', 'dataset_id', 'root_cid', 'upload_status',
    'pdp_status', 'last_proven_epoch', 'attempted_at', 'completed_at',
    'simulated'
  ];
  col_list text;
  r        text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'filecoin_uploads'
  ) THEN
    RAISE NOTICE '0023: filecoin_uploads does not exist; nothing to re-grant.';
    RETURN;
  END IF;

  SELECT string_agg(quote_ident(c.name), ', ' ORDER BY c.ord)
    INTO col_list
    FROM unnest(readable) WITH ORDINALITY AS c(name, ord)
   WHERE EXISTS (
     SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_schema = 'public'
        AND ic.table_name   = 'filecoin_uploads'
        AND ic.column_name  = c.name
   );

  IF col_list IS NULL THEN
    RAISE EXCEPTION '0023: filecoin_uploads exists but none of its expected '
                    'columns do. Refusing to revoke SELECT, because that '
                    'would leave the table unreadable to every browser '
                    'client rather than merely hiding one column.';
  END IF;

  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    -- Same pg_roles guard 0022 used, and for the same reason: this file also
    -- has to run against a plain Postgres that has never heard of Supabase's
    -- roles, rather than aborting the whole migration on a missing role.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE SELECT ON public.filecoin_uploads FROM %I', r);
      EXECUTE format('GRANT SELECT (%s) ON public.filecoin_uploads TO %I',
                     col_list, r);
    END IF;
  END LOOP;
END $$;

-- --- 2. What is deliberately NOT touched ------------------------------------
--
-- 0007's blanket-read RLS policy on filecoin_uploads stays exactly as it is.
-- Column privileges and row policies are two independent gates and this
-- migration only closes one of them: which ROWS anon may see is 0007's
-- decision to revisit, and widening this file to re-litigate it would put an
-- unrelated frontend-visible change inside a security fix. The eleven columns
-- above remain as readable as they were this morning.
--
-- The service role is unaffected in every respect. It bypasses RLS and holds
-- its privileges independently of these two roles, so the health endpoint,
-- check-setup and the evidence pipeline — all of which read filecoin_uploads
-- on the service key, including the `error` column — continue unchanged. 0016
-- established that the only client-side Supabase reads in this frontend are
-- against `claims`, so nothing in the browser loses a column it was using.
--
-- INSERT, UPDATE and DELETE are also left alone. Supabase's default GRANT ALL
-- gives anon those too, and they are gated today only by 0007 having written
-- no policy for them. That is a real weakness and it is not this migration's:
-- it predates `error`, it applies to every table in the schema, and fixing it
-- one table at a time inside an unrelated file is how it would get missed
-- everywhere else.
--
-- Still not in the supabase_realtime publication, and neither is the table.
-- Publication membership is a third exposure that neither the revoke here nor
-- the policy in 0007 gates.

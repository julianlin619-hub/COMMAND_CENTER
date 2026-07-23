-- Enable RLS on the tweets table so PostgREST cannot expose rows to
-- unauthorized callers. Service role (used by cron and dashboard API routes)
-- retains full access; all other roles are implicitly denied.
--
-- The `tweets` table was never created by a migration — it was made ad-hoc
-- (Supabase dashboard) and flagged by the Security Advisor, which is what
-- prompted this migration. The table has since been dropped from the remote,
-- so this must no-op when the table is absent: `supabase db push` runs the
-- whole file in order and a hard failure here blocks every later migration
-- (which is exactly what happened on 2026-07-23). IF EXISTS + the guarded DO
-- block keep the original intent when the table is present and do nothing
-- when it isn't.
ALTER TABLE IF EXISTS tweets ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF to_regclass('public.tweets') IS NOT NULL THEN
    -- Guard the policy too (CREATE POLICY has no IF NOT EXISTS): skip if a
    -- prior partial apply already created it.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'tweets'
        AND policyname = 'Service role full access on tweets'
    ) THEN
      CREATE POLICY "Service role full access on tweets"
        ON tweets
        FOR ALL
        TO authenticated, anon
        USING (auth.role() = 'service_role')
        WITH CHECK (auth.role() = 'service_role');
    END IF;
  END IF;
END $$;

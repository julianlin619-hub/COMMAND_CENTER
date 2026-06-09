-- Enable RLS on the tweets table so PostgREST cannot expose rows to
-- unauthorized callers. Service role (used by cron and dashboard API routes)
-- retains full access; all other roles are implicitly denied.
ALTER TABLE tweets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on tweets"
  ON tweets
  FOR ALL
  TO authenticated, anon
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

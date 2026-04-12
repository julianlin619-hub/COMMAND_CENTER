-- Enable Row Level Security and add a dedup constraint.
--
-- RLS: With RLS enabled and no policies for the anon role, the anon key
-- gets zero access. Only the service_role key (used by our server-side
-- code) can read/write. The service key bypasses RLS automatically in
-- Supabase, but explicit policies document the intent.
--
-- Dedup: A partial unique index on (platform, md5(caption)) prevents
-- duplicate posts per platform. Uses md5() because captions are TEXT
-- and could exceed the B-tree index size limit. Excludes failed/error
-- posts so retries can re-insert.

-- ── RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE cron_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on posts"
    ON posts FOR ALL
    USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on schedules"
    ON schedules FOR ALL
    USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on cron_runs"
    ON cron_runs FOR ALL
    USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on templates"
    ON templates FOR ALL
    USING (auth.role() = 'service_role');

-- ── Dedup constraint ─────────────────────────────────────────────────────

CREATE UNIQUE INDEX idx_posts_platform_caption_dedup
    ON posts (platform, md5(caption))
    WHERE status NOT IN ('failed', 'buffer_error');

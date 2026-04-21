-- Performance indexes — add covering composites for the access patterns
-- the codebase actually uses. Identified by the architecture review (see
-- /Users/julianlin/.claude/plans/rustling-squishing-bear.md item #11).
--
-- These are CREATE INDEX IF NOT EXISTS so re-running this migration is safe.
-- Postgres uses the most selective index automatically, so adding composites
-- doesn't hurt single-column queries that still hit `idx_posts_platform`.

-- ── schedules.post_id ────────────────────────────────────────────────────
-- Postgres does NOT auto-index foreign keys (unlike MySQL). Every cron run
-- of get_due_schedules() does a `posts!inner(*)` join that filters by
-- schedule.post_id → posts.id. Without this index the join falls back to
-- a sequential scan as the schedules table grows.
CREATE INDEX IF NOT EXISTS idx_schedules_post_id ON schedules (post_id);

-- ── posts(platform, status) ──────────────────────────────────────────────
-- Dashboard pages filter on both columns together, e.g. the Facebook page
-- queries `platform = 'tiktok' AND status = 'sent_to_buffer'` to find posts
-- ready to be repurposed. The standalone idx_posts_platform and
-- idx_posts_status indexes can each only serve one half of the predicate;
-- this composite lets Postgres jump directly to matching rows.
CREATE INDEX IF NOT EXISTS idx_posts_platform_status ON posts (platform, status);

-- ── posts(platform, created_at DESC) ─────────────────────────────────────
-- Dashboard listing queries (`/posts`, per-platform pages) all do
-- `WHERE platform = ? ORDER BY created_at DESC LIMIT N`. The standalone
-- idx_posts_published_at indexes published_at, not created_at, and only
-- on published posts (which excludes drafts/sent_to_buffer/buffer_error).
-- This composite covers the listing pattern across all statuses.
CREATE INDEX IF NOT EXISTS idx_posts_platform_created_at
    ON posts (platform, created_at DESC);

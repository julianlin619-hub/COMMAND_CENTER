-- COMMAND_CENTER initial schema
-- Run this in the Supabase SQL editor or via supabase db push

-- Enum types
CREATE TYPE platform_enum AS ENUM (
    'youtube', 'instagram', 'tiktok', 'linkedin', 'x', 'threads'
);

CREATE TYPE post_status AS ENUM (
    'draft', 'scheduled', 'publishing', 'published', 'failed'
);

CREATE TYPE cron_status AS ENUM (
    'running', 'success', 'failed'
);

CREATE TYPE media_type_enum AS ENUM (
    'image', 'video', 'carousel'
);

-- ── Posts ────────────────────────────────────────────────────────────────

CREATE TABLE posts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform        platform_enum NOT NULL,
    platform_post_id TEXT,
    status          post_status NOT NULL DEFAULT 'draft',
    title           TEXT,
    caption         TEXT,
    media_type      media_type_enum,
    media_urls      TEXT[],
    hashtags        TEXT[],
    permalink       TEXT,
    published_at    TIMESTAMPTZ,
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_posts_platform ON posts (platform);
CREATE INDEX idx_posts_status ON posts (status);
CREATE INDEX idx_posts_published_at ON posts (published_at DESC);

-- ── Schedules ───────────────────────────────────────────────────────────

CREATE TABLE schedules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id         UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    scheduled_for   TIMESTAMPTZ NOT NULL,
    picked_up_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_schedules_due ON schedules (scheduled_for)
    WHERE picked_up_at IS NULL;

-- ── Engagement Metrics ──────────────────────────────────────────────────

CREATE TABLE engagement_metrics (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id         UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    platform        platform_enum NOT NULL,
    views           BIGINT DEFAULT 0,
    likes           BIGINT DEFAULT 0,
    comments        BIGINT DEFAULT 0,
    shares          BIGINT DEFAULT 0,
    saves           BIGINT DEFAULT 0,
    clicks          BIGINT DEFAULT 0,
    impressions     BIGINT DEFAULT 0,
    reach           BIGINT DEFAULT 0,
    watch_time_sec  BIGINT DEFAULT 0,
    followers_delta INT DEFAULT 0,
    extra           JSONB DEFAULT '{}',
    snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_metrics_post ON engagement_metrics (post_id, snapshot_at DESC);
CREATE INDEX idx_metrics_platform_time ON engagement_metrics (platform, snapshot_at DESC);

-- ── Cron Runs ───────────────────────────────────────────────────────────

CREATE TABLE cron_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform        platform_enum NOT NULL,
    job_type        TEXT NOT NULL,
    status          cron_status NOT NULL DEFAULT 'running',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    posts_processed INT DEFAULT 0,
    error_message   TEXT
);

CREATE INDEX idx_cron_runs_platform ON cron_runs (platform, started_at DESC);

-- ── Supabase Storage bucket for media ───────────────────────────────────
-- Create via Supabase dashboard or CLI:
--   supabase storage create media --public=false

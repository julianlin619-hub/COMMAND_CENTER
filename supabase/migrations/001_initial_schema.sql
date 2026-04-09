-- COMMAND_CENTER initial schema
-- Run this in the Supabase SQL editor or via supabase db push

-- ── Enum types ─────────────────────────────────────────────────────────
-- ENUMs are custom data types that restrict a column to a fixed set of
-- allowed values. Think of them like a dropdown menu at the database level.
-- Why use them instead of plain TEXT?
--   1. Data integrity — a typo like 'yotube' is rejected immediately.
--   2. Self-documenting — the schema itself tells you every valid value.
--   3. Storage efficiency — Postgres stores enums as integers internally.

-- Every platform we support. Adding a new platform means adding a value
-- here first (ALTER TYPE platform_enum ADD VALUE 'newplatform').
CREATE TYPE platform_enum AS ENUM (
    'youtube', 'instagram', 'tiktok', 'linkedin', 'facebook', 'threads'
);

-- Lifecycle of a post: draft -> scheduled -> publishing -> published
-- If something goes wrong during publishing, it moves to 'failed' instead.
CREATE TYPE post_status AS ENUM (
    'draft', 'scheduled', 'publishing', 'published', 'failed'
);

-- Tracks whether a background cron job is still running, finished
-- successfully, or hit an error.
CREATE TYPE cron_status AS ENUM (
    'running', 'success', 'failed'
);

-- The kind of media attached to a post. 'carousel' means multiple
-- images/videos shown as a swipeable set (common on Instagram/LinkedIn).
CREATE TYPE media_type_enum AS ENUM (
    'image', 'video', 'carousel'
);

-- ── Posts ────────────────────────────────────────────────────────────────
-- The central table. Every piece of content you create — whether it's a
-- YouTube video, an Instagram reel, or a tweet — lives here as one row.

CREATE TABLE posts (
    -- UUID (Universally Unique Identifier) is used instead of a simple
    -- auto-incrementing integer (1, 2, 3...) for the primary key. Why?
    --   1. Globally unique — safe to generate IDs from the dashboard, cron
    --      jobs, or anywhere else without worrying about collisions.
    --   2. Non-guessable — no one can iterate /posts/1, /posts/2 to scrape.
    --   3. Merge-friendly — if you ever combine data from multiple sources,
    --      UUIDs won't clash the way sequential IDs would.
    -- gen_random_uuid() tells Postgres to auto-generate a UUID when you
    -- INSERT a row without specifying an id.
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Which social media platform this post targets.
    platform        platform_enum NOT NULL,

    -- The ID the platform gives back after publishing (e.g., a YouTube
    -- video ID or tweet ID). NULL until we actually publish.
    platform_post_id TEXT,

    -- Current lifecycle stage of this post. Defaults to 'draft' so new
    -- posts start unpublished.
    status          post_status NOT NULL DEFAULT 'draft',

    -- Post title — used by platforms that support titles (YouTube, LinkedIn).
    -- NULL for platforms like Instagram/Threads where there's no title field.
    title           TEXT,

    -- The main text body / description / caption for the post.
    caption         TEXT,

    -- What kind of media is attached (image, video, carousel), if any.
    media_type      media_type_enum,

    -- Array of URLs pointing to media files in Supabase Storage. We use a
    -- Postgres TEXT array (TEXT[]) so a single post can have multiple files
    -- (e.g., a carousel of images).
    media_urls      TEXT[],

    -- Array of hashtags. Stored separately from the caption so we can
    -- easily add/remove them or format them differently per platform.
    hashtags        TEXT[],

    -- The public URL to the published post (e.g., https://twitter.com/...).
    -- Filled in after publishing so the dashboard can link directly to it.
    permalink       TEXT,

    -- When the post was actually published on the platform. NULL until then.
    published_at    TIMESTAMPTZ,

    -- If publishing failed, the error message is saved here so you can
    -- debug it from the dashboard without digging through logs.
    error_message   TEXT,

    -- created_at: when the row was first inserted (never changes).
    -- updated_at: when the row was last modified (updated on every edit).
    -- Why both? created_at tells you when the post was drafted. updated_at
    -- tells you the last time anything changed — useful for sorting by
    -- "recently edited" and for cache invalidation.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes make queries faster by letting Postgres jump directly to matching
-- rows instead of scanning the entire table. Think of them like the index
-- in the back of a textbook — you look up a topic and it tells you exactly
-- which page to go to, instead of reading every page.
--
-- We create indexes on the columns we filter/sort by most often:

-- "Show me all posts for Instagram" — the dashboard filters by platform.
CREATE INDEX idx_posts_platform ON posts (platform);

-- "Show me all published posts" / "Show me all drafts" — filter by status.
CREATE INDEX idx_posts_status ON posts (status);

-- "Show me my most recent posts" — sort by publish date, newest first.
-- DESC means descending order so the most recent posts come first.
CREATE INDEX idx_posts_published_at ON posts (published_at DESC);

-- ── Schedules ───────────────────────────────────────────────────────────
-- Links a post to a specific publish time. There's a one-to-one
-- relationship: each post has at most one schedule row. We keep it in a
-- separate table (instead of adding columns to posts) because not every
-- post is scheduled — drafts and already-published posts don't need these
-- fields, and a separate table keeps the posts table clean.

CREATE TABLE schedules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Foreign key to the posts table. REFERENCES posts(id) tells Postgres
    -- this column must point to an existing post. ON DELETE CASCADE means
    -- if the post is deleted, this schedule row is automatically deleted
    -- too — no orphaned schedules left behind.
    post_id         UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,

    -- The date/time when this post should go live.
    scheduled_for   TIMESTAMPTZ NOT NULL,

    -- Acts as a lock to prevent double-publishing. Here's the problem it
    -- solves: cron jobs run every 4 hours, and there could be a race
    -- condition where two cron runs try to publish the same post. When a
    -- cron picks up a schedule, it immediately sets picked_up_at to now().
    -- Once this is non-NULL, no other cron run will touch this row.
    -- Think of it like taking a ticket off a board — once someone grabs it,
    -- it's gone.
    picked_up_at    TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- This is a "partial index" — notice the WHERE clause at the end.
-- Instead of indexing every row in the table, it only indexes rows where
-- picked_up_at IS NULL (i.e., schedules that haven't been picked up yet).
-- Why? Because the cron job's query is always:
--   "Find schedules where scheduled_for <= now AND picked_up_at IS NULL"
-- Rows that have already been picked up will never match that query, so
-- there's no point wasting space indexing them. The partial index stays
-- small and fast, only covering the rows we actually care about.
CREATE INDEX idx_schedules_due ON schedules (scheduled_for)
    WHERE picked_up_at IS NULL;

-- ── Cron Runs ───────────────────────────────────────────────────────────
-- Observability table — logs every execution of every cron job. Without
-- this, you'd have no way to know from the dashboard whether your cron
-- jobs are actually running, how long they take, or why they failed. It's
-- like a flight recorder for your background processes. If posts aren't
-- publishing, the first thing you check is this table.

CREATE TABLE cron_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Which platform's cron job ran.
    platform        platform_enum NOT NULL,

    -- What the cron was doing: 'publish' (send scheduled posts to the
    -- platform API) or 'metrics' (pull engagement data back). Having this
    -- as TEXT instead of an enum gives flexibility to add new job types
    -- without a migration.
    job_type        TEXT NOT NULL,

    -- Lifecycle of a cron run:
    --   'running' — the job has started but hasn't finished yet.
    --   'success' — completed without errors.
    --   'failed'  — something went wrong (check error_message for details).
    -- Defaults to 'running' because we INSERT the row at the start of the
    -- job, then UPDATE it to 'success' or 'failed' when it finishes.
    status          cron_status NOT NULL DEFAULT 'running',

    -- When the job started. Used to detect stuck jobs (if started_at was
    -- 30 minutes ago and status is still 'running', something is wrong).
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- When the job finished. NULL while still running. The difference
    -- between finished_at and started_at tells you how long the job took.
    finished_at     TIMESTAMPTZ,

    -- How many posts this run processed. Useful for spotting anomalies
    -- (e.g., usually processes 5 posts but suddenly processes 0).
    posts_processed INT DEFAULT 0,

    -- If the job failed, the error details go here.
    error_message   TEXT
);

-- Quickly look up recent cron runs for a given platform, newest first.
-- Powers the dashboard's "cron health" monitoring view.
CREATE INDEX idx_cron_runs_platform ON cron_runs (platform, started_at DESC);

-- ── Supabase Storage bucket for media ───────────────────────────────────
-- Media files (images, videos) are NOT stored in the database — they live
-- in Supabase Storage, which is an S3-compatible object store. The database
-- only stores URLs pointing to those files (in posts.media_urls).
--
-- Why not store files in the database?
--   1. Databases are optimized for structured data, not large binary blobs.
--   2. Supabase Storage handles file uploads, CDN delivery, and access
--      control out of the box.
--   3. Keeps the database small and backups fast.
--
-- The bucket must be created separately (it's not a SQL migration):
-- Create via Supabase dashboard or CLI:
--   supabase storage create media --public=false
--
-- public=false means files require an authenticated URL to access. The cron
-- jobs use the Supabase service key to generate signed URLs when they need
-- to download media for publishing to platform APIs.

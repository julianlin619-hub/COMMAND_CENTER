-- Batch video → auto-titled/captioned manual-upload pathway.
--
-- Adds the two pieces of state the new pathway needs that the existing
-- schema doesn't already cover:
--   1. A vector index over the tweet bank so we can find the tweet whose
--      sentiment best matches a video's transcript (the RAG caption lookup).
--   2. A per-video job queue so the dashboard can hand each uploaded mp4 to
--      the spawned Python processor and track its status (pending → done).
--
-- Everything downstream (posts, schedules, buffer reconcile, storage cleanup)
-- reuses the existing tables — the processor writes ordinary `posts` rows with
-- metadata.source='manual_upload', identical to today's single-file upload.

-- ── pgvector ─────────────────────────────────────────────────────────────
-- Postgres extension that adds the `vector` column type plus distance
-- operators (<=> is cosine distance). Supabase ships it; we just enable it.
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Tweet bank (embedded) ────────────────────────────────────────────────
-- One row per tweet from data/TweetMasterBank.csv, with its embedding so we
-- can do nearest-neighbour search. Backfilled once by
-- scripts/embed_tweet_bank.py after this migration runs. We keep the bank in
-- its own table (not the CSV) because the RAG lookup needs the vectors in
-- Postgres where pgvector can rank them — re-embedding 18K tweets on every
-- upload would be far too slow and expensive.
CREATE TABLE tweet_bank (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The original tweet id from the CSV. Unique so the backfill is
    -- idempotent (re-running skips tweets already inserted via upsert).
    tweet_id        TEXT NOT NULL UNIQUE,
    text            TEXT NOT NULL,
    favorite_count  INT,
    -- text-embedding-3-small returns 1536-dimensional vectors. If you ever
    -- switch embedding models, change this dimension AND re-run the backfill
    -- (vectors of different dimensions can't be compared).
    embedding       vector(1536),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- IVFFlat index for approximate nearest-neighbour search by cosine distance.
-- `lists` trades index build time / memory for query speed; 100 is a sane
-- default for ~18K rows. The index only helps once the table is populated —
-- build it after the backfill if you want optimal centroids, but creating it
-- here is harmless (it just stays empty until rows land).
CREATE INDEX idx_tweet_bank_embedding
    ON tweet_bank USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- ── match_tweet_bank RPC ─────────────────────────────────────────────────
-- Returns the `match_count` tweets whose embedding is closest (cosine) to the
-- query embedding. Called from Python via client.rpc("match_tweet_bank", ...).
-- similarity = 1 - cosine_distance, so higher is more similar (easier for the
-- caller to reason about than a raw distance).
CREATE OR REPLACE FUNCTION match_tweet_bank(
    query_embedding vector(1536),
    match_count int DEFAULT 10
)
RETURNS TABLE (
    tweet_id text,
    text text,
    favorite_count int,
    similarity float
)
LANGUAGE sql STABLE
AS $$
    SELECT
        tb.tweet_id,
        tb.text,
        tb.favorite_count,
        1 - (tb.embedding <=> query_embedding) AS similarity
    FROM tweet_bank tb
    WHERE tb.embedding IS NOT NULL
    ORDER BY tb.embedding <=> query_embedding
    LIMIT match_count;
$$;

-- ── Video batch jobs ─────────────────────────────────────────────────────
-- One row per uploaded mp4 in the batch pathway. The dashboard inserts a row
-- (status='pending') right after the browser finishes uploading to Storage,
-- then spawns `python -m core.video_batch --job-id <id>` which claims the row
-- (pending → processing), transcribes + titles + captions + fans out to
-- Buffer, and finally marks it done (or failed). The row doubles as the UI's
-- progress record and as an idempotency guard: claim_video_batch_job() only
-- succeeds on a 'pending' row, so a double-click or retry can't double-post.
CREATE TABLE video_batch_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Clerk user id of the uploader (from the dashboard session). Stored so
    -- the storage-path ownership check has a record and the UI can scope.
    user_id         TEXT NOT NULL,
    -- Supabase Storage path of the uploaded mp4 (tiktok/manual/<userId>/...).
    storage_path    TEXT NOT NULL,
    -- pending → processing → done | failed. Plain TEXT (not an enum) so we can
    -- add states without a migration, matching cron_runs.job_type's rationale.
    status          TEXT NOT NULL DEFAULT 'pending',
    -- Filled in by the processor once generated, so the UI can show them.
    title           TEXT,
    caption         TEXT,
    transcript      TEXT,
    -- Set when status='failed'. Sanitized before write (see core/database.py).
    error_message   TEXT,
    -- Incremented on each claim. Lets us spot a job that keeps crashing.
    attempts        INT NOT NULL DEFAULT 0,
    -- Set when a worker claims the job; mirrors schedules.picked_up_at so the
    -- same stale-recovery idea could apply if a processor ever crashes mid-run.
    picked_up_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial index over just the unclaimed jobs — the only ones a claim query
-- scans. Stays small as completed jobs accumulate (same pattern as
-- idx_schedules_due).
CREATE INDEX idx_video_batch_jobs_pending
    ON video_batch_jobs (created_at)
    WHERE status = 'pending';

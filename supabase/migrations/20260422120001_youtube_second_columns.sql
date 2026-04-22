-- YouTube second-channel direct-upload feature: column + index.
--
-- Runs after the enum-additions migration (required — the partial index
-- predicate below references 'youtube_second', which must already be a
-- valid enum value).
--
-- metadata JSONB: structured per-post metadata. For youtube_second, we
-- store {"publish_at": "<ISO-8601 UTC>"} representing the claimed slot.
-- JSONB rather than a dedicated column because only youtube_second cares,
-- and we may extend the shape in the future without more migrations.

ALTER TABLE posts
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Partial unique index enforces "one post per (platform, publish_at) slot"
-- ONLY for youtube_second rows that have a publish_at and are not failed.
--
-- Why partial?
--   1. Other platforms don't use metadata.publish_at — indexing them wastes space.
--   2. Excluding status='failed' lets a failed upload release its slot so a
--      retry can immediately reclaim the same time window. Without this, a
--      single botched OAuth refresh would burn a slot for hours.
--
-- The index is the safety net backing the advisory-lock-based slot claim in
-- /api/youtube-second/upload-init — if two tx somehow race past the lock,
-- the INSERT with the duplicate publish_at fails with 23505 and the route
-- handler retries.

CREATE UNIQUE INDEX IF NOT EXISTS posts_youtube_second_slot_unique
    ON posts (platform, (metadata->>'publish_at'))
    WHERE platform = 'youtube_second'
      AND metadata ? 'publish_at'
      AND status <> 'failed';

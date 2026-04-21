-- Enforce the one-schedule-per-post invariant at the database layer.
--
-- `supabase/migrations/20260412105430_initial_schema.sql` documents schedules as "one-to-one
-- with posts" — but the schema itself only had a foreign key, not a UNIQUE
-- constraint, on `schedules.post_id`. The cron "take a ticket" logic in
-- `core/scheduler.py` relies on that 1:1 relationship: it picks a schedule
-- row, sets `picked_up_at` to lock it, and publishes the linked post. If a
-- second schedule row exists for the same post_id, two cron runs can grab
-- two different ticket rows for the same post and publish it twice.
--
-- A unique index is the right fix because:
--   * It's the same on-disk structure as the non-unique `idx_schedules_post_id`
--     from migration 005 (which this supersedes for FK-join lookups too), so
--     there's no added index-maintenance cost on writes.
--   * It turns the invariant into a constraint the database enforces, instead
--     of an invariant scattered across application code.
--
-- ── Safety check before enforcing uniqueness ───────────────────────────────
-- If the schedules table already contains duplicate post_ids (from the bug
-- this migration prevents), CREATE UNIQUE INDEX will fail with a clear error.
-- The DO block runs first so the operator gets a readable message naming the
-- offending post_ids instead of the raw Postgres error.
DO $$
DECLARE
    dup_count INT;
    dup_ids   TEXT;
BEGIN
    SELECT COUNT(*), string_agg(post_id::text, ', ')
      INTO dup_count, dup_ids
      FROM (
        SELECT post_id
          FROM schedules
         GROUP BY post_id
        HAVING COUNT(*) > 1
      ) d;

    IF dup_count > 0 THEN
        RAISE EXCEPTION
            'Cannot add UNIQUE(post_id) to schedules: % post_id(s) already have duplicate rows: %. Resolve duplicates (keep the row with the smallest picked_up_at, delete the rest) and re-run this migration.',
            dup_count, dup_ids;
    END IF;
END
$$;

-- ── The unique index ───────────────────────────────────────────────────────
-- CREATE UNIQUE INDEX IF NOT EXISTS makes this migration idempotent. Uses a
-- plain (non-CONCURRENTLY) build because (a) Supabase runs migrations inside
-- a transaction, which forbids CONCURRENTLY, and (b) the schedules table is
-- small (one row per scheduled post, not per post).
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_post_id_unique
    ON schedules (post_id);

-- Migration 005's `idx_schedules_post_id` is now redundant (unique indexes
-- serve the same join lookups as non-unique ones). Leaving it in place for
-- now — dropping it is a separate cleanup since it's unrelated to the
-- correctness invariant this migration enforces.

-- ── Rollback ───────────────────────────────────────────────────────────────
-- To roll back manually:
--
--   DROP INDEX IF EXISTS idx_schedules_post_id_unique;
--
-- Rollback is safe at any point — dropping the index only removes the
-- constraint enforcement. Existing well-formed data is unaffected.

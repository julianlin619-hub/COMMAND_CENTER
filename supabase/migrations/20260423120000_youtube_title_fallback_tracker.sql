-- YouTube title-fallback retry tracker.
--
-- Why this table exists: the studio-first cron generates titles from the
-- video's caption transcript. When a draft has no caption track yet (ASR
-- still processing, captions disabled, etc.) we skip the draft and retry
-- on the next cron run. Without a counter, a draft whose captions never
-- materialize becomes a zombie — discovered every run, skipped every run,
-- never makes it to the dashboard.
--
-- After N skips (default 3, see YOUTUBE_TITLE_FALLBACK_AFTER in
-- core.youtube_studio_scheduler) the cron falls back to a cleaned version
-- of the original Studio title and deletes the tracker row. The counter
-- is keyed on (channel_id, video_id) so the same logic can extend to
-- additional YouTube channels without schema changes.
--
-- Only the transcript-unavailable path bumps this counter. Title
-- generation failures are treated as transient (Claude outage / API blip)
-- and do not count — otherwise a 1-hour Claude outage would flip many
-- good drafts to fallback titles.

CREATE TABLE youtube_title_fallback_tracker (
    channel_id       TEXT NOT NULL,
    video_id         TEXT NOT NULL,
    skip_count       INT  NOT NULL DEFAULT 0,
    first_skipped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_skipped_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_reason      TEXT,
    PRIMARY KEY (channel_id, video_id)
);

-- RLS: service-role-only access, matching the pattern from
-- 20260412105433_rls_and_dedup.sql. The anon key must not be able to
-- read or write this table — all access flows through the cron's
-- service-key client in core.database.
ALTER TABLE youtube_title_fallback_tracker ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on youtube_title_fallback_tracker"
    ON youtube_title_fallback_tracker FOR ALL
    USING (auth.role() = 'service_role');

-- Per-platform browser session state for headless-Chromium publishers.
--
-- Why this table exists: Snapchat has no usable upload API for unattended
-- posting (Snap Kit needs user-tap, Marketing API is ads-only, Stories API
-- is invite-only). The publisher cron drives Playwright headless Chromium
-- against the Public Profile Web Uploader instead, which means we need a
-- way to persist the logged-in browser context (cookies + localStorage)
-- across cron runs without re-prompting the operator for credentials.
--
-- Playwright serialises that context to a JSON blob via `context.storage_state()`.
-- We stash that blob here, keyed on the platform_enum value. The operator
-- captures the initial blob locally via `scripts/capture_snapchat_auth.py`,
-- and the publisher refreshes it after every successful publish (so cookies
-- stay rotated organically). If auth ever expires the publisher raises
-- PlatformAuthError and the operator re-runs the capture script.
--
-- Keyed on the enum directly (PRIMARY KEY on platform_enum, not a surrogate
-- id) because there is exactly one session per platform — adding a row for
-- platform='snapchat' replaces the prior session blob via UPSERT. Future
-- headless publishers for other platforms can reuse this table by inserting
-- their own enum row; no schema change required.

CREATE TABLE platform_session_state (
    platform      platform_enum PRIMARY KEY,
    storage_state JSONB         NOT NULL,
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- RLS: service-role-only access. Matches the pattern from
-- 20260423120000_youtube_title_fallback_tracker.sql and the broader policy
-- set in 20260412105433_rls_and_dedup.sql. The anon key must not be able
-- to read or write this table — the JSONB blob is effectively a session
-- credential and only the cron's service-key client should touch it.
ALTER TABLE platform_session_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on platform_session_state"
    ON platform_session_state FOR ALL
    USING (auth.role() = 'service_role');

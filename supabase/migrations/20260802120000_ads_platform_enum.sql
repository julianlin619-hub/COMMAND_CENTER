-- Add 'ads' to platform_enum for the Ad Carousels feature.
--
-- Ad Carousels is a manually-triggered pipeline (no cron) that renders
-- prompt-selected tweets as carousel PNGs and exports them to Google Drive.
-- It never publishes to a social platform, but 'ads' still needs to be a
-- platform_enum value because two enum-typed columns must reference it:
--   - templates.platform  → the ads slides get their own template row so
--     styling can diverge from the Instagram carousel via the designer
--   - cron_runs.platform  → manual runs are logged so the dashboard can
--     show "last run" like the instagram-reposts page does
--
-- This ALTER lives alone in its own migration: Postgres forbids using a
-- new enum value inside the same transaction that adds it, so the
-- template seed + settings table land in the next migration file.

ALTER TYPE platform_enum ADD VALUE IF NOT EXISTS 'ads';

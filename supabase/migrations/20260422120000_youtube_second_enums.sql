-- YouTube second-channel direct-upload feature: enum additions.
--
-- This migration MUST commit before the companion columns migration runs.
-- Postgres does not allow adding a value to an enum and using it in the
-- same transaction (the new value isn't visible until after commit), so
-- the DDL is split across two migration files.
--
-- Existing enum state (from 20260412105430_initial_schema.sql):
--   platform_enum: youtube, instagram, instagram_2nd, tiktok, linkedin, facebook, threads
--   post_status:   draft, scheduled, publishing, published, failed  (+ sent_to_buffer, buffer_error in later migration)

ALTER TYPE platform_enum ADD VALUE IF NOT EXISTS 'youtube_second';
ALTER TYPE post_status ADD VALUE IF NOT EXISTS 'uploading_to_youtube';

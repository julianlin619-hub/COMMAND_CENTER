-- Add Buffer-specific post statuses to the post_status enum.
--
-- sent_to_buffer: the video was successfully queued in Buffer but hasn't
--   published to TikTok yet. Buffer handles timing via its queue system.
-- buffer_error: the Buffer API call failed. Distinct from 'failed' which
--   describes a direct-posting failure in the platform adapter lifecycle.
--
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction in Postgres.
-- If running via Supabase Dashboard migration runner, it handles this automatically.
-- If running manually, ensure you're NOT inside a BEGIN/COMMIT block.

ALTER TYPE post_status ADD VALUE IF NOT EXISTS 'sent_to_buffer';
ALTER TYPE post_status ADD VALUE IF NOT EXISTS 'buffer_error';

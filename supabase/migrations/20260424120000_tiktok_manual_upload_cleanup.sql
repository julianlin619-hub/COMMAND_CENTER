-- Partial index to keep the daily tiktok-storage-cleanup cron's scan cheap
-- as the posts table grows. Only rows currently eligible for cleanup
-- (manual-upload TikTok posts not yet cleaned) stay in the index; once the
-- cron flips metadata.storage_cleanup_status to 'done' the row drops out.
CREATE INDEX IF NOT EXISTS idx_posts_manual_upload_cleanup_pending
    ON posts (created_at)
    WHERE platform = 'tiktok'
      AND metadata->>'source' = 'manual_upload'
      AND metadata->>'storage_cleanup_status' = 'pending';

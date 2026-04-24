-- Sibling partial index for the manual-upload cleanup cron, now that the
-- TikTok manual-upload dialog also fans out to YouTube Shorts via Buffer.
-- Mirrors the 20260424120000 index but scoped to platform='youtube' so the
-- same daily cron (cron/tiktok_storage_cleanup.py) can scan both platforms
-- with cheap index seeks as the posts table grows.
CREATE INDEX IF NOT EXISTS idx_posts_manual_upload_cleanup_pending_youtube
    ON posts (created_at)
    WHERE platform = 'youtube'
      AND metadata->>'source' = 'manual_upload'
      AND metadata->>'storage_cleanup_status' = 'pending';

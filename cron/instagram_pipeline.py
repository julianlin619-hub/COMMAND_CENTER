"""Instagram cross-post pipeline — automated cron job.

Runs daily (1:30 PM UTC) to mirror TikTok Path 1 reels onto the Alex Hormozi
Instagram account via Buffer. There is NO new video generation here — this
pipeline re-uses the 1080x1920 MP4s that TikTok already rendered and stored
in Supabase Storage, just fanning them out to a second Buffer queue.

Concerns are intentionally kept separate from cron/tiktok_pipeline.py so that
Instagram can fail/retry independently of TikTok.

The pipeline has 2 phases, each logged as a separate cron_runs entry:
  Phase 1 — Read:   query recent TikTok posts from the DB, filter out dupes
  Phase 2 — Buffer: get signed URLs for the existing MP4s and send to Buffer

A failure in Phase 1 aborts the run (no posts = nothing to send).
A failure in Phase 2 for one item does NOT abort other items.
"""

import logging
import sys
from datetime import datetime, timedelta, timezone

from core.buffer import get_channel_id, send_to_buffer
from core.database import (
    get_client,
    insert_post,
    log_cron_finish,
    log_cron_start,
    post_caption_exists,
    update_post,
)
from core.env_diag import log_env_diagnostics
from core.media import get_signed_url
from core.models import Post


# Postgres unique-constraint violation code. Raised by postgrest as APIError.code
# when the dedup index from migration 004_rls_and_dedup.sql fires.
_PG_UNIQUE_VIOLATION = "23505"


def _is_unique_violation(exc: Exception) -> bool:
    """Check if an exception from Supabase is a unique-constraint violation."""
    code = getattr(exc, "code", "") or ""
    message = str(exc).lower()
    return _PG_UNIQUE_VIOLATION in code or _PG_UNIQUE_VIOLATION in message or "duplicate key" in message

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def main():
    # Log env-var presence first so the UI output pane shows whether the
    # subprocess inherited every var this pipeline depends on.
    log_env_diagnostics(
        "instagram-pipeline",
        required=[
            "SUPABASE_URL",
            "SUPABASE_SERVICE_KEY",
            "BUFFER_ACCESS_TOKEN",
            "BUFFER_ORG_ID",
        ],
    )

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 1: Read recent TikTok posts from the database
    # ─────────────────────────────────────────────────────────────────────
    # Unlike facebook_pipeline.py we also select media_urls — facebook
    # regenerates its own PNGs from the caption, but we reuse TikTok's MP4
    # as-is, so we need the storage path.
    run_id = log_cron_start(platform="instagram", job_type="content_fetch")
    try:
        client = get_client()
        # Compute the 48-hour cutoff in Python — Supabase's PostgREST filters
        # don't evaluate SQL expressions, so we must pass an ISO timestamp.
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()
        # Skip rows whose metadata.source is "manual_upload" — those come from
        # the dashboard's TikTok manual upload route (Pathway 3), which is
        # explicitly scoped to TikTok + YouTube Shorts + LinkedIn. Re-fanning
        # them out here would publish the same video to Instagram against the
        # user's intent.
        result = client.table("posts").select("id, caption, media_urls").eq(
            "platform", "tiktok"
        ).eq(
            "status", "sent_to_buffer"
        ).gte(
            "created_at", cutoff
        ).neq(
            "metadata->>source", "manual_upload"
        ).execute()

        tiktok_posts = result.data or []
        logger.info("Phase 1: found %d recent TikTok posts", len(tiktok_posts))

        # Filter out posts that already have an Instagram version, and guard
        # against TikTok rows with empty media_urls (shouldn't happen for
        # sent_to_buffer posts, but skip rather than crash if it does).
        new_posts = []
        for post in tiktok_posts:
            caption = post["caption"]
            media_urls = post.get("media_urls") or []
            if not media_urls:
                logger.warning("Skipping TikTok post %s — empty media_urls", post.get("id"))
                continue
            if post_caption_exists("instagram", caption):
                logger.debug("Skipping duplicate: %s...", caption[:50])
                continue
            new_posts.append(post)

        log_cron_finish(run_id, status="success", posts_processed=len(new_posts))
        logger.info(
            "Phase 1: %d new posts after dedup (%d filtered)",
            len(new_posts), len(tiktok_posts) - len(new_posts),
        )
    except Exception as e:
        logger.error("Phase 1 failed (read TikTok posts): %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    if not new_posts:
        logger.info("No new posts to process — nothing to send. Exiting.")
        return

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 2: Send reels to Buffer's Instagram queue
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="instagram", job_type="buffer_send")
    sent_count = 0
    error_count = 0

    try:
        channel_id = get_channel_id(service="instagram")
    except Exception as e:
        logger.error("Phase 2 failed — could not get Instagram channel ID: %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    for post in new_posts:
        storage_path = post["media_urls"][0]
        caption = post["caption"]
        # Same engagement hook as TikTok/Facebook — short caption that drives
        # comments. The raw tweet text lives in the video itself.
        instagram_caption = "Agree?"

        # Guard: skip empty/whitespace captions. Buffer rejects them and we
        # don't want to flip status to sent_to_buffer when the send will fail.
        if not caption or not caption.strip():
            logger.warning("Skipping post with empty caption (storage: %s)", storage_path)
            error_count += 1
            continue

        # ─── INSERT FIRST, THEN SEND TO BUFFER ───────────────────────────
        # See tiktok_pipeline.py for the rationale — this pattern closes the
        # race window where two concurrent runs could both queue the same
        # caption in Buffer. The partial unique index from migration
        # 004_rls_and_dedup.sql arbitrates: only one insert wins, the loser
        # skips. On Buffer failure we flip to buffer_error (which drops the
        # row from the dedup index, allowing future retries).
        new_post = Post(
            platform="instagram",
            status="sent_to_buffer",
            media_type="video",
            media_urls=[storage_path],
            caption=caption,
        )
        try:
            post_id = insert_post(new_post)
        except Exception as e:
            if _is_unique_violation(e):
                logger.info("Skipping duplicate (DB constraint): %s...", caption[:50])
                continue
            logger.error("Insert failed for %s: %s", storage_path, e, exc_info=True)
            error_count += 1
            continue

        try:
            # Get a signed URL with 7-day expiry. Buffer queues content and may
            # not download it for hours or days, so a short expiry risks the
            # URL dying before Buffer fetches the video.
            video_url = get_signed_url(storage_path, expires_in=604800)

            # Send to Buffer's Instagram queue as a Reel — Buffer rejects
            # Instagram posts without metadata.instagram.type, and 1080x1920
            # vertical MP4s belong in the Reels tab.
            buffer_post_id = send_to_buffer(
                channel_id, instagram_caption, video_url,
                media_type="video", instagram_post_type="reel",
            )

            # Stamp the Buffer post ID onto the row we already inserted
            update_post(post_id, platform_post_id=buffer_post_id)
            sent_count += 1
            logger.info("Sent to Buffer: %s (Buffer post %s)", storage_path, buffer_post_id)

        except Exception as e:
            # Flip to buffer_error so the row drops out of the dedup index
            # and a future run can retry this caption.
            logger.error("Buffer send failed for %s: %s", storage_path, e, exc_info=True)
            # Nested try: update_post now raises on no-match. A DB failure
            # here would shadow the real Buffer error and kill the whole
            # batch — catch it so the loop continues and the original
            # exception stays in the log.
            try:
                update_post(post_id, status="buffer_error", error_message=str(e)[:500])
            except Exception as db_err:
                logger.error("Also failed to mark post %s as buffer_error: %s", post_id, db_err)
            error_count += 1

    # Log final status — success if at least one was sent, failed if all errored
    final_status = "success" if sent_count > 0 else "failed"
    error_msg = f"{error_count} items failed" if error_count > 0 else None
    log_cron_finish(
        run_id, status=final_status,
        posts_processed=sent_count, error_message=error_msg,
    )
    logger.info(
        "Phase 2 complete: %d sent to Buffer, %d errors",
        sent_count, error_count,
    )


if __name__ == "__main__":
    main()

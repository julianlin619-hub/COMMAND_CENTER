"""TikTok Bank Reel pipeline — daily cron job.

Runs daily (2 PM UTC / 7 AM PDT) to pick 1 high-performing tweet from
the TweetMasterBank CSV, generate a branded quote-card video, and queue
it to TikTok via Buffer.

This is a SEPARATE pipeline from cron/tiktok_pipeline.py (which sources
from live Apify-scraped outlier tweets). Both write to the same `posts`
table with platform='tiktok', so the partial unique index on
(platform, md5(caption)) prevents cross-pipeline duplicates.

The pipeline has 3 phases, each logged as a separate cron_runs entry:
  Phase 1 — Pick: select 1 random tweet from the bank (>= min likes)
  Phase 2 — Generate: call the dashboard API to render PNG + MP4 video
  Phase 3 — Buffer: insert post, get signed URL, send to Buffer queue
"""

import logging
import os
import sys

from core.buffer import get_channel_id, send_to_buffer
from core.content_gen_client import generate_content
from core.content_sources import select_bank_content_with_likes
from core.database import (
    insert_post,
    log_cron_finish,
    log_cron_start,
    post_caption_exists,
    update_post,
)
from core.media import get_signed_url
from core.models import Post
from core.text_utils import normalize_tweet_text

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
    # Read config from environment
    bank_path = os.environ.get("CONTENT_BANK_PATH", "data/TweetMasterBank.csv")
    min_likes = int(os.environ.get("TIKTOK_BANK_MIN_LIKES", "6500"))
    dashboard_url = os.environ.get("DASHBOARD_URL", "")
    cron_secret = os.environ.get("CRON_SECRET", "")

    if not dashboard_url:
        logger.error("DASHBOARD_URL not set — cannot call dashboard API for video generation")
        sys.exit(1)

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 1: Pick 1 tweet from the bank
    # ─────────────────────────────────────────────────────────────────────
    # Select a random high-performing tweet from the CSV, then check it
    # against existing TikTok posts in the DB to avoid duplicates.
    run_id = log_cron_start(platform="tiktok", job_type="bank_pick")
    try:
        # Pull more candidates than we need so we have room after dedup.
        # The bank has ~18K tweets; with a 6500-like filter we get a few
        # thousand candidates, so pulling 20 is cheap and gives us plenty
        # of fallbacks if most are already posted.
        candidates = select_bank_content_with_likes(
            bank_path, count=20, min_likes=min_likes,
        )

        # Normalize and dedup against existing TikTok posts
        picked = None
        for candidate in candidates:
            normalized = normalize_tweet_text(candidate["text"])
            if post_caption_exists("tiktok", normalized):
                logger.debug("Skipping duplicate: %s...", normalized[:50])
                continue
            # Attach normalized text for later phases
            candidate["normalized"] = normalized
            picked = candidate
            break

        if not picked:
            logger.info("No usable bank tweet found (all duplicates or bank exhausted). Exiting.")
            log_cron_finish(run_id, status="success", posts_processed=0)
            return

        log_cron_finish(run_id, status="success", posts_processed=1)
        logger.info("Phase 1: picked bank tweet (id=%s, %d likes): %s...",
                     picked["tweet_id"], picked["favorite_count"], picked["normalized"][:60])
    except Exception as e:
        logger.error("Phase 1 failed (bank pick): %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 2: Generate video via dashboard API
    # ─────────────────────────────────────────────────────────────────────
    # The dashboard's /api/content-gen/generate route handles canvas
    # rendering, ffmpeg conversion, Supabase Storage upload, and cleanup.
    # Retries on 5xx / network errors are handled inside generate_content.
    run_id = log_cron_start(platform="tiktok", job_type="bank_generate")
    try:
        data = generate_content(
            dashboard_url=dashboard_url,
            cron_secret=cron_secret,
            tweets=[{"id": picked["tweet_id"], "text": picked["normalized"]}],
            platform="tiktok",
        )

        if data.get("error"):
            raise RuntimeError(data["error"])

        # Log per-item errors from the API so we can see exactly why
        # individual items failed (e.g. ffmpeg crash, storage upload error).
        api_errors = data.get("errors", [])
        if api_errors:
            logger.warning("Generate API returned %d error(s):", len(api_errors))
            for i, err in enumerate(api_errors):
                logger.warning("  error[%d]: %s", i, err)

        generated = data.get("generated", [])
        if not generated:
            raise RuntimeError(
                f"Generate API returned empty results. API errors: {api_errors}"
            )

        log_cron_finish(run_id, status="success", posts_processed=len(generated))
        logger.info("Phase 2: generated %d video(s)", len(generated))
    except Exception as e:
        logger.error("Phase 2 failed (generate): %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 3: Send video to Buffer's TikTok queue
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="tiktok", job_type="bank_send")

    try:
        channel_id = get_channel_id(service="tiktok")
    except Exception as e:
        logger.error("Phase 3 failed — could not get TikTok channel ID: %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    item = generated[0]
    storage_path = item["storagePath"]
    caption = item["text"]
    # Hardcoded TikTok caption — short engagement hook for quote-card videos
    tiktok_caption = "Agree?"

    if not caption or not caption.strip():
        logger.warning("Skipping tweet with empty caption (storage: %s)", storage_path)
        log_cron_finish(run_id, status="failed", error_message="Empty caption after generation")
        sys.exit(1)

    # ─── INSERT FIRST, THEN SEND TO BUFFER ───────────────────────────
    # Same insert-before-send dedup pattern as tiktok_pipeline.py Phase 4.
    # The partial unique index on (platform, md5(caption)) is the source
    # of truth — attempt the insert first, and if the DB rejects it, another
    # run already claimed this caption.
    post = Post(
        platform="tiktok",
        status="sent_to_buffer",
        media_type="video",
        media_urls=[storage_path],
        caption=caption,
    )
    try:
        post_id = insert_post(post)
    except Exception as e:
        if _is_unique_violation(e):
            logger.info("Skipping duplicate (DB constraint): %s...", caption[:50])
            log_cron_finish(run_id, status="success", posts_processed=0)
            return
        logger.error("Insert failed for %s: %s", storage_path, e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    try:
        # 7-day signed URL — Buffer queues videos and may not download
        # them for hours or days.
        video_url = get_signed_url(storage_path, expires_in=604800)

        buffer_post_id = send_to_buffer(channel_id, tiktok_caption, video_url, media_type="video")

        update_post(post_id, platform_post_id=buffer_post_id)
        logger.info("Sent to Buffer: %s (Buffer post %s)", storage_path, buffer_post_id)
        log_cron_finish(run_id, status="success", posts_processed=1)

    except Exception as e:
        # Flip to buffer_error so the row drops out of the dedup index
        # and a future run can retry this caption.
        logger.error("Buffer send failed for %s: %s", storage_path, e, exc_info=True)
        # Nested try: update_post now raises on no-match. If the DB write
        # fails here we still need to run log_cron_finish below so the
        # cron_runs row doesn't stay "running" forever — catch and log.
        try:
            update_post(post_id, status="buffer_error", error_message=str(e)[:500])
        except Exception as db_err:
            logger.error("Also failed to mark post %s as buffer_error: %s", post_id, db_err)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()

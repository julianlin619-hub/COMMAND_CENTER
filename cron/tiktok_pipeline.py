"""TikTok Outlier Tweet Reel pipeline — automated cron job.

Runs daily (8 AM Las Vegas / 3 PM UTC) to scrape viral tweets, generate
branded quote-card videos, and queue them to TikTok via Buffer.

The pipeline has 4 phases, each logged as a separate cron_runs entry:
  Phase 1 — Fetch: scrape outlier tweets from X via Apify
  Phase 2 — Filter: normalize text and dedup against existing TikTok posts
  Phase 3 — Generate: call the dashboard API to render PNG + MP4 videos
  Phase 4 — Buffer: get signed URLs and send videos to Buffer's TikTok queue

Phase 3 delegates to the dashboard's /api/content-gen/generate route because
canvas rendering and ffmpeg conversion require Node.js + native deps that
aren't available in the Python cron environment. The cron authenticates
using the CRON_SECRET bearer token (same as other cron → dashboard calls).

A failure in Phase 1 or 2 aborts the run (no tweets = nothing to generate).
A failure in Phase 3 aborts Phase 4 (no videos = nothing to send).
A failure in Phase 4 for one item does NOT abort other items — each video
is sent independently and failures are recorded per-item.
"""

import logging
import os
import sys

from core.buffer import get_channel_id, send_to_buffer, truncate_caption
from core.content_gen_client import generate_content
from core.content_sources import fetch_apify_tweets
from core.database import (
    get_client,
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
    """Check if an exception from Supabase is a unique-constraint violation.

    We compare the dedup index partial-unique constraint as the source of
    truth for "already sent" — that's more reliable than an app-level check
    which can race against concurrent runs. Works across supabase-py versions
    by inspecting both the exception's .code attr and its string form.
    """
    code = getattr(exc, "code", "") or ""
    message = str(exc).lower()
    return _PG_UNIQUE_VIOLATION in code or _PG_UNIQUE_VIOLATION in message or "duplicate key" in message

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def main():
    # Read config from environment (all have sensible defaults)
    twitter_handle = os.environ.get("APIFY_TWITTER_HANDLE", "AlexHormozi")
    max_items = int(os.environ.get("TIKTOK_MAX_ITEMS", "30"))
    min_likes = int(os.environ.get("TIKTOK_MIN_LIKES", "4000"))
    dashboard_url = os.environ.get("DASHBOARD_URL", "")
    cron_secret = os.environ.get("CRON_SECRET", "")

    if not dashboard_url:
        logger.error("DASHBOARD_URL not set — cannot call dashboard API for video generation")
        sys.exit(1)

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 1: Fetch outlier tweets via Apify
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="tiktok", job_type="content_fetch")
    try:
        tweets = fetch_apify_tweets(
            twitter_handle,
            max_items=max_items,
            # Use a longer lookback for TikTok — we run daily, not every 4h,
            # so we need to catch tweets from the past 48 hours to avoid
            # missing content posted between runs.
            hours_lookback=48,
            min_favorites=min_likes,
        )
        log_cron_finish(run_id, status="success", posts_processed=len(tweets))
        logger.info("Phase 1: fetched %d outlier tweets from @%s", len(tweets), twitter_handle)
    except Exception as e:
        logger.error("Phase 1 failed (fetch): %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    if not tweets:
        logger.info("No tweets found — nothing to do. Exiting.")
        return

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 2: Normalize text and filter duplicates
    # ─────────────────────────────────────────────────────────────────────
    # No separate cron_runs entry for this phase — it's a fast in-memory
    # filter, not an external API call. Dedup results are included in the
    # Phase 1 log.
    new_tweets = []
    for tweet in tweets:
        normalized = normalize_tweet_text(tweet["text"])
        if post_caption_exists("tiktok", normalized):
            logger.debug("Skipping duplicate: %s...", normalized[:50])
            continue
        # Attach normalized text so we don't re-normalize later
        tweet["normalized"] = normalized
        new_tweets.append(tweet)

    logger.info(
        "Phase 2: %d new tweets after dedup (%d filtered)",
        len(new_tweets), len(tweets) - len(new_tweets),
    )

    if not new_tweets:
        logger.info("All tweets already scheduled — nothing to generate. Exiting.")
        return

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 3: Generate videos via dashboard API
    # ─────────────────────────────────────────────────────────────────────
    # The dashboard's /api/content-gen/generate route handles canvas rendering,
    # ffmpeg conversion, Supabase Storage upload, and temp file cleanup.
    # Retries on 5xx / network errors are handled inside generate_content.
    run_id = log_cron_start(platform="tiktok", job_type="content_generate")
    try:
        data = generate_content(
            dashboard_url=dashboard_url,
            cron_secret=cron_secret,
            tweets=[{"id": t["id"], "text": t["text"]} for t in new_tweets],
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
        logger.info("Phase 3: generated %d videos", len(generated))
    except Exception as e:
        logger.error("Phase 3 failed (generate): %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    if not generated:
        logger.info("No videos generated — nothing to send to Buffer. Exiting.")
        return

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 4: Send videos to Buffer's TikTok queue
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="tiktok", job_type="buffer_send")
    sent_count = 0
    error_count = 0

    try:
        channel_id = get_channel_id(service='tiktok')
    except Exception as e:
        logger.error("Phase 4 failed — could not get TikTok channel ID: %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    for item in generated:
        storage_path = item["storagePath"]
        caption = item["text"]
        # Hardcoded TikTok caption — short engagement hook for quote-card videos
        tiktok_caption = "Agree?"

        # Guard: skip empty or whitespace-only captions. Buffer's GraphQL
        # mutation will reject them, and we don't want to flip status to
        # sent_to_buffer when we know the send will fail.
        if not caption or not caption.strip():
            logger.warning("Skipping tweet with empty caption (storage: %s)", storage_path)
            error_count += 1
            continue

        # ─── INSERT FIRST, THEN SEND TO BUFFER ───────────────────────────
        # The previous implementation called send_to_buffer() first and did a
        # late-dedup check before insert. That window let two concurrent runs
        # both queue the same caption in Buffer (the DB showed one row, but
        # Buffer published twice). The partial unique index from migration
        # 004_rls_and_dedup.sql on (platform, md5(caption)) WHERE status NOT
        # IN ('failed', 'buffer_error') is our source of truth — attempt the
        # insert first, and if the DB rejects it with a unique-violation,
        # another run already claimed this caption. If Buffer later fails,
        # we flip status to buffer_error, which releases the row from the
        # dedup index so a subsequent run can retry.
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
                continue
            logger.error("Insert failed for %s: %s", storage_path, e, exc_info=True)
            error_count += 1
            continue

        try:
            # Get a signed URL with 7-day expiry. Buffer queues videos and may
            # not download them for hours or days, so a short expiry risks the
            # URL dying before Buffer fetches the video.
            video_url = get_signed_url(storage_path, expires_in=604800)

            # Send to Buffer's TikTok queue
            buffer_post_id = send_to_buffer(channel_id, tiktok_caption, video_url, media_type='video')

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

    # Log final status — success even if some items failed, as long as
    # at least one was sent. Only "failed" if ALL items errored out.
    final_status = "success" if sent_count > 0 else "failed"
    error_msg = f"{error_count} items failed" if error_count > 0 else None
    log_cron_finish(
        run_id, status=final_status,
        posts_processed=sent_count, error_message=error_msg,
    )
    logger.info(
        "Phase 4 complete: %d sent to Buffer, %d errors",
        sent_count, error_count,
    )


if __name__ == "__main__":
    main()

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

import httpx

from core.buffer import get_tiktok_channel_id, send_to_buffer, truncate_caption
from core.content_sources import fetch_apify_tweets
from core.database import (
    insert_post,
    log_cron_finish,
    log_cron_start,
    post_caption_exists,
)
from core.media import get_signed_url
from core.models import Post
from core.text_utils import normalize_tweet_text

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
        logger.error("Phase 1 failed (fetch): %s", e)
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
    run_id = log_cron_start(platform="tiktok", job_type="content_generate")
    try:
        generate_url = f"{dashboard_url.rstrip('/')}/api/content-gen/generate"
        payload = {
            "tweets": [{"id": t["id"], "text": t["text"]} for t in new_tweets],
        }

        # Generous timeout — canvas rendering + ffmpeg conversion is CPU-intensive.
        # Each tweet takes ~10-20 seconds, so 5 minutes should cover a batch of 30.
        resp = httpx.post(
            generate_url,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {cron_secret}",
            },
            json=payload,
            timeout=300,
        )
        resp.raise_for_status()
        data = resp.json()

        if data.get("error"):
            raise RuntimeError(data["error"])

        generated = data.get("generated", [])
        log_cron_finish(run_id, status="success", posts_processed=len(generated))
        logger.info("Phase 3: generated %d videos", len(generated))
    except Exception as e:
        logger.error("Phase 3 failed (generate): %s", e)
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
        channel_id = get_tiktok_channel_id()
    except Exception as e:
        logger.error("Phase 4 failed — could not get TikTok channel ID: %s", e)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    for item in generated:
        storage_path = item["storagePath"]
        caption = item["text"]
        # Hardcoded TikTok caption — short engagement hook for quote-card videos
        tiktok_caption = "Agree?"

        try:
            # Get a signed URL with 7-day expiry. Buffer queues videos and may
            # not download them for hours or days, so a short expiry risks the
            # URL dying before Buffer fetches the video.
            video_url = get_signed_url(storage_path, expires_in=604800)

            # Send to Buffer's TikTok queue
            buffer_post_id = send_to_buffer(channel_id, tiktok_caption, video_url)

            # Record the post in Supabase with sent_to_buffer status.
            # This is a successful handoff — Buffer will handle actual TikTok
            # publishing at the next available queue slot.
            post = Post(
                platform="tiktok",
                status="sent_to_buffer",
                media_type="video",
                media_urls=[storage_path],
                caption=caption,
                platform_post_id=buffer_post_id,
            )
            insert_post(post)
            sent_count += 1
            logger.info("Sent to Buffer: %s (Buffer post %s)", storage_path, buffer_post_id)

        except Exception as e:
            # Record the failure but continue with the next item.
            # One bad video shouldn't block the rest of the batch.
            logger.error("Buffer send failed for %s: %s", storage_path, e)
            error_post = Post(
                platform="tiktok",
                status="buffer_error",
                media_type="video",
                media_urls=[storage_path],
                caption=caption,
                error_message=str(e)[:500],
            )
            insert_post(error_post)
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

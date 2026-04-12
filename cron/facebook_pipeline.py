"""Facebook Quote Card pipeline — automated cron job.

Runs daily (1 PM UTC = 6 AM Las Vegas PDT, 1 hour after TikTok's 12 PM UTC)
to repurpose TikTok's selected tweets as square 1080x1080 PNG quote cards
and queue them to Facebook via Buffer.

Unlike TikTok, this pipeline does NOT run its own Apify scraper. Instead,
it reads recent TikTok posts from the database — every tweet that passed
TikTok's like-threshold filtering automatically becomes a Facebook candidate.

The pipeline has 3 phases, each logged as a separate cron_runs entry:
  Phase 1 — Read: query recent TikTok posts from the DB, filter out dupes
  Phase 2 — Generate: call the dashboard API to render square PNG images
  Phase 3 — Buffer: get signed URLs and send images to Buffer's Facebook queue

A failure in Phase 1 aborts the run (no posts = nothing to generate).
A failure in Phase 2 aborts Phase 3 (no images = nothing to send).
A failure in Phase 3 for one item does NOT abort other items.
"""

import logging
import os
import sys
from datetime import datetime, timedelta, timezone

import httpx

from core.buffer import get_channel_id, send_to_buffer
from core.database import (
    get_client,
    insert_post,
    log_cron_finish,
    log_cron_start,
    post_caption_exists,
)
from core.media import get_signed_url
from core.models import Post

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def main():
    dashboard_url = os.environ.get("DASHBOARD_URL", "")
    cron_secret = os.environ.get("CRON_SECRET", "")

    if not dashboard_url:
        logger.error("DASHBOARD_URL not set — cannot call dashboard API for image generation")
        sys.exit(1)

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 1: Read recent TikTok posts from the database
    # ─────────────────────────────────────────────────────────────────────
    # Instead of scraping tweets from Apify like TikTok does, we read posts
    # that TikTok already selected and sent to Buffer. This means every tweet
    # that passed TikTok's like-threshold filter is automatically a candidate.
    run_id = log_cron_start(platform="facebook", job_type="content_fetch")
    try:
        client = get_client()
        # Compute the 48-hour cutoff in Python — Supabase's PostgREST filters
        # don't evaluate SQL expressions, so we must pass an ISO timestamp.
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()
        result = client.table("posts").select("id, caption").eq(
            "platform", "tiktok"
        ).eq(
            "status", "sent_to_buffer"
        ).gte(
            "created_at", cutoff
        ).execute()

        tiktok_posts = result.data or []
        logger.info("Phase 1: found %d recent TikTok posts", len(tiktok_posts))

        # Filter out posts that already have a Facebook version
        new_posts = []
        for post in tiktok_posts:
            caption = post["caption"]
            if post_caption_exists("facebook", caption):
                logger.debug("Skipping duplicate: %s...", caption[:50])
                continue
            new_posts.append(post)

        log_cron_finish(run_id, status="success", posts_processed=len(new_posts))
        logger.info(
            "Phase 1: %d new posts after dedup (%d filtered)",
            len(new_posts), len(tiktok_posts) - len(new_posts),
        )
    except Exception as e:
        logger.error("Phase 1 failed (read TikTok posts): %s", e)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    if not new_posts:
        logger.info("No new posts to process — nothing to generate. Exiting.")
        return

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 2: Generate square images via dashboard API
    # ─────────────────────────────────────────────────────────────────────
    # The dashboard's /api/content-gen/generate route handles canvas rendering
    # and Supabase Storage upload. We pass platform='facebook' so it renders
    # 1080x1080 PNGs instead of 1080x1920 MP4 videos.
    run_id = log_cron_start(platform="facebook", job_type="content_generate")
    try:
        generate_url = f"{dashboard_url.rstrip('/')}/api/content-gen/generate"
        payload = {
            "platform": "facebook",
            "tweets": [{"id": p["id"], "text": p["caption"]} for p in new_posts],
        }

        # Generous timeout — canvas rendering is CPU-intensive.
        # Each image takes ~2-5 seconds, so 5 minutes covers a batch of 30.
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
        logger.info("Phase 2: generated %d square images", len(generated))
    except Exception as e:
        logger.error("Phase 2 failed (generate): %s", e)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    if not generated:
        logger.info("No images generated — nothing to send to Buffer. Exiting.")
        return

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 3: Send images to Buffer's Facebook queue
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="facebook", job_type="buffer_send")
    sent_count = 0
    error_count = 0

    try:
        channel_id = get_channel_id(service="facebook")
    except Exception as e:
        logger.error("Phase 3 failed — could not get Facebook channel ID: %s", e)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    for item in generated:
        storage_path = item["storagePath"]
        caption = item["text"]
        # Same engagement hook as TikTok — short caption that drives comments
        facebook_caption = "Agree?"

        try:
            # Get a signed URL with 7-day expiry. Buffer queues content and may
            # not download it for hours or days, so a short expiry risks the
            # URL dying before Buffer fetches the image.
            image_url = get_signed_url(storage_path, expires_in=604800)

            # Send to Buffer's Facebook queue with media_type='image'
            buffer_post_id = send_to_buffer(
                channel_id, facebook_caption, image_url,
                media_type="image", facebook_post_type="post",
            )

            # Recheck dedup right before insert — another concurrent run
            # may have inserted this caption between Phase 1 and now.
            if post_caption_exists("facebook", caption):
                logger.info("Skipping duplicate (late check): %s...", caption[:50])
                continue

            # Record the post in Supabase with sent_to_buffer status.
            post = Post(
                platform="facebook",
                status="sent_to_buffer",
                media_type="image",
                media_urls=[storage_path],
                caption=caption,
                platform_post_id=buffer_post_id,
            )
            insert_post(post)
            sent_count += 1
            logger.info("Sent to Buffer: %s (Buffer post %s)", storage_path, buffer_post_id)

        except Exception as e:
            # Record the failure but continue with the next item.
            logger.error("Buffer send failed for %s: %s", storage_path, e)
            error_post = Post(
                platform="facebook",
                status="buffer_error",
                media_type="image",
                media_urls=[storage_path],
                caption=caption,
                error_message=str(e)[:500],
            )
            insert_post(error_post)
            error_count += 1

    # Log final status — success if at least one was sent, failed if all errored
    final_status = "success" if sent_count > 0 else "failed"
    error_msg = f"{error_count} items failed" if error_count > 0 else None
    log_cron_finish(
        run_id, status=final_status,
        posts_processed=sent_count, error_message=error_msg,
    )
    logger.info(
        "Phase 3 complete: %d sent to Buffer, %d errors",
        sent_count, error_count,
    )


if __name__ == "__main__":
    main()

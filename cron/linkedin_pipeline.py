"""LinkedIn Quote Card pipeline — automated cron job.

Runs daily at 12:00 UTC = 5:00 AM PDT (30 min after Facebook's 11:30 UTC
slot) to requeue Facebook's already-rendered quote cards on LinkedIn.

Reads posts that Facebook has already generated and sent to Buffer, then
queues the SAME PNG (by reference — no re-render) to Buffer's LinkedIn
channel. This guarantees byte-for-byte parity with Facebook and skips a
redundant content-gen call. As a consequence, LinkedIn only posts on days
Facebook did — exactly the desired 1:1 behavior.

Two phases, each logged as a separate cron_runs entry:
  Phase 1 — Read: query recent Facebook posts from the DB, filter out dupes
  Phase 2 — Buffer: get signed URLs and send to Buffer's LinkedIn queue

A failure in Phase 1 aborts the run (no posts = nothing to send).
A failure in Phase 2 for one item does NOT abort other items.

Phase 2 will fail until a LinkedIn channel is connected in Buffer — the
channel lookup in core/buffer.py raises "No linkedin channel connected".
That's the one manual step: connect LinkedIn inside buffer.com.
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
        "linkedin-pipeline",
        required=[
            "SUPABASE_URL",
            "SUPABASE_SERVICE_KEY",
            "BUFFER_ACCESS_TOKEN",
            "BUFFER_ORG_ID",
        ],
    )

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 1: Read recent Facebook posts from the database
    # ─────────────────────────────────────────────────────────────────────
    # Facebook has already selected outliers, rendered 1080×1080 quote cards,
    # and uploaded them to Storage. LinkedIn just requeues the same PNGs on
    # its Buffer channel — no re-render, no content-gen round-trip. Dedup is
    # per-platform, so a caption on Facebook is still a LinkedIn candidate;
    # we only skip captions already on LinkedIn.
    run_id = log_cron_start(platform="linkedin", job_type="content_fetch")
    try:
        client = get_client()
        # Compute the 48-hour cutoff in Python — Supabase's PostgREST filters
        # don't evaluate SQL expressions, so we must pass an ISO timestamp.
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()
        result = client.table("posts").select("id, caption, media_urls").eq(
            "platform", "facebook"
        ).eq(
            "status", "sent_to_buffer"
        ).gte(
            "created_at", cutoff
        ).execute()

        fb_posts = result.data or []
        logger.info("Phase 1: found %d recent Facebook posts", len(fb_posts))

        # Filter out posts that already have a LinkedIn version, and defensively
        # skip any Facebook row missing media_urls (shouldn't happen, but would
        # crash Phase 2 if it did).
        new_posts = []
        for post in fb_posts:
            caption = post["caption"]
            media_urls = post.get("media_urls") or []
            if not media_urls:
                logger.warning("Skipping Facebook post %s with no media_urls", post["id"])
                continue
            if post_caption_exists("linkedin", caption):
                logger.debug("Skipping duplicate: %s...", caption[:50])
                continue
            new_posts.append(post)

        log_cron_finish(run_id, status="success", posts_processed=len(new_posts))
        logger.info(
            "Phase 1: %d new posts after dedup (%d filtered)",
            len(new_posts), len(fb_posts) - len(new_posts),
        )
    except Exception as e:
        logger.error("Phase 1 failed (read Facebook posts): %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    if not new_posts:
        logger.info("No new posts to process — nothing to send. Exiting.")
        return

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 2: Send images to Buffer's LinkedIn queue
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="linkedin", job_type="buffer_send")
    sent_count = 0
    error_count = 0

    try:
        channel_id = get_channel_id(service="linkedin")
    except Exception as e:
        logger.error("Phase 2 failed — could not get LinkedIn channel ID: %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    for item in new_posts:
        # Reuse the exact storage path Facebook uploaded. Signed URLs are
        # per-request so we don't share a URL — just the underlying object.
        storage_path = item["media_urls"][0]
        caption = item["caption"]
        # Same engagement hook as Facebook — short caption that drives comments
        linkedin_caption = "Agree?"

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
        post = Post(
            platform="linkedin",
            status="sent_to_buffer",
            media_type="image",
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
            # Get a signed URL with 7-day expiry. Buffer queues content and may
            # not download it for hours or days, so a short expiry risks the
            # URL dying before Buffer fetches the image.
            image_url = get_signed_url(storage_path, expires_in=604800)

            # Send to Buffer's LinkedIn queue with media_type='image'. Unlike
            # Facebook, Buffer's LinkedIn integration has no platform-specific
            # metadata block (no equivalent of facebook_post_type).
            buffer_post_id = send_to_buffer(
                channel_id, linkedin_caption, image_url,
                media_type="image",
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

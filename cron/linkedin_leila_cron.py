"""
LinkedIn (Leila Hormozi) cron job entry point.

Apify-source pipeline that turns recent @LeilaHormozi tweets into 1080×1080
quote-card PNGs and queues them on Buffer's Leila LinkedIn channel.

Phases (each logged as its own cron_runs row):
  Phase 0 — SOURCE: Apify-scrape recent @LeilaHormozi tweets. Tries a 24-hour
            window first, falls back to 72 hours if 24h returned nothing —
            the source repo's behavior was "post when there's content,"
            and a single dry day shouldn't skip the whole pipeline.
  Phase 1 — GENERATE: hand each tweet to the dashboard's content-gen route
            and get back a Storage path to a rendered 1080×1080 PNG.
            Re-uses Alex's Facebook template config (no Leila-specific
            template yet).
  Phase 2 — BUFFER: insert a `posts` row (status='sent_to_buffer') for each
            generated image and send it to Buffer's Leila LinkedIn queue
            with a hardcoded "Agree?" caption — same engagement hook the
            Alex Facebook/LinkedIn pipeline uses.

Bypasses `core.scheduler.process_due_posts` because that path goes through
platform adapters that don't handle media (the Threads adapter, for example,
ignores media_urls). Direct send_to_buffer matches the Facebook pipeline's
proven shape.

The Alex `linkedin-pipeline` cron is untouched — it's a separate requeue-off-
Facebook flow with its own Render service and its own dedup state.
"""

import logging
import os
import sys
import uuid

from core.buffer import send_to_buffer
from core.content_gen_client import generate_content
from core.content_sources import fetch_apify_tweets
from core.database import (
    insert_post,
    log_cron_finish,
    log_cron_start,
    post_caption_exists,
    update_post,
)
from core.env_diag import log_env_diagnostics
from core.media import get_signed_url
from core.models import Post

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


# Postgres unique-constraint violation code. Raised by postgrest as APIError.code
# when the dedup index from migration 004_rls_and_dedup.sql fires — used here
# to ride out a race where two concurrent runs both got past `post_caption_exists`
# and tried to insert the same caption.
_PG_UNIQUE_VIOLATION = "23505"


def _is_unique_violation(exc: Exception) -> bool:
    """Detect a Supabase APIError that represents a unique-constraint violation."""
    code = getattr(exc, "code", "") or ""
    message = str(exc).lower()
    return (
        _PG_UNIQUE_VIOLATION in code
        or _PG_UNIQUE_VIOLATION in message
        or "duplicate key" in message
    )


# Buffer channel ID for Leila's LinkedIn account.
#
#   Buffer org: "ACQ" (id 67dafe21c453882020852a9a)
#   Channel:    Leila Hormozi LinkedIn (service: linkedin)
#
# Hardcoded for the same reason THREADS_LEILA_CHANNEL_ID is hardcoded in
# threads_leila_cron.py:57 — the channel is stable per-account and the
# BUFFER_ACCESS_TOKEN it's paired with is what actually gates access. Pulling
# it from env vars adds drift potential without buying any safety.
#
# To rotate (or look up another channel in the same org), POST to
# https://api.buffer.com/graphql with the existing BUFFER_ACCESS_TOKEN:
#
#   { account { organizations { id name channels { id name service } } } }
#
# Find the entry where service="linkedin" and name matches Leila's LinkedIn,
# then paste its `id` here.
LINKEDIN_LEILA_CHANNEL_ID = "69f8e8fb5c4c051afa0d487e"

# Engagement hook — image is the focus, caption is just a question that
# tends to drive comments. Same string Alex's Facebook + LinkedIn cron uses.
LINKEDIN_LEILA_CAPTION = "Agree?"


def _fetch_with_fallback(twitter_handle: str) -> list[dict]:
    """Pull recent tweets, falling back to a wider window when the tight one is empty.

    Try 24h first (matches Threads-Leila and the source repo's "today's
    tweets" intent). If nothing comes back — Leila skipped a day, or the
    Apify actor was rate-limited and yielded zero — widen to 72h so a
    single quiet day doesn't lose us a LinkedIn post entirely.
    """
    tweets = fetch_apify_tweets(twitter_handle, max_items=5, hours_lookback=24)
    if tweets:
        return tweets
    logger.info(
        "No tweets in 24h window for @%s — falling back to 72h", twitter_handle,
    )
    return fetch_apify_tweets(twitter_handle, max_items=5, hours_lookback=72)


def main() -> None:
    log_env_diagnostics(
        "linkedin-leila-cron",
        required=[
            "SUPABASE_URL",
            "SUPABASE_SERVICE_KEY",
            "BUFFER_ACCESS_TOKEN",
            "APIFY_API_KEY",
            "DASHBOARD_URL",
            "CRON_SECRET",
        ],
        optional=[
            "APIFY_LEILA_TWITTER_HANDLE",
        ],
    )

    if not LINKEDIN_LEILA_CHANNEL_ID:
        logger.error(
            "LINKEDIN_LEILA_CHANNEL_ID is not set in cron/linkedin_leila_cron.py — "
            "look it up via Buffer GraphQL (see comment in this file) and hardcode it."
        )
        sys.exit(1)

    dashboard_url = os.environ.get("DASHBOARD_URL", "")
    cron_secret = os.environ.get("CRON_SECRET", "")
    if not dashboard_url:
        logger.error("DASHBOARD_URL not set — cannot call dashboard API for image generation")
        sys.exit(1)

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 0: Source recent @LeilaHormozi tweets via Apify
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="linkedin_leila", job_type="content_apify")
    new_tweets: list[dict] = []
    try:
        twitter_handle = os.environ.get("APIFY_LEILA_TWITTER_HANDLE", "LeilaHormozi")
        tweets = _fetch_with_fallback(twitter_handle)
        logger.info("Phase 0: fetched %d tweets from @%s", len(tweets), twitter_handle)

        for tweet in tweets:
            text = tweet["text"]
            if post_caption_exists("linkedin_leila", text):
                logger.debug("Skipping duplicate: %s...", text[:50])
                continue
            new_tweets.append(tweet)

        log_cron_finish(run_id, status="success", posts_processed=len(new_tweets))
        logger.info(
            "Phase 0: %d new tweets after dedup (%d filtered)",
            len(new_tweets),
            len(tweets) - len(new_tweets),
        )
    except Exception as e:
        logger.error("Phase 0 failed (Apify source): %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    if not new_tweets:
        logger.info("No new tweets to process — exiting before generation.")
        return

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 1: Generate 1080×1080 PNG quote cards via dashboard endpoint
    # ─────────────────────────────────────────────────────────────────────
    # The route reuses the Facebook template config but stores the PNG at
    # linkedin_leila/tweet-{id}.png so the namespace is creator-distinct.
    # We mint fresh UUIDs because the post row hasn't been inserted yet
    # (matches cron/facebook_pipeline.py — tweets carry "id" purely so the
    # API can echo them back paired with each storagePath).
    request_items = [
        {"id": str(uuid.uuid4()), "text": tweet["text"]} for tweet in new_tweets
    ]
    # Built before the API call so it's available unconditionally in Phase 2,
    # not bound inside the try-block that may raise. The route preserves the
    # input id so we can pair the rendered image back to the tweet's text
    # (used for Post.caption / dedup against post_caption_exists).
    text_by_id: dict[str, str] = {item["id"]: item["text"] for item in request_items}

    run_id = log_cron_start(platform="linkedin_leila", job_type="content_generate")
    try:
        data = generate_content(
            dashboard_url=dashboard_url,
            cron_secret=cron_secret,
            tweets=request_items,
            platform="linkedin_leila",
        )

        if data.get("error"):
            raise RuntimeError(data["error"])

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
        logger.info("Phase 1: generated %d square images", len(generated))
    except Exception as e:
        logger.error("Phase 1 failed (generate): %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 2: Insert post rows + send to Buffer's LinkedIn queue
    # ─────────────────────────────────────────────────────────────────────
    # Insert-then-send mirrors cron/facebook_pipeline.py: the partial-unique
    # index closes the race where two concurrent runs queue the same caption
    # in Buffer. Loser of the race catches the unique violation and skips.
    # On Buffer failure we flip status to buffer_error so the row drops out
    # of the dedup index and a future run can retry.
    run_id = log_cron_start(platform="linkedin_leila", job_type="buffer_send")
    sent_count = 0
    error_count = 0

    for item in generated:
        storage_path = item["storagePath"]
        tweet_id = item.get("id", "")
        # Caption stored on the Post row is the original tweet text — that's
        # what `post_caption_exists` dedups against. The Buffer-facing caption
        # is the engagement hook ("Agree?"), kept intentionally separate.
        tweet_text = text_by_id.get(tweet_id) or item.get("text", "")
        if not tweet_text or not tweet_text.strip():
            logger.warning("Skipping post with empty tweet text (storage: %s)", storage_path)
            error_count += 1
            continue

        post = Post(
            platform="linkedin_leila",
            status="sent_to_buffer",
            media_type="image",
            media_urls=[storage_path],
            caption=tweet_text,
        )
        try:
            post_id = insert_post(post)
        except Exception as e:
            if _is_unique_violation(e):
                logger.info("Skipping duplicate (DB constraint): %s...", tweet_text[:50])
                continue
            logger.error("Insert failed for %s: %s", storage_path, e, exc_info=True)
            error_count += 1
            continue

        try:
            # 7-day signed URL — Buffer queues for hours/days before downloading,
            # and a short expiry would silently break the eventual fetch.
            image_url = get_signed_url(storage_path, expires_in=604800)

            buffer_post_id = send_to_buffer(
                LINKEDIN_LEILA_CHANNEL_ID,
                LINKEDIN_LEILA_CAPTION,
                image_url,
                media_type="image",
            )
            update_post(post_id, platform_post_id=buffer_post_id)
            sent_count += 1
            logger.info("Sent to Buffer: %s (Buffer post %s)", storage_path, buffer_post_id)
        except Exception as e:
            logger.error("Buffer send failed for %s: %s", storage_path, e, exc_info=True)
            try:
                update_post(post_id, status="buffer_error", error_message=str(e)[:500])
            except Exception as db_err:
                logger.error(
                    "Also failed to mark post %s as buffer_error: %s", post_id, db_err,
                )
            error_count += 1

    final_status = "success" if sent_count > 0 else "failed"
    error_msg = f"{error_count} items failed" if error_count > 0 else None
    log_cron_finish(
        run_id,
        status=final_status,
        posts_processed=sent_count,
        error_message=error_msg,
    )
    logger.info(
        "Phase 2 complete: %d sent to Buffer, %d errors", sent_count, error_count,
    )

    if sent_count == 0 and error_count > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()

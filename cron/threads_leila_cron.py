"""
Threads (Leila Hormozi) cron job entry point.

Parallel to cron/threads_cron.py — same Apify-scrape → Buffer-queue path,
different Twitter handle and Buffer channel, separate platform enum value
('threads_leila'). Ported from github.com/julianlin619-hub/THREADS-LEILA-,
which is a verbatim repost of recent @LeilaHormozi tweets with no
engagement filter and no content bank.

Phase 0 — SOURCE: pull recent tweets from @LeilaHormozi via Apify and create
          scheduled posts in Supabase (platform='threads_leila'). Each tweet
          is dedup'd against existing posts via post_caption_exists.
Phase 1 — PUBLISH: process due posts via the Threads adapter, pointing at
          the Leila-specific Buffer channel.

The Alex Threads cron is untouched — this job has its own cron_runs history
and its own Render service.
"""

import logging
import os
import sys
from datetime import datetime, timezone

from core.content_sources import fetch_apify_tweets
from core.database import (
    insert_post,
    insert_schedule,
    log_cron_finish,
    log_cron_start,
    post_caption_exists,
)
from core.env_diag import log_env_diagnostics
from core.models import Post
from core.scheduler import process_due_posts
from platforms.threads import Threads

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

# Buffer channel ID for Leila's Threads (org "ACQ", channel "leilahormozi").
# Hardcoded because it's stable per-account and the BUFFER_ACCESS_TOKEN it's
# paired with is what actually gates access — keeping this out of env vars
# avoids per-environment config drift for a value that never changes.
THREADS_LEILA_CHANNEL_ID = "67dafec61616c536ddd6e02f"


def main():
    log_env_diagnostics(
        "threads-leila-cron",
        required=[
            "SUPABASE_URL",
            "SUPABASE_SERVICE_KEY",
            "BUFFER_ACCESS_TOKEN",
            "APIFY_API_KEY",
        ],
        optional=[
            "APIFY_LEILA_TWITTER_HANDLE",
        ],
    )

    # Construct the Threads adapter against Leila's Buffer channel. The
    # default constructor reads BUFFER_THREADS_CHANNEL_ID (Alex); passing
    # channel_id explicitly overrides that for this run.
    client = Threads(channel_id=THREADS_LEILA_CHANNEL_ID)

    # -------------------------------------------------------------------------
    # PHASE 0: Source tweets via Apify
    # -------------------------------------------------------------------------
    # Source repo posts every recent @LeilaHormozi tweet without filtering on
    # engagement — match that behavior (no min_favorites). max_items=5 mirrors
    # the source repo's per-run cap.
    run_id = log_cron_start(platform="threads_leila", job_type="content_apify")
    try:
        apify_sourced = 0
        now = datetime.now(timezone.utc)

        twitter_handle = os.environ.get("APIFY_LEILA_TWITTER_HANDLE", "LeilaHormozi")
        tweets = fetch_apify_tweets(twitter_handle, max_items=5, hours_lookback=24)

        for tweet in tweets:
            if post_caption_exists("threads_leila", tweet["text"]):
                continue
            post = Post(platform="threads_leila", caption=tweet["text"], status="scheduled")
            post_id = insert_post(post)
            insert_schedule(post_id, now)
            apify_sourced += 1

        log_cron_finish(run_id, status="success", posts_processed=apify_sourced)
        logger.info("Apify sourcing complete: %d new posts", apify_sourced)
    except Exception as e:
        logger.error("Apify sourcing failed: %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))

    # -------------------------------------------------------------------------
    # PHASE 1: Publish due posts
    # -------------------------------------------------------------------------
    run_id = log_cron_start(platform="threads_leila", job_type="post")
    try:
        try:
            client.refresh_credentials()
        except Exception as e:
            logger.error("Credential refresh failed — aborting run: %s", e, exc_info=True)
            log_cron_finish(run_id, status="failed", error_message=f"Credential refresh failed: {e}")
            sys.exit(1)

        processed = process_due_posts(client, "threads_leila")

        log_cron_finish(run_id, status="success", posts_processed=processed)
        logger.info("Posting complete: %d posts processed", processed)
    except Exception as e:
        logger.error("Posting failed: %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()

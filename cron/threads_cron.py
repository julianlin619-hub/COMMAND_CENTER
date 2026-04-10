"""
Threads cron job entry point.

This is a "cron job" -- a scheduled background task that runs automatically on a
timer (every 4 hours via Render's cron scheduler). It is NOT triggered by a user
clicking something in the dashboard. Instead, Render runs this script on a fixed
schedule, like an alarm clock that goes off every 4 hours.

The dashboard and this cron job never talk to each other directly. They communicate
through the Supabase database: the dashboard writes posts/schedules into the DB,
and this cron job reads them out and publishes them to Threads.

This script does two things each time it runs:
  Phase 0 - SOURCE: Pull new content from external sources (Apify tweet scraping
            and a pre-written content bank CSV). Creates scheduled posts in Supabase
            so Phase 1 can pick them up immediately. Ported from the original THREADS
            repo (github.com/julianlin619-hub/THREADS).
  Phase 1 - PUBLISH: Find posts that are due to be published and send them to Threads.

These are tracked as separate "cron runs" in the database so we can see independently
whether each phase succeeded. A failure in Phase 0 does NOT prevent Phase 1 from
running — content sourcing is best-effort, and we don't want a scraping hiccup to
block publishing of posts that are already scheduled.
"""

import logging
import os
import sys
from datetime import datetime, timezone

# Content sourcing functions (ported from the original THREADS repo)
from core.content_sources import fetch_apify_tweets, select_bank_content
# Database helpers for tracking cron runs and storing data
from core.database import (
    get_posts,
    insert_post,
    insert_schedule,
    log_cron_finish,
    log_cron_start,
    post_caption_exists,
)
from core.models import Post
# process_due_posts handles the logic of finding posts whose scheduled time has passed
# and calling the platform client to publish them
from core.scheduler import process_due_posts
# Threads is the platform adapter -- it implements the PlatformBase interface
# (create_post, refresh_credentials, etc.)
from platforms.threads import Threads

# Set up logging so we can see what happens when this script runs.
# The format includes timestamp, log level, and logger name, which makes it
# easy to debug issues in Render's log viewer.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


def main():
    # Create the Threads platform client. This object knows how to talk to
    # the Threads API -- publishing posts, fetching metrics, refreshing tokens, etc.
    # (Threads uses Buffer's API — see platforms/threads.py for details.)
    client = Threads()

    # -------------------------------------------------------------------------
    # PHASE 0a: Source tweets via Apify
    # -------------------------------------------------------------------------
    # Fetches recent tweets from a Twitter account and creates scheduled posts.
    # Tracked separately from the content bank so each source has its own
    # run history and can be triggered independently from the dashboard.
    run_id = log_cron_start(platform="threads", job_type="content_apify")
    try:
        apify_sourced = 0
        now = datetime.now(timezone.utc)

        twitter_handle = os.environ.get("APIFY_TWITTER_HANDLE", "AlexHormozi")
        tweets = fetch_apify_tweets(twitter_handle)

        for tweet in tweets:
            if post_caption_exists("threads", tweet["text"]):
                continue
            post = Post(platform="threads", caption=tweet["text"], status="scheduled")
            post_id = insert_post(post)
            insert_schedule(post_id, now)
            apify_sourced += 1

        log_cron_finish(run_id, status="success", posts_processed=apify_sourced)
        logger.info("Apify sourcing complete: %d new posts", apify_sourced)
    except Exception as e:
        logger.error("Apify sourcing failed: %s", e)
        log_cron_finish(run_id, status="failed", error_message=str(e))

    # -------------------------------------------------------------------------
    # PHASE 0b: Source from content bank
    # -------------------------------------------------------------------------
    # Picks random entries from a pre-written CSV file. Tracked as its own
    # cron run so failures here don't mask Apify results (and vice versa).
    run_id = log_cron_start(platform="threads", job_type="content_bank")
    try:
        bank_sourced = 0
        now = datetime.now(timezone.utc)

        bank_path = os.environ.get("CONTENT_BANK_PATH", "data/threads_bank.csv")
        bank_count = int(os.environ.get("CONTENT_BANK_COUNT", "5"))

        existing_posts = get_posts(platform="threads", limit=5000)
        existing_captions = {
            p["caption"] for p in existing_posts if p.get("caption")
        }

        bank_items = select_bank_content(
            bank_path, count=bank_count, already_used=existing_captions,
        )
        for text in bank_items:
            post = Post(platform="threads", caption=text, status="scheduled")
            post_id = insert_post(post)
            insert_schedule(post_id, now)
            bank_sourced += 1

        log_cron_finish(run_id, status="success", posts_processed=bank_sourced)
        logger.info("Bank sourcing complete: %d new posts", bank_sourced)
    except Exception as e:
        logger.error("Bank sourcing failed: %s", e)
        log_cron_finish(run_id, status="failed", error_message=str(e))

    # -------------------------------------------------------------------------
    # PHASE 1: Publish due posts
    # -------------------------------------------------------------------------
    # We log a "cron run" in the database so the dashboard can show a history
    # of when this job ran and whether it succeeded or failed.
    run_id = log_cron_start(platform="threads", job_type="post")
    try:
        try:
            client.refresh_credentials()
        except Exception as e:
            logger.error("Credential refresh failed — aborting run: %s", e)
            log_cron_finish(run_id, status="failed", error_message=f"Credential refresh failed: {e}")
            sys.exit(1)

        processed = process_due_posts(client, "threads")

        log_cron_finish(run_id, status="success", posts_processed=processed)
        logger.info("Posting complete: %d posts processed", processed)
    except Exception as e:
        logger.error("Posting failed: %s", e)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)



# This is Python's standard entry-point guard. It means "only run main() when
# this file is executed directly (e.g., `python threads_cron.py`), NOT when it's
# imported as a module by another file." This is a Python convention that keeps
# the script from accidentally running when imported elsewhere.
if __name__ == "__main__":
    main()

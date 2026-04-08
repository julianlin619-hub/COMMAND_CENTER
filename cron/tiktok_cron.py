"""
TikTok cron job entry point.

This is a "cron job" -- a scheduled background task that runs automatically on a
timer (every 4 hours via Render's cron scheduler). It is NOT triggered by a user
clicking something in the dashboard. Instead, Render runs this script on a fixed
schedule, like an alarm clock that goes off every 4 hours.

The dashboard and this cron job never talk to each other directly. They communicate
through the Supabase database: the dashboard writes posts/schedules into the DB,
and this cron job reads them out, publishes them to TikTok, and writes metrics back.

This script does two things each time it runs:
  Phase 1 - PUBLISH: Find posts that are due to be published and send them to TikTok.
  Phase 2 - METRICS: For posts already published, pull engagement data (views, likes,
            comments, shares, etc.) from the TikTok API and store it in the database.

These are tracked as separate "cron runs" in the database so we can see independently
whether posting succeeded vs. whether metrics collection succeeded. A failure in
Phase 1 does NOT prevent Phase 2 from running in the next execution -- but within a
single execution, a Phase 1 failure will exit early (before Phase 2 starts).
"""

import logging
import sys

# Database helpers for tracking cron runs and storing data
from core.database import log_cron_start, log_cron_finish, get_posts, upsert_metrics
# process_due_posts handles the logic of finding posts whose scheduled time has passed
# and calling the platform client to publish them
from core.scheduler import process_due_posts
# TikTok is the platform adapter -- it implements the PlatformBase interface
# (create_post, get_post_metrics, refresh_credentials, etc.)
from platforms.tiktok import TikTok

# Set up logging so we can see what happens when this script runs.
# The format includes timestamp, log level, and logger name, which makes it
# easy to debug issues in Render's log viewer.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


def main():
    # Create the TikTok platform client. This object knows how to talk to
    # the TikTok Content Posting API -- uploading videos, fetching metrics,
    # refreshing tokens, etc.
    client = TikTok()

    # -------------------------------------------------------------------------
    # PHASE 1: Publish due posts
    # -------------------------------------------------------------------------
    # We log a "cron run" in the database so the dashboard can show a history
    # of when this job ran and whether it succeeded or failed.
    run_id = log_cron_start(platform="tiktok", job_type="post")
    try:
        # OAuth tokens expire after a set time (TikTok access tokens last about
        # 24 hours). We MUST refresh credentials before making any API calls,
        # otherwise we'd get 401 Unauthorized errors. This exchanges our stored
        # refresh token for a fresh access token.
        client.refresh_credentials()

        # process_due_posts queries the database for TikTok posts whose
        # scheduled_time has passed and status is still "scheduled", then
        # publishes each one via the TikTok API. Returns the count of
        # posts that were processed.
        processed = process_due_posts(client, "tiktok")

        # Record this cron run as successful in the database
        log_cron_finish(run_id, status="success", posts_processed=processed)
        logger.info("Posting complete: %d posts processed", processed)
    except Exception as e:
        logger.error("Posting failed: %s", e)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        # sys.exit(1) terminates the script with exit code 1 (non-zero = failure).
        # This is important because Render monitors exit codes -- a non-zero exit
        # tells Render the job failed, which can trigger alerts and shows as a
        # failure in the Render dashboard. Exit code 0 means success.
        sys.exit(1)

    # -------------------------------------------------------------------------
    # PHASE 2: Pull metrics for published posts
    # -------------------------------------------------------------------------
    # This is a separate cron run record because we want to track posting and
    # metrics collection independently. If metrics fail, we still want to know
    # that posting succeeded (and vice versa in future runs).
    run_id = log_cron_start(platform="tiktok", job_type="metrics")
    try:
        # Fetch up to 50 posts that have already been published to TikTok.
        # We limit to 50 to avoid hitting API rate limits -- TikTok has
        # quotas on how many API calls you can make per day.
        posts = get_posts(platform="tiktok", status="published", limit=50)
        for post in posts:
            # We check for platform_post_id because a post might be marked as
            # "published" in our database but not yet have a TikTok video ID.
            # This can happen if the post was partially processed (e.g., uploaded
            # to TikTok but the ID wasn't saved due to a crash). Without a
            # TikTok video ID, we can't ask the API for metrics -- we wouldn't
            # know which video to ask about.
            if post.get("platform_post_id"):
                # Ask TikTok's API for current engagement data (views, likes,
                # comments, shares, etc.) and store the snapshot in our database.
                snapshot = client.get_post_metrics(post["platform_post_id"])
                upsert_metrics(post["id"], snapshot)
        log_cron_finish(run_id, status="success", posts_processed=len(posts))
        logger.info("Metrics pull complete: %d posts updated", len(posts))
    except Exception as e:
        logger.error("Metrics pull failed: %s", e)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        # Same as above -- exit with code 1 so Render knows this run failed.
        sys.exit(1)


# This is Python's standard entry-point guard. It means "only run main() when
# this file is executed directly (e.g., `python tiktok_cron.py`), NOT when it's
# imported as a module by another file." This is a Python convention that keeps
# the script from accidentally running when imported elsewhere.
if __name__ == "__main__":
    main()

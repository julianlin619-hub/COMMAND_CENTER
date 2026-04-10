"""
LinkedIn cron job entry point.

This is a "cron job" -- a scheduled background task that runs automatically on a
timer (every 4 hours via Render's cron scheduler). It is NOT triggered by a user
clicking something in the dashboard. Instead, Render runs this script on a fixed
schedule, like an alarm clock that goes off every 4 hours.

The dashboard and this cron job never talk to each other directly. They communicate
through the Supabase database: the dashboard writes posts/schedules into the DB,
and this cron job reads them out and publishes them to LinkedIn.

This script publishes posts that are due to be sent to LinkedIn.
"""

import logging
import sys

# Database helpers for tracking cron runs and storing data
from core.database import log_cron_start, log_cron_finish
# process_due_posts handles the logic of finding posts whose scheduled time has passed
# and calling the platform client to publish them
from core.scheduler import process_due_posts
# LinkedIn is the platform adapter -- it implements the PlatformBase interface
# (create_post, refresh_credentials, etc.)
from platforms.linkedin import LinkedIn

# Set up logging so we can see what happens when this script runs.
# The format includes timestamp, log level, and logger name, which makes it
# easy to debug issues in Render's log viewer.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


def main():
    # Create the LinkedIn platform client. This object knows how to talk to
    # the LinkedIn API -- creating posts, fetching analytics, refreshing tokens, etc.
    client = LinkedIn()

    # -------------------------------------------------------------------------
    # PHASE 1: Publish due posts
    # -------------------------------------------------------------------------
    # We log a "cron run" in the database so the dashboard can show a history
    # of when this job ran and whether it succeeded or failed.
    run_id = log_cron_start(platform="linkedin", job_type="post")
    try:
        try:
            client.refresh_credentials()
        except Exception as e:
            logger.error("Credential refresh failed — aborting run: %s", e)
            log_cron_finish(run_id, status="failed", error_message=f"Credential refresh failed: {e}")
            sys.exit(1)

        processed = process_due_posts(client, "linkedin")

        log_cron_finish(run_id, status="success", posts_processed=processed)
        logger.info("Posting complete: %d posts processed", processed)
    except Exception as e:
        logger.error("Posting failed: %s", e)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)



# This is Python's standard entry-point guard. It means "only run main() when
# this file is executed directly (e.g., `python linkedin_cron.py`), NOT when it's
# imported as a module by another file." This is a Python convention that keeps
# the script from accidentally running when imported elsewhere.
if __name__ == "__main__":
    main()

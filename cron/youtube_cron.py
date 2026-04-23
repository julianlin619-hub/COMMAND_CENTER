"""
YouTube cron job entry point.

This is a "cron job" -- a scheduled background task that runs automatically on a
timer (once a day at 10:00 UTC via Render's cron scheduler). It is NOT triggered
by a user clicking something in the dashboard. Instead, Render runs this script
on a fixed schedule, like an alarm clock that goes off once a day.

The dashboard and this cron job never talk to each other directly. They
communicate through the Supabase database: the dashboard reads posts rows written
by this cron; this cron reads YouTube directly and writes posts rows back.

Studio-first workflow: the operator manually bulk-uploads videos to YouTube
Studio as Private drafts. Once a day, this cron discovers the earliest drafts,
cleans each title (regex strip + Claude Sonnet semantic pass), and schedules up
to 10 of them into fixed publish slots over the next 24 hours. Direct uploads
via videos.insert are NOT performed — see core.youtube_studio_scheduler for the
full flow and quota-math reasoning.
"""

import logging
import os
import sys

from core.database import log_cron_finish, log_cron_start
from core.env_diag import log_env_diagnostics
from core.youtube_studio_scheduler import schedule_studio_drafts
from platforms.youtube import YouTube

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)


def main():
    # Log env-var presence first so the UI output pane shows whether the
    # subprocess inherited every var this pipeline depends on. Optional vars
    # are allowed to be missing — they change behavior but don't block the run.
    log_env_diagnostics(
        "youtube-cron",
        required=[
            "SUPABASE_URL",
            "SUPABASE_SERVICE_KEY",
            "YOUTUBE_CLIENT_ID",
            "YOUTUBE_CLIENT_SECRET",
            "YOUTUBE_REFRESH_TOKEN",
        ],
        optional=[
            # Flip to "1" to log the videos.update payload without writing.
            "YOUTUBE_STUDIO_DRY_RUN",
            # Override the 30-minute lead time (rarely needed).
            "YOUTUBE_STUDIO_MIN_LEAD_MINUTES",
            # If set, validate_credentials asserts the owned channel matches.
            "YOUTUBE_CHANNEL_ID",
            # Used by the title cleaner to call Claude Sonnet. Missing = regex-only cleanup.
            "ANTHROPIC_API_KEY",
        ],
    )

    client = YouTube()
    dry_run = os.environ.get("YOUTUBE_STUDIO_DRY_RUN") == "1"

    run_id = log_cron_start(platform="youtube", job_type="studio_schedule")
    try:
        try:
            client.refresh_credentials()
        except Exception as e:
            logger.error("Credential refresh failed — aborting run: %s", e, exc_info=True)
            log_cron_finish(
                run_id, status="failed", error_message=f"Credential refresh failed: {e}"
            )
            sys.exit(1)

        summary = schedule_studio_drafts(client, dry_run=dry_run)

        log_cron_finish(
            run_id, status="success", posts_processed=len(summary.scheduled)
        )
        logger.info(
            "Studio-schedule complete: scheduled=%d skipped=%d backlog=%d quota_used=%d dry_run=%s",
            len(summary.scheduled),
            len(summary.skipped),
            summary.backlog,
            summary.quota_used,
            summary.dry_run,
        )
    except Exception as e:
        logger.error("Studio-schedule run failed: %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)


# This is Python's standard entry-point guard. It means "only run main() when
# this file is executed directly (e.g., `python -m cron.youtube_cron`), NOT
# when it's imported as a module by another file."
if __name__ == "__main__":
    main()

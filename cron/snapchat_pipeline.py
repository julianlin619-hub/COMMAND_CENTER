"""Snapchat publisher cron — claims due schedules and posts via Playwright.

This script runs hourly on Render at `:05` UTC. It does the publish half
of the Snapchat pipeline:
  - Reads `schedules` rows that are due (scheduled_for <= now, picked_up_at IS NULL).
  - Atomically claims each row, calls platforms.snapchat.Snapchat.create_post(),
    and transitions the post to 'published' or 'failed'.

The generator half — picking a tweet, rendering the MP4, uploading to
Storage, and inserting the `posts` + `schedules` rows — lives in the
dashboard's `/api/snapchat-pipeline` route. The two halves never talk
directly; they communicate only via Supabase, satisfying the CLAUDE.md
cross-service contract.

Modelled on the publish phase of `cron/threads_cron.py` rather than the
multi-phase `cron/tiktok_pipeline.py` because this script does exactly
one thing: drain the due queue.
"""

import logging
import sys

from core.database import log_cron_finish, log_cron_start
from core.env_diag import log_env_diagnostics
from core.scheduler import process_due_posts
from platforms.snapchat import Snapchat

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def main() -> None:
    # Surface env-var presence first so the dashboard UI's output pane shows
    # whether the cron container actually received what it needs. Same
    # pattern every other cron uses; install_log_sanitizer wires itself up
    # via this call too.
    log_env_diagnostics(
        "snapchat-pipeline",
        required=[
            "SUPABASE_URL",
            "SUPABASE_SERVICE_KEY",
            "SNAPCHAT_PROFILE_URL",
        ],
    )

    client = Snapchat()
    # validate_config raises ValueError with a list of missing env vars if
    # any required ones are absent. We let it bubble — the log_env_diagnostics
    # above will have already flagged the issue, and the cron_runs row we're
    # about to write would be misleading if we silently proceeded.
    client.validate_config()

    run_id = log_cron_start(platform="snapchat", job_type="post")
    try:
        processed = process_due_posts(client, "snapchat")
        log_cron_finish(run_id, status="success", posts_processed=processed)
        logger.info("Snapchat publish complete: %d posts processed", processed)
    except Exception as e:
        # process_due_posts already catches per-post exceptions and stamps
        # the post failed. A bubble-up here means something broke before the
        # per-post loop (DB unreachable, Playwright import failed, etc.).
        # Use the adapter's sanitiser so any Snap cookie that snuck into
        # the exception text doesn't end up in cron_runs.error_message —
        # belt-and-suspenders since database.log_cron_finish also sanitises.
        safe_msg = client.sanitize_error(e)
        logger.error("Snapchat publish failed: %s", safe_msg, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=safe_msg)
        sys.exit(1)


if __name__ == "__main__":
    main()

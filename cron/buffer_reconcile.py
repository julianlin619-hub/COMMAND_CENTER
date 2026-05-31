"""Buffer reconciliation — periodic cron job.

Closes a visibility gap in the publishing pipeline. When we send a post to
Buffer, `send_to_buffer` returns as soon as Buffer *accepts* it into the
queue — it stamps `posts.platform_post_id` but leaves `status='sent_to_buffer'`
and never checks back. So a post that Buffer later fails to publish (e.g. its
media URL expired before Buffer fetched it, or the platform rejected it) shows
"An unknown error has occurred" in Buffer's own dashboard while OUR dashboard
still shows it as handed-off — the failure is invisible to us.

This cron polls Buffer for every unconfirmed handoff and resolves each:

  - published   → status='published', published_at mirrored from Buffer sentAt
  - failed      → status='buffer_error' with the Buffer status as the reason,
                  so it surfaces in the dashboard (and drops out of the dedup
                  index, letting a future pipeline run re-send the caption)
  - still queued → left alone, re-checked next run

It is intentionally surface-only: it does not re-send failed posts (a true
retry needs the original Buffer payload, which isn't fully reconstructable from
the row today — see the plan's "Retry" follow-up). Modeled on
cron/tiktok_storage_cleanup.py, which already polls Buffer per post.

Run locally with:  python -m cron.buffer_reconcile
"""

import logging
import sys

from core.buffer import get_buffer_post_state
from core.database import (
    get_posts_awaiting_buffer_confirmation,
    log_cron_finish,
    log_cron_start,
    update_post,
)
from core.env_diag import log_env_diagnostics


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def _is_failure_status(status: str | None) -> bool:
    """True if Buffer's post status indicates a publish failure.

    Buffer's PostStatus enum isn't fully documented and may gain values, so we
    match defensively on substrings ('error'/'fail') rather than an exact set.
    Known non-failure statuses ('sent', 'draft', 'buffer'/queued) don't match.
    """
    if not status:
        return False
    s = status.lower()
    return "error" in s or "fail" in s


def main() -> None:
    log_env_diagnostics(
        "buffer-reconcile",
        required=[
            "SUPABASE_URL",
            "SUPABASE_SERVICE_KEY",
            "BUFFER_ACCESS_TOKEN",
            "BUFFER_ORG_ID",
        ],
    )

    run_id = log_cron_start(platform="buffer", job_type="reconcile")

    try:
        posts = get_posts_awaiting_buffer_confirmation()
        logger.info("Found %d post(s) awaiting Buffer confirmation", len(posts))

        published = 0
        failed = 0
        still_queued = 0
        errors = 0

        for post in posts:
            post_id = post["id"]
            buffer_id = post.get("platform_post_id")
            try:
                state = get_buffer_post_state(buffer_id)

                # Buffer has no record of this id (deleted/unknown). Leave the
                # row as-is and log — flipping it either way would be a guess.
                if state is None:
                    logger.warning(
                        "Post %s (%s): Buffer has no record of %s — skipping",
                        post_id, post.get("platform"), buffer_id,
                    )
                    still_queued += 1
                    continue

                sent_at = state["sentAt"]
                status = state["status"]

                if sent_at is not None:
                    # Published. Mirror Buffer's publish time into our row.
                    update_post(
                        post_id,
                        status="published",
                        published_at=sent_at.isoformat(),
                    )
                    published += 1
                    logger.info(
                        "Post %s (%s): published at %s",
                        post_id, post.get("platform"), sent_at.isoformat(),
                    )
                elif _is_failure_status(status):
                    # Buffer-side failure. Surface it so it's visible in the
                    # dashboard. error_message is auto-sanitized by update_post.
                    update_post(
                        post_id,
                        status="buffer_error",
                        error_message=f"Buffer reported status '{status}'",
                    )
                    failed += 1
                    logger.warning(
                        "Post %s (%s): Buffer-side failure (status=%s)",
                        post_id, post.get("platform"), status,
                    )
                else:
                    # Still in Buffer's queue (e.g. status 'buffer'/'pending').
                    still_queued += 1

            except Exception as e:
                # Per-post isolation: one bad post must not abort the run.
                # Next run retries it cleanly.
                logger.error(
                    "Failed to reconcile post %s (Buffer %s): %s",
                    post_id, buffer_id, e, exc_info=True,
                )
                errors += 1
                continue

        logger.info(
            "Reconcile: %d published, %d failed, %d still queued, %d errors",
            published, failed, still_queued, errors,
        )

        final_status = "success" if errors == 0 else "failed"
        error_msg = f"{errors} post(s) errored during reconcile" if errors else None
        log_cron_finish(
            run_id,
            status=final_status,
            posts_processed=published + failed,
            error_message=error_msg,
        )

    except Exception as e:
        logger.error("buffer-reconcile crashed: %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()

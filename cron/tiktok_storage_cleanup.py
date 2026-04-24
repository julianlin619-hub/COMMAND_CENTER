"""Manual-upload storage cleanup — daily cron job.

Runs daily at 03:00 UTC to reclaim Supabase Storage for manually-uploaded
videos whose Buffer queue entries have already published. The posts
themselves stay live on their platforms — only the source mp4 in Supabase
Storage is removed, 3 days after Buffer confirms every queued copy is live.

Each manual upload writes one `posts` row per fan-out target (currently
`platform='tiktok'` and `platform='youtube'`) pointing at the SAME storage
path. This cron groups rows by storage path and only deletes the file once
every row in the group is both published (Buffer sentAt set) AND past its
3-day retention window. Per-row `published_at` is still mirrored from
Buffer's sentAt as soon as the post goes live, so the posts view reflects
publish state before the file is collected.

Scan predicate per row:
  metadata->>'source'         = 'manual_upload'
  metadata->>'storage_cleanup_status' = 'pending'
  platform                    in ('tiktok','youtube')

Idempotency: a row flips to `done` only after the Storage delete succeeds
(or the row has no media_urls to delete). A failed Storage call leaves the
whole group `pending` and tomorrow's run retries.
"""

import logging
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from core.buffer import get_buffer_post_sent_at
from core.database import (
    get_client,
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

MANUAL_UPLOAD_PLATFORMS = ("tiktok", "youtube")
RETENTION = timedelta(days=3)


def main():
    log_env_diagnostics(
        "tiktok-storage-cleanup",
        required=[
            "SUPABASE_URL",
            "SUPABASE_SERVICE_KEY",
            "BUFFER_ACCESS_TOKEN",
            "BUFFER_ORG_ID",
        ],
    )

    run_id = log_cron_start(platform="tiktok", job_type="storage_cleanup")

    try:
        client = get_client()
        rows = (
            client.table("posts")
            .select("id, platform, media_urls, metadata, published_at")
            .in_("platform", list(MANUAL_UPLOAD_PLATFORMS))
            .filter("metadata->>source", "eq", "manual_upload")
            .filter("metadata->>storage_cleanup_status", "eq", "pending")
            .execute()
            .data
        )
        logger.info("Found %d manual-upload row(s) pending cleanup", len(rows))

        # Group rows by storage path. Every fan-out target for a single upload
        # shares the same media_urls[0], so the group is the unit that decides
        # when we can delete the file.
        groups: dict[str, list[dict]] = defaultdict(list)
        orphan_rows: list[dict] = []
        for row in rows:
            media_urls = row.get("media_urls") or []
            if not media_urls:
                orphan_rows.append(row)
                continue
            groups[media_urls[0]].append(row)

        processed_groups = 0
        skipped_queued = 0
        skipped_retention = 0
        errors = 0

        # Orphan rows (no media_urls) — nothing to delete, just flip the flag
        # so we stop scanning them forever.
        for row in orphan_rows:
            logger.warning("Row %s has no media_urls — marking cleanup done", row["id"])
            try:
                _mark_done(row)
            except Exception as e:
                logger.error("Failed to flip cleanup_status on orphan %s: %s",
                             row["id"], e, exc_info=True)
                errors += 1

        for storage_path, group in groups.items():
            try:
                result = _process_group(client, storage_path, group)
            except Exception as e:
                logger.error("Group %s failed: %s", storage_path, e, exc_info=True)
                errors += 1
                continue

            if result == "deleted":
                processed_groups += 1
            elif result == "queued":
                skipped_queued += 1
            elif result == "retention":
                skipped_retention += 1
            elif result == "error":
                errors += 1

        logger.info(
            "Cleanup complete: %d group(s) cleaned, %d awaiting publish, "
            "%d within 3d retention, %d errors",
            processed_groups, skipped_queued, skipped_retention, errors,
        )
        final_status = "success" if errors == 0 else "failed"
        error_msg = f"{errors} item(s) failed" if errors else None
        log_cron_finish(
            run_id, status=final_status,
            posts_processed=processed_groups, error_message=error_msg,
        )

    except Exception as e:
        logger.error("tiktok-storage-cleanup crashed: %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)


def _process_group(client, storage_path: str, group: list[dict]) -> str:
    """Resolve one storage-path group. Returns a one-word status for tallies.

    Returns:
        "deleted"   — file removed, all rows flipped to done.
        "queued"    — at least one row still has no Buffer sentAt yet.
        "retention" — all published, but the newest sentAt is <3d old.
        "error"     — partial failure; see logged details.
    """
    # Fetch sentAt for every row's Buffer post. If any row raises, bubble up —
    # main() logs once and skips the group; tomorrow's run retries cleanly.
    sent_times: list[datetime] = []
    for row in group:
        metadata = row.get("metadata") or {}
        buffer_id = metadata.get("buffer_post_id")
        if not buffer_id:
            logger.warning("Row %s (%s) has no buffer_post_id — skipping group %s",
                           row["id"], row.get("platform"), storage_path)
            return "error"

        sent_at = get_buffer_post_sent_at(buffer_id)

        # Mirror sentAt into posts.published_at the first time we see it set,
        # independent of whether the group is ready to delete — this keeps the
        # posts view in sync with Buffer's publish state as soon as it flips.
        if sent_at is not None and not row.get("published_at"):
            update_post(
                row["id"],
                status="published",
                published_at=sent_at.isoformat(),
            )

        if sent_at is None:
            return "queued"
        sent_times.append(sent_at)

    # Every row is published. The file can go once the LATEST sentAt is 3+
    # days old — otherwise a copy that just published would lose its source
    # before it could re-serve (Buffer already has the video, but we keep
    # the 3-day grace window in case of post deletion + re-queue recovery).
    newest = max(sent_times)
    age = datetime.now(timezone.utc) - newest
    if age < RETENTION:
        logger.info(
            "Group %s: all published, newest is %s old — waiting for %s retention",
            storage_path, age, RETENTION,
        )
        return "retention"

    # Delete the file once, then flip every row's cleanup_status to done.
    try:
        client.storage.from_("media").remove([storage_path])
    except Exception as e:
        logger.error("Storage delete failed for %s: %s", storage_path, e, exc_info=True)
        return "error"

    any_flip_error = False
    for row in group:
        try:
            _mark_done(row)
        except Exception as e:
            logger.error("Failed to flip cleanup_status=done on %s: %s",
                         row["id"], e, exc_info=True)
            any_flip_error = True

    if any_flip_error:
        # File is already deleted; leaving some rows pending is harmless —
        # next run sees empty media_urls from Storage and flips via the
        # orphan branch.
        return "error"

    logger.info(
        "Group %s: deleted %s, flipped %d row(s) to done",
        storage_path, storage_path, len(group),
    )
    return "deleted"


def _mark_done(row: dict) -> None:
    metadata = row.get("metadata") or {}
    new_metadata = {
        **metadata,
        "storage_cleanup_status": "done",
        "cleaned_at": datetime.now(timezone.utc).isoformat(),
    }
    update_post(row["id"], metadata=new_metadata)


if __name__ == "__main__":
    main()

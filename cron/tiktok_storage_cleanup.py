"""Manual-upload storage cleanup — daily cron job.

Runs daily at 03:00 UTC. Two responsibilities, both scoped to the
TikTok manual-upload pathway (Pathway 3):

  1. Group cleanup (the original behaviour). Reclaim Supabase Storage
     for manually-uploaded videos whose Buffer queue entries have
     already published. Each manual upload writes one `posts` row per
     fan-out target (currently tiktok / youtube / linkedin) pointing
     at the SAME storage path; the file is deleted 3 days after Buffer
     confirms every queued copy is live. Per-row `published_at` is
     mirrored from Buffer's sentAt as soon as the post goes live so
     the posts view reflects publish state before the file is reaped.

     Scan predicate per row:
       metadata->>'source'                 = 'manual_upload'
       metadata->>'storage_cleanup_status' = 'pending'
       platform                            in ('tiktok','youtube','linkedin')

     Idempotency: a row flips to `done` only after the Storage delete
     succeeds (or the row has no media_urls to delete). A failed
     Storage call leaves the whole group `pending` and tomorrow's run
     retries.

  2. Orphan cleanup (added to fix #56). Sweep Storage objects under
     `media/tiktok/manual/<userId>/` that no `posts` row references.
     These accumulate when the user cancels an in-progress upload in
     the queue UI: the finalize step never ran, so no `posts` row was
     written, so the group-cleanup path can't see them. We list the
     bucket, build the set of paths claimed by any posts row, and
     delete unclaimed objects older than ORPHAN_TTL. The 24h grace
     window is there so a genuinely-in-progress upload isn't reaped
     before its finalize call lands.
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

MANUAL_UPLOAD_PLATFORMS = ("tiktok", "youtube", "linkedin")
RETENTION = timedelta(days=7)

# Storage prefix that the dashboard's sign-url route mints paths under.
# Format: `tiktok/manual/<userId>/<uuid>.<ext>`. Orphan cleanup walks the
# bucket from this root.
MANUAL_UPLOAD_PREFIX = "tiktok/manual"

# Don't reap objects newer than this — gives a legitimate in-flight
# upload (sign-url -> PUT -> finalize) plenty of time to write its
# posts row. 24h is conservative: a 2GB video on a slow connection
# might upload for an hour, but a day is overkill on the safe side.
ORPHAN_TTL = timedelta(hours=24)

# Bucket name. Centralised because both _process_group and
# _cleanup_orphans touch the same bucket.
BUCKET = "media"


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
            "Group cleanup: %d group(s) cleaned, %d awaiting publish, "
            "%d within 3d retention, %d errors",
            processed_groups, skipped_queued, skipped_retention, errors,
        )

        # Orphan sweep — best-effort. If it fails, the group cleanup
        # above still counts as successful; orphans just live another
        # day.
        orphan_counts = _cleanup_orphans(client)
        logger.info(
            "Orphan cleanup: %d deleted, %d skipped (< %s old), %d errors",
            orphan_counts["deleted"],
            orphan_counts["skipped_recent"],
            ORPHAN_TTL,
            orphan_counts["errors"],
        )

        total_errors = errors + orphan_counts["errors"]
        final_status = "success" if total_errors == 0 else "failed"
        error_msg = f"{total_errors} item(s) failed" if total_errors else None
        log_cron_finish(
            run_id, status=final_status,
            posts_processed=processed_groups + orphan_counts["deleted"],
            error_message=error_msg,
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
        #
        # update_post() now raises RuntimeError on a zero-row UPDATE (missing
        # row, RLS rejection, transient outage). Without this guard, a single
        # bad row would abort _process_group via main()'s except clause, mark
        # the whole group as errored, and prevent the file from being deleted
        # even though every OTHER row in the group is in good shape. Treat
        # the mirror as best-effort: log, continue with the publish check,
        # and let tomorrow's run retry the same row.
        if sent_at is not None and not row.get("published_at"):
            try:
                update_post(
                    row["id"],
                    status="published",
                    published_at=sent_at.isoformat(),
                )
            except RuntimeError as e:
                logger.warning(
                    "Could not mirror sentAt to post %s (%s): %s — continuing; tomorrow's run will retry",
                    row["id"], row.get("platform"), e,
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


def _cleanup_orphans(client) -> dict:
    """Delete Storage objects under tiktok/manual/<userId>/* that no
    posts row references and that are older than ORPHAN_TTL.

    This is the cleanup path for cancelled uploads from the queue UI:
    the user aborts mid-PUT, the finalize step never runs, so no
    posts row is written and the regular group cleanup can't see the
    file. Without this, cancelled uploads accumulate forever.

    Strategy:
      1. Build the "claimed" set: every path that appears in any
         posts.media_urls. Doing this in one SELECT (rather than a
         per-file existence check) keeps the work O(N+M) instead of
         O(N*M).
      2. Walk the bucket starting at MANUAL_UPLOAD_PREFIX. Supabase
         Storage's list() is shallow, so we list user directories
         first and then list files within each.
      3. For each file: if its path is in the claimed set, skip;
         else if its createdAt is within ORPHAN_TTL, skip (might be
         in flight); else delete.

    Returns counters {"deleted", "skipped_recent", "errors"} so main()
    can fold them into the cron run summary.
    """
    counters = {"deleted": 0, "skipped_recent": 0, "errors": 0}

    # Step 1: build claimed set from ALL posts.media_urls. We don't
    # filter by source/platform/status — any reference is enough to
    # protect the file. Cheap query: one column, no joins.
    try:
        rows = client.table("posts").select("media_urls").execute().data
    except Exception as e:
        logger.error("Orphan cleanup: failed to fetch claimed paths: %s",
                     e, exc_info=True)
        counters["errors"] += 1
        return counters

    claimed: set[str] = set()
    for row in rows:
        for path in (row.get("media_urls") or []):
            if isinstance(path, str):
                claimed.add(path)
    logger.info("Orphan cleanup: %d claimed path(s) protected", len(claimed))

    # Step 2: enumerate user directories under MANUAL_UPLOAD_PREFIX.
    try:
        user_dirs = client.storage.from_(BUCKET).list(MANUAL_UPLOAD_PREFIX)
    except Exception as e:
        logger.error("Orphan cleanup: failed to list %s: %s",
                     MANUAL_UPLOAD_PREFIX, e, exc_info=True)
        counters["errors"] += 1
        return counters

    cutoff = datetime.now(timezone.utc) - ORPHAN_TTL

    for entry in user_dirs:
        # Supabase Storage returns a synthetic placeholder ("emptyFolderPlaceholder")
        # for directories that exist only as a path prefix. Real
        # directories show up with id=None; files have id != None.
        # We want to recurse into directories regardless of which
        # case applies, so just try-list and ignore failures.
        user_name = entry.get("name")
        if not user_name or user_name == ".emptyFolderPlaceholder":
            continue
        user_path = f"{MANUAL_UPLOAD_PREFIX}/{user_name}"

        try:
            files = client.storage.from_(BUCKET).list(user_path)
        except Exception as e:
            logger.error("Orphan cleanup: failed to list %s: %s",
                         user_path, e, exc_info=True)
            counters["errors"] += 1
            continue

        for f in files:
            name = f.get("name")
            if not name or name == ".emptyFolderPlaceholder":
                continue
            full_path = f"{user_path}/{name}"

            if full_path in claimed:
                continue

            # Parse createdAt. Supabase returns ISO-8601 with a Z
            # suffix; fromisoformat() needs +00:00 prior to Python
            # 3.11. We accept either via the replace().
            created_raw = f.get("created_at") or f.get("createdAt")
            if not created_raw:
                logger.warning(
                    "Orphan cleanup: %s has no createdAt — skipping",
                    full_path,
                )
                continue
            try:
                created = datetime.fromisoformat(
                    created_raw.replace("Z", "+00:00")
                )
            except ValueError as e:
                logger.warning(
                    "Orphan cleanup: %s has bad createdAt %r: %s",
                    full_path, created_raw, e,
                )
                continue

            if created > cutoff:
                counters["skipped_recent"] += 1
                continue

            try:
                client.storage.from_(BUCKET).remove([full_path])
                counters["deleted"] += 1
                age = datetime.now(timezone.utc) - created
                logger.info(
                    "Orphan cleanup: deleted %s (age=%s)",
                    full_path, age,
                )
            except Exception as e:
                logger.error(
                    "Orphan cleanup: failed to delete %s: %s",
                    full_path, e, exc_info=True,
                )
                counters["errors"] += 1

    return counters


if __name__ == "__main__":
    main()

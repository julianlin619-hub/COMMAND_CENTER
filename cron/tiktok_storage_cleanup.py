"""TikTok manual-upload storage cleanup — daily cron job.

Runs daily at 03:00 UTC to reclaim Supabase Storage for manually-uploaded
TikTok videos whose Buffer queue entry has already published. The TikTok
post itself stays live on TikTok — only the source mp4 in Supabase Storage
is removed, 3 days after Buffer confirms the publish.

Flow per eligible row (platform='tiktok', metadata.source='manual_upload',
metadata.storage_cleanup_status='pending'):
  1. Ask Buffer for the post (GraphQL) → read `sentAt`.
  2. If `sentAt` is null, the post is still queued — skip.
  3. If `posts.published_at` is still null, mirror Buffer's `sentAt` into
     `published_at` and flip status to 'published'.
  4. If now() - sentAt >= 3 days, delete the mp4 from Storage and flip
     `metadata.storage_cleanup_status='done'` (with `cleaned_at` stamp).

Idempotency: a row only flips to `done` after the Storage delete succeeds.
A failed Storage call leaves the row `pending` and tomorrow's run retries.
"""

import logging
import sys
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
            .select("id, media_urls, metadata, published_at")
            .eq("platform", "tiktok")
            .filter("metadata->>source", "eq", "manual_upload")
            .filter("metadata->>storage_cleanup_status", "eq", "pending")
            .execute()
            .data
        )
        logger.info("Found %d manual-upload row(s) pending cleanup", len(rows))

        processed = 0
        skipped_queued = 0
        errors = 0

        for row in rows:
            metadata = row.get("metadata") or {}
            buffer_id = metadata.get("buffer_post_id")
            if not buffer_id:
                logger.warning("Row %s has no buffer_post_id in metadata — skipping", row["id"])
                errors += 1
                continue

            try:
                sent_at = get_buffer_post_sent_at(buffer_id)
            except Exception as e:
                logger.error("Buffer lookup failed for post %s (buffer %s): %s",
                             row["id"], buffer_id, e, exc_info=True)
                errors += 1
                continue

            if sent_at is None:
                # Still queued in Buffer — nothing to do yet.
                skipped_queued += 1
                continue

            # Mirror sentAt into posts.published_at the first time we see it set.
            # Doing this as a single update_post keeps status and timestamp in sync.
            if not row.get("published_at"):
                try:
                    update_post(
                        row["id"],
                        status="published",
                        published_at=sent_at.isoformat(),
                    )
                except Exception as e:
                    logger.error("Failed to mark post %s published: %s", row["id"], e, exc_info=True)
                    errors += 1
                    continue

            # 3-day retention. Buffer is the source of truth — we re-read sentAt
            # each run instead of trusting a stale published_at.
            age = datetime.now(timezone.utc) - sent_at
            if age < timedelta(days=3):
                logger.info(
                    "Row %s published %s ago — waiting until 3 days elapse",
                    row["id"], age,
                )
                continue

            media_urls = row.get("media_urls") or []
            if not media_urls:
                logger.warning("Row %s has no media_urls — marking cleanup done", row["id"])
            else:
                try:
                    client.storage.from_("media").remove(media_urls)
                except Exception as e:
                    logger.error("Storage delete failed for %s: %s", media_urls, e, exc_info=True)
                    errors += 1
                    continue

            new_metadata = {
                **metadata,
                "storage_cleanup_status": "done",
                "cleaned_at": datetime.now(timezone.utc).isoformat(),
            }
            try:
                update_post(row["id"], metadata=new_metadata)
                processed += 1
                logger.info("Cleaned up storage for post %s (%s)", row["id"], media_urls)
            except Exception as e:
                logger.error("Failed to flip cleanup_status=done on %s: %s", row["id"], e, exc_info=True)
                errors += 1

        logger.info(
            "Cleanup complete: %d cleaned, %d still queued, %d errors",
            processed, skipped_queued, errors,
        )
        final_status = "success" if errors == 0 else "failed"
        error_msg = f"{errors} item(s) failed" if errors else None
        log_cron_finish(
            run_id, status=final_status,
            posts_processed=processed, error_message=error_msg,
        )

    except Exception as e:
        logger.error("tiktok-storage-cleanup crashed: %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()

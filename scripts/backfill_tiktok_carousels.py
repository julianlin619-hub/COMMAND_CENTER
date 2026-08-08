"""One-off backfill: queue every prior Instagram carousel to TikTok.

The instagram-carousel pipeline gained a TikTok mirror leg (see
_send_tiktok_carousel in cron/instagram_carousel_pipeline.py) — this
script back-fills the carousels that shipped to Instagram BEFORE that
leg existed, so the TikTok channel starts with the full "Day N" series.

For each live IG carousel row (status not failed/buffer_error), oldest
day first so TikTok publishes the series in order:
  1. skip if a tiktok row with the same TITLE already exists. The TikTok
     row's dedup caption is the title ("... (Day N)", unique per day),
     NOT slide 2's tweet text — the retired tweet-reel pipeline filled
     platform='tiktok' rows with tweet texts, and keying on the tweet
     would wrongly block carousels whose slide-2 tweet once shipped as
     a reel (a 10-slide carousel is not the same content);
  2. insert a platform='tiktok' posts row reusing the SAME storage
     paths and metadata (source='carousel', day, tweet_ids);
  3. send ONE Buffer createPost with one image asset per slide —
     Buffer publishes this on a TikTok channel as a photo-mode
     carousel, and TikTok auto-applies a music track (Buffer's API has
     no music-selection field);
  4. record the replay payload so buffer_reconcile can confirm/retry.

Buffer picks the queue slots (schedulingType=automatic), so N carousels
land in the channel's next N posting slots rather than all at once.
Sends are paced 2s apart to stay clear of Buffer's shared rate window
(same spacing buffer_reconcile uses).

NOT registered in render.yaml — run manually from the repo root:
    python scripts/backfill_tiktok_carousels.py            # real run
    DRY_RUN=1 python scripts/backfill_tiktok_carousels.py  # print only
    LIMIT=1 python scripts/backfill_tiktok_carousels.py    # first N only
"""

import logging
import os
import sys
import time

from core.buffer import get_channel_id, send_to_buffer
from core.database import (
    get_client,
    insert_post,
    post_caption_exists,
    record_buffer_handoff,
    update_post,
)
from core.media import build_proxy_url
from core.models import Post
from cron._tweet_card_legs import BUFFER_CAPTION, _is_unique_violation

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

INTER_SEND_SLEEP_SECONDS = 2.0


def main() -> None:
    dry_run = os.environ.get("DRY_RUN", "") == "1"
    limit = int(os.environ.get("LIMIT", "0"))  # 0 = no limit

    rows = (
        get_client()
        .table("posts")
        .select("id,status,caption,media_urls,metadata")
        .eq("platform", "instagram")
        .eq("metadata->>source", "carousel")
        .execute()
        .data
        or []
    )
    live = [r for r in rows if r.get("status") not in ("failed", "buffer_error")]
    # Oldest day first so the TikTok queue publishes Day 1, Day 2, ... in
    # series order regardless of row creation order (a retried day ships
    # later than its number).
    live.sort(key=lambda r: int((r.get("metadata") or {}).get("day", 0)))
    logger.info("%d live Instagram carousels found", len(live))

    tiktok_channel_id = get_channel_id(service="tiktok")
    logger.info("TikTok Buffer channel: %s", tiktok_channel_id)

    queued = skipped = failed = attempted = 0
    for row in live:
        # LIMIT counts ATTEMPTS (sends tried), not successes — otherwise a
        # failing run would plow through every row despite the cap.
        if limit and attempted >= limit:
            logger.info("LIMIT=%d reached — stopping", limit)
            break

        metadata = row.get("metadata") or {}
        day = metadata.get("day")
        # Title as the TikTok dedup key (see module docstring); the IG
        # row's slide-2 caption is the fallback for any row without one.
        caption = metadata.get("title") or row.get("caption") or ""
        storage_paths = row.get("media_urls") or []

        if not caption.strip() or not storage_paths:
            logger.warning("Day %s: empty caption or no slides — skipping", day)
            skipped += 1
            continue

        # Cheap pre-check; the unique index below is still the arbiter.
        if post_caption_exists("tiktok", caption):
            logger.info("Day %s: already on TikTok — skipping", day)
            skipped += 1
            continue

        if dry_run:
            logger.info("DRY RUN — would queue Day %s (%d slides) to TikTok", day, len(storage_paths))
            queued += 1
            attempted += 1
            continue

        attempted += 1
        post = Post(
            platform="tiktok",
            status="sent_to_buffer",
            media_type="carousel",
            media_urls=storage_paths,
            caption=caption,
            metadata=metadata,
        )
        try:
            post_id = insert_post(post)
        except Exception as e:
            if _is_unique_violation(e):
                logger.info("Day %s: dedup race lost — skipping", day)
                skipped += 1
                continue
            logger.error("Day %s: insert failed: %s", day, e)
            failed += 1
            continue

        try:
            media_urls = [build_proxy_url(post_id, i) for i in range(len(storage_paths))]
            buffer_post_id = send_to_buffer(
                tiktok_channel_id, BUFFER_CAPTION, media_urls, media_type="image",
            )
            record_buffer_handoff(
                post_id, buffer_post_id,
                channel_id=tiktok_channel_id,
                body=BUFFER_CAPTION,
                media_type="image",
                base_metadata=metadata,
            )
            queued += 1
            logger.info(
                "Day %s: queued to TikTok (%d slides, post %s, Buffer %s)",
                day, len(storage_paths), post_id, buffer_post_id,
            )
        except Exception as e:
            logger.error("Day %s: Buffer send failed: %s", day, e)
            try:
                update_post(post_id, status="buffer_error", error_message=str(e)[:500])
            except Exception as db_err:
                logger.error("Day %s: also failed to mark buffer_error: %s", day, db_err)
            failed += 1

        time.sleep(INTER_SEND_SLEEP_SECONDS)

    logger.info("Done: %d queued, %d skipped, %d failed", queued, skipped, failed)
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()

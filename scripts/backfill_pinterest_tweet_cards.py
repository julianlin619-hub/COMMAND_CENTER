"""One-off backfill: queue every prior tweet card to Pinterest.

The Tweet Card fan-out gained a Pinterest leg (cron/_tweet_card_legs.py) —
this script back-fills the cards that shipped to Facebook/LinkedIn BEFORE
that leg existed, so the Pinterest queue starts with the full archive
instead of trickling in at cron pace.

Source of truth is the Facebook leg: every tweet card ever shipped has a
platform='facebook' posts row whose media_urls[0] is the rendered
1080×1080 PNG and whose caption is the tweet text — exactly the two
inputs the Pinterest leg reuses (LinkedIn rows reference the same bytes,
so reading them would only produce duplicates). For each live FB row
(status not failed/buffer_error), oldest first so Pinterest publishes the
archive in original posting order:
  1. skip if a pinterest row with the same caption already exists (the
     daily cron may have shipped it since the leg went live);
  2. reuse send_leg() from cron/_tweet_card_legs — the exact
     insert-row → proxy-URL → Buffer-send → replay-payload dance the
     cron runs, with the tweet text as the pin description and the
     configured board (PINTEREST_BOARD_NAME, default "Business Tactics").

Buffer picks the queue slots (schedulingType=automatic), so ~160 pins
land in the channel's next ~160 posting slots rather than all at once.

Pacing: sends sleep 10s apart. Buffer's rate window is ~100 requests per
rolling 15 minutes; at 6 sends/minute the full ~160-row archive stays
under it (90/15min) instead of slamming into RATE_LIMIT_EXCEEDED around
row 100 like a 2s pace would. A send that still reports rate limiting
stops the run — the un-attempted rows simply aren't inserted yet, so
re-running the script later resumes where it left off (and buffer_error
rows drop out of the dedup index, so the failed row retries too).

NOT registered in render.yaml — run manually from the repo root:
    python scripts/backfill_pinterest_tweet_cards.py            # real run
    DRY_RUN=1 python scripts/backfill_pinterest_tweet_cards.py  # print only
    LIMIT=5 python scripts/backfill_pinterest_tweet_cards.py    # first N only
"""

import logging
import os
import sys
import time

from core.buffer import get_channel_id, get_pinterest_board_service_id
from core.database import get_client, post_caption_exists
from cron._tweet_card_legs import (
    PINTEREST_CAPTION_LIMIT,
    pinterest_board_name,
    send_leg,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

# ~100 req / rolling 15 min shared window: 10s spacing = 90/15min, safely
# under the cap for the full archive in one run (see module docstring).
INTER_SEND_SLEEP_SECONDS = 10.0


def main() -> None:
    dry_run = os.environ.get("DRY_RUN", "") == "1"
    limit = int(os.environ.get("LIMIT", "0"))  # 0 = no limit

    rows = (
        get_client()
        .table("posts")
        .select("id,status,caption,media_urls,metadata,created_at")
        .eq("platform", "facebook")
        .order("created_at", desc=False)  # oldest first → archive in order
        .execute()
        .data
        or []
    )
    live = [r for r in rows if r.get("status") not in ("failed", "buffer_error")]
    logger.info("%d live Facebook tweet cards found (%d rows total)", len(live), len(rows))

    pin_channel_id = get_channel_id(service="pinterest")
    board_service_id = get_pinterest_board_service_id(pinterest_board_name())
    logger.info(
        "Pinterest Buffer channel: %s, board %r (%s)",
        pin_channel_id, pinterest_board_name(), board_service_id,
    )

    queued = skipped = failed = attempted = 0
    for row in live:
        # LIMIT counts ATTEMPTS (sends tried), not successes — otherwise a
        # failing run would plow through every row despite the cap.
        if limit and attempted >= limit:
            logger.info("LIMIT=%d reached — stopping", limit)
            break

        caption = row.get("caption") or ""
        storage_paths = row.get("media_urls") or []

        if not caption.strip() or not storage_paths:
            logger.warning("Row %s: empty caption or no media — skipping", row["id"])
            skipped += 1
            continue

        # Cheap pre-check; the (platform, md5(caption)) unique index inside
        # send_leg is still the arbiter against concurrent cron runs.
        if post_caption_exists("pinterest", caption):
            logger.info("Already on Pinterest — skipping: %s...", caption[:50])
            skipped += 1
            continue

        if dry_run:
            logger.info("DRY RUN — would queue to Pinterest: %s...", caption[:70])
            queued += 1
            attempted += 1
            continue

        attempted += 1
        # Keep the original outlier/bank classification where the FB row has
        # one; rows from before the source tag existed get 'backfill' so
        # their provenance stays visible in the dashboard.
        source_tag = (row.get("metadata") or {}).get("source") or "backfill"
        result = send_leg(
            platform="pinterest",
            channel_id=pin_channel_id,
            storage_path=storage_paths[0],
            caption=caption,
            source_tag=source_tag,
            # The pin description is the tweet text — same rule as the cron
            # leg (pins live in search; blank captions are undiscoverable).
            buffer_body=caption,
            extra_send_kwargs={
                "pinterest": {"boardServiceId": board_service_id},
                "caption_limit": PINTEREST_CAPTION_LIMIT,
            },
        )

        if result["status"] == "sent":
            queued += 1
            logger.info("Queued to Pinterest (Buffer %s): %s...", result["buffer_post_id"], caption[:50])
        elif result["status"] == "duplicate":
            skipped += 1
        else:
            failed += 1
            # send_leg flattens exceptions to strings, so sniff the message
            # to tell "Buffer is throttling the whole window" apart from a
            # single broken post — once throttled, every later send in this
            # run would fail too, so stop and let a re-run resume.
            if "rate limit" in (result.get("error") or "").lower():
                logger.error("Buffer rate limited — stopping; re-run later to resume")
                break

        time.sleep(INTER_SEND_SLEEP_SECONDS)

    logger.info("Done: %d queued, %d skipped, %d failed", queued, skipped, failed)
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()

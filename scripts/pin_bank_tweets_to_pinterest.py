"""One-off: queue a batch of fresh bank tweets to Pinterest via Buffer.

The daily tweet-card crons (cron/tiktok_pipeline.py + cron/tiktok_bank_pipeline.py)
ship a card or a handful of cards a day, each with a Pinterest leg, and
scripts/backfill_pinterest_tweet_cards.py already pinned every card that
existed before that leg went live. So "100 more pins" can't come from the
archive — it has to come from bank tweets that have never been rendered as
a card. This script does that in one go:

  Phase 1 — pick:   read the tweet_bank rows at or above MIN_LIKES,
                    most-liked first, and keep the first LIMIT tweets that
                    aren't on Pinterest yet. "Already on Pinterest" and
                    "already has a Facebook card" come from one paged read
                    of the posts table per platform, not a query per
                    candidate — a 100-pin pick walks hundreds of bank rows.
                    A tweet with a live Facebook card reuses that PNG (the
                    cron's Pinterest leg ships the FB image byte-for-byte —
                    see cron/_tweet_card_legs.py); everything else is
                    queued for a fresh render.
  Phase 2 — render: POST the un-rendered picks to the dashboard's
                    /api/content-gen/generate in batches of
                    RENDER_BATCH_SIZE with platform='facebook' (1080×1080
                    PNG), through the same render_extra_platforms() helper
                    the crons use. A pick whose render fails is dropped
                    with a warning rather than aborting the run.
  Phase 3 — send:   send_leg() per pick — the exact insert-row → proxy-URL
                    → Buffer-send → replay-payload dance the cron's
                    Pinterest leg runs, with the tweet text as the pin
                    description and the configured board
                    (PINTEREST_BOARD_NAME, default "Business Tactics").

Most-liked first (rather than the bank cron's random pick) so a batch is
the proven best of the pool, and so a re-run is deterministic: already-
pinned tweets are skipped, so running twice with LIMIT=100 yields the top
200 rather than a random overlap.

DRY_RUN=1 prints the pick list plus a count of unpinned bank tweets above
each like floor (6500 down to 4000), so MIN_LIKES can be chosen for the
real run when the default floor holds fewer tweets than LIMIT.

Buffer picks the queue slots (schedulingType=automatic), so the pins land
in the channel's next LIMIT posting slots rather than all at once.

Pacing: sends sleep 10s apart, same as the backfill script — Buffer's rate
window is ~100 requests per rolling 15 minutes, and 6 sends/minute keeps a
100-pin run under it. A send that still reports rate limiting stops the
run; the un-attempted picks were never inserted, so re-running later
resumes where it left off.

Dedup is per-platform on (platform, md5(caption)) — the partial unique
index inside send_leg is the arbiter. A tweet pinned here can still be
picked by the daily bank cron for Facebook/LinkedIn later (those are
different platform rows); the cron's own Pinterest leg will simply skip it
as a duplicate.

NOT registered in render.yaml. Run manually from the repo root with the
cron env vars set (SUPABASE_URL, SUPABASE_SERVICE_KEY, BUFFER_ACCESS_TOKEN,
BUFFER_ORG_ID, DASHBOARD_URL, CRON_SECRET):

    DRY_RUN=1 python scripts/pin_bank_tweets_to_pinterest.py   # pick + report only
    python scripts/pin_bank_tweets_to_pinterest.py             # real run, LIMIT=100
    LIMIT=25 MIN_LIKES=8000 python scripts/pin_bank_tweets_to_pinterest.py

or from GitHub → Actions → "Pinterest bank push (manual)", which runs it
with the repo's secrets (.github/workflows/pinterest-bank-push.yml).
"""

from __future__ import annotations

import logging
import os
import sys
import time

from core.buffer import get_channel_id, get_pinterest_board_service_id
from core.content_sources import select_bank_content_with_likes
from core.database import get_client
from core.env_diag import log_env_diagnostics
from core.text_utils import normalize_tweet_text
from cron._tweet_card_legs import (
    PINTEREST_CAPTION_LIMIT,
    pinterest_board_name,
    render_extra_platforms,
    send_leg,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)
# httpx logs every request URL at INFO — one line per PostgREST query and
# Buffer call. Besides being noise, those URLs carry the Supabase project
# host and query filters, and this script's output can land in a public
# GitHub Actions log. Warnings and errors from httpx still come through.
logging.getLogger("httpx").setLevel(logging.WARNING)

# Same 10s spacing as scripts/backfill_pinterest_tweet_cards.py: Buffer
# allows ~100 requests per rolling 15 min, and 6 sends/min = 90/15min, so a
# 100-pin run (plus the two channel/board lookups) stays under the cap.
INTER_SEND_SLEEP_SECONDS = 10.0

# The outlier cron renders up to 15 tweets per /api/content-gen/generate
# call; 10 keeps each call comfortably inside that proven envelope on the
# dashboard's 2 GB instance (node-canvas renders are memory-hungry) while
# still needing only ~10 calls for a 100-pin run.
RENDER_BATCH_SIZE = 10

# Like floors the dry run reports unpinned counts for. 6500 is the bank
# cron's default bar; 4000 is where the Instagram carousel cron settled
# after its 6.5K pool ran thin (render.yaml, CAROUSEL_MIN_LIKES).
FLOOR_STEPS = (6500, 6000, 5500, 5000, 4500, 4000)

# Tags the posts rows so the dashboard can tell these apart from the daily
# cron's "bank" rows and the launch-day "backfill" rows.
SOURCE_TAG = "bank_push"


def _env_int(key: str, default: int) -> int:
    """Read an integer env var, treating unset AND blank as the default.

    GitHub Actions passes workflow inputs through as strings, and an input
    left empty in the UI arrives as "" rather than absent — int("") would
    crash, so blank falls back to the default too.
    """
    raw = os.environ.get(key, "").strip()
    return int(raw) if raw else default


def live_posts_by_caption(platform: str) -> dict[str, str | None]:
    """{caption: first media path} for every live posts row on `platform`.

    One paged read (PostgREST caps a select at 1000 rows; the tweet-card
    platforms hold a few hundred rows each) instead of a query per
    candidate — the crons check one tweet at a time with
    post_caption_exists(), but a 100-pin pick walks hundreds of bank rows.
    Same liveness filter as post_caption_exists(): failed / buffer_error
    rows don't count, so a caption whose earlier send failed can be retried.
    """
    out: dict[str, str | None] = {}
    page = 0
    while True:
        batch = (
            get_client()
            .table("posts")
            .select("caption,media_urls")
            .eq("platform", platform)
            .not_.in_("status", ["failed", "buffer_error"])
            .range(page * 1000, page * 1000 + 999)
            .execute()
            .data
            or []
        )
        for row in batch:
            paths = row.get("media_urls") or []
            out[row["caption"]] = paths[0] if paths else None
        if len(batch) < 1000:
            return out
        page += 1


def _bank_rows_most_liked_first(min_likes: int) -> list[dict]:
    """tweet_bank rows at or above `min_likes`, sorted by likes descending.

    select_bank_content_with_likes() shuffles and slices to `count`, so we
    ask for everything (sys.maxsize) and impose our own order — it is the
    only public bank reader, and the shuffle is harmless once we re-sort.
    """
    rows = select_bank_content_with_likes(count=sys.maxsize, min_likes=min_likes)
    rows.sort(key=lambda r: r["favorite_count"], reverse=True)
    return rows


def pick_candidates(
    limit: int, min_likes: int, *, pinned: dict[str, str | None], fb_cards: dict[str, str | None],
) -> list[dict]:
    """Phase 1: the first `limit` bank tweets, most-liked first, not yet pinned.

    `pinned` and `fb_cards` are the live_posts_by_caption() maps for
    'pinterest' and 'facebook'. Each returned dict is {'tweet_id', 'text'
    (normalized), 'favorite_count', 'storage_path' (an existing FB PNG, or
    None when a render is needed)}.
    """
    rows = _bank_rows_most_liked_first(min_likes)
    logger.info("%d bank tweets at >= %d likes", len(rows), min_likes)

    picks: list[dict] = []
    already_pinned = 0
    for row in rows:
        if len(picks) >= limit:
            break
        # Same cleanup the bank cron applies before a tweet becomes a
        # caption (strip t.co links, fix spacing) — the caption is also
        # the dedup key, so it has to match what the cron would write.
        text = normalize_tweet_text(row["text"])
        if not text:
            continue
        # Pre-check against the live Pinterest rows; the (platform,
        # md5(caption)) unique index inside send_leg still arbitrates if a
        # cron run pins the same tweet concurrently.
        if text in pinned:
            already_pinned += 1
            continue
        picks.append({
            "tweet_id": str(row["tweet_id"]),
            "text": text,
            "favorite_count": row["favorite_count"],
            "storage_path": fb_cards.get(text),
        })

    logger.info(
        "Picked %d tweets (%d skipped as already on Pinterest); %d reuse an existing Facebook card",
        len(picks), already_pinned, sum(1 for p in picks if p["storage_path"]),
    )
    return picks


def log_floor_report(pinned: dict[str, str | None]) -> None:
    """Dry-run aid: how many unpinned bank tweets sit above each like floor.

    One log line so the operator can choose MIN_LIKES for the real run — a
    floor with fewer unpinned tweets than LIMIT would just come up short.
    Reads the bank once at the lowest floor and counts locally.
    """
    rows = _bank_rows_most_liked_first(min(FLOOR_STEPS))
    unpinned_likes = [
        row["favorite_count"]
        for row in rows
        if (text := normalize_tweet_text(row["text"])) and text not in pinned
    ]
    counts = ", ".join(
        f">={floor}: {sum(1 for likes in unpinned_likes if likes >= floor)}"
        for floor in FLOOR_STEPS
    )
    logger.info("Unpinned bank tweets by like floor — %s", counts)


def render_missing(picks: list[dict], *, dashboard_url: str, cron_secret: str) -> list[dict]:
    """Phase 2: render a Facebook PNG for every pick that lacks one, in batches.

    Mutates each pick's 'storage_path' in place and returns the picks that
    have one afterwards. Picks whose render failed are logged and dropped —
    the run should still ship the rest rather than abort on one bad card.
    render_extra_platforms() never raises (a failed batch just comes back
    empty), so a dashboard hiccup costs at most one batch.
    """
    todo = [p for p in picks if not p["storage_path"]]
    for start in range(0, len(todo), RENDER_BATCH_SIZE):
        batch = todo[start:start + RENDER_BATCH_SIZE]
        rendered = render_extra_platforms(
            dashboard_url=dashboard_url,
            cron_secret=cron_secret,
            tweets=[{"id": p["tweet_id"], "text": p["text"]} for p in batch],
        )["facebook"]
        for p in batch:
            p["storage_path"] = rendered.get(p["tweet_id"])
        logger.info(
            "Rendered batch %d-%d: %d/%d images",
            start + 1, start + len(batch),
            sum(1 for p in batch if p["storage_path"]), len(batch),
        )

    for p in picks:
        if not p["storage_path"]:
            logger.warning(
                "No render for tweet %s — dropping: %s...", p["tweet_id"], p["text"][:60],
            )
    return [p for p in picks if p["storage_path"]]


def send_all(picks: list[dict], *, channel_id: str, board_service_id: str) -> tuple[int, int, int]:
    """Phase 3: queue each pick to Pinterest through send_leg, rate-paced.

    Returns (queued, skipped, failed). Stops early on a Buffer rate-limit
    error: once the window is throttled every later send would fail too,
    and the un-attempted picks were never inserted, so a later re-run
    picks them up again.
    """
    queued = skipped = failed = 0
    for i, p in enumerate(picks):
        result = send_leg(
            platform="pinterest",
            channel_id=channel_id,
            storage_path=p["storage_path"],
            caption=p["text"],
            source_tag=SOURCE_TAG,
            # The pin description is the tweet text — same rule as the cron
            # leg (pins live in search; a blank description is undiscoverable).
            buffer_body=p["text"],
            extra_send_kwargs={
                "pinterest": {"boardServiceId": board_service_id},
                # Lift send_to_buffer's default 150-char truncation so the
                # whole tweet survives as the description.
                "caption_limit": PINTEREST_CAPTION_LIMIT,
            },
        )
        status = result["status"]
        if status == "sent":
            queued += 1
            logger.info(
                "Queued %d/%d (Buffer %s, %d likes): %s...",
                i + 1, len(picks), result["buffer_post_id"], p["favorite_count"], p["text"][:50],
            )
        elif status == "duplicate":
            skipped += 1
            logger.info("Already on Pinterest (dedup race) — skipping: %s...", p["text"][:50])
        else:
            failed += 1
            logger.error("Send failed (%s) for tweet %s: %s", status, p["tweet_id"], result.get("error"))
            # send_leg flattens exceptions to strings, so sniff the message to
            # tell "Buffer is throttling the whole window" apart from a single
            # broken post.
            if "rate limit" in (result.get("error") or "").lower():
                logger.error("Buffer rate limited — stopping; re-run later to resume")
                break
        if i < len(picks) - 1:
            time.sleep(INTER_SEND_SLEEP_SECONDS)
    return queued, skipped, failed


def main() -> None:
    dry_run = os.environ.get("DRY_RUN", "").strip() == "1"
    limit = _env_int("LIMIT", 100)
    min_likes = _env_int("MIN_LIKES", 6500)
    dashboard_url = os.environ.get("DASHBOARD_URL", "")
    cron_secret = os.environ.get("CRON_SECRET", "")

    log_env_diagnostics(
        "pin-bank-tweets-to-pinterest",
        required=[
            "SUPABASE_URL",
            "SUPABASE_SERVICE_KEY",
            "BUFFER_ACCESS_TOKEN",
            "BUFFER_ORG_ID",
            "DASHBOARD_URL",
            "CRON_SECRET",
        ],
        optional=["LIMIT", "MIN_LIKES", "DRY_RUN", "PINTEREST_BOARD_NAME"],
    )
    logger.info(
        "Mode: %s | LIMIT=%d | MIN_LIKES=%d | board=%r",
        "DRY RUN" if dry_run else "REAL", limit, min_likes, pinterest_board_name(),
    )

    # Resolve the channel + board up front (both are read-only Buffer
    # queries) so a typo'd board name or a disconnected channel fails
    # loudly before any render or send happens.
    channel_id = get_channel_id(service="pinterest")
    board_service_id = get_pinterest_board_service_id(pinterest_board_name())
    logger.info(
        "Pinterest Buffer channel %s, board %r -> serviceId %s",
        channel_id, pinterest_board_name(), board_service_id,
    )

    pinned = live_posts_by_caption("pinterest")
    fb_cards = live_posts_by_caption("facebook")
    logger.info("%d live Pinterest rows, %d live Facebook cards in posts", len(pinned), len(fb_cards))

    picks = pick_candidates(limit=limit, min_likes=min_likes, pinned=pinned, fb_cards=fb_cards)

    if dry_run:
        for i, p in enumerate(picks, 1):
            logger.info(
                "DRY RUN %3d. [%s] %6d likes  %s%s",
                i, p["tweet_id"], p["favorite_count"], p["text"][:80],
                "  (reuses FB card)" if p["storage_path"] else "",
            )
        logger.info(
            "DRY RUN — would render %d cards and queue %d pins; nothing sent",
            sum(1 for p in picks if not p["storage_path"]), len(picks),
        )
        log_floor_report(pinned)
        return

    if not picks:
        logger.info(
            "Nothing to pin — bank exhausted at this like floor, or everything is already on Pinterest",
        )
        return

    if not dashboard_url or not cron_secret:
        logger.error("DASHBOARD_URL / CRON_SECRET not set — cannot render cards")
        sys.exit(1)

    ready = render_missing(picks, dashboard_url=dashboard_url, cron_secret=cron_secret)
    if not ready:
        logger.error("No cards rendered — nothing to send")
        sys.exit(1)

    queued, skipped, failed = send_all(ready, channel_id=channel_id, board_service_id=board_service_id)
    dropped = len(picks) - len(ready)
    logger.info(
        "Done: %d queued, %d skipped, %d failed, %d dropped at render",
        queued, skipped, failed, dropped,
    )
    # Non-zero exit on any shortfall so an Actions run shows red — the
    # dedup makes a re-run safe, and the log above says what to top up.
    if failed or dropped:
        sys.exit(1)


if __name__ == "__main__":
    main()

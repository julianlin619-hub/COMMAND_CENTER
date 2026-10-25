"""Instagram Carousel pipeline — weekly cron job (Mondays).

Replaces the paused Instagram reel leg of the tweet-card fan-out (see
IG_TWEET_CARD_FORMAT in cron/_tweet_card_legs.py) with an outlier-tweet
carousel (there is no title/intro card — slide 1 is the strongest tweet):

  Slides 1-10 — ten outlier tweets (Instagram's carousel maximum), pulled
                from the bank ONLY (the tweet_bank table), each >=
                CAROUSEL_MIN_LIKES likes (default 6500 in code / 4000 on
                Render), ordered most likes -> least likes.

The daily single-tweet post is a SEPARATE cron now: between 2026-08-17 and
Oct 2026 this module also ran a "Phase 0" solo-breakout leg that shipped
every fresh viral tweet as its own post. Once this cron went weekly that
leg could only fire on Mondays, so it moved to
cron/instagram_solo_pipeline.py — one 4:5 post every day, scheduled for
6pm Pacific. The two crons share a dedup ledger (see below), so a tweet
shipped solo never reappears as a slide and vice versa.

Internally each shipped carousel still advances a "Day N" counter — it no
longer appears on any slide, but it remains a human-readable series
marker in metadata.

The carousel always ships with exactly CAROUSEL_TWEET_COUNT slides —
if ten unused qualifying tweets can't be found, or any slide fails to
render, the run skips/fails cleanly and nothing is posted (the "Day N"
series never ships a short set).

Dedup: every tweet used on any shipped carousel is tracked and never
reused. Two layers:
  - metadata.tweet_ids on each carousel's posts row — the selection phase
    unions these across all live carousel rows and skips those ids (the
    solo cron reads the same ledger via _fetch_carousel_history);
  - posts.caption stores slide 1's tweet text, so the existing
    (platform, md5(caption)) partial-unique index also arbitrates
    concurrent runs, and post_caption_exists() text-checks every candidate
    against anything already shipped to the same channel — including the
    solo cron's posts, whose caption is the full tweet text.

The day counter needs no table of its own: day = (number of live carousel
rows) + 1. A buffer_error row drops out of that count, so a failed day is
retried under the same number the next run.

(The TikTok photo-carousel mirror leg was removed in Aug 2026 — the
operator stopped publishing tweet carousels to TikTok. The historical
platform='tiktok' carousel rows stay in the DB for dashboard history.)

Three cron_runs phases, platform='instagram':
  Phase 1 — carousel_pick:     day number + 10 bank outlier tweets
  Phase 2 — carousel_generate: render the 10 tweet cards
  Phase 3 — carousel_send:     insert posts row + one Buffer carousel send

Run locally with:  python -m cron.instagram_carousel_pipeline
Dry run (no DB write, no Buffer send):  CAROUSEL_DRY_RUN=1 python -m ...
"""

import logging
import os
import re
import sys

from core.buffer import get_channel_id, send_to_buffer
from core.content_gen_client import generate_content
from core.content_sources import select_bank_content_with_likes
from core.database import (
    get_client,
    insert_post,
    log_cron_finish,
    log_cron_start,
    post_caption_exists,
    record_buffer_handoff,
    update_post,
)
from core.env_diag import log_env_diagnostics
from core.media import build_proxy_url
from core.models import Post
from core.text_utils import normalize_tweet_text
from cron._tweet_card_legs import BUFFER_CAPTION, _is_unique_violation


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Rows carry source="carousel" so the dashboard can tell carousel posts
# apart from anything the old reel leg wrote under the same platform value.
# Also the key the day counter and used-tweet lookup filter on.
SOURCE_TAG = "carousel"


def _series_label(day: int) -> str:
    """Internal per-day series marker — NOT rendered on any slide.

    Stored in metadata.title so the dashboard can show which "Day N" a
    carousel belongs to. (It also served as the dedup caption for the
    TikTok mirror leg until that leg was removed in Aug 2026.)
    """
    return f"Outlier carousel (Day {day})"


def _text_fingerprint(text: str) -> str:
    """Casefolded, punctuation/whitespace-free form of a tweet for dup checks.

    Coarse on purpose: two tweets that differ only in emoji, quote style, or
    line breaks are the same content on a carousel slide.
    """
    return re.sub(r"[^a-z0-9]", "", text.casefold())


def _fetch_carousel_history() -> tuple[int, set[str]]:
    """Return (next_day_number, used_tweet_ids) from prior carousel rows.

    Both come from the same query so a single source of truth (live carousel
    posts rows) drives the "Day N" counter AND the never-reuse-a-tweet rule.
    "Live" excludes failed/buffer_error rows: a carousel that never shipped
    doesn't advance the day, and its tweets are free to be re-picked.
    """
    rows = (
        get_client()
        .table("posts")
        .select("status,metadata")
        .eq("platform", "instagram")
        .eq("metadata->>source", SOURCE_TAG)
        .execute()
        .data
        or []
    )
    live = [r for r in rows if r.get("status") not in ("failed", "buffer_error")]

    used_ids: set[str] = set()
    for row in live:
        for tweet_id in (row.get("metadata") or {}).get("tweet_ids", []) or []:
            used_ids.add(str(tweet_id))

    return len(live) + 1, used_ids


def _pick_carousel_tweets(
    *,
    min_likes: int,
    count: int,
    used_tweet_ids: set[str],
) -> list[dict]:
    """Pick up to `count` unused outlier tweets from the bank.

    Bank-only since 2026-08-17: fresh Apify tweets no longer feed the
    carousel — they ship as solo posts instead (see
    cron/instagram_solo_pipeline.py).
    The bank (the tweet_bank table, topped up daily by the threads cron's
    scrape) is a settled catalogue whose like counts are final, so
    `min_likes` (CAROUSEL_MIN_LIKES, default 6500 in code / 4000 on
    Render) is a "proven performer" bar, not a virality signal.

    Every candidate must clear three gates:
      - id not used on a previous carousel (used_tweet_ids),
      - text not already posted to Instagram in any format
        (post_caption_exists — covers the old reel leg's posts AND the
        solo-breakout leg, whose caption is the full tweet text),
      - text not a fingerprint-duplicate of a tweet picked earlier this run.

    Returns dicts of {'tweet_id', 'text', 'normalized', 'favorite_count',
    'source': 'bank'}, sorted by favorite_count DESCENDING — the returned
    order IS the slide order, and the operator wants the carousel to open
    on its strongest tweet. May return fewer than `count` — the caller
    decides that a short set skips the run.
    """
    picked: list[dict] = []
    seen_fps: set[str] = set()

    # Pull a generous batch: the dedup gates thin the candidates and the
    # filtered bank read is cheap (CSV scan, no network).
    for candidate in select_bank_content_with_likes(
        count=count * 8, min_likes=min_likes,
    ):
        if len(picked) >= count:
            break
        tweet_id = str(candidate["tweet_id"])
        normalized = normalize_tweet_text(candidate["text"])
        if not normalized.strip():
            continue
        fp = _text_fingerprint(normalized)
        if fp in seen_fps:
            continue
        if tweet_id in used_tweet_ids:
            logger.debug("Skipping tweet %s — used on a previous carousel", tweet_id)
            continue
        if post_caption_exists("instagram", normalized):
            logger.debug("Skipping tweet %s — text already posted to IG", tweet_id)
            continue
        seen_fps.add(fp)
        picked.append({
            "tweet_id": tweet_id,
            "text": candidate["text"],
            "normalized": normalized,
            "favorite_count": candidate["favorite_count"],
            "source": "bank",
        })

    # Rank the slides most-liked first — the returned order is the slide
    # order and the carousel opens on its strongest tweet.
    picked.sort(key=lambda t: t["favorite_count"], reverse=True)
    return picked


def main() -> None:
    log_env_diagnostics(
        "instagram-carousel-pipeline",
        required=[
            "SUPABASE_URL",
            "SUPABASE_SERVICE_KEY",
            "DASHBOARD_URL",
            "CRON_SECRET",
            "BUFFER_ACCESS_TOKEN",
            "BUFFER_ORG_ID",
        ],
        optional=[
            "CAROUSEL_MIN_LIKES",
            "CAROUSEL_TWEET_COUNT",
            "CAROUSEL_DRY_RUN",
        ],
    )

    # Carousel bar — the bank is a settled catalogue, so this is a "proven
    # performer" floor (set to 4000 on Render, 2026-08-17).
    min_likes = int(os.environ.get("CAROUSEL_MIN_LIKES", "6500"))
    # 10 tweet slides, Instagram's carousel maximum (no title card since
    # Aug 2026 — the carousel opens on its strongest tweet).
    tweet_count = int(os.environ.get("CAROUSEL_TWEET_COUNT", "10"))
    # Mirrors YOUTUBE_STUDIO_DRY_RUN: pick + render for real, log the
    # would-be send, but write no posts row and touch no Buffer queue.
    dry_run = os.environ.get("CAROUSEL_DRY_RUN", "") == "1"
    dashboard_url = os.environ.get("DASHBOARD_URL", "")
    cron_secret = os.environ.get("CRON_SECRET", "")

    if not dashboard_url:
        logger.error("DASHBOARD_URL not set — cannot call dashboard API for rendering")
        sys.exit(1)

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 1: Day number + pick the outlier tweets (bank only)
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="instagram", job_type="carousel_pick")
    try:
        day, used_tweet_ids = _fetch_carousel_history()
        logger.info(
            "Day %d (%d tweets used on previous carousels)",
            day, len(used_tweet_ids),
        )

        tweets = _pick_carousel_tweets(
            min_likes=min_likes,
            count=tweet_count,
            used_tweet_ids=used_tweet_ids,
        )
        if len(tweets) < tweet_count:
            # The Day-N series always ships a full set — a short carousel
            # would make the series inconsistent. Nothing was written, so
            # today's picks stay available for tomorrow's run.
            logger.info(
                "Only %d/%d unused tweets >= %d likes — skipping run.",
                len(tweets), tweet_count, min_likes,
            )
            log_cron_finish(run_id, status="success", posts_processed=0)
            return

        for t in tweets:
            logger.info(
                "Slide tweet (%s, id=%s, %d likes): %.60s",
                t["source"], t["tweet_id"], t["favorite_count"], t["normalized"],
            )
        log_cron_finish(run_id, status="success", posts_processed=1)
    except Exception as e:
        logger.error("Phase 1 failed (carousel pick): %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 2: Render the tweet cards (all must succeed)
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="instagram", job_type="carousel_generate")
    try:
        # Slide order IS the payload order downstream: the carousel opens
        # directly on the most-liked tweet (no title/intro card).
        render_payload = [
            {"id": t["tweet_id"], "text": t["text"]} for t in tweets
        ]
        data = generate_content(
            dashboard_url=dashboard_url,
            cron_secret=cron_secret,
            tweets=render_payload,
            platform="instagram",
        )
        if data.get("error"):
            raise RuntimeError(data["error"])
        for i, err in enumerate(data.get("errors", []) or []):
            logger.warning("  instagram render error[%d]: %s", i, err)

        # Re-map results by id — the route drops failed items, so the response
        # list's order can't be trusted to mirror the request's.
        rendered = {str(item["id"]): item for item in data.get("generated", []) or []}

        # ALL slides must render: the series never ships a short set, and
        # nothing was inserted yet so failing here retries cleanly next run.
        missing = [p["id"] for p in render_payload if p["id"] not in rendered]
        if missing:
            raise RuntimeError(
                f"Render dropped slide(s) {missing} (API errors: {data.get('errors', [])})"
            )

        storage_paths = [rendered[p["id"]]["storagePath"] for p in render_payload]
        # The route re-normalizes the text it renders; use ITS text for
        # slide 1's tweet as the dedup caption so post_caption_exists and the
        # md5(caption) index see exactly the string future runs re-derive.
        dedup_caption = rendered[tweets[0]["tweet_id"]]["text"]

        log_cron_finish(run_id, status="success", posts_processed=len(storage_paths))
        logger.info("Phase 2: rendered %d tweet slide(s)", len(storage_paths))
    except Exception as e:
        logger.error("Phase 2 failed (generate): %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    metadata = {
        "source": SOURCE_TAG,
        "day": day,
        "title": _series_label(day),
        # The never-reuse ledger: _fetch_carousel_history unions these
        # across all live carousel rows on every future run.
        "tweet_ids": [t["tweet_id"] for t in tweets],
        "tweet_sources": {t["tweet_id"]: t["source"] for t in tweets},
    }

    if dry_run:
        logger.info(
            "DRY RUN — would send Day %d carousel (%d slides): %s. "
            "No posts row written, no Buffer send.",
            day, len(storage_paths), storage_paths,
        )
        return

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 3: Insert posts row, then ONE Buffer carousel send
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="instagram", job_type="carousel_send")

    try:
        # Same channel lookup the reel leg used → Alex's main IG channel.
        ig_channel_id = get_channel_id(service="instagram")
    except Exception as e:
        logger.error("Phase 3 failed — could not get Instagram channel ID: %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    # Insert-first-then-send (the send_leg pattern, inlined because one row
    # carries the whole carousel): the partial-unique index on
    # (platform, md5(caption)) arbitrates concurrent runs, keyed on slide 1's
    # tweet text.
    post = Post(
        platform="instagram",
        status="sent_to_buffer",
        media_type="carousel",
        media_urls=storage_paths,
        caption=dedup_caption,
        metadata=metadata,
    )
    try:
        post_id = insert_post(post)
    except Exception as e:
        if _is_unique_violation(e):
            logger.info("Dedup race lost (DB constraint) — slide-2 tweet already used: %.50s", dedup_caption)
            log_cron_finish(run_id, status="success", posts_processed=0)
            return
        logger.error("insert_post failed: %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    try:
        # One indexed proxy URL per slide (see /api/media/[id]?index=N) —
        # permanent URLs that re-sign on every Buffer fetch. All of them go
        # into a SINGLE Buffer update: multiple image assets on an Instagram
        # channel with type='post' is what Buffer publishes as a carousel.
        media_urls = [build_proxy_url(post_id, i) for i in range(len(storage_paths))]
        buffer_post_id = send_to_buffer(
            ig_channel_id,
            BUFFER_CAPTION,  # blank — the content is on the cards
            media_urls,
            media_type="image",
            instagram_post_type="post",
        )
        record_buffer_handoff(
            post_id, buffer_post_id,
            channel_id=ig_channel_id,
            body=BUFFER_CAPTION,
            media_type="image",
            instagram_post_type="post",
            base_metadata=metadata,
        )

        log_cron_finish(run_id, status="success", posts_processed=1)
        logger.info(
            "Phase 3 complete: Day %d carousel (%d slides) sent to Buffer (post %s, Buffer %s)",
            day, len(storage_paths), post_id, buffer_post_id,
        )
    except Exception as e:
        # Flip to buffer_error so the row drops out of the dedup index AND
        # out of the day counter/used-tweet ledger — the next run retries the
        # same day number with a fresh (possibly identical) pick.
        logger.error("Buffer carousel send failed: %s", e, exc_info=True)
        try:
            update_post(post_id, status="buffer_error", error_message=str(e)[:500])
        except Exception as db_err:
            logger.error("Also failed to mark post %s as buffer_error: %s", post_id, db_err)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()

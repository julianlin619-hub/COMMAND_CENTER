"""Instagram Solo Post pipeline — every-second-day cron job.

Ships exactly ONE outlier tweet every second day to Alex's main Instagram
channel as a standalone 1080x1350 (4:5) quote-card feed post, scheduled
through Buffer to publish at 6:00 PM Pacific (POST_LOCAL_HOUR / POST_TZ
below).

This is the single-post counterpart of the weekly Day-N carousel
(cron/instagram_carousel_pipeline.py). Until Oct 2026 the solo-breakout leg
lived inside the carousel cron as its "Phase 0" — but once that cron went
weekly (Mondays only), fresh breakouts could only ship on Mondays and never
at a chosen time. Pulling the leg into its own cron fixes both, and
capping it at one post means Instagram gets a predictable every-other-day
cadence instead of 0-3 posts dumped into the queue whenever the carousel
ran.

How the one tweet is chosen (first match wins):

  1. Fresh breakout — Apify scrapes the account's recent tweets, and the
     most-liked one that went viral inside the window (at most
     SOLO_BREAKOUT_HOURS old, default 72, AND already >=
     SOLO_BREAKOUT_MIN_LIKES likes, default 6000) ships today. Retweets,
     replies and anything already posted to Instagram are skipped.
  2. Bank fallback — if nothing fresh qualifies (most days: breakouts are
     rare), a random unused tweet from the tweet_bank table that clears
     SOLO_BANK_MIN_LIKES (default 4000, matching the carousel's
     CAROUSEL_MIN_LIKES on Render) ships instead. The bank is a settled
     catalogue of proven performers, so a post always ships on schedule;
     random (rather than most-liked-first) keeps the feed varied instead of
     draining the top of the bank in strict order.

Dedup shares the carousel's ledger: a tweet already used on any shipped
carousel slide (metadata.tweet_ids) is skipped, and posts.caption stores
the full tweet text so post_caption_exists() — plus the partial-unique
(platform, md5(caption)) index — stops the same tweet shipping twice in any
Instagram format. Because the carousel picks run the same gate against
solo rows, a tweet that ships solo today can't reappear on Monday's
carousel either.

Why the publish time is set here and not in Buffer: Buffer's addToQueue
mode drops a post into the channel's next free posting slot, which would
make the publish time depend on whatever schedule is configured in the
Buffer UI. Passing due_at makes send_to_buffer use mode=customScheduled
with an explicit dueAt, so "6pm Pacific every second day" is enforced by
this code regardless of the channel's Buffer settings.

How "every second day" is kept honest: each run reads the due time of the
most recent live solo post (metadata.due_at) and picks the first 6pm slot
that is both in the future AND at least POST_EVERY_DAYS (2) days after it.
The Render cron fires on odd days of the month ("*/2"), which cron syntax
can't make perfectly alternate across a 31-day month boundary — the
due-time gap rule absorbs that: a run that fires "too early" simply
schedules the post for the correct slot a day further out instead of
posting on back-to-back days. The same rule is what lets the operator run
the pipeline several times by hand to pre-queue a few posts: each run
lands on the next free slot in the 2-day grid.

Two cron_runs phases, platform='instagram':
  Phase 1 — solo_pick:  scrape + choose the one tweet (fresh first, then bank)
  Phase 2 — solo_send:  render the 4:5 card, insert the posts row, Buffer send

Run locally with:  python -m cron.instagram_solo_pipeline
(each hand run queues one more post on the next free 2-day slot)
Dry run (no DB write, no Buffer send):  SOLO_DRY_RUN=1 python -m ...
"""

import logging
import os
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from core.buffer import get_channel_id, send_to_buffer
from core.content_gen_client import generate_content
from core.content_sources import fetch_apify_tweets
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
from core.tweet_filter import is_retweet
from cron._tweet_card_legs import BUFFER_CAPTION, _is_unique_violation
from cron.instagram_carousel_pipeline import (
    _fetch_carousel_history,
    _pick_carousel_tweets,
    _text_fingerprint,
)


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Rows carry source="solo_breakout" — the same tag the carousel cron's old
# Phase 0 wrote, so the dashboard's history of solo posts stays continuous
# across the move to this module.
SOURCE_TAG = "solo_breakout"

# When the solo post goes live. 18:00 in Alex's home timezone (Las Vegas
# observes Pacific time). Pacific is used by name, not as a fixed UTC
# offset, so the post stays at 6pm local across the PDT/PST switch.
POST_LOCAL_HOUR = 18
POST_TZ = ZoneInfo("America/Los_Angeles")
# Minimum gap between two solo posts. 2 = every second day.
POST_EVERY_DAYS = 2


def _latest_solo_due_at() -> datetime | None:
    """Return the publish time of the most recently scheduled live solo post.

    Reads metadata.due_at off the newest posts row this cron wrote. "Live"
    excludes failed/buffer_error rows — a post that never reached Buffer
    doesn't occupy a slot, so the next run can take that slot over. Rows
    the carousel cron's old Phase 0 wrote have no due_at (they went to
    Buffer's queue, not a fixed time) and are ignored here.
    """
    rows = (
        get_client()
        .table("posts")
        .select("metadata")
        .eq("platform", "instagram")
        .eq("metadata->>source", SOURCE_TAG)
        .not_.in_("status", ["failed", "buffer_error"])
        .not_.is_("metadata->>due_at", "null")
        .order("metadata->>due_at", desc=True)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        return None
    return datetime.fromisoformat(rows[0]["metadata"]["due_at"])


def _next_post_time(now: datetime, last_due: datetime | None = None) -> datetime:
    """Return the next free 6pm Pacific slot as an aware datetime.

    The slot must be strictly after `now` (Buffer rejects a dueAt that has
    already gone by — relevant when the cron is run by hand late in the
    day), and at least POST_EVERY_DAYS days after `last_due`, the previous
    solo post's publish time. Slots step in whole local days, so the result
    is always 6pm on the dot even across the PDT/PST switch.
    """
    local_now = now.astimezone(POST_TZ)
    due = local_now.replace(
        hour=POST_LOCAL_HOUR, minute=0, second=0, microsecond=0
    )
    if due <= local_now:
        due = due + timedelta(days=1)
    if last_due is not None:
        earliest = last_due.astimezone(POST_TZ) + timedelta(days=POST_EVERY_DAYS)
        while due < earliest:
            due = due + timedelta(days=1)
    return due


def _pick_solo_breakouts(
    apify_tweets: list[dict], used_tweet_ids: set[str]
) -> list[dict]:
    """Filter fresh Apify tweets down to the ones worth a solo post.

    The window/likes gates (SOLO_BREAKOUT_HOURS / SOLO_BREAKOUT_MIN_LIKES)
    are applied by fetch_apify_tweets before this runs — this helper only
    applies the content/dedup gates:
      - not a retweet ("RT @…" — someone else's content) and not a reply
        (leading "@" — conversational, meaningless out of thread),
      - id not used on any previous carousel slide (until 2026-08-17 the
        carousel's Apify pathway shipped recent tweets as slides, so a
        2-day-old tweet could already be on a past carousel),
      - text not already posted to Instagram in any format — this is also
        what keeps a tweet that stays viral for all 72 hours of the window
        from shipping again on the next run, because each solo post stores
        the full tweet text as its caption,
      - not a fingerprint-duplicate of a breakout picked earlier this run.

    Returns dicts of {'tweet_id', 'text', 'normalized', 'favorite_count'},
    keeping Apify's newest-first order. The caller decides which ONE of
    them ships today (see _choose_tweet).
    """
    picked: list[dict] = []
    seen_fps: set[str] = set()
    for tweet in apify_tweets:
        tweet_id = str(tweet["id"])
        text = tweet["text"]
        if is_retweet(text) or text.lstrip().startswith("@"):
            continue
        normalized = normalize_tweet_text(text)
        if not normalized.strip():
            continue
        fp = _text_fingerprint(normalized)
        if fp in seen_fps:
            continue
        if tweet_id in used_tweet_ids:
            continue
        if post_caption_exists("instagram", normalized):
            continue
        seen_fps.add(fp)
        picked.append({
            "tweet_id": tweet_id,
            "text": text,
            "normalized": normalized,
            "favorite_count": tweet.get("like_count", 0),
        })
    return picked


def _choose_tweet(
    breakouts: list[dict],
    *,
    bank_min_likes: int,
    used_tweet_ids: set[str],
) -> dict | None:
    """Pick today's single tweet: strongest fresh breakout, else bank.

    Fresh breakouts win over the bank because they're timely — a tweet
    that blew up this week lands better than a proven line from last year.
    Among several breakouts the most-liked ships first; the others are
    still inside their 72h window tomorrow and will get their turn (or age
    out, which is fine — the bank never runs dry).

    Returns a dict of {'tweet_id', 'text', 'normalized', 'favorite_count',
    'source': 'fresh' | 'bank'}, or None when even the bank has nothing
    unused above the bar.
    """
    if breakouts:
        best = max(breakouts, key=lambda t: t["favorite_count"])
        return {**best, "source": "fresh"}

    # The carousel's bank picker already applies the id / caption /
    # fingerprint gates on top of the bank's random sampler, so asking it
    # for one tweet gives "a random unused bank tweet above the bar".
    bank = _pick_carousel_tweets(
        min_likes=bank_min_likes, count=1, used_tweet_ids=used_tweet_ids,
    )
    return bank[0] if bank else None


def main() -> None:
    log_env_diagnostics(
        "instagram-solo-pipeline",
        required=[
            "SUPABASE_URL",
            "SUPABASE_SERVICE_KEY",
            "DASHBOARD_URL",
            "CRON_SECRET",
            "BUFFER_ACCESS_TOKEN",
            "BUFFER_ORG_ID",
            # Fresh-breakout pathway. Missing -> fetch_apify_tweets returns []
            # and every run falls through to the bank.
            "APIFY_API_KEY",
        ],
        optional=[
            "APIFY_TWITTER_HANDLE",
            "SOLO_BREAKOUT_HOURS",
            "SOLO_BREAKOUT_MIN_LIKES",
            "SOLO_BANK_MIN_LIKES",
            "SOLO_DRY_RUN",
        ],
    )

    twitter_handle = os.environ.get("APIFY_TWITTER_HANDLE", "AlexHormozi")
    # Fresh-breakout gates: an Apify tweet only qualifies if it's at most
    # this many hours old AND already above this likes bar — i.e. it went
    # viral within the window. The bar sits higher than the bank's because
    # a 3-day-old tweet's count is still climbing.
    solo_hours = int(os.environ.get("SOLO_BREAKOUT_HOURS", "72"))
    solo_min_likes = int(os.environ.get("SOLO_BREAKOUT_MIN_LIKES", "6000"))
    # Bank fallback bar — the bank is a settled catalogue, so this is a
    # "proven performer" floor. Default matches the carousel's Render value.
    bank_min_likes = int(os.environ.get("SOLO_BANK_MIN_LIKES", "4000"))
    # Mirrors CAROUSEL_DRY_RUN: scrape + pick + render for real, log the
    # would-be send, but write no posts row and touch no Buffer queue.
    dry_run = os.environ.get("SOLO_DRY_RUN", "") == "1"
    dashboard_url = os.environ.get("DASHBOARD_URL", "")
    cron_secret = os.environ.get("CRON_SECRET", "")

    if not dashboard_url:
        logger.error("DASHBOARD_URL not set — cannot call dashboard API for rendering")
        sys.exit(1)

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 1: Choose today's tweet (fresh breakout first, bank fallback)
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="instagram", job_type="solo_pick")
    try:
        # Share the carousel's never-reuse ledger so a tweet already shown
        # as a carousel slide doesn't come back as a solo post.
        _, used_tweet_ids = _fetch_carousel_history()
        # max_items=50 comfortably covers 72h of posting for one account —
        # the window filter (not this cap) decides what qualifies.
        breakouts = _pick_solo_breakouts(
            fetch_apify_tweets(
                twitter_handle,
                max_items=50,
                hours_lookback=solo_hours,
                min_favorites=solo_min_likes,
            ),
            used_tweet_ids,
        )
        chosen = _choose_tweet(
            breakouts, bank_min_likes=bank_min_likes, used_tweet_ids=used_tweet_ids,
        )
        if chosen is None:
            # Nothing fresh and the bank is mined out above the bar. Nothing
            # was written, so tomorrow's run simply tries again.
            logger.info(
                "No unused tweet available (%d fresh qualified, bank bar %d) — skipping run.",
                len(breakouts), bank_min_likes,
            )
            log_cron_finish(run_id, status="success", posts_processed=0)
            return
        logger.info(
            "Today's tweet (%s, id=%s, %d likes; %d fresh breakout(s) qualified): %.60s",
            chosen["source"], chosen["tweet_id"], chosen["favorite_count"],
            len(breakouts), chosen["normalized"],
        )
        log_cron_finish(run_id, status="success", posts_processed=1)
    except Exception as e:
        logger.error("Phase 1 failed (solo pick): %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 2: Render the 4:5 card, insert the posts row, Buffer send
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="instagram", job_type="solo_send")
    try:
        # platform="instagram" selects the 1080x1350 (4:5) template row —
        # the same card the carousel slides use, so solos and slides match.
        data = generate_content(
            dashboard_url=dashboard_url,
            cron_secret=cron_secret,
            tweets=[{"id": chosen["tweet_id"], "text": chosen["text"]}],
            platform="instagram",
        )
        if data.get("error"):
            raise RuntimeError(data["error"])
        rendered = {str(item["id"]): item for item in data.get("generated", []) or []}
        card = rendered.get(chosen["tweet_id"])
        if card is None:
            raise RuntimeError(
                f"Render dropped tweet {chosen['tweet_id']} (API errors: {data.get('errors', [])})"
            )

        # Next free slot on the 2-day grid — see _next_post_time. Looked up
        # here (after the pick) so a run that skips for lack of tweets
        # never touches the schedule.
        due_at = _next_post_time(datetime.now(POST_TZ), _latest_solo_due_at())
        metadata = {
            "source": SOURCE_TAG,
            "tweet_id": chosen["tweet_id"],
            "tweet_source": chosen["source"],
            "favorite_count": chosen["favorite_count"],
            # Human-readable record of when Buffer was told to publish —
            # the dashboard has no other way to see a customScheduled time.
            "due_at": due_at.isoformat(),
        }

        if dry_run:
            logger.info(
                "DRY RUN — would send solo post (%s, %d likes) due %s: %s. "
                "No posts row written, no Buffer send.",
                chosen["source"], chosen["favorite_count"], due_at.isoformat(),
                card["storagePath"],
            )
            log_cron_finish(run_id, status="success", posts_processed=0)
            return

        # Insert-first-then-send, same as the carousel: the caption is the
        # full tweet text (the route-normalized version, so future dedup
        # checks re-derive the exact same string), and the partial-unique
        # (platform, md5(caption)) index arbitrates concurrent runs.
        post = Post(
            platform="instagram",
            status="sent_to_buffer",
            media_type="image",
            media_urls=[card["storagePath"]],
            caption=card["text"],
            metadata=metadata,
        )
        try:
            post_id = insert_post(post)
        except Exception as e:
            if _is_unique_violation(e):
                logger.info(
                    "Dedup race lost (DB constraint) — tweet already posted: %.50s",
                    card["text"],
                )
                log_cron_finish(run_id, status="success", posts_processed=0)
                return
            raise
    except Exception as e:
        logger.error("Phase 2 failed (render/insert): %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    try:
        ig_channel_id = get_channel_id(service="instagram")
        buffer_post_id = send_to_buffer(
            ig_channel_id,
            BUFFER_CAPTION,  # blank — the content is on the card
            build_proxy_url(post_id, 0),
            media_type="image",
            instagram_post_type="post",
            due_at=due_at,
        )
        # The replay payload deliberately omits due_at: a reconcile re-send
        # happens after the original time has passed, so it falls back to
        # addToQueue rather than asking Buffer for a slot in the past.
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
            "Phase 2 complete: solo post scheduled for %s (post %s, Buffer %s) — %.60s",
            due_at.isoformat(), post_id, buffer_post_id, chosen["normalized"],
        )
    except Exception as e:
        # Flip to buffer_error so the row leaves the dedup index and the
        # tweet can be picked again tomorrow.
        logger.error("Solo post Buffer send failed: %s", e, exc_info=True)
        try:
            update_post(post_id, status="buffer_error", error_message=str(e)[:500])
        except Exception as db_err:
            logger.error("Also failed to mark post %s as buffer_error: %s", post_id, db_err)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()

"""Instagram Carousel pipeline — daily cron job.

Replaces the paused Instagram reel leg of the tweet-card fan-out (see
IG_TWEET_CARD_FORMAT in cron/_tweet_card_legs.py) with a daily outlier-tweet
carousel (there is no title/intro card — slide 1 is the strongest tweet):

  Slides 1-10 — ten outlier tweets (Instagram's carousel maximum), pulled
                from the CSV bank ONLY, each >= CAROUSEL_MIN_LIKES likes
                (default 6500 in code / 4000 on Render), ordered most
                likes -> least likes.

Since 2026-08-17 the run also ships a SEPARATE solo-breakout leg BEFORE
the carousel: Apify scrapes the account's recent tweets, and every tweet
that went viral inside the window — at most SOLO_BREAKOUT_HOURS old
(default 72) AND already >= SOLO_BREAKOUT_MIN_LIKES likes (default 6000)
— becomes its own standalone single-image IG post (same 1080x1350 card
template as the carousel slides, blank Buffer caption). Breakouts are
rare (usually 0-3 per run), and the 72h window plus the dedup gates mean
a tweet that stays viral for three days still ships only once. The solo
leg failing never blocks the carousel — each leg has its own cron_runs
row and its own try/except.

Internally each shipped carousel still advances a "Day N" counter — it no
longer appears on any slide, but it remains the per-day dedup key for the
TikTok mirror leg and a human-readable series marker in metadata.

The carousel always ships with exactly CAROUSEL_TWEET_COUNT slides —
if nine unused qualifying tweets can't be found, or any slide fails to
render, the run skips/fails cleanly and nothing is posted (the "Day N"
series never ships a short set).

Dedup: every tweet used on any shipped carousel is tracked and never
reused. Two layers:
  - metadata.tweet_ids on each carousel's posts row — the selection phase
    unions these across all live carousel rows and skips those ids;
  - posts.caption stores slide 1's tweet text, so the existing
    (platform, md5(caption)) partial-unique index also arbitrates
    concurrent runs, and post_caption_exists() text-checks every candidate
    against anything the old reel leg already shipped to the same channel.

The day counter needs no table of its own: day = (number of live carousel
rows) + 1. A buffer_error row drops out of that count, so a failed day is
retried under the same number the next run.

The same slide set also ships to TikTok as a photo-mode carousel (a
best-effort mirror leg after the Instagram send — see
_send_tiktok_carousel). Buffer publishes multiple image assets on a
TikTok channel as a photo carousel; TikTok auto-applies a music track
to photo posts on its side (Buffer's API exposes no music-selection
field, only isAiGenerated/title, so the track can't be chosen here).

Four cron_runs phases, platform='instagram':
  Phase 0 — solo_breakout:     render + send one standalone post per
                               fresh viral tweet (72h / 6K gates)
  Phase 1 — carousel_pick:     day number + 10 bank outlier tweets
  Phase 2 — carousel_generate: render the 10 tweet cards
  Phase 3 — carousel_send:     insert posts row + one Buffer carousel send,
                               then the TikTok mirror leg

Run locally with:  python -m cron.instagram_carousel_pipeline
Dry run (no DB write, no Buffer send):  CAROUSEL_DRY_RUN=1 python -m ...
"""

import logging
import os
import re
import sys

from core.buffer import get_channel_id, send_to_buffer
from core.content_gen_client import generate_content
from core.content_sources import fetch_apify_tweets, select_bank_content_with_likes
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

    Stored in metadata.title for the dashboard and used as the TikTok mirror
    row's dedup caption, which must be unique per day (see
    _send_tiktok_carousel for why slide 1's tweet text can't be that key).
    The old title-card wording ("Brutally honest advice…") was retired in
    Aug 2026; captions never collide across the formats because the day
    number only moves forward.
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
    bank_path: str,
    min_likes: int,
    count: int,
    used_tweet_ids: set[str],
) -> list[dict]:
    """Pick up to `count` unused outlier tweets from the CSV bank.

    Bank-only since 2026-08-17: fresh Apify tweets no longer feed the
    carousel — they ship as solo posts instead (see _pick_solo_breakouts).
    The bank is a settled catalogue whose like counts are final, so
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
        bank_path, count=count * 8, min_likes=min_likes,
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
        2-day-old tweet could already be on yesterday's carousel),
      - text not already posted to Instagram in any format — this is also
        what keeps a tweet that stays viral for all 72 hours of the window
        from shipping again on the next run, because each solo post stores
        the full tweet text as its caption,
      - not a fingerprint-duplicate of a breakout picked earlier this run.

    Returns dicts of {'tweet_id', 'text', 'normalized', 'favorite_count'},
    keeping Apify's newest-first order.
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


def _send_solo_breakouts(
    breakouts: list[dict],
    *,
    dashboard_url: str,
    cron_secret: str,
    dry_run: bool,
) -> int:
    """Render each breakout as a 1080x1350 card and ship it as its own
    single-image IG post via Buffer. Returns how many were sent.

    Unlike the carousel (all-or-nothing — the Day-N series never ships a
    short set), each solo post is independent: a render or send failure on
    one breakout logs and moves on, because holding back tweet A over
    tweet B's failure helps no one. A failed one retries naturally on the
    next run — nothing was inserted for it, so the dedup gates still let
    it through.
    """
    if not breakouts:
        logger.info("No solo breakouts this run.")
        return 0

    # One render call for the whole batch — same template row the carousel
    # slides use, so solos and slides are visually identical.
    data = generate_content(
        dashboard_url=dashboard_url,
        cron_secret=cron_secret,
        tweets=[{"id": b["tweet_id"], "text": b["text"]} for b in breakouts],
        platform="instagram",
    )
    if data.get("error"):
        raise RuntimeError(data["error"])
    for i, err in enumerate(data.get("errors", []) or []):
        logger.warning("  solo render error[%d]: %s", i, err)
    rendered = {str(item["id"]): item for item in data.get("generated", []) or []}

    ig_channel_id = None if dry_run else get_channel_id(service="instagram")

    sent = 0
    for b in breakouts:
        card = rendered.get(b["tweet_id"])
        if card is None:
            logger.warning(
                "Solo breakout %s dropped by render — will retry next run", b["tweet_id"]
            )
            continue
        if dry_run:
            logger.info(
                "DRY RUN — would send solo breakout (%d likes): %.60s",
                b["favorite_count"], b["normalized"],
            )
            continue

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
            metadata={
                "source": "solo_breakout",
                "tweet_id": b["tweet_id"],
                "favorite_count": b["favorite_count"],
            },
        )
        try:
            post_id = insert_post(post)
        except Exception as e:
            if _is_unique_violation(e):
                logger.info(
                    "Dedup race lost (DB constraint) — breakout already posted: %.50s",
                    card["text"],
                )
                continue
            raise

        try:
            buffer_post_id = send_to_buffer(
                ig_channel_id,
                BUFFER_CAPTION,  # blank — the content is on the card
                build_proxy_url(post_id, 0),
                media_type="image",
                instagram_post_type="post",
            )
            record_buffer_handoff(
                post_id, buffer_post_id,
                channel_id=ig_channel_id,
                body=BUFFER_CAPTION,
                media_type="image",
                instagram_post_type="post",
                base_metadata=post.metadata,
            )
            sent += 1
            logger.info(
                "Solo breakout queued (%d likes): post %s, Buffer %s — %.60s",
                b["favorite_count"], post_id, buffer_post_id, b["normalized"],
            )
        except Exception as e:
            # Flip to buffer_error so the row leaves the dedup index and the
            # breakout can retry on the next run (still inside its 72h window).
            logger.error("Solo breakout Buffer send failed: %s", e, exc_info=True)
            try:
                update_post(post_id, status="buffer_error", error_message=str(e)[:500])
            except Exception as db_err:
                logger.error("Also failed to mark post %s as buffer_error: %s", post_id, db_err)
    return sent


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
            # Solo-breakout leg. Missing -> fetch_apify_tweets returns []
            # and the run is carousel-only.
            "APIFY_API_KEY",
        ],
        optional=[
            "APIFY_TWITTER_HANDLE",
            "CONTENT_BANK_PATH",
            "CAROUSEL_MIN_LIKES",
            "CAROUSEL_TWEET_COUNT",
            "CAROUSEL_DRY_RUN",
            "SOLO_BREAKOUT_HOURS",
            "SOLO_BREAKOUT_MIN_LIKES",
        ],
    )

    twitter_handle = os.environ.get("APIFY_TWITTER_HANDLE", "AlexHormozi")
    bank_path = os.environ.get("CONTENT_BANK_PATH", "data/TweetMasterBank.csv")
    # Carousel bar — the bank is a settled catalogue, so this is a "proven
    # performer" floor (set to 4000 on Render, 2026-08-17).
    min_likes = int(os.environ.get("CAROUSEL_MIN_LIKES", "6500"))
    # Solo-breakout gates: an Apify tweet only qualifies if it's at most
    # this many hours old AND already above this likes bar — i.e. it went
    # viral within the window. The bar sits higher than the carousel's
    # because a 3-day-old tweet's count is still climbing.
    solo_hours = int(os.environ.get("SOLO_BREAKOUT_HOURS", "72"))
    solo_min_likes = int(os.environ.get("SOLO_BREAKOUT_MIN_LIKES", "6000"))
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
    # PHASE 0: Solo breakouts — one standalone post per fresh viral tweet
    # ─────────────────────────────────────────────────────────────────────
    # Runs BEFORE the carousel so its posts rows are visible to the
    # carousel's post_caption_exists gate (a breakout that also lives in
    # the bank can't ship twice in one run). Its failure never blocks the
    # carousel: no sys.exit here, just its own cron_runs row.
    run_id = log_cron_start(platform="instagram", job_type="solo_breakout")
    try:
        # Reuse the carousel ledger: until 2026-08-17 the carousel's Apify
        # pathway shipped recent tweets as slides, so a 2-day-old breakout
        # could already be on yesterday's carousel.
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
        sent = _send_solo_breakouts(
            breakouts,
            dashboard_url=dashboard_url,
            cron_secret=cron_secret,
            dry_run=dry_run,
        )
        log_cron_finish(run_id, status="success", posts_processed=sent)
        logger.info(
            "Phase 0: %d solo breakout(s) shipped (%d qualified, window=%dh, >= %d likes)",
            sent, len(breakouts), solo_hours, solo_min_likes,
        )
    except Exception as e:
        logger.error("Phase 0 failed (solo breakouts): %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))

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
            bank_path=bank_path,
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

        # ─── TIKTOK MIRROR LEG (best-effort) ─────────────────────────────
        # The IG carousel is the primary send — by this point it's queued,
        # so a TikTok hiccup must not fail the run. The note (if any) rides
        # in error_message so the dashboard shows the leg's health without
        # a separate cron_runs row.
        tiktok_note = _send_tiktok_carousel(
            storage_paths=storage_paths,
            dedup_caption=dedup_caption,
            metadata=metadata,
            day=day,
        )

        log_cron_finish(
            run_id, status="success", posts_processed=1, error_message=tiktok_note,
        )
        logger.info(
            "Phase 3 complete: Day %d carousel (%d slides) sent to Buffer (post %s, Buffer %s)%s",
            day, len(storage_paths), post_id, buffer_post_id,
            f" — {tiktok_note}" if tiktok_note else " — tiktok leg OK",
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


def _send_tiktok_carousel(
    *,
    storage_paths: list[str],
    dedup_caption: str,
    metadata: dict,
    day: int,
) -> str | None:
    """Queue the same slides to Buffer's TikTok channel as a photo carousel.

    Mirrors the Instagram send: one posts row carrying all the slides, one
    Buffer createPost with one image asset per slide. Buffer publishes
    multiple images on a TikTok channel as a photo-mode carousel; TikTok
    auto-applies a music track to photo posts (there is no music field in
    Buffer's TikTokPostMetadataInput — verified by schema introspection —
    so the specific track can't be chosen from here).

    The metadata dict is reused verbatim (source='carousel', day,
    tweet_ids). That's safe for the day counter and the never-reuse
    ledger: _fetch_carousel_history filters on platform='instagram', so
    tiktok rows never double-count.

    Returns None on success, or a short human-readable note for the
    carousel_send run's error_message. NEVER raises — the IG carousel has
    already shipped by the time this runs.
    """
    try:
        tiktok_channel_id = get_channel_id(service="tiktok")
    except Exception as e:
        logger.warning("TikTok channel lookup failed — skipping TikTok leg: %s", e)
        return f"tiktok skipped (channel lookup failed: {str(e)[:120]})"

    # Insert-first-then-send, same as the IG row above — but the TikTok
    # row's dedup caption is the internal series label ("... (Day N)",
    # unique per day), not slide 1's tweet text. The retired tweet-reel
    # pipeline filled platform='tiktok' rows with tweet texts, so keying on
    # the tweet would wrongly block any carousel whose slide-1 tweet once
    # shipped as a reel. The label still arbitrates the real risk (the same
    # day double-queued by concurrent/re-runs) via the (platform,
    # md5(caption)) index. It is never rendered or shown on TikTok — the
    # Buffer send below posts a blank caption.
    tiktok_caption = metadata.get("title") or dedup_caption
    post = Post(
        platform="tiktok",
        status="sent_to_buffer",
        media_type="carousel",
        media_urls=storage_paths,
        caption=tiktok_caption,
        metadata=metadata,
    )
    try:
        tiktok_post_id = insert_post(post)
    except Exception as e:
        if _is_unique_violation(e):
            logger.info(
                "TikTok dedup — this day already queued to TikTok, skipping leg: %.50s",
                tiktok_caption,
            )
            return "tiktok skipped (day already queued)"
        logger.error("TikTok carousel insert failed: %s", e, exc_info=True)
        return f"tiktok insert failed: {str(e)[:120]}"

    try:
        media_urls = [build_proxy_url(tiktok_post_id, i) for i in range(len(storage_paths))]
        buffer_post_id = send_to_buffer(
            tiktok_channel_id,
            BUFFER_CAPTION,  # blank, same as IG — the content is on the cards
            media_urls,
            media_type="image",
        )
        record_buffer_handoff(
            tiktok_post_id, buffer_post_id,
            channel_id=tiktok_channel_id,
            body=BUFFER_CAPTION,
            media_type="image",
            base_metadata=metadata,
        )
        logger.info(
            "Day %d carousel also queued to TikTok (post %s, Buffer %s)",
            day, tiktok_post_id, buffer_post_id,
        )
        return None
    except Exception as e:
        # Flip to buffer_error so the row leaves the dedup index and
        # buffer_reconcile (which allows carousel-source tiktok re-sends)
        # or a future manual retry can pick it up.
        logger.error("TikTok carousel Buffer send failed: %s", e, exc_info=True)
        try:
            update_post(tiktok_post_id, status="buffer_error", error_message=str(e)[:500])
        except Exception as db_err:
            logger.error("Also failed to mark TikTok post %s as buffer_error: %s", tiktok_post_id, db_err)
        return f"tiktok buffer send failed: {str(e)[:120]}"


if __name__ == "__main__":
    main()

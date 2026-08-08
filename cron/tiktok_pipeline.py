"""Tweet Card Outlier pipeline — automated cron job.

Runs daily at 11:00 UTC (4:00 AM PDT) to scrape viral @AlexHormozi tweets
and fan them out as quote-card content across the platform legs:

  * Facebook  — 1080×1080 PNG image (Alex's square template)
  * LinkedIn  — 1080×1080 PNG image (reuses the Facebook render bytes —
                no separate render call)
  * Instagram — paused by default (IG_TWEET_CARD_FORMAT='off'); the
                standalone carousel cron owns Instagram now. Setting
                'image' restores the 1080×1440 portrait PNG feed post.

The TikTok leg (1080×1920 MP4 reel, formerly the primary leg) was
RETIRED in Aug 2026 — the operator stopped publishing to TikTok.
Facebook is the anchor leg now: Phase-2 dedup keys on facebook posts
rows, and the run aborts if the Facebook render produces nothing
(LinkedIn reuses the FB bytes, so without them nothing can ship at
all). Restore the leg from git history if TikTok ever comes back.

cron_runs.platform stays "tiktok" and the three job_type phases keep
their historical names — that's the orchestrator's identity, and the
dashboard's getLastRun() query and the run history key on it. Renaming
would orphan the history without buying anything. Same reason the
module keeps its tiktok_pipeline name and render.yaml keeps the
tweet-reel-recent service name.

  Phase 1 — content_fetch: scrape outlier tweets from X via Apify
  Phase 2 — content_generate: render FB PNG (+ IG PNG in 'image' mode)
  Phase 3 — buffer_send: FB → LI → IG fan-out per tweet

Failure rules:
  - Phase 1 fail (Apify) — abort the run.
  - Phase 2 fail for FB render — abort. LinkedIn reuses the FB bytes
    and dedup anchors on facebook, so there is nothing to ship.
  - Phase 2 fail for IG render — log a warning; only the IG leg skips
    per tweet. FB/LI legs still ship.
  - Phase 3 leg failure — recorded in posts table (buffer_error status
    releases the row from the dedup index for retry); counts go into
    the run's error_message summary.
"""

import logging
import os
import sys

from core.database import (
    log_cron_finish,
    log_cron_start,
    post_caption_exists,
)
from core.env_diag import log_env_diagnostics
from core.text_utils import normalize_tweet_text
from core.content_sources import fetch_apify_tweets
from cron._tweet_card_legs import (
    fanout_extra_legs_for_one_tweet,
    instagram_card_format,
    render_extra_platforms,
    resolve_extra_channel_ids,
    summarize_leg_failures,
)


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Tag the row's metadata so future audits can tell outlier rows from
# bank rows. Nothing reads this downstream anymore but it's cheap to
# keep, and the dashboard filters on it.
SOURCE_TAG = "outlier"


def main():
    log_env_diagnostics(
        "tiktok-pipeline",
        required=[
            "SUPABASE_URL",
            "SUPABASE_SERVICE_KEY",
            "APIFY_API_KEY",
            "DASHBOARD_URL",
            "CRON_SECRET",
            "BUFFER_ACCESS_TOKEN",
            "BUFFER_ORG_ID",
        ],
        optional=["APIFY_TWITTER_HANDLE", "TIKTOK_MIN_LIKES", "TIKTOK_MAX_ITEMS"],
    )

    twitter_handle = os.environ.get("APIFY_TWITTER_HANDLE", "AlexHormozi")
    max_items = int(os.environ.get("TIKTOK_MAX_ITEMS", "15"))
    min_likes = int(os.environ.get("TIKTOK_MIN_LIKES", "4000"))
    dashboard_url = os.environ.get("DASHBOARD_URL", "")
    cron_secret = os.environ.get("CRON_SECRET", "")

    if not dashboard_url:
        logger.error("DASHBOARD_URL not set — cannot call dashboard API for content generation")
        sys.exit(1)

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 1: Fetch outlier tweets via Apify
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="tiktok", job_type="content_fetch")
    try:
        tweets = fetch_apify_tweets(
            twitter_handle,
            max_items=max_items,
            # No time window — quote-card content ages gracefully, so we
            # widen the funnel to "the latest N tweets that meet the
            # engagement bar." Per-platform dedup against the posts
            # table is the real "already posted" guard.
            hours_lookback=None,
            min_favorites=min_likes,
        )
        log_cron_finish(run_id, status="success", posts_processed=len(tweets))
        logger.info("Phase 1: fetched %d outlier tweets from @%s", len(tweets), twitter_handle)
    except Exception as e:
        logger.error("Phase 1 failed (fetch): %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    if not tweets:
        logger.info("No tweets found — nothing to do. Exiting.")
        return

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 2 (in-memory): Normalize + Facebook dedup
    # ─────────────────────────────────────────────────────────────────────
    # We dedup against Facebook because it's the anchor leg now that the
    # TikTok leg is retired — LinkedIn reuses the FB bytes, so a caption
    # already shipped to FB has nothing left to anchor on. LI/IG legs do
    # their own per-platform dedup later inside the fan-out helper
    # (post_caption_exists call there). Tweets that shipped to TikTok in
    # the past but whose FB leg failed or skipped will surface again here
    # — that's intentional (FB never got them).
    new_tweets = []
    for tweet in tweets:
        normalized = normalize_tweet_text(tweet["text"])
        if post_caption_exists("facebook", normalized):
            logger.debug("Skipping duplicate (facebook): %s...", normalized[:50])
            continue
        tweet["normalized"] = normalized
        new_tweets.append(tweet)

    logger.info(
        "Phase 2: %d new tweets after Facebook dedup (%d filtered)",
        len(new_tweets), len(tweets) - len(new_tweets),
    )

    if not new_tweets:
        logger.info("All tweets already scheduled on Facebook — nothing to generate. Exiting.")
        return

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 3: Generate content via dashboard API
    #   Facebook PNGs (1080×1080, also shipped to LI; fatal on an empty
    #   result — nothing can ship without them) and, in 'image' mode
    #   only, Instagram PNGs (1080×1440 portrait; non-fatal — empty map
    #   skips just the IG leg per tweet).
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="tiktok", job_type="content_generate")
    try:
        extra_paths = render_extra_platforms(
            dashboard_url=dashboard_url,
            cron_secret=cron_secret,
            tweets=new_tweets,
        )
        # render_extra_platforms never raises (per-platform best-effort),
        # so promote an empty Facebook map to a phase failure here — FB is
        # the anchor render and LI ships its bytes.
        if not extra_paths["facebook"]:
            raise RuntimeError("Facebook render returned no images — nothing to ship")
        logger.info("Phase 3: rendered %d Facebook images", len(extra_paths["facebook"]))

        log_cron_finish(
            run_id,
            status="success",
            posts_processed=len(extra_paths["facebook"]),
            error_message=_render_summary(extra_paths),
        )
    except Exception as e:
        logger.error("Phase 3 failed (generate): %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 4: Fan out to FB + LI + Pinterest (+ IG in 'image' mode) via Buffer
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="tiktok", job_type="buffer_send")
    sent_count = 0   # tweets where at least one leg shipped
    error_count = 0
    leg_results: list[dict] = []

    # Channel/board lookups degrade gracefully: a None channel id means that
    # leg is skipped for the whole run (skipped_no_channel / skipped_no_board).
    (
        fb_channel_id,
        li_channel_id,
        ig_channel_id,
        pin_channel_id,
        pin_board_service_id,
    ) = resolve_extra_channel_ids()

    for tweet in new_tweets:
        tweet_id = str(tweet["id"])
        # The normalized text is byte-identical to what the render API
        # stamped on the images and returned as `text` (core.text_utils
        # mirrors the dashboard's normalizeTweetText), so dedup keys stay
        # consistent with rows written before the TikTok-leg removal.
        caption = tweet["normalized"]

        if not caption or not caption.strip():
            logger.warning("Skipping tweet %s with empty caption", tweet_id)
            error_count += 1
            continue

        fb_path = extra_paths["facebook"].get(tweet_id)
        ig_path = extra_paths["instagram"].get(tweet_id)

        # The whole fan-out call is wrapped in try/except because
        # `_send_or_skip` calls `post_caption_exists()` (a bare Supabase
        # query) BEFORE the protected `send_leg()` body — a transient
        # Supabase blip on any leg would otherwise unwind out of the
        # for-loop and skip `log_cron_finish` below, leaving
        # `cron_runs.status='running'` permanently. Catching here lets
        # the loop continue to the next tweet and lets the final
        # `log_cron_finish` always run.
        try:
            leg_result = fanout_extra_legs_for_one_tweet(
                tweet_caption=caption,
                fb_storage_path=fb_path,
                ig_storage_path=ig_path,
                fb_channel_id=fb_channel_id,
                li_channel_id=li_channel_id,
                ig_channel_id=ig_channel_id,
                pin_channel_id=pin_channel_id,
                pin_board_service_id=pin_board_service_id,
                source_tag=SOURCE_TAG,
            )
            leg_results.append(leg_result)
            if any(r["status"] == "sent" for r in leg_result.values()):
                sent_count += 1
        except Exception as e:
            logger.error(
                "fan-out raised for tweet %s (continuing): %s",
                tweet_id, e, exc_info=True,
            )
            error_count += 1

    # Run status: success if any tweet shipped at least one leg. Per-leg
    # failures surface via error_message and via posts.status='buffer_error'
    # rows — not by failing the run.
    final_status = "success" if sent_count > 0 else "failed"
    error_msg_parts: list[str] = []
    if error_count > 0:
        error_msg_parts.append(f"fan-out errors: {error_count}")
    leg_summary = summarize_leg_failures(leg_results)
    if leg_summary:
        error_msg_parts.append(leg_summary)
    error_msg = "; ".join(error_msg_parts) or None

    log_cron_finish(
        run_id, status=final_status,
        posts_processed=sent_count, error_message=error_msg,
    )
    logger.info(
        "Phase 4 complete: %d tweets shipped, %d errors, fan-out summary: %s",
        sent_count, error_count, leg_summary or "all legs OK",
    )


def _render_summary(extra_paths: dict[str, dict[str, str]]) -> str | None:
    """Compact one-line note when the optional IG render came back empty.

    Used as the Phase-3 error_message field. A missing Facebook render is
    fatal upstream (the phase raises before this runs on success), so the
    only best-effort render left to report on is Instagram — and only in
    'image' mode; in the default 'off' mode an empty IG dict is expected,
    not a failure worth flagging. Returns None when there's nothing to
    flag so the success record stays clean.
    """
    if instagram_card_format() == "image" and not extra_paths.get("instagram"):
        return "no instagram renders"
    return None


if __name__ == "__main__":
    main()

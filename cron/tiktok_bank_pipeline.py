"""Tweet Card Bank pipeline — daily cron job.

Runs daily at 11:15 UTC (4:15 AM PDT) to pick 1 high-performing tweet
from the TweetMasterBank CSV and fan it out as quote-card content across
the platform legs:

  * Facebook  — 1080×1080 PNG image
  * LinkedIn  — 1080×1080 PNG image (reuses the Facebook bytes — no
                separate render call)
  * Instagram — paused by default (IG_TWEET_CARD_FORMAT='off'); the
                standalone carousel cron owns Instagram now. Setting
                'image' restores the 1080×1440 portrait PNG feed post.

The TikTok leg (1080×1920 MP4 reel, formerly the primary leg) was
RETIRED in Aug 2026 — the operator stopped publishing to TikTok.
Facebook is the anchor leg now: the Phase-1 pick dedups against
facebook posts rows and the run aborts if the Facebook render produces
nothing. Restore the leg from git history if TikTok ever comes back.

Companion to cron/tiktok_pipeline.py — same fan-out shape but sources
from the CSV bank instead of Apify. Both write to the same `posts` table
and rely on the partial unique index on (platform, md5(caption)) to
prevent cross-pipeline duplicates.

cron_runs.platform stays "tiktok" and the job_type phase names are
preserved — that's the orchestrator's historical identity, and the
dashboard's getLastRun() query keys on it (see cron/tiktok_pipeline.py).

  Phase 1 — bank_pick:     pick 1 random unposted bank tweet
  Phase 2 — bank_generate: render FB PNG (+ IG PNG in 'image' mode)
  Phase 3 — bank_send:     FB → LI → IG fan-out
"""

import logging
import os
import sys

from core.content_sources import select_bank_content_with_likes
from core.database import (
    log_cron_finish,
    log_cron_start,
    post_caption_exists,
)
from core.env_diag import log_env_diagnostics
from core.text_utils import normalize_tweet_text
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

# Bank rows carry source="bank" so the dashboard can filter outlier vs
# bank traffic. Nothing downstream reads it anymore but it's cheap to
# keep.
SOURCE_TAG = "bank"


def main():
    log_env_diagnostics(
        "tiktok-bank-pipeline",
        required=[
            "SUPABASE_URL",
            "SUPABASE_SERVICE_KEY",
            "DASHBOARD_URL",
            "CRON_SECRET",
            "BUFFER_ACCESS_TOKEN",
            "BUFFER_ORG_ID",
        ],
        optional=["CONTENT_BANK_PATH", "TIKTOK_BANK_MIN_LIKES"],
    )

    bank_path = os.environ.get("CONTENT_BANK_PATH", "data/TweetMasterBank.csv")
    min_likes = int(os.environ.get("TIKTOK_BANK_MIN_LIKES", "6500"))
    dashboard_url = os.environ.get("DASHBOARD_URL", "")
    cron_secret = os.environ.get("CRON_SECRET", "")

    if not dashboard_url:
        logger.error("DASHBOARD_URL not set — cannot call dashboard API for content generation")
        sys.exit(1)

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 1: Pick 1 bank tweet (Facebook-dedup against posts)
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="tiktok", job_type="bank_pick")
    try:
        # Pull more candidates than we need so we have room after the
        # Facebook dedup. The bank has ~18K tweets; with the 6500-like
        # filter we have several thousand candidates, so 20 is cheap and
        # gives plenty of fallback when the top picks are already posted.
        candidates = select_bank_content_with_likes(
            bank_path, count=20, min_likes=min_likes,
        )

        picked = None
        for candidate in candidates:
            normalized = normalize_tweet_text(candidate["text"])
            # Facebook is the anchor leg now that the TikTok leg is
            # retired — LinkedIn reuses the FB bytes, so an FB duplicate
            # has nothing left to anchor on.
            if post_caption_exists("facebook", normalized):
                logger.debug("Skipping duplicate (facebook): %s...", normalized[:50])
                continue
            candidate["normalized"] = normalized
            picked = candidate
            break

        if not picked:
            logger.info("No usable bank tweet (all Facebook-duplicates or bank exhausted). Exiting.")
            log_cron_finish(run_id, status="success", posts_processed=0)
            return

        log_cron_finish(run_id, status="success", posts_processed=1)
        logger.info(
            "Phase 1: picked bank tweet (id=%s, %d likes): %s...",
            picked["tweet_id"], picked["favorite_count"], picked["normalized"][:60],
        )
    except Exception as e:
        logger.error("Phase 1 failed (bank pick): %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    # Shape the picked tweet to match the {'id', 'text'} contract
    # render_extra_platforms expects (it pulls 'id' as the result key).
    tweet_for_render = {"id": picked["tweet_id"], "text": picked["normalized"]}

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 2: Render Facebook PNG (+ Instagram PNG in 'image' mode)
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="tiktok", job_type="bank_generate")
    try:
        # The FB 1:1 PNG is reused for the LinkedIn leg downstream (no
        # separate LI render). The IG render only happens in 'image' mode
        # and is best-effort — an empty IG result skips only the IG leg.
        extra_paths = render_extra_platforms(
            dashboard_url=dashboard_url,
            cron_secret=cron_secret,
            tweets=[tweet_for_render],
        )
        # render_extra_platforms never raises (per-platform best-effort),
        # so promote an empty Facebook map to a phase failure here — FB is
        # the anchor render and nothing can ship without it.
        if not extra_paths["facebook"]:
            raise RuntimeError("Facebook render returned no image — nothing to ship")

        log_cron_finish(
            run_id,
            status="success",
            posts_processed=1,
            error_message=_render_summary(extra_paths),
        )
        logger.info("Phase 2: rendered Facebook image")
    except Exception as e:
        logger.error("Phase 2 failed (generate): %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 3: Fan out to FB + LI (+ IG in 'image' mode) via Buffer
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="tiktok", job_type="bank_send")

    fb_channel_id, li_channel_id, ig_channel_id = resolve_extra_channel_ids()

    tweet_id = str(tweet_for_render["id"])
    caption = picked["normalized"]
    fb_path = extra_paths["facebook"].get(tweet_id)
    ig_path = extra_paths["instagram"].get(tweet_id)

    # Wrapped in try/except because `_send_or_skip` calls
    # `post_caption_exists()` (an unwrapped Supabase query) before the
    # protected `send_leg()` body — a transient Supabase blip would
    # otherwise unwind out and skip `log_cron_finish`, orphaning the
    # cron_runs row at status='running'.
    try:
        leg_result = fanout_extra_legs_for_one_tweet(
            tweet_caption=caption,
            fb_storage_path=fb_path,
            ig_storage_path=ig_path,
            fb_channel_id=fb_channel_id,
            li_channel_id=li_channel_id,
            ig_channel_id=ig_channel_id,
            source_tag=SOURCE_TAG,
        )
        leg_summary = summarize_leg_failures([leg_result])
        sent_any = any(r["status"] == "sent" for r in leg_result.values())
    except Exception as e:
        logger.error("fan-out raised for tweet %s: %s", tweet_id, e, exc_info=True)
        leg_summary = f"fan-out raised: {e!s}"
        sent_any = False

    # A run where every leg skipped (dedup race, channel lookup failure)
    # ships nothing — surface that as a failure with a reason so the
    # dashboard doesn't show a green run that posted nowhere.
    if not sent_any and not leg_summary:
        leg_summary = "no legs sent (all skipped — see posts table)"

    log_cron_finish(
        run_id,
        status="success" if sent_any else "failed",
        posts_processed=1 if sent_any else 0,
        error_message=leg_summary,
    )
    logger.info(
        "Phase 3 complete: fan-out summary: %s",
        leg_summary or "all legs OK",
    )


def _render_summary(extra_paths: dict[str, dict[str, str]]) -> str | None:
    """Compact one-line note when the optional IG render came back empty.

    Used as the Phase-2 error_message field. A missing Facebook render is
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

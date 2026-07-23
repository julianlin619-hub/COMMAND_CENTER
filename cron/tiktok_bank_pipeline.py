"""Tweet Card Bank pipeline — daily cron job.

Runs daily at 11:15 UTC (4:15 AM PDT) to pick 1 high-performing tweet
from the TweetMasterBank CSV and fan it out as quote-card content across
four platform legs:

  * TikTok    — 1080×1920 MP4 video
  * Facebook  — 1080×1080 PNG image
  * LinkedIn  — 1080×1080 PNG image (LinkedIn color overrides; reuses
                the Facebook bytes — no separate render call)
  * Instagram — 1080×1440 portrait PNG image (own template row)

Companion to cron/tiktok_pipeline.py — same fan-out shape but sources
from the CSV bank instead of Apify. Both write to the same `posts` table
with platform values "tiktok" / "facebook" / "linkedin" / "instagram"
and rely on the partial unique index on (platform, md5(caption)) to
prevent cross-pipeline duplicates.

Three cron_runs phases are preserved so the dashboard's getLastRun()
query keeps working without schema changes:

  Phase 1 — bank_pick:     pick 1 random unposted bank tweet
  Phase 2 — bank_generate: render TikTok MP4 + FB PNG + IG PNG
  Phase 3 — bank_send:     TikTok → FB → LI → IG fan-out

cron_runs.platform stays "tiktok" because it's the orchestrator's
identity. Per-leg outcomes land in the `posts` table. See
cron/tiktok_pipeline.py's module docstring for the partial-failure
semantics — identical here for the single-tweet case.
"""

import logging
import os
import sys

from core.buffer import get_channel_id, send_to_buffer
from core.content_gen_client import generate_content
from core.content_sources import select_bank_content_with_likes
from core.database import (
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
from cron._tweet_card_legs import (
    BUFFER_CAPTION,
    _is_unique_violation,
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
# bank traffic. Nothing downstream reads it anymore (the chain to FB/LI
# is gone) but it's cheap to keep.
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
    # PHASE 1: Pick 1 bank tweet (TikTok-dedup against posts)
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="tiktok", job_type="bank_pick")
    try:
        # Pull more candidates than we need so we have room after TikTok
        # dedup. The bank has ~18K tweets; with the 6500-like filter we
        # have several thousand candidates, so 20 is cheap and gives
        # plenty of fallback when the top picks are already posted.
        candidates = select_bank_content_with_likes(
            bank_path, count=20, min_likes=min_likes,
        )

        picked = None
        for candidate in candidates:
            normalized = normalize_tweet_text(candidate["text"])
            if post_caption_exists("tiktok", normalized):
                logger.debug("Skipping duplicate (tiktok): %s...", normalized[:50])
                continue
            candidate["normalized"] = normalized
            picked = candidate
            break

        if not picked:
            logger.info("No usable bank tweet (all TikTok-duplicates or bank exhausted). Exiting.")
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
    # PHASE 2: Render TikTok MP4, then Facebook PNG, then LinkedIn PNG
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="tiktok", job_type="bank_generate")
    try:
        data = generate_content(
            dashboard_url=dashboard_url,
            cron_secret=cron_secret,
            tweets=[tweet_for_render],
            platform="tiktok",
        )
        if data.get("error"):
            raise RuntimeError(data["error"])

        for i, err in enumerate(data.get("errors", []) or []):
            logger.warning("  tiktok render error[%d]: %s", i, err)

        generated = data.get("generated", []) or []
        if not generated:
            raise RuntimeError(
                f"TikTok render returned no items (API errors: {data.get('errors', [])})"
            )
        logger.info("Phase 2a: generated %d TikTok video(s)", len(generated))

        # Facebook + Instagram renders are both best-effort. The FB 1:1
        # PNG is reused for the LinkedIn leg downstream (no separate LI
        # render). The IG render is portrait 1080×1440, its own leg only.
        # An empty FB result means FB + LI legs skip; an empty IG result
        # means only the IG leg skips for this run.
        extra_paths = render_extra_platforms(
            dashboard_url=dashboard_url,
            cron_secret=cron_secret,
            tweets=[tweet_for_render],
        )

        log_cron_finish(
            run_id,
            status="success",
            posts_processed=len(generated),
            error_message=_render_summary(extra_paths),
        )
    except Exception as e:
        logger.error("Phase 2 failed (generate): %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 3: Send TikTok video, then fan out to FB + LI
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="tiktok", job_type="bank_send")

    try:
        tiktok_channel_id = get_channel_id(service="tiktok")
    except Exception as e:
        logger.error("Phase 3 failed — could not get TikTok channel ID: %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    fb_channel_id, li_channel_id, ig_channel_id = resolve_extra_channel_ids()

    item = generated[0]
    storage_path = item["storagePath"]
    caption = item["text"]

    if not caption or not caption.strip():
        logger.warning("Skipping tweet with empty caption (storage: %s)", storage_path)
        log_cron_finish(run_id, status="failed", error_message="Empty caption after generation")
        sys.exit(1)

    # ─── TIKTOK LEG (insert first, then send) ────────────────────────────
    post = Post(
        platform="tiktok",
        status="sent_to_buffer",
        media_type="video",
        media_urls=[storage_path],
        caption=caption,
        metadata={"source": SOURCE_TAG},
    )
    try:
        post_id = insert_post(post)
    except Exception as e:
        if _is_unique_violation(e):
            logger.info("Skipping duplicate (DB constraint): %s...", caption[:50])
            log_cron_finish(run_id, status="success", posts_processed=0)
            return
        logger.error("TikTok insert failed for %s: %s", storage_path, e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    try:
        video_url = build_proxy_url(post_id)
        buffer_post_id = send_to_buffer(
            tiktok_channel_id, BUFFER_CAPTION, video_url, media_type="video",
        )
        # Persist the replay payload so buffer_reconcile can re-send this
        # exact post if Buffer later fails to publish it.
        record_buffer_handoff(
            post_id, buffer_post_id,
            channel_id=tiktok_channel_id,
            body=BUFFER_CAPTION,
            media_type="video",
            base_metadata={"source": SOURCE_TAG},
        )
        logger.info("[tiktok] sent to Buffer: %s (Buffer post %s)", storage_path, buffer_post_id)
    except Exception as e:
        logger.error("[tiktok] Buffer send failed for %s: %s", storage_path, e, exc_info=True)
        try:
            update_post(post_id, status="buffer_error", error_message=str(e)[:500])
        except Exception as db_err:
            logger.error("[tiktok] also failed to mark buffer_error: %s", db_err)
        # TikTok failed — skip the fan-out and end the run as a failure.
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    # ─── FACEBOOK + LINKEDIN + INSTAGRAM FAN-OUT ─────────────────────────
    # LinkedIn reuses the Facebook 1:1 PNG — no separate LI render call.
    # Instagram has its own 1080×1440 portrait render (own template row,
    # own storage path), so its path is looked up from the IG sub-dict.
    # Wrapped in try/except because `_send_or_skip` calls
    # `post_caption_exists()` (an unwrapped Supabase query) before the
    # protected `send_leg()` body — a transient Supabase blip would
    # otherwise unwind out and skip `log_cron_finish`, orphaning the
    # cron_runs row at status='running'.
    tweet_id = str(item.get("id", ""))
    fb_path = extra_paths["facebook"].get(tweet_id)
    ig_path = extra_paths["instagram"].get(tweet_id)
    try:
        leg_result = fanout_extra_legs_for_one_tweet(
            tweet_caption=caption,
            fb_storage_path=fb_path,
            ig_storage_path=ig_path,
            # This tweet's TikTok MP4 path — reused for the IG reel when
            # IG_TWEET_CARD_FORMAT='video' (the default).
            tiktok_storage_path=storage_path,
            fb_channel_id=fb_channel_id,
            li_channel_id=li_channel_id,
            ig_channel_id=ig_channel_id,
            source_tag=SOURCE_TAG,
        )
        leg_summary = summarize_leg_failures([leg_result])
    except Exception as e:
        logger.error("fan-out raised for tweet %s: %s", tweet_id, e, exc_info=True)
        leg_summary = f"fan-out raised: {e!s}"

    log_cron_finish(
        run_id, status="success", posts_processed=1, error_message=leg_summary,
    )
    logger.info(
        "Phase 3 complete: tiktok sent + fan-out summary: %s",
        leg_summary or "all legs OK",
    )


def _render_summary(extra_paths: dict[str, dict[str, str]]) -> str | None:
    """One-line description of the FB + IG render results for the bank run.

    Used as the Phase-2 error_message field. Helps operators tell
    "render dropped the leg" from "render succeeded but Buffer rejected
    everything." LinkedIn reuses the FB bytes (so an empty FB result
    skips FB + LI), while Instagram has its own render (so an empty
    IG result skips only the IG leg). Returns None when both renders
    produced at least one image so the success record stays clean.
    """
    missing: list[str] = []
    if not extra_paths.get("facebook"):
        missing.append("facebook")
    # An IG render only happens in 'image' mode — in 'video' mode the leg
    # reuses the TikTok MP4 and in 'off' mode it's paused, so an empty IG
    # dict is expected there, not a failure worth flagging.
    if instagram_card_format() == "image" and not extra_paths.get("instagram"):
        missing.append("instagram")
    if not missing:
        return None
    return "no " + " or ".join(missing) + " renders"


if __name__ == "__main__":
    main()

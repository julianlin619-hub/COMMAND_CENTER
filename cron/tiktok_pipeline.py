"""Tweet Card Outlier pipeline — automated cron job.

Runs daily at 11:00 UTC (4:00 AM PDT) to scrape viral @AlexHormozi tweets
and fan them out as quote-card content across three platforms:

  * TikTok    — 1080×1920 MP4 video
  * Facebook  — 1080×1080 PNG image (Alex's square template)
  * LinkedIn  — 1080×1080 PNG image (LinkedIn color overrides)

Before this consolidation, the same source tweets were processed by three
separate crons running on a stagger (TikTok 11:00, Facebook 11:30,
LinkedIn 12:00) where Facebook and LinkedIn re-read TikTok's database
rows from the previous 24h. That chain was fragile — a metadata.source
filter bug on the FB/LI hop could silently break the entire fan-out.
We now run the whole flow in-process so the platforms can't get out of
sync, and so we can reason about partial failures in one place.

Three cron_runs phases are preserved so the dashboard's getLastRun()
query keeps working without schema changes:

  Phase 1 — content_fetch: scrape outlier tweets from X via Apify
  Phase 2 — content_generate: render TikTok MP4 + Facebook PNG + LinkedIn PNG
  Phase 3 — buffer_send: TikTok → FB → LI fan-out per tweet

cron_runs.platform stays "tiktok" because it's the orchestrator's
identity, not the leg. Per-leg outcomes land in the `posts` table (one
row per platform per tweet shipped) — there is no metadata column on
cron_runs (verified in supabase/migrations/20260412105430_initial_schema.sql).
The Phase-3 cron_runs.error_message string summarises non-fatal FB/LI
leg failures.

Failure rules:
  - Phase 1 fail (Apify) — abort the run.
  - Phase 2 fail for TikTok render — abort. We can't ship the FB/LI legs
    on their own because dedup ties them to the TikTok caption.
  - Phase 2 fail for FB or LI render — log a warning; that platform's
    storage_path map stays empty, so the fan-out skips that leg per
    tweet. TikTok publishes go ahead.
  - Phase 3 fail per tweet (TikTok) — increment error counter; continue.
  - Phase 3 FB/LI leg failure — recorded in posts table (buffer_error
    status releases the row from the dedup index for retry); counts go
    into the run's error_message summary.
"""

import logging
import os
import sys

from core.buffer import get_channel_id, send_to_buffer
from core.content_gen_client import generate_content
from core.database import (
    insert_post,
    log_cron_finish,
    log_cron_start,
    post_caption_exists,
    update_post,
)
from core.env_diag import log_env_diagnostics
from core.media import get_signed_url
from core.models import Post
from core.text_utils import normalize_tweet_text
from core.content_sources import fetch_apify_tweets
from cron._tweet_card_legs import (
    BUFFER_CAPTION,
    SIGNED_URL_EXPIRES_IN,
    _is_unique_violation,
    fanout_extra_legs_for_one_tweet,
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
# bank rows. Nothing reads this downstream anymore (the chain to FB/LI
# is gone) but it's cheap to keep, and the dashboard filters on it.
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
    # PHASE 2 (in-memory): Normalize + per-platform TikTok dedup
    # ─────────────────────────────────────────────────────────────────────
    # We dedup against TikTok here because TikTok is the "primary" leg —
    # if its caption is already shipped, there's nothing for the fan-out
    # to anchor on. FB/LI legs do their own per-platform dedup later
    # inside the fan-out helper (post_caption_exists call there).
    new_tweets = []
    for tweet in tweets:
        normalized = normalize_tweet_text(tweet["text"])
        if post_caption_exists("tiktok", normalized):
            logger.debug("Skipping duplicate (tiktok): %s...", normalized[:50])
            continue
        tweet["normalized"] = normalized
        new_tweets.append(tweet)

    logger.info(
        "Phase 2: %d new tweets after TikTok dedup (%d filtered)",
        len(new_tweets), len(tweets) - len(new_tweets),
    )

    if not new_tweets:
        logger.info("All tweets already scheduled on TikTok — nothing to generate. Exiting.")
        return

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 3: Generate content via dashboard API
    #   3a. TikTok MP4s  (fatal on failure — nothing to anchor the fan-out)
    #   3b. Facebook PNGs (non-fatal — empty map skips FB leg per tweet)
    #   3c. LinkedIn PNGs (non-fatal — empty map skips LI leg per tweet)
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="tiktok", job_type="content_generate")
    try:
        # 3a. TikTok render — same call shape as the legacy pipeline.
        data = generate_content(
            dashboard_url=dashboard_url,
            cron_secret=cron_secret,
            tweets=[{"id": t["id"], "text": t["text"]} for t in new_tweets],
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
        logger.info("Phase 3a: generated %d TikTok videos", len(generated))

        # 3b + 3c. Facebook + LinkedIn renders. The helper never raises;
        # a fully-failed platform yields an empty dict and the fan-out
        # skips it per tweet.
        extra_paths = render_extra_platforms(
            dashboard_url=dashboard_url,
            cron_secret=cron_secret,
            tweets=new_tweets,
        )

        # Phase succeeded as long as TikTok rendered something — FB/LI
        # are best-effort. Surface the FB/LI render counts in the
        # success record for observability.
        log_cron_finish(
            run_id,
            status="success",
            posts_processed=len(generated),
            error_message=_render_summary(extra_paths) if _render_summary(extra_paths) else None,
        )
    except Exception as e:
        logger.error("Phase 3 failed (generate): %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    if not generated:
        logger.info("No videos generated — nothing to send. Exiting.")
        return

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 4: Send to Buffer's TikTok queue, then fan out to FB + LI
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="tiktok", job_type="buffer_send")
    sent_count = 0
    error_count = 0
    leg_results: list[dict] = []

    # Resolve all three channel IDs up-front. The TikTok channel is
    # required; FB and LI failures degrade gracefully (per-leg skip).
    try:
        tiktok_channel_id = get_channel_id(service="tiktok")
    except Exception as e:
        logger.error("Phase 4 failed — could not resolve TikTok channel: %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    fb_channel_id, li_channel_id, ig_channel_id = resolve_extra_channel_ids()

    for item in generated:
        storage_path = item["storagePath"]
        caption = item["text"]

        if not caption or not caption.strip():
            logger.warning("Skipping tweet with empty caption (storage: %s)", storage_path)
            error_count += 1
            continue

        # ─── TIKTOK LEG (insert first, then send) ────────────────────────
        # Insert-before-send closes the race window where two concurrent
        # runs could both queue the same caption in Buffer. The partial
        # unique index from migration 004 arbitrates: only one insert
        # wins. On Buffer failure we flip to buffer_error so the row
        # releases from the dedup index for retry.
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
                continue
            logger.error("TikTok insert failed for %s: %s", storage_path, e, exc_info=True)
            error_count += 1
            continue

        try:
            video_url = get_signed_url(storage_path, expires_in=SIGNED_URL_EXPIRES_IN)
            buffer_post_id = send_to_buffer(
                tiktok_channel_id, BUFFER_CAPTION, video_url, media_type="video",
            )
            update_post(post_id, platform_post_id=buffer_post_id)
            sent_count += 1
            logger.info("[tiktok] sent to Buffer: %s (Buffer post %s)", storage_path, buffer_post_id)
        except Exception as e:
            logger.error("[tiktok] Buffer send failed for %s: %s", storage_path, e, exc_info=True)
            try:
                update_post(post_id, status="buffer_error", error_message=str(e)[:500])
            except Exception as db_err:
                logger.error("[tiktok] also failed to mark buffer_error: %s", db_err)
            error_count += 1
            # Skip the fan-out for this tweet — we don't want FB/LI to
            # ship a tweet whose TikTok leg blew up. Next-day run will
            # retry the whole tweet.
            continue

        # ─── FACEBOOK + LINKEDIN + INSTAGRAM FAN-OUT ─────────────────────
        # Look up the per-platform storage paths from the Phase-3 result.
        # `id` here is the Apify tweet id we passed into generate_content.
        # Instagram reuses the Facebook 1:1 PNG (no separate IG render).
        tweet_id = str(item.get("id", ""))
        fb_path = extra_paths["facebook"].get(tweet_id)
        li_path = extra_paths["linkedin"].get(tweet_id)
        leg_result = fanout_extra_legs_for_one_tweet(
            tweet_caption=caption,
            fb_storage_path=fb_path,
            li_storage_path=li_path,
            fb_channel_id=fb_channel_id,
            li_channel_id=li_channel_id,
            ig_channel_id=ig_channel_id,
            source_tag=SOURCE_TAG,
        )
        leg_results.append(leg_result)

    # Cron-run status mirrors today's TikTok-only rule: success if any
    # TikTok tweet shipped. FB/LI leg failures surface via error_message
    # and via posts.status='buffer_error' rows — not by failing the run.
    final_status = "success" if sent_count > 0 else "failed"
    error_msg_parts: list[str] = []
    if error_count > 0:
        error_msg_parts.append(f"tiktok items failed: {error_count}")
    leg_summary = summarize_leg_failures(leg_results)
    if leg_summary:
        error_msg_parts.append(leg_summary)
    error_msg = "; ".join(error_msg_parts) or None

    log_cron_finish(
        run_id, status=final_status,
        posts_processed=sent_count, error_message=error_msg,
    )
    logger.info(
        "Phase 4 complete: %d tiktok sent, %d tiktok errors, fan-out summary: %s",
        sent_count, error_count, leg_summary or "all legs OK",
    )


def _render_summary(extra_paths: dict[str, dict[str, str]]) -> str | None:
    """Compact one-line description of the FB/LI render outcome.

    Used as the Phase-3 error_message when one or both extra-platform
    renders came back empty. Helps operators tell "render dropped a leg"
    from "render succeeded but Buffer rejected everything."
    """
    parts: list[str] = []
    if not extra_paths["facebook"]:
        parts.append("no facebook renders")
    if not extra_paths["linkedin"]:
        parts.append("no linkedin renders")
    return ", ".join(parts) or None


if __name__ == "__main__":
    main()

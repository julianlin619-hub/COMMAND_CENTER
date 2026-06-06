"""Batch video processor — the on-demand worker for the manual-upload pathway.

This is NOT a scheduled cron. It's spawned per uploaded mp4 by the dashboard
(`python -m core.video_batch --job-id <uuid>`, see
dashboard/src/app/api/tiktok/manual-upload/batch/route.ts), exactly the way
api/cron/run spawns the existing pipelines. It runs on the dashboard web
service, which already has ffmpeg and python_deps available.

For one job it:
  1. Claims the job row (pending → processing) so a retry/double-click can't
     double-process.
  2. Extracts audio (ffmpeg) → transcribes (Deepgram) → generates a title
     (Claude, reusing core.youtube_title_generator) → picks a caption (RAG
     over the tweet bank).
  3. Fans the video out to Buffer for TikTok + YouTube Shorts + X, writing
     `posts` rows in the SAME shape as the single-file manual upload
     (metadata.source='manual_upload') so buffer_reconcile and
     tiktok_storage_cleanup handle them with no changes.
  4. Marks the job done (or failed) and prints a one-line JSON result to
     stdout for the dashboard to relay back to the browser.

Logging goes to stderr (logging's default), so stdout carries only the JSON
result — the dashboard parses the last stdout line.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys

from core.buffer import get_channel_id, send_to_buffer
from core.caption_rag import pick_caption
from core.database import (
    claim_video_batch_job,
    get_video_batch_job,
    insert_post,
    sanitize_error_message,
    update_post,
    update_video_batch_job,
)
from core.media import build_proxy_url
from core.models import Post
from core.transcription import extract_audio, transcribe
from core.youtube_title_generator import generate_title

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Defaults applied to every YouTube Shorts upload — mirrors YOUTUBE_DEFAULTS in
# dashboard/src/app/api/tiktok/manual-upload/route.ts. `title` is supplied per
# video from the generated title. Buffer rejects a YouTube post with no
# category, so the full block goes on every call.
YOUTUBE_DEFAULTS = {
    "categoryId": "27",  # Education
    "privacy": "public",
    "madeForKids": False,
    "notifySubscribers": True,
    "embeddable": True,
    "license": "youtube",
}

# Per-platform caption limits, matching route.ts. TikTok uses send_to_buffer's
# 150 default; YouTube descriptions allow 5000; X allows 280.
_YOUTUBE_CAPTION_LIMIT = 5000
_X_CAPTION_LIMIT = 280

# Buffer reports the X (Twitter) channel under service='twitter'; this name
# disambiguates the live acq_official channel from any stale legacy one.
_X_CHANNEL_NAME = "acq_official"


def _insert_leg(platform: str, title: str, caption: str, storage_path: str) -> str:
    """Insert a sent_to_buffer posts row for one platform leg. Returns post id.

    Uses the identical metadata shape as the single-file manual upload so the
    storage-cleanup cron (which groups by storage path and scans
    metadata.source='manual_upload') reclaims the mp4 once every leg publishes.
    """
    post = Post(
        platform=platform,  # type: ignore[arg-type]  # validated by Post enum
        status="sent_to_buffer",
        title=title,
        caption=caption,
        media_type="video",
        media_urls=[storage_path],
        metadata={
            "source": "manual_upload",
            "storage_cleanup_status": "pending",
        },
    )
    return insert_post(post)


def _stamp_buffer_id(post_id: str, buffer_post_id: str) -> None:
    """Record the Buffer post id on a leg's row, matching route.ts's shape."""
    update_post(
        post_id,
        platform_post_id=buffer_post_id,
        metadata={
            "source": "manual_upload",
            "buffer_post_id": buffer_post_id,
            "storage_cleanup_status": "pending",
        },
    )


def fanout_video(storage_path: str, title: str, caption: str) -> dict:
    """Fan one video out to Buffer for TikTok + YouTube Shorts + X.

    Replicates dashboard/src/app/api/tiktok/manual-upload/route.ts leg-for-leg.
    TikTok is the primary leg — if it fails, raises so the job is marked failed.
    YouTube and X are best-effort (partial success): a failure there is
    recorded in the returned dict but doesn't fail the whole job, because the
    TikTok post is already queued on Buffer and can't be un-queued.

    Insert-before-send order per leg so the /api/media/<id> proxy URL resolves
    when Buffer validates the media synchronously.
    """
    result: dict = {}

    # ── TikTok (primary) ──────────────────────────────────────────────────
    tiktok_post_id = _insert_leg("tiktok", title, caption, storage_path)
    tiktok_channel_id = get_channel_id(service="tiktok")
    tiktok_buffer_id = send_to_buffer(
        tiktok_channel_id, caption, build_proxy_url(tiktok_post_id), "video",
    )
    _stamp_buffer_id(tiktok_post_id, tiktok_buffer_id)
    result["tiktok_buffer_id"] = tiktok_buffer_id
    logger.info("TikTok queued on Buffer: %s", tiktok_buffer_id)

    # ── YouTube Shorts (best-effort) ──────────────────────────────────────
    yt_post_id = _insert_leg("youtube", title, caption, storage_path)
    try:
        yt_channel_id = get_channel_id(service="youtube")
        yt_buffer_id = send_to_buffer(
            yt_channel_id, caption, build_proxy_url(yt_post_id), "video",
            youtube={"title": title, **YOUTUBE_DEFAULTS},
            caption_limit=_YOUTUBE_CAPTION_LIMIT,
        )
        _stamp_buffer_id(yt_post_id, yt_buffer_id)
        result["youtube_buffer_id"] = yt_buffer_id
        logger.info("YouTube queued on Buffer: %s", yt_buffer_id)
    except Exception as e:
        result["youtube_error"] = sanitize_error_message(str(e))
        logger.error("YouTube leg failed: %s", result["youtube_error"])
        # Drop the row we inserted — Buffer never queued it, and leaving it
        # would make storage cleanup wait forever for a sentAt that never comes.
        _delete_post(yt_post_id)

    # ── X / acq_official (best-effort) ────────────────────────────────────
    x_post_id = _insert_leg("x_acq_official", title, caption, storage_path)
    try:
        x_channel_id = get_channel_id(service="twitter", name=_X_CHANNEL_NAME)
        x_buffer_id = send_to_buffer(
            x_channel_id, caption, build_proxy_url(x_post_id), "video",
            caption_limit=_X_CAPTION_LIMIT,
        )
        _stamp_buffer_id(x_post_id, x_buffer_id)
        result["x_buffer_id"] = x_buffer_id
        logger.info("X queued on Buffer: %s", x_buffer_id)
    except Exception as e:
        result["x_error"] = sanitize_error_message(str(e))
        logger.error("X leg failed: %s", result["x_error"])
        _delete_post(x_post_id)

    return result


def _delete_post(post_id: str) -> None:
    """Best-effort delete of a leg row whose Buffer send failed."""
    from core.database import get_client

    try:
        get_client().table("posts").delete().eq("id", post_id).execute()
    except Exception as e:
        logger.error("Failed to roll back orphan post %s: %s", post_id, e)


def process_job(job_id: str) -> dict:
    """Process one job end-to-end. Returns the result dict printed to stdout."""
    if not claim_video_batch_job(job_id):
        # Already claimed/processed by another spawn — nothing to do. Not an
        # error; report the current state so the caller can reflect it.
        logger.info("Job %s already claimed — skipping", job_id)
        existing = get_video_batch_job(job_id)
        return {"job_id": job_id, "status": (existing or {}).get("status", "unknown"),
                "skipped": True}

    job = get_video_batch_job(job_id)
    if not job:
        raise RuntimeError(f"Job {job_id} not found after claim")

    storage_path = job["storage_path"]
    mp3_path: str | None = None
    try:
        mp3_path = extract_audio(storage_path)
        transcript = transcribe(mp3_path)
        title = generate_title(transcript)
        caption = pick_caption(transcript)

        fanout = fanout_video(storage_path, title, caption)

        update_video_batch_job(
            job_id,
            status="done",
            title=title,
            caption=caption,
            transcript=transcript,
        )
        logger.info("Job %s done: title=%r", job_id, title)
        return {"job_id": job_id, "status": "done", "title": title,
                "caption": caption, **fanout}
    finally:
        # Always clean up the temp mp3, success or failure.
        if mp3_path and os.path.exists(mp3_path):
            try:
                os.remove(mp3_path)
            except OSError as e:
                logger.warning("Could not remove temp audio %s: %s", mp3_path, e)


def main() -> None:
    parser = argparse.ArgumentParser(description="Process one video batch job.")
    parser.add_argument("--job-id", required=True, help="video_batch_jobs row id")
    args = parser.parse_args()

    try:
        result = process_job(args.job_id)
    except Exception as e:
        safe = sanitize_error_message(str(e))
        logger.error("Job %s failed: %s", args.job_id, safe, exc_info=True)
        # Best-effort: record the failure on the row so the UI shows it.
        try:
            update_video_batch_job(args.job_id, status="failed", error_message=safe)
        except Exception as db_err:
            logger.error("Also failed to mark job failed: %s", db_err)
        # stdout carries the machine-readable result; stderr has the traceback.
        print(json.dumps({"job_id": args.job_id, "status": "failed", "error": safe}))
        sys.exit(1)

    print(json.dumps(result))


if __name__ == "__main__":
    main()

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
    record_buffer_handoff,
    sanitize_error_message,
    update_video_batch_job,
)
from core.log_safe import install_log_sanitizer
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


def _leg_metadata(job_id: str) -> dict:
    """Base metadata stamped on every leg row.

    Identical to the single-file manual upload's shape (so the storage-cleanup
    cron, which scans metadata.source='manual_upload', reclaims the mp4 once
    every leg publishes) PLUS `video_batch_job_id`. The job id is what makes the
    fan-out idempotent on a re-run: _already_posted() looks a leg up by
    (job_id, platform), so a process that crashed mid-fanout and is re-run won't
    re-queue a leg it already sent (see fanout_video / finding #2).
    """
    return {
        "source": "manual_upload",
        "storage_cleanup_status": "pending",
        "video_batch_job_id": job_id,
    }


def _insert_leg(
    job_id: str, platform: str, title: str, caption: str, storage_path: str
) -> str:
    """Insert a sent_to_buffer posts row for one platform leg. Returns post id."""
    post = Post(
        platform=platform,  # type: ignore[arg-type]  # validated by Post enum
        status="sent_to_buffer",
        title=title,
        caption=caption,
        media_type="video",
        media_urls=[storage_path],
        metadata=_leg_metadata(job_id),
    )
    return insert_post(post)


def _already_posted(job_id: str, platform: str) -> str | None:
    """Return the Buffer id of a leg already sent for (job_id, platform), or None.

    The per-leg idempotency guard for finding #2: the job row is only flipped to
    'done' after ALL three legs finish, so if the process dies after — say —
    TikTok is queued but before the done write, a re-run would otherwise fan out
    from the top and double-post TikTok. We instead check, per leg, whether a
    posts row for this job already carries a Buffer id, and skip the send if so.

    Matches on metadata->>video_batch_job_id (set by _leg_metadata) and a
    non-null platform_post_id (only stamped AFTER Buffer accepts the post).
    """
    from core.database import get_client

    res = (
        get_client()
        .table("posts")
        .select("platform_post_id")
        .eq("platform", platform)
        .filter("metadata->>video_batch_job_id", "eq", job_id)
        .not_.is_("platform_post_id", "null")
        .limit(1)
        .execute()
    )
    rows = res.data or []
    return rows[0]["platform_post_id"] if rows else None


def _send_leg(
    job_id: str,
    platform: str,
    channel_id: str,
    caption: str,
    storage_path: str,
    *,
    title: str,
    youtube: dict | None = None,
    caption_limit: int | None = None,
) -> str:
    """Send one leg to Buffer idempotently. Returns the Buffer post id.

    Order per leg: idempotency check → insert row → send → record handoff.
      * If this leg was already posted for this job (a crash-and-rerun), skip
        the send and return the existing Buffer id (finding #2).
      * Insert-before-send so the /api/media/<id> proxy URL resolves when Buffer
        validates the media synchronously.
      * On send failure, roll back the row we just inserted and re-raise — the
        caller decides whether that's fatal (TikTok) or best-effort (YT/X).
        This rollback now applies to EVERY leg, including TikTok (finding #10).
      * On success, record the handoff via record_buffer_handoff so the row
        carries a buffer_replay block and buffer_reconcile can re-send it if
        Buffer later fails to publish (finding #5).
    """
    existing = _already_posted(job_id, platform)
    if existing:
        logger.info(
            "Leg %s already posted for job %s (Buffer %s) — skipping re-send",
            platform, job_id, existing,
        )
        return existing

    post_id = _insert_leg(job_id, platform, title, caption, storage_path)
    try:
        buffer_id = send_to_buffer(
            channel_id, caption, build_proxy_url(post_id), "video",
            youtube=youtube, caption_limit=caption_limit,
        )
    except Exception:
        # Buffer never queued it — drop the orphan row so storage cleanup isn't
        # left waiting forever for a sentAt that never comes.
        _delete_post(post_id)
        raise

    record_buffer_handoff(
        post_id, buffer_id,
        channel_id=channel_id,
        body=caption,
        media_type="video",
        youtube=youtube,
        caption_limit=caption_limit,
        base_metadata=_leg_metadata(job_id),
    )
    logger.info("%s queued on Buffer: %s", platform, buffer_id)
    return buffer_id


def fanout_video(job_id: str, storage_path: str, title: str, caption: str) -> dict:
    """Fan one video out to Buffer for TikTok + YouTube Shorts + X.

    Replicates dashboard/src/app/api/tiktok/manual-upload/route.ts leg-for-leg.
    TikTok is the primary leg — if it fails, raises so the job is marked failed.
    YouTube and X are best-effort (partial success): a failure there is
    recorded in the returned dict (as `<platform>_error`) but doesn't fail the
    whole job, because the TikTok post is already queued on Buffer and can't be
    un-queued. process_job uses the presence of any `*_error` key to mark the
    job 'done_partial' rather than 'done' (finding #11).

    Each leg goes through _send_leg, which is idempotent per (job_id, platform)
    so a crashed-and-rerun process can't double-post (finding #2).
    """
    result: dict = {}

    # ── TikTok (primary) ──────────────────────────────────────────────────
    # No try/except: a TikTok failure must propagate so the job is marked
    # failed. _send_leg already rolled back its row before re-raising.
    result["tiktok_buffer_id"] = _send_leg(
        job_id, "tiktok", get_channel_id(service="tiktok"),
        caption, storage_path, title=title,
    )

    # ── YouTube Shorts (best-effort) ──────────────────────────────────────
    try:
        result["youtube_buffer_id"] = _send_leg(
            job_id, "youtube", get_channel_id(service="youtube"),
            caption, storage_path, title=title,
            youtube={"title": title, **YOUTUBE_DEFAULTS},
            caption_limit=_YOUTUBE_CAPTION_LIMIT,
        )
    except Exception as e:
        result["youtube_error"] = sanitize_error_message(str(e))
        logger.error("YouTube leg failed: %s", result["youtube_error"])

    # ── X / acq_official (best-effort) ────────────────────────────────────
    try:
        result["x_buffer_id"] = _send_leg(
            job_id, "x_acq_official",
            get_channel_id(service="twitter", name=_X_CHANNEL_NAME),
            caption, storage_path, title=title,
            caption_limit=_X_CAPTION_LIMIT,
        )
    except Exception as e:
        result["x_error"] = sanitize_error_message(str(e))
        logger.error("X leg failed: %s", result["x_error"])

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

        fanout = fanout_video(job_id, storage_path, title, caption)

        # A best-effort leg (YouTube/X) failing is recorded as a `<plat>_error`
        # key. TikTok (the primary leg) is already queued at this point, so the
        # job succeeded — but partially. Surface that distinctly (finding #11)
        # so the UI/API can flag "scheduled, but a platform didn't queue."
        partial = any(key.endswith("_error") for key in fanout)
        status = "done_partial" if partial else "done"

        # Wrap the terminal status write (finding #2): the fan-out has already
        # happened — TikTok is queued and the posts rows are written. A transient
        # DB blip on THIS write must NOT bubble up to main()'s except, which
        # would flip a successfully-fanned-out job to 'failed' AND (worse) leave
        # it re-runnable. Mirror scheduler.process_due_posts's nested-try: log
        # the double-fault and still return success. The row stays 'processing';
        # the per-leg idempotency guard means even a re-run can't double-post.
        try:
            update_video_batch_job(
                job_id,
                status=status,
                title=title,
                caption=caption,
                transcript=transcript,
            )
        except Exception as db_err:
            logger.error(
                "Job %s fanned out OK (status=%s) but the status write failed: "
                "%s — leaving row 'processing', NOT marking failed",
                job_id, status, db_err,
            )

        logger.info("Job %s %s: title=%r", job_id, status, title)
        return {"job_id": job_id, "status": status, "title": title,
                "caption": caption, **fanout}
    finally:
        # Always clean up the temp mp3, success or failure.
        if mp3_path and os.path.exists(mp3_path):
            try:
                os.remove(mp3_path)
            except OSError as e:
                logger.warning("Could not remove temp audio %s: %s", mp3_path, e)


def main() -> None:
    # Install the log redaction filter BEFORE anything can log (finding #3).
    # Every cron entrypoint does this; the batch processor skipped it. It
    # matters here especially because the failure path below logs the traceback
    # (exc_info=True), and ffmpeg/Deepgram/Supabase exceptions routinely carry
    # the signed Storage URL or an Authorization header in their text — without
    # the filter those land in Render's durable logs verbatim. Idempotent and
    # must run after logging.basicConfig (done at import), which it is.
    install_log_sanitizer()

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

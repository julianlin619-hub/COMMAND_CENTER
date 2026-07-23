"""Instagram Repost Pipeline — manually-triggered, never a scheduled cron.

Reads a JSON payload from stdin: {"permalinks": ["https://www.instagram.com/reel/..."]}
For each permalink it:
  1. Scrapes the post via Apify (apify/instagram-scraper) to get the video URL.
  2. Downloads the video and uploads it to Supabase Storage.
  3. Transcribes the video audio via Deepgram.
  4. Picks a caption from the tweet bank via RAG (embedding similarity + Claude rerank).
  5. Queues the video on Buffer as an Instagram Reel (alexhighlights2026 channel).
  6. Records the post in the posts table.

Run via: python3 -m core.instagram_repost_pipeline
(invoked from dashboard/src/app/api/instagram-reposts/run/route.ts)

Logging goes to stderr; the final JSON summary goes to stdout.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
import tempfile

import httpx

from core.buffer import get_channel_id, send_to_buffer
from core.caption_rag import pick_caption
from core.content_sources import fetch_apify_instagram_post
from core.database import (
    insert_post,
    log_cron_finish,
    log_cron_start,
    record_buffer_handoff,
    sanitize_error_message,
    get_client,
)
from core.log_safe import install_log_sanitizer
from core.media import get_signed_url, upload_to_storage
from core.models import Post
from core.transcription import extract_audio, transcribe

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Instagram caption ceiling — Buffer rejects longer captions.
_INSTAGRAM_CAPTION_LIMIT = 2200

# Buffer channel name for the second Instagram account.
_BUFFER_IG_NAME = os.environ.get("BUFFER_INSTAGRAM_2ND_NAME", "alexhighlights2026")

# 30-day signed URL — Buffer downloads lazily from its queue; a post can sit
# there 1-2 weeks, so a 7-day expiry leaves backed-up posts with a dead URL.
_SIGNED_URL_EXPIRY_SECONDS = 2592000

# Max video size to download (500 MB). Instagram Reels can be large.
_MAX_VIDEO_BYTES = 500 * 1024 * 1024


def _url_hash(url: str) -> str:
    """Stable 12-char hex hash of a URL for use as a storage filename suffix."""
    return hashlib.sha256(url.encode()).hexdigest()[:12]


def _delete_post(post_id: str) -> None:
    """Best-effort delete of an orphan post row when Buffer send fails.

    If we insert the post row but Buffer rejects the send, we clean up the
    orphan so it doesn't show up in the dashboard as a stuck sent_to_buffer row.
    """
    try:
        get_client().table("posts").delete().eq("id", post_id).execute()
    except Exception as e:
        logger.warning(
            "Failed to clean up orphan post %s: %s",
            post_id,
            sanitize_error_message(str(e)),
        )


def process_permalink(url: str, channel_id: str) -> dict:
    """Scrape, transcribe, caption-pick, and queue one Instagram post to Buffer.

    Returns a result dict with keys: success (bool), buffer_id (str|None),
    error (str|None). Never raises — all exceptions are caught and surfaced
    in the return dict so a single failed post doesn't abort the batch.
    """
    try:
        # 1. Apify scrape — get the video URL for this post.
        logger.info("Scraping %s via Apify", url)
        item = fetch_apify_instagram_post(url)
        if item is None:
            return {
                "success": False,
                "error": "Apify returned no result (non-video or private post)",
            }

        video_url = item.get("video_url")
        if not video_url:
            return {"success": False, "error": "No video URL in scraped data"}

        # 2. Download video to a temp file, then upload to Supabase Storage.
        storage_path = f"instagram_reposts/{_url_hash(url)}.mp4"
        logger.info("Downloading video from Apify result")

        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
            tmp_path = tmp.name

        try:
            timeout = httpx.Timeout(120.0, connect=15.0)
            with httpx.stream(
                "GET", video_url, follow_redirects=True, timeout=timeout
            ) as resp:
                resp.raise_for_status()
                bytes_written = 0
                with open(tmp_path, "wb") as f:
                    for chunk in resp.iter_bytes(chunk_size=65536):
                        bytes_written += len(chunk)
                        if bytes_written > _MAX_VIDEO_BYTES:
                            raise ValueError(
                                f"Video too large (>{_MAX_VIDEO_BYTES // 1024 // 1024} MB)"
                            )
                        f.write(chunk)
            logger.info("Downloaded %d bytes to %s", bytes_written, tmp_path)
            upload_to_storage(tmp_path, storage_path)
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

        # 3. Transcribe — extract_audio downloads from Supabase Storage, runs
        # ffmpeg to get a mono 16kHz mp3, then returns the mp3 path.
        logger.info("Transcribing %s", storage_path)
        mp3_path = extract_audio(storage_path)
        try:
            transcript = transcribe(mp3_path)
        finally:
            if os.path.exists(mp3_path):
                os.remove(mp3_path)

        if not transcript.strip():
            return {
                "success": False,
                "error": "Empty transcript — cannot pick a caption",
            }

        # 4. Pick caption via RAG — embeds transcript, finds nearest tweet-bank
        # entries by cosine similarity, then Claude reranks for meaning match.
        caption = pick_caption(transcript)
        logger.info("Picked caption (%d chars): %s…", len(caption), caption[:80])

        # 5. Get 30-day signed URL; insert post row; send to Buffer.
        signed_url = get_signed_url(storage_path, expires_in=_SIGNED_URL_EXPIRY_SECONDS)

        post = Post(
            platform="instagram_2nd",
            status="sent_to_buffer",
            caption=caption,
            media_type="video",
            media_urls=[storage_path],
        )
        post_id = insert_post(post)

        try:
            buffer_id = send_to_buffer(
                channel_id,
                caption,
                signed_url,
                "video",
                instagram_post_type="reel",
                caption_limit=_INSTAGRAM_CAPTION_LIMIT,
            )
        except Exception:
            # Buffer never queued it — drop the orphan row so the dashboard
            # doesn't show a stuck sent_to_buffer entry.
            _delete_post(post_id)
            raise

        # 6. Record the Buffer handoff so buffer_reconcile can re-send if Buffer
        # later fails to publish, and so the row carries the replay payload.
        record_buffer_handoff(
            post_id,
            buffer_id,
            channel_id=channel_id,
            body=caption,
            media_type="video",
            instagram_post_type="reel",
            caption_limit=_INSTAGRAM_CAPTION_LIMIT,
            base_metadata={"source": "repost", "original_url": url},
        )

        logger.info("Queued on Buffer as %s (post row %s)", buffer_id, post_id)
        return {"success": True, "buffer_id": buffer_id}

    except Exception as e:
        error = sanitize_error_message(str(e))
        logger.error("Failed to process %s: %s", url, error)
        return {"success": False, "error": error}


def main() -> None:
    install_log_sanitizer()

    # argparse with no positional args — all input arrives via stdin.
    argparse.ArgumentParser(
        description="Scrape, caption, and repost Instagram videos to Buffer."
    ).parse_args()

    payload = json.loads(sys.stdin.read())
    permalinks: list[str] = payload.get("permalinks", [])

    if not permalinks:
        print(json.dumps({"processed": 0, "scheduled": 0, "failed": 0}))
        return

    run_id = log_cron_start(platform="instagram_2nd", job_type="repost")

    # Resolve the Buffer channel once — cached inside get_channel_id for the run.
    channel_id = get_channel_id(service="instagram", name=_BUFFER_IG_NAME)

    processed = 0
    scheduled = 0
    failed = 0

    for url in permalinks:
        result = process_permalink(url, channel_id)
        processed += 1
        if result["success"]:
            scheduled += 1
        else:
            failed += 1

    status = "success" if scheduled > 0 else "failed"
    error_msg = f"All {failed} posts failed" if scheduled == 0 else None

    log_cron_finish(
        run_id,
        status,
        posts_processed=scheduled,
        error_message=error_msg,
    )

    print(json.dumps({"processed": processed, "scheduled": scheduled, "failed": failed}))


if __name__ == "__main__":
    main()

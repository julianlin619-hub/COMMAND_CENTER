"""Media file handling: download, upload to Supabase Storage.

This module sits between Supabase Storage and the platform adapters.
The typical flow is:
  1. Dashboard uploads a file to Supabase Storage (via the Next.js API).
  2. When a cron job publishes the post, it calls download_file() to pull
     the media from Supabase Storage to a temporary local file.
  3. The platform adapter then uploads that file to the social media API.

We could pass the Supabase URL directly to platform APIs, but most
platforms require you to upload media through their own endpoints —
they don't accept arbitrary URLs. So we need this download-then-reupload step.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from urllib.parse import unquote

import httpx
from supabase import Client

from core.database import get_client

logger = logging.getLogger(__name__)

# All media files live in this single Supabase Storage bucket
STORAGE_BUCKET = "media"

# Only allow known media file extensions — reject anything else to prevent
# uploading executables, scripts, or other dangerous file types.
ALLOWED_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp",  # images
    ".mp4", ".mov", ".avi", ".mkv", ".webm",           # videos
    ".mp3", ".wav", ".aac", ".m4a",                     # audio
}

# Max file size in bytes (100 MB). Prevents disk exhaustion if someone
# points us at a huge file. Individual platforms may have lower limits.
MAX_FILE_SIZE = 100 * 1024 * 1024


def _sanitize_filename(url: str) -> str:
    """Extract and sanitize a filename from a URL.

    Defends against path traversal attacks by:
    1. URL-decoding the path (catches %2e%2e%2f encoding tricks)
    2. Extracting only the final path component (no directory parts)
    3. Rejecting filenames that contain traversal sequences (../)
    4. Rejecting filenames with non-media extensions
    """
    # Strip query params, then URL-decode to catch encoded traversal sequences
    raw = unquote(url.split("?")[0].split("/")[-1])

    # Reject anything with traversal sequences after decoding
    if ".." in raw or "/" in raw or "\\" in raw:
        raise ValueError(f"Unsafe filename rejected: {raw!r}")

    # Only keep alphanumeric, hyphens, underscores, and dots
    sanitized = re.sub(r"[^\w.\-]", "_", raw)
    if not sanitized or sanitized.startswith("."):
        raise ValueError(f"Invalid filename after sanitization: {raw!r}")

    # Check file extension against whitelist
    ext = os.path.splitext(sanitized)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError(
            f"File type {ext!r} not allowed. Allowed: {sorted(ALLOWED_EXTENSIONS)}"
        )

    return sanitized


def download_file(url: str, dest_dir: str = "/tmp") -> str:
    """Download a file from a URL to a local path. Returns the local path."""
    filename = _sanitize_filename(url)
    dest = os.path.join(dest_dir, filename)

    # Verify the resolved path stays within dest_dir (prevents traversal
    # even if sanitization has a gap — defense in depth)
    real_dest = os.path.realpath(dest)
    real_dir = os.path.realpath(dest_dir)
    if not real_dest.startswith(real_dir + os.sep) and real_dest != real_dir:
        raise ValueError(f"Path escapes dest_dir: {real_dest}")

    # Use streaming download so we never load the entire file into memory.
    # This matters for large videos (hundreds of MB) — without streaming,
    # we'd need enough RAM to hold the whole file at once.
    # Timeout breakdown: 10s to establish the connection, then up to 60s of
    # silence on reads before we bail. Without this, a hung upstream
    # (Supabase Storage or a platform CDN) would block the whole cron run
    # until Render's 5-minute overall timeout kills the process.
    timeout = httpx.Timeout(60.0, connect=10.0)
    with httpx.stream("GET", url, follow_redirects=True, timeout=timeout) as response:
        response.raise_for_status()

        # Pre-check Content-Length if the server provides it
        content_length = response.headers.get("content-length")
        if content_length and int(content_length) > MAX_FILE_SIZE:
            raise ValueError(
                f"File too large: {int(content_length)} bytes "
                f"(max {MAX_FILE_SIZE} bytes)"
            )

        # Stream to disk with a running byte count as a safety net
        bytes_written = 0
        with open(dest, "wb") as f:
            for chunk in response.iter_bytes(chunk_size=8192):
                bytes_written += len(chunk)
                if bytes_written > MAX_FILE_SIZE:
                    f.close()
                    os.remove(dest)
                    raise ValueError(
                        f"File exceeded max size during download "
                        f"({bytes_written} bytes, max {MAX_FILE_SIZE})"
                    )
                f.write(chunk)

    logger.info("Downloaded %s -> %s (%d bytes)", url, dest, bytes_written)
    return dest


def upload_to_storage(local_path: str, storage_path: str) -> str:
    """Upload a local file to Supabase Storage. Returns the storage path."""
    client = get_client()
    with open(local_path, "rb") as f:
        client.storage.from_(STORAGE_BUCKET).upload(storage_path, f)
    logger.info("Uploaded %s -> %s/%s", local_path, STORAGE_BUCKET, storage_path)
    return storage_path


def get_signed_url(storage_path: str, expires_in: int = 3600) -> str:
    """Get a signed URL for a file in Supabase Storage.

    Signed URLs are temporary, pre-authenticated download links. They let
    the cron job (or a platform API) fetch a file without needing Supabase
    credentials. The URL expires after `expires_in` seconds (default: 1 hour)
    so files aren't permanently exposed.
    """
    client = get_client()
    result = client.storage.from_(STORAGE_BUCKET).create_signed_url(storage_path, expires_in)
    return result["signedURL"]

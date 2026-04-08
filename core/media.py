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
from pathlib import Path

import httpx
from supabase import Client

from core.database import get_client

logger = logging.getLogger(__name__)

# All media files live in this single Supabase Storage bucket
STORAGE_BUCKET = "media"


def download_file(url: str, dest_dir: str = "/tmp") -> str:
    """Download a file from a URL to a local path. Returns the local path."""
    # Extract the filename from the URL, stripping any query params.
    # e.g. "https://xyz.supabase.co/.../photo.jpg?token=abc" -> "photo.jpg"
    filename = url.split("/")[-1].split("?")[0]
    dest = os.path.join(dest_dir, filename)
    # Use streaming download so we never load the entire file into memory.
    # This matters for large videos (hundreds of MB) — without streaming,
    # we'd need enough RAM to hold the whole file at once.
    with httpx.stream("GET", url, follow_redirects=True) as response:
        response.raise_for_status()
        with open(dest, "wb") as f:
            # Write in 8KB chunks — a good balance between memory and I/O overhead
            for chunk in response.iter_bytes(chunk_size=8192):
                f.write(chunk)
    logger.info("Downloaded %s -> %s", url, dest)
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

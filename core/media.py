"""Media file handling: download, upload to Supabase Storage."""

from __future__ import annotations

import logging
import os
from pathlib import Path

import httpx
from supabase import Client

from core.database import get_client

logger = logging.getLogger(__name__)

STORAGE_BUCKET = "media"


def download_file(url: str, dest_dir: str = "/tmp") -> str:
    """Download a file from a URL to a local path. Returns the local path."""
    filename = url.split("/")[-1].split("?")[0]
    dest = os.path.join(dest_dir, filename)
    with httpx.stream("GET", url, follow_redirects=True) as response:
        response.raise_for_status()
        with open(dest, "wb") as f:
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
    """Get a signed URL for a file in Supabase Storage."""
    client = get_client()
    result = client.storage.from_(STORAGE_BUCKET).create_signed_url(storage_path, expires_in)
    return result["signedURL"]

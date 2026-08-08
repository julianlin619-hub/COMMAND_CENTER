"""Google Drive upload helpers for the Ad Carousels export.

Why this module exists:
    The ads carousel pipeline (core/ads_carousel_pipeline.py) renders tweet
    slides as PNGs and hands them to the user as a Google Drive folder —
    it never posts to a social platform. This module is the thin Drive v3
    client that creates the per-run folder and uploads the slides.

Why raw httpx instead of the google-api-python-client SDK:
    Same reasoning as platforms/youtube.py — we only need three endpoints
    (token refresh, files.create for a folder, files.create with media
    upload), and the official SDK drags in a large dependency tree plus a
    credential-object model that doesn't fit our env-var token storage.

Authentication:
    Long-lived OAuth refresh token in env vars (GDRIVE_CLIENT_ID,
    GDRIVE_CLIENT_SECRET, GDRIVE_REFRESH_TOKEN), exchanged for a ~1h
    access token per run via core.auth.refresh_oauth_token. Mint the
    refresh token with scripts/generate_gdrive_refresh_token.py.

IMPORTANT — drive.file scope:
    The token is scoped to `drive.file`, which can only see files/folders
    THIS app created. A folder made by hand in the Drive UI is invisible
    to the token (creating a child inside it 404s). That's why the token
    script also creates the parent "Ad Carousels" folder and prints its
    ID for the ADS_DRIVE_FOLDER_ID env var.

API docs: https://developers.google.com/drive/api/reference/rest/v3
"""

from __future__ import annotations

import json
import logging
import uuid

import httpx

from core.auth import refresh_oauth_token
from core.exceptions import (
    NonRetryablePlatformError,
    PlatformAPIError,
    PlatformAuthError,
    PlatformRateLimitError,
)
from core.retry import with_retry

logger = logging.getLogger(__name__)

_TOKEN_URL = "https://oauth2.googleapis.com/token"
_API_BASE = "https://www.googleapis.com/drive/v3"
_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3"
# Uploads are ~1-2 MB PNGs; 60s leaves headroom for a slow link without
# letting a hung request eat the dashboard route's overall budget.
_REQUEST_TIMEOUT = 60.0


def get_access_token() -> str:
    """Exchange the long-lived refresh token for a short-lived access token."""
    return refresh_oauth_token(
        token_url=_TOKEN_URL,
        client_id_env="GDRIVE_CLIENT_ID",
        client_secret_env="GDRIVE_CLIENT_SECRET",
        refresh_token_env="GDRIVE_REFRESH_TOKEN",
    )


def build_multipart_related(
    metadata: dict, media: bytes, content_type: str
) -> tuple[bytes, str]:
    """Build a multipart/related body for a Drive media upload.

    Drive's `uploadType=multipart` requires RFC 2387 multipart/related —
    part 1 is the file metadata as JSON, part 2 is the raw media bytes.
    httpx's `files=` parameter produces multipart/form-data (each part
    gets a Content-Disposition header), which Drive rejects, so we build
    the body by hand.

    Returns (body_bytes, boundary) — the caller puts the boundary in the
    Content-Type header: `multipart/related; boundary=<boundary>`.

    Kept as a pure function (no I/O) so tests can validate the wire
    format without a network.
    """
    boundary = uuid.uuid4().hex
    delimiter = f"--{boundary}\r\n".encode()
    body = (
        delimiter
        + b"Content-Type: application/json; charset=UTF-8\r\n\r\n"
        + json.dumps(metadata).encode()
        + b"\r\n"
        + delimiter
        + f"Content-Type: {content_type}\r\n\r\n".encode()
        + media
        + f"\r\n--{boundary}--\r\n".encode()
    )
    return body, boundary


@with_retry()
def create_folder(name: str, parent_id: str | None, access_token: str) -> dict:
    """Create a Drive folder; returns {"id": ..., "webViewLink": ...}.

    parent_id=None creates the folder at My Drive root (only the one-off
    token script does that — pipeline runs always nest under
    ADS_DRIVE_FOLDER_ID).
    """
    metadata: dict = {
        "name": name,
        # This magic mimeType is how Drive distinguishes "create a folder"
        # from "create an empty file" on the same files.create endpoint.
        "mimeType": "application/vnd.google-apps.folder",
    }
    if parent_id:
        metadata["parents"] = [parent_id]

    response = httpx.post(
        f"{_API_BASE}/files",
        params={"fields": "id,webViewLink"},
        headers={"Authorization": f"Bearer {access_token}"},
        json=metadata,
        timeout=_REQUEST_TIMEOUT,
    )
    _raise_for_drive_error(response)
    data = response.json()
    return {"id": data["id"], "webViewLink": data["webViewLink"]}


@with_retry()
def upload_png(
    filename: str, data: bytes, parent_id: str, access_token: str
) -> str:
    """Upload a PNG into a Drive folder; returns the new file's ID."""
    body, boundary = build_multipart_related(
        {"name": filename, "parents": [parent_id]}, data, "image/png"
    )
    response = httpx.post(
        f"{_UPLOAD_BASE}/files",
        params={"uploadType": "multipart", "fields": "id"},
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": f"multipart/related; boundary={boundary}",
        },
        content=body,
        timeout=_REQUEST_TIMEOUT,
    )
    _raise_for_drive_error(response)
    return response.json()["id"]


@with_retry()
def copy_file(file_id: str, name: str, parent_id: str, access_token: str) -> str:
    """Server-side copy of a Drive file into a folder; returns the copy's ID.

    Used by the permutation generator: each unique slide PNG is uploaded
    ONCE, then copied into every carousel folder that uses it. A copy is
    one small metadata call (~100ms) vs re-uploading ~1MB of PNG bytes —
    for a 100-carousel batch that's the difference between minutes and
    an hour.
    """
    response = httpx.post(
        f"{_API_BASE}/files/{file_id}/copy",
        params={"fields": "id"},
        headers={"Authorization": f"Bearer {access_token}"},
        json={"name": name, "parents": [parent_id]},
        timeout=_REQUEST_TIMEOUT,
    )
    _raise_for_drive_error(response)
    return response.json()["id"]


def _raise_for_drive_error(response: httpx.Response) -> None:
    """Map a Drive API error response onto our exception hierarchy.

    The mapping decides how @with_retry reacts (see core/retry.py):
      - 401 / non-rate 403 → PlatformAuthError (bad/expired/mis-scoped
        token; a 404 on a folder you can see in the Drive UI usually
        means the drive.file scope can't see it — recreate it via the
        token script). Retried, but will fail all attempts.
      - 403 with a rate-limit reason / 429 → retried with backoff.
      - 5xx → PlatformAPIError → retried.
      - other 4xx → NonRetryablePlatformError → fails fast.
    """
    if response.is_success:
        return
    status = response.status_code
    try:
        body = response.json()
    except Exception:  # pragma: no cover — only hit on non-JSON errors
        body = {"raw": response.text}
    logger.error("Drive API %s error: %s", status, body)

    # Drive signals per-user rate limiting as a 403 with one of these
    # reasons — retryable, unlike a scope/permission 403.
    reason = ""
    try:
        errors = body.get("error", {}).get("errors", [])
        if errors:
            reason = errors[0].get("reason", "")
    except AttributeError:
        pass

    if status == 401:
        raise PlatformAuthError(f"Drive API 401: {body}")
    if status == 403:
        if reason in {"userRateLimitExceeded", "rateLimitExceeded"}:
            raise PlatformRateLimitError(f"Drive rate limited ({reason}): {body}")
        raise PlatformAuthError(f"Drive API 403 ({reason}): {body}")
    if status == 429:
        retry_after = None
        header = response.headers.get("retry-after")
        if header and header.isdigit():
            retry_after = float(header)
        raise PlatformRateLimitError(
            f"Drive API 429: {body}", retry_after=retry_after
        )
    if 500 <= status < 600:
        raise PlatformAPIError(f"Drive API {status}: {body}", status_code=status)
    raise NonRetryablePlatformError(
        f"Drive API {status}: {body}", status_code=status
    )

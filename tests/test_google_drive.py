"""Tests for core.google_drive.

Focus on the two pieces that are easy to get subtly wrong and painful to
debug against the live API:
  * build_multipart_related — Drive rejects multipart/form-data (what
    httpx's `files=` produces), so the hand-built multipart/related body
    must match RFC 2387 exactly.
  * _raise_for_drive_error — the status→exception mapping decides what
    @with_retry retries vs fails fast, mirroring platforms/youtube.py's
    _raise_for_youtube_error tests-by-inspection.

No network calls anywhere — responses are constructed httpx.Response
objects.
"""

from __future__ import annotations

import json

import httpx
import pytest

from core.exceptions import (
    NonRetryablePlatformError,
    PlatformAPIError,
    PlatformAuthError,
    PlatformRateLimitError,
)
from core.google_drive import _raise_for_drive_error, build_multipart_related


class TestBuildMultipartRelated:
    _METADATA = {"name": "01.png", "parents": ["folder123"]}
    _MEDIA = b"\x89PNG\r\n\x1a\nfakebytes"

    def test_boundary_wraps_body(self):
        body, boundary = build_multipart_related(
            self._METADATA, self._MEDIA, "image/png"
        )
        # RFC 2387: parts open with --boundary, body closes with --boundary--
        assert body.startswith(f"--{boundary}\r\n".encode())
        assert body.endswith(f"\r\n--{boundary}--\r\n".encode())
        # Exactly two opening delimiters (metadata part + media part).
        assert body.count(f"--{boundary}\r\n".encode()) == 2

    def test_metadata_part_is_json(self):
        body, _ = build_multipart_related(self._METADATA, self._MEDIA, "image/png")
        assert b"Content-Type: application/json; charset=UTF-8" in body
        # The JSON must round-trip — Drive parses it for name/parents.
        json_start = body.index(b"{")
        json_end = body.index(b"}", json_start) + 1
        assert json.loads(body[json_start:json_end]) == self._METADATA

    def test_media_part_carries_raw_bytes(self):
        body, _ = build_multipart_related(self._METADATA, self._MEDIA, "image/png")
        assert b"Content-Type: image/png" in body
        assert self._MEDIA in body

    def test_boundary_not_in_media(self):
        """The boundary is a fresh uuid4 hex per call — two calls must not
        share one (a stale module-level boundary could collide with body
        bytes and truncate the upload)."""
        _, b1 = build_multipart_related(self._METADATA, self._MEDIA, "image/png")
        _, b2 = build_multipart_related(self._METADATA, self._MEDIA, "image/png")
        assert b1 != b2


def _response(status: int, body: dict | None = None, headers: dict | None = None):
    return httpx.Response(
        status_code=status,
        json=body if body is not None else {},
        headers=headers,
        request=httpx.Request("POST", "https://www.googleapis.com/drive/v3/files"),
    )


class TestRaiseForDriveError:
    def test_success_is_silent(self):
        _raise_for_drive_error(_response(200, {"id": "x"}))

    def test_401_is_auth_error(self):
        with pytest.raises(PlatformAuthError):
            _raise_for_drive_error(_response(401))

    def test_403_rate_reason_is_rate_limit(self):
        body = {"error": {"errors": [{"reason": "userRateLimitExceeded"}]}}
        with pytest.raises(PlatformRateLimitError):
            _raise_for_drive_error(_response(403, body))

    def test_403_scope_reason_is_auth_error(self):
        body = {"error": {"errors": [{"reason": "insufficientPermissions"}]}}
        with pytest.raises(PlatformAuthError):
            _raise_for_drive_error(_response(403, body))

    def test_429_honors_retry_after(self):
        with pytest.raises(PlatformRateLimitError) as exc_info:
            _raise_for_drive_error(_response(429, headers={"retry-after": "7"}))
        assert exc_info.value.retry_after == 7.0

    def test_500_is_retryable_api_error(self):
        with pytest.raises(PlatformAPIError) as exc_info:
            _raise_for_drive_error(_response(500))
        # Must NOT be the non-retryable subclass — 5xx should back off + retry.
        assert not isinstance(exc_info.value, NonRetryablePlatformError)

    def test_404_fails_fast(self):
        """404 on folder create usually means drive.file can't see the
        parent (hand-made folder) — deterministic, retrying never fixes it."""
        with pytest.raises(NonRetryablePlatformError):
            _raise_for_drive_error(_response(404))

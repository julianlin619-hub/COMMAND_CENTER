"""Shared client for the dashboard's /api/content-gen/generate endpoint.

Three cron pipelines (tiktok, tiktok_bank, facebook) all hit this endpoint
to drive canvas rendering + ffmpeg conversion on the Next.js dashboard.
Each used to duplicate the POST + raise_for_status logic with zero retry —
one transient 502 from the dashboard (restart, brief OOM, deploy blip)
permanently failed the cron run. This helper centralizes the call and adds
retry with exponential backoff + jitter for transient failures.

Retry policy:
  - 5xx responses and network errors (httpx.RequestError) ARE retried.
  - 4xx responses are NOT retried — those mean a bad payload or auth token,
    which retrying won't fix. Fail fast instead.

Backoff: ~2s, ~4s, ~8s worst-case (full jitter) = ≤14s total waiting,
comfortably inside Render's 15-minute cron window.
"""

from __future__ import annotations

import logging
import random
import time
from collections.abc import Iterable, Mapping
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_MAX_RETRIES = 3
_BASE_DELAY = 2.0
_MAX_DELAY = 30.0
_TIMEOUT_SECONDS = 300


def generate_content(
    dashboard_url: str,
    cron_secret: str,
    tweets: Iterable[Mapping[str, str]],
    platform: str = "tiktok",
) -> dict[str, Any]:
    """POST to /api/content-gen/generate with retry on transient failures.

    Args:
        dashboard_url: Base URL of the dashboard (trailing slash ok).
        cron_secret: Bearer token for the Authorization header.
        tweets: Iterable of {"id", "text"} mappings.
        platform: "tiktok" (1080x1920 MP4) or "facebook" (1080x1080 PNG).

    Returns:
        Parsed JSON: {"generated": [...], "errors": [...]}.

    Raises:
        httpx.HTTPStatusError on non-retriable 4xx, or 5xx after retries exhaust.
        httpx.RequestError on network failure after retries exhaust.
    """
    generate_url = f"{dashboard_url.rstrip('/')}/api/content-gen/generate"
    payload: dict[str, Any] = {
        "platform": platform,
        "tweets": [{"id": t["id"], "text": t["text"]} for t in tweets],
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {cron_secret}",
    }

    for attempt in range(_MAX_RETRIES + 1):
        try:
            resp = httpx.post(
                generate_url, headers=headers, json=payload, timeout=_TIMEOUT_SECONDS,
            )
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as e:
            status = e.response.status_code
            # 4xx = our bug (bad payload, bad auth). No retry will fix it.
            if status < 500 or attempt == _MAX_RETRIES:
                raise
            delay = _jitter_delay(attempt)
            logger.warning(
                "generate attempt %d/%d got %d, retrying in %.1fs",
                attempt + 1, _MAX_RETRIES + 1, status, delay,
            )
            time.sleep(delay)
        except httpx.RequestError as e:
            if attempt == _MAX_RETRIES:
                raise
            delay = _jitter_delay(attempt)
            logger.warning(
                "generate attempt %d/%d failed (%s: %s), retrying in %.1fs",
                attempt + 1, _MAX_RETRIES + 1, type(e).__name__, e, delay,
            )
            time.sleep(delay)

    # Unreachable: the loop either returns on success or raises on the last
    # attempt. Kept as a defensive assertion for type checkers.
    raise RuntimeError("generate_content retry loop exited without returning")


def _jitter_delay(attempt: int) -> float:
    """Full-jitter exponential backoff, capped at _MAX_DELAY."""
    cap = min(_BASE_DELAY * (2**attempt), _MAX_DELAY)
    return random.uniform(0, cap)

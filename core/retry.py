"""Retry decorator with exponential backoff and rate-limit awareness.

Why retry at all?
    Social media APIs are flaky. They return transient errors (500s, timeouts,
    rate limits) that succeed if you just try again after a short wait. Without
    automatic retries, every transient error would mark a post as "failed" and
    require manual intervention.

What is exponential backoff?
    Instead of retrying immediately (which hammers the API and probably fails
    again), we wait progressively longer between attempts:
      attempt 0: wait ~1s
      attempt 1: wait ~2s
      attempt 2: wait ~4s
    This gives the API time to recover.

What is jitter?
    If multiple cron jobs hit a rate limit at the same time and all wait
    exactly 2 seconds, they'll all retry at the same moment and collide again.
    Jitter adds randomness to the delay (e.g. wait 0-2s instead of exactly 2s)
    so retries spread out and don't thundering-herd the API.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import random
from collections.abc import Callable
from typing import TypeVar

from core.exceptions import PlatformRateLimitError

logger = logging.getLogger(__name__)

T = TypeVar("T")

DEFAULT_MAX_RETRIES = 3
DEFAULT_BASE_DELAY = 1.0  # seconds
DEFAULT_MAX_DELAY = 60.0  # seconds — cap so we never wait longer than 1 minute


def with_retry(
    max_retries: int = DEFAULT_MAX_RETRIES,
    base_delay: float = DEFAULT_BASE_DELAY,
    max_delay: float = DEFAULT_MAX_DELAY,
) -> Callable:
    """Decorator that retries a function with exponential backoff and jitter.

    If the function raises PlatformRateLimitError with a retry_after value,
    that value is used as the delay instead of the calculated backoff.
    """

    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        # ── Async wrapper ───────────────────────────────────────────
        # Used when the decorated function is a coroutine (async def).
        # We need a separate wrapper because async functions must be
        # awaited, and we use asyncio.sleep() instead of time.sleep().
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs) -> T:
            last_exception = None
            # range(max_retries + 1) gives us the initial attempt + N retries.
            # e.g. max_retries=3 means attempts 0, 1, 2, 3 (4 total tries).
            for attempt in range(max_retries + 1):
                try:
                    return await func(*args, **kwargs)
                except PlatformRateLimitError as e:
                    # Rate limits get special treatment: if the platform told
                    # us how long to wait (retry_after), we honor that instead
                    # of our own backoff calculation.
                    last_exception = e
                    if attempt == max_retries:
                        raise
                    delay = e.retry_after if e.retry_after else _calc_delay(attempt, base_delay, max_delay)
                    logger.warning(
                        "Rate limited on attempt %d/%d, retrying in %.1fs: %s",
                        attempt + 1, max_retries + 1, delay, e,
                    )
                    await asyncio.sleep(delay)
                except Exception as e:
                    # All other errors use standard exponential backoff
                    last_exception = e
                    if attempt == max_retries:
                        raise
                    delay = _calc_delay(attempt, base_delay, max_delay)
                    logger.warning(
                        "Attempt %d/%d failed, retrying in %.1fs: %s",
                        attempt + 1, max_retries + 1, delay, e,
                    )
                    await asyncio.sleep(delay)
            raise last_exception  # type: ignore[misc]

        # ── Sync wrapper ────────────────────────────────────────────
        # Used when the decorated function is a regular (non-async) function.
        # Same logic as above, but uses time.sleep() for blocking waits.
        @functools.wraps(func)
        def sync_wrapper(*args, **kwargs) -> T:
            import time

            last_exception = None
            for attempt in range(max_retries + 1):
                try:
                    return func(*args, **kwargs)
                except PlatformRateLimitError as e:
                    last_exception = e
                    if attempt == max_retries:
                        raise
                    delay = e.retry_after if e.retry_after else _calc_delay(attempt, base_delay, max_delay)
                    logger.warning(
                        "Rate limited on attempt %d/%d, retrying in %.1fs: %s",
                        attempt + 1, max_retries + 1, delay, e,
                    )
                    time.sleep(delay)
                except Exception as e:
                    last_exception = e
                    if attempt == max_retries:
                        raise
                    delay = _calc_delay(attempt, base_delay, max_delay)
                    logger.warning(
                        "Attempt %d/%d failed, retrying in %.1fs: %s",
                        attempt + 1, max_retries + 1, delay, e,
                    )
                    time.sleep(delay)
            raise last_exception  # type: ignore[misc]

        # Automatically pick the right wrapper based on whether the
        # decorated function is async or sync. The caller doesn't need
        # to think about it — @with_retry() works on both.
        if asyncio.iscoroutinefunction(func):
            return async_wrapper  # type: ignore[return-value]
        return sync_wrapper  # type: ignore[return-value]

    return decorator


def _calc_delay(attempt: int, base_delay: float, max_delay: float) -> float:
    """Exponential backoff with full jitter.

    Formula: random(0, min(base_delay * 2^attempt, max_delay))

    Example with base_delay=1, max_delay=60:
      attempt 0: random between 0 and 1s
      attempt 1: random between 0 and 2s
      attempt 2: random between 0 and 4s
      attempt 3: random between 0 and 8s
      ...capped at 60s

    "Full jitter" means we pick a random value between 0 and the max delay
    (as opposed to "equal jitter" which picks between half and the max).
    Full jitter is recommended by AWS and generally performs best at
    spreading out retries.
    """
    delay = min(base_delay * (2**attempt), max_delay)
    return random.uniform(0, delay)

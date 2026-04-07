"""Retry decorator with exponential backoff and rate-limit awareness."""

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
DEFAULT_MAX_DELAY = 60.0  # seconds


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
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs) -> T:
            last_exception = None
            for attempt in range(max_retries + 1):
                try:
                    return await func(*args, **kwargs)
                except PlatformRateLimitError as e:
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

        if asyncio.iscoroutinefunction(func):
            return async_wrapper  # type: ignore[return-value]
        return sync_wrapper  # type: ignore[return-value]

    return decorator


def _calc_delay(attempt: int, base_delay: float, max_delay: float) -> float:
    """Exponential backoff with full jitter."""
    delay = min(base_delay * (2**attempt), max_delay)
    return random.uniform(0, delay)

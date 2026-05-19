"""Snapchat browser-session persistence helpers.

The Snapchat adapter drives a headless Chromium against the Public Profile
Web Uploader. To stay logged in across cron runs we serialise Playwright's
BrowserContext (cookies + localStorage + sessionStorage) to JSON via
`context.storage_state()` and persist that blob in Supabase.

This module is the only place SQL touches `platform_session_state`. The
adapter calls `load_storage_state()` at the start of `create_post()` and
`save_storage_state()` only after a successful publish — so a failed
publish never overwrites a valid session blob with a half-broken one.

Why a separate module?
    Keeps the Playwright code in `snapchat.py` free of Supabase imports,
    and lets the unit tests mock these two functions cleanly without
    monkey-patching the supabase-py client.
"""

from __future__ import annotations

from datetime import datetime, timezone

from core.database import get_client

# We hardcode platform='snapchat' because there's exactly one row per
# platform_enum value and this module is snapchat-specific. If/when a second
# headless-Chromium publisher lands (e.g. a future TikTok web uploader) we'd
# either parameterise here or copy this file with its own constant — both
# fine. Premature generalisation now would just add a parameter no caller
# uses today.
_PLATFORM = "snapchat"


class StorageStateMissing(RuntimeError):
    """Raised when no platform_session_state row exists for snapchat.

    The operator must run `scripts/capture_snapchat_auth.py` to seed the
    row before the publisher can post. Surfaced as a separate exception
    type so the adapter's `create_post` can convert it into a
    PlatformAuthError with the right operator-actionable message.
    """


def load_storage_state() -> dict:
    """Return the latest Playwright storage_state JSON blob for snapchat.

    Raises StorageStateMissing if no row exists. The publisher cron treats
    that as a hard auth failure — see snapchat.py's create_post for how
    the exception is translated to AUTH_EXPIRED.
    """
    client = get_client()
    result = (
        client.table("platform_session_state")
        .select("storage_state")
        .eq("platform", _PLATFORM)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        raise StorageStateMissing(
            "No platform_session_state row for snapchat — run "
            "scripts/capture_snapchat_auth.py to seed the session blob"
        )
    return rows[0]["storage_state"]


def save_storage_state(state: dict) -> None:
    """Upsert the latest storage_state for snapchat with updated_at=now().

    Callers should only invoke this on the success path of a publish, after
    the success indicator confirms the post landed. Persisting cookies
    after a failed publish would risk overwriting a working session with
    one that's already mid-broken (e.g. a captcha redirect that mutated
    cookies but didn't actually post).
    """
    client = get_client()
    row = {
        "platform": _PLATFORM,
        "storage_state": state,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    # Mirrors the upsert pattern in core/database.py::bump_title_fallback_tracker.
    # on_conflict=platform — the table's PRIMARY KEY is platform, so this
    # collapses the first-time-INSERT and refresh-UPDATE paths into one call.
    (
        client.table("platform_session_state")
        .upsert(row, on_conflict="platform")
        .execute()
    )

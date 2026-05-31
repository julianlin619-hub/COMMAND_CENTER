"""Buffer GraphQL API client for multi-platform posting.

Sends generated content (videos for TikTok, images for Facebook, etc.) to
Buffer's posting queue. Buffer handles the actual platform API interaction
(upload, publishing, scheduling).

Supports any platform connected in Buffer — the `service` param selects
which channel to use ('tiktok', 'facebook', etc.).

Required env vars:
  BUFFER_ACCESS_TOKEN  — OAuth bearer token for Buffer's API
  BUFFER_ORG_ID        — Buffer organization ID (to find platform channels)
"""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime

import httpx

logger = logging.getLogger(__name__)

BUFFER_GRAPHQL_URL = "https://api.buffer.com/graphql"

# TikTok has a 150-character caption limit. We truncate with an ellipsis (…)
# to signal the text was cut, matching the TS version's behavior.
TIKTOK_CAPTION_LIMIT = 150

# Cache channel IDs per service for the lifetime of a single cron run.
# Channels don't change between API calls, so one lookup per service per run
# is enough. Keys are service names ('tiktok', 'facebook', etc.).
_cached_channel_ids: dict[str, str] = {}


# Retry budget for transient rate limiting. Bank-sourced bursts (e.g. a bank
# run firing ~24 items × 4 fan-out platforms ≈ 96 createPost calls against
# Buffer's ~100-req/15-min cap) were nuking whole batches: every send got
# rate-limited and the post was marked failed with no retry. We absorb the
# transient case here so callers don't each need their own retry logic.
_MAX_ATTEMPTS = 5  # 1 initial try + up to 4 retries
# Cap a single backoff sleep. A 15-minute rolling-window cooldown can ask us
# to wait minutes, which would blow the Render cron's runtime budget and stall
# every later post in the run. If the wait hint exceeds this, we give up and
# let the post be retried by the next cron run / the reconcile cron instead.
_MAX_BACKOFF_SECONDS = 60.0
# Fallback when no wait hint is given: short enough not to waste the run,
# long enough to clear a typical per-second/per-minute quota.
_DEFAULT_BACKOFF_SECONDS = 5.0


def _parse_wait_seconds(raw: object) -> float:
    """Coerce a Retry-After / retryAfter hint to seconds, with a safe default."""
    try:
        return float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return _DEFAULT_BACKOFF_SECONDS


def _graphql_rate_limited(errors: list[dict]) -> tuple[bool, float]:
    """Detect a rate-limit error in a GraphQL `errors` array.

    Buffer's new public GraphQL API reports rate limiting as a GraphQL error
    with `extensions.code == "RATE_LIMIT_EXCEEDED"` at HTTP 200 — NOT an HTTP
    429 — so the legacy 429-only retry never fired for it. Returns
    (is_rate_limited, wait_seconds); wait falls back to the default when Buffer
    doesn't include a hint in `extensions`.
    """
    for err in errors:
        ext = err.get("extensions") or {}
        code = str(ext.get("code", "")).upper()
        message = str(err.get("message", "")).lower()
        if code == "RATE_LIMIT_EXCEEDED" or "rate limit" in message:
            hint = ext.get("retryAfter", ext.get("retry_after"))
            wait = _parse_wait_seconds(hint) if hint is not None else _DEFAULT_BACKOFF_SECONDS
            return True, wait
    return False, 0.0


def _buffer_request(query: str, variables: dict | None = None) -> dict:
    """Send a GraphQL request to Buffer and return the data payload.

    Raises on HTTP errors, auth errors, or GraphQL-level errors.

    Retries transient rate limiting up to `_MAX_ATTEMPTS` times, honoring the
    server's wait hint but capping a single sleep at `_MAX_BACKOFF_SECONDS`.
    Two rate-limit shapes are handled: a legacy HTTP 429 (honoring the
    `Retry-After` header) and the new API's GraphQL `RATE_LIMIT_EXCEEDED`
    error (HTTP 200, see `_graphql_rate_limited`).
    """
    token = os.environ.get("BUFFER_ACCESS_TOKEN", "")
    if not token:
        raise RuntimeError("BUFFER_ACCESS_TOKEN env var not set")

    for attempt in range(1, _MAX_ATTEMPTS + 1):
        resp = httpx.post(
            BUFFER_GRAPHQL_URL,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
            },
            json={"query": query, "variables": variables or {}},
            # createPost with a video asset is slow: Buffer downloads the file
            # from our signed URL before responding, which can exceed 30s.
            timeout=120,
        )

        # Legacy HTTP 429 rate limit.
        if resp.status_code == 429:
            wait = _parse_wait_seconds(resp.headers.get("Retry-After"))
            if attempt < _MAX_ATTEMPTS and wait <= _MAX_BACKOFF_SECONDS:
                logger.warning(
                    "Buffer 429 on attempt %d/%d — sleeping %.1fs before retry",
                    attempt, _MAX_ATTEMPTS, wait,
                )
                time.sleep(wait)
                continue
            raise RuntimeError(
                f"Buffer rate limited (HTTP 429) after {attempt} attempt(s)"
            )

        if resp.status_code == 401:
            raise RuntimeError("Buffer token is invalid or expired (401)")
        if not resp.is_success:
            raise RuntimeError(
                f"Buffer API error {resp.status_code}: {resp.text or resp.reason_phrase}"
            )

        body = resp.json()

        # GraphQL-level errors (rate limiting, query syntax, missing fields…).
        errors = body.get("errors")
        if errors:
            limited, wait = _graphql_rate_limited(errors)
            if limited and attempt < _MAX_ATTEMPTS and wait <= _MAX_BACKOFF_SECONDS:
                logger.warning(
                    "Buffer RATE_LIMIT_EXCEEDED on attempt %d/%d — sleeping %.1fs before retry",
                    attempt, _MAX_ATTEMPTS, wait,
                )
                time.sleep(wait)
                continue
            messages = ", ".join(e.get("message", "") for e in errors)
            raise RuntimeError(f"Buffer GraphQL error: {messages}")

        return body.get("data", {})

    # Defensive: every branch above returns, continues, or raises, so the loop
    # can't fall through here in practice.
    raise RuntimeError("Buffer request failed after exhausting retries")


def get_channel_id(org_id: str | None = None, service: str = "tiktok") -> str:
    """Look up a platform's channel ID in a Buffer organization.

    Queries Buffer's channels endpoint, finds the one matching the given
    service name, and returns its ID. Results are cached per service so
    repeated calls within the same process don't make extra API requests.

    Args:
        org_id: Buffer organization ID. Defaults to BUFFER_ORG_ID env var.
        service: Buffer service name — 'tiktok', 'facebook', etc.

    Raises:
        RuntimeError: If no matching channel is found in Buffer.
    """
    if service in _cached_channel_ids:
        return _cached_channel_ids[service]

    org = org_id or os.environ.get("BUFFER_ORG_ID", "")
    if not org:
        raise RuntimeError("BUFFER_ORG_ID env var not set")

    # Query all channels for this org and find the one matching `service`.
    # Uses GraphQL variables (not string interpolation) to prevent injection.
    data = _buffer_request(
        """
        query GetChannels($orgId: OrganizationId!) {
            channels(input: { organizationId: $orgId }) {
                id
                service
                name
            }
        }
        """,
        {"orgId": org},
    )

    channels = data.get("channels", [])
    match = next((c for c in channels if c.get("service") == service), None)

    if not match:
        raise RuntimeError(
            f"No {service} channel connected in Buffer. "
            f"Connect {service} at buffer.com first."
        )

    _cached_channel_ids[service] = match["id"]
    logger.info("Found %s channel in Buffer: %s (%s)", service, match["name"], match["id"])
    return match["id"]


def send_to_buffer(
    channel_id: str, caption: str, media_url: str, media_type: str = "video",
    facebook_post_type: str | None = None,
    instagram_post_type: str | None = None,
) -> str:
    """Send content to Buffer's posting queue.

    Creates a Buffer post with schedulingType=automatic (Buffer picks the
    next available time slot) and mode=addToQueue (appends to the queue
    instead of posting immediately).

    Args:
        channel_id: Buffer channel ID (from get_channel_id).
        caption: Post caption text (will be truncated if over 150 chars).
        media_url: Public URL of the media file (Supabase signed URL).
        media_type: 'video' or 'image' — determines Buffer asset format.

    Returns:
        The Buffer post ID on success.

    Raises:
        RuntimeError: If Buffer returns an error (auth, rate limit, etc.)
    """
    # Build the assets payload based on media type.
    # For videos: Buffer downloads from our signed URL and re-uploads to the platform.
    # For images: same flow, but Buffer uses the image upload path.
    # Buffer's assets input is a list of single-field items, one per media file
    # (e.g. `[{"image": {"url": …}}]`). Migrated from the legacy object shape
    # ({"images": [...]}) per Buffer's 2026-05-25 API change.
    if media_type == "image":
        assets = [{"image": {"url": media_url}}]
    else:
        assets = [{"video": {"url": media_url}}]

    data = _buffer_request(
        """
        mutation CreatePost($input: CreatePostInput!) {
            createPost(input: $input) {
                __typename
                ... on PostActionSuccess {
                    post { id }
                }
                # Catch-all: every Buffer error type implements the
                # MutationError interface, so this fragment surfaces the
                # message for ANY error member — including ones not listed
                # explicitly below and any new types Buffer adds later.
                # Without it, an unlisted error type returned neither `post`
                # nor `message` and we raised a useless "Unexpected response".
                ... on MutationError { message }
                ... on NotFoundError { message }
                ... on UnauthorizedError { message }
                ... on UnexpectedError { message }
                ... on RestProxyError { message }
                ... on LimitReachedError { message }
                ... on InvalidInputError { message }
            }
        }
        """,
        {
            "input": {
                "channelId": channel_id,
                "schedulingType": "automatic",
                "mode": "addToQueue",
                "text": truncate_caption(caption),
                "assets": assets,
                # Buffer nests platform-specific fields under metadata.
                # Facebook requires metadata.facebook.type (post/reel/story);
                # Instagram requires metadata.instagram.type (post/reel/story) AND
                # metadata.instagram.shouldShareToFeed (Boolean!) — marked
                # required in Buffer's GraphQL schema for every IG type, even
                # "post". For both "post" and "reel" we want True (the post
                # lands in the feed; the reel cross-posts to the feed). Story
                # support, if ever added, should set False here.
                **(
                    {"metadata": {
                        **({"facebook": {"type": facebook_post_type}} if facebook_post_type else {}),
                        **(
                            {"instagram": {
                                "type": instagram_post_type,
                                "shouldShareToFeed": True,
                            }}
                            if instagram_post_type else {}
                        ),
                    }}
                    if facebook_post_type or instagram_post_type else {}
                ),
            },
        },
    )

    result = data.get("createPost", {})

    # Buffer returns error types as union members with a `message` field.
    # Include __typename so the log/error names which error type fired
    # (e.g. LimitReachedError vs InvalidInputError) instead of a bare string.
    if result.get("message"):
        error_type = result.get("__typename") or "BufferError"
        raise RuntimeError(f"Buffer error ({error_type}): {result['message']}")

    post = result.get("post")
    if not post:
        # No post and no message — surface the typename so we can tell which
        # union member came back unhandled rather than masking it entirely.
        error_type = result.get("__typename") or "unknown type"
        raise RuntimeError(
            f"Unexpected response from Buffer — no post returned ({error_type})"
        )

    logger.info("Sent to Buffer queue: post %s", post["id"])
    return post["id"]


def get_buffer_post_sent_at(post_id: str) -> datetime | None:
    """Return the UTC datetime Buffer published a post, or None if still queued.

    Wraps Buffer's GraphQL `post(input:{id})` lookup and parses `sentAt`.
    Used by cron/tiktok_storage_cleanup.py to decide when it's safe to
    delete a manual-upload mp4 from Supabase Storage (3 days after Buffer
    confirms the post went live).
    """
    # Buffer's `post(input:{id})` returns a plain Post object, not a union,
    # so we select fields directly. `createPost` uses a union (PostActionSuccess
    # | *Error), but reads don't — a mismatch here returns GRAPHQL_VALIDATION_FAILED.
    data = _buffer_request(
        """
        query GetPost($id: PostId!) {
            post(input: { id: $id }) {
                id
                sentAt
                status
            }
        }
        """,
        {"id": post_id},
    )

    post = data.get("post") or {}
    sent = post.get("sentAt")
    if not sent:
        return None
    # Buffer returns ISO-8601 with a `Z` suffix; fromisoformat needs +00:00.
    return datetime.fromisoformat(sent.replace("Z", "+00:00"))


def get_buffer_post_state(post_id: str) -> dict | None:
    """Return Buffer's current view of a post: {'status', 'sentAt'} or None.

    Used by cron/buffer_reconcile.py to verify posts we handed to Buffer's
    queue actually published. Unlike `get_buffer_post_sent_at` (which only
    cares about the publish timestamp), this also returns the raw `status`
    string so the reconcile cron can distinguish "still queued" from a
    Buffer-side failure.

    Returns None only if Buffer has no record of the post (deleted/unknown id).
    `sentAt` is a parsed UTC datetime when set, else None.
    """
    # Same read query as get_buffer_post_sent_at — Buffer's post(input:{id})
    # returns a plain Post object (not the createPost union), so we select
    # fields directly.
    data = _buffer_request(
        """
        query GetPost($id: PostId!) {
            post(input: { id: $id }) {
                id
                sentAt
                status
            }
        }
        """,
        {"id": post_id},
    )

    post = data.get("post")
    if not post:
        return None

    sent_raw = post.get("sentAt")
    sent_at = (
        datetime.fromisoformat(sent_raw.replace("Z", "+00:00"))
        if sent_raw
        else None
    )
    return {"status": post.get("status"), "sentAt": sent_at}


def truncate_caption(text: str, limit: int = TIKTOK_CAPTION_LIMIT) -> str:
    """Truncate caption to TikTok's character limit with ellipsis.

    TikTok's caption limit is 150 characters. If the text exceeds this,
    we cut it and append a Unicode ellipsis (…) so the user sees it was
    truncated rather than abruptly cut off mid-word.

    Short-circuits when the text already fits (no gratuitous ellipsis),
    and trims additional trailing whitespace after slicing so we don't
    end up with "word …" style ugly breaks.
    """
    if limit <= 0 or len(text) <= limit:
        return text
    ellipsis = "\u2026"
    # Slice so there's room for the ellipsis, trim any trailing whitespace
    # that ended up at the cut boundary, then append. Resulting length is
    # at most `limit` characters (the ellipsis counts as one).
    truncated = text[: limit - 1].rstrip()
    return truncated + ellipsis

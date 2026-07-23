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


class BufferRateLimitError(RuntimeError):
    """Buffer rejected a request because we exceeded its rate limit.

    A distinct type (not a bare RuntimeError) so batch callers — the reconcile
    cron especially — can tell "Buffer is throttling us" apart from "this one
    post is broken." Buffer's limit is a rolling ~100-request/15-minute window:
    once it trips, every remaining request in the run will also be rejected
    until the window resets, so the right reaction is to stop the batch and let
    the next scheduled run retry — not to keep hammering.
    """

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
            raise BufferRateLimitError(
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
            if limited:
                # Exhausted retries (or the wait hint exceeded our cap) on a
                # GraphQL-level rate limit — same "Buffer is throttling us"
                # signal as the HTTP 429 above, so raise the same type.
                raise BufferRateLimitError(f"Buffer rate limited: {messages}")
            raise RuntimeError(f"Buffer GraphQL error: {messages}")

        return body.get("data", {})

    # Defensive: every branch above returns, continues, or raises, so the loop
    # can't fall through here in practice.
    raise RuntimeError("Buffer request failed after exhausting retries")


def get_channel_id(
    org_id: str | None = None, service: str = "tiktok", name: str | None = None
) -> str:
    """Look up a platform's channel ID in a Buffer organization.

    Queries Buffer's channels endpoint, finds the one matching the given
    service name, and returns its ID. Results are cached per service so
    repeated calls within the same process don't make extra API requests.

    Args:
        org_id: Buffer organization ID. Defaults to BUFFER_ORG_ID env var.
        service: Buffer service name — 'tiktok', 'facebook', etc.
        name: Optional channel name (case-insensitive) to disambiguate when an
            org has multiple channels for the same service. Buffer reports the
            X (Twitter) channel under service='twitter', and an org can carry a
            stale/legacy twitter channel alongside the live one — pass
            name='acq_official' to pin the right one. Mirrors getChannelId's
            `name` arg in dashboard/src/lib/buffer.ts.

    Raises:
        RuntimeError: If no matching channel is found in Buffer.
    """
    # Cache key includes the name so a service-only lookup and a name-scoped
    # lookup for the same service don't clobber each other.
    cache_key = f"{service}:{name.lower()}" if name else service
    if cache_key in _cached_channel_ids:
        return _cached_channel_ids[cache_key]

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

    want_name = name.lower() if name else None
    channels = data.get("channels", [])
    match = next(
        (
            c
            for c in channels
            if c.get("service") == service
            and (want_name is None or str(c.get("name", "")).lower() == want_name)
        ),
        None,
    )

    if not match:
        suffix = f' named "{name}"' if name else ""
        raise RuntimeError(
            f"No {service} channel{suffix} connected in Buffer. "
            f"Connect {service} at buffer.com first."
        )

    _cached_channel_ids[cache_key] = match["id"]
    logger.info("Found %s channel in Buffer: %s (%s)", service, match["name"], match["id"])
    return match["id"]


def send_to_buffer(
    channel_id: str, caption: str, media_url: str | list[str],
    media_type: str = "video",
    facebook_post_type: str | None = None,
    instagram_post_type: str | None = None,
    youtube: dict | None = None,
    caption_limit: int | None = None,
) -> str:
    """Send content to Buffer's posting queue.

    Creates a Buffer post with schedulingType=automatic (Buffer picks the
    next available time slot) and mode=addToQueue (appends to the queue
    instead of posting immediately).

    Args:
        channel_id: Buffer channel ID (from get_channel_id).
        caption: Post caption text (truncated to caption_limit, default 150).
        media_url: Public URL of the media file (Supabase signed URL), or a
            list of URLs for a multi-image post. Multiple image URLs on an
            Instagram channel become ONE carousel post — Buffer's assets
            input is already a list, one entry per media file. All existing
            single-media callers keep passing a plain string.
        media_type: 'video' or 'image' — determines Buffer asset format.
            Applies to every URL in a list (a carousel is all images).
        youtube: Optional YouTube publisher metadata block (title, categoryId,
            privacy, madeForKids, notifySubscribers, embeddable, license, and
            optional tags). Required for the YouTube channel — Buffer rejects a
            YouTube post that's missing a category. Mirrors the YouTubeMetadata
            type in dashboard/src/lib/buffer.ts.
        caption_limit: Override the 150-char TikTok truncation. YouTube callers
            pass 5000 (descriptions) and X callers pass 280 so captions aren't
            amputated unnecessarily.

    Returns:
        The Buffer post ID on success.

    Raises:
        ValueError: If media_url is an empty list.
        RuntimeError: If Buffer returns an error (auth, rate limit, etc.)
    """
    # Build the assets payload based on media type.
    # For videos: Buffer downloads from our signed URL and re-uploads to the platform.
    # For images: same flow, but Buffer uses the image upload path.
    # Buffer's assets input is a list of single-field items, one per media file
    # (e.g. `[{"image": {"url": …}}]`). Migrated from the legacy object shape
    # ({"images": [...]}) per Buffer's 2026-05-25 API change. The carousel
    # pipeline passes a list of URLs, which maps 1:1 onto that list shape.
    urls = [media_url] if isinstance(media_url, str) else list(media_url)
    if not urls:
        raise ValueError("send_to_buffer requires at least one media URL")
    asset_key = "image" if media_type == "image" else "video"
    assets = [{asset_key: {"url": u}} for u in urls]

    # Buffer nests platform-specific fields under metadata, not on the
    # top-level input. Build it up only with the keys that apply so we never
    # send an empty/partial block Buffer might reject.
    metadata: dict = {}
    if facebook_post_type:
        metadata["facebook"] = {"type": facebook_post_type}
    if instagram_post_type:
        # 1080x1920 vertical videos belong in the Reels tab; shouldShareToFeed
        # also pushes them into the main feed (marked required in Buffer's
        # schema for every IG type). Mirrors dashboard/src/lib/buffer.ts.
        metadata["instagram"] = {
            "type": instagram_post_type,
            "shouldShareToFeed": True,
        }
    if youtube:
        # Drop an empty `tags` key — some publishers reject `tags: []`.
        yt = dict(youtube)
        if not yt.get("tags"):
            yt.pop("tags", None)
        metadata["youtube"] = yt

    post_input: dict = {
        "channelId": channel_id,
        "schedulingType": "automatic",
        "mode": "addToQueue",
        "text": truncate_caption(caption, caption_limit or TIKTOK_CAPTION_LIMIT),
        "assets": assets,
    }
    if metadata:
        post_input["metadata"] = metadata

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
        {"input": post_input},
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
    try:
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
    except RuntimeError as exc:
        # Same "not found" guard as get_buffer_post_state: if Buffer has
        # deleted the post, treat it as unpublished (None) so the cleanup
        # cron skips the group rather than crashing and potentially
        # mis-deleting files that belong to other still-queued posts.
        if "not found" in str(exc).lower():
            return None
        raise

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
    try:
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
    except RuntimeError as exc:
        # Buffer returns a GraphQL error when the post id is unknown (e.g. the
        # user manually deleted the post from Buffer's queue, or Buffer pruned
        # it after a publish failure). Honour the docstring's "Returns None"
        # contract so the reconcile cron can mark the row terminal instead of
        # looping on it forever.
        if "not found" in str(exc).lower():
            return None
        raise

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

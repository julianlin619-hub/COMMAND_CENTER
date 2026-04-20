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


def _buffer_request(query: str, variables: dict | None = None) -> dict:
    """Send a GraphQL request to Buffer and return the data payload.

    Raises on HTTP errors, auth errors, or GraphQL-level errors.
    """
    token = os.environ.get("BUFFER_ACCESS_TOKEN", "")
    if not token:
        raise RuntimeError("BUFFER_ACCESS_TOKEN env var not set")

    resp = httpx.post(
        BUFFER_GRAPHQL_URL,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        json={"query": query, "variables": variables or {}},
        timeout=30,
    )

    if resp.status_code == 401:
        raise RuntimeError("Buffer token is invalid or expired (401)")
    if not resp.is_success:
        raise RuntimeError(
            f"Buffer API error {resp.status_code}: {resp.text or resp.reason_phrase}"
        )

    body = resp.json()

    # GraphQL-level errors (query syntax, missing fields, etc.)
    if body.get("errors"):
        messages = ", ".join(e.get("message", "") for e in body["errors"])
        raise RuntimeError(f"Buffer GraphQL error: {messages}")

    return body.get("data", {})


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
    # Buffer's AssetsInput accepts: images, videos, documents, link
    if media_type == "image":
        assets = {"images": [{"url": media_url}]}
    else:
        assets = {"videos": [{"url": media_url}]}

    data = _buffer_request(
        """
        mutation CreatePost($input: CreatePostInput!) {
            createPost(input: $input) {
                ... on PostActionSuccess {
                    post { id }
                }
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
                # Instagram requires metadata.instagram.type (post/reel/story).
                **(
                    {"metadata": {
                        **({"facebook": {"type": facebook_post_type}} if facebook_post_type else {}),
                        **({"instagram": {"type": instagram_post_type}} if instagram_post_type else {}),
                    }}
                    if facebook_post_type or instagram_post_type else {}
                ),
            },
        },
    )

    result = data.get("createPost", {})

    # Buffer returns error types as union members with a `message` field
    if result.get("message"):
        raise RuntimeError(f"Buffer error: {result['message']}")

    post = result.get("post")
    if not post:
        raise RuntimeError("Unexpected response from Buffer — no post returned")

    logger.info("Sent to Buffer queue: post %s", post["id"])
    return post["id"]


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

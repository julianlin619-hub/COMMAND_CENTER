"""Buffer GraphQL API client for TikTok video posting.

Sends generated TikTok videos to Buffer's posting queue. Buffer handles
the actual TikTok API interaction (upload, publishing, scheduling).

Ported from TWEEL_REEL's lib/buffer.ts and adapted for Python:
  - Uses httpx instead of fetch
  - Reads BUFFER_ACCESS_TOKEN (not BUFFER_API — same key, we standardized on the longer name)
  - Reads BUFFER_ORG_ID instead of hardcoding the organization ID
  - TikTok channel ID is discovered via GraphQL query, not hardcoded

Required env vars:
  BUFFER_ACCESS_TOKEN  — OAuth bearer token for Buffer's API
  BUFFER_ORG_ID        — Buffer organization ID (to find the TikTok channel)
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

# Cache the TikTok channel ID for the lifetime of a single cron run.
# The channel doesn't change between API calls, so one lookup per run is enough.
_cached_tiktok_channel_id: str | None = None


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
    resp.raise_for_status()

    body = resp.json()

    # GraphQL-level errors (query syntax, missing fields, etc.)
    if body.get("errors"):
        messages = ", ".join(e.get("message", "") for e in body["errors"])
        raise RuntimeError(f"Buffer GraphQL error: {messages}")

    return body.get("data", {})


def get_tiktok_channel_id(org_id: str | None = None) -> str:
    """Look up the TikTok channel ID for a Buffer organization.

    Queries Buffer's channels endpoint, finds the one with service='tiktok',
    and returns its ID. The result is cached so repeated calls within the
    same process (cron run) don't make extra API requests.

    Args:
        org_id: Buffer organization ID. Defaults to BUFFER_ORG_ID env var.

    Raises:
        RuntimeError: If no TikTok channel is found in Buffer.
    """
    global _cached_tiktok_channel_id
    if _cached_tiktok_channel_id:
        return _cached_tiktok_channel_id

    org = org_id or os.environ.get("BUFFER_ORG_ID", "")
    if not org:
        raise RuntimeError("BUFFER_ORG_ID env var not set")

    # Query all channels for this org and find the TikTok one
    data = _buffer_request(f"""
        query GetChannels {{
            channels(input: {{ organizationId: "{org}" }}) {{
                id
                service
                name
            }}
        }}
    """)

    channels = data.get("channels", [])
    tiktok = next((c for c in channels if c.get("service") == "tiktok"), None)

    if not tiktok:
        raise RuntimeError(
            "No TikTok channel connected in Buffer. "
            "Connect TikTok at buffer.com first."
        )

    _cached_tiktok_channel_id = tiktok["id"]
    logger.info("Found TikTok channel in Buffer: %s (%s)", tiktok["name"], tiktok["id"])
    return tiktok["id"]


def send_to_buffer(channel_id: str, caption: str, video_url: str) -> str:
    """Send a video to Buffer's TikTok posting queue.

    Creates a Buffer post with schedulingType=automatic (Buffer picks the
    next available time slot) and mode=addToQueue (appends to the queue
    instead of posting immediately).

    Args:
        channel_id: Buffer TikTok channel ID (from get_tiktok_channel_id).
        caption: TikTok caption text (will be truncated if over 150 chars).
        video_url: Public URL of the video file (Supabase signed URL).

    Returns:
        The Buffer post ID on success.

    Raises:
        RuntimeError: If Buffer returns an error (auth, rate limit, etc.)
    """
    # The GraphQL mutation matches TWEEL_REEL's lib/buffer.ts createPost.
    # videos[{url}] tells Buffer to download the video from our signed URL.
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
                "assets": {
                    "videos": [{"url": video_url}],
                },
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
    """
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "\u2026"

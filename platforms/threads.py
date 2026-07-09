"""Threads platform adapter — posts to Threads via Buffer's GraphQL API.

Ported from: github.com/julianlin619-hub/THREADS
-----------------------------------------------------------------
This adapter wraps Buffer's API rather than the Threads API directly.
The original automation used Buffer to queue posts to a connected Threads
channel, and this adapter preserves that working approach.

How it works:
  - create_post sends text to Buffer's GraphQL API, which queues it for
    publishing on the connected Threads channel.
  - Buffer handles the actual Threads API interaction (container creation,
    publishing, scheduling).
Required env vars:
  BUFFER_ACCESS_TOKEN         — OAuth token for Buffer's API
  BUFFER_THREADS_CHANNEL_ID   — The Buffer channel ID for your Threads profile
"""

import logging
import os
import time

import httpx

from core.exceptions import PlatformAPIError, PlatformAuthError, PlatformRateLimitError
from core.models import MediaUploadResult, Post
from platforms.base import PlatformBase

logger = logging.getLogger(__name__)

BUFFER_GRAPHQL_URL = "https://api.buffer.com/graphql"

# GraphQL mutation ported from lib/buffer.ts in the original THREADS repo.
# schedulingType: automatic lets Buffer pick the next optimal time slot.
# mode: addToQueue appends to the queue instead of posting immediately.
#
# The whole input is passed as ONE `$input: CreatePostInput!` variable rather
# than inlining per-field variables (`channelId: $channelId`) into the query
# literal. The inline shape (declaring `$channelId: ChannelId!`) started failing
# with "Argument input has invalid value {…}" after Buffer's 2026-05-25 API
# change tightened the inner field typing — the inline `ChannelId!` usage was no
# longer type-compatible at query-validation time. Wrapping the input in a single
# variable defers field checks to value coercion (which still passes), matching
# the shape core/buffer.py::send_to_buffer already uses.
CREATE_POST_MUTATION = """
  mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      __typename
      ... on PostActionSuccess {
        post {
          id
          status
        }
      }
      # Catch-all: every Buffer error type implements MutationError, so this
      # fragment surfaces the message for ANY error member — including new
      # types — instead of returning neither `post` nor `message`.
      ... on MutationError { message }
      ... on InvalidInputError { message }
      ... on UnexpectedError { message }
      ... on LimitReachedError { message }
    }
  }
"""


class Threads(PlatformBase):
    name = "threads"

    # create_post hands the post to Buffer's queue (Buffer publishes to Threads
    # asynchronously), so the scheduler should mark it 'sent_to_buffer' and let
    # cron.buffer_reconcile confirm the actual publish — see PlatformBase.
    publishes_via_buffer = True

    def __init__(self, channel_id: str | None = None) -> None:
        # Buffer credentials (for posting). channel_id can be passed
        # explicitly so the same adapter can target different Buffer
        # channels (e.g., a second creator's Threads account); when
        # omitted, fall back to the canonical BUFFER_THREADS_CHANNEL_ID.
        self.buffer_token = os.environ.get("BUFFER_ACCESS_TOKEN", "")
        self.channel_id = channel_id or os.environ.get("BUFFER_THREADS_CHANNEL_ID", "")

    def validate_config(self) -> None:
        """Check that required Buffer env vars are present."""
        self._check_env_vars("BUFFER_ACCESS_TOKEN", "BUFFER_THREADS_CHANNEL_ID")

    # ── Authentication ──────────────────────────────────────────

    def refresh_credentials(self) -> None:
        """No-op — Buffer tokens are long-lived and don't need periodic refresh."""
        return

    def validate_credentials(self) -> bool:
        """Verify the Buffer token can reach the API."""
        if not self.buffer_token or not self.channel_id:
            return False
        try:
            resp = httpx.post(
                BUFFER_GRAPHQL_URL,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.buffer_token}",
                },
                json={"query": "{ account { id } }"},
                timeout=10,
            )
            if resp.status_code == 401:
                raise PlatformAuthError("Buffer token is invalid or expired")
            return resp.status_code == 200
        except httpx.HTTPError:
            return False

    # ── Posting ─────────────────────────────────────────────────

    def create_post(self, post: Post) -> str:
        """Queue a post to Threads via Buffer's GraphQL API.

        Builds the text from post.caption (+ hashtags if present), sends it
        to Buffer which handles the actual Threads publishing. Returns the
        Buffer post ID.
        """
        # Build text content from the Post model
        text = post.caption or post.title or ""
        if post.hashtags:
            tag_str = " ".join(f"#{tag}" for tag in post.hashtags)
            text = f"{text}\n\n{tag_str}"

        if not text.strip():
            raise PlatformAPIError("Post has no text content", status_code=400)

        # Send to Buffer — mirrors the postToBuffer() function from the
        # original lib/buffer.ts.
        #
        # On HTTP 429 we honor Retry-After and retry up to 2 times before
        # giving up. Mirrors the retry block in core/buffer.py:_buffer_request
        # — kept inline (not refactored to share) to avoid bigger churn while
        # absorbing the bank-burst 429 storm that was failing every post in
        # a batch with no recovery.
        max_attempts = 3  # 1 initial try + up to 2 retries on 429
        resp: httpx.Response | None = None
        for attempt in range(1, max_attempts + 1):
            resp = httpx.post(
                BUFFER_GRAPHQL_URL,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.buffer_token}",
                },
                json={
                    "query": CREATE_POST_MUTATION,
                    # Pass the input as a single CreatePostInput variable (not
                    # inlined per-field into the query) — see CREATE_POST_MUTATION.
                    # Threads is text-only, so no `assets` key.
                    "variables": {
                        "input": {
                            "channelId": self.channel_id,
                            "text": text,
                            "schedulingType": "automatic",
                            "mode": "addToQueue",
                        }
                    },
                },
                timeout=30,
            )
            if resp.status_code != 429 or attempt == max_attempts:
                break
            try:
                retry_after = float(resp.headers.get("Retry-After", "5"))
            except (TypeError, ValueError):
                retry_after = 5.0
            logger.warning(
                "Buffer 429 on attempt %d/%d — sleeping %.1fs before retry",
                attempt, max_attempts, retry_after,
            )
            time.sleep(retry_after)

        assert resp is not None  # loop runs at least once
        if resp.status_code == 429:
            # Exhausted retries — surface to scheduler as PlatformRateLimitError
            # so this stays distinguishable from generic API failures in logs.
            try:
                retry_after = float(resp.headers.get("Retry-After", "60"))
            except (TypeError, ValueError):
                retry_after = 60.0
            raise PlatformRateLimitError(
                "Buffer rate limit exceeded", retry_after=retry_after
            )

        if resp.status_code == 401:
            raise PlatformAuthError("Buffer token expired or invalid")

        if resp.status_code != 200:
            raise PlatformAPIError(
                f"Buffer API error {resp.status_code}: {resp.text}",
                status_code=resp.status_code,
            )

        data = resp.json()

        # Check for GraphQL-level errors
        if data.get("errors"):
            messages = ", ".join(e.get("message", "") for e in data["errors"])
            raise PlatformAPIError(f"Buffer GraphQL error: {messages}")

        result = data.get("data", {}).get("createPost", {})

        # Buffer returns error types as union members with a `message` field
        # (InvalidInputError, UnexpectedError, LimitReachedError)
        if result.get("message"):
            raise PlatformAPIError(f"Buffer error: {result['message']}")

        buffer_post = result.get("post", {})
        post_id = buffer_post.get("id", "unknown")
        logger.info("Queued post to Buffer: %s (status: %s)",
                     post_id, buffer_post.get("status", "?"))
        return post_id

    def buffer_replay(self, post: Post) -> dict:
        """Replay payload for cron.buffer_reconcile to re-send a failed post.

        Threads posts are text-only and rebuilt deterministically from the row
        by create_post, so reconcile only needs to know which Buffer channel to
        target (this adapter can front several Threads channels via channel_id).
        """
        return {"channel_id": self.channel_id}

    # ── Media ───────────────────────────────────────────────────

    def upload_media(self, local_path: str, media_type: str) -> MediaUploadResult:
        """No-op — the original automation is text-only via Buffer.

        Buffer can accept media via URL in the mutation, but the existing
        THREADS repo only posts text. When media support is needed, extend
        CREATE_POST_MUTATION to include a mediaUrl variable pointing to a
        Supabase Storage signed URL.
        """
        return MediaUploadResult(
            platform_media_id=None,
            metadata={"note": "text-only via Buffer — media not yet supported"},
        )

    def get_media_constraints(self) -> dict:
        """Return Threads' content limits."""
        return {
            "max_image_size_mb": 8,
            "max_video_duration_sec": 300,  # 5 minutes
            "max_video_size_mb": 1000,      # ~1 GB
            "max_caption_length": 500,
            "supported_image_formats": ["jpg", "png"],
            "supported_video_formats": ["mp4", "mov"],
            "max_carousel_items": 20,
            "supports_text_only": True,
        }


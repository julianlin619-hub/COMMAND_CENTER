"""Threads platform implementation. Placeholder — will be filled from existing repo.

STUB FILE — This adapter will wrap the Threads API (part of Meta's ecosystem,
like Instagram).
-----------------------------------------------------------------
Key things to know about Threads' API:
  - Auth uses the same Meta/Instagram OAuth 2.0 flow.  In fact, Threads
    API access is granted through the same Instagram app configuration
    in the Meta Developer portal.  Long-lived tokens last ~60 days.
  - Posting follows the same two-step container pattern as Instagram:
      1. Create a media container (POST /{threads-user-id}/threads)
      2. Publish the container (POST /{threads-user-id}/threads_publish)
    If you already understand the Instagram adapter, this one will feel
    very familiar — Meta intentionally made them similar.
  - Threads supports text posts, images, videos, and carousels.
    Text-only posts are unique to Threads (Instagram requires media).
  - Metrics come from the Threads Insights API (views, likes, replies,
    reposts, quotes).

API docs: https://developers.facebook.com/docs/threads
"""

from platforms.base import PlatformBase
from core.models import EngagementSnapshot, MediaUploadResult, Post


class Threads(PlatformBase):
    name = "threads"

    def refresh_credentials(self) -> None:
        # Will use the same Meta long-lived token refresh flow as Instagram.
        # GET /oauth/access_token?grant_type=th_exchange_token to extend
        # the token.  Tokens last ~60 days, similar to Instagram.
        raise NotImplementedError("TODO: port from existing repo")

    def validate_credentials(self) -> bool:
        # Will call GET /me?fields=id,username to verify the Threads
        # token is still valid.
        raise NotImplementedError("TODO: port from existing repo")

    def create_post(self, post: Post) -> str:
        # Two-step container flow (same pattern as Instagram):
        # 1. POST /{threads-user-id}/threads — create a container with
        #    media_type (TEXT, IMAGE, VIDEO, CAROUSEL), text, image_url
        #    or video_url.
        # 2. POST /{threads-user-id}/threads_publish — publish it.
        # Unlike Instagram, Threads supports TEXT-only posts (no media
        # required).  Returns the Threads post ID.
        raise NotImplementedError("TODO: port from existing repo")

    def upload_media(self, local_path: str, media_type: str) -> MediaUploadResult:
        # Like Instagram, Threads expects a publicly accessible URL to the
        # media rather than a direct file upload.  This method will upload
        # the file to Supabase Storage and return the public URL in the
        # MediaUploadResult for create_post to reference.
        # For text-only posts, this step is skipped entirely.
        raise NotImplementedError("TODO: port from existing repo")

    def get_media_constraints(self) -> dict:
        # Will return Threads' limits: images up to 8 MB (JPG, PNG),
        # videos up to 5 min and 1 GB, text up to 500 chars, max 20
        # images in a carousel, etc.
        raise NotImplementedError("TODO: port from existing repo")

    def get_post_metrics(self, platform_post_id: str) -> EngagementSnapshot:
        # Will call GET /{threads-media-id}/insights with metric names:
        # views, likes, replies, reposts, quotes.  Maps these into an
        # EngagementSnapshot.  Note that Threads metrics are more limited
        # than Instagram's — no "saves" or "reach" yet.
        raise NotImplementedError("TODO: port from existing repo")

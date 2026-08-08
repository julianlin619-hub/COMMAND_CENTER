"""TikTok platform adapter — UNUSED.

The TikTok publishing that still exists goes through Buffer (see
core/buffer.py; live legs: manual-upload fan-out in core/video_batch.py
and the carousel mirror in cron/instagram_carousel_pipeline.py — the
tweet-reel leg was retired Aug 2026). This stub is kept as reference for
a future direct TikTok API integration if we ever need to bypass Buffer.
-----------------------------------------------------------------
Key things to know about TikTok's API:
  - Auth uses OAuth 2.0.  You get an authorization code, exchange it for
    an access token + refresh token.  Access tokens expire in ~24 hours;
    refresh tokens last much longer.
  - Video posting is a multi-step process:
      1. Call /v2/post/publish/inbox/video/init/ to get an upload URL.
      2. Upload the video file to that URL (chunked upload for large files).
      3. TikTok processes the video asynchronously — you poll a status
         endpoint until it's done.
  - TikTok is video-first.  Photo posts (carousels) are a newer feature
    with a separate endpoint.
  - Metrics come from the /v2/video/query/ endpoint (views, likes, comments,
    shares).  Access to detailed analytics requires additional scopes.

API docs: https://developers.tiktok.com/doc/content-posting-api-get-started
"""

from platforms.base import PlatformBase
from core.models import Post


class TikTok(PlatformBase):
    name = "tiktok"

    def validate_config(self) -> None:
        raise NotImplementedError("TODO: port from existing repo")

    def refresh_credentials(self) -> None:
        # Will call POST /v2/oauth/token/ with grant_type=refresh_token
        # to get a new access token.  TikTok access tokens are short-lived
        # (~24h), so the cron job needs to refresh before every run.
        raise NotImplementedError("TODO: port from existing repo")

    def validate_credentials(self) -> bool:
        # Will call GET /v2/user/info/ to check if the access token is
        # still valid.  Returns True if TikTok responds with user data.
        raise NotImplementedError("TODO: port from existing repo")

    def create_post(self, post: Post) -> str:
        # Multi-step flow:
        # 1. Initialize the upload via /v2/post/publish/inbox/video/init/
        # 2. Upload the video binary to the returned upload URL
        # 3. Poll /v2/post/publish/status/fetch/ until processing completes
        # Returns the TikTok video ID.
        raise NotImplementedError("TODO: port from existing repo")

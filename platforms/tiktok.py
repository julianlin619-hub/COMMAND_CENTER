"""TikTok platform implementation. Placeholder — will be filled from existing repo.

STUB FILE — This adapter will wrap TikTok's Content Posting API (part of the
TikTok for Developers platform).
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
from core.models import MediaUploadResult, Post


class TikTok(PlatformBase):
    name = "tiktok"

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

    def upload_media(self, local_path: str, media_type: str) -> MediaUploadResult:
        # TikTok requires uploading the video as part of the posting flow
        # (see create_post above), so this may handle the upload step
        # separately, or return a no-op if create_post handles it inline.
        # For chunked uploads of large videos, this is where chunk logic
        # would live.
        raise NotImplementedError("TODO: port from existing repo")

    def get_media_constraints(self) -> dict:
        # Will return TikTok's limits: videos up to 10 min (287.6 MB via
        # API), supported formats (mp4, webm), aspect ratio 9:16 preferred,
        # caption max 2200 chars, etc.
        raise NotImplementedError("TODO: port from existing repo")

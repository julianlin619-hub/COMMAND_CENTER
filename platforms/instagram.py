"""Instagram platform implementation. Placeholder — will be filled from existing repo.

STUB FILE — This adapter will wrap the Instagram Graph API (part of Meta's
Graph API ecosystem, shared with Facebook).
-----------------------------------------------------------------
Key things to know about Instagram's API:
  - Auth uses Facebook/Meta OAuth 2.0.  You get a short-lived token from the
    login flow, exchange it for a long-lived token (~60 days), and then
    refresh before it expires.
  - Posting is a two-step process: first you create a "media container"
    (uploading the image/video URL), then you "publish" that container.
    This is different from most APIs where posting is a single call.
  - Instagram supports feed posts, Reels (short video), Stories, and
    carousels (multiple images/videos in one post).  Each type has a
    slightly different creation flow.
  - Metrics come from the Instagram Insights API (requires a Business or
    Creator account).

API docs: https://developers.facebook.com/docs/instagram-api
"""

from platforms.base import PlatformBase
from core.models import EngagementSnapshot, MediaUploadResult, Post


class Instagram(PlatformBase):
    name = "instagram"

    def refresh_credentials(self) -> None:
        # Will exchange the current long-lived token for a new one via
        # GET /oauth/access_token?grant_type=ig_exchange_token.
        # Long-lived tokens last ~60 days, so refreshing weekly is safe.
        raise NotImplementedError("TODO: port from existing repo")

    def validate_credentials(self) -> bool:
        # Will call GET /me to check if the token is still valid.
        # Returns True if the API responds with the user's account info.
        raise NotImplementedError("TODO: port from existing repo")

    def create_post(self, post: Post) -> str:
        # Two-step flow:
        # 1. POST /{ig-user-id}/media — creates a container (pass image_url
        #    or video_url, caption, etc.).  For Reels, also set media_type
        #    to "REELS".
        # 2. POST /{ig-user-id}/media_publish — publishes the container.
        # Returns the Instagram media ID string.
        raise NotImplementedError("TODO: port from existing repo")

    def upload_media(self, local_path: str, media_type: str) -> MediaUploadResult:
        # Instagram's Graph API doesn't accept direct file uploads — it
        # expects a publicly accessible URL to the media file.  So this
        # method will upload the file to Supabase Storage first, get the
        # public URL, and return that URL in the MediaUploadResult for
        # create_post to use.
        raise NotImplementedError("TODO: port from existing repo")

    def get_media_constraints(self) -> dict:
        # Will return Instagram's limits: images up to 8 MB, videos up to
        # 100 MB (Reels up to 90 sec via API), aspect ratios 4:5 to 1.91:1,
        # caption max 2200 chars, max 30 hashtags, etc.
        raise NotImplementedError("TODO: port from existing repo")

    def get_post_metrics(self, platform_post_id: str) -> EngagementSnapshot:
        # Will call GET /{media-id}/insights to fetch impressions, reach,
        # likes, comments, saves, shares, etc.  Maps these platform-specific
        # metric names into the unified EngagementSnapshot fields.
        raise NotImplementedError("TODO: port from existing repo")
